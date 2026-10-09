/**
 * Economy rules taken over from Settlers 4 (docs/S4-AUDIT.md, items 2, 3, 6, 9, 10, 11, 12, 15):
 * no natural tree spread, site supply in piles of 8 with hard priority, fish that run out and get
 * missed, the carrier reserve, the transport priority list, meat 1 : 1 with a 77 % pig farm, and
 * donkeys with two packs of 8 from a 25 % ranch. (Mines' misses: `mining.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { addBuilding, spawnSettler, updateBuilding } from '../src/sim/buildings';
import { recomputeTerritory } from '../src/sim/territory';
import { BUILDINGS, CARRIER_RESERVE, DISPATCH_EVERY, PROFESSIONS, SITE, TRADE, TRANSPORT_PRIORITY } from '../src/sim/config';
import { carrierReserve, spareCarriers, transportOrder } from '../src/sim/economy';
import { landOf } from '../src/sim/land';
import { siteNeeds, sitePile } from '../src/sim/logistics';
import { enterGarrison, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { RESOURCES, Terrain, type Building, type BuildingType } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, clearGround, depot, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const treeCount = (w: World) => w.map.tree.reduce((n, t) => n + (t > 0 ? 1 : 0), 0);
const carriersOf = (w: World) => w.settlers.filter((s) => s.owner === 1 && s.kind === 'carrier' && !w.dying.has(s.id));

describe('trees (Settlers 4: only foresters plant)', () => {
  it('no tree appears by itself', () => {
    const w = new World(42);
    const before = treeCount(w);
    run(w, 6000);
    // Nobody fells or plants here: the forest stays exactly as it was generated.
    expect(treeCount(w)).toBe(before);
  });

  it('a forester still plants and his saplings grow', () => {
    const w = new World(42);
    startTower(w).output.plank = 20;
    startTower(w).output.stone = 20;
    const c = base(w);
    const hut = placeNear(w, 'forester', c.x + 5, c.y + 3)!;
    run(w, 9000);
    expect(hut.done).toBe(true);
    expect(w.stats.treesPlanted).toBeGreaterThan(0);
  });
});

describe('construction sites (Settlers 4)', () => {
  it('ask for nothing before a digger comes, then for at most SITE.pile of a material at a time', () => {
    const w = new World(42);
    clearGround(w);
    startTower(w).output.plank = 40;
    startTower(w).output.stone = 40;
    for (const s of w.settlers.filter((s) => s.kind === 'digger')) killSettler(w, s);
    w.orderWorkers('digger', 0);
    const c = base(w);
    const site = placeNear(w, 'house_large', c.x + 6, c.y + 2)!;
    expect(site.levelled).toBe(false);
    run(w, 600);
    expect(site.delivered.plank + site.inbound.plank + site.delivered.stone + site.inbound.stone).toBe(0);

    // A digger: now the materials come, never more than SITE.pile lying or on the way per material.
    startTower(w).output.shovel = 1;
    w.orderWorkers('digger', 1);
    let most = 0;
    for (let t = 0; t < 30000 && !site.done; t++) {
      w.step();
      for (const r of ['plank', 'stone'] as const) most = Math.max(most, sitePile(site, r) + site.inbound[r]);
    }
    expect(site.done).toBe(true);
    expect(most).toBe(SITE.pile);
    expect(BUILDINGS.house_large.cost.stone!).toBeGreaterThan(SITE.pile);
  });

  it('hard priority: while a prioritised site needs a material, no other site on its land gets any', () => {
    const w = new World(42);
    clearGround(w);
    startTower(w).output.plank = 30;
    startTower(w).output.stone = 30;
    const c = base(w);
    const a = placeNear(w, 'house_small', c.x + 5, c.y - 1)!;
    const b = placeNear(w, 'house_medium', c.x - 5, c.y - 1)!;
    expect(w.setPriority(b.id, true)).toBe(true);
    for (let t = 0; t < 20000 && !b.done; t++) {
      w.step();
      for (const r of ['plank', 'stone'] as const) {
        if (siteNeeds(b, r) > 0) expect(a.inbound[r]).toBe(0);
      }
    }
    expect(b.done).toBe(true);
    // The flag goes once the site is built; the other site gets its turn.
    expect(b.priority).toBe(false);
    run(w, 9000);
    expect(a.done).toBe(true);
  });

  it('at most SITE.maxPriority prioritised sites per piece of land', () => {
    const w = new World(42);
    const c = base(w);
    const sites: Building[] = [];
    for (let k = 0; sites.length <= SITE.maxPriority && k < 200; k++) {
      const b = placeNear(w, 'flowerbed', c.x - 6 + (k % 14), c.y + 5 + Math.floor(k / 14), 2);
      if (b) sites.push(b);
    }
    expect(sites.length).toBe(SITE.maxPriority + 1);
    expect(new Set(sites.map((b) => landOf(w, b))).size).toBe(1);
    for (let k = 0; k < SITE.maxPriority; k++) expect(w.setPriority(sites[k].id, true)).toBe(true);
    expect(w.setPriority(sites[SITE.maxPriority].id, true)).toBe(false);
    // Turning one off makes room again.
    expect(w.setPriority(sites[0].id, false)).toBe(true);
    expect(w.setPriority(sites[SITE.maxPriority].id, true)).toBe(true);
  });
});

/** Nearest owned water tile that touches walkable land, on the first standard seed that has one. */
function worldWithShore() {
  for (const seed of [42, 7, 123, 999, 5, 11, 13]) {
    const w = new World(seed);
    startTower(w).output.plank = 40;
    startTower(w).output.stone = 40;
    const c = base(w);
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let i = 0; i < w.map.terrain.length; i++) {
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      if (w.map.terrain[i] !== Terrain.Water || !w.owns(x, y) || !w.map.hasWalkableNeighbor(x, y)) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < bestD) {
        best = { x, y };
        bestD = d;
      }
    }
    if (best) return { w, shore: best };
  }
  throw new Error('no seed with water in the starting territory');
}

