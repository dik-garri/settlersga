import { describe, expect, it } from 'vitest';
import { CROP_KINDS, CROP_RIPE, CROP_STUBBLE, GROW_EVERY, GROWTH, OUTPUT_CAP, PROFESSIONS, s4Ticks, TREE_MATURE } from '../src/sim/config';
import { harvest, plant } from '../src/sim/nature';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A free, owned, plantable tile near the start (away from doors). */
function plot(w: World): number {
  const c = base(w);
  const m = w.map;
  for (let r = 4; r < 14; r++) {
    for (let y = c.y - r; y <= c.y + r; y++) {
      for (let x = c.x - r; x <= c.x + r; x++) {
        if (w.map.inBounds(x, y) && m.owner[m.idx(x, y)] === 1 && m.isPlantable(x, y) && !m.hasDoorNear(x, y)) return m.idx(x, y);
      }
    }
  }
  throw new Error('no plot');
}

describe('growth on Settlers 4’s timers (audit item 16)', () => {
  it('converts the S4 stage times: grain 3 × 30 × 31 ticks ≈ 198 s, stubble ≈ 66 s, trees 3 × 40 × 31 ≈ 264 s', () => {
    expect(GROWTH.grain.stageTicks).toBe(Math.round(s4Ticks(930)));
    expect(GROWTH.grain.stageTicks).toBe(660);
    expect(GROWTH.grain.stubbleTicks).toBe(660);
    expect(GROWTH.tree.stageTicks).toBe(880);
    expect(GROWTH.grain.stageTicks % GROW_EVERY).toBe(0);
    // The farmer sows as long as there is room (`SearchGrainSeedPos`): no cap on his fields.
    expect(PROFESSIONS.farmer.plant!.maxNearby).toBeUndefined();
  });

  it('a field ripens in exactly three stage times, with no randomness, and never rots', () => {
    for (const seed of [42, 7]) {
      const w = new World(seed);
      const i = plot(w);
      // Sown on a timer step, so the stages count from there.
      while (w.tick % GROW_EVERY !== GROW_EVERY - 1) w.step();
      plant(w, 'grain', i);
      const sown = w.tick;
      const stages: number[] = [];
      let last = w.map.crop[i];
      for (let t = 0; t < 3 * GROWTH.grain.stageTicks + 2 * GROW_EVERY; t++) {
        w.step();
        if (w.map.crop[i] !== last) {
          stages.push(w.tick - sown);
          last = w.map.crop[i];
        }
      }
      const g = GROWTH.grain.stageTicks;
      expect(stages.map((s) => Math.abs(s - g * (stages.indexOf(s) + 1)) <= GROW_EVERY)).toEqual([true, true, true]);
      expect(w.map.crop[i]).toBe(CROP_RIPE);
      // Ripe stays ripe.
      run(w, 5 * g);
      expect(w.map.crop[i]).toBe(CROP_RIPE);
      expect(w.growing.has(i)).toBe(false);
    }
  });

  it('a reaped field is stubble for ≈ 66 s: nothing can be sown there, then the tile is free', () => {
    const w = new World(42);
    const i = plot(w);
    const x = i % w.map.w;
    const y = Math.floor(i / w.map.w);
    plant(w, 'grain', i);
    w.map.crop[i] = CROP_RIPE;
    w.growing.delete(i);
    harvest(w, 'grain', i);
    expect(w.map.crop[i]).toBe(CROP_STUBBLE);
    expect(w.map.cropKind[i]).toBe(CROP_KINDS.indexOf('grain'));
    expect(w.map.isPlantable(x, y)).toBe(false);
    expect(w.map.isWalkable(x, y)).toBe(true);
    run(w, GROWTH.grain.stubbleTicks! - GROW_EVERY);
    expect(w.map.crop[i]).toBe(CROP_STUBBLE);
    run(w, 2 * GROW_EVERY);
    expect(w.map.crop[i]).toBe(0);
    expect(w.map.isPlantable(x, y)).toBe(true);
  });

  it('a sapling becomes a mature tree in three stage times of 880 ticks', () => {
    const w = new World(42);
    const i = plot(w);
    while (w.tick % GROW_EVERY !== GROW_EVERY - 1) w.step();
    plant(w, 'tree', i);
    run(w, 3 * GROWTH.tree.stageTicks - 2 * GROW_EVERY);
    expect(w.map.tree[i]).toBe(TREE_MATURE - 1);
    run(w, 3 * GROW_EVERY);
    expect(w.map.tree[i]).toBe(TREE_MATURE);
  });

  it('growth timers survive save and load bit for bit', () => {
    const w = new World(42);
    plant(w, 'grain', plot(w));
    run(w, 777);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1500);
    run(l, 1500);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });

  it('the farmer reaps while his pile has room, else sows; his fields are not capped', () => {
    const w = new World(42);
    const c = base(w);
    const farm = placeNear(w, 'farm', c.x + 5, c.y + 4)!;
    startTower(w).output.plank = 40;
    startTower(w).output.stone = 20;
    run(w, 6000);
    expect(farm.done).toBe(true);
    // A full pile: he only sows now, up to every free spot round the farm.
    farm.output.grain = OUTPUT_CAP;
    const fields = () => w.map.crop.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    run(w, 6000);
    const before = fields();
    run(w, 6000);
    expect(fields()).toBeGreaterThanOrEqual(before);
    expect(fields()).toBeGreaterThan(10);
    expect(farm.output.grain).toBe(OUTPUT_CAP);
  });
});
