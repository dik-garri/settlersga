import { describe, expect, it } from 'vitest';
import { BUILDINGS, MINING, oreOf } from '../src/sim/config';
import { available } from '../src/sim/buildings';
import { workersOf } from '../src/sim/economy';
import { saveWorld } from '../src/sim/save';
import { Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { clearGround, depot, startTower } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/**
 * No start goods on the ground (their food would feed the mines): planks, stone and the tools the
 * tests need on the start tower's pile instead, a plain supply pile.
 */
function richWorld(seed = 42): World {
  const w = new World(seed);
  clearGround(w);
  const t = startTower(w);
  t.output.plank = 80;
  t.output.stone = 40;
  t.output.pickaxe = 4;
  t.output.hammer = 4;
  t.output.shovel = 2;
  return w;
}

/** Owned mountain tiles carrying the given ore. */
function ownedOre(w: World, res: 'coal' | 'ironore') {
  const tiles: { x: number; y: number }[] = [];
  for (let i = 0; i < w.map.ore.length; i++) {
    const x = i % w.map.w;
    const y = Math.floor(i / w.map.w);
    if (w.owns(x, y) && w.map.oreAmount[i] > 0 && oreOf(w.map.ore[i]) === res) tiles.push({ x, y });
  }
  return tiles;
}

function oreLeft(w: World, res: 'coal' | 'ironore') {
  let n = 0;
  for (let i = 0; i < w.map.ore.length; i++) if (oreOf(w.map.ore[i]) === res) n += w.map.oreAmount[i];
  return n;
}

describe('mountains', () => {
  it('are walkable, take mines but no ordinary buildings', () => {
    const w = richWorld();
    const coal = ownedOre(w, 'coal');
    expect(coal.length).toBeGreaterThan(0); // the starting territory always has a mountain
    const { x, y } = coal[0];
    expect(w.map.terrain[w.map.idx(x, y)]).toBe(Terrain.Mountain);
    expect(w.map.isWalkable(x, y)).toBe(true);
    // No ordinary building may cover the mountain tile (2×2 footprints anchored so they include it).
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) expect(w.canPlace('woodcutter', x - dx, y - dy)).toBe(false);
    }
    expect(placeNear(w, 'coalmine', x, y, 4)).not.toBeNull();
  });
});

