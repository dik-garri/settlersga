import { canTakeUp, isReachable, isReadyWorker, nearestStorage } from './buildings';
import { freeGoods, goodsOn, reserveGoods, stackTiles } from './ground';
import { postMessage } from './messages';
import { landAt, landOf } from './land';
import { offered } from './stop';
import { dispatchTrade, marketWants } from './trade';
import { goldWanted, weaponsWanted } from './military';
import {
  BUILD_TICKS_PER_UNIT,
  BUILDINGS,
  costOf,
  INPUT_CAP,
  ORDERABLE,
  PRODUCER_DISTANCE_FACTOR,
  PROFESSIONS,
  RESOURCE_INFO,
  SITE,
  SURPLUS_KEEP,
} from './config';
import {
  countDelivery,
  distributionKey,
  economyOf,
  recountWorkers,
  spareCarriers,
  transportOrder,
  workerOrder,
  workersOf,
} from './economy';
import { RESOURCES, type Building, type PlayerId, type Point, type Resource, type Settler, type SettlerKind } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Where a carrier picks a unit up: a building's pile (at its door) or goods lying on the ground
 * (`ground.ts`, at the tile itself).
 */
interface Supply {
  at: Point;
  piece: number;
  b?: Building;
  tile?: number;
  /** Its distance counts at this share (`PRODUCER_DISTANCE_FACTOR` for a producer's pile; else 1). */
  factor?: number;
}

/** The player's ground stacks per good: tile, place and piece of land (built once per dispatch round). */
type GroundIndex = Map<Resource, Supply[]>;

function groundIndex(w: World, owner: PlayerId): GroundIndex {
  const out: GroundIndex = new Map();
  const m = w.map;
  for (const i of stackTiles(w)) {
    if (m.owner[i] !== owner || freeGoods(w, i) <= 0) continue;
    const res = goodsOn(w, i)!;
    const at = { x: i % m.w, y: Math.floor(i / m.w) };
    let list = out.get(res);
    if (!list) out.set(res, (list = []));
    list.push({ at, piece: landAt(w, at, owner), tile: i });
  }
  return out;
}

/** Units of `res` a site still has to be brought in all (delivered or on the way do not count). */
export function siteNeeds(b: Building, res: Resource): number {
  return b.done ? 0 : costOf(b.type)[res] - b.delivered[res] - b.inbound[res];
}

/**
 * Units of `res` lying at a site, not yet built in. Builders use up the delivered materials in
 * `RESOURCES` order (planks before stone, as Settlers 4 builds them), as `ruinGoods` counts them.
 */
export function sitePile(b: Building, res: Resource): number {
  let used = Math.floor(b.progress / BUILD_TICKS_PER_UNIT);
  for (const r of RESOURCES) {
    const built = Math.min(b.delivered[r], used);
    if (r === res) return b.delivered[r] - built;
    used -= built;
  }
  return 0;
}

/**
 * Units of `res` the building still wants delivered: site materials or workshop inputs. A site asks,
 * as in Settlers 4, only once a digger is on his way to it (or it is levelled) and only while its pile
 * of the material plus what is on the way stays under `SITE.pile`.
 */
export function demand(w: World, b: Building, res: Resource): number {
  // A stopped building or site asks for nothing (`stop.ts`).
  if (!isReachable(w, b) || b.stopped) return 0;
  if (!b.done) {
    const needs = siteNeeds(b, res);
    if (needs <= 0 || (!b.levelled && b.diggerIds.length === 0)) return 0;
    return Math.min(needs, SITE.pile - sitePile(b, res) - b.inbound[res]);
  }
  const recipe = BUILDINGS[b.type].recipe;
  if (recipe?.inputs[res]) return INPUT_CAP - b.input[res] - b.inbound[res];
  // Every input the building uses, alternatives included, has its own pile of up to INPUT_CAP units.
  if (recipe?.inputsAnyOf?.includes(res)) return INPUT_CAP - b.input[res] - b.inbound[res];
  return goldWanted(w, b, res, INPUT_CAP) || weaponsWanted(b, res) || marketWants(b, res);
}

/**
 * The ready-made worker nearest the workplace's door who may take it up (`canTakeUp`) on its piece
 * of land, taken out of `ready`.
 */
