import { FIELD, GEOLOGIST, GEOLOGIST_SIGN, ORDERABLE, oreOf, PIONEER, PROFESSIONS, THIEF } from './config';
import { postMessage } from './messages';
import { recountWorkers, spareCarriers, workerOrder, workersOf } from './economy';
import { restIdle } from './idle';
import { formationSpots } from './field';
import { freeGoods, goodsOn, liftGoods, reserveGoods, stackTiles } from './ground';
import { sitePile } from './logistics';
import { sameRegion } from './regions';
import { abort, carryBack } from './settlers';
import { RESOURCES, Terrain, type Building, type PlayerId, type Point, type Resource, type Settler, type SettlerKind, type Task } from './types';
import type { GameMap } from './map';
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
 * Pioneer: claims neutral passable tiles (`claimable`), one per `claim` task: the tile's `map.owner`
 * is set at once and stays his owner's like any land (`territory.ts`). It carries no influence, so
 * another player's tower that covers it takes it, as in Settlers 4. Pioneers never claim owned land.
 *
 * Geologist: puts up a sign (`map.signAt`/`signBy`; what his owner learns goes to `map.prospected`,
 * per player, for good) on every walkable mountain tile without a sign of his owner's (`prospectable`),
 * his owner's land, neutral or foreign, one per `prospect` task — the whole ridge. Signs come down
 * after `GEOLOGIST_SIGN`'s lifetime (`signEnds`), and the tile may then be examined again.
 *
 * Thief (`THIEF`, Settlers 4's `CThiefRole`): sent to a spot (`sendThief` — a foreign building's door —
 * or any explored spot by mouse), he takes one unit off the first stack round it (`lootAt`: a pile at
 * a building's door or goods on the ground; on his own or an ally's land only goods on the ground),
 * carries it to his home point (`Settler.homeAt`) and puts it on the ground there, then goes back
 * while there is loot. On hostile land every specialist may be cut down by that land's swordsmen, the
 * thief once a hostile fighter has unmasked him (`intruders.ts`, `INTRUDERS`).
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
  return m.terrain[m.idx(x, y)] === Terrain.Mountain && m.isWalkable(x, y) && !hasSign(w, m.idx(x, y), player);
}

/** Tick at which the sign on tile `i` comes down (`GEOLOGIST_SIGN`), 0 if none was ever put up there. */
export function signEnds(m: GameMap, i: number): number {
  const at = m.signAt[i];
  if (at === 0) return 0;
  let h = Math.imul(i ^ 0x2c1b3c6d, 0x27d4eb2d);
  h ^= h >>> 15;
  return at - 1 + GEOLOGIST_SIGN.lifetime + ((h >>> 0) % (GEOLOGIST_SIGN.spread + 1));
}

/** Whether a sign of `player`'s geologists stands on tile `i`. */
export function hasSign(w: World, i: number, player: PlayerId): boolean {
  return w.map.signBy[i] === player && w.tick < signEnds(w.map, i);
}

/** Symbols on a sign for `amount` units of ore under the tile: 1 (a little), 2 or 3 (a lot); 0 for none. */
export function signLevel(amount: number): number {
  if (amount <= 0) return 0;
  const [some, lots] = GEOLOGIST_SIGN.levels;
  return amount < some ? 1 : amount < lots ? 2 : 3;
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
  m.owner[i] = s.owner;
  w.territoryVersion++;
  if (s.errand) s.errand.n = (s.errand.n ?? 0) + 1;
}

// ---------------------------------------------------------------- thief

/** Where a thief takes a unit from: a building's pile at its door, or a stack on the ground. */
export interface Loot {
  x: number;
  y: number;
  res: Resource;
  /** The building whose pile it is (none: goods on the ground). */
  b?: number;
  from: 'output' | 'input' | 'site' | 'ground';
}

/** Units of `res` a building's pile of kind `from` holds that nobody has claimed. */
function pileOf(b: Building, from: Loot['from'], res: Resource): number {
  if (from === 'output') return b.output[res] - b.outReserved[res];
  if (from === 'input') return b.input[res] - (b.trade?.loading[res] ?? 0);
  return sitePile(b, res);
}

/** The fullest pile at a building's door, output first, then input, then a site's materials. */
function buildingLoot(b: Building): Pick<Loot, 'res' | 'from'> | null {
  let best: Pick<Loot, 'res' | 'from'> | null = null;
  let most = 0;
  for (const from of (b.done ? ['output', 'input'] : ['site']) as Loot['from'][]) {
    for (const r of RESOURCES) {
      const n = pileOf(b, from, r);
      if (n > most) {
        most = n;
        best = { res: r, from };
      }
    }
  }
  return best;
}

/**
 * What a thief of `player` sent to (x, y) takes (Settlers 4 `CThiefRole::CheckGoodInSurrounding`): the
 * first stack in a spiral of `THIEF.lootRadius` round the spot — a building's pile at its door (a
 * producer's output, a workshop's input, a warehouse's stock, a site's materials) or goods on the
 * ground. On his own or an ally's land only goods on the ground (he moves his player's goods). Only
 * on tiles the player has explored.
 */
