/**
 * Specialists on hostile land, as in Settlers 4: a geologist, pioneer or thief standing on land of a
 * player who is neither his own nor an ally attracts that player's swordsmen, who walk up and cut him
 * down; a thief is disguised until a hostile fighter comes close (on any land, `CThiefRole`,
 * `ISelectableSettlerRole::ThiefCheckMasquerade`) and disguised again on land that is not hostile
 * with no enemy fighter near. A loaded donkey (`ProfessionDef.dropsLoad`) is an intruder too: a
 * blow makes it drop its load and go home (`donkeyHit`). The rules and their sources are in
 * `INTRUDERS` (config.ts).
 *
 * Cost: the scan runs every `INTRUDERS.scanEvery` ticks over the specialists and loaded donkeys only
 * (outdoor fighters and military buildings are looked at per thief or exposed intruder), so it follows
 * the number of intruders, not the map.
 */
import { combatOf, duelTick } from './combat';
import { INTRUDERS, PROFESSIONS } from './config';
import { dropGoods } from './ground';
import { abort } from './settlers';
import { packsOf } from './trade';
import { outdoorFighters } from './field';
import { isArcher, isFighter, isMilitary, keepOf, sendOut } from './military';
import { SPECIALIST_KINDS } from './specialists';
import type { Building, PlayerId, Point, Settler, SettlerKind, Task } from './types';
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

/** Kinds that may intrude: specialists, and professions that drop their load when hit (the donkey). */
const INTRUDING = new Set<SettlerKind>([
  ...SPECIALIST_KINDS,
  ...(Object.keys(PROFESSIONS) as SettlerKind[]).filter((k) => PROFESSIONS[k].dropsLoad),
]);

/** A specialist, or a donkey with goods in its packs (`ProfessionDef.dropsLoad`): who may intrude. */
function mayIntrude(s: Settler): boolean {
  return INTRUDING.has(s.kind) && (!PROFESSIONS[s.kind].dropsLoad || s.carrying !== null);
}

/** Whether `s` is an intruder outdoors on `host`'s land who may be attacked there now. */
export function isTarget(w: World, s: Settler, host: PlayerId): boolean {
  if (s.inside !== null || w.dying.has(s.id) || !mayIntrude(s)) return false;
  if (hostLand(w, s) !== host) return false;
  return !PROFESSIONS[s.kind].cloaked || !!s.exposed;
}

/** A fighter outdoors hostile to `s`'s owner within `r` of him (Settlers 4 `CScanner::FindAnyEnemyFighter`). */
function enemyFighterNear(w: World, s: Settler, r: number): boolean {
  for (const f of outdoorFighters(w)) {
    if (f.owner !== s.owner && !w.allied(f.owner, s.owner) && !w.dying.has(f.id) && dist(f, s) <= r) return true;
  }
  return false;
}

/**
 * A disguised specialist's mask (Settlers 4 `ThiefCheckMasquerade`): every `scanEvery` ticks a hostile
 * fighter within `decloakRadius` unmasks him, on any land — buildings never do; every `recloakEvery`
 * ticks an unmasked one standing on land that is his owner's, an ally's or nobody's, with no hostile
 * fighter within `recloakRadius`, is disguised again.
 */
function checkMask(w: World, s: Settler): void {
  if (!s.exposed) {
    if (enemyFighterNear(w, s, INTRUDERS.decloakRadius)) s.exposed = true;
    return;
  }
  if ((w.tick + s.id) % INTRUDERS.recloakEvery >= INTRUDERS.scanEvery) return;
  if (hostLand(w, s) === 0 && !enemyFighterNear(w, s, INTRUDERS.recloakRadius)) delete s.exposed;
}

/** Fighters already going for `target` (a `chase` of him in their tasks). */
export function chasers(w: World, target: Settler): number {
  let n = 0;
  for (const f of outdoorFighters(w)) if (f.tasks.some((t) => t.t === 'chase' && t.s === target.id)) n++;
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
  for (const s of w.settlers) {
    if (PROFESSIONS[s.kind].cloaked && s.inside === null && !w.dying.has(s.id)) checkMask(w, s);
  }
  for (const s of intruders(w)) {
    if (w.dying.has(s.id)) continue;
    const host = hostLand(w, s);
    if (!isTarget(w, s, host)) continue;
    if (chasers(w, s) >= INTRUDERS.responders) continue;
    const r = responder(w, host, s);
    if (!r) continue;
    sendOut(w, r.b, r.f);
    r.f.tasks = [{ t: 'chase', s: s.id, n: 0 }];
  }
}

/** Lets go of the intruder and gives up the chase. */
function quit(s: Settler, e: Settler | undefined): void {
  if (s.opponent !== null && s.opponent === e?.id) s.opponent = null;
  if (e && e.opponent === s.id) e.opponent = null;
  s.tasks.shift();
}

/**
 * `chase` task: walk up to the intruder (a `goto` inserted towards where he is); within
 * `INTRUDERS.seizeRadius` pin him (`opponent`: he stands, `updateSettler`); adjacent, strike at the
 * fighter's own pace with ordinary blows (`combat.ts`) — he does not fight back; what he carried is
 * lost with him (`killSettler`), and a donkey drops its load instead (`donkeyHit`). Ends when he is
 * dead, gone, indoors, disguised again, no intruder any more or off this fighter's land.
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
  if (s.opponent !== e.id) {
    // Just reached him: the first blow comes after a random part of the fighter's cadence.
    s.opponent = e.id;
    s.reload = w.rng() * (combatOf(s)?.every ?? 1);
  }
  s.working = true;
  duelTick(w, s, e, false);
  if (!w.dying.has(e.id)) return;
  w.stats.intrudersKilled++;
  quit(s, undefined);
}

/**
 * A blow on a loaded donkey (Settlers 4 `CDonkeyRole`: vulnerable while loaded): it is not hurt; it
 * drops its packs on the ground where it stands — they lie on that land, its owner's carriers take
 * them — and, its trip over, goes back to its markets (`donkeyIdle`).
 */
export function donkeyHit(w: World, s: Settler): void {
  const packs = packsOf(s);
  s.carrying = null;
  delete s.load;
  delete s.pack2;
  for (const p of packs) dropGoods(w, s, p.res, p.n);
  s.opponent = null;
  abort(w, s);
}

const intruderCache = new WeakMap<World, { tick: number; list: Settler[] }>();

/** Specialists and loaded donkeys outdoors on some hostile player's land, built once per tick (derived, not saved). */
function intruders(w: World): Settler[] {
  const c = intruderCache.get(w);
  if (c && c.tick === w.tick) return c.list;
  const list = w.settlers.filter((s) => s.inside === null && !w.dying.has(s.id) && mayIntrude(s) && hostLand(w, s) !== 0);
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
