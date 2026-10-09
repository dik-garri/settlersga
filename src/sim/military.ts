/**
 * Soldiers, archers, garrisons and combat, as in Settlers 4 (sources in `docs/S4-AUDIT.md` items 1, 4,
 * 5 and 7: `CMilitaryBuildingRole`, `CBarrackRole`, `CTowerSoldier`, `CDoorRole`).
 *
 * - **Barracks** (`def.barracks`) work only by their owner's recruit orders (`economy.ts`
 *   `recruitOrders`, by kind and level; none by default). About once a second a barracks takes the
 *   order of the highest rank its pile pays for (weapon, `kit`, the level's gold; kinds of one rank
 *   take turns), calls the nearest free carrier on its land and takes those goods off its pile for
 *   him; he walks in and comes out as that fighter, standing free by the barracks. His walk is the
 *   training.
 * - **Garrisons:** a military building calls free fighters in up to its owner's wish
 *   (`Building.wish`, per kind): an empty one with no wish asks for one fighter — a swordsman if
 *   there is one, else an archer —, more only when the player fills it or sends fighters in by hand.
 *   It looks for free fighters (outdoors, no post, no garrison, idle) in rings round its door, the
 *   highest level first; with nobody free it stays empty, holds no land and its owner is warned. A
 *   fighter beyond the wish is put out of the door, one at a time and only while no enemy is near.
 *   Fighters never move between buildings by themselves.
 * - **Attacks:** an attack sends free fighters and the spares of military buildings (beyond `keep`)
 *   within `ATTACK_RANGE`. At a held building with a door the attackers first break the door, then
 *   duel its defenders one at a time (`combat.ts`; swordsmen come out first). Garrison archers shoot
 *   enemy fighters on their side's land or nobody's within their tower range. When no defender is
 *   left, a swordsman or archer (`combat.captures`) takes the building over alone: ownership and land
 *   change (`territory.ts`), and the rest stay outside. The squad leader neither takes nor holds one.
 * - A fighter's level is bought with gold at the barracks and never changes; wounded fighters heal
 *   only at an infirmary's door (`infirmary.ts`). Allied players (`World.allied`) never attack each other.
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
  BARRACKS_EVERY,
  BUILDINGS,
  FIELD,
  GARRISON_KEEP,
  GARRISON_ORDERS,
  INPUT_CAP,
  LEVEL_RES,
  OUTPUT_SHARES,
  PROFESSIONS,
  SHOT_TICKS,
  SOLDIER_LEVELS,
  type GarrisonDef,
} from './config';
import { duelTick, hitDamage, maxHp, rearm, startDuel, strike } from './combat';
import { economyOf, ENDLESS, recruitCalled } from './economy';
import { fieldIdle, formationSpots, freeIdle, outdoorFighters } from './field';
import { dropGoods } from './ground';
import { landAt, landOf } from './land';
import { postMessage } from './messages';
import { sameRegion } from './regions';
import { abort } from './settlers';
import type { Building, PlayerId, Point, Resource, Settler, SettlerKind, Stock, Task } from './types';
import type { WarStats, World } from './world';

/** Professions that fight. */
export const FIGHTERS: readonly SettlerKind[] = (Object.keys(PROFESSIONS) as SettlerKind[]).filter(
  (k) => PROFESSIONS[k].combat,
);

export function isFighter(s: Settler): boolean {
  return !!PROFESSIONS[s.kind].combat;
}

export function isArcher(s: Settler): boolean {
  return !!PROFESSIONS[s.kind].combat?.ranged;
}

/** A fighter who may hold a garrison slot (not the squad leader, `combat.fieldOnly`). */
export function canGarrison(s: Settler): boolean {
  const c = PROFESSIONS[s.kind].combat;
  return !!c && !c.fieldOnly;
}

export function isMilitary(b: Building): boolean {
  return !!BUILDINGS[b.type].garrison;
}

function garrisonOf(b: Building): GarrisonDef {
  return BUILDINGS[b.type].garrison!;
}

/** Fighters the building never gives away to attack or to chase intruders. */
export function keepOf(b: Building): number {
  return garrisonOf(b).keep ?? GARRISON_KEEP;
}

export { maxHp };

const alive = (w: World, id: number): Settler | undefined => (w.dying.has(id) ? undefined : w.getSettler(id));

function members(w: World, b: Building): Settler[] {
  return b.garrison.map((id) => alive(w, id)).filter((s): s is Settler => !!s);
}

