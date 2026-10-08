import { describe, expect, it } from 'vitest';
import { addBuilding, spawnSettler } from '../src/sim/buildings';
import { hpOf, PROFESSIONS } from '../src/sim/config';
import { fieldUnits, formationSpots, moraleOf } from '../src/sim/field';
import { enterGarrison, keepOf, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { RESOURCES, type Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, dismissStandby, startTower, vacateStart } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** A walkable tile near (x, y), where a formation of one would stand. */
function spotNear(w: World, x: number, y: number) {
  return formationSpots(w, x, y, 1)[0];
}

/** New fighters of player 1 standing in the field before the start tower's door, holding there. */
function inTheField(w: World, n: number, kind: 'soldier' | 'archer' | 'leader' = 'soldier'): Settler[] {
  const c = startTower(w);
  const made: Settler[] = [];
  for (let i = 0; i < n; i++) {
    const s = spawnSettler(w, kind, c);
    s.hp = hpOf(kind);
    s.inside = null;
    s.home = null;
    made.push(s);
  }
  expect(w.orderHold(made.map((s) => s.id))).toBe(n);
  return made;
}

describe('direct army control', () => {
  it('a building releases its spare fighters as field units, keeping its own', () => {
    const w = new World(42);
    const c = startTower(w);
    for (let i = 0; i < 6; i++) enterGarrison(w, c, spawnSettler(w, 'soldier', c));
    const before = c.garrison.length;
    const out = w.releaseFighters(c.id, 3);
    expect(out).toBe(3);
    expect(c.garrison.length).toBe(before - 3);
    expect(fieldUnits(w, 1).length).toBe(3);
    // Never below what it keeps.
    w.releaseFighters(c.id, 99);
    expect(c.garrison.length).toBeGreaterThanOrEqual(keepOf(c));
  });

  it('fighters ordered to a point stay there as field units', () => {
    const w = new World(42);
    const units = inTheField(w, 3);
    for (const s of units) expect(s.post).toBeTruthy();
    const c = startTower(w);
    const target = spotNear(w, c.door.x + 6, c.door.y + 3);
    expect(w.orderMove(units.map((s) => s.id), target.x, target.y)).toBe(3);
    run(w, 400);
    for (const s of units) {
      expect(s.inside).toBeNull();
      expect(dist(s, target)).toBeLessThan(4);
    }
    // Long after, still in the field: they do not look for a garrison by themselves.
    run(w, 1500);
    for (const s of units) expect(s.inside).toBeNull();
    expect(fieldUnits(w, 1).length).toBeGreaterThanOrEqual(3);
  });

  it('hold keeps them on their tile, garrison sends them back inside', () => {
    const w = new World(42);
    // The start tower's swordsman falls (its archers hold it) and nobody stands by: one free
    // swordsman's slot (test setup).
    dismissStandby(w);
    const t = startTower(w);
    killSettler(w, w.getSettler(t.garrison.find((id) => w.getSettler(id)!.kind === 'soldier')!)!);
    const units = inTheField(w, 2);
    const ids = units.map((s) => s.id);
    run(w, 60);
    expect(w.orderHold(ids)).toBe(2);
    for (const s of units) expect(s.post).toEqual({ x: Math.round(s.x), y: Math.round(s.y) });
    expect(w.orderGarrison(ids, null)).toBe(2);
    run(w, 400);
    // Both left the field; the start tower had a free swordsman's slot for one of them.
    for (const s of units) expect(s.post).toBeNull();
    expect(units.filter((s) => s.inside !== null).length).toBeGreaterThanOrEqual(1);
  });

  it('field swordsmen engage enemy fighters that come near', () => {
    const w = new World(42, { players: 2 });
    const mine = inTheField(w, 2);
    const c = startTower(w);
    const at = spotNear(w, c.door.x + 4, c.door.y + 4);
    w.orderMove(mine.map((s) => s.id), at.x, at.y);
    run(w, 300);
    // An enemy swordsman walks into them.
    const foe = spawnSettler(w, 'soldier', startTower(w, 2));
    foe.hp = 100;
    foe.inside = null;
    foe.x = foe.px = at.x + 2;
    foe.y = foe.py = at.y;
    foe.post = { x: at.x + 2, y: at.y };
    let fought = false;
    for (let i = 0; i < 1500 && !w.dying.has(foe.id) && w.getSettler(foe.id); i++) {
      w.step();
      if (foe.opponent !== null) fought = true;
    }
    expect(fought).toBe(true);
    // Two against one: the intruder falls.
    expect(w.getSettler(foe.id)).toBeUndefined();
  });

  it('field archers shoot enemies in range', () => {
    const w = new World(42, { players: 2 });
    const [archer] = inTheField(w, 1, 'archer');
    run(w, 100);
    const foe = spawnSettler(w, 'soldier', startTower(w, 2));
    foe.hp = 100;
    foe.inside = null;
    foe.x = foe.px = archer.x + 3;
    foe.y = foe.py = archer.y;
    foe.post = { x: Math.round(foe.x), y: Math.round(foe.y) };
    // The foe holds still (no swordsman of ours to duel): only arrows reach him.
    const shotsBefore = w.shots.length;
    let shot = false;
    for (let i = 0; i < 60; i++) {
      w.step();
      if (w.shots.length > shotsBefore) shot = true;
    }
    expect(shot).toBe(true);
    expect(foe.hp).toBeLessThan(100);
  });

  it('an attack order from the field takes an empty enemy building', () => {
    const w = new World(42, { players: 2 });
    const [s] = inTheField(w, 1);
    const c = base(w);
    // An unmanned enemy tower a few tiles away (built directly, outside player 2's land is fine here).
    let tower;
    for (let r = 6; r < 14 && !tower; r++) {
      for (let dx = -r; dx <= r && !tower; dx++) {
        const x = c.x + dx;
        const y = c.y + r;
        if (w.map.inBounds(x, y + 2) && w.map.isWalkable(x, y) && w.map.isWalkable(x + 1, y + 1)) {
          if ([0, 1].every((oy) => [0, 1].every((ox) => w.map.isBuildable(x + ox, y + oy, 'ground' as never) && w.map.building[w.map.idx(x + ox, y + oy)] === 0))) {
            tower = addBuilding(w, 'tower', x, y, 2, true);
          }
        }
      }
    }
    expect(tower).toBeDefined();
    expect(w.orderAttack([s.id], tower!.id)).toBe(1);
    run(w, 1200);
    expect(tower!.owner).toBe(1);
    expect(tower!.garrison).toContain(s.id);
    expect(s.post).toBeNull();
  });

  it('a squad leader lifts the fighters near him, and his squad follows him', () => {
    const w = new World(42);
    const [leader] = inTheField(w, 1, 'leader');
    const squad = inTheField(w, 3);
    const c = startTower(w);
    const a = spotNear(w, c.door.x + 5, c.door.y + 2);
    w.orderMove([leader.id, ...squad.map((s) => s.id)], a.x, a.y);
    run(w, 400);
    const morale = PROFESSIONS.leader.combat!.leads!.morale;
    for (const s of squad) expect(moraleOf(w, s)).toBe(morale);
    for (const s of squad) expect(s.post?.leader).toBe(leader.id);
    // Only the leader is sent on: the squad keeps its places around him.
    const b = spotNear(w, c.door.x - 5, c.door.y + 6);
    w.orderMove([leader.id], b.x, b.y);
    run(w, 600);
    expect(dist(leader, b)).toBeLessThan(2);
    for (const s of squad) expect(dist(s, leader)).toBeLessThan(5);
    // Far from any leader, no bonus.
    const [lone] = inTheField(w, 1);
    const far = spotNear(w, c.door.x + 12, c.door.y - 10);
    w.orderMove([lone.id], far.x, far.y);
    run(w, 600);
    expect(moraleOf(w, lone)).toBe(1);
  });

  it('a barracks makes a squad leader from armour and a sword', () => {
    const w = new World(42);
    // Room for a melee fighter: a free swordsman's slot in the start tower (`vacateStart`).
    const c = vacateStart(w);
    c.output.plank = 80;
    c.output.stone = 40;
    const barracks = placeNear(w, 'barracks', base(w).x + 5, base(w).y - 1)!;
    run(w, 1500);
    expect(barracks.done).toBe(true);
    w.setShare('sword', 0);
    w.setShare('bow', 0);
    w.setShare('armor', 100);
    c.output.armor = 1;
    c.output.sword = 1;
    run(w, 1200);
    expect(w.settlers.some((s) => s.kind === 'leader')).toBe(true);
    // Armour and sword both went into him.
    expect(c.output.armor + barracks.input.armor).toBe(0);
    expect(c.output.sword + barracks.input.sword).toBe(0);
  });

  it('field units survive save and load bit for bit', () => {
    const w = new World(7, { players: 2 });
    const units = inTheField(w, 3);
    const c = startTower(w);
    const t = spotNear(w, c.door.x + 6, c.door.y + 5);
    w.orderMove(units.map((s) => s.id), t.x, t.y);
    run(w, 50);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 600);
    run(l, 600);
    expect(saveWorld(l)).toEqual(saveWorld(w));
    for (const b of w.buildings.values()) for (const r of RESOURCES) expect(b.inbound[r]).toBeGreaterThanOrEqual(0);
  });
});
