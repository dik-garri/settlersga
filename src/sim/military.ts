/**
 * Soldiers, archers, garrisons and combat.
 *
 * Military buildings (`def.garrison`) hold fighters: swordsmen (`soldier`) and archers. New fighters
 * come only from a barracks (`def.barracks`): a carrier enters as its recruit, takes a weapon from its
 * pile, trains and walks to the nearest garrison with room. Empty slots are also filled by moving a
 * spare fighter out of a reserve building (the castle) or a rear outpost. Every building keeps `keep`
 * fighters it never gives away. An attack sends spare fighters to an enemy military building; at its door each
 * attacker duels one defender at a time (defenders are stronger by the building's `defense`).
 * Archers inside a garrison shoot attackers approaching it; attacking archers shoot defenders who are
 * busy duelling their comrades. When no defender is left, the attacker takes the building over:
 * ownership and territory change, and enemy civil buildings left on foreign land are destroyed.
 * Fighters inside a garrison heal, and gold delivered to a building that `trains` promotes them.
 *
 * Removing a settler must go through `killSettler`, which clears every reference to it; the settler
 * itself leaves `World.settlers` at the end of the tick (`removeDead`).
 */
import { centerOf, claimsTerritory, recomputeTerritory } from './buildings';
import {
  ATTACK_RANGE,
  BARRACKS_MIN_IDLE,
  BUILDINGS,
  INPUT_CAP,
  OUTPUT_SHARES,
  DAMAGE,
  FIGHT_EVERY,
  GARRISON_KEEP,
  HEAL_EVERY,
  PROFESSIONS,
  PROMOTE_COST,
  PROMOTE_RES,
  PROMOTE_TICKS,
  SHOT_TICKS,
  SOLDIER_LEVELS,
  type GarrisonDef,
} from './config';
import { randInt } from './rng';
import { abort } from './settlers';
import type { Building, PlayerId, Point, Resource, Settler, SettlerKind, Task } from './types';
import type { World } from './world';

/** Professions that fight, in recruiting preference (melee first). */
export const FIGHTERS: readonly SettlerKind[] = (Object.keys(PROFESSIONS) as SettlerKind[]).filter(
  (k) => PROFESSIONS[k].combat,
);
const RANGED_KIND = FIGHTERS.find((k) => PROFESSIONS[k].combat!.ranged);

export function isFighter(s: Settler): boolean {
  return !!PROFESSIONS[s.kind].combat;
}

export function isArcher(s: Settler): boolean {
  return !!PROFESSIONS[s.kind].combat?.ranged;
}

export function isMilitary(b: Building): boolean {
  return !!BUILDINGS[b.type].garrison;
}

function garrisonOf(b: Building): GarrisonDef {
  return BUILDINGS[b.type].garrison!;
}

/** Fighters the building never gives away to man others or to attack. */
export function keepOf(b: Building): number {
  return garrisonOf(b).keep ?? GARRISON_KEEP;
}

export function maxHp(s: Settler): number {
  return Math.round((PROFESSIONS[s.kind].hp ?? 0) * SOLDIER_LEVELS[s.level].hp);
}

/** Melee strength: rank × profession, × the building's defense when fighting at its own door. */
function strength(s: Settler, defending: Building | null): number {
  const melee = PROFESSIONS[s.kind].combat?.melee ?? 1;
  return SOLDIER_LEVELS[s.level].damage * melee * (defending ? (garrisonOf(defending).defense ?? 1) : 1);
}

/** Free garrison slots not yet promised to an incoming soldier. */
export function garrisonSpace(b: Building): number {
  const def = BUILDINGS[b.type].garrison;
  return def ? def.capacity - b.garrison.length - b.garrisonInbound : 0;
}

const alive = (w: World, id: number): Settler | undefined => (w.dying.has(id) ? undefined : w.getSettler(id));

function members(w: World, b: Building): Settler[] {
  return b.garrison.map((id) => alive(w, id)).filter((s): s is Settler => !!s);
}

