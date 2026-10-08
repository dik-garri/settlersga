/**
 * Direct army control, as in Settlers 3/4: fighters ordered out of their buildings become field units.
 *
 * A field unit is an ordinary fighter with a `Settler.post`: instead of looking for a garrison when
 * idle (`soldierIdle`), it walks to its post and stays there, engaging enemy fighters that come within
 * `FIELD.engageRadius` (swordsmen close in and duel with the `engage` task; archers shoot from where
 * they stand). Orders are public player commands (`World.orderMove`, `orderAttack`, `orderGarrison`,
 * `orderHold`, `releaseFighters`), usable by the AI as well. A squad leader (`combat.leads`) lifts the
 * fighters around him (`moraleOf`), and soldiers ordered out together with him keep their place
 * around him (`post.leader`) as he moves.
 *
 * Cost: every field unit looks around only every `FIELD.scanEvery` ticks (staggered by id), over the
 * list of outdoor fighters built once per tick (`outdoorFighters`) — proportional to units, not to the
 * map. Field units occupy no tiles, like every settler.
 */
import { duelTick, startDuel } from './combat';
import { FIELD, PROFESSIONS } from './config';
import { nearestIntruder } from './intruders';
import { abort } from './settlers';
import { isFighter, leaveGarrison, shoot, slotsFree, isArcher, isMilitary, keepOf } from './military';
import type { Building, FieldPost, PlayerId, Point, Settler, Task } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------- per-tick caches (derived, not saved)

const outdoorCache = new WeakMap<World, { tick: number; list: Settler[] }>();

/** Living fighters standing outside any building, built once per tick. */
export function outdoorFighters(w: World): Settler[] {
  const c = outdoorCache.get(w);
  if (c && c.tick === w.tick) return c.list;
  const list = w.settlers.filter((s) => s.inside === null && !w.dying.has(s.id) && isFighter(s));
  outdoorCache.set(w, { tick: w.tick, list });
  return list;
}

const leaderCache = new WeakMap<World, { tick: number; list: Settler[] }>();

function leaders(w: World): Settler[] {
  const c = leaderCache.get(w);
  if (c && c.tick === w.tick) return c.list;
  const list = w.settlers.filter((s) => !w.dying.has(s.id) && PROFESSIONS[s.kind].combat?.leads);
  leaderCache.set(w, { tick: w.tick, list });
  return list;
}

/**
 * Morale factor for a fighter's damage (`combat.ts`): a squad leader of his own within his radius
 * lifts it. Leaders lead, they are not led (Settlers 4 gives the leader's 21 a blow without a bonus).
 */
export function moraleOf(w: World, s: Settler): number {
  if (PROFESSIONS[s.kind].combat?.leads) return 1;
  let best = 1;
  for (const l of leaders(w)) {
    const leads = PROFESSIONS[l.kind].combat!.leads!;
    if (l.owner !== s.owner || leads.morale <= best) continue;
    if (dist(l, s) <= leads.radius) best = leads.morale;
  }
  return best;
}

const hostile = (w: World, a: Settler, b: Settler) => a.owner !== b.owner && !w.allied(a.owner, b.owner);

// ---------------------------------------------------------------- formation

/**
 * Up to `n` distinct walkable tiles around (x, y), nearest first in a spiral, `FIELD.formation` apart:
 * where a group ordered to a point spreads out. Deterministic (fixed ring order).
 */
