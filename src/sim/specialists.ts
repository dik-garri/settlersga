import { nearestStorage } from './buildings';
import { FIELD, GEOLOGIST, ORDERABLE, PIONEER, PROFESSIONS, THIEF } from './config';
import { recountWorkers, workerOrder, workersOf } from './economy';
import { restIdle } from './idle';
import { formationSpots } from './field';
import { sameRegion } from './regions';
import { abort, carryBack } from './settlers';
import { RESOURCES, Terrain, type Building, type PlayerId, type Resource, type Settler, type SettlerKind, type Task } from './types';
import type { World } from './world';

/**
 * Specialists, as in Settlers 4: made from free carriers on the player's order (`ORDERABLE`, like
 * builders), then sent on errands. None is bound to his owner's land (S4 manual §10: «not limited by
 * your settlement's boundaries»).
 *
 * Pioneer and geologist work an errand the way S4's `CPioneerRole`/`CGeologistRole` do: he walks to
 * the spot he was sent to, then keeps picking the next tile out from where he stands (`searchTile`:
 * the nearest window of a distance-sorted spiral that holds any, there the tile closest to the spot,
 * himself weighing three times as much), works it, and picks again — until nothing is left within
 * `reach` of him. Then the errand is over and he stays standing where he is (`Settler.post`), waiting
 * for orders; nobody walks home. Tiles he finds no route to are skipped (`errand.skip`).
 *
 * Pioneer: claims neutral passable tiles (`claimable`), one per `claim` task. A claim is recorded in
 * `map.claimed` (saved) and the tile's `map.owner` is set at once; `recomputeTerritory` keeps giving
 * claimed tiles to their claimant wherever no military building claims them, so land a tower or castle
 * claims always wins, and the claim comes back if that building goes. Pioneers never claim owned land.
 *
 * Geologist: leaves a sign (`map.prospected`, per player) on every unexamined walkable mountain tile
 * (`prospectable`), his owner's, neutral or foreign, one per `prospect` task — the whole ridge.
 *
 * Thief: `sendThief` points him at a foreign, explored building with goods at its door (or in stock);
 * he walks there unnoticed, takes one unit of its most plentiful good in `THIEF.stealTicks` and carries
 * it to his owner's nearest warehouse, then goes back for more until the building is bare or gone.
 * On hostile land every specialist may be cut down by that land's swordsmen, the thief once unmasked
 * (`intruders.ts`, `INTRUDERS`).
 *
 * All keep their errand in `Settler.errand` (saved); without one or a post they idle with the crowd.
 * `dismissSpecialist` turns a free one standing on his owner's land back into a carrier (bringing the
 * tool back to a warehouse) and lowers the order.
 */

/** Whether a pioneer of `player` may claim the tile: neutral and passable (S4 `CPioneerRole::CheckLand`). */
export function claimable(w: World, x: number, y: number, _player: PlayerId): boolean {
  const m = w.map;
  return m.inBounds(x, y) && m.owner[m.idx(x, y)] === 0 && m.isWalkable(x, y);
}

/** Whether a geologist of `player` may examine the tile: walkable mountain without his sign, on any land. */
export function prospectable(w: World, x: number, y: number, player: PlayerId): boolean {
  const m = w.map;
  if (!m.inBounds(x, y)) return false;
  return m.terrain[m.idx(x, y)] === Terrain.Mountain && m.isWalkable(x, y) && !w.isProspected(x, y, player);
}

// ---------------------------------------------------------------- the search (S4 SearchPosition)

/** Offsets within `reach`, sorted by distance (ties: row, then column) — S4's `CSpiralOffsets`. */
const spirals = new Map<number, Int16Array>();

function spiral(reach: number): Int16Array {
  let out = spirals.get(reach);
  if (out) return out;
  const r = Math.ceil(reach);
  const pts: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= reach * reach) pts.push([dx, dy]);
  pts.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
  out = new Int16Array(pts.length * 2);
  pts.forEach(([dx, dy], k) => {
    out![k * 2] = dx;
    out![k * 2 + 1] = dy;
  });
  spirals.set(reach, out);
  return out;
}

interface Search {
  /** Where he searches from: where he stands (or the spot, before his first tile). */
  ox: number;
  oy: number;
  /** The spot he was sent to: the search leans towards it. */
  tx: number;
  ty: number;
  /** His tile, for the reachability test (`sameRegion`); −1 skips it. */
  at: number;
  reach: number;
  window: number;
  ok: (i: number, x: number, y: number) => boolean;
}