/** Archer slots still to fill (counting archers already on their way). */
function archersWanted(w: World, b: Building): number {
  return Math.max(0, (garrisonOf(b).archers ?? 0) - members(w, b).filter(isArcher).length - b.garrisonArchersInbound);
}

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

/**
 * Garrisoned fighters that may leave: inside, not fighting, beyond the `keep` the building holds back.
 * With a role (`archer` true/false) that role comes first, for manning slots; without one (attacks)
 * swordsmen and archers alternate, so an attack is a mixed party.
 */
function spareSoldiers(w: World, b: Building, archer?: boolean): Settler[] {
  const ready = members(w, b).filter((s) => s.inside === b.id && s.opponent === null);
  const melee = ready.filter((s) => !isArcher(s)).sort((p, q) => p.id - q.id);
  const ranged = ready.filter(isArcher).sort((p, q) => p.id - q.id);
  let order: Settler[];
  if (archer === true) order = [...ranged, ...melee];
  else if (archer === false) order = [...melee, ...ranged];
  else {
    order = [];
    for (let k = 0; k < Math.max(melee.length, ranged.length); k++) {
      if (k < melee.length) order.push(melee[k]);
      if (k < ranged.length) order.push(ranged[k]);
    }
  }
  return order.slice(0, Math.max(0, Math.min(order.length, b.garrison.length - keepOf(b))));
}

/**
 * Logistics step: fill military buildings' free slots, outposts before reserves, by moving a spare
 * fighter of the wanted role from a reserve building (the castle) or an outpost further back. New
 * fighters are not made here — barracks train them (`updateBarracks`), and they find a free slot
 * themselves (`soldierIdle`).
 */
export function staffGarrisons(w: World, own: Building[]): void {
  const military = own.filter((b) => b.done && isMilitary(b));
  const outposts = military.filter((b) => !garrisonOf(b).claimsWhenEmpty);
  const reserves = military.filter((b) => garrisonOf(b).claimsWhenEmpty);
  // First one fighter for every empty outpost (that is what claims its land), then fill them up.
  const empty = outposts.filter((b) => b.garrison.length + b.garrisonInbound === 0);
  const frontDistance = distancesToEnemy(w, outposts);
  for (const b of [...empty, ...outposts, ...reserves]) {
    const firstPass = empty.includes(b) && b.garrison.length + b.garrisonInbound === 0;
    let room = firstPass ? 1 : Infinity;
    while (room-- > 0 && garrisonSpace(b) > 0 && b.unreachableUntil <= w.tick) {
      const wantArcher = RANGED_KIND !== undefined && archersWanted(w, b) > 0;
      // Donors: the reserve (castle) for any outpost; an empty outpost also takes from the nearest
      // other outpost with spares, and any outpost from outposts further from the enemy — fighters
      // move from the rear to the front, never back, so this cannot cycle.
      const front = frontDistance.get(b.id) ?? Infinity;
      const donors = !outposts.includes(b)
        ? []
        : [
            ...reserves,
            ...outposts
              .filter((o) => o !== b && (firstPass || (frontDistance.get(o.id) ?? Infinity) > front + 1))
              .sort((p, q) => distance(p, b) - distance(q, b) || p.id - q.id),
          ];
      const reserve = donors.map((r) => ({ r, spare: spareSoldiers(w, r, wantArcher) })).find((x) => x.spare.length > 0);
      if (!reserve) break;
      const s = reserve.spare[0];
      leaveGarrison(w, reserve.r, s);
      sendToJoin(s, b);
    }
  }
}

// ---------------------------------------------------------------- barracks

/** Weapons a barracks trains with: the tools of the fighting professions. */
const WEAPONS: readonly Resource[] = FIGHTERS.map((k) => PROFESSIONS[k].tool!);

const fighterFor = (weapon: Resource) => FIGHTERS.find((k) => PROFESSIONS[k].tool === weapon)!;

/** Weapons a finished barracks wants on its pile (each up to the input limit). */
export function weaponsWanted(b: Building, res: Resource): number {
  if (!BUILDINGS[b.type].barracks || !b.done || !WEAPONS.includes(res)) return 0;
  return INPUT_CAP - b.input[res] - b.inbound[res];
}