/** Garrison slots of one kind: `archers` of them for ranged fighters, the rest for melee ones. */
export function slotsOf(b: Building, archer: boolean): number {
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

/** The building's wish (Settlers 4's wished swordsmen and bowmen), created empty on first use. */
export function wishOf(b: Building): { melee: number; ranged: number } {
  return (b.wish ??= { melee: 0, ranged: 0 });
}

/** Fighters of each kind inside (or bound to) the building and on their way in. */
export function garrisonCounts(w: World, b: Building): { melee: number; ranged: number; inMelee: number; inRanged: number } {
  let ranged = 0;
  let melee = 0;
  for (const s of members(w, b)) {
    if (isArcher(s)) ranged++;
    else melee++;
  }
  return { melee, ranged, inMelee: b.garrisonInbound - b.garrisonArchersInbound, inRanged: b.garrisonArchersInbound };
}

export function enterGarrison(w: World, b: Building, s: Settler): void {
  const claimed = claimsTerritory(b);
  // Manned again from empty: a new door (Settlers 4 `InsertDoor` at the first fighter in).
  if (b.garrison.length === 0) delete b.doorHp;
  // Manned from empty, it sees its `sight` (`fog.ts` rebuilds vision on this version).
  if (b.garrison.length === 0 && BUILDINGS[b.type].sight) w.buildingsVersion++;
  b.garrison.push(s.id);
  s.post = null;
  s.home = b.id;
  s.inside = b.id;
  s.x = s.px = b.door.x;
  s.y = s.py = b.door.y;
  // Whoever is let in is wished for (a fighter only comes when ordered, `raiseWish`).
  const wish = wishOf(b);
  const c = garrisonCounts(w, b);
  if (isArcher(s)) wish.ranged = Math.max(wish.ranged, c.ranged);
  else wish.melee = Math.max(wish.melee, c.melee);
  if (claimsTerritory(b) !== claimed) claimChanged(w, b);
}

/**
 * A fighter sent out of the garrison by an order (an attack, a chase): he leaves and the building
 * wishes one fewer of his kind, so it does not call him straight back (Settlers 4 `ThrowOutId`
 * lowers the wish with the count).
 */
export function sendOut(w: World, b: Building, s: Settler): void {
  const wish = wishOf(b);
  const key = isArcher(s) ? 'ranged' : 'melee';
  leaveGarrison(w, b, s);
  wish[key] = Math.max(0, wish[key] - 1);
}

export function leaveGarrison(w: World, b: Building, s: Settler): void {
  const claimed = claimsTerritory(b);
  const had = b.garrison.length;
  b.garrison = b.garrison.filter((id) => id !== s.id);
  // Emptied, it no longer sees its `sight` (`fog.ts`).
  if (had > 0 && b.garrison.length === 0 && BUILDINGS[b.type].sight) w.buildingsVersion++;
  if (s.home === b.id) s.home = null;
  if (s.inside === b.id) s.inside = null;
  if (claimsTerritory(b) !== claimed) claimChanged(w, b);
}

/**
 * Garrisoned fighters that may leave: inside, not fighting, beyond the `keep` the building holds back.
 * With a role (`archer` true/false) that role comes first; without one (attacks) swordsmen and
 * archers alternate, so an attack is a mixed party.
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

/** Tells the building's owner (`messages.ts`): an empty building finds no free fighter, a barracks no carrier. */
function warn(w: World, kind: 'noFighter' | 'noCarrier', b: Building): void {
  postMessage(w, kind, b.owner, b.door, { b: b.id });
}

// ---------------------------------------------------------------- garrisons

/**
 * A free fighter: outdoors, no garrison, no field post, not fighting, doing nothing but standing or
 * walking (the army menu's «Свободны»; the AI's idle fighters).
 */
export function isFreeFighter(w: World, s: Settler): boolean {
  if (s.inside !== null || s.home !== null || s.post || s.opponent !== null || w.dying.has(s.id) || !isFighter(s)) return false;
  return s.tasks.every((t) => t.t === 'goto' || t.t === 'wait');
}

/**
 * A fighter a military building may call in: as Settlers 4's `CSettlerMgr::OrderWarrior` takes any
 * fighter of the kind still `ENTITY_FLAG_Selectable` — the flag is cleared only when a soldier is
 * attached to a building or vehicle (`CSoldierRole::ComeToWork`, boarding), not by move or attack
 * orders —, any outdoor fighter without a garrison or one he is walking into, field units and
 * attackers included. Not one in a duel (our duels link both sides; S4 would take him) [оценка].
 */
export function isCallable(w: World, s: Settler): boolean {
  if (s.inside !== null || s.home !== null || s.opponent !== null || w.dying.has(s.id) || !canGarrison(s)) return false;
  // A patient on his way to or at an infirmary's door (`infirmary.ts`) is left to heal [оценка].
  return !s.tasks.some((t) => t.t === 'join' || t.t === 'heal');
}

const freeCache = new WeakMap<World, { tick: number; list: Settler[] }>();

/** Callable fighters of every player, built once per tick (they are re-checked when picked). */
function freeFighters(w: World): Settler[] {
  const c = freeCache.get(w);
  if (c && c.tick === w.tick) return c.list;
  const list = outdoorFighters(w).filter((s) => isCallable(w, s));
  freeCache.set(w, { tick: w.tick, list });
  return list;
}

/**
 * The free fighter of the kind a military building calls (Settlers 4 `CSettlerMgr::OrderWarrior`):
 * in rings of `GARRISON_ORDERS.rings` round its door, the highest level first, then the nearest; only
 * one who can walk there.
 */
function findFreeFighter(w: World, b: Building, archer: boolean): Settler | undefined {
  const m = w.map;
  const door = m.idx(b.door.x, b.door.y);
  const candidates = freeFighters(w).filter((s) => s.owner === b.owner && isArcher(s) === archer && isCallable(w, s));
  if (candidates.length === 0) return undefined;
  const d = (s: Settler) => Math.hypot(s.x - b.door.x, s.y - b.door.y);
  for (const ring of GARRISON_ORDERS.rings) {
    let best: Settler | undefined;
    for (const s of candidates) {
      const ds = d(s);
      if (ds >= ring) continue;
      if (best && (s.level < best.level || (s.level === best.level && (ds > d(best) || (ds === d(best) && s.id > best.id))))) continue;
      if (!sameRegion(m, m.idx(Math.round(s.x), Math.round(s.y)), door)) continue;
      best = s;
    }
    if (best) return best;
  }
  return undefined;
}

function sendToJoin(w: World, s: Settler, b: Building): void {
  // Whatever he was doing ends (Settlers 4: the tower's call overrides a move or attack order).
  abort(w, s);
  s.post = null;
  const archer = isArcher(s);
  b.garrisonInbound++;
  if (archer) b.garrisonArchersInbound++;
  s.tasks = [
    { t: 'goto', x: b.door.x, y: b.door.y },
    { t: 'join', b: b.id, archer },
  ];
}

/**
 * A fighter is sent in by hand (`orderGarrison`; Settlers 4 `IncWishAndOrder`): the wish of his kind
 * grows to cover him, up to its slots.
 */
export function raiseWish(w: World, b: Building, archer: boolean): void {
  const wish = wishOf(b);
  const c = garrisonCounts(w, b);
  const coming = archer ? c.ranged + c.inRanged : c.melee + c.inMelee;
  const key = archer ? 'ranged' : 'melee';
  wish[key] = Math.min(slotsOf(b, archer), Math.max(wish[key], coming + 1));
}

/**
 * Every `GARRISON_ORDERS.every` ticks (Settlers 4 `CMilitaryBuildingRole::OrderWarrior`): order a free
 * swordsman while fewer are inside and coming than wished — or, empty with no wish, one at all (the
 * wish becomes one); then an archer the same way (the empty case only if no swordsman was found). An
 * empty building with nobody coming warns its owner.
 */
function orderWarriors(w: World, b: Building): void {
  const wish = wishOf(b);
  const c = garrisonCounts(w, b);
  let orderedMelee = c.inMelee;
  const none = c.melee + c.ranged === 0 && c.inMelee + c.inRanged === 0 && wish.melee + wish.ranged === 0;
  if ((c.melee + orderedMelee < wish.melee || none) && slotsOf(b, false) > 0) {
    const s = findFreeFighter(w, b, false);
    if (s) {
      sendToJoin(w, s, b);
      orderedMelee++;
      if (none) wish.melee = 1;
    }
  }
  const noneYet = orderedMelee === 0 && none;
  if ((c.ranged + c.inRanged < wish.ranged || noneYet) && slotsOf(b, true) > 0) {
    const s = findFreeFighter(w, b, true);
    if (s) {
      sendToJoin(w, s, b);
      if (noneYet) wish.ranged = 1;
    }
  }
  if (c.melee + c.ranged === 0 && b.garrisonInbound === 0) warn(w, 'noFighter', b);
}

/** A hostile fighter outdoors within `r` tiles of the door (Settlers 4 `FindAnyEnemyFighter`). */
function enemyNear(w: World, b: Building, r: number): boolean {
  for (const o of outdoorFighters(w)) {
    if (o.owner !== b.owner && !w.allied(o.owner, b.owner) && Math.hypot(o.x - b.door.x, o.y - b.door.y) <= r) return true;
  }
  return false;
}

/**
 * Every `GARRISON_ORDERS.every` ticks (Settlers 4 `ThrowOut`): with more swordsmen inside than wished
 * the last one steps out — else an archer —, one at a time and only while no enemy fighter is within
 * `GARRISON_ORDERS.enemyNear` tiles. He then stands free by the building.
 */
function throwOut(w: World, b: Building): void {
  const wish = wishOf(b);
  const c = garrisonCounts(w, b);
  if (c.melee <= wish.melee && c.ranged <= wish.ranged) return;
  if (enemyNear(w, b, GARRISON_ORDERS.enemyNear)) return;
  const archer = c.melee <= wish.melee;
  const out = members(w, b)
    .filter((s) => isArcher(s) === archer && s.inside === b.id && s.opponent === null)
    .sort((p, q) => q.id - p.id)[0];
  if (out) stepOut(w, b, out);
}

/** A fighter leaves the garrison through the door and stands free a few steps in front of it. */
function stepOut(w: World, b: Building, s: Settler): void {
  leaveGarrison(w, b, s);
  s.home = null;
  s.inside = null;
  s.x = s.px = b.door.x;
  s.y = s.py = b.door.y;
  standNear(w, s, b.door);
}

/** Walks a free fighter to a spot near `at` not taken by another free fighter of his (they spread out). */
function standNear(w: World, s: Settler, at: Point): void {
  const near = outdoorFighters(w).filter(
    (o) => o !== s && o.owner === s.owner && !o.post && o.home === null && Math.hypot(o.x - at.x, o.y - at.y) <= 4,
  ).length;
  const spots = formationSpots(w, at.x, at.y + 1, near + 2);
  const spot = spots[Math.min(near + 1, spots.length - 1)];
  s.tasks = spot ? [{ t: 'goto', x: spot.x, y: spot.y }] : [];
}

/** Player command (Settlers 4 «fill», `FillAllSlots`): the building wishes every slot filled. */
export function fillGarrison(w: World, id: number, player: PlayerId): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !isMilitary(b) || !b.done) return false;
  b.wish = { melee: slotsOf(b, false), ranged: slotsOf(b, true) };
  return true;
}

