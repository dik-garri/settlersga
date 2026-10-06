import { describe, expect, it } from 'vitest';
import { costOf, START_PLANKS, START_STONE } from '../src/sim/config';
import { RESOURCES, type BuildingType } from '../src/sim/types';
import { findPath } from '../src/sim/pathfinding';
import { World } from '../src/sim/world';

/** Finds the free spot closest to `near` where the building can be placed. */
function findSpot(world: World, type: BuildingType, near: { x: number; y: number }) {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < world.map.h; y++) {
    for (let x = 0; x < world.map.w; x++) {
      if (!world.canPlace(type, x, y)) continue;
      const d = Math.hypot(x - near.x, y - near.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  if (!best) throw new Error(`no spot for ${type}`);
  return best;
}

function totalStone(world: World) {
  return world.map.stone.reduce((sum, v) => sum + v, 0);
}

/** Units of `res` that exist as goods: in buildings' output and input piles and in carriers' hands. */
function goodsInWorld(world: World, res: 'plank' | 'stone') {
  let n = world.settlers.filter((s) => s.carrying === res).length;
  for (const b of world.buildings.values()) n += b.output[res] + (b.done ? b.input[res] : 0);
  return n;
}

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

describe('World', () => {
  it('starts with a finished castle, settlers and planks', () => {
    const world = new World(42);
    expect(world.castle.done).toBe(true);
    expect(world.castle.output.plank).toBe(START_PLANKS);
    expect(world.settlers.length).toBeGreaterThan(0);
  });

  it('rejects overlapping and water placements', () => {
    const world = new World(42);
    const { x, y } = world.castle;
    expect(world.canPlace('woodcutter', x, y)).toBe(false);
    expect(world.placeBuilding('castle', x + 5, y + 5)).toBeNull();
    const water = [...world.map.terrain.keys()].find((i) => world.map.terrain[i] === 0)!;
    expect(world.canPlace('woodcutter', water % world.map.w, Math.floor(water / world.map.w))).toBe(false);
  });

  it('builds a site, staffs it and produces logs and planks', () => {
    const world = new World(42);
    // The guaranteed grove is to the east of the castle.
    const wc = findSpot(world, 'woodcutter', { x: world.castle.x + 6, y: world.castle.y });
    const woodcutter = world.placeBuilding('woodcutter', wc.x, wc.y)!;
    expect(woodcutter).not.toBeNull();
    const sm = findSpot(world, 'sawmill', { x: world.castle.x + 1, y: world.castle.y + 6 });
    const sawmill = world.placeBuilding('sawmill', sm.x, sm.y)!;
    expect(sawmill).not.toBeNull();

    run(world, 6000);

    expect(woodcutter.done).toBe(true);
    expect(sawmill.done).toBe(true);
    expect(woodcutter.workerId).not.toBeNull();
    expect(sawmill.workerId).not.toBeNull();
    expect(world.stats.produced.log).toBeGreaterThan(5);
    expect(world.stats.produced.plank).toBeGreaterThan(3);

    const spentPlanks = costOf('woodcutter').plank + costOf('sawmill').plank;
    expect(goodsInWorld(world, 'plank')).toBe(START_PLANKS - spentPlanks + world.stats.produced.plank);
    // The sawmill's stone came from the castle's starting stock.
    expect(costOf('sawmill').stone).toBeGreaterThan(0);
    expect(goodsInWorld(world, 'stone')).toBe(START_STONE - costOf('sawmill').stone);
  });

  it('forester plants saplings around the hut', () => {
    const world = new World(42);
    const spot = findSpot(world, 'forester', { x: world.castle.x - 5, y: world.castle.y });
    const hut = world.placeBuilding('forester', spot.x, spot.y)!;
    expect(hut).not.toBeNull();

    run(world, 3000);

    expect(hut.done).toBe(true);
    expect(world.getSettler(hut.workerId)?.kind).toBe('forester');
    expect(world.stats.treesPlanted).toBeGreaterThanOrEqual(5);
    // Saplings stay off building and door tiles.
    for (let i = 0; i < world.map.tree.length; i++) {
      if (world.map.tree[i]) expect(world.map.building[i] + world.map.door[i]).toBe(0);
    }
  });

  it('keeps a woodcutter supplied for an hour when paired with a forester', () => {
    const world = new World(42);
    // On the castle meadow, so only the forester's saplings are within the woodcutter's reach.
    const c = world.castle;
    const wc = findSpot(world, 'woodcutter', { x: c.x - 4, y: c.y + 3 });
    world.placeBuilding('woodcutter', wc.x, wc.y);
    const fr = findSpot(world, 'forester', { x: c.x - 4, y: c.y - 1 });
    world.placeBuilding('forester', fr.x, fr.y);

    run(world, 30000);
    const before = world.stats.produced.log;
    run(world, 6000);

    expect(world.stats.produced.log - before).toBeGreaterThan(20);
    for (const b of world.buildings.values()) {
      expect(findPath(world.map, c.door.x, c.door.y, b.door.x, b.door.y), b.type).not.toBeNull();
    }
  });

  it('stonecutter quarries stone from deposits until they are used up', () => {
    const world = new World(42);
    const c = world.castle;
    const before = totalStone(world);
    expect(before).toBeGreaterThan(0);
    // The guaranteed quarry lies south-west of the castle.
    const spot = findSpot(world, 'stonecutter', { x: c.x - 5, y: c.y + 3 });
    const hut = world.placeBuilding('stonecutter', spot.x, spot.y)!;
    expect(hut).not.toBeNull();

    run(world, 5000);

    expect(hut.done).toBe(true);
    expect(world.getSettler(hut.workerId)?.kind).toBe('stonecutter');
    expect(world.stats.produced.stone).toBeGreaterThan(5);
    // Every unit broken off a deposit exists as goods (possibly still in the stonecutter's hands).
    const mined = before - totalStone(world);
    const inHand = world.getSettler(hut.workerId)?.carrying === 'stone' ? 1 : 0;
    expect(mined).toBe(world.stats.produced.stone + inHand);
    expect(goodsInWorld(world, 'stone')).toBe(START_STONE + mined);
    // Deposits block movement only while stone is left.
    for (let i = 0; i < world.map.stone.length; i++) {
      const x = i % world.map.w;
      const y = Math.floor(i / world.map.w);
      if (world.map.stone[i] > 0) expect(world.map.isWalkable(x, y)).toBe(false);
    }
  });

  it('only allows building inside the territory', () => {
    const world = new World(42);
    const c = world.castle;
    expect(world.map.owner[world.map.idx(c.x + 1, c.y + 1)]).toBe(1);
    expect(world.map.owner[world.map.idx(0, 0)]).toBe(0);
    for (let y = 0; y < world.map.h; y++) {
      for (let x = 0; x < world.map.w; x++) {
        if (world.canPlace('woodcutter', x, y)) {
          expect(world.map.owner[world.map.idx(x, y)]).toBe(1);
          expect(world.map.owner[world.map.idx(x + 1, y + 2)]).toBe(1);
        }
      }
    }
  });

  it('a garrisoned guard tower pushes the border out', () => {
    const world = new World(42);
    const c = world.castle;
    const owned = () => world.map.owner.reduce((sum, v) => sum + v, 0);
    const before = owned();
    // As far from the castle as the territory allows.
    let spot: { x: number; y: number } | null = null;
    let far = 0;
    for (let y = 0; y < world.map.h; y++) {
      for (let x = 0; x < world.map.w; x++) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (d > far && world.canPlace('tower', x, y)) {
          far = d;
          spot = { x, y };
        }
      }
    }
    const tower = world.placeBuilding('tower', spot!.x, spot!.y)!;
    expect(tower).not.toBeNull();

    run(world, 3000);

    expect(tower.done).toBe(true);
    expect(world.getSettler(tower.workerId)?.kind).toBe('guard');
    expect(owned()).toBeGreaterThan(before + 40);
    expect(world.map.owner[world.map.idx(tower.x, tower.y)]).toBe(1);
  });

  it('gatherers leave trees outside the territory alone', () => {
    const world = new World(42);
    const outside = new Set<number>();
    for (let i = 0; i < world.map.tree.length; i++) {
      if (world.map.tree[i] && !world.map.owner[i]) outside.add(i);
    }
    // Woodcutter right at the border, next to the wild forest.
    const c = world.castle;
    const wc = findSpot(world, 'woodcutter', { x: c.x + 8, y: c.y - 2 });
    world.placeBuilding('woodcutter', wc.x, wc.y);
    run(world, 6000);
    expect(world.stats.produced.log).toBeGreaterThan(0);
    for (const i of outside) expect(world.map.tree[i], `tree ${i}`).toBeGreaterThan(0);
  });

  it('tags buildings, settlers and land with their owner', () => {
    const world = new World(42);
    const c = world.castle;
    const wc = findSpot(world, 'woodcutter', { x: c.x + 5, y: c.y });
    const b = world.placeBuilding('woodcutter', wc.x, wc.y)!;
    expect(b.owner).toBe(1);
    expect(world.settlers.every((s) => s.owner === 1)).toBe(true);
    // Player 2 owns no land, so cannot build anywhere.
    expect(world.canPlace('woodcutter', wc.x + 2, wc.y, 2)).toBe(false);
    expect(world.placeBuilding('woodcutter', wc.x + 2, wc.y, 2)).toBeNull();
  });

  it('builders leave a starved site for one they can work on', () => {
    const world = new World(42);
    const c = world.castle;
    c.output.stone = 0; // towers will get their planks but never their stone
    const towers = [];
    for (const [dx, dy] of [[5, -4], [-5, -4], [-5, 4]]) {
      const spot = findSpot(world, 'tower', { x: c.x + dx, y: c.y + dy });
      towers.push(world.placeBuilding('tower', spot.x, spot.y)!);
    }
    run(world, 400); // all three builders settle on the towers
    const wc = findSpot(world, 'woodcutter', { x: c.x + 5, y: c.y + 4 });
    const hut = world.placeBuilding('woodcutter', wc.x, wc.y)!;
    run(world, 3000);
    expect(towers.every((t) => !t.done)).toBe(true);
    expect(hut.done).toBe(true);
  });

  it('a carrier cut off from its destination brings the goods back instead of losing them', () => {
    const world = new World(42);
    const c = world.castle;
    const spot = findSpot(world, 'sawmill', { x: c.x + 6, y: c.y + 4 });
    const site = world.placeBuilding('sawmill', spot.x, spot.y)!;
    let carrier;
    for (let i = 0; i < 400 && !carrier; i++) {
      world.step();
      carrier = world.settlers.find((s) => s.carrying === 'plank');
    }
    expect(carrier).toBeDefined();
    // Wall the site in with rock (its own footprint already blocks the rest).
    for (let y = site.y - 1; y <= site.y + site.h + 1; y++) {
      for (let x = site.x - 1; x <= site.x + site.w + 1; x++) {
        const i = world.map.idx(x, y);
        if (!world.map.building[i]) world.map.terrain[i] = 3;
      }
    }
    run(world, 1500);
    const planks = () =>
      goodsInWorld(world, 'plank') + site.delivered.plank;
    expect(site.done).toBe(false);
    expect(planks()).toBe(START_PLANKS);
    expect(world.settlers.some((s) => s.carrying === 'plank')).toBe(false);
  });

  it('refuses buildings that would close the only passage', () => {
    const world = new World(42);
    const c = world.castle;
    const wx = c.x + 5;
    const gap = c.y + 1;
    for (let y = 0; y < world.map.h; y++) {
      if (y === gap || y === gap + 1) continue;
      world.map.terrain[world.map.idx(wx, y)] = 3;
      world.map.tree[world.map.idx(wx, y)] = 0;
    }
    for (const [x, y] of [[wx, gap], [wx, gap + 1], [wx + 1, gap], [wx + 1, gap + 1], [wx + 1, gap + 2], [wx, gap + 2]]) {
      world.map.terrain[world.map.idx(x, y)] = 2;
      world.map.tree[world.map.idx(x, y)] = 0;
      world.map.stone[world.map.idx(x, y)] = 0;
    }
    world.map.terrain[world.map.idx(wx, gap + 2)] = 3;
    expect(world.canPlace('woodcutter', wx, gap)).toBe(false);
  });

  it('never leaves reservations negative', () => {
    const world = new World(7);
    const wc = findSpot(world, 'woodcutter', { x: world.castle.x + 6, y: world.castle.y });
    world.placeBuilding('woodcutter', wc.x, wc.y);
    const fr = findSpot(world, 'forester', { x: world.castle.x + 4, y: world.castle.y + 5 });
    world.placeBuilding('forester', fr.x, fr.y);
    const st = findSpot(world, 'stonecutter', { x: world.castle.x - 5, y: world.castle.y + 3 });
    world.placeBuilding('stonecutter', st.x, st.y);
    const sm = findSpot(world, 'sawmill', { x: world.castle.x + 1, y: world.castle.y - 5 });
    world.placeBuilding('sawmill', sm.x, sm.y);
    const violations: string[] = [];
    for (let i = 0; i < 3000; i++) {
      world.step();
      for (const b of world.buildings.values()) {
        for (const res of RESOURCES) {
          if (b.inbound[res] < 0 || b.outReserved[res] < 0 || b.output[res] < 0 || b.outReserved[res] > b.output[res]) {
            violations.push(`tick ${world.tick} ${b.type} ${res}`);
          }
        }
      }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(Object.values(world.stats.lost).every((n) => n === 0)).toBe(true);
  });
});