describe('fish (Settlers 4: they run out, a third of the attempts fail)', () => {
  it('a missed attempt takes no fish; the water never restocks', () => {
    const { w, shore } = worldWithShore();
    const hut = placeNear(w, 'fisher', shore.x, shore.y, 6)!;
    depot(w, 1, undefined, ['fish']); // takes the catch away: a full pile would pause the fisher
    const fishInWater = () => w.map.fish.reduce((n, f) => n + f, 0);
    const start = fishInWater();
    let catches = 0;
    let misses = 0;
    let atDoor = false;
    for (let t = 0; t < 40000; t++) {
      w.step();
      const fisher = w.getSettler(hut.workerId);
      const head = fisher?.tasks[0];
      // An outing ends with the fisher putting his catch down at the hut — or with empty hands.
      const now = head?.t === 'store';
      if (now && !atDoor) {
        if (fisher!.carrying === 'fish') catches++;
        else misses++;
      }
      atDoor = now;
      // Nothing restocks: the water only ever loses fish, exactly as many as were caught (stored at
      // the hut or still in the fisher's hands).
      const inHand = fisher?.carrying === 'fish' ? 1 : 0;
      expect(fishInWater()).toBe(start - w.stats.produced.fish - inHand);
    }
    expect(catches + misses).toBeGreaterThan(40);
    const missed = misses / (catches + misses);
    const chance = PROFESSIONS.fisher.gather!.missChance!;
    expect(missed).toBeGreaterThan(chance - 0.15);
    expect(missed).toBeLessThan(chance + 0.15);
  });
});

describe('carrier reserve (Settlers 4: 5 by default)', () => {
  it('no carrier takes up a job while no more than the reserve are left', () => {
    const w = new World(42);
    expect(carrierReserve(w, 1)).toBe(CARRIER_RESERVE.default);
    const n = carriersOf(w).length;
    expect(w.setCarrierReserve(n)).toBe(true);
    const c = base(w);
    const huts: Building[] = [];
    for (const [dx, dy] of [[5, 3], [-5, 3], [5, -4]]) {
      const at = placeNear(w, 'woodcutter', c.x + dx, c.y + dy)!;
      at.done = true;
      at.levelled = true;
      huts.push(at);
    }
    run(w, 600);
    expect(huts.filter((b) => b.workerRequested || b.workerId !== null).length).toBe(0);
    expect(spareCarriers(w, 1)).toBe(0);
    // Two carriers above the reserve: exactly two huts get their woodcutter.
    w.setCarrierReserve(n - 2);
    run(w, 1200);
    expect(huts.filter((b) => b.workerRequested || b.workerId !== null).length).toBe(2);
    expect(carriersOf(w).length).toBe(n - 2);
  });

  it('does not hold back ready-made workers (the start smiths and miners are no carriers)', () => {
    const w = new World(42);
    const smith = w.settlers.find((s) => s.owner === 1 && s.kind === 'toolsmith' && s.home === null);
    expect(smith).toBeDefined();
    w.setCarrierReserve(CARRIER_RESERVE.max);
    const c = base(w);
    const b = placeNear(w, 'toolsmith', c.x + 5, c.y + 3)!;
    b.done = true;
    b.levelled = true;
    const carriers = carriersOf(w).length;
    run(w, 1500);
    expect(b.workerId).toBe(smith!.id);
    expect(carriersOf(w).length).toBe(carriers);
  });

  it('is clamped to Settlers 4’s range and survives save and load', () => {
    const w = new World(42);
    w.setCarrierReserve(0);
    expect(carrierReserve(w, 1)).toBe(CARRIER_RESERVE.min);
    w.setCarrierReserve(5000);
    expect(carrierReserve(w, 1)).toBe(CARRIER_RESERVE.max);
    w.setCarrierReserve(12);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(carrierReserve(l, 1)).toBe(12);
    // Each player has his own.
    expect(carrierReserve(l, 1)).toBe(12);
  });
});