/**
 * Player command: one swordsman (`archer` false) or archer more (`delta` 1) or fewer (−1) wished. As
 * in Settlers 4 (`ConvertEventIntoGoal`, event 19) the wish never drops below one fighter in all: the
 * last one of a kind goes only while the other kind is wished and inside. More: up to the slots.
 */
export function changeGarrison(w: World, id: number, archer: boolean, delta: number, player: PlayerId): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !isMilitary(b) || !b.done || (delta !== 1 && delta !== -1)) return false;
  const wish = wishOf(b);
  const c = garrisonCounts(w, b);
  const [key, other, otherInside] = archer
    ? (['ranged', 'melee', c.melee] as const)
    : (['melee', 'ranged', c.ranged] as const);
  if (delta > 0) {
    if (wish[key] >= slotsOf(b, archer)) return false;
    wish[key]++;
    return true;
  }
  if (wish[key] > 1 || (wish[key] === 1 && wish[other] !== 0 && otherInside !== 0)) {
    wish[key]--;
    return true;
  }
  return false;
}

/**
 * Player command (Settlers 4 «withdraw», event 19 for all): fighters on their way in turn back, and
 * the wish drops to one — a swordsman if one is inside, else an archer; the others step out one at a
 * time (`throwOut`).
 */
export function withdrawGarrison(w: World, id: number, player: PlayerId): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !isMilitary(b) || !b.done) return false;
  for (const s of w.settlers) {
    if (s.owner === player && s.tasks.some((t) => t.t === 'join' && t.b === b.id)) abort(w, s);
  }
  const c = garrisonCounts(w, b);
  b.wish = c.melee > 0 ? { melee: 1, ranged: 0 } : c.ranged > 0 ? { melee: 0, ranged: 1 } : { melee: 0, ranged: 0 };
  return true;
}

