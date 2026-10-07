import { isReachable, nearestStorage } from './buildings';
import { goldWanted, staffGarrisons, wantsRecruit, weaponsWanted } from './military';
import { BUILDINGS, costOf, INPUT_CAP, ORDERABLE, PROFESSIONS, RESOURCE_INFO } from './config';
import { countDelivery, distributionKey, economyOf, recountWorkers, workerOrder, workersOf } from './economy';
import { RESOURCES, type Building, type PlayerId, type Point, type Resource, type Settler } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Units of `res` the building still wants delivered: site materials or workshop inputs. */
export function demand(w: World, b: Building, res: Resource): number {
  if (!isReachable(w, b)) return 0;
  if (!b.done) return costOf(b.type)[res] - b.delivered[res] - b.inbound[res];
  const recipe = BUILDINGS[b.type].recipe;
  if (recipe?.inputs[res]) return INPUT_CAP - b.input[res] - b.inbound[res];
  if (recipe?.inputsAnyOf?.includes(res)) {
    // Alternatives share one pile limit.
    const held = recipe.inputsAnyOf.reduce((n, r) => n + b.input[r] + b.inbound[r], 0);
    return INPUT_CAP - held;
  }
  return goldWanted(w, b, res, INPUT_CAP) || weaponsWanted(b, res);
}

/** Hands jobs to idle carriers of every player. */
export function dispatch(w: World): void {
  for (const p of w.players) dispatchFor(w, p.id);
}

/**
 * Priorities: staff finished buildings, then feed demands from the nearest supply,
 * then clear producers' surplus into the nearest warehouse.
 */
function dispatchFor(w: World, owner: PlayerId): void {
  const idle = w.settlers.filter((s) => s.owner === owner && s.kind === 'carrier' && s.tasks.length === 0);
  const take = (near: Point): Settler | undefined => {
    let bestIdx = -1;
    for (let i = 0; i < idle.length; i++) {
      if (bestIdx < 0 || dist(idle[i], near) < dist(idle[bestIdx], near)) bestIdx = i;
    }
    return bestIdx < 0 ? undefined : idle.splice(bestIdx, 1)[0];
  };
  const own = [...w.buildings.values()].filter((b) => b.owner === owner);

  // Staff finished workplaces; professions with a tool fetch it from the nearest pile first.
  for (const b of own) {
    const kind = BUILDINGS[b.type].worker;
    if (!kind || !b.done || b.workerId !== null || b.workerRequested || !isReachable(w, b)) continue;
    // A barracks calls its next recruit only when there is a weapon for him and room for a new fighter.
    if (BUILDINGS[b.type].barracks && !wantsRecruit(w, b)) continue;
    const tool = PROFESSIONS[kind].tool;
    const from = tool ? nearestSupply(w, own, tool, b) : undefined;
    if (tool && !from) continue; // waits for the toolsmith
    const s = take(from ? from.door : b.door);
    if (!s) break;
    b.workerRequested = true;
    s.tasks = [];
    if (from && tool) {
      from.outReserved[tool]++;
      s.tasks.push({ t: 'goto', x: from.door.x, y: from.door.y }, { t: 'pickup', b: from.id, res: tool });
    }
    s.tasks.push({ t: 'goto', x: b.door.x, y: b.door.y }, { t: 'become', b: b.id, kind });
  }

  staffGarrisons(w, own);
  if (idle.length === 0) return;

  // Workers the player ordered (builders, diggers — as in Settlers 4, never more than ordered):
  // carriers pick up the profession's tool and take it up.
  for (const kind of ORDERABLE) {
    const tool = PROFESSIONS[kind].tool;
    for (let k = workerOrder(w, owner, kind) - workersOf(w, owner, kind); k > 0; k--) {
      const from = tool ? nearestSupply(w, own, tool, null) : undefined;
      if (tool && !from) break;
      const s = take(from ? from.door : w.castleOf(owner).door);
      if (!s) return;
      s.tasks = [];
      if (from && tool) {
        from.outReserved[tool]++;
        s.tasks.push({ t: 'goto', x: from.door.x, y: from.door.y }, { t: 'pickup', b: from.id, res: tool });
      }
      s.tasks.push({ t: 'retool', kind });
      recountWorkers(w);
    }
  }

  // Demands are served one unit per round, least-stocked consumer first, so a scarce resource is
  // shared fairly instead of the oldest building taking it all; for a good the player distributes
  // (`economy.ts`), the consumer type furthest behind its weight goes first, and weight 0 gets none.
  const eco = economyOf(w, owner);
  for (const res of RESOURCES) {
    const distributed = eco.distribution[res] !== undefined;
    const key = (b: Building) => (distributed ? distributionKey(eco, res, b) : 0);
    const wanting = own.filter((b) => demand(w, b, res) > 0 && key(b) < Infinity);
    while (wanting.length > 0) {
      wanting.sort(
        (a, b) =>
          Number(b.priority) - Number(a.priority) ||
          key(a) - key(b) ||
          stocked(a, res) - stocked(b, res) ||
          a.id - b.id,
      );
      const b = wanting[0];
      const from = nearestSupply(w, own, res, b);
      if (!from) break;
      const s = take(from.door);
      if (!s) return;
      assignDelivery(s, from, b, res);
      countDelivery(eco, res, b);
      if (demand(w, b, res) <= 0) wanting.shift();
    }
  }

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
  for (const b of own) {
    if (!b.done || BUILDINGS[b.type].storage || !isReachable(w, b)) continue;
    for (const res of RESOURCES) {
      const limit = RESOURCE_INFO[res].storeLimit ?? Infinity;
      while (b.output[res] - b.outReserved[res] > 0 && storedOf(res) < limit) {
        const store = nearestStorage(w, owner, b.door, res);
        if (!store) break; // every warehouse refuses it: it waits at the producer
        const s = take(b.door);
        if (!s) return;
        assignDelivery(s, b, store, res);
        stored.set(res, storedOf(res) + 1);
      }
    }
  }
}

/** How much of `res` the consumer already has or has coming. */
function stocked(b: Building, res: Resource): number {
  return (b.done ? b.input[res] : b.delivered[res]) + b.inbound[res];
}

/** Nearest pile holding unpromised `res`; distance from `target`'s door, or any when target is null. */
function nearestSupply(w: World, own: Building[], res: Resource, target: Building | null): Building | undefined {
  let best: Building | undefined;
  for (const b of own) {
    if (b === target || !b.done || !isReachable(w, b) || b.output[res] - b.outReserved[res] <= 0) continue;
    if (!best || (target && dist(b.door, target.door) < dist(best.door, target.door))) best = b;
  }
  return best;
}

function assignDelivery(s: Settler, from: Building, to: Building, res: Resource): void {
  from.outReserved[res]++;
  to.inbound[res]++;
  s.tasks = [
    { t: 'goto', x: from.door.x, y: from.door.y },
    { t: 'pickup', b: from.id, res },
    { t: 'goto', x: to.door.x, y: to.door.y },
    { t: 'drop', b: to.id, res },
  ];
}