export function formationSpots(w: World, x: number, y: number, n: number): Point[] {
  const m = w.map;
  const step = Math.max(1, FIELD.formation);
  const out: Point[] = [];
  for (let r = 0; out.length < n && r <= 2 + Math.ceil(Math.sqrt(n)) * 2; r++) {
    for (let dy = -r; dy <= r && out.length < n; dy++) {
      for (let dx = -r; dx <= r && out.length < n; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = Math.round(x) + dx * step;
        const ty = Math.round(y) + dy * step;
        if (!m.inBounds(tx, ty) || !m.isWalkable(tx, ty) || m.door[m.idx(tx, ty)] !== 0) continue;
        out.push({ x: tx, y: ty });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- orders

/** The player's own living fighters among `ids` that can take an order (outside, not in a duel). */
function orderable(w: World, ids: readonly number[], player: PlayerId): Settler[] {
  const out: Settler[] = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const s = w.getSettler(id);
    if (!s || w.dying.has(s.id) || s.owner !== player || !isFighter(s)) continue;
    if (s.inside !== null || s.opponent !== null) continue;
    out.push(s);
  }
  return out;
}

/** Drops whatever a unit was doing (its reservations go back) and leaves its home garrison's books. */
function clearOrders(w: World, s: Settler): void {
  abort(w, s);
  s.tasks = [];
  s.path = [];
  if (s.home !== null) {
    const home = w.buildings.get(s.home);
    if (home && home.garrison.includes(s.id)) leaveGarrison(w, home, s);
    s.home = null;
  }
}

/**
 * Player command: move fighters to (x, y). They spread into a formation around the point and stay
 * there as field units. If a squad leader is among them, the others keep their place around him:
 * their posts follow him wherever he is sent later. Returns how many obeyed.
 */
export function orderMove(w: World, ids: readonly number[], x: number, y: number, player: PlayerId): number {
  const units = orderable(w, ids, player);
  if (units.length === 0 || !w.map.inBounds(Math.round(x), Math.round(y))) return 0;
  const leader = units.find((s) => PROFESSIONS[s.kind].combat?.leads);
  // The leader takes the centre, then swordsmen in front, archers behind (ids keep it deterministic).
  const ordered = [
    ...(leader ? [leader] : []),
    ...units.filter((s) => s !== leader && !isArcher(s)),
    ...units.filter((s) => s !== leader && isArcher(s)),
  ];
  const spots = formationSpots(w, x, y, ordered.length);
  if (spots.length === 0) return 0;
  ordered.forEach((s, k) => {
    const spot = spots[Math.min(k, spots.length - 1)];
    clearOrders(w, s);
    const post: FieldPost = { x: spot.x, y: spot.y };
    if (leader && s !== leader) {
      post.leader = leader.id;
      post.dx = spot.x - spots[0].x;
      post.dy = spot.y - spots[0].y;
    }
    s.post = post;
  });
  return ordered.length;
}

/** Player command: fighters hold where they stand (a field post on their own tile). */
export function orderHold(w: World, ids: readonly number[], player: PlayerId): number {
  const units = orderable(w, ids, player);
  for (const s of units) {
    clearOrders(w, s);
    s.post = { x: Math.round(s.x), y: Math.round(s.y) };
  }
  return units.length;
}

/**
 * Player command: fighters attack an enemy military building, wherever they stand (the field version
 * of `attack`, which sends spares from buildings in range). Survivors who do not take it (archers, or
 * all once another took it) stay at the target's door as field units. Returns how many went.
 */
export function orderAttack(w: World, ids: readonly number[], targetId: number, player: PlayerId): number {
  const target = w.buildings.get(targetId);
  if (!target || !target.done || !isMilitary(target) || w.allied(target.owner, player)) return 0;
  const units = orderable(w, ids, player);
  for (const s of units) {
    clearOrders(w, s);
    s.post = { x: target.door.x, y: target.door.y };
    s.tasks = [
      { t: 'goto', x: target.door.x, y: target.door.y, adj: true },
      { t: 'assault', b: target.id, n: 0 },
    ];
  }
  return units.length;
}

/**
 * Player command: fighters go into an own military building with free slots of their kind (or, with
 * none given, each into the nearest one with room, as homeless fighters do). Returns how many went.
 */
export function orderGarrison(w: World, ids: readonly number[], buildingId: number | null, player: PlayerId): number {
  const units = orderable(w, ids, player);
  const b = buildingId !== null ? w.buildings.get(buildingId) : undefined;
  if (buildingId !== null && (!b || b.owner !== player || !isMilitary(b) || !b.done)) return 0;
  let n = 0;
  for (const s of units) {
    if (b && slotsFree(w, b, isArcher(s)) <= 0) continue;
    clearOrders(w, s);
    s.post = null;
    if (b) {
      b.garrisonInbound++;
      if (isArcher(s)) b.garrisonArchersInbound++;
      s.tasks = [
        { t: 'goto', x: b.door.x, y: b.door.y },
        { t: 'join', b: b.id, archer: isArcher(s) },
      ];
    }
    // Without a building, the empty queue lets `soldierIdle` find the nearest garrison.
    n++;
  }
  return n;
}

/**
 * Player command: send up to `count` of a military building's spare fighters (beyond what it keeps,
 * `keep`) out of the door as field units, in formation before it. Returns how many came out.
 */
export function releaseFighters(w: World, buildingId: number, count: number, player: PlayerId): number {
  const b = w.buildings.get(buildingId);
  if (!b || b.owner !== player || !b.done || !isMilitary(b)) return 0;
  const ready = b.garrison
    .map((id) => w.getSettler(id))
    .filter((s): s is Settler => !!s && !w.dying.has(s.id) && s.inside === b.id && s.opponent === null)
    .sort((p, q) => Number(isArcher(p)) - Number(isArcher(q)) || p.id - q.id)
    .slice(0, Math.max(0, Math.min(count, b.garrison.length - keepOf(b))));
  const spots = formationSpots(w, b.door.x, b.door.y + 2, ready.length);
  ready.forEach((s, k) => {
    leaveGarrison(w, b, s);
    s.home = null;
    s.inside = null;
    const spot = spots[Math.min(k, spots.length - 1)] ?? b.door;
    s.post = { x: spot.x, y: spot.y };
  });
  return ready.length;
}

// ---------------------------------------------------------------- behaviour

/** Where a field unit should stand now: its post, or its place around its living squad leader. */
function postOf(w: World, s: Settler): Point {
  const p = s.post!;
  if (p.leader === undefined) return p;
  const l = w.getSettler(p.leader);
  if (!l || w.dying.has(l.id) || l.owner !== s.owner || !l.post) {
    // The leader is gone (or went into a building): keep the last place.
    delete p.leader;
    return p;
  }
  const at = { x: Math.round(l.post.x + (p.dx ?? 0)), y: Math.round(l.post.y + (p.dy ?? 0)) };
  if (w.map.inBounds(at.x, at.y) && w.map.isWalkable(at.x, at.y)) {
    p.x = at.x;
    p.y = at.y;
  }
  return p;
}

/** The nearest enemy fighter outside within `range` of `s` (ties by id), or undefined. */
function nearestEnemy(w: World, s: Settler, range: number): Settler | undefined {
  let best: Settler | undefined;
  let bestD = Infinity;
  for (const o of outdoorFighters(w)) {
    if (!hostile(w, s, o)) continue;
    const d = dist(o, s);
    if (d > range || d > bestD || (d === bestD && best && o.id > best.id)) continue;
    best = o;
    bestD = d;
  }
  return best;
}

/**
 * Idle behaviour of a field unit (called from `soldierIdle` when the fighter has a post): archers shoot
 * the nearest enemy in range; swordsmen engage the nearest within `FIELD.engageRadius`; otherwise walk
 * back to the post.
 */
export function fieldIdle(w: World, s: Settler): void {
  const ranged = PROFESSIONS[s.kind].combat?.ranged;
  if (ranged) {
    if (s.reload > 0) s.reload--;
    const target = nearestEnemy(w, s, ranged.range) ?? nearestIntruder(w, s, ranged.range);
    if (target) {
      s.working = true;
      if (s.reload <= 0) shoot(w, s, target, s);
      return;
    }
  } else if ((w.tick + s.id) % FIELD.scanEvery === 0) {
    const target = nearestEnemy(w, s, FIELD.engageRadius);
    if (target) {
      s.tasks = [{ t: 'engage', s: target.id, n: 0 }];
      return;
    }
    // An intruding specialist on our land (`intruders.ts`): go and cut him down.
    const intruder = nearestIntruder(w, s, FIELD.engageRadius);
    if (intruder) {
      s.tasks = [{ t: 'chase', s: intruder.id, n: 0 }];
      return;
    }
  }
  const p = postOf(w, s);
  if (dist(s, p) > FIELD.slack) s.tasks = [{ t: 'goto', x: p.x, y: p.y }];
}

/**
 * `engage` task: close in on the enemy fighter and duel him (`combat.ts`: both strike on their own
 * timers). The duel pairs both (`opponent`); one side runs it — this task, unless the enemy is
 * engaging back and has the lower id (who runs it decides nothing about who strikes first). Gives up
 * when the enemy is gone, inside a building, busy with someone else for long, or lured beyond
 * `FIELD.chaseLimit` from the post.
 */
export function engageTick(w: World, s: Settler, task: Extract<Task, { t: 'engage' }>): void {
  const e = w.getSettler(task.s);
  const quit = () => {
    if (s.opponent === task.s) s.opponent = null;
    if (e && e.opponent === s.id) e.opponent = null;
    s.tasks.shift();
  };
  if (!e || w.dying.has(e.id) || e.inside !== null || !hostile(w, s, e)) return quit();
  if (s.post && dist(s, postOf(w, s)) > FIELD.chaseLimit) return quit();
  if (s.opponent === e.id) {
    s.working = true;
    // Both sides engaging each other: the lower id runs the duel, the other just stands.
    const mirrored = e.opponent === s.id && e.tasks[0]?.t === 'engage' && e.id < s.id;
    if (mirrored) return;
    duelTick(w, s, e);
    return;
  }
  if (dist(s, e) <= 1.5) {
    // Side by side, diagonals included (where an `adj` walk stops).
    if (e.opponent === null && s.opponent === null) {
      s.opponent = e.id;
      e.opponent = s.id;
      task.n = 0;
      startDuel(w, s, e);
      return;
    }
    // He is busy with a comrade: wait beside, or give up after a while.
    if (++task.n > FIELD.waitBeside) quit();
    return;
  }
  // Close in: a short walk towards where he stands now, re-aimed each time it ends.
  s.tasks.unshift({ t: 'goto', x: Math.round(e.x), y: Math.round(e.y), adj: true });
}

/** Hostile field units within `range` of a building's door (garrison archers shoot them too). */
export function fieldUnitsNear(w: World, b: Building, range: number): Settler[] {
  return outdoorFighters(w).filter(
    (o) => o.post && hostile2(w, o.owner, b.owner) && Math.hypot(o.x - b.door.x, o.y - b.door.y) <= range,
  );
}

const hostile2 = (w: World, a: PlayerId, b: PlayerId) => a !== b && !w.allied(a, b);

/** Units of `player` currently in the field (posts), for the HUD and the AI. */
export function fieldUnits(w: World, player: PlayerId): Settler[] {
  return w.settlers.filter((s) => s.owner === player && !w.dying.has(s.id) && !!s.post && isFighter(s));
}

