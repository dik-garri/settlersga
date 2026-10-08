import { describe, expect, it } from 'vitest';
import { generateMap, type GameMap } from '../src/sim/map';
import { findPath } from '../src/sim/pathfinding';
import { Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import { base } from './helpers';

const isWet = (m: GameMap, i: number) => m.terrain[i] === Terrain.Water || m.terrain[i] === Terrain.Ford;

/** 4-connected components of water (fords count as water), as lists of tile indices. */
function waterBodies(m: GameMap): number[][] {
  const seen = new Uint8Array(m.w * m.h);
  const out: number[][] = [];
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !isWet(m, i)) continue;
    const body: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      body.push(c);
      const x = c % m.w;
      const y = Math.floor(c / m.w);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (!m.inBounds(x + dx, y + dy)) continue;
        const n = m.idx(x + dx, y + dy);
        if (!seen[n] && isWet(m, n)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    out.push(body);
  }
  return out;
}

/** Largest connected mountain area (8-connected): its tile count and its longest side in tiles. */
function largestRange(m: GameMap): { area: number; extent: number } {
  const seen = new Uint8Array(m.w * m.h);
  const isHigh = (i: number) => m.terrain[i] === Terrain.Mountain || m.terrain[i] === Terrain.Rock;
  let best = { area: 0, extent: 0 };
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !isHigh(i)) continue;
    let area = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      area++;
      const x = c % m.w;
      const y = Math.floor(c / m.w);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!m.inBounds(x + dx, y + dy)) continue;
          const n = m.idx(x + dx, y + dy);
          if (!seen[n] && isHigh(n)) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (area > best.area) best = { area, extent: Math.max(x1 - x0, y1 - y0) + 1 };
  }
  return best;
}

describe('rivers', () => {
  it('are deterministic and get fords', () => {
    const a = generateMap(42, 128, [{ x: 64, y: 64 }]);
    const b = generateMap(42, 128, [{ x: 64, y: 64 }]);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.height).toEqual(b.height);
    let fords = 0;
    for (const t of a.terrain) if (t === Terrain.Ford) fords++;
    expect(fords).toBeGreaterThan(0);
  });

  it('run into the sea or end in a lake, not as stray puddles', () => {
    for (const seed of [1, 42, 7]) {
      const m = generateMap(seed, 128, [{ x: 64, y: 64 }]);
      for (const body of waterBodies(m)) {
        if (body.some((i) => m.terrain[i] === Terrain.Ford)) expect(body.length).toBeGreaterThan(6);
      }
    }
  });

  it('keep the starts connected by land and leave room to build around each start', () => {
    for (const size of [64, 128, 256]) {
      for (const seed of [42, 7]) {
        const w = new World(seed, { size, players: 2 });
        const a = w.homeOf(1);
        const b = w.homeOf(2);
        expect(findPath(w.map, a.x, a.y, b.x, b.y), `size ${size} seed ${seed}`).not.toBeNull();
        for (const p of w.players) {
          const c = base(w, p.id);
          let spots = 0;
          for (let y = c.y - 9; y <= c.y + 9; y++) {
            for (let x = c.x - 9; x <= c.x + 9; x++) if (w.canPlace('woodcutter', x, y, p.id)) spots++;
          }
          expect(spots, `size ${size} seed ${seed} player ${p.id}`).toBeGreaterThan(20);
        }
      }
    }
  });
});

describe('mountain ranges', () => {
  it('form long chains on big maps without burying them in rock', () => {
    // Without ridges the largest mountain area on these seeds spans only 40–48 tiles.
    for (const seed of [42, 999, 5]) {
      const m = generateMap(seed, 256, [{ x: 128, y: 128 }]);
      expect(largestRange(m).extent, `seed ${seed}`).toBeGreaterThanOrEqual(64);
      let high = 0;
      for (const t of m.terrain) if (t === Terrain.Mountain || t === Terrain.Rock) high++;
      expect(high / m.terrain.length).toBeGreaterThan(0.05);
      expect(high / m.terrain.length).toBeLessThan(0.25);
    }
  });
});