function takeReady(w: World, ready: Settler[], kind: SettlerKind, b: Building, piece: number, owner: PlayerId): Settler | undefined {
  let best = -1;
  for (let i = 0; i < ready.length; i++) {
    if (!canTakeUp(ready[i].kind, kind) || landAt(w, ready[i], owner) !== piece) continue;
    if (best < 0 || dist(ready[i], b.door) < dist(ready[best], b.door)) best = i;
  }
  return best < 0 ? undefined : ready.splice(best, 1)[0];
}

/** Hands jobs to idle carriers (and donkeys) of every player. */
export function dispatch(w: World): void {
  for (const p of w.players) {
    dispatchFor(w, p.id);
    dispatchTrade(w, p.id);
  }
}

/**
 * Priorities: staff finished buildings, then feed demands from the nearest supply,
 * then clear producers' surplus into the nearest warehouse.
 *
 * As in Settlers 4 carriers work only on their own land: a job's source, destination and carrier
 * all stand on one piece of the owner's territory (`land.ts`); other pieces get goods by donkey.
 */
function dispatchFor(w: World, owner: PlayerId): void {
  // Striking carriers (no bed, `beds.ts`) take no job.
  const idle = w.settlers.filter((s) => s.owner === owner && s.kind === 'carrier' && s.tasks.length === 0 && !s.strike);
  const pieceOfCarrier = idle.map((s) => landAt(w, s, owner));
  /** Idle carriers per piece of land, so pieces without any are skipped before searching. */
  const idleOn = new Map<number, number>();
  for (const p of pieceOfCarrier) idleOn.set(p, (idleOn.get(p) ?? 0) + 1);
  const hasIdle = (piece: number) => piece !== 0 && (idleOn.get(piece) ?? 0) > 0;
  const take = (near: Point, piece: number): Settler | undefined => {
    if (!hasIdle(piece)) return undefined;
    let bestIdx = -1;
    for (let i = 0; i < idle.length; i++) {
      if (pieceOfCarrier[i] !== piece) continue;
      if (bestIdx < 0 || dist(idle[i], near) < dist(idle[bestIdx], near)) bestIdx = i;
    }
    if (bestIdx < 0) return undefined;
    pieceOfCarrier.splice(bestIdx, 1);
    idleOn.set(piece, idleOn.get(piece)! - 1);
    return idle.splice(bestIdx, 1)[0];
  };
  const own = [...w.buildings.values()].filter((b) => b.owner === owner);
  const piece = new Map<number, number>();
  for (const b of own) piece.set(b.id, landOf(w, b));
  const pieceOf = (b: Building) => piece.get(b.id)!;
  const ground = groundIndex(w, owner);
  // Every pile offering a good, listed once per round: what is offered only shrinks while jobs are handed out.
  const supplies = new Map<Resource, Supply[]>();
  const suppliesOf = (res: Resource): Supply[] => {
    let list = supplies.get(res);
    if (!list) supplies.set(res, (list = supplyList(w, own, res, pieceOf, ground)));
    return list;
  };
  const supplyOf = (res: Resource, target: Building | null) => nearestSupply(w, suppliesOf(res), res, target, pieceOf);
  // Settlers 4's carrier reserve: no carrier takes up a job while no more than the reserve are left.
  let spare = spareCarriers(w, owner);

  // Ready-made workers waiting for a workplace (Settlers 4's start smiths and miners).
  const ready = w.settlers.filter((s) => s.owner === owner && s.tasks.length === 0 && isReadyWorker(s));
  // Staff finished workplaces: a ready-made worker of the profession first, else a carrier, who
  // fetches the profession's tool from the nearest pile first.
  for (const b of own) {
    const kind = BUILDINGS[b.type].worker;
    if (!kind || !b.done || b.workerId !== null || b.workerRequested || !isReachable(w, b)) continue;
    const r = ready.length > 0 ? takeReady(w, ready, kind, b, pieceOf(b), owner) : undefined;
    if (r) {
      b.workerRequested = true;
      r.tasks = [
        { t: 'goto', x: b.door.x, y: b.door.y },
        { t: 'become', b: b.id, kind },
      ];
      continue;
    }
    // A carrier takes up the job only above the reserve (ready-made workers above are no carriers).
    if (spare <= 0 || !hasIdle(pieceOf(b))) {
      postMessage(w, 'noCarrier', owner, b.door, { b: b.id });
      continue;
    }
    const tool = PROFESSIONS[kind].tool;
    const from = tool ? supplyOf(tool, b) : undefined;
    if (tool && !from) {
      // Waits for the toolsmith; its owner hears of it (Settlers 4 `MissingToolWarning`).
      postMessage(w, 'noTool', owner, b.door, { res: tool });
      continue;
    }
    const s = take(from ? from.at : b.door, pieceOf(b));
    if (!s) continue;
    spare--;
    b.workerRequested = true;
    s.tasks = [];
    if (from && tool) fetchFrom(w, s, from, tool);
    s.tasks.push({ t: 'goto', x: b.door.x, y: b.door.y }, { t: 'become', b: b.id, kind });
  }

  if (idle.length === 0) return;

  // Workers the player ordered (builders, diggers — as in Settlers 4, never more than ordered):
  // carriers pick up the profession's tool and take it up.
  for (const kind of ORDERABLE) {
    const tool = PROFESSIONS[kind].tool;
    for (let k = workerOrder(w, owner, kind) - workersOf(w, owner, kind); k > 0 && spare > 0; k--) {
      const from = tool ? supplyOf(tool, null) : undefined;
      if (tool && !from) {
        postMessage(w, 'noTool', owner, w.homeOf(owner), { res: tool });
        break;
      }
      // Without a tool to fetch, any free carrier will do: the first one's piece of land.
      const s = from ? take(from.at, from.piece) : idle.length > 0 ? take(idle[0], pieceOfCarrier[0]) : undefined;
      if (!s) break;
      spare--;
      s.tasks = [];
      if (from && tool) fetchFrom(w, s, from, tool);
      s.tasks.push({ t: 'retool', kind });
      recountWorkers(w);
    }
  }

  // Demands are served good by good in the player's transport priority (Settlers 4's list), one unit
  // at a time, as Settlers 4's `CEcoSector` does: for a good with several consumer types, the type
  // furthest behind its distribution weight first (`economy.ts`; weight 0 gets none); then finished
  // buildings before sites; among finished ones the most urgent (`urgencyOf`: an emptier pile, less on
  // the way, a nearer supply); sites least-stocked first. A prioritised building is served first and,
  // while a prioritised site still needs the good, nobody else on its piece of land gets any (`SITE`).
  const eco = economyOf(w, owner);
  const order = transportOrder(w, owner);
  /** Pieces of land with work but no carrier: one walks over from another piece (`relocate`). */
  const needy = new Set<number>();
  for (const res of order) {
    if (idle.length === 0) break;
    const key = (b: Building) => distributionKey(eco, res, b);
    let urgent: Set<number> | null = null;
    for (const b of own) {
      if (b.priority && siteNeeds(b, res) > 0 && isReachable(w, b)) (urgent ??= new Set()).add(pieceOf(b));
    }
    const allowed = (b: Building) => !urgent?.has(pieceOf(b)) || (b.priority && !b.done);
    let wanting = own.filter((b) => demand(w, b, res) > 0 && key(b) < Infinity && allowed(b));
    const urgency = new Map<number, number>();
    const rate = (b: Building) => {
      if (b.done) urgency.set(b.id, urgencyOf(b, res, supplyOf(res, b)));
    };
    for (const b of wanting) rate(b);
    const keys = new Map<number, number>();
    while (wanting.length > 0) {
      for (const c of wanting) keys.set(c.id, key(c));
      wanting.sort(
        (a, b) =>
          Number(b.priority) - Number(a.priority) ||
          keys.get(a.id)! - keys.get(b.id)! ||
          Number(!a.done) - Number(!b.done) ||
          (a.done ? urgency.get(b.id)! - urgency.get(a.id)! : stocked(a, res) - stocked(b, res)) ||
          a.id - b.id,
      );
      const b = wanting[0];
      const p = pieceOf(b);
      // Nothing (or nobody to carry it) on its piece of land: every consumer there waits this round,
      // those on other pieces still get served (with one piece this is the old `break`).
      const from = supplyOf(res, b);
      if (from && !hasIdle(p)) needy.add(p);
      const s = from ? take(from.at, p) : undefined;
      if (!s) {
        wanting = wanting.filter((c) => pieceOf(c) !== p);
        continue;
      }
      assignDelivery(w, s, from!, b, res);
      countDelivery(eco, res, b);
      // A supply used up moves everyone's nearest one: rate them all again; else only the one served.
      if (from!.b ? offered(from!.b, res) <= 0 : freeGoods(w, from!.tile!) <= 0) wanting.forEach(rate);
      else rate(b);
      if (demand(w, b, res) <= 0) wanting.shift();
    }
  }

  if (idle.length === 0) return;
  const stored = new Map<Resource, number>();
  const storedOf = (res: Resource) => {
    let n = stored.get(res);
    if (n === undefined) {
      n = 0;
      for (const b of own) if (BUILDINGS[b.type].storage) n += b.output[res] + b.inbound[res];
      stored.set(res, n);
    }
    return n;
  };
  // Where no warehouse on a piece takes a good (or has room), none will later this round: room only
  // shrinks as deliveries are assigned. Spares a search per producer when every warehouse is full.
  const noStore = new Set<number>();
  const storeFor = (near: Point, res: Resource, piece: number): Building | undefined => {
    const key = piece * RESOURCES.length + RESOURCES.indexOf(res);
    if (noStore.has(key)) return undefined;
    const store = nearestStorage(w, owner, near, res, piece);
    if (!store) noStore.add(key);
    return store;
  };
  // Surplus goes to the warehouses in the same transport priority, good by good — and so does what a
  // stopped building or site offers that no consumer took (`stop.ts`).
  const producers = own.filter((b) => (b.done || b.stopped) && !BUILDINGS[b.type].storage && isReachable(w, b));
  // A working producer keeps its last unit for a consumer (`SURPLUS_KEEP`); a stopped one gives all.
  const keeps = producers.map((b) => (isProductionPile(b) && !b.stopped ? SURPLUS_KEEP : 0));
  for (const res of order) {
    const limit = RESOURCE_INFO[res].storeLimit ?? Infinity;
    for (let k = 0; k < producers.length; k++) {
      const b = producers[k];
      while (offered(b, res) > keeps[k] && storedOf(res) < limit) {
        if (!hasIdle(pieceOf(b))) {
          if (pieceOf(b) !== 0) needy.add(pieceOf(b));
          break;
        }
        const store = storeFor(b.door, res, pieceOf(b));
        if (!store) break; // every warehouse on its land refuses it (or there is none): it waits at the producer
        const s = take(b.door, pieceOf(b))!;
        assignDelivery(w, s, { at: b.door, piece: pieceOf(b), b }, store, res);
        stored.set(res, storedOf(res) + 1);
      }
    }
  }
  // Goods on the ground go to a warehouse that takes them (and has room); with none they stay where
  // they lie, a supply for sites and workshops like any pile.
  const taken = acceptedGoods(w, owner);
  for (const res of order) {
    const stacks = ground.get(res);
    if (!stacks || !taken.has(res)) continue;
    const limit = RESOURCE_INFO[res].storeLimit ?? Infinity;
    for (const from of stacks) {
      while (idle.length > 0 && freeGoods(w, from.tile!) > 0 && storedOf(res) < limit) {
        if (!hasIdle(from.piece)) {
          if (from.piece !== 0) needy.add(from.piece);
          break;
        }
        const store = storeFor(from.at, res, from.piece);
        if (!store) break;
        const s = take(from.at, from.piece)!;
        assignDelivery(w, s, from, store, res);
        stored.set(res, storedOf(res) + 1);
      }
    }
  }
  relocate(w, own, needy, idle, pieceOfCarrier, pieceOf);
}

