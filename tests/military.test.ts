import { describe, expect, it } from 'vitest';
import { centerOf, spawnSettler } from '../src/sim/buildings';
import { START_CONDITIONS } from '../src/sim/config';

const START_FIGHTERS = START_CONDITIONS.medium.soldiers + START_CONDITIONS.medium.archers;
import { enterGarrison, isFighter, killSettler } from '../src/sim/military';
import { ENDLESS } from '../src/sim/economy';
import { saveWorld } from '../src/sim/save';
import { RESOURCES, type Building } from '../src/sim/types';
import { startPositions, World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** Plenty of building materials on every start tower's pile (test setup; a plain supply pile). */
function rich(w: World) {
  for (const p of w.players) {
    const c = startTower(w, p.id);
    c.output.plank = 80;
    c.output.stone = 40;
  }
  return w;
}

const soldiersOf = (w: World, player: number) => w.settlers.filter((s) => s.owner === player && s.kind === 'soldier');
const fightersOf = (w: World, player: number) => w.settlers.filter((s) => s.owner === player && isFighter(s) && !w.dying.has(s.id));

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
    for (const id of [...b.builderIds, ...b.diggerIds]) expect(w.getSettler(id)).toBeDefined();
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
  const [a, b] = [startTower(w, 1), startTower(w, 2)];
  if (opts.enemySoldiers !== undefined) {
    // Fighters in spawn order: the first is the swordsman holding their start tower.
    for (const s of fightersOf(w, 2).slice(opts.enemySoldiers)) killSettler(w, s);
    w.step();
  }
  // Extra swordsmen standing by our start tower (test setup; in play they come from a barracks):
  // they walk into towers with a free slot.
  for (let k = 0; k < (opts.swords ?? 0); k++) spawnSettler(w, 'soldier', a).inside = null;
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
  it('two players start far apart with their own start tower, settlers and land', () => {
    const w = new World(42, { players: 2 });
    const [p1, p2] = startPositions(64, 2);
    expect(Math.hypot(p1.x - p2.x, p1.y - p2.y)).toBeGreaterThan(30);
    expect(startTower(w, 1).owner).toBe(1);
    expect(startTower(w, 2).owner).toBe(2);
    expect(fightersOf(w, 2).length).toBe(START_FIGHTERS);
    const c2 = startTower(w, 2);
    expect(w.map.owner[w.map.idx(c2.x, c2.y)]).toBe(2);
    run(w, 600);
    expectConsistent(w);
  });
});

