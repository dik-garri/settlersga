import { BUILDINGS, CARRIER_RESERVE, DISTRIBUTION_DEFAULTS, NETWORK_ONLY, ORDERABLE, PROFESSIONS, START_CONDITIONS, TRANSPORT_PRIORITY, type StartLevel } from './config';
import { nearestStorage } from './buildings';
import { landOf } from './land';
import { RESOURCES, type Building, type BuildingType, type PlayerId, type Resource, type SettlerKind, type Task } from './types';
import type { World } from './world';

/**
 * A player's economy settings, as in Settlers 4's settlers and production menus (plain data, saved
 * with the player):
 * - `orders`: how many of each orderable profession (builders, diggers, specialists) the player wants; carriers
 *   with the tool are recruited only up to that (`logistics.ts`);
 * - `toolOrders`: the toolsmith's order queue — units still to forge per tool, or `ENDLESS`; tools
 *   without orders are forged automatically, by need (`chooseOutput`);
 * - `distribution`: per good, weights between the building types that consume it (`defaultWeight`
 *   each unless set — Settlers 4 always shares a good with several consumer types by its distribution,
 *   `CEcoSector` over `CBuildingSupplyPriority`; of its default percentages our sources give only bread
 *   to the coal mine, 85 — `DISTRIBUTION_DEFAULTS` —, the rest are equal). `tally` counts units handed
 *   out per type, so deliveries follow the weights over time;
 * - `recruitOrders`: Settlers 4's barracks orders — per fighting profession, per level (index), how
 *   many recruits are still wanted, or `ENDLESS`. None by default: a barracks recruits nobody unasked.
 * - `minCarriers`: the free-carrier reserve (`CARRIER_RESERVE`): no carrier takes up a job while the
 *   player has no more carriers than this;
 * - `transport`: the transport priority, every good once, most urgent first (`TRANSPORT_PRIORITY`).
 */
export interface EconomyState {
  orders: Partial<Record<SettlerKind, number>>;
  toolOrders: Partial<Record<Resource, number>>;
  recruitOrders?: Partial<Record<SettlerKind, number[]>>;
  distribution: Partial<Record<Resource, Partial<Record<BuildingType, number>>>>;
  tally: Partial<Record<Resource, Partial<Record<BuildingType, number>>>>;
  minCarriers: number;
  transport: Resource[];
}

/** A tool order that never runs out. */
export const ENDLESS = -1;

/** Fresh settings for a player starting with `start`'s workers. */
export function createEconomy(start: StartLevel): EconomyState {
  const s = START_CONDITIONS[start];
  return {
    orders: { builder: s.builders, digger: s.diggers, geologist: s.geologists },
    toolOrders: {},
    recruitOrders: {},
    distribution: {},
    tally: {},
    minCarriers: CARRIER_RESERVE.default,
    transport: [...TRANSPORT_PRIORITY],
  };
}

export function economyOf(w: World, player: PlayerId): EconomyState {
  const p = w.players.find((q) => q.id === player)!;
  if (!p.economy) p.economy = createEconomy('medium');
  return p.economy;
}

// ------------------------------------------------------------------------- workers

/** Workers of the profession the player has ordered in all. */
export function workerOrder(w: World, player: PlayerId, kind: SettlerKind): number {
  return economyOf(w, player).orders[kind] ?? 0;
}

/** Per world: orderable workers per player and kind, counted once per tick (derived, not saved). */
const workerCounts = new WeakMap<World, { tick: number; counts: Int32Array }>();

/**
 * The player's settlers of the profession, plus carriers on their way to become one. Counted for all
 * players and orderable kinds in one pass per tick, as the toolsmith asks every tick.
 */
export function workersOf(w: World, player: PlayerId, kind: SettlerKind): number {
  const k = ORDERABLE.indexOf(kind);
  if (k < 0) return 0;
  let cached = workerCounts.get(w);
  if (!cached || cached.tick !== w.tick) {
    const counts = new Int32Array((w.players.length + 1) * ORDERABLE.length);
    for (const s of w.settlers) {
      if (w.dying.has(s.id)) continue;
      let j = ORDERABLE.indexOf(s.kind);
      if (j < 0 && s.kind === 'carrier') {
        for (const t of s.tasks) if (t.t === 'retool') j = ORDERABLE.indexOf(t.kind);
      }
      if (j >= 0) counts[s.owner * ORDERABLE.length + j]++;
    }
    cached = { tick: w.tick, counts };
    workerCounts.set(w, cached);
  }
  return cached.counts[player * ORDERABLE.length + k] ?? 0;
}

