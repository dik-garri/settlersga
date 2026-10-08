import { describe, expect, it, vi } from 'vitest';
import { spawnSettler } from '../src/sim/buildings';
import { duelWorth, hitDamage, maxHp } from '../src/sim/combat';
import { hpOf, PROFESSIONS, TICKS_PER_SECOND } from '../src/sim/config';
import { formationSpots } from '../src/sim/field';
import { enterGarrison, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import type { PlayerId, Settler, SettlerKind } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

// Fighting strength is tested in army.test.ts; here it is pinned (100 % unless a test sets it) so the
// numbers are Settlers 4's unit stats as they are.
const ctl = vi.hoisted(() => ({ factor: 1 as number | null }));
vi.mock('../src/sim/strength', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/sim/strength')>();
  return { ...orig, fieldFactor: (w: World, s: Settler) => ctl.factor ?? orig.fieldFactor(w, s) };
});

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** A fighter of `owner` standing in the field at (x, y), holding there (`post`). */
function fighter(w: World, owner: PlayerId, kind: SettlerKind, level: number, x: number, y: number): Settler {
  const s = spawnSettler(w, kind, w.castleOf(owner));
  s.level = level;
  s.hp = hpOf(kind, level);
  s.inside = null;
  s.x = s.px = x;
  s.y = s.py = y;
  s.post = { x, y };
  return s;
}

/** Two fighters of players 1 and 2 side by side in the open; returns them and where they stand. */
function pair(w: World, a: [SettlerKind, number], b: [SettlerKind, number]) {
  const c = w.castle;
  const [p, q] = formationSpots(w, c.door.x + 6, c.door.y + 4, 2);
  return { one: fighter(w, 1, a[0], a[1], p.x, p.y), two: fighter(w, 2, b[0], b[1], q.x, q.y) };
}

/** Steps until one of them dies; the duel's length in seconds from the moment they paired, and the winner. */
function fight(w: World, one: Settler, two: Settler) {
  let start = -1;
  for (let i = 0; i < 3000; i++) {
    w.step();
    if (start < 0 && one.opponent === two.id && two.opponent === one.id) start = w.tick;
    const gone = (s: Settler) => !w.getSettler(s.id);
    if (gone(one) || gone(two)) {
      return { seconds: (w.tick - start) / TICKS_PER_SECOND, winner: gone(one) ? two : one };
    }
  }
  throw new Error('no outcome');
}

