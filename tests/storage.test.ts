import { describe, expect, it } from 'vitest';
import { addBuilding, nearestStorage, spawnSettler } from '../src/sim/buildings';
import { AI_LEVELS, BUILDINGS, GROUND, OUTPUT_CAP, START_CONDITIONS, startGoods, STORE_PILE } from '../src/sim/config';
import { workerOrder, workersOf } from '../src/sim/economy';
import { saveWorld } from '../src/sim/save';
import { abort } from '../src/sim/settlers';
import { prospectTiles } from '../src/sim/specialists';
import { pilesUsed, storageRoom } from '../src/sim/storage';
import { RESOURCES, type Building, type Resource } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, depot, goodsInWorld, groundUnits } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const lost = (w: World) => RESOURCES.reduce((n, r) => n + w.stats.lost[r], 0);

/** A finished warehouse of player 1 placed outright near (x, y), taking `goods` in (a new one takes nothing). */
function warehouseNear(w: World, x: number, y: number, goods: readonly Resource[] = RESOURCES): Building {
  for (let r = 3; r < 14; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (!w.canPlace('warehouse', x + dx, y + dy, 1)) continue;
        const b = addBuilding(w, 'warehouse', x + dx, y + dy, 1, true);
        for (const res of goods) w.setAccepts(b.id, res, true);
        return b;
      }
    }
  }
  throw new Error('no room for a warehouse');
}

/** Fills every free pile of the warehouse with iron ore (full piles), so no new good finds room. */
function fillUp(b: Building): void {
  const def = BUILDINGS[b.type].storage!;
  b.output.ironore += Math.ceil(b.output.ironore / STORE_PILE) * STORE_PILE - b.output.ironore;
  b.output.ironore += (def.piles! - pilesUsed(b, def)) * STORE_PILE;
}

