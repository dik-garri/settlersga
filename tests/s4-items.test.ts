/**
 * Settlers 4 parity items of docs/S4-AUDIT.md: messages with a place (24), own land visible (23),
 * the lookout tower's occupant and alarm (27), the thief (18), the loaded donkey (21), computer
 * players' help and counterattack (29), war statistics and the score (28). The infirmary (17) is in
 * army-s4.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { attackTriggered } from '../src/sim/ai';
import { addBuilding, centerOf, spawnSettler } from '../src/sim/buildings';
import { AI, AI_LEVELS, BUILDINGS, FOG, INTRUDERS, MESSAGE_KEEP, MESSAGES, MINING, oreOf, THIEF } from '../src/sim/config';
import { dropGoods } from '../src/sim/ground';
import { postMessage } from '../src/sim/messages';
import { enterGarrison, isFighter, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { scoreOf } from '../src/sim/score';
import { lootAt } from '../src/sim/specialists';
import { settlementValue } from '../src/sim/strength';
import type { Building, BuildingType, PlayerId, Point, Settler, SettlerKind } from '../src/sim/types';
import { World } from '../src/sim/world';
import { clearGround, groundUnits, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A finished building of `type` on the player's land, as near `at` as it fits (test setup). */
function built(w: World, type: BuildingType, at: Point, p: PlayerId = 1, r = 12): Building {
  for (let d = 0; d <= r; d++) {
    for (let y = at.y - d; y <= at.y + d; y++) {
      for (let x = at.x - d; x <= at.x + d; x++) {
        if (Math.max(Math.abs(x - at.x), Math.abs(y - at.y)) !== d) continue;
        if (w.canPlace(type, x, y, p)) return addBuilding(w, type, x, y, p, true);
      }
    }
  }
  throw new Error(`no room for ${type}`);
}

/** Its worker, inside (test setup). */
function staff(w: World, b: Building): Settler {
  const s = spawnSettler(w, BUILDINGS[b.type].worker!, b);
  s.home = b.id;
  s.inside = b.id;
  b.workerId = s.id;
  return s;
}

/** A settler of `kind` standing outdoors at (x, y). */
function outdoors(w: World, kind: SettlerKind, p: PlayerId, x: number, y: number): Settler {
  const s = spawnSettler(w, kind, startTower(w, p));
  s.inside = null;
  s.home = null;
  s.x = s.px = x;
  s.y = s.py = y;
  return s;
}

/** An owned, walkable tile of player `p` at least `d` from `from` (nearest first). */
function ownTileAway(w: World, p: PlayerId, from: Point, d: number): Point {
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = 0; y < w.map.h; y++) {
    for (let x = 0; x < w.map.w; x++) {
      const dd = Math.hypot(x - from.x, y - from.y);
      if (dd >= d && dd < bestD && w.owns(x, y, p) && w.map.isWalkable(x, y) && w.map.door[w.map.idx(x, y)] === 0) {
        best = { x, y };
        bestD = dd;
      }
    }
  }
  return best!;
}

