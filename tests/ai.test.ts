import { describe, expect, it } from 'vitest';
import { knownEnemies } from '../src/sim/ai';
import { AI, AI_PLAN, BUILDINGS, oreOf } from '../src/sim/config';
import { centerOf, spawnSettler } from '../src/sim/buildings';
import { enterGarrison, isFighter, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { RESOURCES } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { groundUnits, startTower } from './helpers';

const MINUTE = 600;
const LONG = 120_000; // these runs simulate up to an hour of game time

function run(w: World, ticks: number, each?: () => void) {
  for (let i = 0; i < ticks; i++) {
    w.step();
    each?.();
  }
}

const ownBuildings = (w: World, p: number) => [...w.buildings.values()].filter((b) => b.owner === p);
const fighters = (w: World, p: number) => w.settlers.filter((s) => s.owner === p && isFighter(s));

describe('computer player', () => {
  it('builds up an economy and expands', { timeout: LONG }, () => {
    const w = new World(42, { players: 2, ai: [2] });
    const startSettlers = w.settlers.filter((s) => s.owner === 2).length;
    const startLand = w.map.owner.filter((o) => o === 2).length;
    // Settlers 4's walking pace and costs, and its pioneer claiming at S4's pace per area (≈ 42 s a
    // tile): about 23 minutes to its twentieth building (18 while he claimed a tile every 6 s).
    run(w, 27 * MINUTE);
    const own = ownBuildings(w, 2);
    expect(own.filter((b) => b.done).length).toBeGreaterThanOrEqual(20);
    const start = startTower(w, 2).id;
    expect(own.filter((b) => b.done && b.garrison.length > 0 && b.id !== start).length).toBeGreaterThanOrEqual(1);
    // No headquarters: it builds a warehouse of its own and ticks the goods it takes in.
    const store = own.find((b) => b.done && BUILDINGS[b.type].storage);
    expect(store).toBeDefined();
    expect(store!.accept?.length).toBe(RESOURCES.length);
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
    const start = startTower(w, 2).id;
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
    // Every building it owns came out of placeBuilding (or is its start tower).
    for (const b of ownBuildings(w, 2)) expect(b.id === start || placed.has(b.id), b.type).toBe(true);
  });

  it('eventually attacks a passive player and defeats it', { timeout: LONG }, () => {
    const w = new World(7, { players: 2, ai: [2] });
    // Every target it picks is one player 2 has explored.
    const unseen: string[] = [];
    const attack = w.attack.bind(w);
    w.attack = (target, count, player) => {
      const b = w.buildings.get(target);
      if (player === 2 && b && !w.isExplored(b.door.x, b.door.y, 2)) unseen.push(`${w.tick} ${b.type}`);
      return attack(target, count, player);
    };
    // Settlers 4's production times, walking pace and costs (docs/TIMINGS.md): it takes the last
    // occupied tower of the passive player (Settlers 4's defeat rule) after about 75 minutes.
    for (let i = 0; i < 100 * MINUTE && !w.isDefeated(1); i++) w.step();
    expect(unseen).toEqual([]);
    const ai = w.ai.find((a) => a.player === 2)!;
    expect(ai.stats.attacks).toBeGreaterThanOrEqual(1);
    expect(w.isDefeated(1)).toBe(true);
    expect(w.outcome(1)).toBe('lost');
    expect(w.outcome(2)).toBe('won');
    // Not before the peace time is over.
    expect(w.tick).toBeGreaterThanOrEqual(25 * MINUTE);
  });
});

describe('fog of war', () => {
  it('knows only enemy buildings it has explored, and guesses garrisons out of sight', () => {
    const w = new World(42, { players: 2, ai: [2] });
    const enemy = startTower(w, 1);
    expect(w.isExplored(enemy.door.x, enemy.door.y, 2)).toBe(false);
    expect(knownEnemies(w, 2)).toEqual([]);
    // Explored once (e.g. by a passing settler) but out of building sight: the garrison is a guess,
    // even though it is in fact empty.
    for (const s of fighters(w, 1)) killSettler(w, s);
    w.step();
    w.map.explored[w.map.idx(enemy.door.x, enemy.door.y)] |= 1 << 1;
    const known = knownEnemies(w, 2);
    expect(known.map((k) => k.b.id)).toEqual([enemy.id]);
    expect(enemy.garrison.length).toBe(0);
    expect(known[0].defenders).toBe(Math.ceil(BUILDINGS.tower.garrison!.capacity * AI.unseenGarrison));
  });

  it('prospects for gold, mines and smelts it, and promotes its soldiers', { timeout: LONG }, () => {
    // Every start has a guaranteed gold lobe just beyond its start land (`START_GUARANTEES`).
    const w = new World(42, { size: 96, players: 2, ai: [2] });
    let ranked = 0;
    // With Settlers 4's production times, walking pace and costs its first ranked fighter comes after
    // about 99 minutes (about 90 with S4 footprints, once its 3×3 barracks gets room).
    for (let i = 0; i < 120 * MINUTE && ranked === 0; i++) {
      w.step();
      if (i % 100 === 0) ranked = w.settlers.filter((s) => s.owner === 2 && s.kind !== 'carrier' && s.level > 0).length;
    }
    expect(ranked).toBeGreaterThan(0);
    expect(w.stats.produced.gold).toBeGreaterThan(0);
    expect(ownBuildings(w, 2).some((b) => b.type === 'goldmine' && b.done)).toBe(true);
    expect(w.ai[0].stats.geologists).toBeGreaterThan(0);
  });

  it('scouts towards unexplored land while it knows no enemy', { timeout: LONG }, () => {
    const w = new World(42, { players: 2, ai: [2] });
    const explored = () => w.map.explored.filter((e) => e & 2).length;
    const start = explored();
    run(w, 20 * MINUTE);
    expect(explored()).toBeGreaterThan(start * 1.5);
    expect(ownBuildings(w, 1).length).toBe(1);
  });

  it('finds the enemy start tower (towers, lookouts, pioneers, scouts)', { timeout: LONG }, () => {
    const w = new World(42, { players: 2, ai: [2] });
    const enemy = startTower(w, 1);
    let found = -1;
    for (let t = 0; t < 100 * MINUTE && found < 0; t++) {
      w.step();
      if (t % 100 === 0 && knownEnemies(w, 2).some((e) => e.b === enemy)) found = t;
    }
    expect(found).toBeGreaterThan(0);
    // Without lookouts it never finds it on this map (its towers stop ~25 tiles short). Since 2.5
    // the guaranteed far mountains draw its first towers elsewhere: ~41 minutes (31 before); with
    // Settlers 4's production times (docs/TIMINGS.md) ~79; with S4 footprints (the old 4×4 castle, 15×15
    // start meadow) ~122 while its pioneer was stuck on an unreachable tile, ~75 since that is fixed;
    // since its towers hold one fighter unless filled (Settlers 4) its towers alone reach it, ~34.
    expect(found).toBeLessThan(88 * MINUTE);
  });
});

describe('victory and defeat', () => {
  /**
   * Player 2's start tower held by one feeble swordsman (its last occupied military building), a
   * manned tower of player 1 with spares within attack range.
   */
  function lastTower() {
    const w = new World(42, { players: 2 });
    const [a, b] = [startTower(w, 1), startTower(w, 2)];
    // Goods at home for the towers (a pile at the start tower's door).
    a.output.plank = 80;
    a.output.stone = 40;
    // Extra swordsmen without a garrison: they man the new towers (test setup; in play they come from a barracks).
    for (let k = 0; k < 6; k++) spawnSettler(w, 'soldier', a).inside = null;
    const keep = fighters(w, 2).find((s) => s.kind === 'soldier' && s.home === b.id)!;
    for (const s of fighters(w, 2)) if (s !== keep) killSettler(w, s);
    keep.hp = 1;
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
    // A small tower holds one swordsman and keeps him: put spares in (test setup).
    for (let k = 0; k < 2; k++) enterGarrison(w, tower!, spawnSettler(w, 'soldier', tower!));
    expect(w.availableAttackers(b.id)).toBeGreaterThan(0);
    return { w, last: b };
  }

  it('a player whose last occupied military building is taken is out: buildings burn, its people wander off and die', { timeout: LONG }, () => {
    const { w, last } = lastTower();
    expect(w.outcome(1)).toBe('playing');
    expect(w.attack(last.id, 2)).toBe(2);
    for (let i = 0; i < 3000 && !w.isDefeated(2); i++) w.step();
    expect(last.owner).toBe(1);
    expect(w.isDefeated(2)).toBe(true);
    expect(w.outcome(2)).toBe('lost');
    expect(w.outcome(1)).toBe('won');
    expect(ownBuildings(w, 2)).toEqual([]);
    expect(w.map.owner.some((o) => o === 2)).toBe(false);
    // Settlers 4: its people are not struck dead at once; they wander for a while, then die.
    run(w, 20);
    expect(w.settlers.some((s) => s.owner === 2)).toBe(true);
    for (let i = 0; i < 6000 && w.settlers.some((s) => s.owner === 2); i++) w.step();
    expect(w.settlers.some((s) => s.owner === 2)).toBe(false);
    // Its start goods lie on land that is now player 1's: they are player 1's.
    expect(groundUnits(w, 'plank', 2)).toBe(0);
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

describe('AI ore prospecting', () => {
  it('looks for the ore of the first mine in its plan it cannot place, not the last one', () => {
    const w = new World(42, { players: 2, ai: [2] });
    // Let it build up to the toolsmith, so the later mines of the plan (gold, stone…) are in play.
    for (let t = 0; t < 45 * MINUTE; t++) w.step();
    const own = () => [...w.buildings.values()].filter((b) => b.owner === 2);
    expect(own().some((b) => b.type === 'toolsmith' && b.done)).toBe(true);
    // Then coal, gold and stone run out everywhere and its coal mines are gone.
    for (let i = 0; i < w.map.ore.length; i++) {
      const res = oreOf(w.map.ore[i]);
      if (res === 'coal' || res === 'goldore' || res === 'stone') w.map.oreAmount[i] = 0;
    }
    for (const b of own()) if (b.type === 'coalmine') w.demolish(b.id, 2);
    // Materials to pay for a mine, so only the missing ore holds it up (test setup).
    startTower(w, 2).output.plank += 20;
    startTower(w, 2).output.stone += 20;
    for (let t = 0; t < 5 * MINUTE; t++) w.step();
    const firstMine = AI_PLAN.find((s) => BUILDINGS[s.type].mine)!;
    expect(w.ai[0].wantOre).toBe(BUILDINGS[firstMine.type].mine!.res);
  }, LONG);
});
