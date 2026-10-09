import { describe, expect, it } from 'vitest';
import { costOf, GROUND } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { RESOURCES } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, clearGround, depot, groundUnits, startTower } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** Plenty of materials on the start tower's pile (test setup; a plain supply pile, not stored). */
function richWorld(seed = 42): World {
  const w = new World(seed);
  startTower(w).output.plank = 80;
  startTower(w).output.stone = 40;
  return w;
}

describe('warehouses', () => {
  it('take nothing in until the player ticks a good, then collect producers surplus of it', () => {
    const w = richWorld();
    const c = base(w);
    const store = placeNear(w, 'warehouse', c.x + 8, c.y - 3)!;
    const hut = placeNear(w, 'woodcutter', c.x + 8, c.y - 6)!;
    run(w, 6000);
    expect(store.done && hut.done).toBe(true);
    // As in Settlers 4 a new warehouse accepts nothing: the logs wait at the woodcutter's door.
    expect(store.accept).toBeUndefined();
    expect(store.output.log).toBe(0);
    expect(hut.output.log).toBeGreaterThan(0);
    expect(w.setAccepts(store.id, 'log', true)).toBe(true);
    run(w, 1500);
    expect(store.output.log).toBeGreaterThan(0);
  });

  it('turn carriers already on their way back when a warehouse stops taking the good', () => {
    const w = richWorld();
    const o = base(w);
    // Another warehouse taking logs, on the far side of the start.
    const c = depot(w, 1, { x: o.x - 4, y: o.y + 4 }, ['log']);
    const store = placeNear(w, 'warehouse', o.x + 8, o.y - 3)!;
    w.setAccepts(store.id, 'log', true);
    placeNear(w, 'woodcutter', o.x + 8, o.y - 6);
    const enRoute = () =>
      w.settlers.filter((s) => s.tasks.some((t) => t.t === 'drop' && t.b === store.id && t.res === 'log'));
    let i = 0;
    while (enRoute().length === 0 && i++ < 12000) w.step();
    const carriers = enRoute();
    expect(carriers.length).toBeGreaterThan(0);
    const held = store.output.log;
    const otherBefore = c.output.log;
    expect(w.setAccepts(store.id, 'log', false)).toBe(true);
    // Every one of them now heads for the other warehouse, and the reservations moved with them.
    expect(enRoute()).toHaveLength(0);
    expect(store.inbound.log).toBe(0);
    for (const s of carriers) {
      expect(s.tasks.some((t) => t.t === 'drop' && t.b === c.id && t.res === 'log')).toBe(true);
    }
    run(w, 1500);
    expect(store.output.log).toBeLessThanOrEqual(held);
    expect(c.output.log).toBeGreaterThan(otherBefore);
    expect(w.stats.lost.log).toBe(0);
    for (const b of w.buildings.values()) expect(b.inbound.log).toBeGreaterThanOrEqual(0);
  });
});

describe('priority', () => {
  it('a prioritised site gets scarce materials first', () => {
    const w = new World(42);
    const c = startTower(w);
    const o = base(w);
    // Planks for both small houses, stone for one of them only (the start goods taken away).
    clearGround(w);
    c.output.plank = 2 * costOf('house_small').plank;
    c.output.stone = costOf('house_small').stone;
    const a = placeNear(w, 'house_small', o.x + 5, o.y - 1)!;
    const b = placeNear(w, 'house_small', o.x - 5, o.y - 1)!;
    w.setPriority(b.id, true);
    run(w, 3000);
    expect(b.done).toBe(true);
    expect(a.done).toBe(false);
  });
});

describe('demolition', () => {
  it('frees the tiles, leaves the worker jobless in his trade, loses no carried goods and leaves half its materials', () => {
    const w = richWorld();
    const c = base(w);
    const mill = placeNear(w, 'sawmill', c.x + 5, c.y - 1)!;
    const hut = placeNear(w, 'woodcutter', c.x + 7, c.y - 4)!;
    run(w, 2500);
    expect(mill.done && hut.done).toBe(true);
    const worker = w.getSettler(mill.workerId)!;
    expect(worker.kind).toBe('sawmiller');

    const ground = { plank: groundUnits(w, 'plank'), stone: groundUnits(w, 'stone'), log: groundUnits(w, 'log') };
    const atMill = { plank: mill.output.plank, log: mill.input.log };
    expect(w.demolish(mill.id)).toBe(true);
    // Settlers 4: half of its materials (rounded down) and every good lying at it stay on the ground.
    const half = (r: 'plank' | 'stone') => Math.floor(costOf('sawmill')[r] * GROUND.demolishShare);
    expect(groundUnits(w, 'stone') - ground.stone).toBeGreaterThanOrEqual(half('stone'));
    expect(groundUnits(w, 'plank') - ground.plank).toBeGreaterThanOrEqual(half('plank') + atMill.plank);
    expect(groundUnits(w, 'log') - ground.log).toBeGreaterThanOrEqual(atMill.log);
    expect(w.buildings.has(mill.id)).toBe(false);
    // Settlers 4: he keeps his profession (and tool) and waits for the next sawmill.
    expect(worker.kind).toBe('sawmiller');
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
    // The spot can be built on again once the goods lying there are gone.
    clearGround(w);
    expect(w.canPlace('sawmill', mill.x, mill.y)).toBe(true);
  });

  it('refuses other players buildings', () => {
    const w = new World(42, { players: 2 });
    startTower(w).output.plank = 80;
    startTower(w).output.stone = 40;
    expect(w.demolish(startTower(w, 2).id)).toBe(false);
    const c = base(w);
    const hut = placeNear(w, 'woodcutter', c.x + 5, c.y - 1)!;
    expect(w.demolish(hut.id, 2)).toBe(false);
    expect(w.demolish(hut.id)).toBe(true);
  });

  it('priority and demolition survive save and load', () => {
    const w = richWorld();
    const c = base(w);
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