/** Forget the per-tick worker counts (a dispatch round just changed them). */
export function recountWorkers(w: World): void {
  workerCounts.delete(w);
}

export function orderWorkers(w: World, player: PlayerId, kind: SettlerKind, count: number): boolean {
  if (!ORDERABLE.includes(kind) || !Number.isFinite(count)) return false;
  // The saboteur only where the game allows him (Settlers 4: network games).
  if (NETWORK_ONLY.includes(kind) && !w.rules?.saboteurs) return false;
  economyOf(w, player).orders[kind] = Math.max(0, Math.min(999, Math.round(count)));
  return true;
}

// ------------------------------------------------------------------ carrier reserve

/** The player's free-carrier reserve. */
export function carrierReserve(w: World, player: PlayerId): number {
  return economyOf(w, player).minCarriers;
}

/** Player command: set the carrier reserve (clamped to `CARRIER_RESERVE.min`…`max`). */
export function setCarrierReserve(w: World, player: PlayerId, count: number): boolean {
  if (!Number.isFinite(count)) return false;
  economyOf(w, player).minCarriers = Math.max(CARRIER_RESERVE.min, Math.min(CARRIER_RESERVE.max, Math.round(count)));
  return true;
}

/**
 * How many of the player's carriers may still take up a job (worker, builder, digger, specialist,
 * recruit), as in Settlers 4 (`OrderWorker`: `MinCarrier < carriers − carriers with a job order`):
 * its carriers, busy or idle, minus those already on their way to a new job, minus the reserve.
 */
export function spareCarriers(w: World, player: PlayerId): number {
  let n = 0;
  for (const s of w.settlers) {
    if (s.owner !== player || s.kind !== 'carrier' || w.dying.has(s.id)) continue;
    if (!s.tasks.some((t) => t.t === 'become' || t.t === 'retool')) n++;
  }
  return n - carrierReserve(w, player);
}

// ---------------------------------------------------------------- transport priority

/** The player's transport priority: every good once, most urgent first. */
export function transportOrder(w: World, player: PlayerId): readonly Resource[] {
  return economyOf(w, player).transport;
}

export type TransportMove = 'up' | 'down' | 'top' | 'bottom';

/** Player command: move a good one place up or down the transport priority, or to its top or bottom. */
export function moveTransport(w: World, player: PlayerId, res: Resource, how: TransportMove): boolean {
  const list = economyOf(w, player).transport;
  const i = list.indexOf(res);
  if (i < 0) return false;
  const to = how === 'up' ? i - 1 : how === 'down' ? i + 1 : how === 'top' ? 0 : how === 'bottom' ? list.length - 1 : -1;
  if (to < 0 || to >= list.length) return to === i;
  list.splice(i, 1);
  list.splice(to, 0, res);
  return true;
}

// ---------------------------------------------------------------- toolsmith orders

/**
 * Queue `count` more of an orderable output (a toolsmith's tool) — or `ENDLESS` to keep forging it,
 * 0 to clear the order. False for outputs no orderable recipe makes.
 */
export function orderTool(w: World, player: PlayerId, res: Resource, count: number): boolean {
  if (!orderableOutputs().includes(res) || !Number.isFinite(count)) return false;
  const orders = economyOf(w, player).toolOrders;
  if (count === ENDLESS) orders[res] = ENDLESS;
  else if (count <= 0) delete orders[res];
  else orders[res] = Math.min(999, (orders[res] === ENDLESS ? 0 : (orders[res] ?? 0)) + Math.round(count));
  return true;
}

/** The ordered output the workshop makes next (first in its choice order with room), or null. */
export function orderedOutput(w: World, b: Building, choices: readonly Resource[], room: (r: Resource) => boolean): Resource | null {
  const orders = economyOf(w, b.owner).toolOrders;
  for (const r of choices) if (orders[r] !== undefined && room(r)) return r;
  return null;
}

/** One unit of an ordered output was made: count it off the queue. */
export function toolMade(w: World, player: PlayerId, res: Resource): void {
  const orders = economyOf(w, player).toolOrders;
  const n = orders[res];
  if (n === undefined || n === ENDLESS) return;
  if (n <= 1) delete orders[res];
  else orders[res] = n - 1;
}