// ---------------------------------------------------------------- barracks

/** Weapons a barracks keeps on its pile: the tools of the fighting professions. */
const WEAPONS: readonly Resource[] = [...new Set(FIGHTERS.map((k) => PROFESSIONS[k].tool!))];

/** Weapons a finished barracks wants on its pile (each up to the input limit, as S4's piles). */
export function weaponsWanted(b: Building, res: Resource): number {
  if (!BUILDINGS[b.type].barracks || !b.done || !WEAPONS.includes(res)) return 0;
  return INPUT_CAP - b.input[res] - b.inbound[res];
}

/** What one recruit of `kind` at `level` takes off the barracks pile: weapon, kit, the level's gold. */
export function recruitNeeds(kind: SettlerKind, level: number): Partial<Stock> {
  const prof = PROFESSIONS[kind];
  const need: Partial<Stock> = { [prof.tool!]: 1 };
  for (const [r, n] of Object.entries(prof.kit ?? {}) as [Resource, number][]) need[r] = (need[r] ?? 0) + n;
  const cost = SOLDIER_LEVELS[Math.min(level, SOLDIER_LEVELS.length - 1)].cost;
  if (cost > 0) need[LEVEL_RES] = (need[LEVEL_RES] ?? 0) + cost;
  return need;
}

