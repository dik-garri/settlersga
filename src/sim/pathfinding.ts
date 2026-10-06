import { TERRAIN_COST } from './config';
import type { GameMap } from './map';
import { sameRegion } from './regions';
import type { Point } from './types';

const DIRS: readonly [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.keys.length = 0;
  }

  push(item: number, key: number): void {
    const items = this.items;
    const keys = this.keys;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): number {
    const items = this.items;
    const keys = this.keys;
    const top = items[0];
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}

/** Counters for benchmarks and profiling; never read by game logic. */
export const pathStats = { calls: 0, failures: 0, expanded: 0, expandedInFailures: 0 };

/**
 * Search buffers reused across calls on the same map, so a search costs what it explores
 * rather than the map area. A node's g/from are valid only if `seen[i] === stamp`.
 */
interface Scratch {
  g: Float32Array;
  from: Int32Array;
  seen: Uint32Array;
  closed: Uint32Array;
  stamp: number;
  open: MinHeap;
}

const scratchByMap = new WeakMap<GameMap, Scratch>();

function scratchFor(map: GameMap): Scratch {
  let s = scratchByMap.get(map);
  if (!s) {
    const n = map.w * map.h;
    s = {
      g: new Float32Array(n),
      from: new Int32Array(n),
      seen: new Uint32Array(n),
      closed: new Uint32Array(n),
      stamp: 0,
      open: new MinHeap(),
    };
    scratchByMap.set(map, s);
  }
  if (++s.stamp === 0xffffffff) {
    s.seen.fill(0);
    s.closed.fill(0);
    s.stamp = 1;
  }
  s.open.clear();
  return s;
}

function goalInStartRegion(map: GameMap, sx: number, sy: number, tx: number, ty: number, adjacent: boolean): boolean {
  const start = map.idx(sx, sy);
  if (!adjacent) return sameRegion(map, start, map.idx(tx, ty));
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = tx + dx;
      const y = ty + dy;
      if ((dx || dy) && map.isWalkable(x, y) && sameRegion(map, start, map.idx(x, y))) return true;
    }
  }
  return false;
}

/**
 * Slightly inflating the heuristic breaks ties between equal-cost nodes in favour of the ones
 * closer to the goal, which cuts expansions on open ground; paths stay within 0.1% of optimal.
 */
const TIE_BREAK = 1.001;

function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

/**
 * A* over the tile grid with 8-way movement (no cutting blocked corners).
 * Returns the tiles to walk through, excluding the start, or null if unreachable.
 * With `adjacent`, any walkable tile touching the target counts as the goal
 * (used for blocked targets such as trees). The start tile is always allowed.
 * `useRegions` lets hopeless searches fail in O(1) (see regions.ts); tests disable it to cross-check.
 */
export function findPath(
  map: GameMap,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  adjacent = false,
  useRegions = true,
): Point[] | null {
  const isGoal = adjacent
    ? (x: number, y: number) => Math.max(Math.abs(x - tx), Math.abs(y - ty)) === 1
    : (x: number, y: number) => x === tx && y === ty;

  pathStats.calls++;
  if (isGoal(sx, sy)) return [];
  if (!adjacent && !map.isWalkable(tx, ty)) {
    pathStats.failures++;
    return null;
  }

  if (useRegions && !goalInStartRegion(map, sx, sy, tx, ty, adjacent)) {
    pathStats.failures++;
    return null;
  }

  const { g, from, seen, closed, stamp, open } = scratchFor(map);
  const expandedBefore = pathStats.expanded;

  const start = map.idx(sx, sy);
  g[start] = 0;
  seen[start] = stamp;
  open.push(start, octile(sx, sy, tx, ty) * TIE_BREAK);

  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur] === stamp) continue;
    closed[cur] = stamp;
    pathStats.expanded++;
    const cx = cur % map.w;
    const cy = (cur - cx) / map.w;

    if (isGoal(cx, cy)) {
      const path: Point[] = [];
      let i = cur;
      while (i !== start) {
        path.push({ x: i % map.w, y: Math.floor(i / map.w) });
        i = from[i];
      }
      return path.reverse();
    }

    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.isWalkable(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!map.isWalkable(cx + dx, cy) || !map.isWalkable(cx, cy + dy))) {
        continue;
      }
      const ni = map.idx(nx, ny);
      if (closed[ni] === stamp) continue;
      // Slow terrain (swamp) costs more to enter, so routes go around it when that is cheaper.
      const ng = g[cur] + cost * TERRAIN_COST[map.terrain[ni]];
      if (seen[ni] !== stamp || ng < g[ni]) {
        seen[ni] = stamp;
        g[ni] = ng;
        from[ni] = cur;
        open.push(ni, ng + octile(nx, ny, tx, ty) * TIE_BREAK);
      }
    }
  }
  pathStats.failures++;
  pathStats.expandedInFailures += pathStats.expanded - expandedBefore;
  return null;
}

const CONNECT_RADIUS = 5;

/**
 * Whether the tile at (x, y) can become blocked without cutting any route through it:
 * all walkable neighbours must stay mutually reachable inside a small window around the
 * tile. Conservative — a detour longer than the window counts as disconnected.
 */
export function staysConnected(map: GameMap, x: number, y: number): boolean {
  const minX = x - CONNECT_RADIUS;
  const minY = y - CONNECT_RADIUS;
  const size = CONNECT_RADIUS * 2 + 1;
  const inWindow = (nx: number, ny: number) => nx >= minX && ny >= minY && nx < minX + size && ny < minY + size;
  const open = (nx: number, ny: number) => !(nx === x && ny === y) && inWindow(nx, ny) && map.isWalkable(nx, ny);

  const neighbours: [number, number][] = [];
  for (const [dx, dy] of DIRS) {
    if (open(x + dx, y + dy)) neighbours.push([x + dx, y + dy]);
  }
  if (neighbours.length <= 1) return true;

  const seen = new Uint8Array(size * size);
  const key = (nx: number, ny: number) => (ny - minY) * size + (nx - minX);
  const queue: [number, number][] = [neighbours[0]];
  seen[key(...neighbours[0])] = 1;
  while (queue.length > 0) {
    const [cx, cy] = queue.pop()!;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!open(nx, ny) || seen[key(nx, ny)]) continue;
      if (dx !== 0 && dy !== 0 && (!open(cx + dx, cy) || !open(cx, cy + dy))) continue;
      seen[key(nx, ny)] = 1;
      queue.push([nx, ny]);
    }
  }
  return neighbours.every(([nx, ny]) => seen[key(nx, ny)] === 1);
}