describe('messages with a place on the map (S4-AUDIT 24)', () => {
  it('keeps the last MESSAGE_KEEP, quiet for `every` per kind, player and building; `warnings` reads them', () => {
    const w = new World(42);
    expect(postMessage(w, 'noFighter', 1, { x: 3, y: 4 }, { b: 7 })).toBe(true);
    expect(postMessage(w, 'noFighter', 1, { x: 3, y: 4 }, { b: 7 })).toBe(false);
    // Another building, another player: not the same message.
    expect(postMessage(w, 'noFighter', 1, { x: 3, y: 4 }, { b: 8 })).toBe(true);
    expect(postMessage(w, 'noFighter', 2, { x: 3, y: 4 }, { b: 7 })).toBe(true);
    // A carrier shortage is told once per player, whichever building waits.
    expect(postMessage(w, 'noCarrier', 1, { x: 1, y: 1 }, { b: 1 })).toBe(true);
    expect(postMessage(w, 'noCarrier', 1, { x: 1, y: 1 }, { b: 2 })).toBe(false);
    for (let k = 0; k < MESSAGE_KEEP + 5; k++) postMessage(w, 'captured', 1, { x: k, y: 0 }, { b: 100 + k });
    expect(w.messages).toHaveLength(MESSAGE_KEEP);
    expect(w.messages.at(-1)).toMatchObject({ kind: 'captured', player: 1, x: MESSAGE_KEEP + 4, y: 0 });
    expect(w.warnings).toBe(w.messages);
    w.tick += MESSAGES.noFighter.every;
    expect(postMessage(w, 'noFighter', 1, { x: 3, y: 4 }, { b: 7 })).toBe(true);
  });

  it('an assault and a conquest tell both sides where; messages are not saved and change nothing', () => {
    const w = new World(42, { players: 2 });
    const theirs = startTower(w, 2);
    const a = outdoors(w, 'soldier', 1, theirs.door.x, theirs.door.y + 1);
    a.level = 2;
    a.hp = 1e6;
    a.tasks = [{ t: 'assault', b: theirs.id, n: 0 }];
    const copy = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    for (let i = 0; i < 3000 && theirs.owner === 2; i++) {
      w.step();
      copy.step();
    }
    expect(theirs.owner).toBe(1);
    const kinds = (p: PlayerId) => w.messages.filter((m) => m.player === p).map((m) => m.kind);
    expect(kinds(2)).toContain('attacked');
    expect(kinds(2)).toContain('lost');
    expect(kinds(1)).toContain('captured');
    const lost = w.messages.find((m) => m.kind === 'lost')!;
    expect(lost).toMatchObject({ x: theirs.door.x, y: theirs.door.y, b: theirs.id });
    expect(w.stats.war[1].captured).toBe(1);
    expect(w.stats.war[2].lostBuildings).toBe(1);
    // A loaded world (no messages) goes on identically.
    expect(saveWorld(copy)).toEqual(saveWorld(w));
    expect('messages' in saveWorld(w)).toBe(false);
  });

  it('a mine that finds nothing more than `MINING.emptyAfter` times running tells its owner', () => {
    const w = new World(42);
    const m = w.map;
    let mine: Building | null = null;
    for (let i = 0; i < m.ore.length && !mine; i++) {
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      if (oreOf(m.ore[i]) === 'coal' && w.owns(x, y) && w.canPlace('coalmine', x - 1, y - 1)) mine = addBuilding(w, 'coalmine', x - 1, y - 1, 1, true);
    }
    expect(mine).not.toBeNull();
    for (let i = 0; i < m.oreAmount.length; i++) m.oreAmount[i] = 0;
    staff(w, mine!);
    mine!.input.bread = 8;
    const ticks = BUILDINGS.coalmine.recipe!.ticks;
    run(w, ticks * (MINING.emptyAfter + 2));
    expect(w.messages.some((x) => x.kind === 'mineEmpty' && x.b === mine!.id && x.player === 1)).toBe(true);
  });
});

describe('fog: own land is seen whole (S4-AUDIT 23)', () => {
  it('every own tile is visible, and a band of FOG.landBand beyond it, also land without towers', () => {
    const w = new World(42, { players: 2 });
    clearGround(w);
    for (const s of w.settlers) if (s.owner === 1) s.inside = startTower(w).id; // no settler sight
    // Land far away (a pioneer's, say): no tower sees it.
    const far = { x: 6, y: 58 };
    const m = w.map;
    for (let y = far.y - 2; y <= far.y + 2; y++) for (let x = far.x - 2; x <= far.x + 2; x++) m.owner[m.idx(x, y)] = 1;
    w.territoryVersion++;
    w.step();
    for (let i = 0; i < m.owner.length; i++) if (m.owner[i] === 1) expect(w.isVisible(i % m.w, Math.floor(i / m.w), 1)).toBe(true);
    expect(w.isVisible(far.x + 2 + FOG.landBand, far.y, 1)).toBe(true);
    expect(w.isVisible(far.x + 3 + FOG.landBand, far.y, 1)).toBe(false);
    expect(w.isExplored(far.x, far.y, 1)).toBe(true);
    // Player 2 sees none of it.
    expect(w.isVisible(far.x, far.y, 2)).toBe(false);
  });

  it('a military building sees its `sight` only while manned', () => {
    const w = new World(42);
    const t = startTower(w);
    const r = BUILDINGS.tower.sight!;
    expect(r).toBeGreaterThan(BUILDINGS.tower.territory! + FOG.landBand);
    for (const s of w.settlers) s.inside = t.id; // no settler sight
    const c = centerOf(t);
    const probe = { x: Math.round(c.x), y: Math.round(c.y - r + 1) };
    w.step();
    expect(w.isVisible(probe.x, probe.y)).toBe(true);
    // Emptied, it sees only its land and the band.
    for (const id of [...t.garrison]) killSettler(w, w.getSettler(id)!);
    w.step();
    expect(w.isVisible(probe.x, probe.y)).toBe(false);
  });

  it('settlers see FOG.settlerRadius (S4: 15 + 6 of its tiles), the thief further', () => {
    expect(FOG.settlerRadius).toBe(7);
    expect(Math.round((15 + 6) / 3)).toBe(FOG.settlerRadius);
  });
});

