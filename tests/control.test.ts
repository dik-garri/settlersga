import { describe, expect, it } from 'vitest';
import { saveWorld } from '../src/sim/save';
import { RESOURCES } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function richWorld(seed = 42): World {
  const w = new World(seed);
  w.castle.output.plank = 80;
  w.castle.output.stone = 40;
  return w;
}

describe('warehouses', () => {
  it('collect producers surplus when nearer than the castle', () => {
    const w = richWorld();
    const c = w.castle;
    const store = placeNear(w, 'warehouse', c.x + 8, c.y - 3)!;
    const hut = placeNear(w, 'woodcutter', c.x + 8, c.y - 6)!;
    run(w, 6000);
    expect(store.done && hut.done).toBe(true);
    expect(store.output.log).toBeGreaterThan(0);
  });
});

describe('priority', () => {
  it('a prioritised site gets scarce materials first', () => {
    const w = new World(42);
    const c = w.castle;
    c.output.plank = 4; // enough for two small houses' planks only… and nothing else
    c.output.stone = 1;
    const a = placeNear(w, 'house_small', c.x + 5, c.y - 1)!;
    const b = placeNear(w, 'house_small', c.x - 5, c.y - 1)!;
    w.setPriority(b.id, true);
    run(w, 3000);
    expect(b.done).toBe(true);
    expect(a.done).toBe(false);
  });
});

describe('demolition', () => {
  it('frees the tiles, turns the worker back into a carrier and loses no carried goods', () => {
    const w = richWorld();
    const c = w.castle;
    const mill = placeNear(w, 'sawmill', c.x + 5, c.y - 1)!;
    const hut = placeNear(w, 'woodcutter', c.x + 7, c.y - 4)!;
    run(w, 2500);
    expect(mill.done && hut.done).toBe(true);
    const worker = w.getSettler(mill.workerId)!;
    expect(worker.kind).toBe('sawmiller');

    expect(w.demolish(mill.id)).toBe(true);
    expect(w.buildings.has(mill.id)).toBe(false);
    expect(worker.kind).toBe('carrier');
    expect(worker.home).toBeNull();
    for (let dy = 0; dy < mill.h; dy++) {
      for (let dx = 0; dx < mill.w; dx++) expect(w.map.isWalkable(mill.x + dx, mill.y + dy)).toBe(true);
    }
    expect(w.map.door[w.map.idx(mill.door.x, mill.door.y)]).toBe(0);
    expect(w.settlers.some((s) => s.tasks.some((t) => 'b' in t && t.b === mill.id))).toBe(false);

    run(w, 2000);
    expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
    for (const b of w.buildings.values()) {
      for (const r of RESOURCES) {
        expect(b.inbound[r]).toBeGreaterThanOrEqual(0);
        expect(b.outReserved[r]).toBeLessThanOrEqual(b.output[r]);
      }
    }
    // The spot can be built on again.
    expect(w.canPlace('sawmill', mill.x, mill.y)).toBe(true);
  });

  it('refuses the castle and other players buildings', () => {
    const w = richWorld();
    expect(w.demolish(w.castle.id)).toBe(false);
    const c = w.castle;
    const hut = placeNear(w, 'woodcutter', c.x + 5, c.y - 1)!;
    expect(w.demolish(hut.id, 2)).toBe(false);
    expect(w.demolish(hut.id)).toBe(true);
  });

  it('priority and demolition survive save and load', () => {
    const w = richWorld();
    const c = w.castle;
    const a = placeNear(w, 'house_small', c.x + 5, c.y - 1)!;
    const b = placeNear(w, 'woodcutter', c.x - 5, c.y - 1)!;
    w.setPriority(a.id, true);
    run(w, 300);
    w.demolish(b.id);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1500);
    run(l, 1500);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});
