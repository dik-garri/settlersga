import { BUILDINGS } from './config';
import type { Building, PlayerId, Point } from './types';
import type { World } from './world';

/**
 * Pieces of land, as in Settlers 4: carriers work only on their player's own territory, so goods
 * move only between buildings standing on one connected piece of it. `World.land` gives every owned
 * tile the id of its piece (8-connected tiles of the same owner; 0 = nobody's land). It is derived
 * from `map.owner` and rebuilt lazily whenever `territoryVersion` moved (`recomputeTerritory`, a
 * pioneer's claim, a load), so it is never saved.
 *
 * A piece cut off from every warehouse (a captured tower deep in enemy land, a pioneer's patch, land
 * split by a lost tower) is supplied only by donkeys between marketplaces (`trade.ts`).
 */

/** Rebuilds `w.land` if the territory changed since it was built. */
function ensureLand(w: World): void {
  if (w.landVersion !== w.territoryVersion) rebuildLand(w);
}

/** Flood-fill queue, shared by every world (the fill never yields). */
let scratch = new Int32Array(0);

/** Rebuilds `w.land` from tile ownership: a flood fill per piece, O(map). */
export function rebuildLand(w: World): void {
  w.landVersion = w.territoryVersion;
  const m = w.map;
  const n = m.w * m.h;
  if (w.land.length !== n) w.land = new Int32Array(n);
  const land = w.land;
  land.fill(0);
  if (scratch.length < n) scratch = new Int32Array(n);
  const queue = scratch;
  let next = 0;
  for (let start = 0; start < n; start++) {
    const owner = m.owner[start];
    if (owner === 0 || land[start] !== 0) continue;
    const id = ++next;
    land[start] = id;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      const x = i % m.w;
      const y = (i - x) / m.w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= m.h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= m.w) continue;
          const j = ny * m.w + nx;
          if (land[j] !== 0 || m.owner[j] !== owner) continue;
          land[j] = id;
          queue[tail++] = j;
        }
      }
    }
  }
  w.landPieces = next;
  w.storedPieces = null;
}

/** The piece of `player`'s land at this point, or 0 when the tile is not theirs. */
export function landAt(w: World, p: Point, player: PlayerId): number {
  ensureLand(w);
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (!w.map.inBounds(x, y)) return 0;
  const i = w.map.idx(x, y);
  return w.map.owner[i] === player ? w.land[i] : 0;
}

/** The piece of land a building's door stands on (where its goods are handled), 0 if on foreign land. */
export function landOf(w: World, b: Building): number {
  return landAt(w, b.door, b.owner);
}

/**
 * Pieces of land holding a finished warehouse of their owner (castle included). Cached until the
 * buildings or the territory change.
 */
function storedPieces(w: World): Set<number> {
  ensureLand(w);
  if (w.storedPieces && w.storedPiecesAt === w.buildingsVersion) return w.storedPieces;
  const set = new Set<number>();
  for (const b of w.buildings.values()) {
    if (b.done && BUILDINGS[b.type].storage) {
      const piece = landOf(w, b);
      if (piece) set.add(piece);
    }
  }
  w.storedPieces = set;
  w.storedPiecesAt = w.buildingsVersion;
  return set;
}

/**
 * Whether the building stands on land with no warehouse of its owner: carriers there have nowhere
 * to take goods from or to, only donkeys can supply it (the UI marks it).
 */
export function isCutOff(w: World, b: Building): boolean {
  const piece = landOf(w, b);
  return piece === 0 || !storedPieces(w).has(piece);
}
