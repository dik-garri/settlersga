import { describe, expect, it } from 'vitest';
import { addBuilding, spawnSettler } from '../src/sim/buildings';
import { DISTRIBUTION_DEFAULTS, GROWTH, S4_HEIGHT_PX, S4_TILES_PER_TILE } from '../src/sim/config';
import { consumersOf, defaultWeight, DEFAULT_WEIGHT, distributionKey, economyOf } from '../src/sim/economy';
import { dropGoods } from '../src/sim/ground';
import { canPlant, rawness } from '../src/sim/nature';
import type { Building, BuildingType, Point } from '../src/sim/types';
import { World } from '../src/sim/world';
import { base, clearGround, goodsInWorld, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A building of `type` on the free spot nearest `at` (finished unless `done` is false). */
function placed(w: World, type: BuildingType, at: Point, done = true): Building {
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = at.y - 10; y <= at.y + 10; y++) {
    for (let x = at.x - 10; x <= at.x + 10; x++) {
      const d = Math.hypot(x - at.x, y - at.y);
      if (d < bestD && w.canPlace(type, x, y)) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  if (!best) throw new Error(`no room for ${type}`);
  return addBuilding(w, type, best.x, best.y, 1, done);
}

describe('default distribution (Settlers 4 BUILDINGSUPPLYPRIORITY)', () => {
  it('bread goes 85 % to the coal mines, the rest shared equally by the other mines', () => {
    expect(DISTRIBUTION_DEFAULTS.bread?.coalmine).toBe(85);
    const others = consumersOf('bread').filter((t) => t !== 'coalmine');
    expect(others.length).toBeGreaterThan(0);
    for (const t of others) expect(defaultWeight('bread', t)).toBe(Math.round(15 / others.length));
    // Goods without Settlers 4 defaults are shared equally.
    for (const t of consumersOf('grain')) expect(defaultWeight('grain', t)).toBe(DEFAULT_WEIGHT);
  });

  it('the defaults order deliveries and survive the player moving another slider', () => {
    const w = new World(42);
    const eco = economyOf(w, 1);
    const coal = { done: true, type: 'coalmine' } as Building;
    const iron = { done: true, type: 'ironmine' } as Building;
    eco.tally.bread = { coalmine: 16, ironmine: 1 };
    // 16 units to coal mines weigh less than one to an iron mine: 16 / 85 < 1 / 5.
    expect(distributionKey(eco, 'bread', coal)).toBeLessThan(distributionKey(eco, 'bread', iron));
    eco.tally.bread = { coalmine: 18, ironmine: 1 };
    expect(distributionKey(eco, 'bread', coal)).toBeGreaterThan(distributionKey(eco, 'bread', iron));
    expect(w.setDistribution('bread', 'goldmine', 20)).toBe(true);
    expect(eco.distribution.bread).toMatchObject({ coalmine: 85, ironmine: 5, goldmine: 20 });
  });
});

describe('a stopped market turns donkeys around (Settlers 4 CancelIncomingDeliverTraders)', () => {
  it('a loaded donkey on its way goes back to the market it loaded at and unloads there; nothing is lost', () => {
    const w = new World(42);
    const c = base(w);
    const a = placed(w, 'market', { x: c.x + 5, y: c.y - 3 });
    const b = placed(w, 'market', { x: c.x - 9, y: c.y + 8 });
    for (let i = 0; i < 2; i++) spawnSettler(w, 'donkey', a);
    startTower(w).output.plank = 20;
    w.setTradeRoute(a.id, b.id);
    w.orderTrade(a.id, 'plank', 16);
    const planks = goodsInWorld(w, 'plank');
    let donkey = undefined;
    for (let t = 0; t < 8000 && !donkey; t++) {
      w.step();
      donkey = w.settlers.find((s) => s.kind === 'donkey' && s.carrying && s.tasks.some((k) => k.t === 'unload' && k.b === b.id));
    }
    expect(donkey).toBeDefined();
    const carried = (donkey!.load ?? 0) + (donkey!.pack2?.n ?? 0);
    expect(carried).toBeGreaterThan(0);
    run(w, 30); // well on its way
    expect(w.setStopped(b.id, true)).toBe(true);
    // Turned around: back to the market it loaded at.
    expect(donkey!.tasks.some((k) => k.t === 'unload' && k.b === b.id)).toBe(false);
    expect(donkey!.tasks.at(-1)).toMatchObject({ t: 'unload', b: a.id });
    const outBefore = a.output.plank;
    for (let t = 0; t < 3000 && donkey!.carrying; t++) w.step();
    expect(donkey!.carrying).toBeNull();
    expect(b.output.plank).toBe(0);
    expect(a.output.plank + a.outReserved.plank).toBeGreaterThanOrEqual(outBefore);
    expect(goodsInWorld(w, 'plank')).toBe(planks);
    expect(w.stats.lost.plank).toBe(0);
    // No donkey is sent to the stopped market any more.
    run(w, 600);
    expect(w.settlers.some((s) => s.kind === 'donkey' && s.tasks.some((k) => k.t === 'unload' && k.b === b.id))).toBe(false);
    for (const n of Object.values(a.trade!.loading)) expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe('fields only on gentle ground (Settlers 4 SearchGrainSeedPos: slope ≤ 7)', () => {
  /** An own plantable tile near the start with flat corners (set flat by the test). */
  function flatTile(w: World): Point {
    const c = base(w);
    const m = w.map;
    for (let r = 3; r < 12; r++) {
      for (let y = c.y - r; y <= c.y + r; y++) {
        for (let x = c.x - r; x <= c.x + r; x++) {
          if (m.owner[m.idx(x, y)] !== 1 || !canPlant(w, 'tree', x, y, 1)) continue;
          for (const [vx, vy] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) m.setVertexHeight(vx, vy, 20);
          return { x, y };
        }
      }
    }
    throw new Error('no plantable tile');
  }

  it('measures slope in S4 height units over two of its tiles', () => {
    expect(S4_HEIGHT_PX).toBeCloseTo(0.778, 2);
    const w = new World(42);
    const t = flatTile(w);
    expect(rawness(w.map, t.x, t.y)).toBe(0);
    // One edge rising by d px: d / S4_TILES_PER_TILE px per S4 tile, over two S4 tiles, in units.
    w.map.setVertexHeight(t.x + 1, t.y, 26);
    expect(rawness(w.map, t.x, t.y)).toBeCloseTo((6 * 2) / S4_TILES_PER_TILE / S4_HEIGHT_PX, 5);
  });

  it('grain is sown up to the limit and not beyond; trees have none', () => {
    const w = new World(42);
    const t = flatTile(w);
    const limit = GROWTH.grain.maxSlope!;
    expect(limit).toBe(7);
    // The steepest rise along an edge that still counts as 7 units, and one pixel more.
    const ok = Math.floor((limit * S4_TILES_PER_TILE * S4_HEIGHT_PX) / 2);
    w.map.setVertexHeight(t.x + 1, t.y, 20 + ok);
    w.map.setVertexHeight(t.x + 1, t.y + 1, 20 + ok);
    expect(canPlant(w, 'grain', t.x, t.y, 1)).toBe(true);
    w.map.setVertexHeight(t.x + 1, t.y, 20 + ok + 1);
    w.map.setVertexHeight(t.x + 1, t.y + 1, 20 + ok + 1);
    expect(rawness(w.map, t.x, t.y)).toBeGreaterThan(limit);
    expect(canPlant(w, 'grain', t.x, t.y, 1)).toBe(false);
    expect(canPlant(w, 'tree', t.x, t.y, 1)).toBe(true);
  });
});

describe('finished buildings before sites at equal urgency (Settlers 4 CalcUrgent)', () => {
  /**
   * One unit of gold on the ground right by a statue site (an eyecatcher costs gold) and a finished
   * barracks further away that wants gold for a recruit order: both consume gold, which no recipe
   * shares out (no distribution), and the site is nearer the gold.
   */
  function setup(orderGold: boolean) {
    const w = new World(42);
    clearGround(w);
    const c = base(w);
    const barracks = placed(w, 'barracks', { x: c.x - 8, y: c.y + 6 });
    const statue = placed(w, 'statue', { x: c.x + 6, y: c.y + 1 }, false);
    statue.levelled = true; // asks for its materials at once
    dropGoods(w, { x: statue.door.x + 1, y: statue.door.y }, 'gold', 1);
    if (orderGold) w.orderRecruits('soldier', 1, 1);
    for (let t = 0; t < 300 && barracks.inbound.gold + statue.inbound.gold === 0; t++) w.step();
    return { w, barracks, statue };
  }

  it('the gold goes to the finished barracks, not to the nearer site', () => {
    const { barracks, statue } = setup(true);
    expect(barracks.inbound.gold).toBe(1);
    expect(statue.inbound.gold).toBe(0);
  });

  it('with no finished building wanting it, the site gets it', () => {
    const { barracks, statue } = setup(false);
    expect(barracks.inbound.gold).toBe(0);
    expect(statue.inbound.gold).toBe(1);
  });
});