/** The player's weight for an output among `choices` as a fraction (OUTPUT_SHARES defaults). */
export function shareTargets(w: World, owner: PlayerId, choices: readonly Resource[]): Map<Resource, number> | null {
  if (choices.length === 0 || !choices.every((r) => OUTPUT_SHARES[r] !== undefined)) return null;
  const p = w.players.find((q) => q.id === owner);
  const weights = choices.map((r) => p?.shares?.[r] ?? OUTPUT_SHARES[r]!);
  const total = weights.reduce((a, b) => a + b, 0);
  return new Map(choices.map((r, k) => [r, total > 0 ? weights[k] / total : 1 / choices.length]));
}

/** Living fighters of the player whose weapon is `res` (in garrisons, walking, attacking). */
export function fightersWith(w: World, owner: PlayerId, res: Resource): number {
  let n = 0;
  for (const s of w.settlers) if (s.owner === owner && !w.dying.has(s.id) && isFighter(s) && PROFESSIONS[s.kind].tool === res) n++;
  return n;
}

/**
 * Of `candidates`, the one furthest below the player's target share, given how many units of each the
 * player already `has`. Ties: candidate order.
 */
export function mostBehindShare(
  w: World,
  owner: PlayerId,
  candidates: readonly Resource[],
  all: readonly Resource[],
  has: (r: Resource) => number,
): Resource | null {
  const target = shareTargets(w, owner, all);
  if (!target) return null;
  const total = all.reduce((n, r) => n + has(r), 0);
  let best: Resource | null = null;
  let bestGap = -Infinity;
  for (const r of candidates) {
    const gap = target.get(r)! * (total + 1) - has(r);
    if (gap > bestGap) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Whether a barracks should call in a recruit now: it has a weapon, the player keeps
 * `BARRACKS_MIN_IDLE` idle carriers, and there is more free garrison room than fighters already
 * looking for one (homeless or in training).
 */
export function wantsRecruit(w: World, b: Building): boolean {
  if (!WEAPONS.some((r) => b.input[r] > 0)) return false;
  let idle = 0;
  let looking = 0;
  for (const s of w.settlers) {
    if (s.owner !== b.owner || w.dying.has(s.id)) continue;
    if (s.kind === 'carrier' && s.tasks.length === 0) idle++;
    else if (s.kind === 'recruit' || (isFighter(s) && s.home === null)) looking++;
    else if (s.tasks.some((t) => t.t === 'become' && t.kind === 'recruit')) looking++;
  }
  if (idle < BARRACKS_MIN_IDLE) return false;
  let room = 0;
  for (const o of w.buildings.values()) if (o.owner === b.owner && o.done && isMilitary(o)) room += garrisonSpace(o);
  return room > looking;
}

/**
 * Per tick for a finished barracks: its recruit trains with the weapon the player's army is shortest
 * of (by `OUTPUT_SHARES`) and leaves as that fighter, homeless, to find a garrison.
 */
export function updateBarracks(w: World, b: Building): void {
  const s = w.getSettler(b.workerId);
  if (!s || s.inside !== b.id || w.dying.has(s.id)) return;
  const ready = WEAPONS.filter((r) => b.input[r] > 0);
  if (ready.length === 0) return;
  if (++b.timer < BUILDINGS[b.type].barracks!.ticks) return;
  b.timer = 0;
  const weapon = mostBehindShare(w, b.owner, ready, WEAPONS, (r) => fightersWith(w, b.owner, r)) ?? ready[0];
  b.input[weapon]--;
  s.kind = fighterFor(weapon);
  s.level = 0;
  s.hp = maxHp(s);
  s.home = null;
  s.inside = null;
  s.tasks = [];
  b.workerId = null;
  b.workerRequested = false;
  w.stats.trained++;
}

const distance = (a: Building, b: Building) => Math.hypot(a.door.x - b.door.x, a.door.y - b.door.y);

/** Each building's distance to the nearest enemy military building (none known: not in the map). */
function distancesToEnemy(w: World, own: Building[]): Map<number, number> {
  const out = new Map<number, number>();
  if (own.length === 0) return out;
  const owner = own[0].owner;
  const enemies = [...w.buildings.values()].filter((e) => e.owner !== owner && e.done && isMilitary(e));
  if (enemies.length === 0) return out;
  for (const b of own) out.set(b.id, Math.min(...enemies.map((e) => distance(b, e))));
  return out;
}

function sendToJoin(s: Settler, b: Building): void {
  const archer = isArcher(s);
  b.garrisonInbound++;
  if (archer) b.garrisonArchersInbound++;
  s.tasks = [
    { t: 'goto', x: b.door.x, y: b.door.y },
    { t: 'join', b: b.id, archer },
  ];
}

/** Releases a `join` reservation (on arrival or when the job is aborted). */
export function releaseJoin(b: Building, task: Extract<Task, { t: 'join' }>): void {
  b.garrisonInbound--;
  if (task.archer) b.garrisonArchersInbound--;
}

/** `join` task: move into the garrison if it is still ours and has room; otherwise give up. */
export function joinTick(w: World, s: Settler, task: Extract<Task, { t: 'join' }>): void {
  const b = w.buildings.get(task.b);
  const def = b ? BUILDINGS[b.type].garrison : undefined;
  if (!b || !def || !b.done || b.owner !== s.owner || b.garrison.length >= def.capacity) return abort(w, s);
  releaseJoin(b, task);
  s.tasks.shift();
  enterGarrison(w, b, s);
}

/** Idle fighter: stay in the home garrison, or look for the nearest own one with room. */
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

/** Fighters of `player` that `attack` would send against the target (spares within range). */
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

/** What an attack would send right now, by profession and level (for the attack dialog). */
export function attackerComposition(w: World, targetId: number, count: number, player: PlayerId): Settler[] {
  const target = w.buildings.get(targetId);
  return attackable(target, player) ? attackers(w, target, player).slice(0, Math.max(0, count)) : [];
}

/** Player command: send up to `count` fighters against an enemy military building. Returns how many went. */
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

/** One blow of a duel: either side may land it, in proportion to its strength. */
function blow(w: World, attacker: Settler, defender: Settler, b: Building): void {
  const sa = strength(attacker, null);
  const sd = strength(defender, b);
  const hitter = w.rng() < sd / (sa + sd) ? defender : attacker;
  const victim = hitter === defender ? attacker : defender;
  const base = DAMAGE[0] + randInt(w.rng, DAMAGE[1] - DAMAGE[0] + 1);
  victim.hp -= base * strength(hitter, null);
  if (victim.hp <= 0) killSettler(w, victim);
}

/** An archer's shot: hits at once for the profession's ranged damage × rank; the arrow is cosmetic. */
function shoot(w: World, archer: Settler, target: Settler, from: Point): void {
  const ranged = PROFESSIONS[archer.kind].combat!.ranged!;
  archer.reload = ranged.every;
  w.shots.push({ x0: from.x, y0: from.y, x1: target.x, y1: target.y, tick: w.tick, owner: archer.owner });
  target.hp -= (ranged.damage[0] + randInt(w.rng, ranged.damage[1] - ranged.damage[0] + 1)) * SOLDIER_LEVELS[archer.level].damage;
  if (target.hp <= 0) killSettler(w, target);
}

/**
 * `assault` task, run by the attacker: duel the current defender (one blow every FIGHT_EVERY ticks),
 * or — for an archer — shoot defenders busy with comrades, call out the next defender (swordsmen
 * first), or take the building once nobody defends it.
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
    blow(w, s, d, b);
    return;
  }
  const defenders = members(w, b);
  if (isArcher(s)) {
    // Support fire: shoot a defender who is out duelling one of ours.
    const range = PROFESSIONS[s.kind].combat!.ranged!.range;
    const busy = defenders
      .filter((d) => d.opponent !== null && Math.hypot(d.x - s.x, d.y - s.y) <= range)
      .sort((p, q) => p.hp - q.hp || p.id - q.id)[0];
    if (busy) {
      s.working = true;
      if (--s.reload <= 0) shoot(w, s, busy, s);
      return;
    }
  }
  const defender = defenders
    .filter((d) => d.opponent === null && d.inside === b.id)
    .sort((p, q) => Number(isArcher(p)) - Number(isArcher(q)) || p.id - q.id)[0];
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

/** Attackers (assaulting this building, or on their way to) within `range` tiles of its door. */
function assailantsNear(w: World, b: Building, range: number, assaults: Map<number, Settler[]>): Settler[] {
  return (assaults.get(b.id) ?? []).filter(
    (a) => !w.dying.has(a.id) && Math.hypot(a.x - b.door.x, a.y - b.door.y) <= range,
  );
}

/** Settlers currently on an assault, keyed by the building they assault (built once per tick). */
export function assaultsByTarget(w: World): Map<number, Settler[]> {
  const out = new Map<number, Settler[]>();
  for (const s of w.settlers) {
    const t = s.tasks.find((k) => k.t === 'assault');
    if (!t || t.t !== 'assault') continue;
    const list = out.get(t.b);
    if (list) list.push(s);
    else out.set(t.b, [s]);
  }
  return out;
}

/**
 * Per tick for a finished military building: archers inside shoot assailants in range, fighters
 * inside heal, and gold promotes the weakest fighter inside if the building `trains`.
 */
export function updateGarrison(w: World, b: Building, assaults: Map<number, Settler[]>): void {
  const inside = members(w, b).filter((s) => s.inside === b.id && s.opponent === null);
  if (inside.length === 0) return;
  for (const s of inside) {
    const ranged = PROFESSIONS[s.kind].combat?.ranged;
    if (ranged) {
      if (s.reload > 0) s.reload--;
      if (s.reload <= 0) {
        const target = assailantsNear(w, b, ranged.range, assaults).sort(
          (p, q) => Math.hypot(p.x - b.door.x, p.y - b.door.y) - Math.hypot(q.x - b.door.x, q.y - b.door.y) || p.id - q.id,
        )[0];
        if (target) shoot(w, s, target, b.door);
      }
    }
    if (w.tick % HEAL_EVERY === 0 && s.hp < maxHp(s)) s.hp++;
  }
  if (!garrisonOf(b).trains) return;
  const pupil = promotable(w, b);
  if (!pupil) return;
  const pile = BUILDINGS[b.type].storage ? b.output : b.input;
  if (pile[PROMOTE_RES] - (BUILDINGS[b.type].storage ? b.outReserved[PROMOTE_RES] : 0) < PROMOTE_COST) return;
  if (++b.timer < PROMOTE_TICKS) return;
  b.timer = 0;
  pile[PROMOTE_RES] -= PROMOTE_COST;
  pupil.level++;
  pupil.hp = maxHp(pupil);
}

/** The lowest-ranked fighter inside who can still be promoted, or undefined. */
function promotable(w: World, b: Building): Settler | undefined {
  return members(w, b)
    .filter((s) => s.inside === b.id && s.opponent === null && s.level < SOLDIER_LEVELS.length - 1)
    .sort((p, q) => p.level - q.level || p.id - q.id)[0];
}

/** Gold a training building still wants delivered (its input pile; warehouses train from their stock). */
export function goldWanted(w: World, b: Building, res: Resource, cap: number): number {
  const def = BUILDINGS[b.type];
  if (res !== PROMOTE_RES || !def.garrison?.trains || def.storage || !b.done || !promotable(w, b)) return 0;
  return cap - b.input[res] - b.inbound[res];
}

/** End of tick: forget arrows that have landed (they are only drawn, never simulated). */
export function pruneShots(w: World): void {
  if (w.shots.length === 0) return;
  w.shots = w.shots.filter((s) => w.tick - s.tick < SHOT_TICKS);
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
  // Losing the castle loses the game.
  if (w.players.some((p) => p.id === previous && p.castleId === b.id)) w.defeatPlayer(previous);
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
