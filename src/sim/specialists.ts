import { nearestStorage } from './buildings';
import { FIELD, ORDERABLE, PIONEER, PROFESSIONS, PROSPECT_RADIUS, PROSPECT_TICKS, PROSPECT_TILES, THIEF } from './config';
import { recountWorkers, workerOrder, workersOf } from './economy';
import { restIdle } from './idle';
import { formationSpots } from './field';
import { sameRegion } from './regions';
import { abort, carryBack } from './settlers';
import { RESOURCES, Terrain, type Building, type PlayerId, type Resource, type Settler, type SettlerKind, type Task } from './types';
import type { World } from './world';

/**
 * Specialists, as in Settlers 4: made from free carriers on the player's order (`ORDERABLE`, like
 * builders), then sent on errands.
 *
 * Pioneer: `sendPioneer` points him at neutral land next to his owner's; there he claims tiles one by
 * one — each a neutral, passable tile 4-adjacent to the owner's land within `PIONEER.radius` of the
 * spot, the nearest first — until `PIONEER.maxTiles` are his or none is left. A claim is recorded in
 * `map.claimed` (saved) and the tile's `map.owner` is set at once; `recomputeTerritory` keeps giving
 * claimed tiles to their claimant wherever no military building claims them, so land a tower or castle
 * claims always wins, and the claim comes back if that building goes. Pioneers never claim owned land.
 *
 * Thief: `sendThief` points him at a foreign, explored building with goods at its door (or in stock);
 * he walks there unnoticed, takes one unit of its most plentiful good in `THIEF.stealTicks` and carries
 * it to his owner's nearest warehouse, then goes back for more until the building is bare or gone.
 * On hostile land every specialist may be cut down by that land's swordsmen, the thief once unmasked
 * (`intruders.ts`, `INTRUDERS`).
 *
 * Geologist: `sendGeologist` points him at a mountain of his owner's; he examines up to
 * `PROSPECT_TILES` unexamined tiles around the spot and leaves a sign on each (`map.prospected`).
 *
 * All keep their errand in `Settler.errand` (saved); without one they idle with the crowd.
 * `dismissSpecialist` turns an idle one standing on his owner's land back into a carrier (bringing the
 * tool back to a warehouse) and lowers the order.
 */

const N4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Whether a pioneer of `player` may claim the tile: neutral, passable, next to the player's land. */
export function claimable(w: World, x: number, y: number, player: PlayerId): boolean {
  const m = w.map;
  if (!m.inBounds(x, y)) return false;
  const i = m.idx(x, y);
  if (m.owner[i] !== 0 || !m.isWalkable(x, y)) return false;
  return N4.some(([dx, dy]) => m.inBounds(x + dx, y + dy) && m.owner[m.idx(x + dx, y + dy)] === player);
}

/**
 * The claimable tile within `PIONEER.radius` of (cx, cy) nearest to the pioneer `from` (ties: lowest
 * index), among those he can walk to (`sameRegion`, O(1)): a tile across a lake or a swamp would send
 * him into a failed route and a back-off, then to the same tile again, for ever.
 */
