import { describe, expect, it } from 'vitest';
import { addBuilding, centerOf, claimsTerritory, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, DEFEAT, GROUND, START_CONDITIONS } from '../src/sim/config';
import { workerOrder } from '../src/sim/economy';
import { GameMap } from '../src/sim/map';
import { enterGarrison, isFighter, killSettler } from '../src/sim/military';
import { findPath } from '../src/sim/pathfinding';
import { saveWorld } from '../src/sim/save';
import type { Building, BuildingType, PlayerId, Point } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { dismissStandby, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** The free spot nearest (x, y) whose ground takes the building (ownership ignored: test setup). */
function spotNear(w: World, type: BuildingType, x: number, y: number): Point {
  const def = BUILDINGS[type];
  const m = w.map;
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = x + dx;
        const ty = y + dy;
        let ok = m.inBounds(tx, ty + def.h) && m.isWalkable(tx + def.w - 1, ty + def.h);
        for (let k = 0; k < def.w * def.h && ok; k++) {
          const fx = tx + (k % def.w);
          const fy = ty + Math.floor(k / def.w);
          ok = m.isBuildable(fx, fy, 'ground') && m.building[m.idx(fx, fy)] === 0 && m.door[m.idx(fx, fy)] === 0;
        }
        if (ok && m.door[m.idx(tx + def.w - 1, ty + def.h)] === 0) return { x: tx, y: ty };
      }
    }
  }
  throw new Error('no spot');
}

/** A finished tower of `owner`'s at (or near) (x, y), manned by `swords` swordsmen (test setup). */
function tower(w: World, owner: PlayerId, x: number, y: number, swords = 1): Building {
  const at = spotNear(w, 'tower', x, y);
  const t = addBuilding(w, 'tower', at.x, at.y, owner, true);
  for (let k = 0; k < swords; k++) enterGarrison(w, t, spawnSettler(w, 'soldier', t));
  return t;
}

/** A finished woodcutter's hut of `owner`'s at (or near) (x, y) (test setup). */
function hut(w: World, owner: PlayerId, x: number, y: number): Building {
  const at = spotNear(w, 'woodcutter', x, y);
  return addBuilding(w, 'woodcutter', at.x, at.y, owner, true);
}

/** Tiles within the building's land radius of its centre. */
function disc(w: World, b: Building): number[] {
  const r = BUILDINGS[b.type].territory!;
  const c = centerOf(b);
  const out: number[] = [];
  for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
    for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
      if (w.map.inBounds(x, y) && Math.hypot(x - c.x, y - c.y) <= r) out.push(w.map.idx(x, y));
    }
  }
  return out;
}

/** Whether a claiming building of `owner` other than `except` reaches tile `i`. */
function coveredBy(w: World, owner: PlayerId, i: number, except?: Building): boolean {
  const x = i % w.map.w;
  const y = Math.floor(i / w.map.w);
  for (const b of w.buildings.values()) {
    if (b === except || b.owner !== owner || !claimsTerritory(b)) continue;
    const c = centerOf(b);
    if (Math.hypot(x - c.x, y - c.y) <= BUILDINGS[b.type].territory!) return true;
  }
  return false;
}

const owned = (w: World, p: PlayerId) => w.map.owner.reduce((n, o) => n + (o === p ? 1 : 0), 0);

