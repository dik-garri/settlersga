import { describe, expect, it } from 'vitest';
import { addBuilding, recomputeTerritory, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, PIONEER, STRENGTH } from '../src/sim/config';
import { killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { claimable } from '../src/sim/specialists';
import { attackStrength, defenceStrength, settlementValue, strengthFor } from '../src/sim/strength';
import type { Building, Settler } from '../src/sim/types';
import { World } from '../src/sim/world';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const owned = (w: World, p: number) => w.map.owner.reduce((n, o) => n + (o === p ? 1 : 0), 0);

/** A neutral tile next to the player's land, far from other players. */
function borderTile(w: World, p = 1): { x: number; y: number } {
  const m = w.map;
  const c = w.castleOf(p);
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
    const shovels = w.castle.output.shovel;
    recruit(w, 'pioneer');
    expect(w.castle.output.shovel).toBe(shovels - 1);
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
    expect(gained).toBeLessThanOrEqual(PIONEER.maxTiles);
    expect(w.pioneerLand).toBe(gained);
    // Recomputing the territory keeps the claims.
    recomputeTerritory(w);
    expect(owned(w, 1) - before).toBe(gained);
  });

  it('cannot be sent into the middle of his own land, and a military claim wins over his', () => {
    const w = new World(42, { players: 2 });
    recruit(w, 'pioneer');
    const c = w.castle;
    expect(w.sendPioneer(c.x + 1, c.y + 1)).toBe(false);
    // A claimed tile inside another player's military land goes to that player.
    const other = w.castleOf(2);
    const i = w.map.idx(other.x + 1, other.y + 4);
    w.map.claimed[i] = 1;
    w.pioneerLand++;
    recomputeTerritory(w);
    expect(w.map.owner[i]).toBe(2);
  });

  it('goes back to being a carrier when dismissed on his own land, bringing the shovel back', () => {
    const w = new World(42);
    const s = recruit(w, 'pioneer');
    run(w, 200);
    const shovels = w.castle.output.shovel;
    expect(w.dismissSpecialist('pioneer')).toBe(true);
    expect(s.kind).toBe('carrier');
    run(w, 600);
    expect(w.castle.output.shovel).toBe(shovels + 1);
  });
});

describe('thief', () => {
  /** Two players; a warehouse of player 2's, stocked, explored by player 1. */
  function target(): { w: World; store: Building; thief: Settler } {
    const w = new World(42, { players: 2 });
    const thief = recruit(w, 'thief');
    const other = w.castleOf(2);
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
    expect(w.sendThief(w.castle.id)).toBe(false); // own
    explore(w, store);
    expect(w.sendThief(store.id)).toBe(true);
  });

  it('takes goods from the other player and brings them home', () => {
    const { w, store, thief } = target();
    // Nobody to watch: the other player's guards are gone for this test.
    const other = w.castleOf(2);
    for (const id of other.garrison.slice()) killSettler(w, w.getSettler(id)!);
    explore(w, store);
    const home = w.castle.output.iron;
    expect(w.sendThief(store.id)).toBe(true);
    run(w, 6000);
    expect(store.output.iron).toBeLessThan(5);
    expect(w.castle.output.iron).toBeGreaterThan(home);
    expect(w.stats.intrudersKilled).toBe(0);
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
    const base = settlementValue(w, 1);
    const c = w.castle;
    const statue = addBuilding(w, 'statue', c.x + 6, c.y, 1, true);
    const statueCost = BUILDINGS.statue.cost;
    const plain = (statueCost.stone ?? 0) * STRENGTH.points + (statueCost.gold ?? 0) * STRENGTH.goldPoints;
    expect(settlementValue(w, 1) - base).toBe(plain * STRENGTH.eyecatcher);
    expect(statue.done).toBe(true);
  });

  it('fighters on foreign land fight at the attack strength, at home at the defence strength', () => {
    const w = new World(42, { players: 2 });
    expect(attackStrength(w, 1)).toBeLessThan(100);
    expect(defenceStrength(w, 1)).toBe(100);
    // A settlement rich enough lifts both, defence at half the pace.
    for (let k = 0; k < 40; k++) {
      const c = w.castle;
      const b = addBuilding(w, 'obelisk', c.x - 20 + (k % 8) * 2, c.y - 20 + Math.floor(k / 8) * 2, 1, true);
      expect(b).toBeTruthy();
    }
    w.step();
    const a = attackStrength(w, 1);
    expect(a).toBeGreaterThan(100);
    expect(defenceStrength(w, 1)).toBeCloseTo(100 + (a - 100) / 2, 5);
  });
});