describe('mines', () => {
  it('turn food into digging attempts, the favourite food giving the most, and idle without food', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const mine = placeNear(w, 'coalmine', spot.x, spot.y, 4)!;
    run(w, 3000);
    expect(mine.done).toBe(true);
    expect(w.stats.produced.coal).toBe(0); // no food yet
    // A warehouse takes the coal away: a full pile of 8 at the door would pause the mine.
    depot(w, 1, undefined, ['coal']);
    expect(BUILDINGS.coalmine.mine!.favourite).toBe('bread');

    // One bread (coal's favourite) buys MINING.attempts.favourite attempts.
    const before = oreLeft(w, 'coal');
    startTower(w).output.bread = 1;
    run(w, 3000);
    expect(startTower(w).output.bread).toBe(0);
    expect(mine.attempts ?? 0).toBe(0);
    const fromBread = w.stats.produced.coal;
    expect(fromBread).toBeGreaterThan(0);
    expect(fromBread).toBeLessThanOrEqual(MINING.attempts.favourite);
    expect(oreLeft(w, 'coal')).toBe(before - fromBread);

    // One fish (not its favourite) buys only MINING.attempts.other.
    startTower(w).output.fish = 1;
    run(w, 3000);
    expect(startTower(w).output.fish).toBe(0);
    const fromFish = w.stats.produced.coal - fromBread;
    expect(fromFish).toBeGreaterThan(0);
    expect(fromFish).toBeLessThanOrEqual(MINING.attempts.other);
  });

  it('rich tiles always yield, poor ones by chance', () => {
    // A rich deposit gives exactly one unit per attempt.
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const mine = placeNear(w, 'coalmine', spot.x, spot.y, 4)!;
    run(w, 3000);
    expect(mine.done).toBe(true);
    depot(w, 1, undefined, ['coal']);
    for (let i = 0; i < w.map.oreAmount.length; i++) if (oreOf(w.map.ore[i]) === 'coal') w.map.oreAmount[i] = MINING.sureAmount + 20;
    startTower(w).output.bread = 1;
    run(w, 3000);
    expect(w.stats.produced.coal).toBe(MINING.attempts.favourite);

    // A poor one (a single unit per tile) yields far less per attempt.
    const v = richWorld();
    const [spot2] = ownedOre(v, 'coal');
    const mine2 = placeNear(v, 'coalmine', spot2.x, spot2.y, 4)!;
    run(v, 3000);
    expect(mine2.done).toBe(true);
    depot(v, 1, undefined, ['coal']);
    for (let i = 0; i < v.map.oreAmount.length; i++) if (oreOf(v.map.ore[i]) === 'coal') v.map.oreAmount[i] = 1;
    startTower(v).output.bread = 4;
    run(v, 9000);
    expect(startTower(v).output.bread).toBe(0);
    expect(v.stats.produced.coal).toBeGreaterThan(0);
    expect(v.stats.produced.coal).toBeLessThan(4 * MINING.attempts.favourite * 0.6);
  });

  it('stop when the ore within reach runs out', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'ironore');
    const mine = placeNear(w, 'ironmine', spot.x, spot.y, 4)!;
    const r = BUILDINGS.ironmine.mine!.radius;
    const cx = mine.x + (mine.w - 1) / 2;
    const cy = mine.y + (mine.h - 1) / 2;
    let reachable = 0;
    for (let i = 0; i < w.map.ore.length; i++) {
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      if (oreOf(w.map.ore[i]) === 'ironore' && Math.hypot(x - cx, y - cy) <= r) reachable += w.map.oreAmount[i];
    }
    // The whole deposit has to go somewhere: a warehouse taking the ore, its limit (`storage.ts`) lifted
    // — that is not what this tests.
    const limit = BUILDINGS.warehouse.storage;
    BUILDINGS.warehouse.storage = {};
    try {
      depot(w, 1, undefined, ['ironore']);
      startTower(w).output.meat = reachable + 20;
      run(w, 1500 + reachable * 400);
      expect(w.stats.produced.ironore).toBe(reachable);
    } finally {
      BUILDINGS.warehouse.storage = limit;
    }
  });
});

describe('geologist', () => {
  it('prospects owned mountain tiles around the target and goes back to carrying', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const carriersBefore = w.settlers.filter((s) => s.kind === 'carrier').length;
    const hammers = available(w, 1, 'hammer');
    expect(w.sendGeologist(spot.x, spot.y)).toBe(true);
    // None ordered: a carrier takes up a hammer on the spot (counted as a geologist on his way).
    expect(workersOf(w, 1, 'geologist')).toBe(1);
    run(w, 1500);
    expect(w.isProspected(spot.x, spot.y)).toBe(true);
    expect(w.stats.prospected).toBeGreaterThan(3);
    expect(w.settlers.filter((s) => s.kind === 'carrier').length).toBe(carriersBefore);
    // Not ordered, so he went back to carrying and put the hammer down (S4: it falls by him).
    run(w, 600);
    expect(available(w, 1, 'hammer')).toBe(hammers);
    // Not on grass.
    const c = startTower(w);
    expect(w.sendGeologist(c.door.x, c.door.y + 1)).toBe(false);
  });

  it('skips tiles that became unreachable instead of giving up', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    expect(w.sendGeologist(spot.x, spot.y)).toBe(true);
    // A mine now covers the first tiles he wanted to visit.
    placeNear(w, 'coalmine', spot.x, spot.y, 4);
    run(w, 1500);
    expect(w.stats.prospected).toBeGreaterThan(2);
  });

  it('survives save and load mid-way', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    w.sendGeologist(spot.x, spot.y);
    run(w, 200);
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1000);
    run(b, 1000);
    expect(saveWorld(b)).toEqual(saveWorld(w));
  });
});