// ---------------------------------------------------------------- barracks orders

/** Settlers 4 shows an endless recruit order as 100: steps below it count down from there. */
const RECRUIT_ENDLESS_AT = 100;

/** Recruits of `kind` at `level` the player still orders (`ENDLESS` = no end, 0 = none). */
export function recruitOrder(w: World, player: PlayerId, kind: SettlerKind, level: number): number {
  return economyOf(w, player).recruitOrders?.[kind]?.[level] ?? 0;
}

/**
 * Player command (Settlers 4's barracks menu): `count` more recruits of `kind` at `level` (index into
 * its `combat.levels`) — `ENDLESS` for no end, 0 to clear. As in S4 an endless order stands for 100:
 * reaching 100 makes it endless. False for non-fighters or levels the profession does not have.
 */
export function orderRecruits(w: World, player: PlayerId, kind: SettlerKind, level: number, count: number): boolean {
  if (count !== ENDLESS && !(count >= 0)) return false;
  return stepRecruits(w, player, kind, level, count === ENDLESS ? RECRUIT_ENDLESS_AT : count === 0 ? -Infinity : count);
}

/** Player command: `count` fewer recruits of `kind` at `level` ordered (an endless order counts as 100). */
export function reduceRecruits(w: World, player: PlayerId, kind: SettlerKind, level: number, count: number): boolean {
  if (!(count > 0)) return false;
  return stepRecruits(w, player, kind, level, -count);
}

function stepRecruits(w: World, player: PlayerId, kind: SettlerKind, level: number, delta: number): boolean {
  const levels = PROFESSIONS[kind].combat?.levels.length ?? 0;
  if (!Number.isInteger(level) || level < 0 || level >= levels || Number.isNaN(delta)) return false;
  const eco = economyOf(w, player);
  const orders = (eco.recruitOrders ??= {});
  const row = (orders[kind] ??= []);
  while (row.length < levels) row.push(0);
  const now = row[level] === ENDLESS ? RECRUIT_ENDLESS_AT : row[level];
  const next = Math.max(0, Math.round(now + delta));
  row[level] = next >= RECRUIT_ENDLESS_AT ? ENDLESS : next;
  if (row.every((n) => n === 0)) delete orders[kind];
  return true;
}

/** A recruit of `kind` at `level` was called: count him off the order (an endless one stays). */
export function recruitCalled(w: World, player: PlayerId, kind: SettlerKind, level: number): void {
  const row = economyOf(w, player).recruitOrders?.[kind];
  if (!row || row[level] === ENDLESS || !(row[level] > 0)) return;
  row[level]--;
  if (row.every((n) => n === 0)) delete economyOf(w, player).recruitOrders![kind];
}

let orderables: Resource[] | null = null;
/** Outputs that workshops with `recipe.orderable` choose between. */
export function orderableOutputs(): Resource[] {
  if (!orderables) {
    const set = new Set<Resource>();
    for (const def of Object.values(BUILDINGS)) {
      if (def.recipe?.orderable) for (const r of def.recipe.outputChoice ?? []) set.add(r);
    }
    orderables = RESOURCES.filter((r) => set.has(r));
  }
  return orderables;
}

// ---------------------------------------------------------------------- distribution

const consumers = new Map<Resource, BuildingType[]>();
/** Building types whose recipe consumes the good. */
export function consumersOf(res: Resource): BuildingType[] {
  let list = consumers.get(res);
  if (!list) {
    list = (Object.keys(BUILDINGS) as BuildingType[]).filter((t) => {
      const r = BUILDINGS[t].recipe;
      return !!r && ((r.inputs[res] ?? 0) > 0 || !!r.inputsAnyOf?.includes(res));
    });
    consumers.set(res, list);
  }
  return list;
}

/** Goods with more than one kind of consumer: the ones a distribution makes sense for. */
export function distributableGoods(): Resource[] {
  return RESOURCES.filter((r) => consumersOf(r).length > 1);
}

/** Default weight of a consumer type of a good without Settlers 4 defaults (`DISTRIBUTION_DEFAULTS`). */
export const DEFAULT_WEIGHT = 50;

/**
 * Weight of a consumer type when the player set none: Settlers 4's default percent where our sources
 * give it (`DISTRIBUTION_DEFAULTS`), the rest of the good's 100 shared equally by its other consumer
 * types; `DEFAULT_WEIGHT` for goods without defaults.
 */