describe('territory as in Settlers 4 (CWorldManager::SetOwner)', () => {
  it('land stays its owner\'s when the tower that claimed it is demolished', () => {
    const w = new World(42);
    const s = startTower(w);
    const before = owned(w, 1);
    const t = tower(w, 1, s.x + 9, s.y - 3);
    const gained = owned(w, 1);
    expect(gained).toBeGreaterThan(before + 40);
    const mine = disc(w, t).filter((i) => w.map.owner[i] === 1);
    expect(w.demolish(t.id)).toBe(true);
    // Settlers 4: nothing takes it from him — no other player's tower covers it.
    expect(owned(w, 1)).toBe(gained);
    for (const i of mine) expect(w.map.owner[i]).toBe(1);
    run(w, 600);
    expect(owned(w, 1)).toBe(gained);
  });

  it('a rival tower does not take land another player\'s tower still covers; it takes the rest', () => {
    const w = new World(42, { players: 2 });
    const [a1, b1] = [startTower(w, 1), startTower(w, 2)];
    const mid = { x: Math.round((a1.x + b1.x) / 2), y: Math.round((a1.y + b1.y) / 2) };
    const ours = tower(w, 1, mid.x + 4, mid.y + 4);
    const held = disc(w, ours).filter((i) => w.map.owner[i] === 1);
    const theirs = tower(w, 2, mid.x - 5, mid.y - 5);
    const c1 = centerOf(ours);
    const c2 = centerOf(theirs);
    // Every tile our tower covers stays ours, even those nearer their tower (no "nearest wins").
    let nearer = 0;
    for (const i of held) {
      expect(w.map.owner[i]).toBe(1);
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      if (Math.hypot(x - c2.x, y - c2.y) < Math.hypot(x - c1.x, y - c1.y)) nearer++;
    }
    expect(nearer).toBeGreaterThan(0);
    // What only their tower covers is theirs.
    for (const i of disc(w, theirs)) if (!coveredBy(w, 1, i)) expect(w.map.owner[i]).toBe(2);
  });

  it('uncovered land goes to the player whose tower covers it; his buildings on it burn', () => {
    const w = new World(42, { players: 2 });
    const [a1, b1] = [startTower(w, 1), startTower(w, 2)];
    const mid = { x: Math.round((a1.x + b1.x) / 2), y: Math.round((a1.y + b1.y) / 2) };
    const ours = tower(w, 1, mid.x + 4, mid.y + 4);
    const cabin = hut(w, 1, mid.x + 6, mid.y + 1);
    expect(w.map.owner[w.map.idx(cabin.door.x, cabin.door.y)]).toBe(1);
    // Our tower goes: the land stays ours…
    w.demolish(ours.id);
    expect(w.map.owner[w.map.idx(cabin.door.x, cabin.door.y)]).toBe(1);
    expect(w.buildings.has(cabin.id)).toBe(true);
    // …until their tower covers it: nothing of ours holds it any more.
    const theirs = tower(w, 2, mid.x + 1, mid.y + 1);
    const c = centerOf(theirs);
    expect(Math.hypot(cabin.door.x - c.x, cabin.door.y - c.y)).toBeLessThanOrEqual(BUILDINGS.tower.territory!);
    expect(w.map.owner[w.map.idx(cabin.door.x, cabin.door.y)]).toBe(2);
    expect(w.buildings.has(cabin.id)).toBe(false);
    for (const i of disc(w, theirs)) if (!coveredBy(w, 1, i)) expect(w.map.owner[i]).toBe(2);
  });

  it('a conquered tower takes only the land its former owner covers no more, and the game saves and loads', () => {
    const w = new World(42, { players: 2 });
    dismissStandby(w, 1);
    dismissStandby(w, 2);
    const [a1, b1] = [startTower(w, 1), startTower(w, 2)];
    // Their start tower keeps one fighter only (none to spare to man the emptied tower again).
    for (const id of b1.garrison.slice(1)) killSettler(w, w.getSettler(id)!);
    w.step();
    const mid = { x: Math.round((a1.x + b1.x) / 2), y: Math.round((a1.y + b1.y) / 2) };
    const target = tower(w, 2, mid.x - 2, mid.y - 2);
    const cover = tower(w, 2, mid.x - 8, mid.y + 1);
    const ours = tower(w, 1, mid.x + 6, mid.y + 6, 3);
    // A hut of theirs only the target covers, and one the other tower of theirs covers too.
    const lone = hut(w, 2, mid.x + 1, mid.y - 6);
    const safe = hut(w, 2, mid.x - 8, mid.y - 2);
    const liesOn = (b: Building, p: PlayerId) => w.map.owner[w.map.idx(b.door.x, b.door.y)] === p;
    expect(liesOn(lone, 2) && liesOn(safe, 2)).toBe(true);
    // The target is left empty (its defenders fell): its land stays theirs.
    for (const id of [...target.garrison]) killSettler(w, w.getSettler(id)!);
    w.step();
    expect(claimsTerritory(target)).toBe(false);
    const pre = Uint8Array.from(w.map.owner);
    const area = disc(w, target);
    for (const i of area) if (pre[i] !== 1) expect(pre[i]).toBe(2);
    expect(w.attack(target.id, 1)).toBe(1);
    for (let i = 0; i < 3000 && target.owner !== 1; i++) w.step();
    expect(target.owner).toBe(1);
    expect(ours.owner).toBe(1);
    // Theirs only where nothing of theirs covers it any more; their hut on that land burnt.
    const own = new Set(
      [...Array(target.h * target.w).keys()].map((k) => w.map.idx(target.x + (k % target.w), target.y + Math.floor(k / target.w))),
    );
    own.add(w.map.idx(target.door.x, target.door.y));
    for (const i of area) {
      if (own.has(i)) expect(w.map.owner[i]).toBe(1);
      else if (pre[i] === 2 && coveredBy(w, 2, i)) expect(w.map.owner[i]).toBe(2);
      else expect(w.map.owner[i]).toBe(1);
    }
    expect(liesOn(safe, 2)).toBe(true);
    expect(w.buildings.has(safe.id)).toBe(true);
    expect(coveredBy(w, 2, w.map.idx(lone.door.x, lone.door.y))).toBe(false);
    expect(w.buildings.has(lone.id)).toBe(false);
    // Some of the target's land stayed theirs, some changed hands.
    expect(area.some((i) => pre[i] === 2 && w.map.owner[i] === 2)).toBe(true);
    expect(area.some((i) => pre[i] === 2 && w.map.owner[i] === 1)).toBe(true);
    expect(cover.owner).toBe(2);
    // Ownership is saved state: a loaded game goes on identically.
    const copy = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 600);
    run(copy, 600);
    expect(saveWorld(copy)).toEqual(saveWorld(w));
  });
});

