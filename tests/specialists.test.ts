import { describe, expect, it } from 'vitest';
import { addBuilding, available, spawnSettler } from '../src/sim/buildings';
import { recomputeTerritory } from '../src/sim/territory';
import { BUILDINGS, GEOLOGIST, GEOLOGIST_SIGN, PIONEER, PROFESSIONS, STRENGTH } from '../src/sim/config';
import { killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { sameRegion } from '../src/sim/regions';
import { canProspect, claimable, hasSign, isFreeSpecialist, prospectable, signEnds, signLevel } from '../src/sim/specialists';
import { attackStrength, defenceStrength, settlementValue, strengthFor } from '../src/sim/strength';
import { Terrain, type Building, type Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { base, depot, groundUnits, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const owned = (w: World, p: number) => w.map.owner.reduce((n, o) => n + (o === p ? 1 : 0), 0);

/** A neutral tile next to the player's land, far from other players. */
function borderTile(w: World, p = 1): { x: number; y: number } {
  const m = w.map;
  const c = base(w, p);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!claimable(w, x, y, p)) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best!;
}

/** The player's specialist of `kind`, recruited on order. */
function recruit(w: World, kind: 'pioneer' | 'thief', p = 1): Settler {
  w.orderSpecialist(kind, 1, p);
  for (let i = 0; i < 1500 && !w.settlers.some((s) => s.owner === p && s.kind === kind); i++) w.step();
  const s = w.settlers.find((o) => o.owner === p && o.kind === kind);
  expect(s).toBeDefined();
  run(w, 50);
  return s!;
}

describe('pioneer', () => {
  it('is made from a carrier with a shovel, only as ordered', () => {
    const w = new World(42);
    run(w, 600);
    expect(w.settlers.some((s) => s.kind === 'pioneer')).toBe(false);
    // The start shovels lie on the ground by the start tower.
    const shovels = available(w, 1, 'shovel');
    recruit(w, 'pioneer');
    expect(available(w, 1, 'shovel')).toBe(shovels - 1);
  });

  it('claims neutral land next to the border, tile by tile, without a tower', () => {
    const w = new World(42);
    recruit(w, 'pioneer');
    const before = owned(w, 1);
    const t = borderTile(w);
    expect(w.sendPioneer(t.x, t.y)).toBe(true);
    run(w, 3000);
    const gained = owned(w, 1) - before;
    expect(gained).toBeGreaterThan(5);
    // Settling the territory again keeps the claims: nobody else's tower covers them.
    recomputeTerritory(w);
    expect(owned(w, 1) - before).toBe(gained);
  });

  it('keeps claiming until no neutral land is left within his reach, then stays there (Settlers 4)', () => {
    const w = new World(42);
    const s = recruit(w, 'pioneer');
    const before = owned(w, 1);
    const t = borderTile(w);
    expect(w.sendPioneer(t.x, t.y)).toBe(true);
    // At Settlers 4's pace per area (≈ 42 s a tile) he works for hours on open land.
    for (let i = 0; i < 600000 && s.errand; i++) w.step();
    expect(s.errand).toBeNull();
    // Far more than the old cap of 24 tiles an errand.
    expect(owned(w, 1) - before).toBeGreaterThan(24);
    // Nothing he could still walk to is left within his reach.
    const m = w.map;
    const at = m.idx(Math.round(s.x), Math.round(s.y));
    const r = Math.ceil(PIONEER.reach);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(s.x) + dx;
        const y = Math.round(s.y) + dy;
        if (Math.hypot(dx, dy) > PIONEER.reach || !claimable(w, x, y, 1)) continue;
        expect(sameRegion(m, at, m.idx(x, y))).toBe(false);
      }
    }
    // He stays where he finished, a pioneer, waiting for orders.
    const post = { ...s.post! };
    run(w, 1200);
    expect(s.kind).toBe('pioneer');
    expect(Math.hypot(s.x - post.x, s.y - post.y)).toBeLessThan(2);
    // Free for the next errand.
    expect(isFreeSpecialist(s)).toBe(true);
  });

  it('cannot be sent into the middle of his own land, and a military claim wins over his', () => {
    const w = new World(42, { players: 2 });
    recruit(w, 'pioneer');
    const c = base(w);
    expect(w.sendPioneer(c.x + 1, c.y + 1)).toBe(false);
    // A claimed tile (no influence of its owner's) that another player's tower covers goes to that
    // player when the territory there is settled again (Settlers 4's `SetOwner`).
    const other = base(w, 2);
    const i = w.map.idx(other.x + 1, other.y + 4);
    w.map.owner[i] = 1;
    recomputeTerritory(w);
    expect(w.map.owner[i]).toBe(2);
  });

  it('goes back to being a carrier when dismissed on his own land, his shovel put down by him', () => {
    const w = new World(42);
    const s = recruit(w, 'pioneer');
    run(w, 200);
    const shovels = available(w, 1, 'shovel');
    expect(w.dismissSpecialist('pioneer')).toBe(true);
    expect(s.kind).toBe('carrier');
    run(w, 600);
    // Settlers 4 (`CSettler::ChangeType`): the tool falls on the ground next to him, a supply again.
    expect(available(w, 1, 'shovel')).toBe(shovels + 1);
  });
});