export function lootAt(w: World, x: number, y: number, player: PlayerId): Loot | null {
  const m = w.map;
  const offs = spiral(THIEF.lootRadius);
  for (let k = 0; k < offs.length; k += 2) {
    const tx = x + offs[k];
    const ty = y + offs[k + 1];
    if (!m.inBounds(tx, ty) || !w.isExplored(tx, ty, player)) continue;
    const i = m.idx(tx, ty);
    const land = m.owner[i];
    const friendly = land !== 0 && w.allied(land, player);
    const door = m.door[i];
    if (door && !friendly) {
      const b = w.buildings.get(door);
      if (b && !w.allied(b.owner, player)) {
        const l = buildingLoot(b);
        if (l) return { x: tx, y: ty, b: b.id, ...l };
      }
    }
    const res = goodsOn(w, i);
    if (res && freeGoods(w, i) > 0) return { x: tx, y: ty, res, from: 'ground' };
  }
  return null;
}

/** Whether a thief of `player` may be sent to rob `b`: not allied, explored, with loot at its door. */
export function robbable(w: World, b: Building, player: PlayerId): boolean {
  if (w.allied(b.owner, player)) return false;
  const l = lootAt(w, b.door.x, b.door.y, player);
  return !!l && l.b === b.id;
}

/** The thief's home point (`Settler.homeAt`): where he stood when first asked, until an order moves it. */
function thiefHome(s: Settler): Point {
  return (s.homeAt ??= { x: Math.round(s.x), y: Math.round(s.y) });
}

/** An order to (x, y) on the thief's own or an ally's land moves his home point there (Settlers 4). */
function orderedTo(w: World, s: Settler, x: number, y: number): void {
  thiefHome(s);
  const m = w.map;
  if (!m.inBounds(x, y)) return;
  const land = m.owner[m.idx(x, y)];
  if (land !== 0 && w.allied(land, s.owner)) s.homeAt = { x, y };
}

/** Player command: send the nearest free thief to rob building `targetId`. */
export function sendThief(w: World, targetId: number, player: PlayerId): boolean {
  const b = w.buildings.get(targetId);
  if (!b || !robbable(w, b, player)) return false;
  const s = idleSpecialist(w, player, 'thief', b.door.x, b.door.y);
  if (!s) return false;
  clearSpecialist(w, s);
  orderedTo(w, s, b.door.x, b.door.y);
  s.errand = { x: b.door.x, y: b.door.y };
  return true;
}

/**
 * Idle thief: with loot in hand, to his home point, where he puts it on the ground (Settlers 4: not
 * into a warehouse; his player's carriers take it from there); then back to the spot while there is
 * loot round it; with none he stays where he stands.
 */
export function thiefIdle(w: World, s: Settler): void {
  const home = thiefHome(s);
  if (s.carrying) {
    if (Math.round(s.x) !== home.x || Math.round(s.y) !== home.y) {
      s.tasks = [{ t: 'goto', x: home.x, y: home.y }];
      return;
    }
    carryBack(w, s, s.carrying);
  }
  const e = s.errand;
  if (!e) return restIdle(w, s);
  const loot = lootAt(w, e.x, e.y, s.owner);
  if (!loot) return finishErrand(s);
  s.tasks = [
    { t: 'goto', x: loot.x, y: loot.y },
    { t: 'steal', x: loot.x, y: loot.y, n: THIEF.stealTicks },
  ];
}

/**
 * `steal` task: after `n` ticks at the stack, take one unit of it (if it is still there for him) and
 * carry it home (`thiefIdle`).
 */
export function stealTick(w: World, s: Settler, task: Extract<Task, { t: 'steal' }>): void {
  s.working = true;
  if (--task.n > 0) return;
  s.tasks.shift();
  // The first stack still there for him at that very tile (a radius of 0).
  const loot = lootAt(w, task.x, task.y, s.owner);
  if (!loot || loot.x !== task.x || loot.y !== task.y) return;
  if (loot.b !== undefined) {
    const b = w.buildings.get(loot.b)!;
    if (loot.from === 'output') b.output[loot.res]--;
    else if (loot.from === 'input') b.input[loot.res]--;
    else b.delivered[loot.res]--;
  } else {
    const i = w.map.idx(loot.x, loot.y);
    reserveGoods(w, i);
    if (!liftGoods(w, i, loot.res)) return;
  }
  s.carrying = loot.res;
}

// ---------------------------------------------------------------- dismissal

/**
 * Player command: one free specialist (or other orderable worker) of `kind` on his owner's land goes
 * back to being a carrier, putting his tool down on the ground; the order drops by one.
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
 * An orderable worker (geologist, pioneer, thief…) turns back into a carrier and puts his tool down on
 * the ground next to him (`carryBack`, Settlers 4's `CSettler::ChangeType`); the order drops by one
 * unless `lowerOrder` is false (a geologist over the order, `geologistIdle`).
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

/**
 * The player's pile with a free geologist's tool nearest to (x, y): a building's (at its door) or
 * goods lying on the ground of its land (`ground.ts`; the start goods, as in Settlers 4).
 */
