/**
 * Soldiers, garrisons and combat.
 *
 * Military buildings (`def.garrison`) hold soldiers. Empty slots are filled by moving a spare soldier
 * out of the castle's reserve, otherwise by recruiting: a carrier fetches a sword and enlists.
 * An attack sends spare soldiers to an enemy military building; at its door each attacker duels one
 * defender at a time. When no defender is left, the attacker takes the building over: ownership and
 * territory change, and enemy civil buildings left on foreign land are destroyed.
 *
 * Removing a settler must go through `killSettler`, which clears every reference to it; the settler
 * itself leaves `World.settlers` at the end of the tick (`removeDead`).
 */
import { centerOf, claimsTerritory, recomputeTerritory } from './buildings';
import { ATTACK_RANGE, BUILDINGS, DAMAGE, FIGHT_EVERY, GARRISON_KEEP, PROFESSIONS } from './config';
import { randInt } from './rng';
import { abort } from './settlers';
import type { Building, PlayerId, Point, Resource, Settler, Task } from './types';
import type { World } from './world';

export function isMilitary(b: Building): boolean {
  return !!BUILDINGS[b.type].garrison;
}

/** Free garrison slots not yet promised to an incoming soldier. */
export function garrisonSpace(b: Building): number {
  const def = BUILDINGS[b.type].garrison;
  return def ? def.capacity - b.garrison.length - b.garrisonInbound : 0;
}

const alive = (w: World, id: number): Settler | undefined => (w.dying.has(id) ? undefined : w.getSettler(id));

export function enterGarrison(w: World, b: Building, s: Settler): void {
  const claimed = claimsTerritory(b);
  b.garrison.push(s.id);
  s.home = b.id;
  s.inside = b.id;
  s.x = s.px = b.door.x;
  s.y = s.py = b.door.y;
  if (claimsTerritory(b) !== claimed) recomputeTerritory(w);
}

export function leaveGarrison(w: World, b: Building, s: Settler): void {
  const claimed = claimsTerritory(b);
  b.garrison = b.garrison.filter((id) => id !== s.id);
  if (s.home === b.id) s.home = null;
  if (s.inside === b.id) s.inside = null;
  if (claimsTerritory(b) !== claimed) recomputeTerritory(w);
}

/** Garrisoned soldiers that may leave: inside, not fighting, beyond the minimum the building keeps. */
function spareSoldiers(w: World, b: Building): Settler[] {
  const ready = b.garrison
    .map((id) => alive(w, id))
    .filter((s): s is Settler => !!s && s.inside === b.id && s.opponent === null);
  return ready.slice(0, Math.max(0, Math.min(ready.length, b.garrison.length - GARRISON_KEEP)));
}

/**
 * Logistics step: fill military buildings' free slots, outposts before reserves. A spare soldier
 * from a reserve building (the castle) walks over if there is one; otherwise a carrier fetches a
 * sword and enlists.
 */
export function staffGarrisons(
  w: World,
  own: Building[],
  take: (near: Point) => Settler | undefined,
  supplyOf: (res: Resource, target: Building) => Building | undefined,
): void {
  const military = own.filter((b) => b.done && isMilitary(b));
  const outposts = military.filter((b) => !BUILDINGS[b.type].garrison!.claimsWhenEmpty);
  const reserves = military.filter((b) => BUILDINGS[b.type].garrison!.claimsWhenEmpty);
  const sword = PROFESSIONS.soldier.tool!;
  for (const b of [...outposts, ...reserves]) {
    while (garrisonSpace(b) > 0 && b.unreachableUntil <= w.tick) {
      const reserve = outposts.includes(b)
        ? reserves.map((r) => ({ r, spare: spareSoldiers(w, r) })).find((x) => x.spare.length > 0)
        : undefined;
      if (reserve) {
        const s = reserve.spare[0];
        leaveGarrison(w, reserve.r, s);
        sendToJoin(s, b);
        continue;
      }
      const from = supplyOf(sword, b);
      if (!from) break;
      const s = take(from.door);
      if (!s) return;
      from.outReserved[sword]++;
      b.garrisonInbound++;
      s.tasks = [
        { t: 'goto', x: from.door.x, y: from.door.y },
        { t: 'pickup', b: from.id, res: sword },
        { t: 'goto', x: b.door.x, y: b.door.y },
        { t: 'retool', kind: 'soldier' },
        { t: 'join', b: b.id },
      ];
    }
  }
}

