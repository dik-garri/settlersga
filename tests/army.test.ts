import { attackStrength, defenceStrength } from '../src/sim/strength';
import { describe, expect, it } from 'vitest';
import { centerOf, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, SOLDIER_LEVELS, START_SOLDIERS } from '../src/sim/config';
import { enterGarrison, isFighter, keepOf, killSettler, maxHp } from '../src/sim/military';
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
    c.output.iron = 10;
  }
  return w;
}

const fighters = (w: World, b: Building) => b.garrison.map((id) => w.getSettler(id)!).filter(Boolean);

/** Puts a new fighter of `kind` straight into a garrison (test setup only). */
function station(w: World, b: Building, kind: 'soldier' | 'archer'): Settler {
  const s = spawnSettler(w, kind, b);
  enterGarrison(w, b, s);
  return s;
}

/** Two players, each with a finished military building of `type` built towards the other. */
function frontLine(type: 'tower' | 'bigtower' = 'tower') {
  const w = rich(new World(42, { players: 2 }));
  const [a, b] = [w.castleOf(1), w.castleOf(2)];
  const ca = centerOf(a);
  const cb = centerOf(b);
  const toward = (from: { x: number; y: number }, to: { x: number; y: number }, k: number) => ({
    x: Math.round(from.x + (to.x - from.x) * k),
    y: Math.round(from.y + (to.y - from.y) * k),
  });
  const ta = toward(ca, cb, 0.2);
  const tb = toward(cb, ca, 0.2);
  const ours = placeNear(w, type, ta.x, ta.y, 4, 1)!;
  const theirs = placeNear(w, type, tb.x, tb.y, 4, 2)!;
  expect(ours && theirs).toBeTruthy();
  run(w, 3000);
  expect(ours.done && theirs.done).toBe(true);
  return { w, ours, theirs };
}

describe('defence', () => {
  it('the castle never gives away the fighters it keeps, neither to man towers nor to attack', () => {
    const w = rich(new World(42, { players: 2 }));
    const c = w.castle;
    expect(c.garrison.length).toBe(START_SOLDIERS);
    expect(keepOf(c)).toBe(BUILDINGS.castle.garrison!.keep);
    // Many towers and no weapons: only the spares beyond `keep` may leave.
    for (const [dx, dy] of [
      [5, -4],
      [-5, -4],
      [-5, 4],
      [5, 4],
    ]) {
      placeNear(w, 'tower', c.x + dx, c.y + dy, 4);
    }
    for (let i = 0; i < 4000; i++) {
      w.step();
      expect(c.garrison.length).toBeGreaterThanOrEqual(keepOf(c));
    }
    const manned = [...w.buildings.values()].filter((b) => b.type === 'tower' && b.garrison.length > 0).length;
    expect(manned).toBe(START_SOLDIERS - keepOf(c));
    // Nothing left to send against the enemy castle from here.
    expect(w.attackerComposition(w.castleOf(2).id, 99).filter((s) => s.home === c.id)).toHaveLength(0);
  });

  it('defenders at their own door land more blows than equal attackers', () => {
    const { w, ours, theirs } = frontLine();
    // One rank-0 swordsman on each side, made unkillable so the duel lasts hundreds of blows.
    for (const extra of fighters(w, theirs).slice(1)) killSettler(w, extra);
    while (ours.garrison.length < 2) station(w, ours, 'soldier');
    w.step();
    expect(w.attack(theirs.id, 1)).toBe(1);
    const attacker = w.settlers.find((s) => s.tasks.some((t) => t.t === 'assault'))!;
    for (let i = 0; i < 600 && attacker.opponent === null; i++) w.step();
    const defender = w.getSettler(attacker.opponent!)!;
    expect(defender.owner).toBe(2);
    attacker.hp = defender.hp = 1e9;
    // Long enough for the ratio to settle (blows are random).
    run(w, 15000);
    const takenByAttacker = 1e9 - attacker.hp;
    const takenByDefender = 1e9 - defender.hp;
    // Tower defense 1.2, and fighting strength (`strength.ts`): the attacker fights on foreign land
    // at his owner's attack strength, the defender at home at his defence strength. A side lands
    // blows in proportion to its strength and each blow hurts in proportion to it too, so the
    // defender's damage dealt over the attacker's is 1.2 × (fd / fa)².
    const fa = attackStrength(w, 1) / 100;
    const fd = defenceStrength(w, 2) / 100;
    const expected = 1.2 * (fd / fa) ** 2;
    expect(takenByAttacker / takenByDefender).toBeGreaterThan(expected * 0.85);
    expect(takenByAttacker / takenByDefender).toBeLessThan(expected * 1.15);
  });
});