export function toolPileNear(w: World, player: PlayerId, x: number, y: number): { at: Point; b?: Building; tile?: number } | undefined {
  const tool = PROFESSIONS.geologist.tool;
  if (!tool) return undefined;
  let from: { at: Point; b?: Building; tile?: number } | undefined;
  let best = Infinity;
  for (const b of w.buildings.values()) {
    if (b.owner !== player || !b.done || b.output[tool] - b.outReserved[tool] <= 0) continue;
    const d = Math.hypot(b.door.x - x, b.door.y - y);
    if (d < best) {
      from = { at: b.door, b };
      best = d;
    }
  }
  const m = w.map;
  for (const i of stackTiles(w)) {
    if (m.owner[i] !== player || goodsOn(w, i) !== tool || freeGoods(w, i) <= 0) continue;
    const at = { x: i % m.w, y: Math.floor(i / m.w) };
    const d = Math.hypot(at.x - x, at.y - y);
    if (d < best) {
      from = { at, tile: i };
      best = d;
    }
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
  // Taking a carrier for it respects the carrier reserve, like any recruitment (`spareCarriers`).
  if (spareCarriers(w, player) <= 0) return false;
  const tool = PROFESSIONS.geologist.tool;
  const from = tool ? toolPileNear(w, player, x, y) : undefined;
  if (tool && !from) return false;
  const near = from ? from.at : { x, y };
  let best: Settler | undefined;
  for (const s of w.settlers) {
    if (s.owner !== player || s.kind !== 'carrier' || s.tasks.length > 0 || s.strike || w.dying.has(s.id)) continue;
    if (!best || Math.hypot(s.x - near.x, s.y - near.y) < Math.hypot(best.x - near.x, best.y - near.y)) best = s;
  }
  if (!best) return false;
  best.tasks = [];
  if (from && tool) {
    best.tasks.push({ t: 'goto', x: from.at.x, y: from.at.y });
    if (from.b) {
      from.b.outReserved[tool]++;
      best.tasks.push({ t: 'pickup', b: from.b.id, res: tool });
    } else {
      reserveGoods(w, from.tile!);
      best.tasks.push({ t: 'lift', x: from.at.x, y: from.at.y, res: tool });
    }
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
    const since = (e.since ??= w.tick);
    // Never twice in one errand, even where a sign of his has come down meanwhile (on a long ridge).
    const again = (i: number) => w.map.signBy[i] === s.owner && w.map.signAt[i] - 1 >= since;
    const t = nextTile(w, s, e, GEOLOGIST, (i, x, y) => !taken.has(i) && prospectable(w, x, y, s.owner) && !again(i));
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
    w.stats.prospected++;
  }
  w.map.signAt[i] = w.tick + 1;
  w.map.signBy[i] = s.owner;
  w.map.touch(i);
  // Ore under his sign: his owner hears of it (Settlers 4 tells of a find), at most once a minute per ore.
  const ore = oreOf(w.map.ore[i]);
  if (ore && w.map.oreAmount[i] > 0) postMessage(w, 'oreFound', s.owner, task, { res: ore });
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
    // At a building: its door; elsewhere the spot itself (goods lying there, on his own land too).
    can: (w, x, y, b, player) => (b ? robbable(w, b, player) : lootAt(w, x, y, player) !== null),
    apply: (w, s, x, y, b) => {
      const at = b ? b.door : { x, y };
      s.errand = { x: at.x, y: at.y };
      return w.map.inBounds(at.x, at.y);
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
 * around the spot, and wait. With `walkOnly` (Settlers 4's Alt + right click, «go to the location»)
 * they all just walk there. Returns how many obeyed.
 */
export function orderSpecialists(
  w: World,
  ids: readonly number[],
  x: number,
  y: number,
  targetId: number | null,
  player: PlayerId,
  walkOnly = false,
): number {
  const tx = Math.round(x);
  const ty = Math.round(y);
  if (!w.map.inBounds(tx, ty)) return 0;
  const b = targetId !== null ? w.buildings.get(targetId) : undefined;
  const walkers: Settler[] = [];
  let n = 0;
  for (const s of ownSpecialists(w, ids, player)) {
    clearSpecialist(w, s);
    if (PROFESSIONS[s.kind].behavior === 'thief') orderedTo(w, s, b ? b.door.x : tx, b ? b.door.y : ty);
    const order = SPECIALIST_ORDERS[s.kind];
    if (!walkOnly && order && order.can(w, tx, ty, b, player) && order.apply(w, s, tx, ty, b)) n++;
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
    if (PROFESSIONS[s.kind].behavior === 'thief') orderedTo(w, s, s.post.x, s.post.y);
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
