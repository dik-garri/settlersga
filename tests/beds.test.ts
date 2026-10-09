/**
 * Beds and strike, as in Settlers 4 (docs/S4-AUDIT.md, item 14; `beds.ts`).
 */
import { describe, expect, it } from 'vitest';
import { addBuilding, spawnSettler } from '../src/sim/buildings';
import { startBeds } from '../src/sim/beds';
import { BEDS, BUILDINGS, START_CONDITIONS } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const striking = (w: World) => w.settlers.filter((s) => s.owner === 1 && s.strike);

describe('beds (Settlers 4)', () => {
  it('a player starts with 10 × ⌈start carriers / 10⌉ + 10 beds, and nobody strikes', () => {
    expect(startBeds(16)).toBe(30);
    expect(startBeds(32)).toBe(50);
    expect(startBeds(50)).toBe(60);
    for (const start of ['low', 'medium', 'high'] as const) {
      const w = new World(42, { start });
      expect(w.bedsOf().beds).toBe(startBeds(START_CONDITIONS[start].carriers));
      run(w, 3 * BEDS.checkEvery);
      expect(w.bedsOf().striking).toBe(0);
    }
  });

  it('carriers beyond the beds strike and take no job; a new house takes them in', () => {
    const w = new World(42);
    const { beds, carriers } = w.bedsOf();
    const extra = 6;
    for (let i = 0; i < beds - carriers + extra; i++) spawnSettler(w, 'carrier', startTower(w)).inside = null;
    run(w, BEDS.checkEvery + 1);
    expect(w.bedsOf().striking).toBe(extra);
    const strikers = striking(w);
    run(w, 600);
    // The dispatcher passes them over: they never take a job.
    for (const s of strikers) expect(s.tasks.every((t) => t.t === 'goto' || t.t === 'wait')).toBe(true);
    for (const s of strikers) expect(s.kind).toBe('carrier');

    // A small house: 10 beds, but it lets out only 10 − 6 new settlers, so the strike ends at once.
    const c = base(w);
    const house = addBuilding(w, 'house_small', c.x + 6, c.y + 6, 1, false);
    house.levelled = true;
    house.delivered.plank = BUILDINGS.house_small.cost.plank ?? 0;
    house.delivered.stone = BUILDINGS.house_small.cost.stone ?? 0;
    let i = 0;
    while (!house.done && i++ < 20000) w.step();
    expect(house.done).toBe(true);
    expect(w.bedsOf().striking).toBe(0);
    expect(house.spawned).toBe(extra);
    run(w, 3000);
    expect(house.spawned).toBe(10);
    expect(w.bedsOf().striking).toBe(0);
  });

  it('losing a house puts its people on strike', () => {
    const w = new World(42);
    startTower(w).output.plank = 40;
    startTower(w).output.stone = 40;
    const c = base(w);
    const house = placeNear(w, 'house_medium', c.x + 6, c.y + 2)!;
    let i = 0;
    while (house.spawned < 20 && i++ < 30000) w.step();
    expect(house.spawned).toBe(20);
    run(w, BEDS.checkEvery);
    expect(w.bedsOf().striking).toBe(0);
    const before = w.bedsOf();
    w.demolish(house.id);
    run(w, BEDS.checkEvery * 3);
    const after = w.bedsOf();
    expect(after.beds).toBe(before.beds - 20);
    // Only free carriers go on strike, so at most as many as were beyond the beds.
    expect(after.striking).toBeGreaterThan(0);
    expect(after.striking).toBeLessThanOrEqual(Math.max(0, after.carriers - after.beds));
  });

  it('strikes are saved', () => {
    const w = new World(42);
    const { beds, carriers } = w.bedsOf();
    for (let i = 0; i < beds - carriers + 2; i++) spawnSettler(w, 'carrier', startTower(w)).inside = null;
    run(w, BEDS.checkEvery + 1);
    const back = World.load(saveWorld(w));
    expect(back.bedsOf()).toEqual(w.bedsOf());
  });
});
