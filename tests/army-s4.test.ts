import { describe, expect, it } from 'vitest';
import { knownEnemies } from '../src/sim/ai';
import { addBuilding, centerOf, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, FOG, PROFESSIONS, SOLDIER_LEVELS } from '../src/sim/config';
import { enterGarrison, isArcher, isFighter, killSettler, maxHp, slotsFree } from '../src/sim/military';
import { ENDLESS } from '../src/sim/economy';
import { saveWorld } from '../src/sim/save';
import type { Building, Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, dismissStandby, startTower } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** Materials on every start tower's pile (test setup; a plain supply pile). */
function rich(w: World) {
  for (const p of w.players) {
    const c = startTower(w, p.id);
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

/** A finished barracks next to the start tower; the start fighters standing by are gone (`dismissStandby`). */
function withBarracks(w = rich(new World(42))) {
  const c = startTower(w);
  dismissStandby(w);
  const barracks = placeNear(w, 'barracks', base(w).x + 5, base(w).y - 1)!;
  run(w, 1500);
  expect(barracks.done).toBe(true);
  return { w, c, barracks };
}

/** Two players with a tower each, built towards the other. */
function frontLine(w = rich(new World(42, { players: 2 }))) {
  const [a, b] = [startTower(w, 1), startTower(w, 2)];
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
  it('a recruit leaves at the ordered level and pays its gold; levels never change', () => {
    const { w, c, barracks } = withBarracks();
    expect(SOLDIER_LEVELS.map((l) => l.cost)).toEqual([0, 1, 2]);
    w.orderRecruits('soldier', 2, 1);
    w.orderRecruits('archer', 1, 1);
    c.output.gold = 3;
    c.output.sword = 1;
    c.output.bow = 1;
    run(w, 2500);
    const trained = w.settlers.filter((s) => (s.kind === 'soldier' || s.kind === 'archer') && s.level > 0);
    expect(trained.map((s) => `${s.kind}${s.level}`).sort()).toEqual(['archer1', 'soldier2']);
    for (const s of trained) expect(maxHp(s)).toBe(PROFESSIONS[s.kind].combat!.levels[s.level].hp);
    expect(c.output.gold + barracks.input.gold + barracks.inbound.gold).toBe(0);
    c.output.gold = 5;
    run(w, 1500);
    expect(trained.map((s) => s.level).sort()).toEqual([1, 2]);
  });

  it('short of gold for the higher level, the lower one ordered is made instead', () => {
    const { w, barracks } = withBarracks();
    barracks.input.sword = 2;
    barracks.input.gold = 1;
    w.orderRecruits('soldier', 0, ENDLESS);
    w.orderRecruits('soldier', 2, ENDLESS);
    run(w, 1500);
    // Two gold for level 3 never came: both are level 1, the gold stays.
    const made = w.settlers.filter((s) => s.kind === 'soldier' && s.home === null && s.level === 0);
    expect(made.length).toBeGreaterThanOrEqual(2);
    expect(w.settlers.some((s) => s.kind === 'soldier' && s.level === 2)).toBe(false);
    expect(barracks.input.gold).toBe(1);
  });

  it('the squad leader costs armour, a sword and 3 gold, and goes first (Settlers 4)', () => {
    const { w, barracks } = withBarracks();
    expect(PROFESSIONS.leader.kit).toEqual({ sword: 1, gold: 3 });
    barracks.input.armor = 1;
    barracks.input.sword = 2;
    barracks.input.gold = 2;
    w.orderRecruits('leader', 0, 1);
    w.orderRecruits('soldier', 0, 1);
    run(w, 900);
    // Two gold do not pay for him: the swordsman is made, the leader waits.
    expect(w.settlers.filter((s) => s.kind === 'leader')).toHaveLength(0);
    expect(w.recruitOrder('soldier', 0)).toBe(0);
    barracks.input.gold = 3;
    run(w, 900);
    const leader = w.settlers.find((s) => s.kind === 'leader')!;
    expect(leader).toBeDefined();
    expect(barracks.input.armor + barracks.input.sword + barracks.input.gold).toBe(0);
  });
});

describe('garrison slots by kind', () => {
  it('filled, a small tower takes one swordsman and two archers, never more swordsmen', () => {
    const w = rich(new World(42));
    const c = startTower(w);
    // Archers standing by besides the start swordsmen (test setup).
    for (let i = 0; i < 4; i++) spawnSettler(w, 'archer', c).inside = null;
    const tower = placeNear(w, 'tower', base(w).x + 6, base(w).y - 4, 5)!;
    run(w, 3000);
    expect(tower.done).toBe(true);
    expect(w.fillGarrison(tower.id)).toBe(true);
    expect(tower.wish).toEqual({ melee: 1, ranged: 2 });
    run(w, 600);
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

describe('capture (Settlers 4)', () => {
  /** Player 2 left with its start tower's swordsman only: their tower out front stands empty. */
  function emptyEnemy() {
    const { w, ours, theirs } = frontLine();
    const keeper = startTower(w, 2).garrison[0];
    for (const s of w.settlers.filter((x) => x.owner === 2 && isFighter(x) && x.id !== keeper)) killSettler(w, s);
    w.step();
    expect(theirs.garrison).toHaveLength(0);
    return { w, ours, theirs };
  }

  it('an archer takes an empty building like a swordsman, alone', () => {
    const { w, ours, theirs } = emptyEnemy();
    dismissStandby(w, 1);
    // Only archers in our tower: three hold it, its swordsman is gone.
    for (let i = 0; i < 3; i++) station(w, ours, 'archer');
    for (const s of members(w, ours)) if (!isArcher(s)) killSettler(w, s);
    w.step();
    const sent = w.attack(theirs.id, 2);
    expect(sent).toBe(2);
    const party = w.settlers.filter((s) => s.tasks.some((t) => t.t === 'assault'));
    expect(party.every(isArcher)).toBe(true);
    run(w, 1500);
    expect(theirs.owner).toBe(1);
    // One went in; the other stays outside, free.
    expect(theirs.garrison).toHaveLength(1);
    expect(theirs.wish).toEqual({ melee: 0, ranged: 1 });
    const out = party.filter((s) => !theirs.garrison.includes(s.id));
    expect(out).toHaveLength(1);
    expect(out[0].home).toBeNull();
  });

  it('the squad leader neither takes a building nor goes into one', () => {
    const { w, ours, theirs } = emptyEnemy();
    expect(PROFESSIONS.leader.combat!.captures).toBeFalsy();
    const leader = spawnSettler(w, 'leader', ours);
    leader.inside = null;
    expect(w.orderAttack([leader.id], theirs.id)).toBe(1);
    run(w, 1500);
    expect(theirs.owner).toBe(2);
    expect(leader.home).toBeNull();
    // Nor sent in by hand.
    expect(w.orderGarrison([leader.id], ours.id)).toBe(0);
    expect(ours.garrison.includes(leader.id)).toBe(false);
  });

  it('attackers first break the door of a held building', () => {
    const { w, ours, theirs } = frontLine();
    const door = BUILDINGS.tower.garrison!.door!;
    expect(door.hp).toBe(50);
    for (let i = 0; i < 3; i++) station(w, ours, 'soldier');
    expect(theirs.garrison.length).toBeGreaterThan(0);
    w.attack(theirs.id, 2);
    let broken = false;
    let calledOut = false;
    for (let i = 0; i < 1500 && !calledOut; i++) {
      w.step();
      if ((theirs.doorHp ?? door.hp) === 0) broken = true;
      if (w.settlers.some((s) => s.owner === 2 && s.opponent !== null && s.home === theirs.id)) {
        calledOut = true;
        // Nobody was called out before the door fell.
        expect(broken).toBe(true);
      }
    }
    expect(broken).toBe(true);
  });
});

describe('infirmary (Settlers 4 healer\'s hut)', () => {
  /** A finished infirmary near the start with its healer inside (test setup). */
  function infirmary(w: World): Building {
    const at = base(w);
    for (let d = 3; d < 12; d++) {
      for (let y = at.y - d; y <= at.y + d; y++) {
        for (let x = at.x + 4 - d; x <= at.x + 4 + d; x++) {
          if (!w.canPlace('infirmary', x, y)) continue;
          const b = addBuilding(w, 'infirmary', x, y, 1, true);
          const h = spawnSettler(w, 'healer', b);
          h.home = b.id;
          b.workerId = h.id;
          return b;
        }
      }
    }
    throw new Error('no room');
  }

  /** A wounded free archer standing idle `d` tiles from the infirmary's door. */
  function woundedOutside(w: World, b: Building, dx: number): Settler {
    const s = spawnSettler(w, 'archer', startTower(w));
    s.inside = null;
    s.x = s.px = b.door.x + dx;
    s.y = s.py = b.door.y + 1;
    s.hp = 10;
    return s;
  }

  it('calls wounded free fighters in its area to its door one at a time and heals them; never from a tower', () => {
    const w = rich(new World(42));
    const c = startTower(w);
    dismissStandby(w);
    const inf = infirmary(w);
    const inTower = station(w, c, 'archer');
    inTower.hp = 10;
    const out = [woundedOutside(w, inf, 2), woundedOutside(w, inf, -2)];
    // Too far: outside its work area.
    const far = woundedOutside(w, inf, BUILDINGS.infirmary.infirmary!.radius + 4);
    let together = 0;
    for (let i = 0; i < 6000 && out.some((s) => s.hp < maxHp(s)); i++) {
      w.step();
      const patients = w.settlers.filter((s) => s.tasks.some((t) => t.t === 'heal'));
      together = Math.max(together, patients.length);
      if (inf.patient !== undefined) expect(patients.map((s) => s.id)).toEqual([inf.patient]);
    }
    for (const s of out) expect(s.hp).toBe(maxHp(s));
    expect(together).toBe(1);
    // Healed at the door, standing there (free fighters stay where they are).
    expect(out.some((s) => Math.hypot(s.x - inf.door.x, s.y - inf.door.y) <= 1)).toBe(true);
    // The tower's archer stays in his tower, wounded; the one far off is not called.
    expect(inTower.hp).toBe(10);
    expect(inTower.inside).toBe(c.id);
    expect(far.hp).toBe(10);
  });

  it('heals nobody without its healer inside', () => {
    const w = rich(new World(42));
    dismissStandby(w);
    const inf = infirmary(w);
    const healer = w.getSettler(inf.workerId)!;
    healer.inside = null;
    healer.x = healer.px = inf.door.x + 6;
    healer.tasks = [{ t: 'wait', n: 5000 }];
    const s = woundedOutside(w, inf, 2);
    run(w, 1500);
    expect(s.hp).toBe(10);
    expect(inf.patient).toBeUndefined();
  });

  it('a stay at the infirmary continues identically after save and load', () => {
    const w = rich(new World(42));
    dismissStandby(w);
    const inf = infirmary(w);
    woundedOutside(w, inf, 3).hp = 5;
    for (let i = 0; i < 2000 && !w.settlers.some((s) => s.tasks[0]?.t === 'heal'); i++) w.step();
    expect(w.settlers.some((s) => s.tasks[0]?.t === 'heal')).toBe(true);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 800);
    run(l, 800);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});

describe('lookout tower', () => {
  it('sees far once built, claims no land, holds nobody; its occupant is a watchman', () => {
    const w = rich(new World(42));
    const c = base(w);
    const look = placeNear(w, 'lookout', c.x + 7, c.y, 5)!;
    run(w, 2500);
    expect(look.done).toBe(true);
    expect(look.garrison).toHaveLength(0);
    expect(BUILDINGS.lookout.territory).toBeUndefined();
    expect(BUILDINGS.lookout.worker).toBe('watchman');
    expect(w.getSettler(look.workerId)?.kind).toBe('watchman');
    const cc = centerOf(look);
    const r = BUILDINGS.lookout.vision!;
    expect(r).toBeGreaterThan(BUILDINGS.tower.territory! + FOG.landBand);
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
    for (let i = 0; i < 4; i++) station(w, startTower(w), 'soldier');
    expect(w.attack(startTower(w, 2).id, 5)).toBe(0);
    expect(w.availableAttackers(startTower(w, 2).id)).toBe(0);
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