describe('lookout tower: occupant and alarm (S4-AUDIT 27)', () => {
  it('sees its vision without him; with him inside it raises the alarm once per enemy approach', () => {
    const w = new World(42, { players: 2 });
    const look = built(w, 'lookout', { x: startTower(w).x + 6, y: startTower(w).y });
    const alarm = BUILDINGS.lookout.alarm!;
    const c = centerOf(look);
    const enemy = outdoors(w, 'soldier', 2, Math.round(c.x + alarm.radius - 2), Math.round(c.y));
    enemy.hp = 1e6;
    enemy.post = { x: Math.round(enemy.x), y: Math.round(enemy.y) };
    run(w, alarm.every * 2);
    const alarms = () => w.messages.filter((m) => m.kind === 'alarm' && m.b === look.id).length;
    expect(alarms()).toBe(0); // nobody inside: no alarm
    const r = BUILDINGS.lookout.vision!;
    const far = [
      [c.x + r - 1, c.y],
      [c.x - r + 1, c.y],
      [c.x, c.y + r - 1],
      [c.x, c.y - r + 1],
    ].find(([x, y]) => w.map.inBounds(Math.round(x), Math.round(y)))!;
    expect(w.isVisible(Math.round(far[0]), Math.round(far[1]))).toBe(true);
    staff(w, look);
    run(w, alarm.every * 2);
    expect(alarms()).toBe(1);
    run(w, alarm.every * 3);
    expect(alarms()).toBe(1); // still there: no new alarm
    // He goes, and comes back: a new alarm.
    enemy.x = enemy.px = c.x + alarm.radius + 6;
    enemy.post = { x: Math.round(enemy.x), y: Math.round(enemy.y) };
    run(w, alarm.every * 2);
    expect(look.alarm).toBeUndefined();
    enemy.x = enemy.px = c.x + alarm.radius - 2;
    enemy.post = { x: Math.round(enemy.x), y: Math.round(enemy.y) };
    run(w, alarm.every * 2);
    expect(alarms()).toBe(2);
  });
});

describe('the thief (S4-AUDIT 18)', () => {
  it('is unmasked by a hostile fighter within decloakRadius on any land, never by buildings', () => {
    const w = new World(42, { players: 2 });
    const theirs = startTower(w, 2);
    const thief = outdoors(w, 'thief', 1, theirs.door.x, theirs.door.y + 1);
    thief.post = { x: Math.round(thief.x), y: Math.round(thief.y) };
    // Their tower (manned) right there, their free fighters moved far away.
    for (const s of w.settlers) if (s.owner === 2 && isFighter(s) && s.inside === null) killSettler(w, s);
    run(w, INTRUDERS.scanEvery * 3);
    expect(thief.exposed).toBeFalsy();
    const guard = outdoors(w, 'soldier', 2, thief.x + INTRUDERS.decloakRadius + 1, thief.y);
    guard.post = { x: Math.round(guard.x), y: Math.round(guard.y) };
    guard.hp = 1e6;
    run(w, INTRUDERS.scanEvery);
    expect(thief.exposed).toBeFalsy();
    guard.x = guard.px = thief.x + INTRUDERS.decloakRadius - 0.5;
    run(w, INTRUDERS.scanEvery);
    expect(thief.exposed).toBe(true);
  });

  it('is disguised again on land not hostile with no enemy within recloakRadius', () => {
    const w = new World(42, { players: 2 });
    const home = w.homeOf(1);
    const spot = ownTileAway(w, 1, home, 3);
    const thief = outdoors(w, 'thief', 1, spot.x, spot.y);
    thief.post = { ...spot };
    thief.exposed = true;
    const enemy = outdoors(w, 'soldier', 2, spot.x + INTRUDERS.recloakRadius - 1, spot.y);
    enemy.post = { x: Math.round(enemy.x), y: Math.round(enemy.y) };
    enemy.hp = 1e6;
    // Keep his own fighters off the enemy (the check is about the mask only).
    run(w, INTRUDERS.recloakEvery + INTRUDERS.scanEvery);
    expect(thief.exposed).toBe(true);
    killSettler(w, enemy);
    run(w, INTRUDERS.recloakEvery + INTRUDERS.scanEvery);
    expect(thief.exposed).toBeFalsy();
  });

  it('takes one unit off the first stack round the spot, carries it to his home point and puts it on the ground', () => {
    const w = new World(42, { players: 2 });
    clearGround(w); // no goods of his own lying about (he would move those)
    const theirs = startTower(w, 2);
    const store = built(w, 'warehouse', { x: theirs.x - 4, y: theirs.y }, 2);
    store.output.sword = 5;
    for (let i = 0; i < w.map.explored.length; i++) w.map.explored[i] |= 1;
    // Nobody of theirs outdoors to unmask him.
    for (const s of w.settlers) if (s.owner === 2 && isFighter(s) && s.inside === null) killSettler(w, s);
    w.orderSpecialist('thief', 0);
    const home = ownTileAway(w, 1, w.homeOf(1), 4);
    const thief = outdoors(w, 'thief', 1, home.x, home.y);
    expect(w.orderSpecialists([thief.id], home.x, home.y)).toBe(1); // an order on own land: his home point
    expect(thief.homeAt).toEqual(home);
    expect(lootAt(w, store.door.x, store.door.y, 1)).toMatchObject({ b: store.id, res: 'sword', from: 'output' });
    expect(w.sendThief(store.id)).toBe(true);
    const before = groundUnits(w, 'sword', 1);
    for (let i = 0; i < 6000 && groundUnits(w, 'sword', 1) === before; i++) w.step();
    expect(store.output.sword).toBeLessThanOrEqual(4);
    expect(groundUnits(w, 'sword', 1)).toBe(before + 1);
    // Put down at his home point, not in a warehouse.
    const i = w.map.idx(home.x, home.y);
    expect(w.map.goodsAmount[i]).toBeGreaterThan(0);
  });

  it('on his own land he finds only goods on the ground', () => {
    const w = new World(42);
    clearGround(w);
    const store = built(w, 'warehouse', { x: startTower(w).x - 4, y: startTower(w).y });
    store.output.plank = 5;
    w.step(); // his land explored
    expect(lootAt(w, store.door.x, store.door.y, 1)).toBeNull();
    const spot = { x: store.door.x, y: store.door.y + 1 };
    dropGoods(w, spot, 'stone', 2);
    const l = lootAt(w, store.door.x, store.door.y, 1)!;
    expect(l).toMatchObject({ res: 'stone', from: 'ground' });
    expect(Math.hypot(l.x - store.door.x, l.y - store.door.y)).toBeLessThanOrEqual(THIEF.lootRadius);
  });
});

