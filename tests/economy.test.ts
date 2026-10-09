import { describe, expect, it } from 'vitest';
import { ANIMALS, BUILDINGS, PATHS, residentsOf, START_CONDITIONS, startGoods } from '../src/sim/config';
import { consumersOf, distributableGoods } from '../src/sim/economy';
import { pathLevel, pathSpeed, updatePaths, wearTile } from '../src/sim/paths';
import { saveWorld } from '../src/sim/save';
import { RESOURCES, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, groundUnits, startTower } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** Plenty of planks and stone on the start tower's pile (a plain supply pile, no warehouse). */
function richWorld(seed = 42): World {
  const w = new World(seed);
  startTower(w).output.plank = 80;
  startTower(w).output.stone = 40;
  return w;
}

describe('start conditions (as in Settlers 4)', () => {
  it('low, medium and high give different goods and settlers; medium is the classic start', () => {
    const count = (w: World, kind: string) => w.settlers.filter((s) => s.owner === 1 && s.kind === kind).length;
    for (const level of ['low', 'medium', 'high'] as const) {
      const w = new World(42, { start: level });
      const def = START_CONDITIONS[level];
      const goods = startGoods(def);
      expect(groundUnits(w, 'plank', 1)).toBe(goods.plank);
      expect(groundUnits(w, 'stone', 1)).toBe(goods.stone);
      expect(count(w, 'carrier')).toBe(def.carriers);
      expect(count(w, 'builder')).toBe(def.builders);
      expect(w.players[0].economy!.orders.builder).toBe(def.builders);
    }
    expect(groundUnits(new World(42), 'plank', 1)).toBe(startGoods(START_CONDITIONS.medium).plank);
    expect(groundUnits(new World(42, { start: 'high' }), 'bread', 1)).toBeGreaterThan(0);
  });
});

describe('houses as in Settlers 4', () => {
  it('hold 10/20/50 residents on every map size', () => {
    expect(residentsOf(BUILDINGS.house_small)).toBe(10);
    expect(residentsOf(BUILDINGS.house_medium)).toBe(20);
    expect(residentsOf(BUILDINGS.house_large)).toBe(50);
  });

  it('a small house releases the same number of settlers on 64×64 and 128×128', () => {
    for (const size of [64, 128]) {
      const w = new World(42, { size });
      startTower(w).output.plank = 80;
      startTower(w).output.stone = 40;
      const start = w.settlers.length;
      const house = placeNear(w, 'house_small', base(w).x + 5, base(w).y - 1)!;
      run(w, 6000);
      expect(house.done).toBe(true);
      expect(w.settlers.length).toBe(start + 10);
    }
  });
});

describe('hunter', () => {
  it('shoots game near his lodge and brings the meat home; game comes back', () => {
    const w = richWorld();
    const c = base(w);
    startTower(w).output.bow = 1;
    const lodge = placeNear(w, 'hunter', c.x + 5, c.y + 3)!;
    run(w, 2500);
    expect(lodge.done).toBe(true);
    expect(w.getSettler(lodge.workerId)?.kind).toBe('hunter');
    // A deer grazing just outside the lodge.
    const x = lodge.door.x + 3;
    const y = lodge.door.y + 1;
    const deer = { id: w.nextAnimalId++, kind: 'deer' as const, x, y, px: x, py: y, tx: x, ty: y, rest: 10_000, hx: x, hy: y };
    w.animals.push(deer);
    run(w, 1200);
    expect(w.animals.includes(deer)).toBe(false);
    expect(w.stats.produced.meat).toBeGreaterThanOrEqual(1);
    expect(ANIMALS.deer.game).toBe('meat');
  });

  it('hunted game comes back in the woods (Settlers 4’s animal manager)', () => {
    const w = new World(42);
    const deer = () => w.animals.filter((a) => a.kind === 'deer');
    expect(deer().length).toBeGreaterThan(1);
    // Hunt them all: new deer are born by trees, up to the map's cap.
    for (const a of deer()) w.animals.splice(w.animals.indexOf(a), 1);
    run(w, 600);
    expect(deer().length).toBeGreaterThan(1);
    for (const a of deer()) expect(w.map.tree.some((t, i) => t > 0 && Math.hypot((i % w.map.w) - a.hx, Math.floor(i / w.map.w) - a.hy) < 1.5)).toBe(true);
  });
});

