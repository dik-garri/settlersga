import { AI, PROFESSIONS } from './config';
import { inBuildingSight } from './fog';
import { canGarrison, isArcher, isFighter, isMilitary, keepOf, slotsOf } from './military';
import type { AiState } from './ai';
import type { Building, PlayerId, Point, Settler } from './types';
import { startPositions, type World } from './world';

/**
 * Computer players' army (`field.ts`, `military.ts`), through the same commands a human uses
 * (`fillGarrison`, `orderGarrison`, `releaseFighters`, `orderMove`, `orderAttack`, with the AI's own
 * player id). As in Settlers 4 a military building calls in one fighter unless told otherwise, so:
 * - its buildings near a known enemy are filled, and every building's call is answered by sending
 *   it fighters by hand — even from afar —, the rest gather at a rally point behind its front
 *   (`muster`), where attacks find them (`World.attack` sends free fighters in range too);
 * - a strike group is gathered in the field short of its target and attacks together (`stageStrike`,
 *   `updateStrike`) instead of trickling out of several buildings one by one;
 * - hostile field units on or near its land, in its buildings' sight, are met by a field squad
 *   (`defend`);
 * - a scout walks to an enemy castle its buildings cannot see (`sendScout`, `updateScout`);
 * - an enemy's last fighters, left standing when his towers fell, are hunted down (`hunt`).
 * Squads take fighters from the rally first, then the spares of military buildings; done, they go
 * back to the rally. Its squads are plain ids in the saved `AiState`; a squad leader comes along when
 * one is free or sits in a building the group comes from (`orderMove` then forms the squad round him).
 */

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function alive(w: World, me: PlayerId, ids: readonly number[]): Settler[] {
  const out: Settler[] = [];
  for (const id of ids) {
    const s = w.getSettler(id);
    if (s && !w.dying.has(id) && s.owner === me && isFighter(s) && s.inside === null) out.push(s);
  }
  return out;
}

/** Ids in the AI's squads (strike, defence, hunt, scout): not for the rally or for garrisons. */
function held(ai: AiState): Set<number> {
  return new Set([
    ...(ai.strike?.ids ?? []),
    ...(ai.defense?.ids ?? []),
    ...(ai.hunt?.ids ?? []),
    ...(ai.scout ? [ai.scout.id] : []),
  ]);
}

/**
 * Its own fighters outdoors that no squad holds and that are doing nothing: free (no post) or idle
 * at a field post (the rally). By id.
 */
export function idleFighters(w: World, ai: AiState): Settler[] {
  const me = ai.player;
  const hold = held(ai);
  const out: Settler[] = [];
  for (const s of w.settlers) {
    if (s.owner !== me || s.inside !== null || s.home !== null || s.opponent !== null || w.dying.has(s.id)) continue;
    if (!isFighter(s) || hold.has(s.id)) continue;
    if (!s.tasks.every((t) => t.t === 'goto' || t.t === 'wait')) continue;
    out.push(s);
  }
  return out;
}

/**
 * Up to `n` fighters for a squad going to `at`: idle ones outdoors nearest it first, then the spares
 * of its military buildings nearest it (`releaseFighters`). Returns their ids.
 */
function takeFighters(w: World, ai: AiState, own: Building[], at: Point, n: number): number[] {
  const ids = idleFighters(w, ai)
    .sort((a, b) => dist(a, at) - dist(b, at) || a.id - b.id)
    .slice(0, n)
    .map((s) => s.id);
  let want = n - ids.length;
  if (want <= 0) return ids;
  const sources = own
    .filter((b) => b.done && isMilitary(b) && b.garrison.length > keepOf(b))
    .sort((a, b) => dist(a.door, at) - dist(b.door, at) || a.id - b.id);
  const counts = new Map<number, number>();
  for (const b of sources) {
    if (want <= 0) break;
    const k = Math.min(want, b.garrison.length - keepOf(b));
    counts.set(b.id, k);
    want -= k;
  }
  return [...ids, ...release(w, ai.player, counts)];
}