describe('a loaded donkey on hostile land (S4-AUDIT 21)', () => {
  it('is an intruder: a blow makes it drop its load there and go home, unhurt', () => {
    const w = new World(42, { players: 2 });
    const theirs = startTower(w, 2);
    const spot = ownTileAway(w, 2, theirs.door, 3);
    const donkey = outdoors(w, 'donkey', 1, spot.x, spot.y);
    donkey.carrying = 'plank';
    donkey.load = 8;
    donkey.pack2 = { res: 'stone', n: 8 };
    donkey.tasks = [{ t: 'wait', n: 2000 }];
    const before = groundUnits(w, 'plank', 2);
    for (let i = 0; i < 1500 && donkey.carrying; i++) w.step();
    expect(w.dying.has(donkey.id) || !w.getSettler(donkey.id)).toBe(false);
    expect(donkey.carrying).toBeNull();
    expect(donkey.pack2).toBeUndefined();
    // Its packs lie on their land: their carriers take them.
    expect(groundUnits(w, 'plank', 2)).toBe(before + 8);
    expect(groundUnits(w, 'stone', 2)).toBeGreaterThanOrEqual(8);
    // Unloaded, nobody goes for it any more.
    run(w, 200);
    expect(w.settlers.some((s) => s.tasks.some((t) => t.t === 'chase' && t.s === donkey.id))).toBe(false);
  });
});

