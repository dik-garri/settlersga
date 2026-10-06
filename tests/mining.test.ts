import { describe, expect, it } from 'vitest';
import { BUILDINGS, oreOf } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function richWorld(seed = 42): World {
  const w = new World(seed);
  w.castle.output.plank = 80;
  w.castle.output.stone = 40;
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
  it('turn food into ore taken from the mountain, and idle without food', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const mine = placeNear(w, 'coalmine', spot.x, spot.y, 4)!;
    run(w, 3000);
    expect(mine.done).toBe(true);
    expect(w.stats.produced.coal).toBe(0); // no food yet

    const before = oreLeft(w, 'coal');
    w.castle.output.bread = 3;
    w.castle.output.fish = 3;
    run(w, 3000);
    expect(w.stats.produced.coal).toBe(6); // one unit of any food per unit of coal
    expect(oreLeft(w, 'coal')).toBe(before - 6);
    expect(w.castle.output.bread + w.castle.output.fish).toBe(0);
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
    w.castle.output.bread = reachable + 10;
    run(w, 1500 + reachable * 120);
    expect(w.stats.produced.ironore).toBe(reachable);
  });
});

describe('geologist', () => {
  it('prospects owned mountain tiles around the target and goes back to carrying', () => {
    const w = richWorld();
    const [spot] = ownedOre(w, 'coal');
    const carriersBefore = w.settlers.filter((s) => s.kind === 'carrier').length;
    expect(w.sendGeologist(spot.x, spot.y)).toBe(true);
    expect(w.settlers.some((s) => s.kind === 'geologist')).toBe(true);
    run(w, 1500);
    expect(w.isProspected(spot.x, spot.y)).toBe(true);
    expect(w.stats.prospected).toBeGreaterThan(3);
    expect(w.settlers.filter((s) => s.kind === 'carrier').length).toBe(carriersBefore);
    // Not on grass.
    const c = w.castle;
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
