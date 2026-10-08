import { attackStrength, defenceStrength } from '../src/sim/strength';
import { describe, expect, it } from 'vitest';
import { centerOf, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, PROFESSIONS } from '../src/sim/config';
import { enterGarrison, isFighter, keepOf, killSettler, maxHp } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import type { Building, Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** Materials and iron on every start tower's pile (test setup; a plain supply pile). */
function rich(w: World) {
  for (const p of w.players) {
    const c = startTower(w, p.id);
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
  const [a, b] = [startTower(w, 1), startTower(w, 2)];
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
  it('a military building never gives away the fighters it keeps, neither to man towers nor to attack', () => {
    const w = rich(new World(42, { players: 2 }));
    const c = startTower(w);
    // Only the start tower's own garrison: the start fighters standing by it are taken out (setup).
    for (const s of w.settlers.filter((x) => x.owner === 1 && isFighter(x) && x.home === null)) killSettler(w, s);
    w.step();
    expect(c.garrison.length).toBe(BUILDINGS.tower.garrison!.capacity);
    expect(keepOf(c)).toBe(BUILDINGS.tower.garrison!.keep);
    // Many towers and no weapons: only the spares beyond `keep` may leave.
    const o = base(w);
    for (const [dx, dy] of [
      [5, -4],
      [-5, -4],
      [-5, 4],
      [5, 4],
    ]) {
      placeNear(w, 'tower', o.x + dx, o.y + dy, 4);
    }
    for (let i = 0; i < 4000; i++) {
      w.step();
      expect(c.garrison.length).toBeGreaterThanOrEqual(keepOf(c));
    }
    const manned = [...w.buildings.values()].filter((b) => b.type === 'tower' && b.owner === 1 && b !== c && b.garrison.length > 0).length;
    expect(manned).toBe(BUILDINGS.tower.garrison!.capacity - keepOf(c));
    // Nothing left to send against the enemy start tower from here.
    expect(w.attackerComposition(startTower(w, 2).id, 99).filter((s) => s.home === c.id)).toHaveLength(0);
  });

  it('in a duel at the door both strike on their own timers, each at his fighting strength', () => {
    const { w, ours, theirs } = frontLine();
    // One level-1 swordsman on each side, made unkillable so the duel lasts hundreds of blows.
    for (const extra of fighters(w, theirs).slice(1)) killSettler(w, extra);
    while (ours.garrison.length < 2) station(w, ours, 'soldier');
    w.step();
    expect(w.attack(theirs.id, 1)).toBe(1);
    const attacker = w.settlers.find((s) => s.tasks.some((t) => t.t === 'assault'))!;
    for (let i = 0; i < 1800 && attacker.opponent === null; i++) w.step();
    const defender = w.getSettler(attacker.opponent!)!;
    expect(defender.owner).toBe(2);
    attacker.hp = defender.hp = 1e9;
    const ticks = 15000;
    run(w, ticks);
    const takenByAttacker = 1e9 - attacker.hp;
    const takenByDefender = 1e9 - defender.hp;
    // Settlers 4: every blow lands — both strike once per cadence (13 of its ticks), for the level's
    // 10 × fighting strength, rounded: the attacker on foreign land at his owner's attack strength,
    // the defender at home at his defence strength. No bonus for the building itself.
    const { every, levels } = PROFESSIONS.soldier.combat!;
    const blows = ticks / every;
    const byAttacker = Math.round(levels[0].damage * (attackStrength(w, 1) / 100));
    const byDefender = Math.round(levels[0].damage * (defenceStrength(w, 2) / 100));
    expect(byAttacker).toBeLessThan(byDefender);
    expect(Math.abs(takenByDefender / byAttacker - blows)).toBeLessThanOrEqual(1);
    expect(Math.abs(takenByAttacker / byDefender - blows)).toBeLessThanOrEqual(1);
  });
});

describe('no promotion', () => {
  it('gold at a military building does not raise the fighters inside: a level is bought at the barracks', () => {
    const w = rich(new World(42));
    const c = startTower(w);
    c.output.gold = 4;
    run(w, 1500);
    expect(fighters(w, c).every((s) => s.level === 0)).toBe(true);
    expect(c.output.gold).toBe(4);
    for (const s of fighters(w, c)) expect(s.hp).toBe(maxHp(s));
    expect(maxHp({ ...fighters(w, c)[0], level: 1 })).toBe(150);
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
    for (let i = 0; i < 1800 && w.getSettler(attacker.id); i++) {
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
    const c = startTower(w);
    // Swordsmen standing by, to man the new buildings (test setup).
    for (let i = 0; i < 10; i++) spawnSettler(w, 'soldier', c).inside = null;
    const o = base(w);
    const big = placeNear(w, 'bigtower', o.x + 7, o.y - 3, 5)!;
    const fort = placeNear(w, 'fortress', o.x - 7, o.y + 3, 6)!;
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