export function defaultWeight(res: Resource, type: BuildingType): number {
  const given = DISTRIBUTION_DEFAULTS[res];
  if (!given) return DEFAULT_WEIGHT;
  const own = given[type];
  if (own !== undefined) return own;
  const consumers = consumersOf(res);
  const rest = consumers.filter((t) => given[t] === undefined).length;
  const used = consumers.reduce((n, t) => n + (given[t] ?? 0), 0);
  return rest > 0 ? Math.max(0, Math.round((100 - used) / rest)) : 0;
}

export function distributionWeight(w: World, player: PlayerId, res: Resource, type: BuildingType): number {
  return economyOf(w, player).distribution[res]?.[type] ?? defaultWeight(res, type);
}

export function setDistribution(w: World, player: PlayerId, res: Resource, type: BuildingType, weight: number): boolean {
  if (!consumersOf(res).includes(type) || !Number.isFinite(weight)) return false;
  const eco = economyOf(w, player);
  const d = (eco.distribution[res] ??= {});
  for (const t of consumersOf(res)) d[t] ??= defaultWeight(res, t);
  d[type] = Math.max(0, Math.min(100, Math.round(weight)));
  return true;
}

/**
 * Ordering key of a consumer for a good with several consumer types (`distributableGoods`): units
 * handed to its type so far over the type's weight (lower is served first; S4's `(delivered << 8 +
 * 128) / percent`); 0 for other goods and for sites, Infinity for weight 0.
 */
export function distributionKey(eco: EconomyState, res: Resource, b: Building): number {
  if (!b.done || consumersOf(res).length < 2) return 0;
  const weight = eco.distribution[res]?.[b.type] ?? defaultWeight(res, b.type);
  if (weight <= 0) return Infinity;
  return (eco.tally[res]?.[b.type] ?? 0) / weight;
}

/** A unit of a distributed good was handed to a consumer. */
export function countDelivery(eco: EconomyState, res: Resource, b: Building): void {
  if (!b.done || consumersOf(res).length < 2) return;
  const t = (eco.tally[res] ??= {});
  t[b.type] = (t[b.type] ?? 0) + 1;
}

// ----------------------------------------------------------------------- warehouses

/**
 * Whether a warehouse takes this good in (player setting; it still gives out what it holds). As in
 * Settlers 4 (`CStorageBuildingRole::Init`, `SwitchGood`) a new warehouse takes nothing until the
 * player ticks goods.
 */
export function accepts(b: Building, res: Resource): boolean {
  return !!b.accept?.includes(res);
}

export function setAccepts(w: World, player: PlayerId, id: number, res: Resource, on: boolean): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !BUILDINGS[b.type].storage || !RESOURCES.includes(res)) return false;
  const accept = new Set(b.accept ?? []);
  if (on) accept.add(res);
  else accept.delete(res);
  b.accept = RESOURCES.filter((r) => accept.has(r));
  if (b.accept.length === 0) delete b.accept;
  if (!on) redirectDeliveries(w, b, res);
  return true;
}

/**
 * Carriers already bringing `res` to a warehouse that has just stopped accepting it turn to the
 * nearest warehouse on the same land piece that takes it (reservations move with them). With no such
 * warehouse they finish the trip: the good is stored there rather than lost.
 */
export function redirectDeliveries(w: World, b: Building, res: Resource): void {
  for (const s of w.settlers) {
    if (s.owner !== b.owner) continue;
    const k = s.tasks.findIndex((t) => t.t === 'drop' && t.b === b.id && t.res === res);
    if (k < 0) continue;
    const piece = landOf(w, b);
    const to = nearestStorage(w, s.owner, s, res, piece);
    if (!to || to === b) continue;
    const drop = s.tasks[k] as Extract<Task, { t: 'drop' }>;
    b.inbound[res]--;
    to.inbound[res]++;
    drop.b = to.id;
    // The walk that leads to the old door now leads to the new one.
    const walk = s.tasks[k - 1];
    if (walk?.t === 'goto' && walk.x === b.door.x && walk.y === b.door.y) {
      walk.x = to.door.x;
      walk.y = to.door.y;
      if (k - 1 === 0) s.path = [];
    } else {
      // Already at the old door (or the drop came without its walk): walk to the new one first.
      s.tasks.splice(k, 0, { t: 'goto', x: to.door.x, y: to.door.y });
      if (k === 0) s.path = [];
    }
  }
}