describe('defeat (DEFEAT.fighters)', () => {
  it('a player with no occupied military building is out only once his last fighter is gone', () => {
    expect(DEFEAT.fighters).toBe(true);
    const w = new World(42, { players: 2 });
    const t2 = startTower(w, 2);
    const fighters = () => w.settlers.filter((s) => s.owner === 2 && isFighter(s) && !w.dying.has(s.id));
    // His start tower emptied; one fighter of his still stands by it.
    for (const id of [...t2.garrison]) killSettler(w, w.getSettler(id)!);
    for (const s of fighters().slice(1)) killSettler(w, s);
    run(w, DEFEAT.afterTick + 5 * DEFEAT.checkEvery);
    expect(fighters().length).toBe(1);
    expect(w.isDefeated(2)).toBe(false);
    expect(w.holdsOn(2)).toBe(true);
    // His land stays his meanwhile (no tower of anyone else covers it).
    expect(owned(w, 2)).toBeGreaterThan(0);
    killSettler(w, fighters()[0]);
    run(w, 2 * DEFEAT.checkEvery);
    expect(w.isDefeated(2)).toBe(true);
    expect(w.outcome(1)).toBe('won');
    // A defeated player's land goes back to nobody.
    expect(owned(w, 2)).toBe(0);
  });
});