describe('thief', () => {
  /** Two players; a warehouse of player 2's, stocked, explored by player 1. */
  function target(): { w: World; store: Building; thief: Settler } {
    const w = new World(42, { players: 2 });
    const thief = recruit(w, 'thief');
    const other = base(w, 2);
    let store: Building | null = null;
    for (let r = 6; r < 14 && !store; r++) {
      for (let dx = -r; dx <= r && !store; dx++) {
        if (w.canPlace('warehouse', other.x + dx, other.y + r, 2)) store = addBuilding(w, 'warehouse', other.x + dx, other.y + r, 2, true);
      }
    }
    expect(store).not.toBeNull();
    recomputeTerritory(w);
    store!.output.iron = 5;
    return { w, store: store!, thief };
  }

  const explore = (w: World, b: Building) => {
    w.map.explored[w.map.idx(b.door.x, b.door.y)] |= 1;
  };

  it('can only rob explored buildings of other players', () => {
    const { w, store } = target();
    expect(w.sendThief(store.id)).toBe(false); // unexplored
    expect(w.sendThief(startTower(w).id)).toBe(false); // own
    explore(w, store);
    expect(w.sendThief(store.id)).toBe(true);
  });

  it('takes goods from the other player and brings them home', () => {
    const { w, store, thief } = target();
    // Nobody to watch: the other player's fighters standing outside are gone for this test (its start
    // tower keeps its garrison, inside and out of sight of the warehouse door — a player with no
    // occupied military building would be out of the game).
    for (const s of w.settlers.filter((o) => o.owner === 2 && o.inside === null && (o.kind === 'soldier' || o.kind === 'archer'))) {
      killSettler(w, s);
    }
    explore(w, store);
    // A warehouse of his own that takes iron: where the loot goes.
    const home = depot(w, 1, undefined, ['iron']);
    expect(w.sendThief(store.id)).toBe(true);
    run(w, 6000);
    expect(store.output.iron).toBeLessThan(5);
    expect(home.output.iron).toBeGreaterThan(0);
    expect(w.stats.intrudersKilled).toBe(0);
    expect(thief.kind).toBe('thief');
  });

  it('with no warehouse at home taking the loot, puts it down on his own land as goods on the ground', () => {
    const { w, store, thief } = target();
    for (const s of w.settlers.filter((o) => o.owner === 2 && o.inside === null && (o.kind === 'soldier' || o.kind === 'archer'))) {
      killSettler(w, s);
    }
    explore(w, store);
    const before = groundUnits(w, 'iron', 1);
    expect(w.sendThief(store.id)).toBe(true);
    run(w, 6000);
    expect(store.output.iron).toBeLessThan(5);
    expect(groundUnits(w, 'iron', 1)).toBeGreaterThan(before);
    expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
    expect(thief.kind).toBe('thief');
  });

  it('is unmasked and cut down by guards standing near the building he robs', () => {
    const { w, store, thief } = target();
    explore(w, store);
    // Guards posted by the warehouse door (field units of player 2).
    const guards: number[] = [];
    for (let k = 0; k < 3; k++) {
      const g = spawnSettler(w, 'soldier', store);
      g.inside = null;
      g.hp = 100;
      guards.push(g.id);
    }
    w.orderMove(guards, store.door.x + 1, store.door.y + 1, 2);
    w.sendThief(store.id);
    run(w, 8000);
    expect(w.stats.intrudersKilled).toBe(1);
    expect(w.settlers.includes(thief)).toBe(false);
  });

  it('a thief on his errand survives save and load bit-for-bit', () => {
    const { w, store } = target();
    explore(w, store);
    w.sendThief(store.id);
    run(w, 300);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1500);
    run(l, 1500);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});

describe('fighting strength', () => {
  it('starts lower with more players and grows with the settlement value, with diminishing returns', () => {
    expect(strengthFor(0, 1)).toBe(STRENGTH.start);
    expect(strengthFor(0, 2)).toBe(STRENGTH.start - STRENGTH.perPlayer);
    expect(strengthFor(0, 99)).toBe(STRENGTH.min);
    const a = strengthFor(100, 2);
    const b = strengthFor(1000, 2);
    const c = strengthFor(10000, 2);
    expect(a).toBeGreaterThan(50);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c).toBeLessThanOrEqual(STRENGTH.max);
    // Diminishing: the next 1000 points buy less than the first.
    expect(strengthFor(2000, 2) - b).toBeLessThan(b - strengthFor(0, 2));
  });

  it('eyecatchers count several times their materials', () => {
    const w = new World(42);
    const before = settlementValue(w, 1);
    const c = base(w);
    const statue = addBuilding(w, 'statue', c.x + 6, c.y, 1, true);
    const statueCost = BUILDINGS.statue.cost;
    const plain = (statueCost.stone ?? 0) * STRENGTH.points + (statueCost.gold ?? 0) * STRENGTH.goldPoints;
    expect(settlementValue(w, 1) - before).toBe(plain * STRENGTH.eyecatcher);
    expect(statue.done).toBe(true);
  });

  it('fighters on foreign land fight at the attack strength, at home at the defence strength', () => {
    const w = new World(42, { players: 2 });
    expect(attackStrength(w, 1)).toBeLessThan(100);
    expect(defenceStrength(w, 1)).toBe(100);
    // A settlement rich enough lifts both, defence at half the pace.
    for (let k = 0; k < 40; k++) {
      const c = base(w);
      const b = addBuilding(w, 'obelisk', c.x - 20 + (k % 8) * 2, c.y - 20 + Math.floor(k / 8) * 2, 1, true);
      expect(b).toBeTruthy();
    }
    w.step();
    const a = attackStrength(w, 1);
    expect(a).toBeGreaterThan(100);
    expect(defenceStrength(w, 1)).toBeCloseTo(100 + (a - 100) / 2, 5);
  });
});