describe('goods distribution (as in Settlers 4)', () => {
  it('derives each good\'s consumers from the recipes', () => {
    expect(consumersOf('grain')).toEqual(expect.arrayContaining(['mill', 'pigfarm']));
    expect(distributableGoods()).toContain('grain');
    expect(distributableGoods()).not.toContain('log'); // only the sawmill takes logs
  });

  it('a consumer type with weight 0 gets none of the good; weights steer the rest', () => {
    const w = richWorld();
    const c = base(w);
    const mill = placeNear(w, 'mill', c.x + 5, c.y - 1)!;
    const pigs = placeNear(w, 'pigfarm', c.x - 5, c.y - 1)!;
    run(w, 3000);
    expect(mill.done && pigs.done).toBe(true);
    expect(w.setDistribution('grain', 'pigfarm', 0)).toBe(true);
    expect(w.setDistribution('grain', 'sawmill', 50)).toBe(false); // not a grain consumer
    startTower(w).output.grain = 6;
    run(w, 1500);
    expect(pigs.input.grain + pigs.inbound.grain).toBe(0);
    expect(w.stats.produced.pig).toBe(0);
    expect(mill.input.grain + mill.inbound.grain + w.stats.produced.flour).toBeGreaterThan(0);
  });
});

describe('warehouse settings', () => {
  it('a warehouse refusing a good is passed over by surplus hauling', () => {
    const w = richWorld();
    const c = base(w);
    const store = placeNear(w, 'warehouse', c.x + 8, c.y - 3)!;
    const hut = placeNear(w, 'woodcutter', c.x + 8, c.y - 6)!;
    // As in Settlers 4 a new warehouse takes nothing in: tick every good but logs.
    expect(store.accept).toBeUndefined();
    for (const r of RESOURCES) if (r !== 'log') expect(w.setAccepts(store.id, r, true)).toBe(true);
    run(w, 1500);
    expect(store.done).toBe(true);
    expect(w.setAccepts(store.id, 'log', false)).toBe(true);
    expect(w.setAccepts(hut.id, 'log', false)).toBe(false); // not a warehouse
    const before = store.output.log + store.inbound.log;
    const produced = w.stats.produced.log;
    run(w, 5000);
    expect(hut.done).toBe(true);
    expect(w.stats.produced.log).toBeGreaterThan(produced);
    expect(store.output.log).toBe(before);
    expect(w.stats.produced.log).toBeGreaterThan(0);
    expect(w.setAccepts(store.id, 'log', true)).toBe(true);
    expect(store.accept).toEqual(RESOURCES);
  });
});

describe('paths', () => {
  it('wear grows with steps into a dusty path, then a road that is walked faster, and fades unused', () => {
    const w = new World(42);
    const m = w.map;
    let i = -1;
    for (let k = 0; k < m.terrain.length && i < 0; k++) if (m.terrain[k] === Terrain.Grass && m.isWalkable(k % m.w, Math.floor(k / m.w))) i = k;
    expect(pathSpeed(m, i)).toBe(1);
    const steps = Math.ceil(PATHS.levels[1].wear / PATHS.perStep);
    for (let k = 0; k < steps; k++) wearTile(w, i);
    expect(pathLevel(m.wear[i])).toBe(2);
    expect(pathSpeed(m, i)).toBe(PATHS.levels[1].speed);
    expect(w.worn.has(i)).toBe(true);
    // Unused, it fades back to grass.
    for (let t = 0; t < 300; t++) {
      w.tick += PATHS.decayEvery;
      updatePaths(w);
    }
    expect(m.wear[i]).toBe(0);
    expect(w.worn.has(i)).toBe(false);
  });

  it('busy routes wear into paths in a real game', () => {
    const w = richWorld();
    const c = base(w);
    placeNear(w, 'woodcutter', c.x + 5, c.y - 1);
    placeNear(w, 'sawmill', c.x - 3, c.y + 5);
    run(w, 9000);
    let paths = 0;
    for (const i of w.worn) if (pathLevel(w.map.wear[i]) >= 1) paths++;
    expect(paths).toBeGreaterThan(0);
  });
});

describe('economy settings survive save and load', () => {
  it('orders, tool queue, distribution, warehouse refusals and paths continue bit for bit', () => {
    const a = richWorld();
    const c = base(a);
    startTower(a).output.bow = 1;
    placeNear(a, 'woodcutter', c.x + 5, c.y - 1);
    placeNear(a, 'hunter', c.x - 5, c.y + 3);
    const store = placeNear(a, 'warehouse', c.x + 8, c.y - 3)!;
    a.orderWorkers('builder', 4);
    a.orderTool('rod', 2);
    a.setDistribution('grain', 'mill', 80);
    for (const r of RESOURCES) a.setAccepts(store.id, r, true);
    run(a, 2000);
    a.setAccepts(store.id, 'stone', false);
    run(a, 1000);
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    expect(saveWorld(b)).toEqual(saveWorld(a));
    run(a, 2000);
    run(b, 2000);
    expect(saveWorld(b)).toEqual(saveWorld(a));
    expect([...b.worn].sort()).toEqual([...a.worn].sort());
  });
});