function sendToJoin(s: Settler, b: Building): void {
  b.garrisonInbound++;
  s.tasks = [
    { t: 'goto', x: b.door.x, y: b.door.y },
    { t: 'join', b: b.id },
  ];
}

/** `join` task: move into the garrison if it is still ours and has room; otherwise give up. */
export function joinTick(w: World, s: Settler, task: Extract<Task, { t: 'join' }>): void {
  const b = w.buildings.get(task.b);
  const def = b ? BUILDINGS[b.type].garrison : undefined;
  if (!b || !def || !b.done || b.owner !== s.owner || b.garrison.length >= def.capacity) return abort(w, s);
  b.garrisonInbound--;
  s.tasks.shift();
  enterGarrison(w, b, s);
}

/** Idle soldier: stay in the home garrison, or look for the nearest own one with room. */
export function soldierIdle(w: World, s: Settler): void {
  const home = s.home !== null ? w.buildings.get(s.home) : undefined;
  if (home && home.owner === s.owner && home.garrison.includes(s.id)) {
    if (s.inside !== home.id) {
      s.tasks = [
        { t: 'goto', x: home.door.x, y: home.door.y },
        { t: 'enter', b: home.id },
      ];
    }
    return;
  }
  s.home = null;
  let best: Building | undefined;
  for (const b of w.buildings.values()) {
    if (b.owner !== s.owner || !b.done || garrisonSpace(b) <= 0) continue;
    if (!best || Math.hypot(b.door.x - s.x, b.door.y - s.y) < Math.hypot(best.door.x - s.x, best.door.y - s.y)) best = b;
  }
  if (best) sendToJoin(s, best);
  else s.tasks = [{ t: 'wait', n: 50 }];
}

/** Soldiers of `player` that `attack` would send against the target (spares within range). */
function attackers(w: World, target: Building, player: PlayerId): Settler[] {
  const c = centerOf(target);
  const sources = [...w.buildings.values()]
    .filter((b) => b.owner === player && b.done && isMilitary(b))
    .map((b) => ({ b, d: Math.hypot(centerOf(b).x - c.x, centerOf(b).y - c.y) }))
    .filter((x) => x.d <= ATTACK_RANGE)
    .sort((a, b) => a.d - b.d || a.b.id - b.b.id);
  return sources.flatMap((x) => spareSoldiers(w, x.b));
}

function attackable(target: Building | undefined, player: PlayerId): target is Building {
  return !!target && target.done && isMilitary(target) && target.owner !== player;
}

export function availableAttackers(w: World, targetId: number, player: PlayerId): number {
  const target = w.buildings.get(targetId);
  return attackable(target, player) ? attackers(w, target, player).length : 0;
}

/** Player command: send up to `count` soldiers against an enemy military building. Returns how many went. */
export function attack(w: World, targetId: number, count: number, player: PlayerId): number {
  const target = w.buildings.get(targetId);
  if (!attackable(target, player)) return 0;
  const sent = attackers(w, target, player).slice(0, Math.max(0, count));
  for (const s of sent) {
    const from = w.buildings.get(s.home!)!;
    leaveGarrison(w, from, s);
    s.tasks = [
      { t: 'goto', x: target.door.x, y: target.door.y, adj: true },
      { t: 'assault', b: target.id, n: 0 },
    ];
  }
  return sent.length;
}

/**
 * `assault` task, run by the attacker: duel the current defender (one blow every FIGHT_EVERY ticks,
 * either side may land it), call out the next one, or take the building once nobody defends it.
 */
