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
      return { walk: map.isWalkable(1, 1), build: map.isBuildable(1, 1), plant: map.isPlantable(1, 1) };
    };
    expect(at(Terrain.Grass)).toEqual({ walk: true, build: true, plant: true });
    expect(at(Terrain.Desert)).toEqual({ walk: true, build: true, plant: false });
    expect(at(Terrain.Swamp)).toEqual({ walk: true, build: false, plant: false });
    expect(at(Terrain.Sand)).toEqual({ walk: true, build: false, plant: false });
    expect(at(Terrain.Water)).toEqual({ walk: false, build: false, plant: false });
    expect(map.isBuildable(1, 1, Terrain.Mountain)).toBe(false);
    map.terrain[map.idx(1, 1)] = Terrain.Mountain;
    expect(map.isBuildable(1, 1, 'mountain')).toBe(true);
    expect(map.isBuildable(1, 1)).toBe(false);
    expect(TERRAIN[Terrain.Swamp].speed).toBeLessThan(1);
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

describe('slow terrain', () => {
  it('A* walks round a swamp when a dry way is not much longer, and through it when it must', () => {
    // A two-tile-wide swamp band with a dry gap two rows off the straight line.
    const map = new GameMap(20, 20);
    for (let y = 0; y < 20; y++) {
      if (y === 12) continue;
      map.terrain[map.idx(10, y)] = Terrain.Swamp;
      map.terrain[map.idx(11, y)] = Terrain.Swamp;
    }
    const path = findPath(map, 2, 10, 17, 10)!;
    expect(path.some((p) => map.terrain[map.idx(p.x, p.y)] === Terrain.Swamp)).toBe(false);
    map.terrain[map.idx(10, 12)] = Terrain.Swamp;
    map.terrain[map.idx(11, 12)] = Terrain.Swamp;
    expect(findPath(map, 2, 10, 17, 10)).not.toBeNull();
  });

  it('settlers walk more slowly across swamp', () => {
    const ticksToWalk = (swamp: boolean) => {
      const w = new World(42);
      const s = w.settlers.find((x) => x.kind === 'carrier')!;
      const from = w.castle.door;
      const to = { x: from.x + 6, y: from.y };
      for (let x = from.x + 1; x <= to.x; x++) {
        const i = w.map.idx(x, from.y);
        w.map.terrain[i] = swamp ? Terrain.Swamp : Terrain.Grass;
        w.map.tree[i] = 0;
        w.map.stone[i] = 0;
        // Walls on both sides, so the route has to follow the row.
        for (const dy of [-1, 1]) w.map.terrain[w.map.idx(x, from.y + dy)] = Terrain.Rock;
      }
      s.tasks = [{ t: 'goto', x: to.x, y: to.y }];
      let n = 0;
      while (s.tasks.length > 0 && n < 1000) {
        w.step();
        n++;
      }
      return n;
    };
    const dry = ticksToWalk(false);
    const wet = ticksToWalk(true);
    expect(wet).toBeGreaterThan(dry * 1.8);
  });
});
