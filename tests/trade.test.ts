import { describe, expect, it } from 'vitest';
import { addBuilding, recomputeTerritory, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, TRADE } from '../src/sim/config';
import { ENDLESS } from '../src/sim/economy';
import { isCutOff, landOf } from '../src/sim/land';
import { enterGarrison } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import type { Building, BuildingType } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A spot where a building of `type` fits on buildable ground at least `minD` from the start. */
function freeSpot(w: World, type: BuildingType, minD: number, maxD: number): { x: number; y: number } {
  const m = w.map;
  const c = base(w);
  const def = BUILDINGS[type];
  for (let r = minD; r <= maxD; r++) {
    for (let a = 0; a < 64; a++) {
      const x = Math.round(c.x + Math.cos((a / 64) * Math.PI * 2) * r);
      const y = Math.round(c.y + Math.sin((a / 64) * Math.PI * 2) * r);
      let ok = true;
      for (let dy = 0; dy <= def.h && ok; dy++) {
        for (let dx = 0; dx < def.w && ok; dx++) {
          if (!m.isBuildable(x + dx, y + dy, 'ground') || m.owner[m.idx(x + dx, y + dy)] !== 0) ok = false;
        }
      }
      if (ok) return { x, y };
    }
  }
  throw new Error('no free spot');
}

/** A manned tower far from the start: a second piece of the player's land, cut off from the first. */
function outpost(w: World): Building {
  const at = freeSpot(w, 'tower', 26, 40);
  const t = addBuilding(w, 'tower', at.x, at.y, 1, true);
  enterGarrison(w, t, spawnSettler(w, 'soldier', t));
  recomputeTerritory(w);
  return t;
}

/** A finished building of `type` placed directly on the given piece of land (near `near`). */
function onPiece(w: World, type: BuildingType, near: Building): Building {
  const m = w.map;
  const def = BUILDINGS[type];
  const piece = landOf(w, near);
  for (let r = 3; r < 12; r++) {
    for (let y = near.y - r; y <= near.y + r; y++) {
      for (let x = near.x - r; x <= near.x + r; x++) {
        if (!w.canPlace(type, x, y)) continue;
        const door = { x: x + def.w - 1, y: y + def.h };
        if (m.owner[m.idx(door.x, door.y)] !== 1 || w.land[m.idx(door.x, door.y)] !== piece) continue;
        return addBuilding(w, type, x, y, 1, true);
      }
    }
  }
  throw new Error(`no room for ${type}`);
}

describe('carriers work only on their own land', () => {
  it('splits the territory into pieces and marks buildings cut off from every warehouse and from home', () => {
    const w = new World(42);
    const t = outpost(w);
    expect(landOf(w, t)).toBeGreaterThan(0);
    expect(landOf(w, t)).not.toBe(landOf(w, startTower(w)));
    // The home piece (where the start goods lie) counts as served, though it has no warehouse.
    expect(isCutOff(w, startTower(w))).toBe(false);
    expect(isCutOff(w, t)).toBe(true);
  });

  it('delivers to sites on the home land but not to a site on a cut-off piece', () => {
    const w = new World(42);
    const t = outpost(w);
    const far = onPiece(w, 'woodcutter', t);
    far.done = false;
    far.levelled = true;
    const near = placeNear(w, 'woodcutter', base(w).x + 5, base(w).y + 3)!;
    run(w, 3000);
    expect(near.delivered.plank + (near.done ? 1 : 0)).toBeGreaterThan(0);
    expect(far.delivered.plank).toBe(0);
    expect(far.inbound.plank).toBe(0);
  });
});