/** The player has a recruit order that takes gold (a level above the first, or a kit with gold). */
function ordersGold(w: World, owner: PlayerId): boolean {
  const orders = economyOf(w, owner).recruitOrders ?? {};
  for (const [kind, row] of Object.entries(orders) as [SettlerKind, number[]][]) {
    for (let level = 0; level < row.length; level++) {
      if (row[level] !== 0 && (recruitNeeds(kind, level)[LEVEL_RES] ?? 0) > 0) return true;
    }
  }
  return false;
}

/** Gold a barracks wants on its pile: up to `cap` while its owner orders recruits that take gold. */
export function goldWanted(w: World, b: Building, res: Resource, cap: number): number {
  if (res !== LEVEL_RES || !BUILDINGS[b.type].barracks || !b.done || !ordersGold(w, b.owner)) return 0;
  return cap - b.input[res] - b.inbound[res];
}

/**
 * Units of `res` the player's recruit orders still wait for (the weaponsmith forges them first,
 * `waitingFor`): per order its count of the good (an endless one a pile's worth), minus what the
 * barracks already hold.
 */
export function recruitsAwaiting(w: World, owner: PlayerId, res: Resource): number {
  const orders = economyOf(w, owner).recruitOrders ?? {};
  let want = 0;
  for (const [kind, row] of Object.entries(orders) as [SettlerKind, number[]][]) {
    for (let level = 0; level < row.length; level++) {
      const n = row[level] === ENDLESS ? INPUT_CAP : row[level];
      if (n > 0) want += n * (recruitNeeds(kind, level)[res] ?? 0);
    }
  }
  if (want === 0) return 0;
  for (const b of w.buildings.values()) if (b.owner === owner && b.done && BUILDINGS[b.type].barracks) want -= b.input[res];
  return Math.max(0, want);
}

const pays = (b: Building, need: Partial<Stock>) => (Object.entries(need) as [Resource, number][]).every(([r, n]) => b.input[r] >= n);

/**
 * Once every `BARRACKS_EVERY` ticks (Settlers 4 `CBarrackRole::LogicUpdate`): of its owner's recruit
 * orders whose goods lie on its pile, the highest rank (level; the squad leader above all) — kinds of
 * one rank taking turns after the last one (`recruitClass`) — calls the nearest free carrier on its
 * land beyond the carrier reserve. His goods come off the pile at once (back if he never arrives) and
 * the order counts down (an endless one stays). No carrier: its owner is warned.
 */
function recruitStep(w: World, b: Building): void {
  const orders = economyOf(w, b.owner).recruitOrders ?? {};
  let best: { kind: SettlerKind; level: number; cls: number; need: Partial<Stock> } | null = null;
  let bestRank = -1;
  let bestTurn = -2;
  let any = false;
  const last = b.recruitClass ?? 2;
  for (const kind of FIGHTERS) {
    const row = orders[kind];
    if (!row) continue;
    const combat = PROFESSIONS[kind].combat!;
    for (let level = combat.levels.length - 1; level >= 0; level--) {
      if (!row[level]) continue;
      any = true;
      const need = recruitNeeds(kind, level);
      if (!pays(b, need)) continue;
      const rank = combat.rank ?? level + 1;
      const cls = combat.alternate ?? -1;
      const turn = cls < 0 ? -1 : ((last % 3) + 3 - cls) % 3;
      if (rank > bestRank || (rank === bestRank && turn > bestTurn)) {
        best = { kind, level, cls, need };
        bestRank = rank;
        bestTurn = turn;
      }
    }
  }
  if (!any) b.recruitClass = 2;
  if (!best) return;
  const piece = landOf(w, b);
  if (piece === 0) return;
  // Settlers 4 `CarrierForJobOrderAvailable`: only while the player has carriers above his reserve
  // (`economy.minCarriers`, `spareCarriers`); then the nearest idle one on its land.
  let carrier: Settler | undefined;
  for (const s of w.settlers) {
    // A carrier on strike (no bed, `beds.ts`) takes no job, this one neither.
    if (s.owner !== b.owner || s.kind !== 'carrier' || s.tasks.length > 0 || s.strike || w.dying.has(s.id)) continue;
    if (landAt(w, s, b.owner) !== piece) continue;
    const d = Math.hypot(s.x - b.door.x, s.y - b.door.y);
    if (!carrier || d < Math.hypot(carrier.x - b.door.x, carrier.y - b.door.y)) carrier = s;
  }
  if (!carrier || spareCarriers(w, b.owner) <= 0) {
    warn(w, 'noCarrier', b);
    return;
  }
  if (best.cls >= 0) b.recruitClass = best.cls;
  recruitCalled(w, b.owner, best.kind, best.level);
  for (const [r, n] of Object.entries(best.need) as [Resource, number][]) b.input[r] -= n;
  carrier.kind = 'recruit';
  carrier.tasks = [
    { t: 'goto', x: b.door.x, y: b.door.y },
    { t: 'recruit', b: b.id, kind: best.kind, level: best.level, paid: best.need, n: 0 },
  ];
}