describe('the AI hunts an enemy\'s last fighters', () => {
  it('fighters left standing when their towers are gone are hunted down, and their player is out', { timeout: 120_000 }, () => {
    const w = new World(42, { players: 2, ai: [2] });
    const home = startTower(w, 1);
    // Player 1 tears down his only tower: his fighters come out homeless, his land stays his.
    expect(w.demolish(home.id, 1)).toBe(true);
    const left = () => w.settlers.filter((s) => s.owner === 1 && isFighter(s) && !w.dying.has(s.id));
    expect(left().length).toBe(START_CONDITIONS.medium.soldiers + START_CONDITIONS.medium.archers);
    expect(owned(w, 1)).toBeGreaterThan(0);
    // The AI has a strong tower in sight of them (test setup), and knows no military building of his.
    const watch = tower(w, 2, home.x + 7, home.y + 7, 1);
    for (let k = 0; k < 24; k++) {
      const s = spawnSettler(w, 'soldier', watch);
      s.level = 2;
      s.hp = 1e6;
      enterGarrison(w, watch, s);
    }
    for (let i = 0; i < 20 * 600 && !w.isDefeated(1); i++) w.step();
    const ai = w.ai.find((a) => a.player === 2)!;
    expect(ai.stats.hunts ?? 0).toBeGreaterThanOrEqual(1);
    expect(left().length).toBe(0);
    expect(w.isDefeated(1)).toBe(true);
    expect(w.outcome(2)).toBe('won');
  });
});

describe('start people as in Settlers 4 (StartResources.txt, Romans)', () => {
  it('every start level brings its carriers, builders, diggers, fighters, geologists, donkeys and ready workers', () => {
    for (const level of Object.keys(START_CONDITIONS) as (keyof typeof START_CONDITIONS)[]) {
      const def = START_CONDITIONS[level];
      const w = new World(42, { start: level });
      const count = (kind: string) => w.settlers.filter((s) => s.kind === kind).length;
      expect(count('carrier')).toBe(def.carriers);
      expect(count('builder')).toBe(def.builders);
      expect(count('digger')).toBe(def.diggers);
      expect(count('soldier')).toBe(def.soldiers);
      expect(count('archer')).toBe(def.archers);
      expect(count('geologist')).toBe(def.geologists);
      expect(count('donkey')).toBe(def.donkeys);
      for (const [kind, n] of Object.entries(def.workers)) expect(count(kind)).toBe(n);
      // The geologists are ordered (none recruited on top of them, none dismissed).
      expect(workerOrder(w, 1, 'geologist')).toBe(def.geologists);
    }
  });

  it('a ready-made smith takes up a toolsmith\'s or a weaponsmith\'s workplace before any carrier', () => {
    const w = new World(42);
    const t = startTower(w);
    const smiths = new Set(w.settlers.filter((s) => s.kind === 'toolsmith').map((s) => s.id));
    expect(smiths.size).toBe(START_CONDITIONS.medium.workers.toolsmith);
    const tools = placeNear(w, 'toolsmith', t.x - 5, t.y - 1)!;
    const weapons = placeNear(w, 'weaponsmith', t.x + 5, t.y - 1)!;
    for (let i = 0; i < 6000 && (tools.workerId === null || weapons.workerId === null); i++) w.step();
    expect(smiths.has(tools.workerId!)).toBe(true);
    expect(smiths.has(weapons.workerId!)).toBe(true);
    expect(w.getSettler(weapons.workerId)!.kind).toBe('weaponsmith');
  });
});

describe('goods on the ground make a path dearer (Settlers 4: SetPileId, move cost 36 against 16)', () => {
  it('a route steps round a stack when that is cheaper, and still goes through a line of them', () => {
    expect(GROUND.pathCost).toBeCloseTo(36 / 16);
    const m = new GameMap(32, 32);
    const at = (x: number, y: number) => m.idx(x, y);
    const via = (p: Point[] | null, x: number, y: number) => !!p?.some((q) => q.x === x && q.y === y);
    expect(via(findPath(m, 5, 10, 20, 10, false, false), 12, 10)).toBe(true);
    m.goods[at(12, 10)] = 1;
    m.goodsAmount[at(12, 10)] = 4;
    const round = findPath(m, 5, 10, 20, 10, false, false);
    expect(round).not.toBeNull();
    expect(via(round, 12, 10)).toBe(false);
    // A wall of stacks never blocks: the route crosses it.
    for (let y = 0; y < 32; y++) {
      m.goods[at(15, y)] = 1;
      m.goodsAmount[at(15, y)] = 2;
    }
    const across = findPath(m, 5, 10, 20, 10, false, false);
    expect(across).not.toBeNull();
    expect(across!.some((q) => q.x === 15)).toBe(true);
  });
});
