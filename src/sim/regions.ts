import type { GameMap } from './map';

/**
 * Connected walkable regions as a union-find over tile indices, so "is B reachable from A?" is
 * O(α) instead of a failed A* that floods the whole component.
 *
 * Kept incrementally under the game's connectivity invariant: tiles only become blocked after
 * `staysConnected` approved it, so blocking never splits a region and needs no update. A tile that
 * becomes walkable must be reported with `markWalkable`, which merges it with its neighbours.
 * Built lazily per map from its current state; it is derived data and never saved.
 */
class Regions {
  readonly parent: Int32Array;

  constructor(readonly map: GameMap) {
    this.parent = new Int32Array(map.w * map.h);
    for (let i = 0; i < this.parent.length; i++) this.parent[i] = i;
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        if (map.isWalkable(x, y)) this.linkForward(x, y);
      }
    }
  }

  find(i: number): number {
    const p = this.parent;
    let root = i;
    while (p[root] !== root) root = p[root];
    while (p[i] !== root) {
      const next = p[i];
      p[i] = root;
      i = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  /** Can a settler step directly between these two walkable neighbours (no corner cutting)? */
  private stepOk(x: number, y: number, dx: number, dy: number): boolean {
    const m = this.map;
    if (!m.isWalkable(x + dx, y + dy)) return false;
    return dx === 0 || dy === 0 || (m.isWalkable(x + dx, y) && m.isWalkable(x, y + dy));
  }

  /** Initial build: each pair is visited once, from the earlier tile. */
  private linkForward(x: number, y: number): void {
    const i = this.map.idx(x, y);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ]) {
      if (this.stepOk(x, y, dx, dy)) this.union(i, this.map.idx(x + dx, y + dy));
    }
  }

  linkAll(x: number, y: number): void {
    const i = this.map.idx(x, y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && this.stepOk(x, y, dx, dy)) this.union(i, this.map.idx(x + dx, y + dy));
      }
    }
    // A new walkable tile can also be the missing corner that lets two diagonal neighbours connect;
    // they are already joined through this tile by the unions above.
  }
}

const regionsByMap = new WeakMap<GameMap, Regions>();

function regionsFor(map: GameMap): Regions {
  let r = regionsByMap.get(map);
  if (!r) {
    r = new Regions(map);
    regionsByMap.set(map, r);
  }
  return r;
}

export function sameRegion(map: GameMap, a: number, b: number): boolean {
  const r = regionsFor(map);
  return r.find(a) === r.find(b);
}

/** Report a tile that just became walkable (tree felled, deposit mined out, building removed). */
export function markWalkable(map: GameMap, x: number, y: number): void {
  const r = regionsByMap.get(map);
  if (r && map.isWalkable(x, y)) r.linkAll(x, y);
}