/**
 * Per tick for a finished barracks: its recruit orders, on their cadence — not while the player has it
 * stopped (`stop.ts`; Settlers 4 checks orders only while the building runs).
 */
export function updateBarracks(w: World, b: Building): void {
  if (!b.stopped && (w.tick + b.id) % BARRACKS_EVERY === 0) recruitStep(w, b);
}

/**
 * `recruit` task, at the barracks door: he goes in, and after `barracks.ticks` comes out as the fighter
 * he was called for and stands free by the barracks (`stats.trained`).
 */
export function recruitTick(w: World, s: Settler, task: Extract<Task, { t: 'recruit' }>): void {
  const b = w.buildings.get(task.b);
  if (!b || !b.done || b.owner !== s.owner || !BUILDINGS[b.type].barracks) return abort(w, s);
  s.inside = b.id;
  if (++task.n < BUILDINGS[b.type].barracks!.ticks) return;
  s.tasks.shift();
  s.kind = task.kind;
  s.level = task.level;
  s.hp = maxHp(s);
  s.home = null;
  s.inside = null;
  s.x = s.px = b.door.x;
  s.y = s.py = b.door.y;
  w.stats.trained++;
  standNear(w, s, b.door);
}

/** `abort` of a `recruit` task: his goods go back on the barracks pile, he is a carrier again. */
export function releaseRecruit(w: World, s: Settler, task: Extract<Task, { t: 'recruit' }>): void {
  const b = w.buildings.get(task.b);
  for (const [r, n] of Object.entries(task.paid) as [Resource, number][]) {
    if (b) b.input[r] += n;
    else dropGoods(w, s, r, n);
  }
  task.paid = {};
  if (s.kind === 'recruit') s.kind = 'carrier';
  if (s.inside === task.b) s.inside = null;
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

/** Releases a `join` reservation (on arrival or when the job is aborted). */
export function releaseJoin(b: Building, task: Extract<Task, { t: 'join' }>): void {
  b.garrisonInbound--;
  if (task.archer) b.garrisonArchersInbound--;
}

/** `join` task: move into the garrison if it is still ours and has room; otherwise give up. */
export function joinTick(w: World, s: Settler, task: Extract<Task, { t: 'join' }>): void {
  const b = w.buildings.get(task.b);
  // Its own reservation is still counted in the free slots, hence `< 0`.
  if (!b || !isMilitary(b) || !b.done || b.owner !== s.owner || !canGarrison(s) || slotsFree(w, b, isArcher(s)) < 0) return abort(w, s);
  releaseJoin(b, task);
  s.tasks.shift();
  enterGarrison(w, b, s);
}

/**
 * Idle fighter: a field unit keeps its post (`fieldIdle`); one of a garrison goes back in; anyone else
 * is free and stands where he is, taking on enemies that come close (`freeIdle`) — military buildings
 * with room call free fighters in themselves (`orderWarriors`).
 */
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
  freeIdle(w, s);
}

// ---------------------------------------------------------------- attacks

/** An own fighter outdoors who may join an attack: free, or a field unit standing at his post. */
function readyOutdoors(w: World, s: Settler, player: PlayerId): boolean {
  if (s.owner !== player || s.inside !== null || s.home !== null || s.opponent !== null || w.dying.has(s.id)) return false;
  return isFighter(s) && s.tasks.every((t) => t.t === 'goto' || t.t === 'wait');
}

