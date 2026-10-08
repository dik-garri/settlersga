import { BUILDINGS, ORDERABLE, START_CONDITIONS, type StartLevel } from './config';
import { nearestStorage } from './buildings';
import { landOf } from './land';
import { RESOURCES, type Building, type BuildingType, type PlayerId, type Resource, type SettlerKind, type Task } from './types';
import type { World } from './world';

/**
 * A player's economy settings, as in Settlers 4's settlers and production menus (plain data, saved
 * with the player):
 * - `orders`: how many of each orderable profession (builders, diggers) the player wants; carriers
 *   with the tool are recruited only up to that (`logistics.ts`);
 * - `toolOrders`: the toolsmith's order queue — units still to forge per tool, or `ENDLESS`; tools
 *   without orders are forged automatically, by need (`chooseOutput`);
 * - `distribution`: per good, weights between the building types that consume it; a good without an
 *   entry is shared fairly (least-stocked consumer first). `tally` counts units handed out per type,
 *   so deliveries follow the weights over time.
 */
export interface EconomyState {
  orders: Partial<Record<SettlerKind, number>>;
  toolOrders: Partial<Record<Resource, number>>;
  distribution: Partial<Record<Resource, Partial<Record<BuildingType, number>>>>;
  tally: Partial<Record<Resource, Partial<Record<BuildingType, number>>>>;
}

/** A tool order that never runs out. */
export const ENDLESS = -1;

/** Fresh settings for a player starting with `start`'s workers. */
export function createEconomy(start: StartLevel): EconomyState {
  const s = START_CONDITIONS[start];
  return { orders: { builder: s.builders, digger: s.diggers }, toolOrders: {}, distribution: {}, tally: {} };
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
  economyOf(w, player).orders[kind] = Math.max(0, Math.min(999, Math.round(count)));
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

/** Default weight of a consumer type when the player set none. */
export const DEFAULT_WEIGHT = 50;

export function distributionWeight(w: World, player: PlayerId, res: Resource, type: BuildingType): number {
  return economyOf(w, player).distribution[res]?.[type] ?? DEFAULT_WEIGHT;
}

export function setDistribution(w: World, player: PlayerId, res: Resource, type: BuildingType, weight: number): boolean {
  if (!consumersOf(res).includes(type) || !Number.isFinite(weight)) return false;
  const eco = economyOf(w, player);
  const d = (eco.distribution[res] ??= {});
  for (const t of consumersOf(res)) d[t] ??= DEFAULT_WEIGHT;
  d[type] = Math.max(0, Math.min(100, Math.round(weight)));
  return true;
}

/**
 * Ordering key of a consumer for a distributed good: units handed to its type so far over the type's
 * weight (lower is served first); 0 for goods without a distribution, Infinity for weight 0.
 */
export function distributionKey(eco: EconomyState, res: Resource, b: Building): number {
  const d = eco.distribution[res];
  if (!d || !b.done) return 0;
  const weight = d[b.type] ?? DEFAULT_WEIGHT;
  if (weight <= 0) return Infinity;
  return (eco.tally[res]?.[b.type] ?? 0) / weight;
}

/** A unit of a distributed good was handed to a consumer. */
export function countDelivery(eco: EconomyState, res: Resource, b: Building): void {
  if (!eco.distribution[res] || !b.done) return;
  const t = (eco.tally[res] ??= {});
  t[b.type] = (t[b.type] ?? 0) + 1;
}

// ----------------------------------------------------------------------- warehouses

/** Whether a warehouse takes this good in (player setting; it still gives out what it holds). */
export function accepts(b: Building, res: Resource): boolean {
  return !b.refuse?.includes(res);
}

export function setAccepts(w: World, player: PlayerId, id: number, res: Resource, on: boolean): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !BUILDINGS[b.type].storage || !RESOURCES.includes(res)) return false;
  const refuse = new Set(b.refuse ?? []);
  if (on) refuse.delete(res);
  else refuse.add(res);
  b.refuse = RESOURCES.filter((r) => refuse.has(r));
  if (b.refuse.length === 0) delete b.refuse;
  if (!on) redirectDeliveries(w, b, res);
  return true;
}

/**
 * Carriers already bringing `res` to a warehouse that has just stopped accepting it turn to the
 * nearest warehouse on the same land piece that takes it (reservations move with them). With no such
 * warehouse they finish the trip: the good is stored there rather than lost.
 */
function redirectDeliveries(w: World, b: Building, res: Resource): void {
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
