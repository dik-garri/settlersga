import { describe, expect, it } from 'vitest';
import { knownEnemies } from '../src/sim/ai';
import { centerOf, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, FOG, PROFESSIONS, SOLDIER_LEVELS } from '../src/sim/config';
import { enterGarrison, isArcher, killSettler, maxHp, slotsFree } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import type { Building, Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function rich(w: World) {
  for (const p of w.players) {
    const c = w.castleOf(p.id);
    c.output.plank = 120;
    c.output.stone = 80;
  }
  return w;
}

function station(w: World, b: Building, kind: 'soldier' | 'archer'): Settler {
  const s = spawnSettler(w, kind, b);
  enterGarrison(w, b, s);
  return s;
}

const members = (w: World, b: Building) => b.garrison.map((id) => w.getSettler(id)!).filter(Boolean);

/** A finished barracks next to the castle. */
function withBarracks(w = rich(new World(42))) {
  const c = w.castle;
  const barracks = placeNear(w, 'barracks', c.x + 5, c.y - 1)!;
  run(w, 1500);
  expect(barracks.done).toBe(true);
  return { w, c, barracks };
}

/** Two players with a tower each, built towards the other. */
function frontLine(w = rich(new World(42, { players: 2 }))) {
  const [a, b] = [w.castleOf(1), w.castleOf(2)];
  const ca = centerOf(a);
  const cb = centerOf(b);
  const at = (from: typeof ca, to: typeof cb) => ({
    x: Math.round(from.x + (to.x - from.x) * 0.2),
    y: Math.round(from.y + (to.y - from.y) * 0.2),
  });
  const ours = placeNear(w, 'tower', at(ca, cb).x, at(ca, cb).y, 4, 1)!;
  const theirs = placeNear(w, 'tower', at(cb, ca).x, at(cb, ca).y, 4, 2)!;
  run(w, 3000);
  expect(ours.done && theirs.done).toBe(true);
  return { w, ours, theirs };
}

describe('recruit levels (bought at the barracks, as in Settlers 4)', () => {
  it('a recruit leaves at the ordered level and pays its gold; short of gold, at what the gold pays for', () => {
    const { w, c, barracks } = withBarracks();
    expect(w.setRecruitLevel(2)).toBe(true);
    expect(w.recruitLevel()).toBe(2);
    expect(w.setRecruitLevel(SOLDIER_LEVELS.length)).toBe(false);
    c.output.gold = 3; // two for the first recruit (level 3), one left: the second leaves at level 2
    c.output.sword = 1;
    c.output.bow = 1;
    run(w, 1500);
    const trained = w.settlers.filter((s) => (s.kind === 'soldier' || s.kind === 'archer') && s.level > 0);
    expect(trained.map((s) => s.level).sort()).toEqual([1, 2]);
    for (const s of trained) expect(maxHp(s)).toBe(PROFESSIONS[s.kind].combat!.levels[s.level].hp);
    expect(c.output.gold + barracks.input.gold + barracks.inbound.gold).toBe(0);
    // Levels never change afterwards.
    c.output.gold = 5;
    run(w, 1500);
    expect(trained.map((s) => s.level).sort()).toEqual([1, 2]);
  });

  it('at level 1 the barracks asks for no gold', () => {
    const { w, c, barracks } = withBarracks();
    c.output.gold = 2;
    c.output.sword = 1;
    run(w, 1200);
    expect(barracks.input.gold).toBe(0);
    expect(w.settlers.filter((s) => s.kind === 'soldier').every((s) => s.level === 0)).toBe(true);
  });

  it('the order survives save and load', () => {
    const { w, c } = withBarracks();
    w.setRecruitLevel(1);
    c.output.gold = 2;
    c.output.sword = 1;
    run(w, 200);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(l.recruitLevel()).toBe(1);
    run(w, 1000);
    run(l, 1000);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});

describe('garrison slots by kind', () => {
  it('a small tower takes one swordsman and two archers, never more swordsmen', () => {
    const w = rich(new World(42));
    const c = w.castle;
    for (let i = 0; i < 4; i++) station(w, c, 'archer');
    const tower = placeNear(w, 'tower', c.x + 6, c.y - 4, 5)!;
    run(w, 3000);
    expect(tower.done).toBe(true);
    const inside = members(w, tower);
    expect(inside.filter((s) => !isArcher(s))).toHaveLength(1);
    expect(inside.filter(isArcher)).toHaveLength(2);
    expect(slotsFree(w, tower, false)).toBe(0);
    expect(slotsFree(w, tower, true)).toBe(0);
    expect(BUILDINGS.tower.garrison!.capacity).toBe(3);
    expect(BUILDINGS.bigtower.garrison).toMatchObject({ capacity: 6, archers: 3 });
    expect(BUILDINGS.fortress.garrison).toMatchObject({ capacity: 9, archers: 5 });
  });
});

describe('capture', () => {
  it('archers cannot take a building: they fight, then look for a garrison of their own', () => {
    const { w, ours, theirs } = frontLine();
    for (const s of members(w, theirs)) killSettler(w, s);
    for (const s of w.settlers.filter((x) => x.owner === 2 && (x.kind === 'soldier' || x.kind === 'archer'))) killSettler(w, s);
    w.step();
    expect(theirs.garrison).toHaveLength(0);
    // Only archers in our tower: the swordsman leaves, three archers hold it.
    for (let i = 0; i < 3; i++) station(w, ours, 'archer');
    for (const s of members(w, ours)) if (!isArcher(s)) killSettler(w, s);
    w.step();
    const sent = w.attack(theirs.id, 9);
    expect(sent).toBeGreaterThan(0);
    const party = w.settlers.filter((s) => s.tasks.some((t) => t.t === 'assault'));
    expect(party.every(isArcher)).toBe(true);
    run(w, 1500);
    expect(theirs.owner).toBe(2);
    // The archers went back to a garrison of ours.
    for (const s of party) expect(s.home === null || w.buildings.get(s.home)!.owner === 1).toBe(true);
    // A swordsman takes it.
    station(w, ours, 'soldier');
    station(w, ours, 'soldier');
    expect(w.attack(theirs.id, 1)).toBe(1);
    run(w, 1500);
    expect(theirs.owner).toBe(1);
  });
});

describe('infirmary', () => {
  it('wounded fighters heal only in an infirmary, then go back to a garrison', () => {
    const w = rich(new World(42));
    const c = w.castle;
    const wounded = members(w, c).slice(0, 2);
    for (const s of wounded) s.hp = 10;
    run(w, 600);
    // No infirmary: nobody heals, nobody leaves.
    for (const s of wounded) expect(s.hp).toBe(10);
    const inf = placeNear(w, 'infirmary', c.x + 5, c.y + 3)!;
    let wasInBed = false;
    for (let i = 0; i < 8000 && (!inf.done || wounded.some((s) => s.hp < maxHp(s))); i++) {
      w.step();
      if (wounded.some((s) => s.inside === inf.id)) wasInBed = true;
    }
    expect(inf.done).toBe(true);
    expect(wasInBed).toBe(true);
    for (const s of wounded) expect(s.hp).toBe(maxHp(s));
    run(w, 600);
    for (const s of wounded) expect(s.home).not.toBeNull();
    expect(c.garrison.length).toBeGreaterThanOrEqual(BUILDINGS.castle.garrison!.keep!);
  });

  it('a stay in the infirmary continues identically after save and load', () => {
    const w = rich(new World(42));
    const c = w.castle;
    const inf = placeNear(w, 'infirmary', c.x + 5, c.y + 3)!;
    run(w, 2000);
    expect(inf.done).toBe(true);
    members(w, c)[0].hp = 5;
    for (let i = 0; i < 2000 && !w.settlers.some((s) => s.inside === inf.id); i++) w.step();
    expect(w.settlers.some((s) => s.inside === inf.id)).toBe(true);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 800);
    run(l, 800);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});

describe('lookout tower', () => {
  it('sees far, claims no land and holds nobody', () => {
    const w = rich(new World(42));
    const c = w.castle;
    const look = placeNear(w, 'lookout', c.x + 7, c.y, 5)!;
    run(w, 2000);
    expect(look.done).toBe(true);
    expect(look.garrison).toHaveLength(0);
    expect(BUILDINGS.lookout.territory).toBeUndefined();
    const cc = centerOf(look);
    const r = BUILDINGS.lookout.vision!;
    expect(r).toBeGreaterThan(FOG.buildingRadius);
    // A tile at its full sight range is seen (inside the map).
    const far = [
      [cc.x + r - 1, cc.y],
      [cc.x - r + 1, cc.y],
      [cc.x, cc.y + r - 1],
      [cc.x, cc.y - r + 1],
    ].find(([x, y]) => w.map.inBounds(Math.round(x), Math.round(y)))!;
    expect(w.isVisible(Math.round(far[0]), Math.round(far[1]))).toBe(true);
  });
});

describe('teams', () => {
  it('allies cannot attack each other and win together', () => {
    const w = rich(new World(42, { players: 3, teams: [1, 1, 2] }));
    expect(w.allied(1, 2)).toBe(true);
    expect(w.allied(1, 3)).toBe(false);
    for (let i = 0; i < 4; i++) station(w, w.castle, 'soldier');
    expect(w.attack(w.castleOf(2).id, 5)).toBe(0);
    expect(w.availableAttackers(w.castleOf(2).id)).toBe(0);
    expect(knownEnemies(w, 1).some((e) => e.b.owner === 2)).toBe(false);
    w.defeatPlayer(3);
    expect(w.outcome(1)).toBe('won');
    expect(w.outcome(2)).toBe('won');
    expect(w.outcome(3)).toBe('lost');
  });

  it('without teams every player is on its own', () => {
    const w = new World(42, { players: 3 });
    expect(w.allied(1, 2)).toBe(false);
    w.defeatPlayer(3);
    expect(w.outcome(1)).toBe('playing');
  });
});