/**
 * Fighters of `player` that `attack` would send against the target: free fighters and idle field
 * units within `ATTACK_RANGE` of it (nearest first), then the spares of its military buildings in range.
 */
function attackers(w: World, target: Building, player: PlayerId): Settler[] {
  const c = centerOf(target);
  const d = (p: Point) => Math.hypot(p.x - c.x, p.y - c.y);
  const outdoors = outdoorFighters(w)
    .filter((s) => readyOutdoors(w, s, player) && d(s) <= ATTACK_RANGE)
    .sort((p, q) => d(p) - d(q) || p.id - q.id);
  const sources = [...w.buildings.values()]
    .filter((b) => b.owner === player && b.done && isMilitary(b))
    .map((b) => ({ b, d: d(centerOf(b)) }))
    .filter((x) => x.d <= ATTACK_RANGE)
    .sort((a, b) => a.d - b.d || a.b.id - b.b.id);
  return [...outdoors, ...sources.flatMap((x) => spareSoldiers(w, x.b))];
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
    if (s.home !== null) {
      const from = w.buildings.get(s.home);
      if (from) sendOut(w, from, s);
    } else abort(w, s);
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
  // An intruding specialist shot down counts like one cut down (`intruders.ts`).
  if (strike(w, archer, target, !tower ? 0 : atDoor ? ranged.towerDoor : ranged.tower) && !isFighter(target)) w.stats.intrudersKilled++;
}

/** Hit points of the building's door while it is held: full when undamaged, 0 when broken or doorless. */
export function doorHp(b: Building): number {
  const door = garrisonOf(b).door;
  return door ? (b.doorHp ?? door.hp) : 0;
}

/**
 * `assault` task, run by the attacker: duel the current defender (both strike on their own timers,
 * `duelTick`); or break the door of a held building first (Settlers 4 `CDoorRole`); or — for an
 * archer — shoot defenders busy with comrades; call out the next defender (swordsmen first); or take
 * the building alone once nobody defends it.
 */
export function assaultTick(w: World, s: Settler, task: Extract<Task, { t: 'assault' }>): void {
  const b = w.buildings.get(task.b);
  if (!b || !b.done) {
    s.tasks.shift();
    return;
  }
  if (b.owner === s.owner || w.allied(b.owner, s.owner)) {
    // A comrade took it first: one fighter goes in (`conquer`), the rest stay outside.
    s.tasks.shift();
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
    // The last defender fell: he moves in at once (Settlers 4 `InsertTowerGuard` takes the building
    // when its last guard dies), before the defeat check could find his owner's land empty.
    if (w.dying.has(d.id) && !w.dying.has(s.id) && w.buildings.get(b.id) === b && b.garrison.length === 0 && canCapture(s)) {
      conquer(w, b, s);
    }
    return;
  }
  const defenders = members(w, b);
  // Its owner hears of it (Settlers 4 `CAttackMsgList`), at most every `MESSAGES.attacked.every`.
  postMessage(w, 'attacked', b.owner, b.door, { b: b.id });
  if (defenders.length > 0 && doorHp(b) > 0) {
    // The door first: every attacker strikes it at his own pace, archers too.
    s.working = true;
    s.reload--;
    if (s.reload > 0) return;
    rearm(s);
    b.doorHp = Math.max(0, doorHp(b) - hitDamage(w, s, null));
    return;
  }
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
  // A swordsman or archer takes it; the squad leader cannot, his `assault` ends here.
  if (!canCapture(s)) {
    s.tasks.shift();
    return;
  }
  conquer(w, b, s);
}

