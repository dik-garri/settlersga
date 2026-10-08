import { describe, expect, it } from 'vitest';
import { addBuilding, nearestStorage, spawnSettler } from '../src/sim/buildings';
import { AI_LEVELS, BUILDINGS, OUTPUT_CAP, START_CONDITIONS, STORE_PILE } from '../src/sim/config';
import { workerOrder, workersOf } from '../src/sim/economy';
import { saveWorld } from '../src/sim/save';
import { abort } from '../src/sim/settlers';
import { prospectTiles } from '../src/sim/specialists';
import { pilesUsed, storageRoom } from '../src/sim/storage';
import { RESOURCES, type Building } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const lost = (w: World) => RESOURCES.reduce((n, r) => n + w.stats.lost[r], 0);

/** A finished warehouse of player 1 placed outright near (x, y). */
function warehouseNear(w: World, x: number, y: number): Building {
  for (let r = 3; r < 14; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (w.canPlace('warehouse', x + dx, y + dy, 1)) return addBuilding(w, 'warehouse', x + dx, y + dy, 1, true);
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

/** An owned mountain spot with tiles left to examine, nearest to the castle. */
function mountainTile(w: World): { x: number; y: number } {
  const c = w.castle;
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
    const store = warehouseNear(w, w.castle.x + 8, w.castle.y);
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

  it('every start level fits the castle, the hard computer player\'s bonus included', () => {
    const def = BUILDINGS.castle.storage!;
    for (const start of ['low', 'medium', 'high'] as const) {
      const w = new World(42, { start, players: 2, ai: [2], difficulty: ['medium', 'hard'] });
      for (const p of [1, 2]) {
        const c = w.castleOf(p);
        expect(pilesUsed(c, def)).toBeLessThanOrEqual(def.piles!);
      }
      // The bonus really was added (the check above covers the largest stock).
      const bonus = AI_LEVELS.hard.bonus.plank ?? 0;
      expect(w.castleOf(2).output.plank).toBe((START_CONDITIONS[start].goods.plank ?? 0) + bonus);
    }
  });

  it('inbound goods count against the room, so carriers spread over warehouses', () => {
    const w = new World(42);
    const store = warehouseNear(w, w.castle.x + 8, w.castle.y);
    fillUp(store);
    store.output.ironore -= STORE_PILE; // one pile free
    const sent: Building[] = [];
    for (let k = 0; k < 12; k++) {
      const to = nearestStorage(w, 1, store.door, 'log')!;
      to.inbound.log++;
      sent.push(to);
    }
    expect(sent.slice(0, STORE_PILE).every((b) => b === store)).toBe(true);
    expect(sent.slice(STORE_PILE).every((b) => b === w.castle)).toBe(true);
  });

  it('with every warehouse full, surplus waits at the producer (which then pauses) and nothing is lost', () => {
    const w = new World(42);
    w.castle.output.plank = 80;
    w.castle.output.stone = 40;
    fillUp(w.castle);
    const c = w.castle;
    const hut = placeNear(w, 'woodcutter', c.x + 8, c.y - 6)!;
    run(w, 9000);
    expect(hut.done).toBe(true);
    // Its pile is full and stays there: no warehouse has room for logs.
    expect(hut.output.log).toBe(OUTPUT_CAP);
    expect(c.output.log + c.inbound.log).toBe(0);
    const made = w.stats.produced.log;
    run(w, 3000);
    expect(w.stats.produced.log).toBe(made);
    // A new warehouse makes room: the logs move there and the woodcutter works again.
    const store = warehouseNear(w, hut.door.x, hut.door.y);
    run(w, 3000);
    expect(store.output.log).toBeGreaterThan(0);
    expect(w.stats.produced.log).toBeGreaterThan(made);
    expect(lost(w)).toBe(0);
  });

  it('a good in a carrier\'s hands goes back even when every warehouse is full', () => {
    const w = new World(42);
    fillUp(w.castle);
    const s = spawnSettler(w, 'carrier', w.castle);
    s.inside = null;
    s.carrying = 'log';
    abort(w, s);
    expect(s.tasks.at(-1)).toMatchObject({ t: 'drop', b: w.castle.id, res: 'log', back: true });
    run(w, 100);
    expect(w.castle.output.log).toBe(1);
    expect(lost(w)).toBe(0);
  });

  it('a capped world saves and loads bit for bit', () => {
    const a = new World(42);
    fillUp(a.castle);
    placeNear(a, 'woodcutter', a.castle.x + 8, a.castle.y - 6);
    run(a, 3000);
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    run(a, 2000);
    run(b, 2000);
    expect(saveWorld(b)).toEqual(saveWorld(a));
  });
});

describe('geologists are ordered (Settlers 4 settlers menu)', () => {
  it('a carrier takes up a hammer (used up), waits, goes when sent and waits again; dismissed, he brings it back', () => {
    const w = new World(42);
    const hammers = w.castle.output.hammer;
    expect(w.orderSpecialist('geologist', 1)).toBe(true);
    for (let i = 0; i < 1500 && !w.settlers.some((s) => s.kind === 'geologist'); i++) w.step();
    const geo = w.settlers.find((s) => s.kind === 'geologist')!;
    expect(geo).toBeDefined();
    expect(workersOf(w, 1, 'geologist')).toBe(1);
    run(w, 300);
    expect(w.castle.output.hammer).toBe(hammers - 1);
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
    expect(w.castle.output.hammer).toBe(hammers - 1);
    // Dismissed: a carrier again, the hammer goes home and the order drops.
    expect(w.dismissSpecialist('geologist')).toBe(true);
    expect(geo.kind).toBe('carrier');
    expect(workerOrder(w, 1, 'geologist')).toBe(0);
    run(w, 600);
    expect(w.castle.output.hammer).toBe(hammers);
    expect(lost(w)).toBe(0);
  });

  it('busy ordered geologists: sending makes another on the spot, who turns back into a carrier after', () => {
    const w = new World(42);
    const hammers = w.castle.output.hammer;
    w.orderSpecialist('geologist', 1);
    for (let i = 0; i < 1500 && !w.settlers.some((s) => s.kind === 'geologist'); i++) w.step();
    run(w, 300);
    const m = mountainTile(w);
    expect(w.sendGeologist(m.x, m.y)).toBe(true); // the ordered one
    expect(w.sendGeologist(m.x, m.y)).toBe(true); // a second, made on the spot
    expect(workersOf(w, 1, 'geologist')).toBe(2);
    run(w, 4000);
    // Back to what was ordered: one geologist, one hammer in him, the other back in the castle.
    expect(w.settlers.filter((s) => s.kind === 'geologist').length).toBe(1);
    expect(w.castle.output.hammer).toBe(hammers - 1);
  });
});