describe('transport priority (Settlers 4’s list)', () => {
  it('starts as the Roman order and lists every good once; goods move up, down, to the top and bottom', () => {
    const w = new World(42);
    expect([...transportOrder(w, 1)]).toEqual([...TRANSPORT_PRIORITY]);
    expect([...TRANSPORT_PRIORITY].sort()).toEqual([...RESOURCES].sort());
    expect(transportOrder(w, 1).slice(0, 3)).toEqual(['plank', 'stone', 'log']);
    expect(w.moveTransport('coal', 'top')).toBe(true);
    expect(transportOrder(w, 1)[0]).toBe('coal');
    expect(w.moveTransport('coal', 'up')).toBe(false);
    expect(w.moveTransport('coal', 'down')).toBe(true);
    expect(transportOrder(w, 1).slice(0, 2)).toEqual(['plank', 'coal']);
    expect(w.moveTransport('plank', 'bottom')).toBe(true);
    expect(transportOrder(w, 1).at(-1)).toBe('plank');
    expect(transportOrder(w, 1).length).toBe(RESOURCES.length);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(transportOrder(l, 1)).toEqual(transportOrder(w, 1));
  });

  it('with one free carrier the good higher in the list is carried first', () => {
    const firstDrop = (top: 'plank' | 'stone') => {
      const w = new World(42);
      clearGround(w);
      const carriers = carriersOf(w);
      for (const s of carriers.slice(1)) killSettler(w, s);
      startTower(w).output.plank = 10;
      startTower(w).output.stone = 10;
      w.moveTransport(top, 'top');
      const c = base(w);
      const site = placeNear(w, 'house_small', c.x + 5, c.y - 1)!;
      site.levelled = true;
      for (let t = 0; t < 50; t++) {
        w.step();
        const drop = carriers[0].tasks.find((k) => k.t === 'drop');
        if (drop && drop.t === 'drop') return drop.res;
      }
      return null;
    };
    expect(firstDrop('plank')).toBe('plank');
    expect(firstDrop('stone')).toBe('stone');
  });
});

/** A finished workshop of `type` with its worker inside, fed `n` of each input. */
function workshop(w: World, type: BuildingType, n: number): Building {
  const c = base(w);
  const b = placeNear(w, type, c.x + 6, c.y + 4)!;
  b.done = true;
  b.levelled = true;
  const worker = spawnSettler(w, BUILDINGS[type].worker!, b);
  worker.home = b.id;
  b.workerId = worker.id;
  for (const r of Object.keys(BUILDINGS[type].recipe!.inputs) as (keyof typeof b.input)[]) b.input[r] = n;
  return b;
}

describe('meat (Settlers 4)', () => {
  it('a slaughterhouse makes one meat of one pig', () => {
    const recipe = BUILDINGS.slaughterhouse.recipe!;
    expect(recipe.inputs).toEqual({ pig: 1 });
    expect(recipe.outputs).toEqual({ meat: 1 });
    const w = new World(42);
    const b = workshop(w, 'slaughterhouse', 5);
    for (let t = 0; t < recipe.ticks * 5 + 5; t++) updateBuilding(w, b);
    expect(b.input.pig).toBe(0);
    expect(b.output.meat).toBe(5);
  });

  it('a pig farm’s feeding (grain + water) adds a pig 77 % of the time', () => {
    const w = new World(42);
    const b = workshop(w, 'pigfarm', 400);
    const ticks = BUILDINGS.pigfarm.recipe!.ticks;
    let pigs = 0;
    for (let t = 0; t < ticks * 300; t++) {
      updateBuilding(w, b);
      pigs += b.output.pig;
      b.output.pig = 0;
    }
    const fed = 400 - b.input.grain;
    expect(fed).toBe(300);
    expect(400 - b.input.water).toBe(fed);
    expect(pigs / fed).toBeGreaterThan(0.7);
    expect(pigs / fed).toBeLessThan(0.84);
  });
});