/** A fighter who can take an emptied enemy building (swordsman or archer; not the squad leader). */
function canCapture(s: Settler): boolean {
  return !!PROFESSIONS[s.kind].combat?.captures && canGarrison(s);
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
 * Enemy fighters a garrison archer of `b` may shoot (Settlers 4 `CTowerSoldier::SearchBowmanTarget`):
 * outdoors within `range` of the door, standing on land of the building's side or nobody's.
 */
function towerTargets(w: World, b: Building, range: number): Settler[] {
  const m = w.map;
  const out: Settler[] = [];
  for (const o of outdoorFighters(w)) {
    if (o.owner === b.owner || w.allied(o.owner, b.owner) || w.dying.has(o.id)) continue;
    if (Math.hypot(o.x - b.door.x, o.y - b.door.y) > range) continue;
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    const land = m.inBounds(x, y) ? m.owner[m.idx(x, y)] : 0;
    if (land !== 0 && !w.allied(land, b.owner)) continue;
    out.push(o);
  }
  return out.sort(
    (p, q) => Math.hypot(p.x - b.door.x, p.y - b.door.y) - Math.hypot(q.x - b.door.x, q.y - b.door.y) || p.id - q.id,
  );
}

/**
 * Per tick for a finished military building: archers inside shoot enemy fighters in their tower
 * range (looked for every tick while the building is assaulted, else every `FIELD.scanEvery` ticks);
 * a damaged door mends; every `GARRISON_ORDERS.every` ticks it calls free fighters in and puts one
 * beyond its wish out (`orderWarriors`, `throwOut`). Wounded fighters inside stay there: an infirmary
 * heals only free fighters in the open (`infirmary.ts`), as in Settlers 4.
 */
export function updateGarrison(w: World, b: Building, assaults: Map<number, Settler[]>): void {
  const g = garrisonOf(b);
  if (g.door && b.doorHp !== undefined && b.doorHp > 0 && (w.tick + b.id) % Math.max(1, Math.round(g.door.regenEvery)) === 0) {
    if (++b.doorHp >= g.door.hp) delete b.doorHp;
  }
  if ((w.tick + b.id) % GARRISON_ORDERS.every === 0 && !w.isDefeated(b.owner)) {
    throwOut(w, b);
    orderWarriors(w, b);
  }
  const inside = members(w, b).filter((s) => s.inside === b.id && s.opponent === null);
  if (inside.length === 0) return;
  const assaulted = (assaults.get(b.id)?.length ?? 0) > 0;
  let targets: Settler[] | null = null;
  for (const s of inside) {
    const ranged = PROFESSIONS[s.kind].combat?.ranged;
    if (!ranged) continue;
    if (s.reload > 0) s.reload--;
    if (s.reload > 0 || (!assaulted && (w.tick + b.id) % FIELD.scanEvery !== 0)) continue;
    targets ??= towerTargets(w, b, ranged.towerRange);
    const target = targets.find((t) => !w.dying.has(t.id));
    if (target) shoot(w, s, target, b.door, b);
  }
}

/** End of tick: forget arrows that have landed (they are only drawn, never simulated). */
export function pruneShots(w: World): void {
  if (w.shots.length === 0) return;
  w.shots = w.shots.filter((s) => w.tick - s.tick < SHOT_TICKS);
}

/**
 * The attacker moves in alone (Settlers 4 `InsertTowerGuard`): the building changes hands, wishing
 * just him, and takes, as in Settlers 4 (`territory.ts`), the land of its disc its former owner covers
 * no more; his buildings on land that changed hands burn, and their people, homeless on foreign land,
 * flee (`flee.ts`).
 */
/** The player's war record, created on first use (`World.stats.war`, saved). */
export function warStats(w: World, player: PlayerId): WarStats {
  return (w.stats.war[player] ??= { killed: {}, fallen: {}, captured: 0, lostBuildings: 0 });
}

function conquer(w: World, b: Building, s: Settler): void {
  const previous = b.owner;
  warStats(w, s.owner).captured++;
  warStats(w, previous).lostBuildings++;
  postMessage(w, 'lost', previous, b.door, { b: b.id });
  postMessage(w, 'captured', s.owner, b.door, { b: b.id });
  for (const o of w.settlers) {
    if (o.owner !== previous) continue;
    if (o.tasks.some((t) => 'b' in t && t.b === b.id)) abort(w, o);
    if (o.inside === b.id) o.inside = null;
  }
  b.owner = s.owner;
  b.priority = false;
  b.wish = { melee: 0, ranged: 0 };
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
  const fallen = warStats(w, s.owner).fallen;
  fallen[s.kind] = (fallen[s.kind] ?? 0) + 1;
  s.hp = 0;
  // Who struck him down, if he was in a duel (an attacker taking his building, see below).
  const killer = s.opponent !== null ? w.getSettler(s.opponent) : undefined;
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
  for (const b of [...w.buildings.values()]) {
    if (b.garrison.includes(s.id)) {
      // The last defender falls to an attacker who can take the building: he moves in at once
      // (Settlers 4 `InsertTowerGuard`), before the emptied building could lose its land and burn.
      const t = killer?.tasks[0];
      if (b.garrison.length === 1 && killer && !w.dying.has(killer.id) && t?.t === 'assault' && t.b === b.id && canCapture(killer) && !w.allied(killer.owner, b.owner)) {
        b.garrison = [];
        w.buildingsVersion++; // the owner changes: sight goes to the new one (`fog.ts`)
        if (s.home === b.id) s.home = null;
        if (s.inside === b.id) s.inside = null;
        conquer(w, b, killer);
        continue;
      }
      leaveGarrison(w, b, s);
    }
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