/** Fighters it could put into a squad now: idle outdoors plus the spares of its military buildings (within `range` of `near`). */
function spareCount(w: World, ai: AiState, own: Building[], near?: Point, range = Infinity): number {
  let n = idleFighters(w, ai).filter((s) => !near || dist(s, near) <= range).length;
  for (const b of own) {
    if (!b.done || !isMilitary(b) || (near && dist(b.door, near) > range)) continue;
    n += Math.max(0, b.garrison.length - keepOf(b));
  }
  return n;
}

/** Lets `count` fighters out of each building (ascending ids) and returns the ids of those who came out. */
function release(w: World, me: PlayerId, counts: Map<number, number>): number[] {
  const ids: number[] = [];
  for (const [bid, n] of [...counts].sort((a, b) => a[0] - b[0])) {
    const b = w.buildings.get(bid);
    if (!b) continue;
    const before = [...b.garrison];
    if (w.releaseFighters(bid, n, me) === 0) continue;
    const after = new Set(b.garrison);
    for (const id of before) if (!after.has(id)) ids.push(id);
  }
  return ids;
}

/**
 * Starts a staged strike against `target` with the party `World.attack` would send (`send` fighters):
 * they leave their garrisons and gather on the line from the target's door back towards their
 * buildings — on the first tile of their own land at least `AI.stageDistance` from the door, else at
 * that distance. Returns how many came out; 0 = not staged (the party starts too close, or
 * nobody could leave), and the caller attacks from the buildings instead.
 */
export function stageStrike(w: World, ai: AiState, target: Building, send: number): number {
  const me = ai.player;
  const party = w.attackerComposition(target.id, send, me);
  const counts = new Map<number, number>();
  const outdoors: Settler[] = [];
  for (const s of party) {
    if (s.inside !== null) counts.set(s.inside, (counts.get(s.inside) ?? 0) + 1);
    else outdoors.push(s);
  }
  if (counts.size === 0 && outdoors.length === 0) return 0;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const [bid, k] of counts) {
    const d = w.buildings.get(bid)!.door;
    sx += d.x * k;
    sy += d.y * k;
    n += k;
  }
  for (const s of outdoors) {
    sx += s.x;
    sy += s.y;
    n++;
  }
  const from = { x: sx / n, y: sy / n };
  const t = target.door;
  const far = dist(from, t);
  if (far < AI.stageDistance + AI.stageMinWalk) return 0;
  // A free squad leader of its own leads the group (one is enough; leaders never sit in buildings).
  if (!outdoors.some((s) => PROFESSIONS[s.kind].combat?.leads)) {
    const leader = idleFighters(w, ai)
      .filter((s) => PROFESSIONS[s.kind].combat?.leads && dist(s, from) <= AI.defendRange)
      .sort((a, b) => dist(a, from) - dist(b, from) || a.id - b.id)[0];
    if (leader) outdoors.push(leader);
  }
  // On its own land if the line back towards its buildings reaches it (out there the enemy meets the
  // group at home strength), else `AI.stageDistance` short of the door.
  const m = w.map;
  const at = (d: number) => ({
    x: Math.min(m.w - 1, Math.max(0, Math.round(t.x + ((from.x - t.x) / far) * d))),
    y: Math.min(m.h - 1, Math.max(0, Math.round(t.y + ((from.y - t.y) / far) * d))),
  });
  let { x, y } = at(AI.stageDistance);
  for (let d = AI.stageDistance; d < far - 1; d++) {
    const p = at(d);
    const i = m.idx(p.x, p.y);
    if (m.owner[i] === me && m.isWalkable(p.x, p.y)) {
      ({ x, y } = p);
      break;
    }
  }
  const ids = [...outdoors.map((s) => s.id), ...release(w, me, counts)];
  if (ids.length === 0) return 0;
  if (w.orderMove(ids, x, y, me) === 0) {
    // No room to gather there: straight at the target.
    w.orderAttack(ids, target.id, me);
    return ids.length;
  }
  ai.strike = { target: target.id, ids, until: w.tick + AI.stageTimeout };
  ai.stats.staged = (ai.stats.staged ?? 0) + 1;
  return ids.length;
}

