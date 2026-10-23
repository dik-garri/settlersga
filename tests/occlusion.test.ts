import { describe, expect, it } from 'vitest';
import { generateMap } from '../src/sim/map';
import { OCCLUDE_MARGIN, occluderDepth, occludes, type HeightGrid } from '../src/render/occlusion';

const N = 24;

/** Corner heights from a function of the corner's depth (vx + vy): a ridge across the view. */
function grid(height: (vx: number, vy: number) => number): HeightGrid {
  return { vertexHeight: (vx, vy) => height(Math.min(N, Math.max(0, vx)), Math.min(N, Math.max(0, vy))) };
}

function occluders(g: HeightGrid): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (occludes(g, N, N, x, y)) out.add(`${x},${y}`);
  return out;
}

describe('ground hiding what stands behind it', () => {
  it('level ground, a high plateau and front-facing slopes hide nothing', () => {
    expect(occluders(grid(() => 0)).size).toBe(0);
    expect(occluders(grid(() => 200)).size).toBe(0);
    // Rising away from the viewer (lower depth higher), however steep.
    expect(occluders(grid((vx, vy) => Math.min(255, 12 * (2 * N - vx - vy)))).size).toBe(0);
    // Falling away from the viewer, but gentler than the view ray (16 px of height per unit of depth).
    expect(occluders(grid((vx, vy) => Math.min(255, 14 * (vx + vy)))).size).toBe(0);
  });

  it('a crest rising towards the viewer faster than the view ray hides the ground behind it', () => {
    // Depth d = vx + vy: rises 30 px a unit up to the crest at depth 24, then falls.
    const crest = 24;
    const g = grid((vx, vy) => Math.max(0, 240 - 30 * Math.abs(vx + vy - crest)));
    const occ = occluders(g);
    expect(occ.size).toBeGreaterThan(0);
    for (const key of occ) {
      const [x, y] = key.split(',').map(Number);
      // The slope up to the crest faces away (each of its tiles hides the ground behind it) and the
      // crest hides it all; the level ground behind the slope and the far side's foot hide nothing.
      expect(x + y).toBeGreaterThanOrEqual(crest - 8 - 1);
      expect(x + y).toBeLessThanOrEqual(crest + 6);
    }
    // Every tile on the crest line (away from the map's edges) occludes.
    for (let x = 4; x <= 20; x++) expect(occ.has(`${x},${crest - x - 1}`) || occ.has(`${x},${crest - x}`)).toBe(true);
  });

  it('sorts an occluder just over what stands behind its upper edges, under what stands on it', () => {
    const d = 30;
    expect(occluderDepth(d)).toBeGreaterThan(d - 1);
    expect(occluderDepth(d)).toBeLessThan(d - 1 + 0.05);
    expect(OCCLUDE_MARGIN).toBeGreaterThan(0);
  });

  it('flags few tiles of a generated map, and only where its relief is steep', () => {
    const m = generateMap(7, 256, [{ x: 128, y: 128 }]);
    let n = 0;
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (!occludes(m, m.w, m.h, x, y)) continue;
        n++;
        // Something within reach behind it lies lower than its highest corner.
        expect(m.heightRange(Math.max(0, x - 8), Math.max(0, y - 8), x, y)).toBeGreaterThan(16);
      }
    }
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(m.w * m.h * 0.05);
  });
});