/**
 * Settlers walk anywhere, but carry only on their own piece of land (as in Settlers 4): a piece with
 * work and no free carrier gets one from another piece — it walks to a building there and is free
 * to work on arrival (it then hangs about on that piece, `idle.ts`).
 */
function relocate(
  w: World,
  own: Building[],
  needy: Set<number>,
  idle: Settler[],
  pieceOfCarrier: number[],
  pieceOf: (b: Building) => number,
): void {
  for (const p of [...needy].sort((a, b) => a - b)) {
    if (idle.length === 0) return;
    if (pieceOfCarrier.includes(p)) continue;
    const to = own.find((b) => b.done && pieceOf(b) === p && isReachable(w, b));
    if (!to) continue;
    let k = 0;
    for (let i = 1; i < idle.length; i++) if (dist(idle[i], to.door) < dist(idle[k], to.door)) k = i;
    const s = idle.splice(k, 1)[0];
    pieceOfCarrier.splice(k, 1);
    s.tasks = [{ t: 'goto', x: to.door.x, y: to.door.y }];
  }
}

/** How much of `res` the consumer already has or has coming. */
function stocked(b: Building, res: Resource): number {
  return (b.done ? b.input[res] : b.delivered[res]) + b.inbound[res];
}

/**
 * How urgently a finished consumer wants `res`, as Settlers 4's `CPile::CalcUrgent` over the distance
 * to its nearest supply: (2 × pile size − units on the way − 2 × units lying there) / distance; 0 with
 * no supply. Sites rank after every finished building (S4 gives them a constant below any need).
 */