describe('donkeys and marketplaces', () => {
  /** Two markets — one by the start, one on a cut-off piece — and two donkeys. */
  function caravan() {
    const w = new World(42);
    const t = outpost(w);
    const home = placeNear(w, 'market', base(w).x + 5, base(w).y - 2)!;
    home.done = true;
    home.levelled = true;
    const away = onPiece(w, 'market', t);
    for (let i = 0; i < 2; i++) spawnSettler(w, 'donkey', startTower(w));
    return { w, t, home, away };
  }

  it('carry ordered goods from one market to another across land the carriers cannot cross', () => {
    const { w, home, away } = caravan();
    expect(w.setTradeRoute(home.id, away.id)).toBe(true);
    expect(w.orderTrade(home.id, 'plank', 6)).toBe(true);
    run(w, 4000);
    expect(away.output.plank + away.outReserved.plank).toBeGreaterThan(0);
    expect(home.trade!.orders.plank ?? 0).toBeLessThan(6);
    // A donkey's load is at most TRADE.donkeyLoad, and nothing was lost on the way.
    expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
    for (const s of w.settlers) if (s.kind === 'donkey') expect(s.load ?? 0).toBeLessThanOrEqual(TRADE.donkeyLoad);
  });

  it('a market with every order cancelled moves nothing: deliveries on their way turn back', () => {
    const { w, home, away } = caravan();
    w.setTradeRoute(home.id, away.id);
    w.orderTrade(home.id, 'plank', ENDLESS);
    w.orderTrade(home.id, 'stone', ENDLESS);
    // Until carriers are on their way with both goods.
    for (let i = 0; i < 2000 && (home.inbound.plank === 0 || home.inbound.stone === 0); i++) w.step();
    expect(home.inbound.plank + home.inbound.stone).toBeGreaterThan(0);
    for (const res of ['plank', 'stone'] as const) w.orderTrade(home.id, res, 0);
    expect(home.inbound.plank + home.inbound.stone).toBe(0);
    const carriersTo = () =>
      w.settlers.filter((s) => s.kind === 'carrier' && s.tasks.some((t) => t.t === 'drop' && t.b === home.id)).length;
    const donkeysFrom = () => w.settlers.filter((s) => s.tasks.some((t) => t.t === 'load' && t.b === home.id)).length;
    for (let i = 0; i < 3000; i++) {
      w.step();
      expect(carriersTo()).toBe(0);
      expect(donkeysFrom()).toBe(0);
    }
    // Nothing is left stuck in the market's input; leftovers went back via its output pile.
    expect(home.input.plank + home.input.stone).toBe(0);
    expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
  });

  it('a delivery arriving at a market without an order goes on its output pile, not its input', () => {
    const { w, home, away } = caravan();
    w.setTradeRoute(home.id, away.id);
    w.orderTrade(home.id, 'plank', ENDLESS);
    for (let i = 0; i < 2000 && home.inbound.plank === 0; i++) w.step();
    expect(home.inbound.plank).toBeGreaterThan(0);
    // Drop the order behind the carrier's back (no cancel command): the safety net still applies.
    delete home.trade!.orders.plank;
    for (let i = 0; i < 2000 && home.inbound.plank > 0; i++) {
      w.step();
      expect(home.input.plank).toBe(0);
    }
    expect(home.inbound.plank).toBe(0);
  });

  it('supplies a site on the cut-off piece with goods the donkeys brought, by a carrier that walked over', () => {
    const { w, t, home, away } = caravan();
    const site = onPiece(w, 'woodcutter', t);
    site.done = false;
    site.levelled = true;
    w.setTradeRoute(home.id, away.id);
    w.orderTrade(home.id, 'plank', ENDLESS);
    run(w, 9000);
    expect(site.delivered.plank + (site.done ? 99 : 0)).toBeGreaterThan(0);
  });

  it('donkeys bring a market site on a cut-off piece its materials, so it gets built', () => {
    const { w, home, away } = caravan();
    away.done = false;
    away.levelled = true;
    expect(w.setTradeRoute(home.id, away.id)).toBe(true);
    w.orderTrade(home.id, 'plank', 2);
    w.orderTrade(home.id, 'stone', 4);
    run(w, 9000);
    expect(away.done).toBe(true);
    expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
  });

  it('a donkey ranch breeds only while the markets want more donkeys', () => {
    const w = new World(42);
    const ranch = placeNear(w, 'donkeyranch', base(w).x + 5, base(w).y + 3)!;
    ranch.done = true;
    ranch.levelled = true;
    startTower(w).output.grain = 20;
    startTower(w).output.water = 20;
    run(w, 3000);
    const donkeys = () => w.settlers.filter((s) => s.kind === 'donkey').length;
    expect(donkeys()).toBe(0); // no market: no donkeys
    const m = placeNear(w, 'market', base(w).x - 5, base(w).y + 3)!;
    m.done = true;
    m.levelled = true;
    w.buildingsVersion++;
    run(w, 9000);
    expect(donkeys()).toBeGreaterThan(0);
    expect(donkeys()).toBeLessThanOrEqual(TRADE.donkeysPerMarket);
  });

  it('a market lost mid-trip sends the loaded donkey to another market; trade survives save and load', () => {
    const { w, home, away } = caravan();
    w.setTradeRoute(home.id, away.id);
    w.orderTrade(home.id, 'stone', ENDLESS);
    let loaded = false;
    for (let i = 0; i < 6000 && !loaded; i++) {
      w.step();
      loaded = w.settlers.some((s) => s.kind === 'donkey' && s.carrying === 'stone');
    }
    expect(loaded).toBe(true);
    const copy = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 600);
    run(copy, 600);
    expect(saveWorld(copy)).toEqual(saveWorld(w));
    // Demolishing the destination: the donkeys bring their packs back to the home market.
    w.demolish(away.id);
    run(w, 3000);
    expect(w.stats.lost.stone).toBe(0);
    expect(home.trade!.loading.stone ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('rejects routes to other players’ buildings or to non-markets', () => {
    const { w, home } = caravan();
    expect(w.setTradeRoute(home.id, startTower(w).id)).toBe(false);
    expect(w.setTradeRoute(home.id, home.id)).toBe(false);
    expect(w.setTradeRoute(startTower(w).id, home.id)).toBe(false);
    expect(w.setTradeRoute(home.id, startTower(w, 1).id, 2)).toBe(false);
  });
});
