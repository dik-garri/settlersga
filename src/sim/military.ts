/**
 * Soldiers, archers, garrisons and combat.
 *
 * Military buildings (`def.garrison`) hold fighters: swordsmen (`soldier`) and archers. New fighters
 * come only from a barracks (`def.barracks`): a carrier enters as its recruit, takes a weapon from its
 * pile, trains and walks to the nearest garrison with room. Empty slots are also filled by moving a
 * spare fighter out of a rear outpost. Every building keeps `keep`
 * fighters it never gives away. An attack sends spare fighters to an enemy military building; at its door each
 * attacker duels one defender at a time (`combat.ts`: both strike on their own timers; the defender
 * fights at his owner's defence strength, the attacker at his attack strength). Archers inside a
 * garrison shoot attackers approaching it (with the tower bonus, more at its door); attacking archers
 * shoot defenders who are busy duelling their comrades. When no defender is left, a swordsman (`combat.captures`) takes the
 * building over: ownership and territory change, and enemy civil buildings left on foreign land are
 * destroyed. As in Settlers 4, garrison slots have a kind (swordsmen or archers), a fighter's level is
 * bought with gold at the barracks and never changes, and wounded fighters heal only in an infirmary.
 * Allied players (`World.allied`) never attack each other.
 *
 * Removing a settler must go through `killSettler`, which clears every reference to it; the settler
 * itself leaves `World.settlers` at the end of the tick (`removeDead`).
 */
import { centerOf, claimsTerritory } from './buildings';
import { claimChanged } from './territory';
import { leaveSite } from './digging';
import { spareCarriers } from './economy';
import {
  ATTACK_RANGE,
  BUILDINGS,
  INPUT_CAP,
  OUTPUT_SHARES,
  GARRISON_KEEP,
  LEVEL_RES,
  PROFESSIONS,
  SHOT_TICKS,
  SOLDIER_LEVELS,
  WOUNDED_AT,
  WOUNDED_CHECK_EVERY,
  type GarrisonDef,
} from './config';
import { duelTick, maxHp, rearm, startDuel, strike } from './combat';
import { fieldIdle, fieldUnitsNear } from './field';
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

export { maxHp };

/** Free garrison slots not yet promised to an incoming soldier. */
export function garrisonSpace(b: Building): number {
  const def = BUILDINGS[b.type].garrison;
  return def ? def.capacity - b.garrison.length - b.garrisonInbound : 0;
}

const alive = (w: World, id: number): Settler | undefined => (w.dying.has(id) ? undefined : w.getSettler(id));

function members(w: World, b: Building): Settler[] {
  return b.garrison.map((id) => alive(w, id)).filter((s): s is Settler => !!s);
}

/** Garrison slots of one kind: `archers` of them for ranged fighters, the rest for melee ones. */
function slotsOf(b: Building, archer: boolean): number {
  const g = garrisonOf(b);
  const ranged = Math.min(g.capacity, g.archers ?? 0);
  return archer ? ranged : g.capacity - ranged;
}

/** Free slots of a kind, not yet promised to a fighter on his way in (0 for non-military buildings). */
export function slotsFree(w: World, b: Building, archer: boolean): number {
  if (!isMilitary(b) || !b.done) return 0;
  const inside = members(w, b).filter((s) => isArcher(s) === archer).length;
  const inbound = archer ? b.garrisonArchersInbound : b.garrisonInbound - b.garrisonArchersInbound;
  return slotsOf(b, archer) - inside - inbound;
}

export function enterGarrison(w: World, b: Building, s: Settler): void {
  const claimed = claimsTerritory(b);
  b.garrison.push(s.id);
  s.post = null;
  s.home = b.id;
  s.inside = b.id;
  s.x = s.px = b.door.x;
  s.y = s.py = b.door.y;
  if (claimsTerritory(b) !== claimed) claimChanged(w, b);
}