/**
 * A strike group being gathered: once `AI.stageArrived` of it stands at its posts (or the time is
 * up) it attacks together; a target that is gone or no longer hostile sends it back to the rally
 * (`muster`). True while it is still gathering (no other attack meanwhile).
 */
export function updateStrike(w: World, ai: AiState): boolean {
  const st = ai.strike;
  if (!st) return false;
  const me = ai.player;
  const group = alive(w, me, st.ids);
  const target = w.buildings.get(st.target);
  const valid = !!target && target.done && isMilitary(target) && !w.allied(target.owner, me) && !w.isDefeated(target.owner);
  if (!valid || group.length === 0) {
    ai.strike = undefined;
    return false;
  }
  const there = group.filter((s) => s.post && s.tasks.length === 0 && dist(s, s.post) <= 1.5).length;
  if (there < group.length * AI.stageArrived && w.tick < st.until) {
    st.ids = group.map((s) => s.id);
    return true;
  }
  w.orderAttack(group.map((s) => s.id), st.target, me);
  ai.strike = undefined;
  return false;
}

/** A hostile field unit stands on its land or within `margin` tiles of it. */
function nearOwnLand(w: World, x: number, y: number, me: PlayerId, margin: number): boolean {
  const m = w.map;
  for (let dy = -margin; dy <= margin; dy++) {
    for (let dx = -margin; dx <= margin; dx++) {
      if (m.inBounds(x + dx, y + dy) && m.owner[m.idx(x + dx, y + dy)] === me) return true;
    }
  }
  return false;
}

/**
 * Meets hostile field units near its land with a field squad of `AI.defendRatio` times their number:
 * idle fighters outdoors and spares of military buildings (each keeps its `keep`), within
 * `AI.defendRange`; only if it can field at least as many as they are — otherwise its fighters defend
 * from their walls. When none are left in sight the squad goes back to the rally (`muster`).
 */
export function defend(w: World, ai: AiState, own: Building[]): void {
  const me = ai.player;
  const m = w.map;
  const threats: Settler[] = [];
  for (const s of w.settlers) {
    if (!s.post || s.inside !== null || s.owner === me || w.allied(s.owner, me) || !isFighter(s) || w.dying.has(s.id)) continue;
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    if (!m.inBounds(x, y) || !inBuildingSight(w, m.idx(x, y), me)) continue;
    if (nearOwnLand(w, x, y, me, AI.defendMargin)) threats.push(s);
  }
  const squad = ai.defense ? alive(w, me, ai.defense.ids) : [];
  if (threats.length === 0) {
    ai.defense = undefined;
    return;
  }
  const c = {
    x: Math.round(threats.reduce((n, s) => n + s.x, 0) / threats.length),
    y: Math.round(threats.reduce((n, s) => n + s.y, 0) / threats.length),
  };
  const need = Math.ceil(threats.length * AI.defendRatio);
  let ids = squad.map((s) => s.id);
  if (ids.length < need) {
    // Too few to match them in the open: stay behind the walls.
    if (ids.length === 0 && spareCount(w, ai, own, c, AI.defendRange) < threats.length) return;
    const near = own.filter((b) => dist(b.door, c) <= AI.defendRange);
    const out = takeFighters(w, ai, near, c, need - ids.length);
    if (out.length > 0 && ids.length === 0) ai.stats.defended = (ai.stats.defended ?? 0) + 1;
    if (out.length === 0 && ai.defense && dist(ai.defense, c) <= 2) return; // nobody new, in place already
    ids = [...ids, ...out];
  } else if (ai.defense && dist(ai.defense, c) <= 2) return; // in place already
  if (ids.length === 0) return;
  w.orderMove(ids, c.x, c.y, me);
  ai.defense = { ids, x: c.x, y: c.y };
}

