import { describe, expect, it } from 'vitest';
import { BUILDINGS, START_PLANKS } from '../src/sim/config';
import type { BuildingType } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Finds the free spot closest to `near` where the building can be placed. */
function findSpot(world: World, type: BuildingType, near: { x: number; y: number }) {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < world.map.h; y++) {
    for (let x = 0; x < world.map.w; x++) {
      if (!world.canPlace(type, x, y)) continue;
      const d = Math.hypot(x - near.x, y - near.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  if (!best) throw new Error(`no spot for ${type}`);
  return best;
}

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

describe('World', () => {
  it('starts with a finished castle, settlers and planks', () => {
    const world = new World(42);
    expect(world.castle.done).toBe(true);
    expect(world.castle.output.plank).toBe(START_PLANKS);
    expect(world.settlers.length).toBeGreaterThan(0);
  });

  it('rejects overlapping and water placements', () => {
    const world = new World(42);
    const { x, y } = world.castle;
    expect(world.canPlace('woodcutter', x, y)).toBe(false);
    expect(world.placeBuilding('castle', x + 5, y + 5)).toBeNull();
    const water = [...world.map.terrain.keys()].find((i) => world.map.terrain[i] === 0)!;
    expect(world.canPlace('woodcutter', water % world.map.w, Math.floor(water / world.map.w))).toBe(false);
  });

  it('builds a site, staffs it and produces logs and planks', () => {
    const world = new World(42);
    // The guaranteed grove is to the east of the castle.
    const wc = findSpot(world, 'woodcutter', { x: world.castle.x + 6, y: world.castle.y });
    const woodcutter = world.placeBuilding('woodcutter', wc.x, wc.y)!;
    expect(woodcutter).not.toBeNull();
    const sm = findSpot(world, 'sawmill', { x: world.castle.x + 1, y: world.castle.y + 6 });
    const sawmill = world.placeBuilding('sawmill', sm.x, sm.y)!;
    expect(sawmill).not.toBeNull();

    run(world, 6000);

    expect(woodcutter.done).toBe(true);
    expect(sawmill.done).toBe(true);
    expect(woodcutter.workerId).not.toBeNull();
    expect(sawmill.workerId).not.toBeNull();
    expect(world.stats.produced.log).toBeGreaterThan(5);
    expect(world.stats.produced.plank).toBeGreaterThan(3);

    const spent = BUILDINGS.woodcutter.cost + BUILDINGS.sawmill.cost;
    const planksNow =
      [...world.buildings.values()].reduce((sum, b) => sum + b.output.plank, 0) +
      world.settlers.filter((s) => s.carrying === 'plank').length;
    expect(planksNow).toBe(START_PLANKS - spent + world.stats.produced.plank);
  });

  it('never leaves reservations negative', () => {
    const world = new World(7);
    const wc = findSpot(world, 'woodcutter', { x: world.castle.x + 6, y: world.castle.y });
    world.placeBuilding('woodcutter', wc.x, wc.y);
    for (let i = 0; i < 3000; i++) {
      world.step();
      for (const b of world.buildings.values()) {
        for (const v of [...Object.values(b.inbound), ...Object.values(b.outReserved), ...Object.values(b.output)]) {
          expect(v).toBeGreaterThanOrEqual(0);
        }
        expect(b.outReserved.log).toBeLessThanOrEqual(b.output.log);
        expect(b.outReserved.plank).toBeLessThanOrEqual(b.output.plank);
      }
    }
  });
});