function nextClaim(w: World, cx: number, cy: number, player: PlayerId, from: { x: number; y: number }) {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  const r = PIONEER.radius;
  const m = w.map;
  const at = m.idx(Math.round(from.x), Math.round(from.y));
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (Math.hypot(x - cx, y - cy) > r || !claimable(w, x, y, player) || !sameRegion(m, at, m.idx(x, y))) continue;
      const d = Math.hypot(x - from.x, y - from.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/** The player's idle specialist of `kind` nearest to (x, y). */
function idleSpecialist(w: World, player: PlayerId, kind: SettlerKind, x: number, y: number): Settler | undefined {
  let best: Settler | undefined;
  let bestD = Infinity;
  for (const s of w.settlers) {
    if (s.owner !== player || s.kind !== kind || s.tasks.length > 0 || s.errand || w.dying.has(s.id)) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Player command: send an idle pioneer to push the border around (x, y). */
export function sendPioneer(w: World, x: number, y: number, player: PlayerId): boolean {
  const s = idleSpecialist(w, player, 'pioneer', x, y);
  if (!s || !nextClaim(w, x, y, player, s)) return false;
  s.errand = { x, y, n: PIONEER.maxTiles };
  return true;
}

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

/** Player command: send an idle thief to rob building `targetId`. */
export function sendThief(w: World, targetId: number, player: PlayerId): boolean {
  const b = w.buildings.get(targetId);
  if (!b || !robbable(w, b, player)) return false;
  const s = idleSpecialist(w, player, 'thief', b.door.x, b.door.y);
  if (!s) return false;
  s.errand = { x: b.door.x, y: b.door.y, b: b.id };
  return true;
}

/**
 * Player command: one idle specialist (or other orderable worker) of `kind` on his owner's land goes
 * back to being a carrier, bringing his tool back to a warehouse; the order drops by one.
 */
export function dismissSpecialist(w: World, kind: Settler['kind'], player: PlayerId): boolean {
  const m = w.map;
  const s = w.settlers.find(
    (o) =>
      o.owner === player &&
      o.kind === kind &&
      o.tasks.length === 0 &&
      !o.errand &&
      o.inside === null &&
      m.owner[m.idx(Math.round(o.x), Math.round(o.y))] === player,
  );
  if (!s) return false;
  toCarrier(w, s, player);
  return true;
}

/**
 * An orderable worker (geologist, pioneer, thief…) turns back into a carrier and brings his tool back to
 * a warehouse (`carryBack`); the order drops by one unless `lowerOrder` is false (a geologist sent
 * without one ordered, `geologistIdle`).
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

/** Idle pioneer: claim the next tile of the errand, or hang about once it is done. */
export function pioneerIdle(w: World, s: Settler): void {
  const e = s.errand;
  if (e && (e.n ?? 0) > 0) {
    const t = nextClaim(w, e.x, e.y, s.owner, s);
    if (t) {
      s.tasks = [
        { t: 'goto', x: t.x, y: t.y },
        { t: 'claim', x: t.x, y: t.y, n: PIONEER.claimTicks },
      ];
      return;
    }
  }
  s.errand = null;
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
  if (s.errand && s.errand.n !== undefined) s.errand.n--;
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

// ---------------------------------------------------------------- geologist

/** Unprospected, walkable mountain tiles of the player's land the geologist examines around (x, y), nearest first. */
export function prospectTiles(w: World, x: number, y: number, player: PlayerId): { x: number; y: number; d: number }[] {
  const m = w.map;
  if (!m.inBounds(x, y) || !w.owns(x, y, player) || m.terrain[m.idx(x, y)] !== Terrain.Mountain) return [];
  const tiles: { x: number; y: number; d: number }[] = [];
  for (let ty = y - PROSPECT_RADIUS; ty <= y + PROSPECT_RADIUS; ty++) {
    for (let tx = x - PROSPECT_RADIUS; tx <= x + PROSPECT_RADIUS; tx++) {
      const d = Math.hypot(tx - x, ty - y);
      if (d > PROSPECT_RADIUS || !w.owns(tx, ty, player) || !m.isWalkable(tx, ty)) continue;
      if (m.terrain[m.idx(tx, ty)] !== Terrain.Mountain || w.isProspected(tx, ty, player)) continue;
      tiles.push({ x: tx, y: ty, d });
    }
  }
  return tiles.sort((a, b) => a.d - b.d).slice(0, PROSPECT_TILES);
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

/** The player's idle geologist nearest to (x, y), one waiting for an errand (`sendGeologist`). */
export function idleGeologist(w: World, player: PlayerId, x: number, y: number): Settler | undefined {
  return idleSpecialist(w, player, 'geologist', x, y);
}

/**
 * Player command: prospect the mountain around (x, y). As in Settlers 4 geologists are ordered in the
 * settlers menu (`ORDERABLE`) and wait for errands: the nearest idle one goes. With none waiting, the
 * free carrier nearest to the hammer pile nearest the site takes up a hammer (a geologist on the spot,
 * as if ordered and sent in one go); after the errand he turns back into a carrier unless the player
 * has ordered that many geologists by then (`geologistIdle`). False if there is nothing to examine
 * there, or nobody and no hammer to send.
 */
export function sendGeologist(w: World, x: number, y: number, player: PlayerId): boolean {
  if (prospectTiles(w, x, y, player).length === 0) return false;
  const waiting = idleGeologist(w, player, x, y);
  if (waiting) {
    waiting.post = null;
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
  return true;
}

/**
 * Idle geologist (the `prospect` behaviour): with an errand, walk the unexamined mountain tiles around
 * it (up to `PROSPECT_TILES`, nearest first); with none, wait among the idle crowd for the next one —
 * or, when the player has more geologists than ordered (one sent without an order), turn back into a
 * carrier and bring the hammer home.
 */
export function geologistIdle(w: World, s: Settler): void {
  const e = s.errand;
  if (e) {
    s.errand = null;
    const tiles = prospectTiles(w, e.x, e.y, s.owner);
    if (tiles.length > 0) {
      s.tasks = tiles.flatMap((t): Task[] => [
        { t: 'goto', x: t.x, y: t.y },
        { t: 'prospect', x: t.x, y: t.y, n: PROSPECT_TICKS },
      ]);
      return;
    }
  }
  if (workersOf(w, s.owner, s.kind) > workerOrder(w, s.owner, s.kind)) return toCarrier(w, s, s.owner, false);
  // A geologist of an old save still holding his hammer: it is his profession's tool now.
  if (s.carrying !== null && s.carrying === PROFESSIONS[s.kind].tool) s.carrying = null;
  restIdle(w, s);
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
    can: (w, x, y, _b, player) => prospectTiles(w, x, y, player).length > 0,
    apply: (_w, s, x, y) => {
      s.errand = { x, y };
      return true;
    },
  },
  pioneer: {
    label: 'Занять землю',
    can: (w, x, y, _b, player) => nextClaim(w, x, y, player, { x, y }) !== null,
    apply: (_w, s, x, y) => {
      s.errand = { x, y, n: PIONEER.maxTiles };
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