/**
 * Hunts an enemy's last fighters (`DEFEAT.fighters`: he is out only when they are gone): his fighters
 * seen outdoors in its buildings' sight, when it knows no military building of his (explored doors
 * only, as `knownEnemies`) — stragglers left standing when his towers fell; field units near its land
 * are left to `defend`. A field squad of `AI.huntRatio` times their number (at least `AI.huntMin`) of
 * spares from its military buildings nearest them — only if its spares at least match them — is sent
 * to the nearest one; field units engage what they meet (`field.ts`). Back into garrisons when none
 * are left in sight. Public commands only (`releaseFighters`, `orderMove`, `orderGarrison`).
 */
export function hunt(w: World, ai: AiState, own: Building[]): void {
  const me = ai.player;
  const m = w.map;
  const holding = new Set<PlayerId>();
  for (const b of w.buildings.values()) {
    if (b.owner === me || !isMilitary(b) || w.allied(b.owner, me) || !w.isExplored(b.door.x, b.door.y, me)) continue;
    holding.add(b.owner);
  }
  // Their presumed home (the start position nearest them that is not its own or an ally's — public,
  // like the map size) must be explored: Settlers 4's fighters stand free round their towers, and
  // seeing them is no sign their towers are gone until it has looked where the towers would be.
  const friendly = [...w.buildings.values()].filter((b) => w.allied(b.owner, me)).map((b) => b.door);
  const starts = startPositions(m.w, w.players.length).filter((st) => !friendly.some((f) => dist(f, st) < 8));
  const homeSeen = (s: Settler) => {
    let best = starts[0];
    for (const st of starts) if (dist(st, s) < dist(best, s)) best = st;
    return !!best && w.isExplored(best.x, best.y, me);
  };
  const prey: Settler[] = [];
  for (const s of w.settlers) {
    if (s.inside !== null || w.allied(s.owner, me) || holding.has(s.owner) || w.isDefeated(s.owner)) continue;
    if (!isFighter(s) || w.dying.has(s.id)) continue;
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    if (!m.inBounds(x, y) || !inBuildingSight(w, m.idx(x, y), me) || !homeSeen(s)) continue;
    // Field units near its land are `defend`'s.
    if (s.post && nearOwnLand(w, x, y, me, AI.defendMargin)) continue;
    prey.push(s);
  }
  const squad = ai.hunt ? alive(w, me, ai.hunt.ids) : [];
  if (prey.length === 0) {
    ai.hunt = undefined;
    return;
  }
  const from: Point = squad.length > 0 ? squad[0] : w.homeOf(me);
  let goal = prey[0];
  for (const s of prey) if (dist(s, from) < dist(goal, from) || (dist(s, from) === dist(goal, from) && s.id < goal.id)) goal = s;
  const at = { x: Math.round(goal.x), y: Math.round(goal.y) };
  const need = Math.max(AI.huntMin, Math.ceil(prey.length * AI.huntRatio));
  let ids = squad.map((s) => s.id);
  if (ids.length < need) {
    // Too few to outnumber them: not yet.
    if (ids.length + spareCount(w, ai, own) < prey.length) return;
    const out = takeFighters(w, ai, own, at, need - ids.length);
    if (out.length > 0 && ids.length === 0) ai.stats.hunts = (ai.stats.hunts ?? 0) + 1;
    ids = [...ids, ...out];
  } else if (ai.hunt && dist(ai.hunt, at) <= 2) return; // on its way there already
  if (ids.length === 0) return;
  w.orderMove(ids, at.x, at.y, me);
  ai.hunt = { ids, x: at.x, y: at.y };
}

/**
 * Sends one fighter — an idle one outdoors, else a spare (above `keepOf`) of the military building
 * nearest `goal` — there as a field unit: a scout. What he sees is explored for good, so a castle
 * forest, water or swamp keeps out of its buildings' sight is still found. True if one went.
 */
