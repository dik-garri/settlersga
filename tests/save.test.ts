import { describe, expect, it } from 'vitest';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';

function placeNear(world: World, type: Parameters<World['canPlace']>[0], dx: number, dy: number) {
  const c = world.castle;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < world.map.h; y++) {
    for (let x = 0; x < world.map.w; x++) {
      if (!world.canPlace(type, x, y)) continue;
      const d = Math.hypot(x - c.x - dx, y - c.y - dy);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return world.placeBuilding(type, best!.x, best!.y)!;
}

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

describe('save / load', () => {
  it('a loaded world continues exactly like the original', () => {
    const a = new World(42);
    placeNear(a, 'woodcutter', 5, -1);
    placeNear(a, 'sawmill', 1, 5);
    placeNear(a, 'forester', 5, 3);
    placeNear(a, 'stonecutter', -5, 3);
    run(a, 2500); // mid-way: settlers walking, carrying, building, trees growing

    const b = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    expect(saveWorld(b)).toEqual(saveWorld(a));

    run(a, 3000);
    run(b, 3000);
    expect(saveWorld(b)).toEqual(saveWorld(a));
    expect(b.stats.produced.plank).toBeGreaterThan(0);
  });

  it('rejects saves from an unknown format version', () => {
    const save = saveWorld(new World(1));
    expect(() => World.load({ ...save, version: 999 })).toThrow();
  });

  it('supports other map sizes', () => {
    const big = new World(5, { size: 128 });
    expect(big.map.w).toBe(128);
    const c = big.castle;
    expect(Math.abs(c.x + 1 - 64)).toBeLessThanOrEqual(1);
    run(big, 200);
    const loaded = World.load(saveWorld(big));
    expect(loaded.map.w).toBe(128);
  });
});