describe('computer players: Settlers 4 help and counterattack (S4-AUDIT 29)', () => {
  it('counts its building materials twice in its fighting strength from «normal» on', () => {
    const human = new World(42, { players: 2 });
    const easy = new World(42, { players: 2, ai: [2], difficulty: ['medium', 'easy'] });
    const normal = new World(42, { players: 2, ai: [2] });
    expect(AI_LEVELS.medium.strengthDouble).toBe(true);
    expect(settlementValue(easy, 2)).toBe(settlementValue(human, 2));
    expect(settlementValue(normal, 2)).toBe(2 * settlementValue(human, 2));
  });

  it("an AI's mine never works its ore out (a tile keeps 1); a human's does", () => {
    const setup = (ai: boolean) => {
      const w = new World(42, ai ? { ai: [1] } : {});
      w.ai.forEach((a) => (a.nextThink = Infinity)); // no plans of its own in the way
      const m = w.map;
      let mine: Building | null = null;
      for (let i = 0; i < m.ore.length && !mine; i++) {
        const x = i % m.w;
        const y = Math.floor(i / m.w);
        if (oreOf(m.ore[i]) === 'coal' && w.owns(x, y) && w.canPlace('coalmine', x - 1, y - 1)) mine = addBuilding(w, 'coalmine', x - 1, y - 1, 1, true);
      }
      for (let i = 0; i < m.oreAmount.length; i++) if (oreOf(m.ore[i]) === 'coal') m.oreAmount[i] = Math.min(m.oreAmount[i], 2);
      staff(w, mine!);
      return { w, mine: mine! };
    };
    for (const ai of [false, true]) {
      const { w, mine } = setup(ai);
      for (let i = 0; i < 20000; i++) {
        mine.input.bread = 8;
        mine.output.coal = 0;
        w.step();
      }
      const left = [...w.map.oreAmount.keys()].filter((i) => oreOf(w.map.ore[i]) === 'coal');
      const zero = left.some((i) => w.map.oreAmount[i] === 0);
      if (ai) expect(left.every((i) => w.map.oreAmount[i] >= 1)).toBe(true);
      else expect(zero).toBe(true);
    }
  });

  it('strikes back at whoever took one of its military buildings, peace time or not', () => {
    const w = new World(42, { players: 2, ai: [2] });
    const ai = w.ai[0];
    run(w, AI.thinkEvery * 2);
    expect(ai.held).toContain(startTower(w, 2).id);
    // Player 1 takes its start tower (test setup: as `conquer` does it).
    const t = startTower(w, 2);
    for (const id of [...t.garrison]) killSettler(w, w.getSettler(id)!);
    t.owner = 1;
    t.wish = { melee: 0, ranged: 0 };
    enterGarrison(w, t, spawnSettler(w, 'soldier', t));
    expect(w.tick).toBeLessThan(AI.peaceTicks);
    run(w, AI.thinkEvery * 2);
    expect(ai.counter?.b).toBe(t.id);
    expect(ai.stats.counters).toBeGreaterThanOrEqual(1);
    expect(w.settlers.some((s) => s.owner === 2 && s.tasks.some((k) => k.t === 'assault' && k.b === t.id))).toBe(true);
  });

  it("Settlers 4's attack trigger: no attack with fewer than 15 fighters; the chance grows by a step per miss", () => {
    const cfg = AI.s4Attack!;
    const w = new World(42, { players: 2, ai: [2] });
    const ai = w.ai[0];
    for (const s of w.settlers) if (s.owner === 2 && isFighter(s)) killSettler(w, s);
    w.step();
    ai.trigger = { chance: cfg.start, next: 0, ready: false };
    expect(attackTriggered(w, ai)).toBe(false);
    expect(ai.trigger.chance).toBe(cfg.start); // too few: no roll
    for (let k = 0; k < cfg.minFighters; k++) outdoors(w, 'soldier', 2, w.homeOf(2).x, w.homeOf(2).y + 2);
    let rolls = 0;
    while (!ai.trigger.ready && rolls < 200) {
      w.tick = ai.trigger.next;
      const chance = ai.trigger.chance;
      const fired = attackTriggered(w, ai);
      if (!fired) expect(ai.trigger.chance).toBe(Math.min(cfg.max, chance + cfg.step));
      rolls++;
    }
    expect(ai.trigger.ready).toBe(true);
    expect(attackTriggered(w, ai)).toBe(true); // stays ready until it attacks
  });
});

describe('war statistics and the score (S4-AUDIT 28)', () => {
  it('counts kills and losses by kind per player, and scores by the Settlers 4 formula', () => {
    const w = new World(42, { players: 2 });
    const a = outdoors(w, 'soldier', 1, w.homeOf(2).x + 3, w.homeOf(2).y + 3);
    const b = outdoors(w, 'archer', 2, a.x + 1, a.y);
    a.level = 2;
    a.hp = 1e6;
    b.hp = 1;
    a.tasks = [{ t: 'engage', s: b.id, n: 0 }];
    for (let i = 0; i < 200 && !w.dying.has(b.id) && w.getSettler(b.id); i++) w.step();
    expect(w.stats.war[1].killed.archer).toBe(1);
    expect(w.stats.war[2].fallen.archer).toBe(1);
    const sc = scoreOf(w, 1);
    expect(sc.kills).toBe(1);
    expect(sc.total).toBe(Math.round((5 * sc.kills + 2 * (sc.settlers + sc.fighters + sc.gold) + sc.ore + sc.food + sc.buildings) / 10));
    expect(sc.fighters).toBe(w.settlers.filter((s) => s.owner === 1 && isFighter(s)).length);
  });
});
