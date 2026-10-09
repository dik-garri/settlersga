/**
 * Garrisons as in Settlers 4 (`CMilitaryBuildingRole`, docs/S4-AUDIT.md item 1): a military building
 * calls one free fighter unless told otherwise; «fill», «withdraw» and −/+ set how many; fighters
 * never move between buildings by themselves. Tower archers (item 5).
 */
import { describe, expect, it } from 'vitest';
import { addBuilding, claimsTerritory, spawnSettler } from '../src/sim/buildings';
import { GARRISON_ORDERS, PROFESSIONS } from '../src/sim/config';
import { formationSpots } from '../src/sim/field';
import { sameRegion } from '../src/sim/regions';
import { enterGarrison, garrisonCounts, isArcher, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import type { Building, Settler, SettlerKind } from '../src/sim/types';
import { World } from '../src/sim/world';
import { dismissStandby, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A finished, empty tower of player `p` on free ground of its land about `r` tiles from its start tower. */
function newTower(w: World, p = 1, r = 6): Building {
  const c = startTower(w, p);
  for (let d = r; d < r + 8; d++) {
    for (let a = 0; a < 32; a++) {
      const x = Math.round(c.x + Math.cos((a / 32) * Math.PI * 2) * d);
      const y = Math.round(c.y + Math.sin((a / 32) * Math.PI * 2) * d);
      if (w.canPlace('tower', x, y, p)) return addBuilding(w, 'tower', x, y, p, true);
    }
  }
  throw new Error('no room for a tower');
}

/** A free fighter of player `p` standing on the tile nearest (x, y) he can walk from to his start tower (test setup). */
function freeAt(w: World, kind: SettlerKind, x: number, y: number, level = 0, p = 1): Settler {
  const s = spawnSettler(w, kind, startTower(w, p));
  const m = w.map;
  const home = m.idx(startTower(w, p).door.x, startTower(w, p).door.y);
  const at = formationSpots(w, x, y, 25).find((q) => sameRegion(m, m.idx(q.x, q.y), home))!;
  s.inside = null;
  s.level = level;
  s.x = s.px = at.x;
  s.y = s.py = at.y;
  return s;
}

const inside = (w: World, b: Building) => b.garrison.map((id) => w.getSettler(id)!).filter(Boolean);

describe('garrisons (Settlers 4)', () => {
  it('a finished empty tower calls one free fighter: a swordsman when there is one, else an archer', () => {
    const w = new World(42);
    const t = newTower(w);
    expect(t.wish).toBeUndefined();
    run(w, 600);
    // The start fighters stand free by the start tower: one swordsman comes, nobody else.
    expect(inside(w, t).map((s) => s.kind)).toEqual(['soldier']);
    expect(t.wish).toEqual({ melee: 1, ranged: 0 });
    expect(claimsTerritory(t)).toBe(true);
    // With only archers free, an archer.
    const u = newTower(w, 1, 9);
    for (const s of w.settlers.filter((q) => q.owner === 1 && q.kind === 'soldier' && q.home === null)) killSettler(w, s);
    run(w, 600);
    expect(inside(w, u).map((s) => s.kind)).toEqual(['archer']);
    expect(u.wish).toEqual({ melee: 0, ranged: 1 });
  });

  it('fill calls fighters for every slot; withdraw keeps one, the rest step out one at a time and stand by it', () => {
    const w = new World(42);
    const t = newTower(w);
    run(w, 300);
    expect(w.fillGarrison(t.id)).toBe(true);
    expect(t.wish).toEqual({ melee: 1, ranged: 2 });
    run(w, 600);
    const c = garrisonCounts(w, t);
    expect([c.melee, c.ranged]).toEqual([1, 2]);
    expect(w.withdrawGarrison(t.id)).toBe(true);
    expect(t.wish).toEqual({ melee: 1, ranged: 0 });
    // One per call of the building (every GARRISON_ORDERS.every ticks), not all at once.
    let before = t.garrison.length;
    for (let i = 0; i < 300; i++) {
      w.step();
      expect(before - t.garrison.length).toBeLessThanOrEqual(1);
      before = t.garrison.length;
    }
    expect(GARRISON_ORDERS.every).toBe(11);
    expect(inside(w, t).map((s) => s.kind)).toEqual(['soldier']);
    // Those who stepped out stand free by it.
    const out = w.settlers.filter((s) => s.kind === 'archer' && s.home === null && Math.hypot(s.x - t.door.x, s.y - t.door.y) < 5);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('− and + per kind: never below one fighter in all, never above the slots', () => {
    const w = new World(42);
    const t = newTower(w);
    run(w, 300);
    expect(t.wish).toEqual({ melee: 1, ranged: 0 });
    // The last swordsman may not go while no archer is wished and inside.
    expect(w.changeGarrison(t.id, false, -1)).toBe(false);
    expect(w.changeGarrison(t.id, true, 1)).toBe(true);
    expect(w.changeGarrison(t.id, true, 1)).toBe(true);
    expect(w.changeGarrison(t.id, true, 1)).toBe(false);
    expect(t.wish).toEqual({ melee: 1, ranged: 2 });
    run(w, 600);
    expect(garrisonCounts(w, t).ranged).toBe(2);
    // Archers inside now: the swordsman may go.
    expect(w.changeGarrison(t.id, false, -1)).toBe(true);
    expect(t.wish).toEqual({ melee: 0, ranged: 2 });
    run(w, 300);
    expect(inside(w, t).every(isArcher)).toBe(true);
    expect(w.changeGarrison(t.id, true, -1)).toBe(true);
    expect(w.changeGarrison(t.id, true, -1)).toBe(false);
    // Not someone else's building.
    expect(w.fillGarrison(t.id, 2)).toBe(false);
  });

  it('the highest level first, within the rings round its door; nobody from further away', () => {
    const w = new World(42);
    dismissStandby(w);
    const t = newTower(w);
    const d = t.door;
    // Two swordsmen near, the level-2 one a little further; a level-3 one beyond the last ring.
    const near = freeAt(w, 'soldier', d.x + 2, d.y + 1);
    const better = freeAt(w, 'soldier', d.x + 3, d.y + 2, 1);
    const far = GARRISON_ORDERS.rings[GARRISON_ORDERS.rings.length - 1] + 2;
    const best = w.map.inBounds(Math.round(d.x + far), d.y) ? freeAt(w, 'soldier', Math.round(d.x + far), d.y, 2) : undefined;
    run(w, 400);
    expect(t.garrison).toEqual([better.id]);
    w.fillGarrison(t.id);
    run(w, 400);
    expect(t.garrison).toEqual([better.id]);
    expect(near.home).toBeNull();
    if (best) expect(best.home).toBeNull();
    // With nobody free in reach the tower stays as it is and its owner is warned.
    const empty = newTower(w, 1, 9);
    killSettler(w, near);
    run(w, 400);
    expect(empty.garrison).toHaveLength(0);
    expect(claimsTerritory(empty)).toBe(false);
    expect(w.warnings.some((m) => m.kind === 'noFighter' && m.b === empty.id)).toBe(true);
  });

  it('a fighter sent in by hand raises the wish; one beyond it waits while an enemy is near', () => {
    const w = new World(42, { players: 2 });
    const t = newTower(w);
    run(w, 300);
    const free = w.settlers.filter((s) => s.owner === 1 && s.kind === 'archer' && s.home === null);
    expect(w.orderGarrison([free[0].id], t.id)).toBe(1);
    expect(t.wish).toEqual({ melee: 1, ranged: 1 });
    run(w, 400);
    expect(garrisonCounts(w, t).ranged).toBe(1);
    // An enemy fighter at the door: the archer wished away stays inside.
    expect(w.changeGarrison(t.id, true, -1)).toBe(true);
    const foe = freeAt(w, 'soldier', t.door.x + 1, t.door.y + 1, 0, 2);
    foe.hp = 1e9;
    foe.post = { x: Math.round(foe.x), y: Math.round(foe.y) };
    run(w, 200);
    expect(garrisonCounts(w, t).ranged).toBe(1);
    killSettler(w, foe);
    run(w, 200);
    expect(garrisonCounts(w, t).ranged).toBe(0);
  });

  it('fighters never leave one building to man another', () => {
    const w = new World(42);
    const c = startTower(w);
    w.fillGarrison(c.id);
    run(w, 600);
    expect(c.garrison.length).toBe(3);
    dismissStandby(w);
    const t = newTower(w);
    run(w, 1200);
    expect(c.garrison.length).toBe(3);
    expect(t.garrison).toHaveLength(0);
  });

  it('wishes and the fighters on their way survive save and load bit for bit', () => {
    const w = new World(42);
    const t = newTower(w);
    w.fillGarrison(t.id);
    for (let i = 0; i < 100 && t.garrisonInbound === 0; i++) w.step();
    expect(t.garrisonInbound).toBeGreaterThan(0);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(l.buildings.get(t.id)!.wish).toEqual(t.wish);
    run(w, 600);
    run(l, 600);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});

describe('tower archers (Settlers 4: 20 of its tiles, only on their side\'s land or nobody\'s)', () => {
  /** Player 1's tower with one archer inside, and an enemy swordsman `d` tiles south of its door. */
  function setup(d: number) {
    const w = new World(42, { players: 2 });
    dismissStandby(w, 1);
    dismissStandby(w, 2);
    const t = startTower(w, 1);
    enterGarrison(w, t, spawnSettler(w, 'archer', t));
    const foe = freeAt(w, 'soldier', t.door.x, t.door.y + d, 0, 2);
    foe.post = { x: Math.round(foe.x), y: Math.round(foe.y) };
    foe.hp = 1e6;
    return { w, t, foe };
  }

  it('shoots an enemy 6 tiles off on its own land, but not one 8 tiles off', () => {
    const range = PROFESSIONS.archer.combat!.ranged!;
    expect(range.towerRange).toBeCloseTo(20 / 3);
    expect(range.range).toBe(3);
    const near = setup(6);
    run(near.w, 100);
    expect(near.foe.hp).toBeLessThan(1e6);
    const far = setup(8);
    run(far.w, 100);
    expect(far.foe.hp).toBe(1e6);
  });

  it('does not shoot an enemy standing on his own side\'s land', () => {
    const { w, t, foe } = setup(5);
    const i = w.map.idx(Math.round(foe.x), Math.round(foe.y));
    // That tile is the enemy's (test setup: as if his land reached it).
    w.map.owner[i] = 2;
    run(w, 100);
    expect(foe.hp).toBe(1e6);
    w.map.owner[i] = 0;
    run(w, 100);
    expect(foe.hp).toBeLessThan(1e6);
    expect(t.garrison.length).toBeGreaterThan(0);
  });
});