describe('no promotion', () => {
  it('gold in the castle no longer raises the fighters inside: a level is bought at the barracks', () => {
    const w = rich(new World(42));
    const c = w.castle;
    c.output.gold = 4;
    run(w, 1500);
    expect(fighters(w, c).every((s) => s.level === 0)).toBe(true);
    expect(c.output.gold).toBe(4);
    for (const s of fighters(w, c)) expect(s.hp).toBe(maxHp(s));
    expect(maxHp({ ...fighters(w, c)[0], level: 1 })).toBe(Math.round(100 * SOLDIER_LEVELS[1].hp));
  });
});

describe('archers', () => {
  it('a garrisoned archer shoots an approaching attacker before he reaches the door', () => {
    const { w, ours, theirs } = frontLine();
    station(w, theirs, 'archer');
    while (ours.garrison.length < 3) station(w, ours, 'soldier');
    expect(w.attack(theirs.id, 1)).toBe(1);
    const attacker = w.settlers.find((s) => s.tasks.some((t) => t.t === 'assault'))!;
    let hitAway = false;
    let shots = 0;
    for (let i = 0; i < 600 && w.getSettler(attacker.id); i++) {
      w.step();
      shots += w.shots.filter((s) => s.tick === w.tick).length;
      const d = Math.hypot(attacker.x - theirs.door.x, attacker.y - theirs.door.y);
      if (attacker.hp < maxHp(attacker) && d > 1.5) hitAway = true;
    }
    expect(shots).toBeGreaterThan(0);
    expect(hitAway).toBe(true);
  });

  it('attacking archers shoot defenders busy duelling their comrades', () => {
    const { w, ours, theirs } = frontLine('bigtower');
    while (theirs.garrison.length < 3) station(w, theirs, 'soldier');
    while (ours.garrison.length < 6) station(w, ours, ours.garrison.length % 2 ? 'archer' : 'soldier');
    const sent = w.attack(theirs.id, 4);
    expect(sent).toBe(4);
    let archerShots = 0;
    for (let i = 0; i < 1500; i++) {
      w.step();
      archerShots += w.shots.filter((s) => s.tick === w.tick && s.owner === 1).length;
    }
    expect(archerShots).toBeGreaterThan(0);
  });
});

describe('military buildings', () => {
  it('big towers and fortresses hold more fighters and claim more land than towers', () => {
    const w = rich(new World(42));
    const c = w.castle;
    for (let i = 0; i < 10; i++) station(w, c, 'soldier');
    const big = placeNear(w, 'bigtower', c.x + 7, c.y - 3, 5)!;
    const fort = placeNear(w, 'fortress', c.x - 7, c.y + 3, 6)!;
    expect(big && fort).toBeTruthy();
    run(w, 5000);
    expect(big.done && fort.done).toBe(true);
    expect(BUILDINGS.bigtower.garrison!.capacity).toBeGreaterThan(BUILDINGS.tower.garrison!.capacity);
    expect(BUILDINGS.fortress.garrison!.capacity).toBeGreaterThan(BUILDINGS.bigtower.garrison!.capacity);
    expect(big.garrison.length).toBeGreaterThan(0);
    expect(fort.garrison.length).toBeGreaterThan(0);
    // Their territory reaches further than a tower's radius.
    const owns = (b: Building, r: number) => {
      const cc = centerOf(b);
      let far = 0;
      for (let y = 0; y < w.map.h; y++) {
        for (let x = 0; x < w.map.w; x++) {
          const d = Math.hypot(x - cc.x, y - cc.y);
          if (d > BUILDINGS.tower.territory! + 0.5 && d <= r && w.map.owner[w.map.idx(x, y)] === 1) far++;
        }
      }
      return far;
    };
    expect(owns(big, BUILDINGS.bigtower.territory!)).toBeGreaterThan(0);
    expect(owns(fort, BUILDINGS.fortress.territory!)).toBeGreaterThan(0);
  });
});

describe('determinism', () => {
  function battle() {
    const { w, ours, theirs } = frontLine('bigtower');
    station(w, theirs, 'archer');
    while (ours.garrison.length < 6) station(w, ours, ours.garrison.length % 3 ? 'soldier' : 'archer');
    w.attack(theirs.id, 4);
    return w;
  }

  it('the same battle plays out identically, and after save/load mid-fight', () => {
    const a = battle();
    const b = battle();
    for (let i = 0; i < 1500 && !a.settlers.some((s) => s.opponent !== null); i++) {
      a.step();
      b.step();
    }
    expect(a.settlers.some((s) => s.opponent !== null)).toBe(true);
    expect(saveWorld(b)).toEqual(saveWorld(a));
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    run(a, 1200);
    run(l, 1200);
    expect(saveWorld(l)).toEqual(saveWorld(a));
    expect(a.settlers.filter(isFighter).length).toBeGreaterThan(0);
  });
});
