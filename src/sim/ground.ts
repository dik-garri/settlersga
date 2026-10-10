/**
 * Goods lying on the ground, as Settlers 4's piles: the start goods (no headquarters, `addPlayer`),
 * what is left of a demolished or burnt building, and whatever a carrier puts down when his job is
 * cancelled. Each tile holds one kind of good, up to `GROUND.perStack` units (map layers `goods`,
 * `goodsAmount`, `goodsReserved`, saved with the map). A stack belongs to whoever owns the land it
 * lies on: only that player's carriers take from it.
 *
 * For logistics a stack is a supply like a producer's output pile: carriers take from it for sites
 * and workshops (`logistics.ts`), and carry it to a warehouse that accepts the good and has room; never
 * the other way round. A unit promised to a carrier counts in `goodsReserved` until he lifts it (the
 * `lift` task) or his job is aborted (`abort` releases it), as `outReserved` does for buildings.
 *
 * Stacks never block walking, so they need no connectivity checks; they make the tile unbuildable and
 * unplantable (`GameMap.isBuildable`/`isPlantable`), so nothing ever grows or is built over them.
 * Every change calls `map.touch` for the renderer.
 */
import { GROUND, TERRAIN } from './config';
import { RESOURCES, Terrain, type PlayerId, type Point, type Resource } from './types';
import type { World } from './world';
import { dist2, within } from './fmath';

/** The good lying on tile `i`, or null. */
export function goodsOn(w: World, i: number): Resource | null {
  const k = w.map.goods[i];
  return k === 0 ? null : RESOURCES[k - 1];
}

/** Units on tile `i` not yet promised to a carrier. */
export function freeGoods(w: World, i: number): number {
  return w.map.goodsAmount[i] - w.map.goodsReserved[i];
}

/** Tiles holding goods, in index order (derived from the map layers, cached until a stack appears or goes). */
export function stackTiles(w: World): readonly number[] {
  if (!w.stackOrder) w.stackOrder = [...w.stacks].sort((a, b) => a - b);
  return w.stackOrder;
}

/** Rebuilds the derived set of stacked tiles from the map (after a load). */
export function rebuildStacks(w: World): void {
  w.stacks.clear();
  for (let i = 0; i < w.map.goods.length; i++) if (w.map.goods[i] !== 0) w.stacks.add(i);
  w.stackOrder = null;
}

/** Units of `res` lying on the player's land, not yet promised to anyone. */
export function groundStock(w: World, owner: PlayerId, res: Resource): number {
  const m = w.map;
  const k = RESOURCES.indexOf(res) + 1;
  let n = 0;
  for (const i of w.stacks) if (m.goods[i] === k && m.owner[i] === owner) n += m.goodsAmount[i] - m.goodsReserved[i];
  return n;
}

export function reserveGoods(w: World, i: number): void {
  w.map.goodsReserved[i]++;
}

/** Releases a promise made with `reserveGoods` (an aborted `lift`). */
export function releaseGoods(w: World, i: number): void {
  if (w.map.goodsReserved[i] > 0) w.map.goodsReserved[i]--;
}

/** The `lift` task: takes one promised unit of `res` off tile `i`. False if it is not there. */
export function liftGoods(w: World, i: number, res: Resource): boolean {
  const m = w.map;
  if (goodsOn(w, i) !== res || m.goodsAmount[i] === 0) return false;
  m.goodsAmount[i]--;
  releaseGoods(w, i);
  if (m.goodsAmount[i] === 0) clearStack(w, i);
  m.touch(i);
  return true;
}

function clearStack(w: World, i: number): void {
  w.map.goods[i] = 0;
  w.map.goodsReserved[i] = 0;
  w.stacks.delete(i);
  w.stackOrder = null;
}

/** Whether one more unit of good `k` may lie on tile (x, y): walkable dry land, free or a stack of it with room. */
function canHold(w: World, x: number, y: number, k: number): boolean {
  const m = w.map;
  if (!m.inBounds(x, y) || !m.isWalkable(x, y)) return false;
  const i = m.idx(x, y);
  if (TERRAIN[m.terrain[i] as Terrain].water || m.door[i] !== 0 || m.crop[i] !== 0) return false;
  return m.goods[i] === 0 || (m.goods[i] === k && m.goodsAmount[i] < GROUND.perStack);
}

/** Offsets around a point, nearest first (ties in a fixed order), up to `GROUND.searchRadius`. */
const SPIRAL: readonly [number, number][] = (() => {
  const r = GROUND.searchRadius;
  const out: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (within(dx, dy, r + 0.5)) out.push([dx, dy]);
  return out.sort((a, b) => dist2(a[0], a[1]) - dist2(b[0], b[1]) || a[1] - b[1] || a[0] - b[0]);
})();

/**
 * Puts `n` units of `res` on the ground as near (x, y) as there is room: a stack of the same good
 * with room first if it is the nearest, else a free tile (`canHold`), up to `GROUND.perStack` per tile,
 * within `GROUND.searchRadius`. `skip` keeps tiles free (the start tower's surroundings). Returns
 * the units that found no room (the caller counts them lost).
 */
export function putGoods(w: World, at: Point, res: Resource, n: number, skip?: (x: number, y: number) => boolean): number {
  const m = w.map;
  const k = RESOURCES.indexOf(res) + 1;
  const cx = Math.round(at.x);
  const cy = Math.round(at.y);
  for (const [dx, dy] of SPIRAL) {
    if (n <= 0) break;
    const x = cx + dx;
    const y = cy + dy;
    if (!canHold(w, x, y, k) || skip?.(x, y)) continue;
    const i = m.idx(x, y);
    if (m.goods[i] === 0) {
      m.goods[i] = k;
      m.goodsAmount[i] = 0;
      m.goodsReserved[i] = 0;
      w.stacks.add(i);
      w.stackOrder = null;
    }
    const put = Math.min(n, GROUND.perStack - m.goodsAmount[i]);
    m.goodsAmount[i] += put;
    n -= put;
    m.touch(i);
  }
  return n;
}

/** Puts goods down near `at`; whatever finds no room is counted lost. */
export function dropGoods(w: World, at: Point, res: Resource, n: number): void {
  const left = putGoods(w, at, res, n);
  if (left > 0) w.stats.lost[res] += left;
}
