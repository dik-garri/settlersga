import { describe, expect, it } from 'vitest';
import { addBuilding, populationOf, spawnSettler } from '../src/sim/buildings';
import { INPUT_CAP, POPULATION, populationCap, PRODUCER_DISTANCE_FACTOR, SURPLUS_KEEP } from '../src/sim/config';
import { dropGoods } from '../src/sim/ground';
import { workersOf } from '../src/sim/economy';
import { landAt } from '../src/sim/land';
import type { Building, BuildingType, Point } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, clearGround, groundUnits, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A finished building of `type` on the free spot nearest `at`. */
function finished(w: World, type: BuildingType, at: Point): Building {
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = at.y - 10; y <= at.y + 10; y++) {
    for (let x = at.x - 10; x <= at.x + 10; x++) {
      const d = Math.hypot(x - at.x, y - at.y);
      if (d < bestD && w.canPlace(type, x, y)) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  if (!best) throw new Error(`no room for ${type}`);
  return addBuilding(w, type, best.x, best.y, 1, true);
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('supply choice (audit item 19)', () => {
  /**
   * A mill wanting two units of grain, a farm with grain on its pile and grain lying on the ground at
   * about `share` of the farm's distance from the mill (the ground counts at full distance).
   */
  function setup(share: number) {
    const w = new World(42);
    clearGround(w);
    const c = base(w);
    const mill = finished(w, 'mill', { x: c.x + 6, y: c.y + 1 });
    const farm = finished(w, 'farm', { x: c.x - 4, y: c.y + 4 });
    mill.input.grain = INPUT_CAP - 2;
    farm.output.grain = 5;
    const df = dist(farm.door, mill.door);
    // The owned free tile whose distance from the mill comes nearest the wanted one.
    const m = w.map;
    let best = -1;
    for (let i = 0; i < m.w * m.h; i++) {
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      if (m.owner[i] !== 1 || !m.isPlantable(x, y) || m.hasDoorNear(x, y)) continue;
      const err = Math.abs(dist({ x, y }, mill.door) - share * df);
      if (best < 0 || err < Math.abs(dist({ x: best % m.w, y: Math.floor(best / m.w) }, mill.door) - share * df)) best = i;
    }
    const at = { x: best % m.w, y: Math.floor(best / m.w) };
    dropGoods(w, at, 'grain', 5);
    return { w, mill, farm, df, ds: dist(at, mill.door), tile: best };
  }

  it('a producer’s pile counts at half its distance: the farm’s grain beats nearer grain on the ground', () => {
    const { w, farm, df, ds, tile } = setup(0.75);
    expect(ds).toBeLessThan(df);
    expect(ds).toBeGreaterThan(df * PRODUCER_DISTANCE_FACTOR);
    run(w, 6);
    expect(farm.outReserved.grain + (5 - farm.output.grain)).toBe(2);
    expect(w.map.goodsReserved[tile]).toBe(0);
  });

  it('grain at less than half the producer’s distance wins', () => {
    const { w, farm, df, ds, tile } = setup(0.3);
    expect(ds).toBeLessThan(df * PRODUCER_DISTANCE_FACTOR);
    run(w, 6);
    expect(farm.outReserved.grain + (5 - farm.output.grain)).toBe(0);
    expect(w.map.goodsReserved[tile] + (5 - w.map.goodsAmount[tile])).toBe(2);
  });

  it('surplus goes to a warehouse only from 2 units: the last one waits at the producer; a stopped one gives all', () => {
    const w = new World(42);
    clearGround(w);
    const c = base(w);
    const store = finished(w, 'warehouse', { x: c.x - 6, y: c.y - 3 });
    w.setAccepts(store.id, 'plank', true);
    const mill = finished(w, 'sawmill', { x: c.x + 6, y: c.y + 1 });
    mill.output.plank = 4;
    run(w, 1500);
    expect(SURPLUS_KEEP).toBe(1);
    expect(mill.output.plank).toBe(SURPLUS_KEEP);
    expect(store.output.plank).toBe(3);
    w.setStopped(mill.id, true);
    run(w, 800);
    expect(mill.output.plank).toBe(0);
    expect(store.output.plank).toBe(4);
  });
});

describe('population cap (audit item 20)', () => {
  it('2500 settlers a player, 10000 shared with more than four players', () => {
    expect(populationCap(1)).toBe(2500);
    expect(populationCap(4)).toBe(2500);
    expect(populationCap(5)).toBe(2000);
    expect(populationCap(8)).toBe(1250);
  });

  it('a house releases nobody while its owner is at the cap, and resumes below it', () => {
    const w = new World(42);
    const c = base(w);
    const house = finished(w, 'house_small', { x: c.x + 5, y: c.y + 4 });
    const old = POPULATION.cap;
    try {
      POPULATION.cap = populationOf(w, 1);
      run(w, 600);
      expect(house.spawned).toBe(0);
      POPULATION.cap = old;
      run(w, 600);
      expect(house.spawned).toBeGreaterThan(0);
    } finally {
      POPULATION.cap = old;
    }
  });

  it('counts every kind of settler, donkeys included', () => {
    const w = new World(42);
    const n = populationOf(w, 1);
    spawnSettler(w, 'donkey', startTower(w));
    w.step();
    expect(populationOf(w, 1)).toBe(n + 1);
  });
});

describe('lowering the worker order dismisses (audit item 22)', () => {
  it('free builders and diggers over the order turn back into carriers, one at a time, tools on the ground', () => {
    const w = new World(42);
    clearGround(w);
    const builders = workersOf(w, 1, 'builder');
    const diggers = workersOf(w, 1, 'digger');
    expect(builders).toBeGreaterThan(2);
    const carriers = w.settlers.filter((s) => s.kind === 'carrier').length;
    w.orderWorkers('builder', builders - 2);
    w.orderWorkers('digger', diggers - 1);
    run(w, 100);
    expect(w.settlers.filter((s) => s.kind === 'builder').length).toBe(builders - 2);
    expect(w.settlers.filter((s) => s.kind === 'digger').length).toBe(diggers - 1);
    expect(w.settlers.filter((s) => s.kind === 'carrier').length).toBe(carriers + 3);
    expect(groundUnits(w, 'hammer')).toBe(2);
    expect(groundUnits(w, 'shovel')).toBe(1);
    // The order stays where the player put it; nobody is recruited back.
    run(w, 600);
    expect(workersOf(w, 1, 'builder')).toBe(builders - 2);
  });
});

describe('donkeys go back where they were hired (audit item 26)', () => {
  /** Two markets on the home land, a route between them, two donkeys waiting at the first. */
  function homeRoute() {
    const w = new World(42);
    const c = base(w);
    const a = finished(w, 'market', { x: c.x + 5, y: c.y - 3 });
    const b = finished(w, 'market', { x: c.x - 9, y: c.y + 8 });
    for (let i = 0; i < 2; i++) spawnSettler(w, 'donkey', a);
    expect(landAt(w, a.door, 1)).toBe(landAt(w, b.door, 1));
    startTower(w).output.plank = 20;
    w.setTradeRoute(a.id, b.id);
    w.orderTrade(a.id, 'plank', 8);
    return { w, a, b };
  }

  it('after unloading on the same piece of land it walks back to its hiring spot, not to the nearest market', () => {
    const { w, a, b } = homeRoute();
    let unloaded = false;
    for (let t = 0; t < 6000 && !unloaded; t++) {
      w.step();
      unloaded = b.output.plank > 0 || b.outReserved.plank > 0;
    }
    expect(unloaded).toBe(true);
    run(w, 1500);
    const donkeys = w.settlers.filter((s) => s.kind === 'donkey');
    // Every donkey waits by the hiring market again, none by the destination.
    for (const d of donkeys) expect(dist(d, a.door)).toBeLessThan(dist(d, b.door));
    for (const d of donkeys) expect(d.hiredAt).toBeUndefined();
  });
});
