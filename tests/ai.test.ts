import { describe, expect, it } from 'vitest';
import { centerOf } from '../src/sim/buildings';
import { killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { RESOURCES } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

const MINUTE = 600;
const LONG = 120_000; // these runs simulate up to an hour of game time

function run(w: World, ticks: number, each?: () => void) {
  for (let i = 0; i < ticks; i++) {
    w.step();
    each?.();
  }
}

const ownBuildings = (w: World, p: number) => [...w.buildings.values()].filter((b) => b.owner === p);
const soldiers = (w: World, p: number) => w.settlers.filter((s) => s.owner === p && s.kind === 'soldier');

describe('computer player', () => {
  it('builds up an economy and expands', { timeout: LONG }, () => {
    const w = new World(42, { players: 2, ai: [2] });
    const startSettlers = w.settlers.filter((s) => s.owner === 2).length;
    const startLand = w.map.owner.filter((o) => o === 2).length;
    run(w, 15 * MINUTE);
    const own = ownBuildings(w, 2);
    expect(own.filter((b) => b.done).length).toBeGreaterThanOrEqual(20);
    expect(own.filter((b) => b.done && b.garrison.length > 0 && b.type !== 'castle').length).toBeGreaterThanOrEqual(1);
    expect(w.settlers.filter((s) => s.owner === 2).length).toBeGreaterThan(startSettlers);
    expect(w.map.owner.filter((o) => o === 2).length).toBeGreaterThan(startLand);
    // The human did nothing and was left alone.
    expect(ownBuildings(w, 1).length).toBe(1);
  });

  it('only acts through player commands and never spends what it does not have', { timeout: LONG }, () => {
    const w = new World(42, { players: 2, ai: [2] });
    const placed = new Set<number>();
    const place = w.placeBuilding.bind(w);
    w.placeBuilding = (type, x, y, player) => {
      const b = place(type, x, y, player);
      if (b && player === 2) placed.add(b.id);
      return b;
    };
    const castle = w.castleOf(2).id;
    const negative: string[] = [];
    run(w, 20 * MINUTE, () => {
      for (const b of w.buildings.values()) {
        if (b.owner !== 2) continue;
        for (const r of RESOURCES) {
          if (b.output[r] < 0 || b.input[r] < 0 || b.inbound[r] < 0 || b.outReserved[r] > b.output[r]) {
            negative.push(`${w.tick} ${b.type} ${r}`);
          }
        }
      }
    });
    expect(negative.slice(0, 3)).toEqual([]);
    // Every building it owns came out of placeBuilding (or is its castle).
    for (const b of ownBuildings(w, 2)) expect(b.id === castle || placed.has(b.id), b.type).toBe(true);
  });

  it('eventually attacks a passive player and takes the castle', { timeout: LONG }, () => {
    const w = new World(7, { players: 2, ai: [2] });
    for (let i = 0; i < 45 * MINUTE && !w.isDefeated(1); i++) w.step();
    const ai = w.ai.find((a) => a.player === 2)!;
    expect(ai.stats.attacks).toBeGreaterThanOrEqual(1);
    expect(w.isDefeated(1)).toBe(true);
    expect(w.outcome(1)).toBe('lost');
    expect(w.outcome(2)).toBe('won');
    // Not before the peace time is over.
    expect(w.tick).toBeGreaterThanOrEqual(25 * MINUTE);
  });
});

describe('victory and defeat', () => {
  /** Player 2's castle left without soldiers, a manned tower of player 1 within attack range. */
  function undefendedCastle() {
    const w = new World(42, { players: 2 });
    const [a, b] = [w.castleOf(1), w.castleOf(2)];
    a.output.plank = 80;
    a.output.stone = 40;
    a.output.sword = 6;
    for (const s of soldiers(w, 2)) killSettler(w, s);
    w.step();
    const ca = centerOf(a);
    const cb = centerOf(b);
    // Two hops towards the enemy, each tower inside the land the previous one claimed.
    let tower = null;
    for (const k of [0.2, 0.38]) {
      const t = { x: Math.round(ca.x + (cb.x - ca.x) * k), y: Math.round(ca.y + (cb.y - ca.y) * k) };
      tower = placeNear(w, 'tower', t.x, t.y, 5, 1)!;
      expect(tower).toBeTruthy();
      run(w, 3000);
      expect(tower.done && tower.garrison.length).toBeTruthy();
    }
    expect(w.availableAttackers(b.id)).toBeGreaterThan(0);
    return { w, castle: b };
  }

  it('taking a castle defeats its owner: settlers die, buildings burn, the other player wins', { timeout: LONG }, () => {
    const { w, castle } = undefendedCastle();
    expect(w.outcome(1)).toBe('playing');
    expect(w.attack(castle.id, 1)).toBe(1);
    run(w, 1500);
    expect(castle.owner).toBe(1);
    expect(w.isDefeated(2)).toBe(true);
    expect(w.outcome(2)).toBe('lost');
    expect(w.outcome(1)).toBe('won');
    expect(w.settlers.some((s) => s.owner === 2)).toBe(false);
    expect(ownBuildings(w, 2)).toEqual([]);
    expect(w.map.owner.some((o) => o === 2)).toBe(false);
    // No dangling references to the dead.
    for (const b of w.buildings.values()) {
      for (const id of b.garrison) expect(w.getSettler(id)).toBeDefined();
      if (b.workerId !== null) expect(w.getSettler(b.workerId)).toBeDefined();
    }
    run(w, 600); // the game keeps running after the end
  });
});

describe('determinism', () => {
  it('a computer game saved and loaded mid-way continues identically', { timeout: LONG }, () => {
    const w = new World(42, { players: 2, ai: [1, 2] });
    run(w, 8 * MINUTE);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 4 * MINUTE);
    run(l, 4 * MINUTE);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });

  it('the same seed plays out the same game', { timeout: LONG }, () => {
    const a = new World(9, { players: 2, ai: [1, 2] });
    const b = new World(9, { players: 2, ai: [1, 2] });
    run(a, 6 * MINUTE);
    run(b, 6 * MINUTE);
    expect(saveWorld(b)).toEqual(saveWorld(a));
  });
});