describe('duels as in Settlers 4', () => {
  it('an even duel of level-1 swordsmen lasts about 9 s, and either may win', () => {
    ctl.factor = 1;
    const winners = { one: 0, two: 0 };
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const w = new World(seed, { players: 2, size: 64 });
      const { one, two } = pair(w, ['soldier', 0], ['soldier', 0]);
      const { seconds, winner } = fight(w, one, two);
      // 100 hp at 10 a blow: ten blows, one every 13 of S4's ticks (0.92 s) — the tenth lands after
      // 8.3 s plus the random start of the winner's rhythm.
      expect(seconds).toBeGreaterThan(8);
      expect(seconds).toBeLessThan(9.8);
      // The winner took nine blows at most.
      expect(winner.hp).toBeGreaterThanOrEqual(10);
      winners[winner === one ? 'one' : 'two']++;
    }
    // Who strikes first is random per duel, not decided by ids or by who runs the duel.
    expect(winners.one).toBeGreaterThan(0);
    expect(winners.two).toBeGreaterThan(0);
  });

  it('a level-3 swordsman beats a level-1 one, losing at most a few blows', () => {
    ctl.factor = 1;
    for (const seed of [1, 2, 3]) {
      const w = new World(seed, { players: 2, size: 64 });
      const { one, two } = pair(w, ['soldier', 0], ['soldier', 2]);
      const { winner } = fight(w, one, two);
      expect(winner).toBe(two);
      // 100 hp at 20 a blow is five blows; the level-1 man lands at most five of his 10 meanwhile.
      expect(maxHp(two) - two.hp).toBeLessThanOrEqual(50);
      expect(maxHp(two)).toBe(210);
    }
  });

  it('damage is the level’s × fighting strength, rounded, at least 1; a squad leader’s armour takes 2 off', () => {
    const w = new World(42, { players: 2, size: 64 });
    const { one: sword, two: leader } = pair(w, ['soldier', 0], ['leader', 0]);
    const archer = fighter(w, 1, 'archer', 0, sword.x, sword.y);
    const enemy = fighter(w, 2, 'soldier', 0, leader.x, leader.y);
    ctl.factor = 1;
    expect(hitDamage(w, sword, enemy)).toBe(10);
    expect(hitDamage(w, sword, leader)).toBe(8);
    expect(hitDamage(w, archer, enemy)).toBe(4);
    expect(hitDamage(w, archer, leader)).toBe(2);
    expect(hitDamage(w, leader, sword)).toBe(21);
    ctl.factor = 0.55;
    expect(hitDamage(w, sword, enemy)).toBe(6); // 5.5 rounds up
    ctl.factor = 0.25;
    expect(hitDamage(w, archer, enemy)).toBe(1);
    expect(hitDamage(w, archer, leader)).toBe(1); // never below 1
    ctl.factor = 1;
    // A leader of one's own close by: +10 % (exactly one point on 10).
    const ally = fighter(w, 2, 'soldier', 0, leader.x, leader.y);
    expect(hitDamage(w, ally, sword)).toBe(11);
    expect(PROFESSIONS.leader.combat!.leads!.morale).toBeCloseTo(1.1);
  });

  it('a tower archer hits harder, hardest at enemies at its door', () => {
    ctl.factor = 1;
    const w = new World(42, { players: 2, size: 64 });
    const tower = placeNear(w, 'tower', w.castle.x + 6, w.castle.y + 2, 4, 1)!;
    run(w, 3000);
    expect(tower.done).toBe(true);
    const archer = spawnSettler(w, 'archer', tower);
    enterGarrison(w, tower, archer);
    archer.reload = 0;
    // Enemies coming for the tower: one at the door, one further off, alone in range.
    for (const [d, expected] of [
      [0, 4 + 2],
      [4, 4 + 1],
    ] as const) {
      const foe = fighter(w, 2, 'soldier', 0, tower.door.x + d, tower.door.y);
      foe.post = null;
      // He stands where he is, counted as an assailant of the tower.
      foe.tasks = [
        { t: 'wait', n: 1000 },
        { t: 'assault', b: tower.id, n: 0 },
      ];
      const before = foe.hp;
      for (let i = 0; i < 40 && foe.hp === before; i++) w.step();
      expect(before - foe.hp).toBe(expected);
      killSettler(w, foe);
      w.step();
    }
  });

  it('the AI weighs a fighter by hit points × damage per second', () => {
    expect(duelWorth('soldier', 0)).toBeCloseTo(1);
    expect(duelWorth('soldier', 0, 0.5)).toBeCloseTo(0.5);
    expect(duelWorth('soldier', 2)).toBeCloseTo(4.2);
    expect(duelWorth('leader', 2)).toBeCloseTo((215 * 21) / 1000);
    expect(duelWorth('archer', 0)).toBeLessThan(0.25);
  });

  it('a duel continues identically after save and load', () => {
    ctl.factor = 1;
    const w = new World(7, { players: 2, size: 64 });
    const { one, two } = pair(w, ['soldier', 1], ['soldier', 1]);
    for (let i = 0; i < 400 && !(one.opponent === two.id && one.hp < maxHp(one)); i++) w.step();
    expect(one.opponent).toBe(two.id);
    const copy = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    for (let i = 0; i < 150; i++) {
      w.step();
      copy.step();
    }
    expect(JSON.stringify(saveWorld(copy))).toBe(JSON.stringify(saveWorld(w)));
  });
});