function urgencyOf(b: Building, res: Resource, from: Supply | undefined): number {
  if (!from) return 0;
  const need = 2 * INPUT_CAP - b.inbound[res] - 2 * b.input[res];
  return need / Math.max(1, dist(from.at, b.door));
}

/**
 * A producer's output pile (Settlers 4's production pile): a finished workplace — one with a worker or
 * a recipe; a warehouse's or a market's piles are of other kinds. It counts at
 * `PRODUCER_DISTANCE_FACTOR` of its distance and keeps `SURPLUS_KEEP` units back from the warehouses.
 */
function isProductionPile(b: Building): boolean {
  const def = BUILDINGS[b.type];
  return b.done && !def.storage && !def.market && !!(def.worker || def.recipe);
}

/** Goods some finished warehouse of the player takes in (so ground stacks of other goods are not even looked at). */
function acceptedGoods(w: World, owner: PlayerId): Set<Resource> {
  const out = new Set<Resource>();
  for (const b of w.buildings.values()) {
    if (b.owner !== owner || !b.done || !BUILDINGS[b.type].storage || b.stopped) continue;
    for (const r of b.accept ?? []) out.add(r);
  }
  return out;
}

/**
 * Every place holding unpromised `res` for the player's carriers: piles at finished buildings, what a
 * stopped building or site offers (`stop.ts`), and ground stacks.
 */