export function assaultTick(w: World, s: Settler, task: Extract<Task, { t: 'assault' }>): void {
  const b = w.buildings.get(task.b);
  if (!b || !b.done) {
    s.tasks.shift();
    return;
  }
  if (b.owner === s.owner) {
    // A comrade got there first: reinforce it if there is room, otherwise go home.
    s.tasks.shift();
    if (garrisonSpace(b) > 0) sendToJoin(s, b);
    return;
  }
  if (s.opponent !== null) {
    const d = alive(w, s.opponent);
    if (!d) {
      s.opponent = null;
      return;
    }
    s.working = true;
    if (++task.n < FIGHT_EVERY) return;
    task.n = 0;
    const victim = w.rng() < 0.5 ? d : s;
    victim.hp -= DAMAGE[0] + randInt(w.rng, DAMAGE[1] - DAMAGE[0] + 1);
    if (victim.hp <= 0) killSettler(w, victim);
    return;
  }
  const defender = b.garrison
    .map((id) => alive(w, id))
    .find((d) => d && d.opponent === null && d.inside === b.id);
  if (defender) {
    defender.opponent = s.id;
    s.opponent = defender.id;
    defender.inside = null;
    defender.x = defender.px = b.door.x;
    defender.y = defender.py = b.door.y;
    task.n = 0;
    return;
  }
  // Defenders still out fighting other attackers: wait for the outcome.
  if (b.garrison.length > 0) return;
  conquer(w, b, s);
}

/** The attacker moves in: the building and its land change hands, enemy civil buildings there burn. */
function conquer(w: World, b: Building, s: Settler): void {
  const previous = b.owner;
  for (const o of w.settlers) {
    if (o.owner !== previous) continue;
    if (o.tasks.some((t) => 'b' in t && t.b === b.id)) abort(w, o);
    if (o.inside === b.id) o.inside = null;
  }
  b.owner = s.owner;
  b.priority = false;
  s.tasks.shift();
  enterGarrison(w, b, s);
  recomputeTerritory(w);
  for (const o of [...w.buildings.values()]) {
    if (isMilitary(o) || !onForeignLand(w, o)) continue;
    w.removeBuilding(o);
  }
}

function onForeignLand(w: World, b: Building): boolean {
  const m = w.map;
  for (let dy = 0; dy < b.h; dy++) {
    for (let dx = 0; dx < b.w; dx++) {
      const owner = m.owner[m.idx(b.x + dx, b.y + dy)];
      if (owner !== 0 && owner !== b.owner) return true;
    }
  }
  return false;
}

/**
 * Takes a settler out of the game: releases its jobs and reservations, frees its opponent and every
 * building slot that names it. It is removed from `World.settlers` at the end of the tick.
 */
export function killSettler(w: World, s: Settler): void {
  if (w.dying.has(s.id)) return;
  w.dying.add(s.id);
  s.hp = 0;
  if (s.opponent !== null) {
    const o = w.getSettler(s.opponent);
    s.opponent = null;
    if (o && o.opponent === s.id) {
      o.opponent = null;
      // A surviving defender goes back inside.
      const home = o.home !== null ? w.buildings.get(o.home) : undefined;
      if (home && home.garrison.includes(o.id) && o.tasks.length === 0) o.inside = home.id;
    }
  }
  abort(w, s);
  s.tasks = [];
  s.carrying = null;
  for (const b of w.buildings.values()) {
    if (b.garrison.includes(s.id)) leaveGarrison(w, b, s);
    if (b.workerId === s.id) {
      b.workerId = null;
      b.workerRequested = false;
    }
    if (b.builderId === s.id) b.builderId = null;
  }
}

/** End of tick: drop killed settlers from the world. */
export function removeDead(w: World): void {
  if (w.dying.size === 0) return;
  for (let i = w.settlers.length - 1; i >= 0; i--) {
    if (w.dying.has(w.settlers[i].id)) w.settlers.splice(i, 1);
  }
  for (const id of w.dying) w.settlerById.delete(id);
  w.dying.clear();
}
