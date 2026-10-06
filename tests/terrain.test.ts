import { describe, expect, it } from 'vitest';
import { BUILD_DIG_SLOPE, BUILD_MAX_SLOPE, oreOf } from '../src/sim/config';
import { needsLevelling } from '../src/sim/digging';
import { GameMap, generateMap } from '../src/sim/map';
import { Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Mean elevation at the centers of tiles of the given terrain. */
function meanHeight(map: GameMap, t: Terrain): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (map.terrain[map.idx(x, y)] !== t) continue;
      sum += map.heightAt(x, y);
      n++;
    }
  }
  return n ? sum / n : NaN;
}

describe('terrain heights', () => {
  it('are deterministic per seed', () => {
    const a = generateMap(42, 64, [{ x: 32, y: 32 }]);
    const b = generateMap(42, 64, [{ x: 32, y: 32 }]);
    expect(a.height).toEqual(b.height);
    expect(a.height).not.toEqual(generateMap(43, 64, [{ x: 32, y: 32 }]).height);
  });

  it('keep water at the bottom, grass gentle, mountains raised and peaks highest', () => {
    for (const seed of [42, 7, 123]) {
      const map = generateMap(seed, 128, [{ x: 64, y: 64 }]);
      for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
          if (map.terrain[map.idx(x, y)] !== Terrain.Water) continue;
          for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) expect(map.vertexHeight(vx, vy)).toBe(0);
        }
      }
      const grass = meanHeight(map, Terrain.Grass);
      const mountain = meanHeight(map, Terrain.Mountain);
      const rock = meanHeight(map, Terrain.Rock);
      expect(grass).toBeLessThan(20);
      expect(mountain).toBeGreaterThan(grass + 8);
      if (!Number.isNaN(rock)) expect(rock).toBeGreaterThan(mountain);
    }
  });

  it('level the castle meadow', () => {
    for (const seed of [42, 7, 999]) {
      const map = generateMap(seed, 64, [{ x: 32, y: 32 }]);
      expect(map.heightRange(28, 28, 36, 36)).toBeLessThanOrEqual(1);
    }
  });

  it('level every start meadow when several players share the map', () => {
    for (const seed of [42, 7]) {
      const starts = [
        { x: 24, y: 24 },
        { x: 72, y: 72 },
      ];
      const map = generateMap(seed, 96, starts);
      for (const st of starts) {
        expect(map.heightRange(st.x - 4, st.y - 4, st.x + 4, st.y + 4)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('interpolate bilinearly between tile corners', () => {
    const map = new GameMap(2, 2);
    // Corners of tile (0, 0): (0,0)=0, (1,0)=10, (0,1)=20, (1,1)=30.
    map.height.set([0, 10, 0, 20, 30, 0, 0, 0, 0]);
    expect(map.heightAt(-0.5, -0.5)).toBe(0);
    expect(map.heightAt(0.5, -0.5)).toBe(10);
    expect(map.heightAt(0, 0)).toBe(15); // tile center = mean of its corners
    expect(map.heightAt(0, -0.5)).toBe(5);
    expect(map.heightRange(0, 0, 0, 0)).toBe(30);
  });
});

describe('building on slopes', () => {
  it('ordinary buildings need level or levellable ground, mines do not', () => {
    const w = new World(42);
    const m = w.map;
    // A spot that is fine now…
    let spot: { x: number; y: number } | null = null;
    for (let y = 0; y < m.h && !spot; y++) for (let x = 0; x < m.w && !spot; x++) if (w.canPlace('woodcutter', x, y)) spot = { x, y };
    expect(spot).not.toBeNull();
    // …still allowed when moderately sloped (a digger will level it first)…
    const v = (spot!.y + 1) * (m.w + 1) + spot!.x + 1;
    const base = m.vertexHeight(spot!.x + 1, spot!.y + 1);
    m.height[v] = base + BUILD_MAX_SLOPE + 4;
    expect(w.canPlace('woodcutter', spot!.x, spot!.y)).toBe(true);
    expect(needsLevelling(m, 'woodcutter', spot!.x, spot!.y)).toBe(true);
    // …and refused once one of its corners rises beyond what a digger can level.
    m.height[v] = base + BUILD_DIG_SLOPE + 4;
    expect(w.canPlace('woodcutter', spot!.x, spot!.y)).toBe(false);

    let mine: { x: number; y: number } | null = null;
    for (let y = 0; y < m.h && !mine; y++) {
      for (let x = 0; x < m.w && !mine; x++) {
        if (w.canPlace('coalmine', x, y) && oreOf(m.ore[m.idx(x, y)]) !== null) mine = { x, y };
      }
    }
    expect(mine).not.toBeNull();
    m.height[(mine!.y + 1) * (m.w + 1) + mine!.x + 1] = 200;
    expect(w.canPlace('coalmine', mine!.x, mine!.y)).toBe(true);
  });
});