function supplyList(w: World, own: Building[], res: Resource, pieceOf: (b: Building) => number, ground: GroundIndex): Supply[] {
  const out: Supply[] = [];
  for (const b of own) {
    if ((!b.done && !b.stopped) || !isReachable(w, b) || offered(b, res) <= 0) continue;
    out.push({ at: b.door, piece: pieceOf(b), b, factor: isProductionPile(b) ? PRODUCER_DISTANCE_FACTOR : 1 });
  }
  for (const sup of ground.get(res) ?? []) out.push(sup);
  return out;
}

/**
 * Nearest supply still holding unpromised `res` on the same piece of land as `target` (distance from
 * its door, a producer's at `PRODUCER_DISTANCE_FACTOR`; ties: buildings first, then by id or tile), or
 * any on land with carriers when target is null.
 */
function nearestSupply(
  w: World,
  list: readonly Supply[],
  res: Resource,
  target: Building | null,
  pieceOf: (b: Building) => number,
): Supply | undefined {
  const want = target ? pieceOf(target) : -1;
  if (want === 0) return undefined;
  let best: Supply | undefined;
  let bestD = Infinity;
  for (const sup of list) {
    if (sup.piece === 0 || (want > 0 && sup.piece !== want)) continue;
    if (sup.b ? sup.b === target || offered(sup.b, res) <= 0 : freeGoods(w, sup.tile!) <= 0) continue;
    const d = target ? dist(sup.at, target.door) * (sup.factor ?? 1) : 0;
    if (!best || d < bestD) {
      best = sup;
      bestD = d;
    }
  }
  return best;
}

/** Reserves one unit at the supply and queues the walk there and the pickup. */
function fetchFrom(w: World, s: Settler, from: Supply, res: Resource): void {
  s.tasks.push({ t: 'goto', x: from.at.x, y: from.at.y });
  if (from.b) {
    from.b.outReserved[res]++;
    s.tasks.push({ t: 'pickup', b: from.b.id, res });
  } else {
    reserveGoods(w, from.tile!);
    s.tasks.push({ t: 'lift', x: from.at.x, y: from.at.y, res });
  }
}

function assignDelivery(w: World, s: Settler, from: Supply, to: Building, res: Resource): void {
  to.inbound[res]++;
  s.tasks = [];
  fetchFrom(w, s, from, res);
  s.tasks.push({ t: 'goto', x: to.door.x, y: to.door.y }, { t: 'drop', b: to.id, res });
}
