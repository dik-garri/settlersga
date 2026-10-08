/**
 * Specialists on hostile land, as in Settlers 4: a geologist, pioneer or thief standing on land of a
 * player who is neither his own nor an ally attracts that player's swordsmen, who walk up and cut him
 * down; a thief is disguised until one of them comes close. The rules and their sources are in
 * `INTRUDERS` (config.ts).
 *
 * Cost: the scan runs every `INTRUDERS.scanEvery` ticks over the specialists only (outdoor fighters
 * and military buildings are looked at per exposed intruder), so it follows the number of intruders,
 * not the map.
 */
import { DAMAGE, FIGHT_EVERY, INTRUDERS, PROFESSIONS, SOLDIER_LEVELS } from './config';
import { moraleOf, outdoorFighters } from './field';
import { isArcher, isFighter, isMilitary, keepOf, killSettler, leaveGarrison } from './military';
import { randInt } from './rng';
import { SPECIALIST_KINDS } from './specialists';
import { fieldFactor } from './strength';
import type { Building, PlayerId, Point, Settler, Task } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Owner of the land under a settler (0: nobody's, or off the map). */
function landOwner(w: World, s: Point): PlayerId {
  const m = w.map;
  const x = Math.round(s.x);
  const y = Math.round(s.y);
  return m.inBounds(x, y) ? m.owner[m.idx(x, y)] : 0;
}

/** The player whose land `s` stands on, when that player is hostile to him (else 0). */
export function hostLand(w: World, s: Settler): PlayerId {
  const owner = landOwner(w, s);
  return owner !== 0 && owner !== s.owner && !w.allied(owner, s.owner) ? owner : 0;
}

/** Whether `s` is a specialist outdoors on hostile land who may be attacked there now. */
export function isTarget(w: World, s: Settler, host: PlayerId): boolean {
  if (s.inside !== null || w.dying.has(s.id) || !SPECIALIST_KINDS.includes(s.kind)) return false;
  if (hostLand(w, s) !== host) return false;
  return !PROFESSIONS[s.kind].cloaked || (s.exposedUntil ?? 0) > w.tick;
}

/** A fighter of `host` outdoors, or a garrisoned building of his, within `r` of `s`. */
function watchedBy(w: World, s: Settler, host: PlayerId, r: number): boolean {
  for (const f of outdoorFighters(w)) if (f.owner === host && dist(f, s) <= r) return true;
  for (const b of w.buildings.values()) {
    if (b.owner === host && b.garrison.length > 0 && dist(b.door, s) <= r) return true;
  }
  return false;
}

/** Fighters already going for `target` (their head task is a `chase` of him). */
function chasers(w: World, target: Settler): number {
  let n = 0;
  for (const f of outdoorFighters(w)) {
    const t = f.tasks[0];
    if (t?.t === 'chase' && t.s === target.id) n++;
  }
  return n;
}

/** The nearest military building of `host` within `respondRadius` with a melee fighter to spare. */
function responder(w: World, host: PlayerId, at: Settler): { b: Building; f: Settler } | null {
  let best: { b: Building; f: Settler } | null = null;
  let bestD = Infinity;
  for (const b of w.buildings.values()) {
    if (b.owner !== host || !b.done || !isMilitary(b)) continue;
    const d = dist(b.door, at);
    if (d > INTRUDERS.respondRadius || d >= bestD) continue;
    if (b.garrison.length <= keepOf(b)) continue;
    let f: Settler | undefined;
    for (const id of [...b.garrison].sort((p, q) => p - q)) {
      const s = w.getSettler(id);
      if (s && !w.dying.has(id) && s.inside === b.id && s.opponent === null && !isArcher(s)) {
        f = s;
        break;
      }
    }
    if (!f) continue;
    best = { b, f };
    bestD = d;
  }
  return best;
}

/**
 * Every `INTRUDERS.scanEvery` ticks: unmask disguised intruders watched from close by, and send a
 * responder at each exposed one that is not chased enough yet.
 */
export function updateIntruders(w: World): void {
  if (w.tick % INTRUDERS.scanEvery !== 0) return;
  for (const s of intruders(w)) {
    if (w.dying.has(s.id)) continue;
    const host = hostLand(w, s);
    if (PROFESSIONS[s.kind].cloaked && (s.exposedUntil ?? 0) <= w.tick) {
      if (!watchedBy(w, s, host, INTRUDERS.decloakRadius)) continue;
      s.exposedUntil = w.tick + INTRUDERS.exposedTicks;
    }
    if (chasers(w, s) >= INTRUDERS.responders) continue;
    const r = responder(w, host, s);
    if (!r) continue;
    leaveGarrison(w, r.b, r.f);
    r.f.tasks = [{ t: 'chase', s: s.id, n: 0 }];
  }
}

const meleeOf = (s: Settler) => SOLDIER_LEVELS[s.level].damage * (PROFESSIONS[s.kind].combat?.melee ?? 1);

/** Lets go of the intruder and gives up the chase. */
function quit(s: Settler, e: Settler | undefined): void {
  if (s.opponent !== null && s.opponent === e?.id) s.opponent = null;
  if (e && e.opponent === s.id) e.opponent = null;
  s.tasks.shift();
}

/**
 * `chase` task: walk up to the intruder (a `goto` inserted towards where he is); within
 * `INTRUDERS.seizeRadius` pin him (`opponent`: he stands, `updateSettler`); adjacent, strike every
 * `FIGHT_EVERY` ticks — he does not fight back. Ends when he is dead, gone, indoors, disguised again or
 * off this fighter's land.
 */
export function chaseTick(w: World, s: Settler, task: Extract<Task, { t: 'chase' }>): void {
  const e = w.getSettler(task.s);
  if (!e || !isTarget(w, e, s.owner) || (e.opponent !== null && e.opponent !== s.id)) return quit(s, e);
  const d = dist(s, e);
  // Caught: he stands while the swordsman closes the last steps.
  if (d <= INTRUDERS.seizeRadius) e.opponent = s.id;
  if (d > 1.2) {
    // While walking the fighter has no opponent (one with an opponent stands still, `updateSettler`).
    if (s.opponent === e.id) s.opponent = null;
    s.tasks.unshift({ t: 'goto', x: Math.round(e.x), y: Math.round(e.y) });
    return;
  }
  s.opponent = e.id;
  s.working = true;
  if (++task.n < FIGHT_EVERY) return;
  task.n = 0;
  const base = DAMAGE[0] + randInt(w.rng, DAMAGE[1] - DAMAGE[0] + 1);
  e.hp -= base * meleeOf(s) * fieldFactor(w, s) * moraleOf(w, s);
  if (e.hp > 0) return;
  if (e.carrying) w.stats.lost[e.carrying]++;
  e.carrying = null;
  w.stats.intrudersKilled++;
  killSettler(w, e);
  quit(s, undefined);
}

const intruderCache = new WeakMap<World, { tick: number; list: Settler[] }>();

/** Specialists outdoors on some hostile player's land, built once per tick (derived, not saved). */
function intruders(w: World): Settler[] {
  const c = intruderCache.get(w);
  if (c && c.tick === w.tick) return c.list;
  const list = w.settlers.filter((s) => s.inside === null && !w.dying.has(s.id) && SPECIALIST_KINDS.includes(s.kind) && hostLand(w, s) !== 0);
  intruderCache.set(w, { tick: w.tick, list });
  return list;
}

/** The nearest exposed intruder on `s`'s owner's land within `range` (for field units), or undefined. */
export function nearestIntruder(w: World, s: Settler, range: number): Settler | undefined {
  if (!isFighter(s)) return undefined;
  let best: Settler | undefined;
  let bestD = Infinity;
  for (const o of intruders(w)) {
    const d = dist(o, s);
    if (d > range || d > bestD || (d === bestD && best && o.id > best.id)) continue;
    if (!isTarget(w, o, s.owner)) continue;
    best = o;
    bestD = d;
  }
  return best;
}
