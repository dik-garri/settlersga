import { BUILD_MAX_SLOPE, BUILDINGS, CLEAR_STROKES_PER_TILE, DIG_STROKES_PER_DIGGER, MAX_DIGGERS } from './config';
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

/** Spade strokes a site still needs: levelling steps left (one per pixel per corner) plus clearing. */
export function strokesLeft(map: GameMap, b: Building): number {
  let left = Math.max(0, clearStrokes(b) - b.dug);
  if (b.levelTo < 0) return left;
  const [x0, y0, x1, y1] = siteCorners(b.x, b.y, b.w, b.h);
  for (let vy = y0; vy <= y1; vy++) {
    for (let vx = x0; vx <= x1; vx++) {
      if (vx < 0 || vy < 0 || vx > map.w || vy > map.h) continue;
      left += Math.abs(map.vertexHeight(vx, vy) - b.levelTo);
    }
  }
  return left;
}

/**
 * Diggers a site takes at once, as in Settlers 4: one, plus one per `DIG_STROKES_PER_DIGGER` strokes
 * still to do, at most `MAX_DIGGERS`.
 */
export function diggersWanted(map: GameMap, b: Building): number {
  return Math.min(MAX_DIGGERS, Math.floor((strokesLeft(map, b) + DIG_STROKES_PER_DIGGER / 2) / DIG_STROKES_PER_DIGGER) + 1);
}

/** Takes a settler off a site's builders and diggers (he left, died, or the job was aborted). */
export function leaveSite(b: Building, id: number): void {
  const i = b.builderIds.indexOf(id);
  if (i >= 0) b.builderIds.splice(i, 1);
  const j = b.diggerIds.indexOf(id);
  if (j >= 0) b.diggerIds.splice(j, 1);
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