/**
 * The next tile to work: windows of `window` spiral offsets from (ox, oy) outwards, the first holding
 * any tile that passes `ok` decides; among its tiles the least d²(spot) + 3·d²(origin), ties to the
 * first in spiral order. Null when nothing within `reach` passes. O(reach²).
 */
function searchTile(w: World, q: Search): { x: number; y: number } | null {
  const m = w.map;
  const offs = spiral(q.reach);
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  let hit = -1;
  for (let k = 0; k < offs.length / 2; k++) {
    const win = Math.floor(k / q.window);
    if (hit >= 0 && win > hit) break;
    const x = q.ox + offs[k * 2];
    const y = q.oy + offs[k * 2 + 1];
    if (!m.inBounds(x, y)) continue;
    const i = m.idx(x, y);
    if (!q.ok(i, x, y) || (q.at >= 0 && !sameRegion(m, q.at, i))) continue;
    hit = win;
    const score = (x - q.tx) ** 2 + (y - q.ty) ** 2 + 3 * ((x - q.ox) ** 2 + (y - q.oy) ** 2);
    if (score < bestScore) {
      bestScore = score;
      best = { x, y };
    }
  }
  return best;
}

/** Tiles other specialists of the player are already heading for with a task of type `t`. */
function takenBy(w: World, s: Settler, t: 'prospect' | 'claim'): Set<number> {
  const taken = new Set<number>();
  for (const o of w.settlers) {
    if (o === s || o.owner !== s.owner || o.kind !== s.kind) continue;
    for (const task of o.tasks) if (task.t === t) taken.add(w.map.idx(task.x, task.y));
  }
  return taken;
}

type Errand = NonNullable<Settler['errand']>;

/** The next tile of the specialist's errand passing `ok`, searched as S4 does (`searchTile`). */
function nextTile(
  w: World,
  s: Settler,
  e: Errand,
  def: { reach: number; window: number },
  ok: (i: number, x: number, y: number) => boolean,
): { x: number; y: number } | null {
  const m = w.map;
  const sx = Math.round(s.x);
  const sy = Math.round(s.y);
  const fromSpot = e.n === undefined;
  const skip = e.skip;
  return searchTile(w, {
    ox: fromSpot ? e.x : sx,
    oy: fromSpot ? e.y : sy,
    tx: e.x,
    ty: e.y,
    at: m.idx(sx, sy),
    reach: def.reach,
    window: def.window,
    ok: skip?.length ? (i, x, y) => !skip.includes(i) && ok(i, x, y) : ok,
  });
}

/** Whether a specialist sent to (x, y) would find any tile passing `ok` there (no route test). */
function anyAround(w: World, x: number, y: number, def: { reach: number; window: number }, ok: (i: number, x: number, y: number) => boolean) {
  return searchTile(w, { ox: x, oy: y, tx: x, ty: y, at: -1, reach: def.reach, window: def.window, ok }) !== null;
}

/** The errand is over: he stays standing where he is, waiting for orders (`specialistPostIdle`). */
function finishErrand(s: Settler): void {
  s.errand = null;
  s.post = { x: Math.round(s.x), y: Math.round(s.y) };
}

/** A path to the errand's next tile failed: skip that tile from now on (bounded list). */
export function skipErrandTile(w: World, s: Settler, x: number, y: number): void {
  const e = s.errand;
  if (!e) return;
  const skip = (e.skip ??= []);
  if (skip.length >= 64) skip.shift();
  skip.push(w.map.idx(x, y));
}

/**
 * Free for a new errand: none running, nothing to do but wait — idle, or standing at his post
 * (`specialistPostIdle` keeps him there with `wait`/`goto` tasks).
 */
export function isFreeSpecialist(s: Settler): boolean {
  if (s.errand) return false;
  if (s.tasks.length === 0) return true;
  return !!s.post && s.tasks.every((t) => t.t === 'wait' || t.t === 'goto');
}

