/**
 * Where the mountains' rocks go (render-only, no Pixi, so it is unit-tested): impassable peaks
 * (`Terrain.Rock`) get craggy outcrops over 2×2 tiles, one at most per `ROCK_CELL`² cell, picked by
 * the cell's hash, with boulders and loose stones on some of the rock tiles left over; walkable slopes
 * (`Terrain.Mountain`) only the odd small stone. Everything is chosen by tile hash, so a chunk lays out
 * the same every time it is (re)built, and nothing goes on a tile with a tree, a deposit, a building,
 * a door or goods on the ground — the renderer lays a chunk out again when those change
 * (`refreshRocks`), and `rockKey` tells it whether anything moved.
 */
import type { GameMap } from '../sim/map';
import { Terrain } from '../sim/types';
import { depthOf } from './iso';

export type RockSize = 'small' | 'medium' | 'large';
export const ROCK_SIZES: readonly RockSize[] = ['small', 'medium', 'large'];

/** One rock to draw: where its anchor stands (tile coordinates), its depth, sprite and scale. */
export interface RockSpot {
  x: number;
  y: number;
  depth: number;
  size: RockSize;
  variant: number;
  scale: number;
  /** Tile the rock is registered under (its front tile for an outcrop). */
  tile: number;
}

/** Side of the cells outcrops are picked in; divides `CHUNK`, so a cell never straddles chunks. */
export const ROCK_CELL = 4;
/** Out of 10 cells, how many try to hold an outcrop (it needs its 2×2 tiles to be free rock). */
const OUTCROP_IN_10 = 8;
/** Rock tiles outside outcrops, out of `ROCK_ROLL`: this many get a boulder, then this many small stones. */
const ROCK_ROLL = 8;
const ROCK_MEDIUM = 3;
const ROCK_SMALL = 2;
/** About one walkable mountain tile in this many gets a few loose stones. */
const SLOPE_EVERY = 6;
/** Scale ranges per size: the variants' natural spread, never so far that a stone turns into a crag. */
const SCALE: Record<RockSize, [number, number]> = { small: [0.8, 1.1], medium: [0.95, 1.25], large: [0.88, 1.12] };

function hash(i: number): number {
  let h = Math.imul(i ^ 0x2f6b1c39, 0x9e3779b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** True where nothing stands that a rock would overlap. */
function freeTile(map: GameMap, i: number): boolean {
  return map.tree[i] === 0 && map.stone[i] === 0 && map.building[i] === 0 && map.door[i] === 0 && map.goods[i] === 0;
}

function scaleOf(size: RockSize, h: number): number {
  const [lo, hi] = SCALE[size];
  return lo + ((h % 101) / 100) * (hi - lo);
}

/**
 * The rocks of the tiles x0 ≤ x < x1, y0 ≤ y < y1 (a chunk: x0 and y0 multiples of `ROCK_CELL`), with
 * `variants` sprites per size. Outcrops first (they claim their tiles), then the remaining tiles in
 * row order.
 */
export function rockLayout(
  map: GameMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  variants: Record<RockSize, number>,
): RockSpot[] {
  const spots: RockSpot[] = [];
  const w = x1 - x0;
  const taken = new Uint8Array(w * (y1 - y0));
  const rockAt = (x: number, y: number) => {
    const i = map.idx(x, y);
    return map.terrain[i] === Terrain.Rock && freeTile(map, i);
  };
  for (let cy = y0; cy < y1; cy += ROCK_CELL) {
    for (let cx = x0; cx < x1; cx += ROCK_CELL) {
      const h = hash(map.idx(cx, cy) * 7 + 1);
      if (h % 10 >= OUTCROP_IN_10) continue;
      // The outcrop's front tile; its 2×2 area (front tile and the three behind it) stays in the cell.
      // The first of the cell's places, from one picked by hash on, where all four are free rock.
      const places = (ROCK_CELL - 1) * (ROCK_CELL - 1);
      let ax = -1;
      let ay = -1;
      for (let k = 0; k < places; k++) {
        const p = ((h >>> 4) + k) % places;
        const x = cx + 1 + (p % (ROCK_CELL - 1));
        const y = cy + 1 + Math.floor(p / (ROCK_CELL - 1));
        if (x >= x1 || y >= y1) continue;
        if (rockAt(x, y) && rockAt(x - 1, y) && rockAt(x, y - 1) && rockAt(x - 1, y - 1)) {
          ax = x;
          ay = y;
          break;
        }
      }
      if (ax < 0) continue;
      for (const [x, y] of [[ax, ay], [ax - 1, ay], [ax, ay - 1], [ax - 1, ay - 1]]) taken[x - x0 + (y - y0) * w] = 1;
      spots.push({
        x: ax - 0.5,
        y: ay - 0.5,
        // Between its back row and its front tile: what stands beside the front tile (same depth) is
        // drawn over the bulk of the rock, which rises from the tiles behind it.
        depth: depthOf(ax, ay) - 0.6,
        size: 'large',
        variant: (h >>> 24) % variants.large,
        scale: scaleOf('large', h >>> 16),
        tile: map.idx(ax, ay),
      });
    }
  }
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (taken[x - x0 + (y - y0) * w]) continue;
      const i = map.idx(x, y);
      const t = map.terrain[i];
      if ((t !== Terrain.Rock && t !== Terrain.Mountain) || !freeTile(map, i)) continue;
      const h = hash(i * 13 + 5);
      let size: RockSize;
      if (t === Terrain.Rock) {
        const roll = h % ROCK_ROLL;
        if (roll < ROCK_MEDIUM) size = 'medium';
        else if (roll < ROCK_MEDIUM + ROCK_SMALL) size = 'small';
        else continue;
      } else {
        if (h % SLOPE_EVERY !== 0) continue;
        size = 'small';
      }
      // Off the tile centre, but on the tile; loose stones on a walkable tile lie under whoever stands
      // there, so they sort half a row back.
      const ox = (((h >>> 8) % 41) / 40 - 0.5) * 0.5;
      const oy = (((h >>> 14) % 41) / 40 - 0.5) * 0.5;
      spots.push({
        x: x + ox,
        y: y + oy,
        depth: depthOf(x + ox, y + oy) - (t === Terrain.Mountain ? 0.5 : 0),
        size,
        variant: (h >>> 20) % variants[size],
        scale: scaleOf(size, h >>> 3),
        tile: i,
      });
    }
  }
  return spots;
}

/** A checksum of a layout: equal layouts give equal keys (used to skip rebuilding an unchanged chunk). */
export function rockKey(spots: readonly RockSpot[]): number {
  let k = spots.length;
  for (const s of spots) k = (Math.imul(k, 31) + s.tile * 3 + ROCK_SIZES.indexOf(s.size)) >>> 0;
  return k;
}
