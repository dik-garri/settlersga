/**
 * Stopping a building or a site, as in Settlers 4 (docs/S4-AUDIT.md, item 8; `stop.ts`).
 */
import { describe, expect, it } from 'vitest';
import { addBuilding } from '../src/sim/buildings';
import { costOf } from '../src/sim/config';
import { demand } from '../src/sim/logistics';
import { saveWorld } from '../src/sim/save';
import { offered } from '../src/sim/stop';
import { RESOURCES } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, clearGround, depot, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

function richWorld(seed = 42): World {
  const w = new World(seed);
  startTower(w).output.plank = 80;
  startTower(w).output.stone = 40;
  return w;
}

/** No counter below zero, and nothing promised that is not there. */
function consistent(w: World): void {
  for (const b of w.buildings.values()) {
    for (const r of RESOURCES) {
      expect(b.inbound[r]).toBeGreaterThanOrEqual(0);
      expect(b.input[r]).toBeGreaterThanOrEqual(0);
      expect(b.outReserved[r]).toBeGreaterThanOrEqual(0);
    }
  }
}

describe('a stopped workshop', () => {
  it('finishes its cycle, makes nothing more, asks for nothing and gives its input away; restarted it works on', () => {
    const w = richWorld();
    const c = base(w);
    const store = depot(w, 1, undefined, ['log']);
    const mill = placeNear(w, 'sawmill', c.x + 5, c.y - 1)!;
    placeNear(w, 'woodcutter', c.x + 7, c.y - 4);
    placeNear(w, 'woodcutter', c.x + 9, c.y + 2);
    let i = 0;
    while ((!mill.done || mill.input.log < 2) && i++ < 20000) w.step();
    expect(mill.input.log).toBeGreaterThanOrEqual(2);

    expect(w.setStopped(mill.id, true)).toBe(true);
    expect(mill.stopped).toBe(true);
    // Nobody brings it logs any more: carriers on their way dropped the job.
    expect(demand(w, mill, 'log')).toBe(0);
    expect(mill.inbound.log).toBe(0);
    expect(w.settlers.some((s) => s.tasks.some((t) => t.t === 'drop' && t.b === mill.id))).toBe(false);
    run(w, 400); // the cycle under way ends
    const made = mill.output.plank + w.stats.produced.plank;
    expect(mill.timer).toBe(0);
    const storedBefore = store.output.log + store.inbound.log;
    run(w, 3000);
    // No new cycle: not a plank more; its logs went to the warehouse that takes them.
    expect(mill.output.plank + w.stats.produced.plank).toBe(made);
    expect(mill.input.log).toBe(0);
    expect(store.output.log + store.inbound.log).toBeGreaterThan(storedBefore);
    consistent(w);

    expect(w.setStopped(mill.id, false)).toBe(true);
    expect(mill.stopped).toBeUndefined();
    store.accept = undefined; // logs go to the sawmill again
    run(w, 4000);
    expect(w.stats.produced.plank).toBeGreaterThan(made);
    consistent(w);
  });
});

describe('a stopped gatherer', () => {
  it('keeps its worker in and gathers nothing until restarted', () => {
    const w = richWorld();
    const c = base(w);
    const hut = placeNear(w, 'woodcutter', c.x + 7, c.y - 4)!;
    let i = 0;
    while (hut.workerId === null && i++ < 20000) w.step();
    const worker = w.getSettler(hut.workerId)!;
    w.setStopped(hut.id, true);
    // Back from the trip he was on, if any, then he stays in.
    run(w, 1500);
    const logs = w.stats.produced.log;
    run(w, 3000);
    expect(w.stats.produced.log).toBe(logs);
    expect(worker.inside).toBe(hut.id);
    w.setStopped(hut.id, false);
    run(w, 3000);
    expect(w.stats.produced.log).toBeGreaterThan(logs);
  });
});

describe('a stopped site', () => {
  it('sends its builders and diggers away, asks for nothing and gives what lies at it to another site', () => {
    const w = new World(42);
    clearGround(w);
    const t = startTower(w);
    t.output.plank = costOf('house_medium').plank;
    t.output.stone = costOf('house_medium').stone;
    const c = base(w);
    const a = placeNear(w, 'house_medium', c.x + 6, c.y + 2)!;
    let i = 0;
    while ((a.builderIds.length === 0 || a.delivered.plank < 2) && i++ < 20000) w.step();
    expect(a.builderIds.length).toBeGreaterThan(0);

    expect(w.setStopped(a.id, true)).toBe(true);
    expect(a.builderIds).toHaveLength(0);
    expect(a.diggerIds).toHaveLength(0);
    expect(w.settlers.some((s) => s.tasks.some((k) => 'b' in k && k.b === a.id && (k.t === 'build' || k.t === 'drop')))).toBe(false);
    const progress = a.progress;
    // A second site of the same type gets its materials: those still at the tower and those at the
    // stopped site, not yet built in.
    const b = placeNear(w, 'house_medium', c.x - 6, c.y + 2)!;
    run(w, 9000);
    expect(a.progress).toBe(progress);
    expect(demand(w, a, 'plank')).toBe(0);
    expect(b.done).toBe(true);
    expect(offered(a, 'plank')).toBe(0);
    consistent(w);

    // Restarted, it asks again for what it gave away.
    w.setStopped(a.id, false);
    t.output.plank += 10;
    t.output.stone += 10;
    run(w, 9000);
    expect(a.done).toBe(true);
  });
});

describe('stop command', () => {
  it('takes workplaces, sites, warehouses and markets, not houses or military buildings, and only the owners', () => {
    const w = new World(42, { players: 2 });
    const c = base(w);
    const site = placeNear(w, 'woodcutter', c.x + 6, c.y + 2)!;
    expect(w.setStopped(site.id, true, 2)).toBe(false);
    expect(w.setStopped(site.id, true)).toBe(true);
    const house = placeNear(w, 'house_small', c.x - 6, c.y + 2)!;
    house.done = true;
    expect(w.setStopped(house.id, true)).toBe(false);
    expect(w.setStopped(startTower(w).id, true)).toBe(false);
    const store = depot(w);
    expect(w.setStopped(store.id, true)).toBe(true);
  });

  it('a stopped warehouse takes nothing in but still gives out its stock', () => {
    const w = new World(42);
    clearGround(w);
    const c = base(w);
    const store = depot(w);
    store.output.plank = 30;
    store.output.stone = 30;
    store.output.axe = 2;
    w.setStopped(store.id, true);
    const hut = placeNear(w, 'woodcutter', c.x + 7, c.y - 4)!;
    run(w, 8000);
    expect(hut.done).toBe(true);
    expect(hut.output.log + w.stats.produced.log).toBeGreaterThan(0);
    expect(store.output.log).toBe(0);
    expect(store.inbound.log).toBe(0);
    // Its planks still served the site.
    expect(store.output.plank).toBeLessThan(30);
  });

  it('is saved', () => {
    const w = new World(42);
    const b = addBuilding(w, 'sawmill', base(w).x + 6, base(w).y + 6, 1, true);
    w.setStopped(b.id, true);
    const back = World.load(saveWorld(w));
    expect(back.buildings.get(b.id)!.stopped).toBe(true);
  });
});