/** The player's free specialist of `kind` nearest to (x, y). */
function idleSpecialist(w: World, player: PlayerId, kind: SettlerKind, x: number, y: number): Settler | undefined {
  let best: Settler | undefined;
  let bestD = Infinity;
  for (const s of w.settlers) {
    if (s.owner !== player || s.kind !== kind || s.inside !== null || !isFreeSpecialist(s) || w.dying.has(s.id)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------- pioneer

/** Whether a pioneer sent to (x, y) would find land to claim there. */
export function pioneerSpot(w: World, x: number, y: number, player: PlayerId): boolean {
  return anyAround(w, x, y, PIONEER, (_i, tx, ty) => claimable(w, tx, ty, player));
}

/** Player command: send the nearest free pioneer to claim land around (x, y). */
export function sendPioneer(w: World, x: number, y: number, player: PlayerId): boolean {
  if (!w.map.inBounds(x, y)) return false;
  const s = idleSpecialist(w, player, 'pioneer', x, y);
  if (!s) return false;
  // He must be able to walk to some of it: a spot across a lake or a swamp would send him into a
  // failed route for nothing.
  const at = w.map.idx(Math.round(s.x), Math.round(s.y));
  const ok = (i: number, tx: number, ty: number) => claimable(w, tx, ty, player) && sameRegion(w.map, at, i);
  if (!anyAround(w, x, y, PIONEER, ok)) return false;
  clearSpecialist(w, s);
  s.errand = { x, y };
  return true;
}

/** Idle pioneer: claim the next tile of the errand; with none left in reach, stay where he stands. */
export function pioneerIdle(w: World, s: Settler): void {
  const e = s.errand;
  if (e) {
    const taken = takenBy(w, s, 'claim');
    const t = nextTile(w, s, e, PIONEER, (i, x, y) => !taken.has(i) && claimable(w, x, y, s.owner));
    if (t) {
      e.n ??= 0;
      s.tasks = [
        { t: 'goto', x: t.x, y: t.y },
        { t: 'claim', x: t.x, y: t.y, n: PIONEER.claimTicks },
      ];
      return;
    }
    return finishErrand(s);
  }
  restIdle(w, s);
}

/** `claim` task: work the border stone, then the tile is the owner's (if still claimable). */
export function claimTick(w: World, s: Settler, task: Extract<Task, { t: 'claim' }>): void {
  s.working = true;
  if (--task.n > 0) return;
  s.tasks.shift();
  if (!claimable(w, task.x, task.y, s.owner)) return;
  const m = w.map;
  const i = m.idx(task.x, task.y);
  m.claimed[i] = s.owner;
  m.owner[i] = s.owner;
  w.pioneerLand++;
  w.territoryVersion++;
  if (s.errand) s.errand.n = (s.errand.n ?? 0) + 1;
}

// ---------------------------------------------------------------- thief

/** Whether a thief of `player` may be sent to rob `b`: foreign, not allied, explored, with goods. */
export function robbable(w: World, b: Building, player: PlayerId): boolean {
  if (b.owner === player || w.allied(b.owner, player) || !b.done) return false;
  if (!w.isExplored(b.door.x, b.door.y, player)) return false;
  return lootOf(b) !== null;
}

/** The good a thief takes from the building: its most plentiful one not promised to a carrier. */
function lootOf(b: Building): Resource | null {
  let best: Resource | null = null;
  let most = 0;
  for (const r of RESOURCES) {
    const n = b.output[r] - b.outReserved[r];
    if (n > most) {
      most = n;
      best = r;
    }
  }
  return best;
}

/** Player command: send the nearest free thief to rob building `targetId`. */
export function sendThief(w: World, targetId: number, player: PlayerId): boolean {
  const b = w.buildings.get(targetId);
  if (!b || !robbable(w, b, player)) return false;
  const s = idleSpecialist(w, player, 'thief', b.door.x, b.door.y);
  if (!s) return false;
  clearSpecialist(w, s);
  s.errand = { x: b.door.x, y: b.door.y, b: b.id };
  return true;
}

/** Idle thief: (back) to the building he was sent to rob, while there is loot; else hang about. */
export function thiefIdle(w: World, s: Settler): void {
  const e = s.errand;
  const b = e?.b !== undefined ? w.buildings.get(e.b) : undefined;
  if (b && robbable(w, b, s.owner)) {
    s.tasks = [
      { t: 'goto', x: b.door.x, y: b.door.y },
      { t: 'steal', b: b.id, n: THIEF.stealTicks },
    ];
    return;
  }
  s.errand = null;
  restIdle(w, s);
}

/** `steal` task: after `n` ticks at the door, take one good and carry it to a warehouse at home. */
export function stealTick(w: World, s: Settler, task: Extract<Task, { t: 'steal' }>): void {
  const b = w.buildings.get(task.b);
  if (!b || b.owner === s.owner || w.allied(b.owner, s.owner)) {
    s.tasks.shift();
    return;
  }
  s.working = true;
  if (--task.n > 0) return;
  s.tasks.shift();
  const res = lootOf(b);
  if (!res) return;
  const store = nearestStorage(w, s.owner, s, res);
  if (!store) return;
  b.output[res]--;
  s.carrying = res;
  store.inbound[res]++;
  s.tasks = [
    { t: 'goto', x: store.door.x, y: store.door.y },
    { t: 'drop', b: store.id, res },
  ];
}

// ---------------------------------------------------------------- dismissal

/**
 * Player command: one free specialist (or other orderable worker) of `kind` on his owner's land goes
 * back to being a carrier, bringing his tool back to a warehouse; the order drops by one.
 */
export function dismissSpecialist(w: World, kind: Settler['kind'], player: PlayerId): boolean {
  const m = w.map;
  const s = w.settlers.find(
    (o) =>
      o.owner === player &&
      o.kind === kind &&
      isFreeSpecialist(o) &&
      o.inside === null &&
      !w.dying.has(o.id) &&
      m.owner[m.idx(Math.round(o.x), Math.round(o.y))] === player,
  );
  if (!s) return false;
  clearSpecialist(w, s);
  if (s.carrying !== null && s.carrying === PROFESSIONS[s.kind].tool) s.carrying = null;
  toCarrier(w, s, player);
  return true;
}

/**
 * An orderable worker (geologist, pioneer, thief…) turns back into a carrier and brings his tool back to
 * a warehouse (`carryBack`); the order drops by one unless `lowerOrder` is false (a geologist over the
 * order, `geologistIdle`).
 */
function toCarrier(w: World, s: Settler, player: PlayerId, lowerOrder = true): void {
  const kind = s.kind;
  if (lowerOrder) w.orderWorkers(kind, Math.max(0, workerOrder(w, player, kind) - 1), player);
  s.kind = 'carrier';
  s.hp = 0;
  s.errand = null;
  s.post = null;
  recountWorkers(w);
  const tool = PROFESSIONS[kind].tool;
  // The tool was used up when he took up the profession (`retool`); an old save's geologist may still
  // hold it in hand — either way one unit goes back.
  if (tool && (s.carrying === null || s.carrying === tool)) {
    s.carrying = tool;
    carryBack(w, s, tool);
  }
}

// ---------------------------------------------------------------- geologist

/** Whether a geologist of `player` sent to (x, y) would find anything to examine there. */
export function canProspect(w: World, x: number, y: number, player: PlayerId): boolean {
  return anyAround(w, x, y, GEOLOGIST, (_i, tx, ty) => prospectable(w, tx, ty, player));
}

/** The player's pile with a free geologist's tool nearest to (x, y). */
export function toolPileNear(w: World, player: PlayerId, x: number, y: number): Building | undefined {
  const tool = PROFESSIONS.geologist.tool;
  if (!tool) return undefined;
  let from: Building | undefined;
  for (const b of w.buildings.values()) {
    if (b.owner !== player || !b.done || b.output[tool] - b.outReserved[tool] <= 0) continue;
    if (!from || Math.hypot(b.door.x - x, b.door.y - y) < Math.hypot(from.door.x - x, from.door.y - y)) from = b;
  }
  return from;
}

/** The player's free geologist nearest to (x, y), one waiting for an errand (`sendGeologist`). */
export function idleGeologist(w: World, player: PlayerId, x: number, y: number): Settler | undefined {
  return idleSpecialist(w, player, 'geologist', x, y);
}

/**
 * Player command: prospect the mountain around (x, y) — any mountain, his owner's or not. As in
 * Settlers 4 geologists are ordered in the settlers menu (`ORDERABLE`) and wait for errands: the
 * nearest free one goes. With none waiting, the free carrier nearest to the hammer pile nearest the
 * site takes up a hammer (a geologist on the spot, as if ordered and sent in one go: the order grows by
 * one, so he stays a geologist afterwards). False if there is nothing to examine there, or nobody and
 * no hammer to send.
 */
export function sendGeologist(w: World, x: number, y: number, player: PlayerId): boolean {
  const m = w.map;
  if (!m.inBounds(x, y) || m.terrain[m.idx(x, y)] !== Terrain.Mountain || !canProspect(w, x, y, player)) return false;
  const waiting = idleGeologist(w, player, x, y);
  if (waiting) {
    clearSpecialist(w, waiting);
    waiting.errand = { x, y };
    return true;
  }
  const tool = PROFESSIONS.geologist.tool;
  const from = tool ? toolPileNear(w, player, x, y) : undefined;
  if (tool && !from) return false;
  const near = from ? from.door : { x, y };
  let best: Settler | undefined;
  for (const s of w.settlers) {
    if (s.owner !== player || s.kind !== 'carrier' || s.tasks.length > 0 || w.dying.has(s.id)) continue;
    if (!best || Math.hypot(s.x - near.x, s.y - near.y) < Math.hypot(best.x - near.x, best.y - near.y)) best = s;
  }
  if (!best) return false;
  best.tasks = [];
  if (from && tool) {
    from.outReserved[tool]++;
    best.tasks.push({ t: 'goto', x: from.door.x, y: from.door.y }, { t: 'pickup', b: from.id, res: tool });
  }
  best.tasks.push({ t: 'retool', kind: 'geologist', errand: { x, y } });
  recountWorkers(w);
  const count = workersOf(w, player, 'geologist');
  if (count > workerOrder(w, player, 'geologist')) w.orderWorkers('geologist', count, player);
  return true;
}

/**
 * Idle geologist (the `prospect` behaviour): with an errand, examine the next tile of it (`nextTile`);
 * with none left in reach the errand is over and he stays standing there. Without an errand he waits
 * among the idle crowd for the next one — or, when the player has lowered the order below the
 * geologists he has, turns back into a carrier and brings the hammer home.
 */
export function geologistIdle(w: World, s: Settler): void {
  const e = s.errand;
  if (e) {
    const taken = takenBy(w, s, 'prospect');
    const t = nextTile(w, s, e, GEOLOGIST, (i, x, y) => !taken.has(i) && prospectable(w, x, y, s.owner));
    if (t) {
      e.n ??= 0;
      s.tasks = [
        { t: 'goto', x: t.x, y: t.y },
        { t: 'prospect', x: t.x, y: t.y, n: GEOLOGIST.ticks },
      ];
      return;
    }
    finishErrand(s);
  }
  if (workersOf(w, s.owner, s.kind) > workerOrder(w, s.owner, s.kind)) return toCarrier(w, s, s.owner, false);
  // A geologist of an old save still holding his hammer: it is his profession's tool now.
  if (s.carrying !== null && s.carrying === PROFESSIONS[s.kind].tool) s.carrying = null;
  if (specialistPostIdle(s)) return;
  restIdle(w, s);
}

/** `prospect` task: after `n` ticks of hammering, the tile carries the owner's sign. */
export function prospectTick(w: World, s: Settler, task: Extract<Task, { t: 'prospect' }>): void {
  s.working = true;
  if (--task.n > 0) return;
  const i = w.map.idx(task.x, task.y);
  const bit = 1 << (s.owner - 1);
  if (!(w.map.prospected[i] & bit)) {
    w.map.prospected[i] |= bit;
    w.map.touch(i);
    w.stats.prospected++;
  }
  if (s.errand) s.errand.n = (s.errand.n ?? 0) + 1;
  s.tasks.shift();
}

// ---------------------------------------------------------------- direct control

/**
 * Specialists take mouse orders like fighters (Settlers 4): the player selects them on the map and a
 * right click gives each the order that fits it there — the action of its kind (`SPECIALIST_ORDERS`)
 * where that action is possible, else walk there and wait (`Settler.post`, as a fighter's field post).
 * Public player commands (`World.orderSpecialists`, `holdSpecialists`, `dismissUnits`), usable by the AI.
 */
export const SPECIALIST_KINDS: readonly SettlerKind[] = ['geologist', 'pioneer', 'thief'];

export const isSpecialist = (s: Settler): boolean => SPECIALIST_KINDS.includes(s.kind);

export interface SpecialistOrder {
  /** What a right click does where `can` holds (the hover hint). */
  label: string;
  /** Whether the action applies at tile (x, y) / to building `b` under the cursor. */
  can(w: World, x: number, y: number, b: Building | undefined, player: PlayerId): boolean;
  /** Starts the action for one specialist (his previous errand already dropped). */
  apply(w: World, s: Settler, x: number, y: number, b: Building | undefined): boolean;
}

/** Per specialist kind: the action a right click starts where it is possible. */
export const SPECIALIST_ORDERS: Partial<Record<SettlerKind, SpecialistOrder>> = {
  geologist: {
    label: 'Разведать руду',
    can: (w, x, y, _b, player) => w.map.terrain[w.map.idx(x, y)] === Terrain.Mountain && canProspect(w, x, y, player),
    apply: (_w, s, x, y) => {
      s.errand = { x, y };
      return true;
    },
  },
  pioneer: {
    label: 'Занять землю',
    can: (w, x, y, _b, player) => pioneerSpot(w, x, y, player),
    apply: (_w, s, x, y) => {
      s.errand = { x, y };
      return true;
    },
  },
  thief: {
    label: 'Украсть',
    can: (w, _x, _y, b, player) => b !== undefined && robbable(w, b, player),
    apply: (_w, s, _x, _y, b) => {
      if (!b) return false;
      s.errand = { x: b.door.x, y: b.door.y, b: b.id };
      return true;
    },
  },
};

/** The player's own living specialists among `ids` that can take an order (outside a building). */
function ownSpecialists(w: World, ids: readonly number[], player: PlayerId): Settler[] {
  const out: Settler[] = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const s = w.getSettler(id);
    if (!s || w.dying.has(s.id) || s.owner !== player || !isSpecialist(s) || s.inside !== null) continue;
    out.push(s);
  }
  return out;
}

/**
 * Drops a specialist's errand and post; reservations are released (`abort`). He keeps his own tool
 * in hand (the geologist's hammer); anything else he carries (a thief's loot) still goes home.
 */
function clearSpecialist(w: World, s: Settler): void {
  const tool = PROFESSIONS[s.kind].tool;
  const keep = tool !== undefined && s.carrying === tool;
  if (keep) s.carrying = null;
  abort(w, s);
  if (keep && tool) s.carrying = tool;
  s.errand = null;
  s.post = null;
}

/**
 * Player command: a right click at (x, y) (on building `targetId`, if any) for the selected
 * specialists. Each does his kind's action there if it is possible; the rest walk there, spread out
 * around the spot, and wait. Returns how many obeyed.
 */
export function orderSpecialists(
  w: World,
  ids: readonly number[],
  x: number,
  y: number,
  targetId: number | null,
  player: PlayerId,
): number {
  const tx = Math.round(x);
  const ty = Math.round(y);
  if (!w.map.inBounds(tx, ty)) return 0;
  const b = targetId !== null ? w.buildings.get(targetId) : undefined;
  const walkers: Settler[] = [];
  let n = 0;
  for (const s of ownSpecialists(w, ids, player)) {
    clearSpecialist(w, s);
    const order = SPECIALIST_ORDERS[s.kind];
    if (order && order.can(w, tx, ty, b, player) && order.apply(w, s, tx, ty, b)) n++;
    else walkers.push(s);
  }
  const spots = formationSpots(w, tx, ty, walkers.length);
  if (spots.length === 0) return n;
  walkers.forEach((s, k) => {
    const spot = spots[Math.min(k, spots.length - 1)];
    s.post = { x: spot.x, y: spot.y };
  });
  return n + walkers.length;
}

/** Player command: the selected specialists drop their errand and wait where they stand. */
export function holdSpecialists(w: World, ids: readonly number[], player: PlayerId): number {
  const units = ownSpecialists(w, ids, player);
  for (const s of units) {
    clearSpecialist(w, s);
    s.post = { x: Math.round(s.x), y: Math.round(s.y) };
  }
  return units.length;
}

/**
 * Player command: the selected specialists standing on their owner's land go back to being carriers
 * (the order drops by one and the tool goes back to a warehouse). Returns how many.
 */
export function dismissUnits(w: World, ids: readonly number[], player: PlayerId): number {
  const m = w.map;
  let n = 0;
  for (const s of ownSpecialists(w, ids, player)) {
    if (m.owner[m.idx(Math.round(s.x), Math.round(s.y))] !== player) continue;
    clearSpecialist(w, s);
    if (ORDERABLE.includes(s.kind)) {
      // `toCarrier` sends the tool home itself.
      if (s.carrying !== null && s.carrying === PROFESSIONS[s.kind].tool) s.carrying = null;
      toCarrier(w, s, player);
    }
    n++;
  }
  return n;
}

/**
 * Idle specialist with a post (sent somewhere without an action, or told to hold): walks there and
 * waits. True if it handled the settler.
 */
export function specialistPostIdle(s: Settler): boolean {
  const p = s.post;
  if (!p || s.errand) return false;
  if (Math.hypot(s.x - p.x, s.y - p.y) > FIELD.slack) s.tasks = [{ t: 'goto', x: p.x, y: p.y }];
  else s.tasks = [{ t: 'wait', n: 10 }];
  return true;
}
