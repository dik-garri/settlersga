import { canTakeUp, isReachable, isReadyWorker, nearestStorage } from './buildings';
import { freeGoods, goodsOn, reserveGoods, stackTiles } from './ground';
import { landAt, landOf } from './land';
import { dispatchTrade, marketWants } from './trade';
import { goldWanted, staffGarrisons, wantsRecruit, weaponsWanted } from './military';
import { BUILDINGS, costOf, INPUT_CAP, ORDERABLE, PROFESSIONS, RESOURCE_INFO } from './config';
import { countDelivery, distributionKey, economyOf, recountWorkers, workerOrder, workersOf } from './economy';
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

/** Units of `res` the building still wants delivered: site materials or workshop inputs. */
export function demand(w: World, b: Building, res: Resource): number {
  if (!isReachable(w, b)) return 0;
  if (!b.done) return costOf(b.type)[res] - b.delivered[res] - b.inbound[res];
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
  const idle = w.settlers.filter((s) => s.owner === owner && s.kind === 'carrier' && s.tasks.length === 0);
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
  const supplyOf = (res: Resource, target: Building | null) => nearestSupply(w, own, res, target, pieceOf, ground);

  // Ready-made workers waiting for a workplace (Settlers 4's start smiths and miners).
  const ready = w.settlers.filter((s) => s.owner === owner && s.tasks.length === 0 && isReadyWorker(s));
  // Staff finished workplaces: a ready-made worker of the profession first, else a carrier, who
  // fetches the profession's tool from the nearest pile first.
  for (const b of own) {
    const kind = BUILDINGS[b.type].worker;
    if (!kind || !b.done || b.workerId !== null || b.workerRequested || !isReachable(w, b)) continue;
    // A barracks calls its next recruit only when there is a weapon for him and room for a new fighter.
    if (BUILDINGS[b.type].barracks && !wantsRecruit(w, b)) continue;
    const r = ready.length > 0 ? takeReady(w, ready, kind, b, pieceOf(b), owner) : undefined;
    if (r) {
      b.workerRequested = true;
      r.tasks = [
        { t: 'goto', x: b.door.x, y: b.door.y },
        { t: 'become', b: b.id, kind },
      ];
      continue;
    }
    if (!hasIdle(pieceOf(b))) continue;
    const tool = PROFESSIONS[kind].tool;
    const from = tool ? supplyOf(tool, b) : undefined;
    if (tool && !from) continue; // waits for the toolsmith
    const s = take(from ? from.at : b.door, pieceOf(b));
    if (!s) continue;
    b.workerRequested = true;
    s.tasks = [];
    if (from && tool) fetchFrom(w, s, from, tool);
    s.tasks.push({ t: 'goto', x: b.door.x, y: b.door.y }, { t: 'become', b: b.id, kind });
  }

  staffGarrisons(w, own);
  if (idle.length === 0) return;

  // Workers the player ordered (builders, diggers — as in Settlers 4, never more than ordered):
  // carriers pick up the profession's tool and take it up.
  for (const kind of ORDERABLE) {
    const tool = PROFESSIONS[kind].tool;
    for (let k = workerOrder(w, owner, kind) - workersOf(w, owner, kind); k > 0; k--) {
      const from = tool ? supplyOf(tool, null) : undefined;
      if (tool && !from) break;
      // Without a tool to fetch, any free carrier will do: the first one's piece of land.
      const s = from ? take(from.at, from.piece) : idle.length > 0 ? take(idle[0], pieceOfCarrier[0]) : undefined;
      if (!s) break;
      s.tasks = [];
      if (from && tool) fetchFrom(w, s, from, tool);
      s.tasks.push({ t: 'retool', kind });
      recountWorkers(w);
    }
  }

  // Demands are served one unit per round, least-stocked consumer first, so a scarce resource is
  // shared fairly instead of the oldest building taking it all; for a good the player distributes
  // (`economy.ts`), the consumer type furthest behind its weight goes first, and weight 0 gets none.
  const eco = economyOf(w, owner);
  /** Pieces of land with work but no carrier: one walks over from another piece (`relocate`). */
  const needy = new Set<number>();
  for (const res of RESOURCES) {
    if (idle.length === 0) break;
    const distributed = eco.distribution[res] !== undefined;
    const key = (b: Building) => (distributed ? distributionKey(eco, res, b) : 0);
    let wanting = own.filter((b) => demand(w, b, res) > 0 && key(b) < Infinity);
    while (wanting.length > 0) {
      wanting.sort(
        (a, b) =>
          Number(b.priority) - Number(a.priority) ||
          key(a) - key(b) ||
          stocked(a, res) - stocked(b, res) ||
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
  for (const b of own) {
    if (!b.done || BUILDINGS[b.type].storage || !isReachable(w, b)) continue;
    for (const res of RESOURCES) {
      const limit = RESOURCE_INFO[res].storeLimit ?? Infinity;
      while (b.output[res] - b.outReserved[res] > 0 && storedOf(res) < limit) {
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
  for (const [res, stacks] of ground) {
    if (!taken.has(res)) continue;
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

/** Goods some finished warehouse of the player takes in (so ground stacks of other goods are not even looked at). */
function acceptedGoods(w: World, owner: PlayerId): Set<Resource> {
  const out = new Set<Resource>();
  for (const b of w.buildings.values()) {
    if (b.owner !== owner || !b.done || !BUILDINGS[b.type].storage) continue;
    for (const r of b.accept ?? []) out.add(r);
  }
  return out;
}

/**
 * Nearest pile or ground stack holding unpromised `res` on the same piece of land as `target`
 * (distance from its door; ties: buildings first, then by id or tile), or any on land with carriers
 * when target is null.
 */
function nearestSupply(
  w: World,
  own: Building[],
  res: Resource,
  target: Building | null,
  pieceOf: (b: Building) => number,
  ground: GroundIndex,
): Supply | undefined {
  const want = target ? pieceOf(target) : -1;
  if (want === 0) return undefined;
  let best: Supply | undefined;
  let bestD = Infinity;
  const consider = (sup: Supply) => {
    if (sup.piece === 0 || (want > 0 && sup.piece !== want)) return;
    const d = target ? dist(sup.at, target.door) : 0;
    if (!best || d < bestD) {
      best = sup;
      bestD = d;
    }
  };
  for (const b of own) {
    if (b === target || !b.done || !isReachable(w, b) || b.output[res] - b.outReserved[res] <= 0) continue;
    consider({ at: b.door, piece: pieceOf(b), b });
  }
  for (const sup of ground.get(res) ?? []) if (freeGoods(w, sup.tile!) > 0) consider(sup);
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