describe('geologist (Settlers 4: the whole ridge, then he stays)', () => {
  /** An ordered geologist, waiting for an errand. */
  function geologist(w: World): Settler {
    w.orderSpecialist('geologist', 1);
    for (let i = 0; i < 1500 && !w.settlers.some((s) => s.kind === 'geologist'); i++) w.step();
    run(w, 300);
    return w.settlers.find((s) => s.kind === 'geologist')!;
  }

  /** A walkable mountain tile with something to examine, owned by player 1 or not, nearest the start. */
  function mountain(w: World, own: boolean): { x: number; y: number } | null {
    const c = startTower(w);
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let y = 0; y < w.map.h; y++) {
      for (let x = 0; x < w.map.w; x++) {
        if (w.owns(x, y) !== own || !prospectable(w, x, y, 1)) continue;
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    return best;
  }

  it("puts up signs that come down after a while; what was learnt stays and the tile may be signed again", () => {
    const w = new World(123);
    const geo = geologist(w);
    const spot = mountain(w, true)!;
    expect(w.sendGeologist(spot.x, spot.y)).toBe(true);
    const m = w.map;
    let first = -1;
    for (let k = 0; k < 4000 && first < 0; k++) {
      w.step();
      first = m.signBy.findIndex((p) => p === 1);
    }
    expect(first).toBeGreaterThanOrEqual(0);
    const x = first % m.w;
    const y = Math.floor(first / m.w);
    expect(hasSign(w, first, 1)).toBe(true);
    expect(hasSign(w, first, 2)).toBe(false);
    expect(prospectable(w, x, y, 1)).toBe(false);
    expect(prospectable(w, x, y, 2)).toBe(true);
    const ends = signEnds(m, first);
    expect(ends - (m.signAt[first] - 1)).toBeGreaterThanOrEqual(GEOLOGIST_SIGN.lifetime);
    expect(ends - (m.signAt[first] - 1)).toBeLessThanOrEqual(GEOLOGIST_SIGN.lifetime + GEOLOGIST_SIGN.spread);
    // Keep him from coming back to it within this errand, then let the sign come down.
    geo.errand = null;
    geo.tasks = [];
    run(w, ends - w.tick);
    expect(hasSign(w, first, 1)).toBe(false);
    expect(w.isProspected(x, y, 1)).toBe(true);
    expect(prospectable(w, x, y, 1)).toBe(true);
    // Sent again, he puts it up anew.
    expect(w.sendGeologist(x, y)).toBe(true);
    for (let k = 0; k < 4000 && !hasSign(w, first, 1); k++) w.step();
    expect(hasSign(w, first, 1)).toBe(true);
    expect(signLevel(0)).toBe(0);
    expect(signLevel(GEOLOGIST_SIGN.levels[0] - 1)).toBe(1);
    expect(signLevel(GEOLOGIST_SIGN.levels[0])).toBe(2);
    expect(signLevel(GEOLOGIST_SIGN.levels[1])).toBe(3);
  });

  it('examines every mountain tile within his reach as he goes, then stays where he finished', () => {
    const w = new World(123);
    const geo = geologist(w);
    const spot = mountain(w, true)!;
    expect(w.sendGeologist(spot.x, spot.y)).toBe(true);
    for (let i = 0; i < 60000 && geo.errand; i++) w.step();
    expect(geo.errand).toBeNull();
    // The ridge, not just a handful of tiles around the spot (the old errand stopped at 8).
    expect(w.stats.prospected).toBeGreaterThan(40);
    // Nothing he could walk to is left unexamined within his reach.
    const m = w.map;
    const at = m.idx(Math.round(geo.x), Math.round(geo.y));
    const r = Math.ceil(GEOLOGIST.reach);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(geo.x) + dx;
        const y = Math.round(geo.y) + dy;
        if (Math.hypot(dx, dy) > GEOLOGIST.reach || !prospectable(w, x, y, 1)) continue;
        expect(sameRegion(m, at, m.idx(x, y))).toBe(false);
      }
    }
    // Some of it beyond his owner's border.
    let outside = 0;
    for (let i = 0; i < m.w * m.h; i++) if (m.prospected[i] & 1 && m.owner[i] !== 1) outside++;
    expect(outside).toBeGreaterThan(0);
    // He stays there, a geologist, instead of walking home.
    const post = { ...geo.post! };
    run(w, 1200);
    expect(geo.kind).toBe('geologist');
    expect(Math.hypot(geo.x - post.x, geo.y - post.y)).toBeLessThan(2);
    // And can be sent again from where he stands.
    const next = mountain(w, true) ?? mountain(w, false);
    if (next) {
      expect(w.sendGeologist(next.x, next.y)).toBe(true);
      expect(geo.errand).toMatchObject(next);
    }
  });

  it('may be sent to a mountain outside the border', () => {
    const w = new World(7);
    const geo = geologist(w);
    const spot = mountain(w, false)!;
    expect(spot).not.toBeNull();
    expect(w.map.terrain[w.map.idx(spot.x, spot.y)]).toBe(Terrain.Mountain);
    expect(canProspect(w, spot.x, spot.y, 1)).toBe(true);
    expect(w.sendGeologist(spot.x, spot.y)).toBe(true);
    for (let i = 0; i < 20000 && !w.isProspected(spot.x, spot.y); i++) w.step();
    expect(w.isProspected(spot.x, spot.y)).toBe(true);
    expect(geo.kind).toBe('geologist');
  });

  it('survives save and load mid-ridge bit-for-bit', () => {
    const w = new World(123);
    geologist(w);
    const spot = mountain(w, true)!;
    w.sendGeologist(spot.x, spot.y);
    run(w, 900);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1500);
    run(l, 1500);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});

describe("specialists' health (Settlers 4)", () => {
  it("geologist and pioneer 25, thief 20, on the scale of a swordsman's 100", () => {
    expect(PROFESSIONS.geologist.hp).toBe(25);
    expect(PROFESSIONS.pioneer.hp).toBe(25);
    expect(PROFESSIONS.thief.hp).toBe(20);
    const w = new World(42);
    expect(recruit(w, 'pioneer').hp).toBe(25);
  });
});
