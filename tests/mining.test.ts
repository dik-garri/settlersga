import { describe, expect, it } from 'vitest';
import { BUILDINGS, MINING, ORE_RESOURCES, oreOf } from '../src/sim/config';
import { available } from '../src/sim/buildings';
import { workerOrder, workersOf } from '../src/sim/economy';
import { saveWorld } from '../src/sim/save';
import { Terrain, type Building } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { clearGround, depot, noGeologists, startTower } from './helpers';

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

/** Every map tile within the mine's reach (its footprint centre ± `mine.radius`), ore or not. */
function reachOf(w: World, mine: Building): number[] {
  const r = BUILDINGS[mine.type].mine!.radius;
  const cx = mine.x + (mine.w - 1) / 2;
  const cy = mine.y + (mine.h - 1) / 2;
  const out: number[] = [];
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (w.map.inBounds(x, y) && Math.hypot(x - cx, y - cy) <= r) out.push(w.map.idx(x, y));
    }
  }
  return out;
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
    // A mine whose whole reach is rich coal gives exactly one unit per attempt.
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const mine = placeNear(w, 'coalmine', spot.x, spot.y, 4)!;
    run(w, 3000);
    expect(mine.done).toBe(true);
    depot(w, 1, undefined, ['coal']);
    for (const i of reachOf(w, mine)) {
      w.map.ore[i] = ORE_RESOURCES.indexOf('coal') + 1;
      w.map.oreAmount[i] = MINING.sureAmount + 20;
    }
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

  it('miss on tiles without their ore, as in Settlers 4: an attempt picks any tile in reach', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const mine = placeNear(w, 'coalmine', spot.x, spot.y, 4)!;
    run(w, 3000);
    expect(mine.done).toBe(true);
    depot(w, 1, undefined, ['coal']);
    // Half the reach rich coal, the other half nothing: about half the attempts find coal.
    const reach = reachOf(w, mine);
    reach.forEach((i, k) => {
      w.map.ore[i] = k % 2 === 0 ? ORE_RESOURCES.indexOf('coal') + 1 : 0;
      w.map.oreAmount[i] = k % 2 === 0 ? MINING.sureAmount + 20 : 0;
    });
    startTower(w).output.bread = 6;
    run(w, 9000);
    expect(startTower(w).output.bread).toBe(0);
    const attempts = 6 * MINING.attempts.favourite;
    expect(w.stats.produced.coal).toBeGreaterThan(attempts * 0.3);
    expect(w.stats.produced.coal).toBeLessThan(attempts * 0.75);
  });

  it('a worked-out mine goes on eating: every attempt a miss', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const mine = placeNear(w, 'coalmine', spot.x, spot.y, 4)!;
    run(w, 3000);
    expect(mine.done).toBe(true);
    for (const i of reachOf(w, mine)) w.map.oreAmount[i] = 0;
    startTower(w).output.bread = 2;
    run(w, 4000);
    expect(startTower(w).output.bread).toBe(0);
    expect(mine.input.bread).toBe(0);
    expect(w.stats.produced.coal).toBe(0);
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
  it('prospects the mountain around the target and stays a geologist, out there', () => {
    const w = richWorld();
    noGeologists(w);
    const [spot] = ownedOre(w, 'coal');
    const hammers = available(w, 1, 'hammer');
    expect(w.sendGeologist(spot.x, spot.y)).toBe(true);
    // None ordered: a carrier takes up a hammer on the spot, and the order grows by one.
    expect(workersOf(w, 1, 'geologist')).toBe(1);
    expect(workerOrder(w, 1, 'geologist')).toBe(1);
    run(w, 1500);
    expect(w.isProspected(spot.x, spot.y)).toBe(true);
    expect(w.stats.prospected).toBeGreaterThan(3);
    const geo = w.settlers.find((s) => s.kind === 'geologist')!;
    for (let i = 0; i < 40000 && geo.errand; i++) w.step();
    expect(geo.errand).toBeNull();
    // He stays a geologist where he finished; the hammer is his and does not go home.
    run(w, 600);
    expect(geo.kind).toBe('geologist');
    expect(geo.post).not.toBeNull();
    expect(Math.hypot(geo.x - geo.post!.x, geo.y - geo.post!.y)).toBeLessThan(2);
    expect(available(w, 1, 'hammer')).toBe(hammers - 1);
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
