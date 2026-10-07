import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../src/sim/config';
import { Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** A world whose castle holds enough material to build a whole food economy. */
function richWorld(seed = 42): World {
  const w = new World(seed);
  w.castle.output.plank = 80;
  w.castle.output.stone = 40;
  return w;
}

/** Nearest owned water tile that touches walkable land. */
function ownedShore(w: World) {
  const c = w.castle;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < w.map.h; y++) {
    for (let x = 0; x < w.map.w; x++) {
      const i = w.map.idx(x, y);
      if (w.map.terrain[i] !== Terrain.Water || !w.owns(x, y)) continue;
      const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.map.isWalkable(x + dx, y + dy));
      const d = Math.hypot(x - c.x, y - c.y);
      if (shore && d < bestD) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  return best;
}

/** First standard seed whose starting territory touches water. */
function worldWithShore() {
  for (const seed of [42, 7, 123, 999, 5, 11, 13, 17, 19, 23]) {
    const w = richWorld(seed);
    const shore = ownedShore(w);
    if (shore) return { w, shore };
  }
  throw new Error('no seed with water in the starting territory');
}

describe('residences', () => {
  it('release their capacity of carriers over time, and the castle no longer does', () => {
    const w = richWorld();
    const start = w.settlers.length;
    run(w, 3000);
    expect(w.settlers.length).toBe(start);

    const c = w.castle;
    const house = placeNear(w, 'house_small', c.x + 5, c.y + 4)!;
    run(w, 6000);
    expect(house.done).toBe(true);
    expect(w.settlers.length).toBe(start + BUILDINGS.house_small.residence!.capacity);
    expect(w.settlers.filter((s) => s.kind === 'carrier').length).toBeGreaterThanOrEqual(12);
  });
});

describe('farming', () => {
  it('a farmer sows walkable fields around the farm and harvests the grain', () => {
    const w = richWorld();
    const c = w.castle;
    const farm = placeNear(w, 'farm', c.x + 5, c.y + 4)!;
    expect(farm).not.toBeNull();
    run(w, 8000);
    expect(farm.done).toBe(true);
    expect(w.stats.produced.grain).toBeGreaterThan(3);
    const fields = [...w.map.crop.keys()].filter((i) => w.map.crop[i] > 0);
    expect(fields.length).toBeGreaterThan(0);
    for (const i of fields) {
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      expect(w.map.isWalkable(x, y)).toBe(true);
      expect(w.map.isBuildable(x, y)).toBe(false);
    }
  });
});

describe('food chain', () => {
  it('turns grain and water into bread, and pigs into meat', () => {
    const { w, shore } = worldWithShore();
    const c = w.castle;
    placeNear(w, 'waterworks', shore.x, shore.y, 6);
    placeNear(w, 'house_medium', c.x - 3, c.y - 5);
    placeNear(w, 'farm', c.x + 6, c.y + 4);
    placeNear(w, 'farm', c.x - 6, c.y + 5);
    placeNear(w, 'mill', c.x + 4, c.y - 4);
    placeNear(w, 'bakery', c.x - 5, c.y - 1);
    placeNear(w, 'pigfarm', c.x + 7, c.y - 1);
    placeNear(w, 'slaughterhouse', c.x - 1, c.y + 6);
    run(w, 24000);
    for (const b of w.buildings.values()) expect(b.done, b.type).toBe(true);
    expect(w.stats.produced.flour).toBeGreaterThan(0);
    expect(w.stats.produced.bread).toBeGreaterThan(0);
    expect(w.stats.produced.meat).toBeGreaterThan(0);
    expect(w.stats.lost).toEqual(Object.fromEntries(Object.keys(w.stats.lost).map((k) => [k, 0])));
  });
});

describe('fishing', () => {
  it('a fisher catches fish from the shore of owned water', () => {
    const { w, shore } = worldWithShore();
    const hut = placeNear(w, 'fisher', shore.x, shore.y, 6)!;
    expect(hut).not.toBeNull();
    run(w, 5000);
    expect(w.stats.produced.fish).toBeGreaterThan(3);
  });
});

describe('logistics fairness', () => {
  it('shares a scarce input between consumers instead of filling the oldest first', () => {
    const w = richWorld();
    const c = w.castle;
    const a = placeNear(w, 'sawmill', c.x + 5, c.y - 2)!;
    const b = placeNear(w, 'sawmill', c.x - 5, c.y - 2)!;
    run(w, 1500);
    expect(a.done && b.done).toBe(true);
    c.output.log = 2;
    run(w, 10); // one dispatch round
    // Promised or already delivered to each mill.
    const got = (m: typeof a) => m.input.log + m.inbound.log;
    expect(got(a)).toBe(1);
    expect(got(b)).toBe(1);
  });
});
