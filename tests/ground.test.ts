import { describe, expect, it } from 'vitest';
import { centerOf, spawnSettler } from '../src/sim/buildings';
import { costOf, FLEE, GROUND, START_CONDITIONS, startGoods } from '../src/sim/config';
import { dropGoods, goodsOn } from '../src/sim/ground';
import { enterGarrison, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { RESOURCES, type Building, type BuildingType, type Resource } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { sameRegion } from '../src/sim/regions';
import { base, clearGround, goodsInWorld, groundUnits, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

function place(w: World, type: BuildingType, dx: number, dy: number, player = 1): Building {
  const c = base(w, player);
  const b = placeNear(w, type, c.x + dx, c.y + dy, 14, player);
  expect(b, type).not.toBeNull();
  return b!;
}

/** Units of `res` lying within `r` tiles of the building's footprint centre. */
function lyingNear(w: World, b: Building, res: Resource, r = GROUND.searchRadius + 1): number {
  const c = centerOf(b);
  let n = 0;
  for (const i of w.stacks) {
    if (goodsOn(w, i) !== res) continue;
    if (Math.hypot((i % w.map.w) - c.x, Math.floor(i / w.map.w) - c.y) <= r) n += w.map.goodsAmount[i];
  }
  return n;
}

describe('goods on the ground (Settlers 4 piles)', () => {
  it('every start level lays its Settlers 4 piles round the start tower, nothing lost', () => {
    for (const level of Object.keys(START_CONDITIONS) as (keyof typeof START_CONDITIONS)[]) {
      const w = new World(42, { start: level });
      const goods = startGoods(START_CONDITIONS[level]);
      for (const r of RESOURCES) expect(groundUnits(w, r, 1), `${level} ${r}`).toBe(goods[r] ?? 0);
      expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
      expect(startTower(w).type).toBe(START_CONDITIONS[level].building);
    }
  });

  it('stacks never block walking, but nothing is built or planted on them', () => {
    const w = new World(42);
    for (const i of w.stacks) {
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      expect(w.map.isWalkable(x, y)).toBe(true);
      expect(w.map.isBuildable(x, y)).toBe(false);
      expect(w.map.isPlantable(x, y)).toBe(false);
    }
  });

  it('carriers build sites straight from the start goods, with no warehouse at all', () => {
    const w = new World(42);
    const planks = groundUnits(w, 'plank', 1);
    const site = place(w, 'woodcutter', 7, 1);
    run(w, 4000);
    expect(site.done).toBe(true);
    expect(groundUnits(w, 'plank', 1)).toBe(planks - costOf('woodcutter').plank);
    expect([...w.buildings.values()].some((b) => b.type === 'warehouse')).toBe(false);
    // Reservations were all released: nothing promised lies on the ground any more.
    for (const i of w.stacks) expect(w.map.goodsReserved[i]).toBe(0);
  });

  it('a new warehouse takes nothing in; ticked goods are carried to it off the ground, the rest stays', () => {
    const w = new World(42);
    const store = place(w, 'warehouse', -2, -6);
    run(w, 4000);
    expect(store.done).toBe(true);
    expect(store.accept).toBeUndefined();
    expect(RESOURCES.every((r) => store.output[r] + store.inbound[r] === 0)).toBe(true);
    const fish = groundUnits(w, 'fish', 1);
    expect(fish).toBeGreaterThan(0);
    expect(w.setAccepts(store.id, 'fish', true)).toBe(true);
    expect(store.accept).toEqual(['fish']);
    run(w, 2500);
    expect(store.output.fish).toBe(fish);
    expect(groundUnits(w, 'fish', 1)).toBe(0);
    // Not ticked: still on the ground.
    expect(groundUnits(w, 'coal', 1)).toBe(10);
    expect(store.output.coal).toBe(0);
  });

  it('a demolished building leaves half its materials and every good lying at it (Settlers 4)', () => {
    const w = new World(42);
    const hut = place(w, 'sawmill', 6, 6);
    run(w, 5000);
    expect(hut.done).toBe(true);
    clearGround(w);
    hut.output.plank = 5;
    hut.input.log = 3;
    expect(w.demolish(hut.id)).toBe(true);
    const cost = costOf('sawmill');
    expect(lyingNear(w, hut, 'plank')).toBe(Math.floor(cost.plank * GROUND.demolishShare) + 5);
    expect(lyingNear(w, hut, 'stone')).toBe(Math.floor(cost.stone * GROUND.demolishShare));
    expect(lyingNear(w, hut, 'log')).toBe(3);
    // On and around the old footprint, at most a pile of 8 a tile, and its tiles are free again.
    for (const i of w.stacks) expect(w.map.goodsAmount[i]).toBeLessThanOrEqual(GROUND.perStack);
    expect(w.map.building[w.map.idx(hut.x, hut.y)]).toBe(0);
  });

  it('a demolished site gives back half of what was built in and whatever still waited there', () => {
    const w = new World(42);
    const site = place(w, 'house_medium', 6, 6);
    // Delivered but not built in yet: 4 planks and 2 stone; built in: 2 planks.
    site.delivered.plank = 4;
    site.delivered.stone = 2;
    site.progress = 2 * 142;
    clearGround(w);
    w.demolish(site.id);
    expect(lyingNear(w, site, 'plank')).toBe(Math.floor(2 * GROUND.demolishShare) + 2);
    expect(lyingNear(w, site, 'stone')).toBe(2);
  });

  it('a carrier whose destination is torn down puts his load down; it is used later, never lost', () => {
    const w = new World(42);
    const site = place(w, 'sawmill', 6, 4);
    let carrier;
    for (let i = 0; i < 600 && !carrier; i++) {
      w.step();
      carrier = w.settlers.find((s) => s.carrying === 'plank' && s.tasks.some((t) => t.t === 'drop' && t.b === site.id));
    }
    expect(carrier).toBeDefined();
    const before = goodsInWorld(w, 'plank') + site.delivered.plank;
    expect(site.progress).toBe(0); // nothing built in yet: every delivered plank lies there whole
    w.demolish(site.id);
    expect(carrier!.carrying).toBeNull();
    expect(goodsInWorld(w, 'plank')).toBe(before);
    expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
    // Another site takes what lies about.
    const next = place(w, 'woodcutter', -6, 4);
    run(w, 4000);
    expect(next.done).toBe(true);
  });

  it('goods on the ground, a ruin and reservations continue bit for bit after save and load', () => {
    const w = new World(7);
    place(w, 'woodcutter', 7, 1);
    const store = place(w, 'warehouse', -2, -6);
    run(w, 1500);
    w.setAccepts(store.id, 'bread', true);
    dropGoods(w, { x: base(w).x + 3, y: base(w).y + 9 }, 'meat', 11);
    run(w, 700);
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(saveWorld(b)).toEqual(saveWorld(w));
    run(w, 2000);
    run(b, 2000);
    expect(saveWorld(b)).toEqual(saveWorld(w));
  });
});

describe('defeat and stranded settlers (Settlers 4)', () => {
  /** Two players; player 2 is left with nothing but its start tower and a hut. */
  function duel() {
    const w = new World(42, { players: 2 });
    const hut = place(w, 'woodcutter', 6, 2, 2);
    run(w, 3000);
    return { w, hut, tower: startTower(w, 2) };
  }

  it('a player with no occupied military building left is out: buildings burn, goods stay, settlers wander off and die', () => {
    const { w, hut, tower } = duel();
    expect(hut.done).toBe(true);
    hut.output.log = 4;
    // Empty the start tower (in play: killed in its defence).
    for (const id of [...tower.garrison]) killSettler(w, w.getSettler(id)!);
    for (const s of w.settlers) if (s.owner === 2 && (s.kind === 'soldier' || s.kind === 'archer')) killSettler(w, s);
    run(w, 20);
    expect(w.isDefeated(2)).toBe(true);
    expect(w.outcome(1)).toBe('won');
    expect([...w.buildings.values()].some((b) => b.owner === 2)).toBe(false);
    // Burnt, not demolished: no materials back, the logs at the hut stay on the ground.
    expect(lyingNear(w, hut, 'log')).toBe(4);
    const people = w.settlers.filter((s) => s.owner === 2);
    expect(people.length).toBeGreaterThan(0);
    run(w, 200);
    expect(w.settlers.filter((s) => s.owner === 2).length).toBeGreaterThan(0); // wandering a while…
    run(w, 6000);
    expect(w.settlers.filter((s) => s.owner === 2).length).toBe(0); // …then gone
  });

  it('a worker homeless on land that is no longer his flees to his own land, or dies after a few legs', () => {
    const w = new World(42);
    // A stranded carrier far out on neutral land (no own land within FLEE.seek of him).
    const lost = spawnSettler(w, 'carrier', startTower(w));
    lost.inside = null;
    lost.x = lost.px = 2;
    lost.y = lost.py = 2;
    expect(w.map.owner[w.map.idx(2, 2)]).toBe(0);
    // One a few tiles outside the border, where he can walk home: he does, and is a carrier again.
    const near = spawnSettler(w, 'carrier', startTower(w));
    near.inside = null;
    const door = startTower(w).door;
    const m = w.map;
    let edge = { x: door.x, y: door.y };
    let best = Infinity;
    for (let y = 1; y < m.h - 1; y++) {
      for (let x = 1; x < m.w - 1; x++) {
        const i = m.idx(x, y);
        if (m.owner[i] !== 0 || !m.isWalkable(x, y) || !sameRegion(m, i, m.idx(door.x, door.y))) continue;
        // Three tiles beyond the border.
        if (![[3, 0], [-3, 0], [0, 3], [0, -3]].some(([dx, dy]) => m.owner[m.idx(x + dx, y + dy)] === 1)) continue;
        const d = Math.hypot(x - door.x, y - door.y);
        if (d < best) {
          best = d;
          edge = { x, y };
        }
      }
    }
    expect(best).toBeLessThan(Infinity);
    near.x = near.px = edge.x;
    near.y = near.py = edge.y;
    run(w, 1500);
    expect(near.fled).toBeUndefined();
    expect(w.map.owner[w.map.idx(Math.round(near.x), Math.round(near.y))]).toBe(1);
    expect(w.settlers.includes(near)).toBe(true);
    run(w, 3000);
    expect(w.settlers.includes(lost)).toBe(false);
    expect(FLEE.legs).toBeGreaterThan(0);
  });

  it('fighters do not flee: homeless start fighters wait for a garrison', () => {
    const w = new World(42);
    const free = w.settlers.filter((s) => s.owner === 1 && s.kind === 'soldier' && s.home === null);
    expect(free.length).toBe(START_CONDITIONS.medium.soldiers - 1);
    const tower = place(w, 'tower', 9, -6);
    run(w, 4000);
    expect(tower.done).toBe(true);
    expect(tower.garrison.length).toBeGreaterThan(0);
    expect(free.every((s) => w.settlers.includes(s))).toBe(true);
    // A spare in the start tower keeps the player in the game.
    enterGarrison(w, startTower(w), spawnSettler(w, 'soldier', startTower(w)));
    run(w, 20);
    expect(w.isDefeated(1)).toBe(false);
  });
});