export function leaveGarrison(w: World, b: Building, s: Settler): void {
  const claimed = claimsTerritory(b);
  b.garrison = b.garrison.filter((id) => id !== s.id);
  if (s.home === b.id) s.home = null;
  if (s.inside === b.id) s.inside = null;
  if (claimsTerritory(b) !== claimed) claimChanged(w, b);
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
    while (room-- > 0 && b.unreachableUntil <= w.tick) {
      // Slot kinds still open: the first fighter of an empty outpost is a swordsman if possible (he
      // can hold it against a capture), then archer slots before melee ones.
      const kinds = (firstPass ? [false, true] : [true, false]).filter(
        (archer) => (!archer || RANGED_KIND !== undefined) && slotsFree(w, b, archer) > 0,
      );
      if (kinds.length === 0) break;
      // Donors: a reserve (`claimsWhenEmpty`) for any outpost; an empty outpost also takes from the nearest
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
      let moved = false;
      for (const archer of kinds) {
        const reserve = donors
          .map((r) => ({ r, spare: spareSoldiers(w, r, archer).filter((x) => isArcher(x) === archer) }))
          .find((x) => x.spare.length > 0);
        if (!reserve) continue;
        const s = reserve.spare[0];
        leaveGarrison(w, reserve.r, s);
        sendToJoin(s, b);
        moved = true;
        break;
      }
      if (!moved) break;
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
 * The player's army room: free garrison slots of each kind (archer / melee) minus fighters of that
 * kind already looking for one, and recruits in training (or on their way to a barracks).
 */
function armyRoom(w: World, owner: PlayerId): { archer: number; melee: number; training: number } {
  const out = { archer: 0, melee: 0, training: 0 };
  for (const o of w.buildings.values()) {
    if (o.owner !== owner || !o.done || !isMilitary(o)) continue;
    out.archer += slotsFree(w, o, true);
    out.melee += slotsFree(w, o, false);
  }
  for (const s of w.settlers) {
    if (s.owner !== owner || w.dying.has(s.id)) continue;
    if (s.kind === 'recruit' || s.tasks.some((t) => t.t === 'become' && t.kind === 'recruit')) out.training++;
    else if (isFighter(s) && s.home === null && !s.post && !s.tasks.some((t) => t.t === 'join' || t.t === 'heal')) {
      if (isArcher(s)) out.archer--;
      else out.melee--;
    }
  }
  return out;
}

/** Whether the barracks pile holds the weapon `r` and the rest of its fighter's kit (a leader's sword). */
function kitReady(b: Building, r: Resource): boolean {
  if (b.input[r] <= 0) return false;
  const kit = PROFESSIONS[fighterFor(r)].kit ?? {};
  return (Object.keys(kit) as Resource[]).every((k) => b.input[k] - (k === r ? 1 : 0) >= (kit[k] ?? 0));
}

/** Weapons on the barracks pile whose fighters still find a free garrison slot of their kind. */
function trainable(w: World, b: Building, room = armyRoom(w, b.owner)): Resource[] {
  return WEAPONS.filter((r) => kitReady(b, r) && (PROFESSIONS[fighterFor(r)].combat!.ranged ? room.archer : room.melee) > 0);
}

/**
 * Whether a barracks should call in a recruit now: it has a weapon whose fighters find a free slot of
 * their kind, the player has a carrier to spare above the carrier reserve (`spareCarriers`), and there
 * is more free garrison room than recruits already in training.
 */
export function wantsRecruit(w: World, b: Building): boolean {
  if (!WEAPONS.some((r) => b.input[r] > 0)) return false;
  if (spareCarriers(w, b.owner) <= 0) return false;
  const room = armyRoom(w, b.owner);
  return trainable(w, b, room).length > 0 && Math.max(0, room.archer) + Math.max(0, room.melee) > room.training;
}

/**
 * The level a recruit for `weapon` leaves at: the ordered one (at most his profession's highest), or
 * the highest the gold on the pile pays for.
 */
function recruitLevelAt(w: World, b: Building, weapon: Resource): number {
  const levels = PROFESSIONS[fighterFor(weapon)].combat!.levels.length;
  let level = Math.min(w.recruitLevel(b.owner), SOLDIER_LEVELS.length - 1, levels - 1);
  while (level > 0 && SOLDIER_LEVELS[level].cost > b.input[LEVEL_RES]) level--;
  return level;
}

/**
 * Per tick for a finished barracks: its recruit trains for `ticks`, then takes the weapon (among those
 * whose fighters find a free slot of their kind) the player's army is shortest of by `OUTPUT_SHARES`,
 * pays the gold of the level the player ordered (`setRecruitLevel`, falling back to what the pile
 * pays for) and leaves as that fighter, homeless, to find a garrison. With no slot for any weapon the
 * trained recruit waits.
 */
export function updateBarracks(w: World, b: Building): void {
  const s = w.getSettler(b.workerId);
  if (!s || s.inside !== b.id || w.dying.has(s.id)) return;
  if (!WEAPONS.some((r) => b.input[r] > 0)) return;
  const ticks = BUILDINGS[b.type].barracks!.ticks;
  if (b.timer < ticks) b.timer++;
  if (b.timer < ticks) return;
  const ready = trainable(w, b);
  if (ready.length === 0) return;
  b.timer = 0;
  const weapon = mostBehindShare(w, b.owner, ready, WEAPONS, (r) => fightersWith(w, b.owner, r)) ?? ready[0];
  const level = recruitLevelAt(w, b, weapon);
  b.input[weapon]--;
  const kit = PROFESSIONS[fighterFor(weapon)].kit ?? {};
  for (const k of Object.keys(kit) as Resource[]) b.input[k] -= kit[k] ?? 0;
  b.input[LEVEL_RES] -= SOLDIER_LEVELS[level].cost;
  s.kind = fighterFor(weapon);
  s.level = level;
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
  const enemies = [...w.buildings.values()].filter((e) => !w.allied(e.owner, owner) && e.done && isMilitary(e));
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
  // Its own reservation is still counted in the free slots, hence `< 0`.
  if (!b || !isMilitary(b) || !b.done || b.owner !== s.owner || slotsFree(w, b, isArcher(s)) < 0) return abort(w, s);
  releaseJoin(b, task);
  s.tasks.shift();
  enterGarrison(w, b, s);
}

/** Idle fighter: a field unit keeps its post; otherwise stay in the home garrison, or look for the nearest own one with room. */
export function soldierIdle(w: World, s: Settler): void {
  if (s.post) return fieldIdle(w, s);
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
  const archer = isArcher(s);
  for (const b of w.buildings.values()) {
    if (b.owner !== s.owner || !b.done || slotsFree(w, b, archer) <= 0) continue;
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

function attackable(w: World, target: Building | undefined, player: PlayerId): target is Building {
  return !!target && target.done && isMilitary(target) && !w.allied(target.owner, player);
}

export function availableAttackers(w: World, targetId: number, player: PlayerId): number {
  const target = w.buildings.get(targetId);
  return attackable(w, target, player) ? attackers(w, target, player).length : 0;
}

/** What an attack would send right now, by profession and level (for the attack dialog). */
export function attackerComposition(w: World, targetId: number, count: number, player: PlayerId): Settler[] {
  const target = w.buildings.get(targetId);
  return attackable(w, target, player) ? attackers(w, target, player).slice(0, Math.max(0, count)) : [];
}

/** Player command: send up to `count` fighters against an enemy military building. Returns how many went. */
export function attack(w: World, targetId: number, count: number, player: PlayerId): number {
  const target = w.buildings.get(targetId);
  if (!attackable(w, target, player)) return 0;
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

/** Enemies this close to a door stand at it (a tower's stone dropper hits them harder). */
const AT_DOOR = 1.5;

/**
 * An archer's shot (`combat.ts`): hits at once, the arrow is cosmetic. From a garrison (`tower`) it
 * deals the tower bonus, more at an enemy standing at that building's door.
 */
export function shoot(w: World, archer: Settler, target: Settler, from: Point, tower?: Building): void {
  const ranged = PROFESSIONS[archer.kind].combat!.ranged!;
  rearm(archer);
  w.shots.push({ x0: from.x, y0: from.y, x1: target.x, y1: target.y, tick: w.tick, owner: archer.owner });
  const atDoor = tower && Math.hypot(target.x - tower.door.x, target.y - tower.door.y) <= AT_DOOR;
  strike(w, archer, target, !tower ? 0 : atDoor ? ranged.towerDoor : ranged.tower);
}

/**
 * `assault` task, run by the attacker: duel the current defender (both strike on their own timers,
 * `duelTick`), or — for an archer — shoot defenders busy with comrades, call out the next defender (swordsmen
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
    // Caught on the way by a field unit (`field.ts`): his `engage` task runs that duel.
    if (!b.garrison.includes(d.id)) return;
    duelTick(w, s, d);
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
    startDuel(w, s, defender);
    return;
  }
  // Defenders still out fighting other attackers: wait for the outcome.
  if (b.garrison.length > 0) return;
  // Only swordsmen take buildings; an archer's job ends here, he looks for a garrison of his own.
  if (!PROFESSIONS[s.kind].combat?.captures) {
    s.tasks.shift();
    return;
  }
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
 * Per tick for a finished military building: archers inside shoot assailants in range; every
 * `WOUNDED_CHECK_EVERY` ticks, while it is not under attack, its wounded go to an infirmary.
 */
export function updateGarrison(w: World, b: Building, assaults: Map<number, Settler[]>): void {
  const inside = members(w, b).filter((s) => s.inside === b.id && s.opponent === null);
  if (inside.length === 0) return;
  for (const s of inside) {
    const ranged = PROFESSIONS[s.kind].combat?.ranged;
    if (!ranged) continue;
    if (s.reload > 0) s.reload--;
    if (s.reload <= 0) {
      const near = assailantsNear(w, b, ranged.range, assaults);
      // Enemy field units within range are fair game too.
      for (const f of fieldUnitsNear(w, b, ranged.range)) if (!near.includes(f)) near.push(f);
      const target = near.sort(
        (p, q) => Math.hypot(p.x - b.door.x, p.y - b.door.y) - Math.hypot(q.x - b.door.x, q.y - b.door.y) || p.id - q.id,
      )[0];
      if (target) shoot(w, s, target, b.door, b);
    }
  }
  if ((w.tick + b.id) % WOUNDED_CHECK_EVERY === 0 && !assaults.get(b.id)?.length) sendWounded(w, b, inside);
}

// ---------------------------------------------------------------- infirmary

/** Patients per infirmary (in bed or on the way), derived from tasks once per tick and world. */
const patientCache = new WeakMap<World, { tick: number; count: Map<number, number> }>();

function patients(w: World): Map<number, number> {
  const cached = patientCache.get(w);
  if (cached && cached.tick === w.tick) return cached.count;
  const count = new Map<number, number>();
  for (const s of w.settlers) {
    if (w.dying.has(s.id)) continue;
    for (const t of s.tasks) if (t.t === 'heal') count.set(t.b, (count.get(t.b) ?? 0) + 1);
  }
  patientCache.set(w, { tick: w.tick, count });
  return count;
}

/**
 * Wounded fighters (below `WOUNDED_AT` of their hit points) leave the garrison for the nearest own
 * infirmary in range with a free bed; the building keeps at least one fighter (its land) and its
 * `keep`. Without an infirmary nobody heals, as in Settlers 4.
 */
function sendWounded(w: World, b: Building, inside: Settler[]): void {
  const wounded = inside.filter((s) => s.hp < maxHp(s) * WOUNDED_AT).sort((p, q) => p.hp - q.hp || p.id - q.id);
  if (wounded.length === 0) return;
  const c = centerOf(b);
  const beds = patients(w);
  for (const s of wounded) {
    if (b.garrison.length <= Math.max(1, keepOf(b))) return;
    let best: Building | undefined;
    let bestD = Infinity;
    for (const o of w.buildings.values()) {
      const inf = BUILDINGS[o.type].infirmary;
      if (!inf || o.owner !== b.owner || !o.done || (beds.get(o.id) ?? 0) >= inf.beds) continue;
      const oc = centerOf(o);
      const d = Math.hypot(oc.x - c.x, oc.y - c.y);
      if (d <= inf.range && d < bestD) {
        best = o;
        bestD = d;
      }
    }
    if (!best) return;
    beds.set(best.id, (beds.get(best.id) ?? 0) + 1);
    leaveGarrison(w, b, s);
    s.tasks = [
      { t: 'goto', x: best.door.x, y: best.door.y },
      { t: 'heal', b: best.id, n: 0 },
    ];
  }
}

/** `heal` task: lie in the infirmary, one hit point every `healEvery` ticks, then find a garrison. */
export function healTick(w: World, s: Settler, task: Extract<Task, { t: 'heal' }>): void {
  const b = w.buildings.get(task.b);
  const inf = b ? BUILDINGS[b.type].infirmary : undefined;
  if (!b || !inf || !b.done || b.owner !== s.owner) {
    if (s.inside === task.b) s.inside = null;
    s.tasks.shift();
    return;
  }
  s.inside = b.id;
  if (++task.n < inf.healEvery) return;
  task.n = 0;
  s.hp = Math.min(maxHp(s), s.hp + 1);
  if (s.hp < maxHp(s)) return;
  s.inside = null;
  s.tasks.shift();
}

/**
 * Gold a barracks wants on its pile for the level its owner orders recruits at (two recruits' worth,
 * up to `cap`); nothing for level 0 or other buildings.
 */
export function goldWanted(w: World, b: Building, res: Resource, cap: number): number {
  if (res !== LEVEL_RES || !BUILDINGS[b.type].barracks || !b.done) return 0;
  const cost = SOLDIER_LEVELS[Math.min(w.recruitLevel(b.owner), SOLDIER_LEVELS.length - 1)].cost;
  if (cost === 0) return 0;
  return Math.min(cap, cost * 2) - b.input[res] - b.inbound[res];
}

/** End of tick: forget arrows that have landed (they are only drawn, never simulated). */
export function pruneShots(w: World): void {
  if (w.shots.length === 0) return;
  w.shots = w.shots.filter((s) => w.tick - s.tick < SHOT_TICKS);
}

/**
 * The attacker moves in: the building changes hands and takes, as in Settlers 4 (`territory.ts`), the
 * land of its disc its former owner covers no more; his buildings on land that changed hands burn,
 * and their people, homeless on foreign land, flee (`flee.ts`).
 */
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
  // Burnt as in Settlers 4: no materials back, the goods lying at them stay on the ground (`GROUND`).
  // A player left with nothing to fight with is out at the next `checkDefeats`.
  enterGarrison(w, b, s);
  claimChanged(w, b);
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
  // What he carried is lost with him; dropped first, so `abort` reserves no trip home for it.
  if (s.carrying) w.stats.lost[s.carrying] += s.load ?? 1;
  if (s.pack2) w.stats.lost[s.pack2.res] += s.pack2.n;
  delete s.pack2;
  s.carrying = null;
  abort(w, s);
  s.tasks = [];
  for (const b of w.buildings.values()) {
    if (b.garrison.includes(s.id)) leaveGarrison(w, b, s);
    if (b.workerId === s.id) {
      b.workerId = null;
      b.workerRequested = false;
    }
    leaveSite(b, s.id);
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