/** An owned mountain spot with tiles left to examine, nearest to the start. */
function mountainTile(w: World): { x: number; y: number } {
  const c = base(w);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < w.map.h; y++) {
    for (let x = 0; x < w.map.w; x++) {
      if (prospectTiles(w, x, y, 1).length < 3) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best!;
}

describe('warehouse capacity (Settlers 4: piles of 8)', () => {
  it('a storage area holds 8 piles of 8; a good may fill several, a ninth kind finds no room', () => {
    const w = new World(42);
    const store = warehouseNear(w, base(w).x + 8, base(w).y);
    expect(BUILDINGS.warehouse.storage).toEqual({ piles: 8, perPile: 8 });
    expect(storageRoom(store, 'coal')).toBe(64);
    store.output.coal = 10; // two piles, the second with room for 6
    expect(storageRoom(store, 'coal')).toBe(6 * 8 + 6);
    expect(storageRoom(store, 'iron')).toBe(6 * 8);
    // Goods on their way count too.
    store.inbound.coal = 6;
    expect(storageRoom(store, 'iron')).toBe(6 * 8);
    expect(storageRoom(store, 'coal')).toBe(6 * 8);
    store.inbound.coal = 0;
    store.output.coal = 0;
    for (const r of ['plank', 'stone', 'log', 'coal', 'iron', 'gold', 'fish', 'bread'] as const) store.output[r] = 1;
    expect(storageRoom(store, 'meat')).toBe(0);
    expect(storageRoom(store, 'coal')).toBe(7);
  });

  it('every start level\'s goods lie on the ground in piles of at most 8, the hard computer player\'s bonus included', () => {
    for (const start of ['low', 'medium', 'high'] as const) {
      const w = new World(42, { start, players: 2, ai: [2], difficulty: ['medium', 'hard'] });
      const goods = startGoods(START_CONDITIONS[start]);
      for (const i of w.stacks) expect(w.map.goodsAmount[i]).toBeLessThanOrEqual(GROUND.perStack);
      for (const r of RESOURCES) {
        expect(groundUnits(w, r, 1), `${start} ${r}`).toBe(goods[r] ?? 0);
        expect(groundUnits(w, r, 2), `${start} ${r}`).toBe((goods[r] ?? 0) + (AI_LEVELS.hard.bonus[r] ?? 0));
      }
      // No warehouse at the start, and nothing was lost for want of room.
      expect([...w.buildings.values()].some((b) => BUILDINGS[b.type].storage)).toBe(false);
      expect(lost(w)).toBe(0);
    }
  });

  it('a new warehouse takes nothing in until goods are ticked (Settlers 4)', () => {
    const w = new World(42);
    const store = warehouseNear(w, base(w).x + 8, base(w).y, []);
    run(w, 1500);
    expect(RESOURCES.every((r) => store.output[r] + store.inbound[r] === 0)).toBe(true);
    // Ticked: the planks on the ground are carried in; other goods stay where they lie.
    const stoneBefore = groundUnits(w, 'stone', 1);
    w.setAccepts(store.id, 'plank', true);
    run(w, 3000);
    expect(store.output.plank).toBeGreaterThan(0);
    expect(store.output.stone).toBe(0);
    expect(groundUnits(w, 'stone', 1)).toBe(stoneBefore);
  });

  it('inbound goods count against the room, so carriers spread over warehouses', () => {
    const w = new World(42);
    const other = depot(w);
    const store = warehouseNear(w, base(w).x + 8, base(w).y);
    fillUp(store);
    store.output.ironore -= STORE_PILE; // one pile free
    const sent: Building[] = [];
    for (let k = 0; k < 12; k++) {
      const to = nearestStorage(w, 1, store.door, 'log')!;
      to.inbound.log++;
      sent.push(to);
    }
    expect(sent.slice(0, STORE_PILE).every((b) => b === store)).toBe(true);
    expect(sent.slice(STORE_PILE).every((b) => b === other)).toBe(true);
  });

  it('with every warehouse full, surplus waits at the producer (which then pauses) and nothing is lost', () => {
    const w = new World(42);
    // The only warehouse takes logs but is full (of ore).
    const c = depot(w, 1, undefined, ['log']);
    fillUp(c);
    const hut = placeNear(w, 'woodcutter', base(w).x + 8, base(w).y - 6)!;
    run(w, 9000);
    expect(hut.done).toBe(true);
    // Its pile is full and stays there: no warehouse has room for logs.
    expect(hut.output.log).toBe(OUTPUT_CAP);
    expect(c.output.log + c.inbound.log).toBe(0);
    const made = w.stats.produced.log;
    run(w, 3000);
    expect(w.stats.produced.log).toBe(made);
    // A new warehouse makes room: the logs move there and the woodcutter works again.
    const store = warehouseNear(w, hut.door.x, hut.door.y, ['log']);
    run(w, 3000);
    expect(store.output.log).toBeGreaterThan(0);
    expect(w.stats.produced.log).toBeGreaterThan(made);
    expect(lost(w)).toBe(0);
  });

  it('a good in a carrier\'s hands is put down on the ground when his job is cancelled', () => {
    const w = new World(42);
    fillUp(depot(w));
    const s = spawnSettler(w, 'carrier', depot(w));
    s.inside = null;
    s.carrying = 'log';
    abort(w, s);
    expect(s.carrying).toBeNull();
    expect(s.tasks.length).toBe(0);
    expect(groundUnits(w, 'log')).toBe(1);
    // Nobody wants a log and the full warehouse has no room: it stays on the ground.
    run(w, 100);
    expect(goodsInWorld(w, 'log')).toBe(1);
    expect(lost(w)).toBe(0);
  });

  it('a capped world saves and loads bit for bit', () => {
    const a = new World(42);
    fillUp(depot(a));
    placeNear(a, 'woodcutter', base(a).x + 8, base(a).y - 6);
    run(a, 3000);
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    run(a, 2000);
    run(b, 2000);
    expect(saveWorld(b)).toEqual(saveWorld(a));
  });
});

describe('geologists are ordered (Settlers 4 settlers menu)', () => {
  it('a carrier takes up a hammer (used up), waits, goes when sent and waits again; dismissed, he puts it down', () => {
    const w = new World(42);
    const hammers = goodsInWorld(w, 'hammer');
    expect(w.orderSpecialist('geologist', 1)).toBe(true);
    for (let i = 0; i < 1500 && !w.settlers.some((s) => s.kind === 'geologist'); i++) w.step();
    const geo = w.settlers.find((s) => s.kind === 'geologist')!;
    expect(geo).toBeDefined();
    expect(workersOf(w, 1, 'geologist')).toBe(1);
    run(w, 300);
    expect(goodsInWorld(w, 'hammer')).toBe(hammers - 1);
    expect(geo.carrying).toBeNull();
    // Sent: the waiting geologist goes, no new one is made.
    const m = mountainTile(w);
    expect(w.sendGeologist(m.x, m.y)).toBe(true);
    expect(geo.errand).toMatchObject({ x: m.x, y: m.y });
    expect(w.settlers.some((s) => s.tasks.some((t) => t.t === 'retool'))).toBe(false);
    run(w, 2500);
    expect(w.stats.prospected).toBeGreaterThan(2);
    // Errand done: still a geologist, waiting with the idle crowd, hammer not given back.
    expect(geo.kind).toBe('geologist');
    expect(geo.tasks.length).toBe(0);
    expect(goodsInWorld(w, 'hammer')).toBe(hammers - 1);
    // Dismissed: a carrier again, the hammer falls on the ground by him (S4) and the order drops.
    expect(w.dismissSpecialist('geologist')).toBe(true);
    expect(geo.kind).toBe('carrier');
    expect(workerOrder(w, 1, 'geologist')).toBe(0);
    run(w, 600);
    expect(goodsInWorld(w, 'hammer')).toBe(hammers);
    expect(lost(w)).toBe(0);
  });

  it('busy ordered geologists: sending makes another on the spot, who turns back into a carrier after', () => {
    const w = new World(42);
    const hammers = goodsInWorld(w, 'hammer');
    w.orderSpecialist('geologist', 1);
    for (let i = 0; i < 1500 && !w.settlers.some((s) => s.kind === 'geologist'); i++) w.step();
    run(w, 300);
    const m = mountainTile(w);
    expect(w.sendGeologist(m.x, m.y)).toBe(true); // the ordered one
    expect(w.sendGeologist(m.x, m.y)).toBe(true); // a second, made on the spot
    expect(workersOf(w, 1, 'geologist')).toBe(2);
    run(w, 4000);
    // Back to what was ordered: one geologist, one hammer in him, the other back on the ground.
    expect(w.settlers.filter((s) => s.kind === 'geologist').length).toBe(1);
    expect(goodsInWorld(w, 'hammer')).toBe(hammers - 1);
  });
});
