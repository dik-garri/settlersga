import { describe, expect, it } from 'vitest';
import { centerOf, spawnSettler } from '../src/sim/buildings';
import { START_SOLDIERS } from '../src/sim/config';
import { enterGarrison, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { RESOURCES, type Building } from '../src/sim/types';
import { startPositions, World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function rich(w: World) {
  for (const p of w.players) {
    const c = w.castleOf(p.id);
    c.output.plank = 80;
    c.output.stone = 40;
  }
  return w;
}

const soldiersOf = (w: World, player: number) => w.settlers.filter((s) => s.owner === player && s.kind === 'soldier');

/** No reference anywhere points at a settler that no longer exists. */
function expectConsistent(w: World) {
  expect(w.settlerById.size).toBe(w.settlers.length);
  for (const s of w.settlers) {
    expect(w.settlerById.get(s.id)).toBe(s);
    if (s.opponent !== null) expect(w.getSettler(s.opponent)?.opponent).toBe(s.id);
  }
  for (const b of w.buildings.values()) {
    for (const id of b.garrison) expect(w.getSettler(id)?.home).toBe(b.id);
    if (b.workerId !== null) expect(w.getSettler(b.workerId)).toBeDefined();
    if (b.builderId !== null) expect(w.getSettler(b.builderId)).toBeDefined();
    expect(b.garrisonInbound).toBeGreaterThanOrEqual(0);
    for (const r of RESOURCES) expect(b.inbound[r]).toBeGreaterThanOrEqual(0);
  }
}

/**
 * Two players with a tower each, built towards the other; player 2 may be left without spare soldiers.
 * `spares`: extra swordsmen put straight into our tower (a small tower keeps its one swordsman).
 */
function frontier(opts: { enemySoldiers?: number; swords?: number; spares?: number } = {}) {
  const w = rich(new World(42, { players: 2 }));
  const [a, b] = [w.castleOf(1), w.castleOf(2)];
  if (opts.enemySoldiers !== undefined) {
    for (const s of soldiersOf(w, 2).slice(opts.enemySoldiers)) killSettler(w, s);
    w.step();
  }
  // Extra swordsmen in the castle (test setup; in play they come from a barracks).
  for (let k = 0; k < (opts.swords ?? 0); k++) enterGarrison(w, a, spawnSettler(w, 'soldier', a));
  const ca = centerOf(a);
  const cb = centerOf(b);
  const toward = (from: { x: number; y: number }, to: { x: number; y: number }, k: number) => ({
    x: Math.round(from.x + (to.x - from.x) * k),
    y: Math.round(from.y + (to.y - from.y) * k),
  });
  const ta = toward(ca, cb, 0.2);
  const tb = toward(cb, ca, 0.2);
  const ours = placeNear(w, 'tower', ta.x, ta.y, 4, 1)!;
  const theirs = placeNear(w, 'tower', tb.x, tb.y, 4, 2)!;
  expect(ours && theirs).toBeTruthy();
  run(w, 2500);
  expect(ours.done && theirs.done).toBe(true);
  for (let k = 0; k < (opts.spares ?? 0); k++) enterGarrison(w, ours, spawnSettler(w, 'soldier', ours));
  return { w, ours, theirs };
}

describe('players', () => {
  it('two players start far apart with their own castle, settlers and land', () => {
    const w = new World(42, { players: 2 });
    const [p1, p2] = startPositions(64, 2);
    expect(Math.hypot(p1.x - p2.x, p1.y - p2.y)).toBeGreaterThan(30);
    expect(w.castleOf(1).owner).toBe(1);
    expect(w.castleOf(2).owner).toBe(2);
    expect(soldiersOf(w, 2).length).toBe(START_SOLDIERS);
    const c2 = w.castleOf(2);
    expect(w.map.owner[w.map.idx(c2.x, c2.y)]).toBe(2);
    run(w, 600);
    expectConsistent(w);
  });
});

describe('military economy', () => {
  it('the weaponsmith forges the weapons garrisons wait for from iron and coal', () => {
    const w = rich(new World(42));
    const c = w.castle;
    const smith = placeNear(w, 'weaponsmith', c.x + 5, c.y - 1)!;
    run(w, 1500);
    expect(smith.done).toBe(true);
    c.output.iron = 2;
    c.output.coal = 2;
    run(w, 1500);
    // The castle's empty archer slots ask for bows first.
    expect(w.stats.produced.bow).toBe(2);
    expect(w.stats.produced.sword).toBe(0);
  });

  it('weapons alone recruit nobody: new fighters come only from a barracks', () => {
    const w = rich(new World(42));
    const c = w.castle;
    c.output.sword = 2;
    run(w, 600);
    expect(soldiersOf(w, 1).length).toBe(START_SOLDIERS);
    expect(c.output.sword).toBe(2);
  });

  it('a barracks trains carriers with its weapons into fighters who join a garrison', () => {
    const w = rich(new World(42));
    const c = w.castle;
    const barracks = placeNear(w, 'barracks', c.x + 5, c.y - 1)!;
    run(w, 1500);
    expect(barracks.done).toBe(true);
    const carriers = w.settlers.filter((s) => s.kind === 'carrier').length;
    // The castle has one free swordsman's slot and five archers' slots.
    c.output.sword = 1;
    c.output.bow = 1;
    run(w, 900);
    expect(soldiersOf(w, 1).length).toBe(START_SOLDIERS + 1);
    expect(w.settlers.filter((s) => s.kind === 'archer')).toHaveLength(1);
    expect(c.garrison.length).toBe(START_SOLDIERS + 2);
    expect(c.output.sword + barracks.input.sword + c.output.bow + barracks.input.bow).toBe(0);
    expect(w.stats.trained).toBe(2);
    expect(w.settlers.filter((s) => s.kind === 'carrier').length).toBe(carriers - 2);
    expectConsistent(w);
  });

  it('the weaponsmith follows the player sword/bow shares', () => {
    for (const [bow, sword] of [
      [100, 0],
      [0, 100],
    ]) {
      const w = rich(new World(42));
      const c = w.castle;
      w.setShare('bow', bow);
      w.setShare('sword', sword);
      expect(w.shareOf('bow')).toBe(bow);
      const smith = placeNear(w, 'weaponsmith', c.x + 5, c.y - 1)!;
      run(w, 1500);
      expect(smith.done).toBe(true);
      c.output.iron = 3;
      c.output.coal = 3;
      run(w, 2000);
      expect(w.stats.produced.bow).toBe(bow ? 3 : 0);
      expect(w.stats.produced.sword).toBe(sword ? 3 : 0);
    }
    // Only weapons have shares, and they stay within 0..100.
    const w = new World(42);
    w.setShare('plank', 50);
    expect(w.shareOf('plank')).toBe(0);
    w.setShare('bow', 250);
    expect(w.shareOf('bow')).toBe(100);
  });
});

describe('barracks', () => {
  /** A finished barracks next to the castle and how many fighters the castle still has room for. */
  function withBarracks() {
    const w = rich(new World(42));
    const c = w.castle;
    const barracks = placeNear(w, 'barracks', c.x + 5, c.y - 1)!;
    run(w, 1500);
    expect(barracks.done).toBe(true);
    return { w, c, barracks };
  }

  it('trains nobody while every garrison is full, and resumes when room frees up', () => {
    const { w, c, barracks } = withBarracks();
    // Every slot taken: 7 swordsmen and 5 archers.
    while (c.garrison.length < 7) enterGarrison(w, c, spawnSettler(w, 'soldier', c));
    while (c.garrison.length < 12) enterGarrison(w, c, spawnSettler(w, 'archer', c));
    c.output.sword = 2;
    run(w, 900);
    expect(w.stats.trained).toBe(0);
    expect(barracks.workerId).toBeNull();
    expect(c.output.sword + barracks.input.sword).toBe(2);
    killSettler(w, soldiersOf(w, 1)[0]);
    run(w, 900);
    expect(w.stats.trained).toBe(1);
    expect(c.garrison.length).toBe(12);
    expectConsistent(w);
  });

  it('a barracks picks the weapon its player is shortest of', () => {
    const { w, c, barracks } = withBarracks();
    w.setShare('sword', 0);
    w.setShare('bow', 100);
    c.output.sword = 1;
    c.output.bow = 1;
    run(w, 900);
    // The first recruit takes the bow (the army has no archers yet, the share wants only archers).
    const archers = w.settlers.filter((s) => s.kind === 'archer').length;
    expect(archers).toBeGreaterThanOrEqual(1);
    expect(w.stats.trained).toBe(2);
    expect(barracks.input.sword + barracks.input.bow).toBe(0);
  });

  it('training continues identically after save and load', () => {
    const { w, c, barracks } = withBarracks();
    c.output.sword = 1;
    c.output.bow = 1;
    for (let i = 0; i < 1500 && !(barracks.timer > 0); i++) w.step();
    expect(barracks.timer).toBeGreaterThan(0);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 600);
    run(l, 600);
    expect(saveWorld(l)).toEqual(saveWorld(w));
    expect(w.stats.trained).toBe(2);
  });
});

describe('combat', () => {
  it('an undefended enemy tower is taken: ownership and land change hands, enemy civil buildings there burn', () => {
    const { w, ours, theirs } = frontier({ enemySoldiers: 1, spares: 1 });
    expect(theirs.garrison.length).toBe(0); // nobody to spare from their castle
    // An enemy hut on land that only their tower would hold.
    const lumber = placeNear(w, 'woodcutter', theirs.x, theirs.y, 6, 2);
    expect(ours.garrison.length).toBeGreaterThan(0);

    expect(w.availableAttackers(theirs.id)).toBeGreaterThan(0);
    expect(w.attack(theirs.id, 1)).toBe(1);
    run(w, 600);
    expect(theirs.owner).toBe(1);
    expect(theirs.garrison.length).toBe(1);
    expect(w.map.owner[w.map.idx(theirs.x, theirs.y)]).toBe(1);
    expect(lumber).not.toBeNull();
    // No civil building is left standing on another player's land.
    for (const b of w.buildings.values()) {
      if (b.garrison.length > 0 || b.type === 'tower' || b.type === 'castle') continue;
      for (let dy = 0; dy < b.h; dy++) {
        for (let dx = 0; dx < b.w; dx++) {
          expect([0, b.owner]).toContain(w.map.owner[w.map.idx(b.x + dx, b.y + dy)]);
        }
      }
    }
    if (w.map.owner[w.map.idx(lumber!.x, lumber!.y)] === 1) expect(w.buildings.has(lumber!.id)).toBe(false);
    expectConsistent(w);
  });

  it('defenders fight back; the dead are removed with no dangling references', () => {
    const { w, theirs } = frontier({ swords: 6, spares: 4 });
    run(w, 600);
    expect(theirs.garrison.length).toBeGreaterThan(0);
    const before = soldiersOf(w, 1).length + soldiersOf(w, 2).length;
    const sent = w.attack(theirs.id, 4);
    expect(sent).toBeGreaterThan(1);
    let duels = 0;
    for (let i = 0; i < 2500; i++) {
      w.step();
      if (w.settlers.some((s) => s.opponent !== null)) duels++;
      if (i % 50 === 0) expectConsistent(w);
    }
    expect(duels).toBeGreaterThan(0);
    expect(soldiersOf(w, 1).length + soldiersOf(w, 2).length).toBeLessThan(before);
    // Either the tower fell or every attacker died.
    const attackersLeft = w.settlers.filter((s) => s.tasks.some((t) => t.t === 'assault')).length;
    expect(theirs.owner === 1 || attackersLeft === 0).toBe(true);
    expectConsistent(w);
  });

  it('a battle continues identically after save and load', () => {
    const { w, theirs } = frontier({ swords: 6, spares: 4 });
    run(w, 600);
    w.attack(theirs.id, 4);
    for (let i = 0; i < 1500 && !w.settlers.some((s) => s.opponent !== null); i++) w.step();
    expect(w.settlers.some((s) => s.opponent !== null)).toBe(true);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 800);
    run(l, 800);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });

  it('refuses attacks on own or civil buildings', () => {
    const w = rich(new World(42, { players: 2 }));
    expect(w.attack(w.castle.id, 3)).toBe(0);
    const hut = placeNear(w, 'woodcutter', w.castleOf(2).x + 4, w.castleOf(2).y, 6, 2) as Building;
    run(w, 1500);
    expect(w.attack(hut.id, 3)).toBe(0);
  });
});
