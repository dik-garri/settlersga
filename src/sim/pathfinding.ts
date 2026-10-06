import type { GameMap } from './map';
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
 */
export function findPath(
  map: GameMap,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  adjacent = false,
): Point[] | null {
  const isGoal = adjacent
    ? (x: number, y: number) => Math.max(Math.abs(x - tx), Math.abs(y - ty)) === 1
    : (x: number, y: number) => x === tx && y === ty;

  if (isGoal(sx, sy)) return [];
  if (!adjacent && !map.isWalkable(tx, ty)) return null;

  const n = map.w * map.h;
  const g = new Float32Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = new MinHeap();

  const start = map.idx(sx, sy);
  g[start] = 0;
  open.push(start, octile(sx, sy, tx, ty));

  while (open.size > 0) {
    const cur = open.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
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
      if (closed[ni]) continue;
      const ng = g[cur] + cost;
      if (ng < g[ni]) {
        g[ni] = ng;
        from[ni] = cur;
        open.push(ni, ng + octile(nx, ny, tx, ty));
      }
    }
  }
  return null;
}
