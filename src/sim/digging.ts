import { BUILD_MAX_SLOPE, BUILDINGS, CLEAR_STROKES_PER_TILE } from './config';
import type { GameMap } from './map';
import type { Building, BuildingType } from './types';

/**
 * Corners a site's flatness is judged on (and a digger flattens): every corner of the footprint
 * rows plus the door row, the same area `World.canPlace` measures with `heightRange`.
 */
function siteCorners(x: number, y: number, w: number, h: number): [number, number, number, number] {
  return [x, y, x + w, y + h + 1];
}

/** Whether an ordinary building placed here must be levelled by a digger first (mines never). */
export function needsLevelling(map: GameMap, type: BuildingType, x: number, y: number): boolean {
  const def = BUILDINGS[type];
  return def.terrain !== 'mountain' && map.heightRange(x, y, x + def.w - 1, y + def.h) > BUILD_MAX_SLOPE;
}

/** Whether a site of this type is cleared by a digger before building (all but mines). */
export function needsDigger(type: BuildingType): boolean {
  return BUILDINGS[type].terrain !== 'mountain';
}

/** Spade strokes it takes to clear a site, levelling aside. */
export function clearStrokes(b: Pick<Building, 'w' | 'h'>): number {
  return b.w * b.h * CLEAR_STROKES_PER_TILE;
}

/** The height a site is flattened to: the rounded mean of its corners. */
export function levelTarget(map: GameMap, b: Pick<Building, 'x' | 'y' | 'w' | 'h'>): number {
  const [x0, y0, x1, y1] = siteCorners(b.x, b.y, b.w, b.h);
  let sum = 0;
  let n = 0;
  for (let vy = y0; vy <= y1; vy++) {
    for (let vx = x0; vx <= x1; vx++) {
      sum += map.vertexHeight(vx, vy);
      n++;
    }
  }
  return Math.round(sum / n);
}

/**
 * One spade of work: the corner furthest from the target moves one pixel towards it (first in scan
 * order on ties, so it is deterministic). Returns true once every corner is at the target.
 */
export function levelStep(map: GameMap, b: Building): boolean {
  const [x0, y0, x1, y1] = siteCorners(b.x, b.y, b.w, b.h);
  let worst = 0;
  let wx = 0;
  let wy = 0;
  for (let vy = y0; vy <= y1; vy++) {
    for (let vx = x0; vx <= x1; vx++) {
      if (vx < 0 || vy < 0 || vx > map.w || vy > map.h) continue;
      const d = Math.abs(map.vertexHeight(vx, vy) - b.levelTo);
      if (d > worst) {
        worst = d;
        wx = vx;
        wy = vy;
      }
    }
  }
  if (worst === 0) return true;
  const h = map.vertexHeight(wx, wy);
  map.setVertexHeight(wx, wy, h + Math.sign(b.levelTo - h));
  return false;
}