describe('military economy', () => {
  it('the weaponsmith forges first what recruit orders wait for', () => {
    const w = rich(new World(42));
    const c = startTower(w);
    const smith = placeNear(w, 'weaponsmith', base(w).x + 5, base(w).y - 1)!;
    run(w, 1500);
    expect(smith.done).toBe(true);
    // Two archers ordered (Settlers 4: the barracks' orders); swords lead the default shares.
    expect(w.orderRecruits('archer', 0, 2)).toBe(true);
    c.output.iron = 2;
    c.output.coal = 2;
    run(w, 1500);
    expect(w.stats.produced.bow).toBe(2);
    expect(w.stats.produced.sword).toBe(0);
  });

  it('weapons alone recruit nobody: new fighters come only from a barracks', () => {
    const w = rich(new World(42));
    const c = startTower(w);
    c.output.sword = 2;
    run(w, 600);
    expect(fightersOf(w, 1).length).toBe(START_FIGHTERS);
    expect(c.output.sword).toBe(2);
  });

  it('the weaponsmith follows the player sword/bow shares for its reserve', () => {
    for (const [bow, sword] of [
      [100, 0],
      [0, 100],
    ]) {
      const w = rich(new World(42));
      const c = startTower(w);
      w.setShare('bow', bow);
      w.setShare('sword', sword);
      w.setShare('armor', 0); // squad leaders' armour is a third share-controlled output
      expect(w.shareOf('bow')).toBe(bow);
      const smith = placeNear(w, 'weaponsmith', base(w).x + 5, base(w).y - 1)!;
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

describe('barracks (Settlers 4: recruits only by orders)', () => {
  /** A finished barracks by the start tower, its pile stocked straight (test setup). */
  function withBarracks(pile: Partial<Record<'sword' | 'bow' | 'armor' | 'gold', number>> = {}) {
    const w = rich(new World(42));
    const c = startTower(w);
    const barracks = placeNear(w, 'barracks', base(w).x + 5, base(w).y - 1)!;
    run(w, 1500);
    expect(barracks.done).toBe(true);
    for (const [r, n] of Object.entries(pile)) barracks.input[r as 'sword'] = n;
    return { w, c, barracks };
  }
  const recruits = (w: World) => w.settlers.filter((s) => s.tasks.some((t) => t.t === 'recruit'));

  it('recruits nobody without orders, however many weapons lie on its pile', () => {
    const { w, barracks } = withBarracks({ sword: 4, bow: 4, gold: 4 });
    expect(w.recruitOrder('soldier', 0)).toBe(0);
    run(w, 1200);
    expect(w.stats.trained).toBe(0);
    expect(recruits(w)).toHaveLength(0);
    expect(barracks.input.sword).toBe(4);
  });

  it('an order calls the nearest free carrier; he comes out as the fighter and stays standing by the barracks', () => {
    const { w, barracks } = withBarracks({ sword: 2 });
    const carriers = w.settlers.filter((s) => s.kind === 'carrier').length;
    expect(w.orderRecruits('soldier', 0, 1)).toBe(true);
    expect(w.recruitOrder('soldier', 0)).toBe(1);
    for (let i = 0; i < 40 && recruits(w).length === 0; i++) w.step();
    const [r] = recruits(w);
    expect(r.kind).toBe('recruit');
    // His sword comes off the pile at once, and the order counts down.
    expect(barracks.input.sword).toBe(1);
    expect(w.recruitOrder('soldier', 0)).toBe(0);
    run(w, 900);
    expect(w.stats.trained).toBe(1);
    expect(r.kind).toBe('soldier');
    expect(r.level).toBe(0);
    expect(w.settlers.filter((s) => s.kind === 'carrier').length).toBe(carriers - 1);
    // Free: no garrison, no post, standing by the barracks.
    expect(r.home).toBeNull();
    expect(r.post ?? null).toBeNull();
    expect(Math.hypot(r.x - barracks.door.x, r.y - barracks.door.y)).toBeLessThan(5);
    run(w, 600);
    expect(r.home).toBeNull();
    expect(Math.hypot(r.x - barracks.door.x, r.y - barracks.door.y)).toBeLessThan(5);
    expectConsistent(w);
  });

  it('the highest level the pile pays for goes first, and kinds take turns (Settlers 4)', () => {
    const { w } = withBarracks({ sword: 2, bow: 2, gold: 2 });
    w.orderRecruits('soldier', 0, ENDLESS);
    w.orderRecruits('soldier', 2, ENDLESS);
    w.orderRecruits('archer', 0, ENDLESS);
    const made: string[] = [];
    for (let i = 0; i < 3000 && made.length < 4; i++) {
      w.step();
      for (const s of recruits(w)) {
        const t = s.tasks.find((k) => k.t === 'recruit');
        const key = `${s.id}`;
        if (t && t.t === 'recruit' && !made.some((m) => m.startsWith(key + ':'))) made.push(`${key}:${t.kind}${t.level + 1}`);
      }
    }
    // Level 3 swordsman (2 gold) first; then level 1, archers and swordsmen in turn.
    expect(made.map((m) => m.split(':')[1])).toEqual(['soldier3', 'archer1', 'soldier1', 'archer1']);
    // Endless orders stay.
    expect(w.recruitOrder('soldier', 0)).toBe(ENDLESS);
  });

  it('orders step as in Settlers 4: +1, +5, −1, endless (100), −1 from endless, clear', () => {
    const w = new World(42);
    expect(w.orderRecruits('archer', 1, 1)).toBe(true);
    expect(w.orderRecruits('archer', 1, 5)).toBe(true);
    expect(w.recruitOrder('archer', 1)).toBe(6);
    w.reduceRecruits('archer', 1, 1);
    expect(w.recruitOrder('archer', 1)).toBe(5);
    w.orderRecruits('archer', 1, ENDLESS);
    expect(w.recruitOrder('archer', 1)).toBe(ENDLESS);
    w.reduceRecruits('archer', 1, 1);
    expect(w.recruitOrder('archer', 1)).toBe(99);
    w.orderRecruits('archer', 1, 5);
    expect(w.recruitOrder('archer', 1)).toBe(ENDLESS);
    w.orderRecruits('archer', 1, 0);
    expect(w.recruitOrder('archer', 1)).toBe(0);
    // No such level, no such fighter.
    expect(w.orderRecruits('leader', 1, 1)).toBe(false);
    expect(w.orderRecruits('carrier', 0, 1)).toBe(false);
  });

  it('wants gold only while an order takes some; level 1 takes none', () => {
    const { w, c, barracks } = withBarracks({ sword: 1 });
    c.output.gold = 4;
    w.orderRecruits('soldier', 0, 1);
    run(w, 1200);
    expect(barracks.input.gold + barracks.inbound.gold).toBe(0);
    expect(w.settlers.filter((s) => s.kind === 'soldier').every((s) => s.level === 0)).toBe(true);
    w.orderRecruits('soldier', 1, 1);
    run(w, 1200);
    expect(barracks.input.gold + barracks.inbound.gold).toBeGreaterThan(0);
  });

  it('a recruit who never arrives puts his goods back on the pile', () => {
    const { w, barracks } = withBarracks({ sword: 1, gold: 2 });
    w.orderRecruits('soldier', 2, 1);
    for (let i = 0; i < 40 && recruits(w).length === 0; i++) w.step();
    const [r] = recruits(w);
    expect(barracks.input.sword + barracks.input.gold).toBe(0);
    killSettler(w, r);
    expect(barracks.input.sword).toBe(1);
    expect(barracks.input.gold).toBe(2);
  });

  it('with no carrier to spare the player is warned', () => {
    const { w } = withBarracks({ sword: 2 });
    for (const s of w.settlers.filter((x) => x.kind === 'carrier')) killSettler(w, s);
    w.orderRecruits('soldier', 0, 1);
    run(w, 30);
    expect(w.warnings.some((m) => m.kind === 'noCarrier' && m.player === 1)).toBe(true);
    expect(w.recruitOrder('soldier', 0)).toBe(1);
  });

  it('recruiting continues identically after save and load', () => {
    const { w } = withBarracks({ sword: 2, bow: 1, gold: 1 });
    w.orderRecruits('soldier', 1, 1);
    w.orderRecruits('archer', 0, ENDLESS);
    for (let i = 0; i < 100 && recruits(w).length === 0; i++) w.step();
    expect(recruits(w).length).toBeGreaterThan(0);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(l.recruitOrder('archer', 0)).toBe(ENDLESS);
    run(w, 900);
    run(l, 900);
    expect(saveWorld(l)).toEqual(saveWorld(w));
    expect(w.stats.trained).toBe(2);
  });
});

describe('combat', () => {
  it('an undefended enemy tower is taken: ownership and land change hands, enemy civil buildings there burn', () => {
    const { w, ours, theirs } = frontier({ enemySoldiers: 1, spares: 1 });
    expect(theirs.garrison.length).toBe(0); // their start tower keeps its only swordsman
    // An enemy hut on land that only their tower would hold.
    const lumber = placeNear(w, 'woodcutter', theirs.x, theirs.y, 6, 2);
    expect(ours.garrison.length).toBeGreaterThan(0);

    expect(w.availableAttackers(theirs.id)).toBeGreaterThan(0);
    expect(w.attack(theirs.id, 1)).toBe(1);
    run(w, 1800);
    expect(theirs.owner).toBe(1);
    expect(theirs.garrison.length).toBe(1);
    expect(w.map.owner[w.map.idx(theirs.x, theirs.y)]).toBe(1);
    expect(lumber).not.toBeNull();
    // No civil building is left standing on another player's land.
    for (const b of w.buildings.values()) {
      if (b.garrison.length > 0 || b.type === 'tower') continue;
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
    expect(w.attack(startTower(w).id, 3)).toBe(0);
    const hut = placeNear(w, 'woodcutter', base(w, 2).x + 4, base(w, 2).y, 6, 2) as Building;
    run(w, 1500);
    expect(w.attack(hut.id, 3)).toBe(0);
  });
});
