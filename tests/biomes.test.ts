import { describe, expect, it } from 'vitest';
import { TERRAIN } from '../src/sim/config';
import { GameMap, generateMap } from '../src/sim/map';
import { canPlant } from '../src/sim/nature';
import { findPath } from '../src/sim/pathfinding';
import { Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';

function count(map: GameMap, t: Terrain): number {
  let n = 0;
  for (const v of map.terrain) if (v === t) n++;
  return n;
}

describe('terrain table', () => {
  it('drives walking, building and planting', () => {
    const map = new GameMap(4, 4);
    const at = (t: Terrain) => {
      map.terrain[map.idx(1, 1)] = t;
      return {
        walk: map.isWalkable(1, 1),
        build: map.isBuildable(1, 1),
        plant: map.isPlantable(1, 1),
      };
    };
    expect(at(Terrain.Grass)).toEqual({ walk: true, build: true, plant: true });
    expect(at(Terrain.Desert)).toEqual({
      walk: true,
      build: true,
      plant: false,
    });
    expect(at(Terrain.Swamp)).toEqual({
      walk: false,
      build: false,
      plant: false,
    });
    expect(at(Terrain.Sand)).toEqual({
      walk: true,
      build: false,
      plant: false,
    });
    expect(at(Terrain.Water)).toEqual({
      walk: false,
      build: false,
      plant: false,
    });
    expect(map.isBuildable(1, 1, Terrain.Mountain)).toBe(false);
    map.terrain[map.idx(1, 1)] = Terrain.Mountain;
    expect(map.isBuildable(1, 1, 'mountain')).toBe(true);
    expect(map.isBuildable(1, 1)).toBe(false);
  });

  it('nothing is planted on desert, even inside own territory', () => {
    const w = new World(42);
    const c = w.castle;
    const x = c.x + 4;
    const y = c.y - 2;
    expect(canPlant(w, 'tree', x, y, 1)).toBe(true);
    w.map.terrain[w.map.idx(x, y)] = Terrain.Desert;
    expect(canPlant(w, 'tree', x, y, 1)).toBe(false);
    expect(canPlant(w, 'grain', x, y, 1)).toBe(false);
  });
});

describe('deserts and swamps', () => {
  it('are generated deterministically, without trees, and keep start areas green', () => {
    let desert = 0;
    let swamp = 0;
    for (const seed of [42, 7, 123]) {
      const starts = [
        { x: 34, y: 34 },
        { x: 94, y: 94 },
      ];
      const a = generateMap(seed, 128, starts);
      expect(a.terrain).toEqual(generateMap(seed, 128, starts).terrain);
      desert += count(a, Terrain.Desert);
      swamp += count(a, Terrain.Swamp);
      for (let i = 0; i < a.terrain.length; i++) {
        if (a.terrain[i] === Terrain.Desert || a.terrain[i] === Terrain.Swamp) expect(a.tree[i]).toBe(0);
      }
      for (const st of starts) {
        for (let y = st.y - 10; y <= st.y + 10; y++) {
          for (let x = st.x - 10; x <= st.x + 10; x++) {
            if (Math.hypot(x - st.x, y - st.y) > 10) continue;
            const t = a.terrain[a.idx(x, y)];
            expect(t === Terrain.Desert || t === Terrain.Swamp, `${seed} ${x},${y}`).toBe(false);
          }
        }
      }
    }
    expect(desert).toBeGreaterThan(200);
    expect(swamp).toBeGreaterThan(100);
  });
});

describe('impassable swamp', () => {
  it('A* walks round a swamp and finds no way when the swamp closes the gap', () => {
    // A two-tile-wide swamp band across the map with one dry gap.
    const map = new GameMap(20, 20);
    for (let y = 0; y < 20; y++) {
      if (y === 12) continue;
      map.terrain[map.idx(10, y)] = Terrain.Swamp;
      map.terrain[map.idx(11, y)] = Terrain.Swamp;
    }
    const path = findPath(map, 2, 10, 17, 10)!;
    expect(path).not.toBeNull();
    expect(path.some((p) => map.terrain[map.idx(p.x, p.y)] === Terrain.Swamp)).toBe(false);
    map.terrain[map.idx(10, 12)] = Terrain.Swamp;
    map.terrain[map.idx(11, 12)] = Terrain.Swamp;
    expect(findPath(map, 2, 10, 17, 10)).toBeNull();
  });

  it('never cuts land off: all land that swamps alone would separate stays reachable', () => {
    for (const size of [64, 96, 128, 192]) {
      for (const seed of [42, 7, 123, 5, 8, 13]) {
        const players = size >= 128 ? 4 : 2;
        const w = new World(seed, { size, players });
        const m = w.map;
        /** Tiles reachable from the first castle by terrain alone (trees and boulders can be cleared). */
        const reach = (throughSwamp: boolean) => {
          const out = new Uint8Array(m.w * m.h);
          const start = m.idx(w.castleOf(1).door.x, w.castleOf(1).door.y);
          const queue = [start];
          out[start] = 1;
          for (let q = 0; q < queue.length; q++) {
            const i = queue[q];
            const x = i % m.w;
            const y = (i - x) / m.w;
            for (const [dx, dy] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
            ]) {
              const nx = x + dx;
              const ny = y + dy;
              if (!m.inBounds(nx, ny)) continue;
              const j = m.idx(nx, ny);
              const ok = m.isPassableTerrain(nx, ny) || (throughSwamp && m.terrain[j] === Terrain.Swamp);
              if (!ok || out[j]) continue;
              out[j] = 1;
              queue.push(j);
            }
          }
          return out;
        };
        const dry = reach(false);
        const wet = reach(true);
        for (const p of w.players) {
          const d = w.castleOf(p.id).door;
          expect(dry[m.idx(d.x, d.y)], `size ${size} seed ${seed} player ${p.id}`).toBe(1);
        }
        let cut = 0;
        for (let i = 0; i < dry.length; i++) {
          if (wet[i] && !dry[i] && m.terrain[i] !== Terrain.Swamp) cut++;
        }
        expect(cut, `size ${size} seed ${seed}`).toBe(0);
      }
    }
  });
});