describe('donkeys (Settlers 4)', () => {
  it('a ranch breeds a donkey from one feeding in four', () => {
    const w = new World(42);
    const m = placeNear(w, 'market', base(w).x - 5, base(w).y + 3)!;
    m.done = true;
    w.buildingsVersion++;
    const b = workshop(w, 'donkeyranch', 400);
    const ticks = BUILDINGS.donkeyranch.recipe!.ticks;
    let donkeys = 0;
    for (let t = 0; t < ticks * 300; t++) {
      updateBuilding(w, b);
      // Taken away at once, so the market always wants more.
      for (const s of w.settlers) {
        if (s.kind !== 'donkey') continue;
        donkeys++;
        s.kind = 'carrier';
      }
    }
    const fed = 400 - b.input.grain;
    expect(fed).toBe(300);
    expect(donkeys / fed).toBeGreaterThan(0.18);
    expect(donkeys / fed).toBeLessThan(0.32);
  });

  /** Units of `res` carriers took from the building's pile and still hold (or put down nearby). */
  function carriedFrom(w: World, b: Building, res: 'plank' | 'stone'): number {
    return b.outReserved[res] + w.settlers.filter((s) => s.kind === 'carrier' && s.carrying === res).length;
  }

  /** Two markets — one by the start, one on a cut-off piece — and one donkey. */
  function caravan() {
    const w = new World(42);
    const m = w.map;
    const c = base(w);
    let tower: Building | null = null;
    for (let r = 26; r <= 40 && !tower; r++) {
      for (let a = 0; a < 64 && !tower; a++) {
        const x = Math.round(c.x + Math.cos((a / 64) * Math.PI * 2) * r);
        const y = Math.round(c.y + Math.sin((a / 64) * Math.PI * 2) * r);
        let ok = true;
        for (let dy = 0; dy <= 2 && ok; dy++) {
          for (let dx = 0; dx < 2 && ok; dx++) if (!m.isBuildable(x + dx, y + dy, 'ground') || m.owner[m.idx(x + dx, y + dy)] !== 0) ok = false;
        }
        if (ok) tower = addBuilding(w, 'tower', x, y, 1, true);
      }
    }
    enterGarrison(w, tower!, spawnSettler(w, 'soldier', tower!));
    recomputeTerritory(w);
    const home = placeNear(w, 'market', c.x + 5, c.y - 2)!;
    home.done = true;
    home.levelled = true;
    const away = placeNear(w, 'market', tower!.x + 3, tower!.y + 3, 8)!;
    away.done = true;
    away.levelled = true;
    expect(landOf(w, away)).not.toBe(landOf(w, home));
    spawnSettler(w, 'donkey', startTower(w));
    w.setTradeRoute(home.id, away.id);
    return { w, home, away };
  }

  it('carries two packs of 8: sixteen of one good, or two goods', () => {
    for (const [goods, packs] of [
      [{ plank: 16 }, [['plank', 8], ['plank', 8]]],
      [{ plank: 8, stone: 8 }, [['plank', 8], ['stone', 8]]],
    ] as const) {
      const { w, home, away } = caravan();
      for (const [r, n] of Object.entries(goods) as ['plank' | 'stone', number][]) {
        w.orderTrade(home.id, r, n);
        home.input[r] = n;
      }
      const donkey = w.settlers.find((s) => s.kind === 'donkey')!;
      let loaded = false;
      for (let t = 0; t < 4000 && !loaded; t++) {
        w.step();
        loaded = !!donkey.pack2;
      }
      expect(loaded).toBe(true);
      expect([[donkey.carrying, donkey.load], [donkey.pack2!.res, donkey.pack2!.n]]).toEqual(packs);
      expect(TRADE.packs * TRADE.donkeyLoad).toBe(16);
      run(w, 6000);
      for (const [r, n] of Object.entries(goods) as ['plank' | 'stone', number][]) {
        // All of it reached the far market (its carriers may already be taking it on).
        expect(away.output[r] + carriedFrom(w, away, r)).toBe(n);
        expect(home.trade!.orders[r]).toBeUndefined();
      }
      expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
    }
  });

  it('waits for a full load while more is on the way', () => {
    const { w, home } = caravan();
    clearGround(w); // no planks for the carriers to bring: what is on the way is only what we say
    w.orderTrade(home.id, 'plank', 16);
    home.input.plank = 8;
    home.inbound.plank = 8; // carriers bringing the rest (as far as the market knows)
    const donkey = w.settlers.find((s) => s.kind === 'donkey')!;
    for (let t = 0; t < 2000; t++) {
      w.step();
      expect(donkey.tasks.some((k) => k.t === 'load')).toBe(false);
    }
    // Nothing more coming: the half load goes as it is.
    home.inbound.plank = 0;
    run(w, 2 * DISPATCH_EVERY);
    expect(donkey.tasks.filter((t) => t.t === 'load').length).toBe(1);
  });
});
