/**
 * Which ground hides what stands behind it (render-only, no Pixi, so it is unit-tested). The ground is
 * drawn under everything standing on it, so without help a tree, a house or a settler behind a steep
 * crest shows through the slope in front of it. On the isometric heightfield a point P is hidden by
 * ground in front of it in its screen column when that ground projects higher on screen than P does:
 * this happens only behind slopes that rise towards the viewer faster than the view ray (more than
 * `HALF_H` px of height per unit of depth), i.e. behind crests.
 *
 * `occludes` tells whether tile (x, y) covers on screen any point behind it — the points that the
 * renderer's depth order puts under it (depth below `occluderDepth`): its silhouette (the upper
 * envelope of its projected quad) is compared, in three screen columns through its middle and halfway
 * to its side corners, with the ground behind in those columns (corners, tile centres and edge
 * midpoints, back to where even the lowest ground could not be hidden any more). On level or
 * front-facing ground nothing behind a tile ever projects under it, so almost every tile is no
 * occluder; the renderer cuts the occluders' shape out of everything drawn before them
 * (`GameRenderer`, erase blend in the objects layer).
 */
import { HALF_H } from './iso';

/** The corner heights the test reads (`TileView`, as the local player knows them). */
export interface HeightGrid {
  vertexHeight(vx: number, vy: number): number;
}

/** A point behind has to lie this far (screen px) under a tile's silhouette before the tile counts. */
export const OCCLUDE_MARGIN = 3;

/**
 * Depth (`depthOf` scale) an occluder for tiles of depth `d` (x + y) is sorted at: just in front of its
 * back corner (d − 1) and of the centres of the tiles behind its upper edges, so what stands on those
 * is cut, what stands on the tile itself is not.
 */
export function occluderDepth(d: number): number {
  return d - 0.98;
}

/** Screen y (flat projection minus height) of corner (vx, vy): tile coordinates (vx − ½, vy − ½). */
function cornerY(g: HeightGrid, vx: number, vy: number): number {
  return (vx + vy - 1) * HALF_H - g.vertexHeight(vx, vy);
}

/**
 * Whether tile (x, y) of a `w`×`h` map hides on screen some ground behind it (depth below
 * `occluderDepth(x + y)`) by more than `OCCLUDE_MARGIN` px. Cost: a few corner lookups per depth unit
 * back, and only as far back as the tile's own height allows (low ground stops at once).
 */
export function occludes(g: HeightGrid, w: number, h: number, x: number, y: number): boolean {
  const top = cornerY(g, x, y);
  const right = cornerY(g, x + 1, y);
  const bottom = cornerY(g, x + 1, y + 1);
  const left = cornerY(g, x, y + 1);
  // The silhouette in the three columns (the quad is cut along its top–bottom diagonal).
  const envMid = Math.min(top, bottom) + OCCLUDE_MARGIN;
  const envLeft = Math.min(left + top, left + bottom) / 2 + OCCLUDE_MARGIN;
  const envRight = Math.min(right + top, right + bottom) / 2 + OCCLUDE_MARGIN;
  const lowest = Math.min(envMid, envLeft, envRight);
  const inMap = (vx: number, vy: number) => vx >= 0 && vy >= 0 && vx <= w && vy <= h;
  for (let k = 1; ; k++) {
    // The foremost point looked at k steps back lies at depth x + y − 2k + ½; were it at height 0 and
    // still above the silhouette, nothing this far back or further can be hidden.
    if ((x + y - 2 * k + 0.5) * HALF_H <= lowest) return false;
    // Middle column: corner (x − k, y − k) and the centre of tile (x − k, y − k) just in front of it.
    const vx = x - k;
    const vy = y - k;
    if (inMap(vx, vy)) {
      const a = cornerY(g, vx, vy);
      if (a > envMid) return true;
      if (inMap(vx + 1, vy + 1)) {
        const centre = (a + cornerY(g, vx + 1, vy) + cornerY(g, vx + 1, vy + 1) + cornerY(g, vx, vy + 1)) / 4;
        if (centre > envMid) return true;
      }
    }
    // Left half-column: the midpoints of the edges from corner (x − k, y + 1 − k) back and forward.
    const lx = x - k;
    const ly = y + 1 - k;
    if (inMap(lx, ly)) {
      const l = cornerY(g, lx, ly);
      if (inMap(lx, ly - 1) && (l + cornerY(g, lx, ly - 1)) / 2 > envLeft) return true;
      if (inMap(lx + 1, ly) && (l + cornerY(g, lx + 1, ly)) / 2 > envLeft) return true;
    }
    // Right half-column, mirrored.
    const rx = x + 1 - k;
    const ry = y - k;
    if (inMap(rx, ry)) {
      const r = cornerY(g, rx, ry);
      if (inMap(rx - 1, ry) && (r + cornerY(g, rx - 1, ry)) / 2 > envRight) return true;
      if (inMap(rx, ry + 1) && (r + cornerY(g, rx, ry + 1)) / 2 > envRight) return true;
    }
  }
}