export function sendScout(w: World, ai: AiState, own: Building[], goal: Point): boolean {
  const me = ai.player;
  const ids = takeFighters(w, ai, own, goal, 1);
  if (ids.length === 0) return false;
  if (w.orderMove(ids, Math.round(goal.x), Math.round(goal.y), me) === 0) return false;
  ai.scout = { id: ids[0], until: w.tick + AI.scoutTimeout };
  return true;
}

/**
 * A scout out: kept in the field while `needed` (no enemy castle known yet) and his time lasts, then
 * back to the rally (`muster`). True while he is still out.
 */
export function updateScout(w: World, ai: AiState, needed: boolean): boolean {
  const sc = ai.scout;
  if (!sc) return false;
  const [s] = alive(w, ai.player, [sc.id]);
  if (s && needed && w.tick < sc.until) return true;
  ai.scout = undefined;
  return false;
}

/**
 * Its garrisons and its rally, every think (Settlers 4: a military building calls one fighter unless
 * told otherwise, and only free fighters close by):
 * - military buildings in `fill` (near a known enemy) are filled (`fillGarrison`);
 * - every military building that wishes more than it has inside and coming — an empty one at least
 *   one — is sent the nearest idle fighter of the kind it lacks (`orderGarrison`), wherever he
 *   stands;
 * - the other idle fighters gather at `rally` (`orderMove`, all of them again whenever one is away
 *   from it or the point moves `AI.rallySlack` tiles), from where attacks and squads take them.
 */
export function muster(w: World, ai: AiState, own: Building[], fill: readonly Building[], rally: Point): void {
  const me = ai.player;
  for (const b of fill) {
    const wish = b.wish ?? { melee: 0, ranged: 0 };
    if (wish.melee < slotsOf(b, false) || wish.ranged < slotsOf(b, true)) w.fillGarrison(b.id, me);
  }
  const pool = idleFighters(w, ai).filter(canGarrison);
  const take = (b: Building, archer: boolean): boolean => {
    let best = -1;
    for (let k = 0; k < pool.length; k++) {
      if (isArcher(pool[k]) !== archer) continue;
      if (best < 0 || dist(pool[k], b.door) < dist(pool[best], b.door)) best = k;
    }
    if (best < 0) return false;
    const [s] = pool.splice(best, 1);
    return w.orderGarrison([s.id], b.id, me) > 0;
  };
  for (const b of own) {
    if (!b.done || !isMilitary(b) || pool.length === 0) continue;
    const wish = b.wish ?? { melee: 0, ranged: 0 };
    let melee = 0;
    let ranged = 0;
    for (const id of b.garrison) {
      const s = w.getSettler(id);
      if (s && isArcher(s)) ranged++;
      else melee++;
    }
    const inRanged = b.garrisonArchersInbound;
    const inMelee = b.garrisonInbound - inRanged;
    if (melee + ranged + inMelee + inRanged === 0 && wish.melee + wish.ranged === 0) {
      // Empty and nobody called yet: one, a swordsman if there is one.
      if (!take(b, false)) take(b, true);
      continue;
    }
    for (let k = melee + inMelee; k < wish.melee && take(b, false); k++);
    for (let k = ranged + inRanged; k < wish.ranged && take(b, true); k++);
  }
  // The rest (and squad leaders, who never go in) gather at the rally point.
  const rest = idleFighters(w, ai).filter((s) => !s.tasks.some((t) => t.t === 'join'));
  if (rest.length === 0) return;
  const moved = !ai.rally || dist(ai.rally, rally) > AI.rallySlack;
  const at = moved ? rally : ai.rally!;
  if (!moved && rest.every((s) => s.post && dist(s.post, at) <= AI.rallySlack + 2)) return;
  if (w.orderMove(rest.map((s) => s.id), at.x, at.y, me) > 0) ai.rally = { x: at.x, y: at.y };
}
