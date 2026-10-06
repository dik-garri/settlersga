import { isReachable, nearestStorage } from './buildings';
import { BUILDINGS, costOf, INPUT_CAP } from './config';
import { RESOURCES, type Building, type PlayerId, type Point, type Resource, type Settler } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Units of `res` the building still wants delivered: site materials or workshop inputs. */
export function demand(w: World, b: Building, res: Resource): number {
  if (!isReachable(w, b)) return 0;
  if (!b.done) return costOf(b.type)[res] - b.delivered[res] - b.inbound[res];
  const recipe = BUILDINGS[b.type].recipe;
  if (recipe?.inputs[res]) return INPUT_CAP - b.input[res] - b.inbound[res];
  return 0;
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
  if (idle.length === 0) return;
  const take = (near: Point): Settler | undefined => {
    let bestIdx = -1;
    for (let i = 0; i < idle.length; i++) {
      if (bestIdx < 0 || dist(idle[i], near) < dist(idle[bestIdx], near)) bestIdx = i;
    }
    return bestIdx < 0 ? undefined : idle.splice(bestIdx, 1)[0];
  };
  const own = [...w.buildings.values()].filter((b) => b.owner === owner);

  for (const b of own) {
    const kind = BUILDINGS[b.type].worker;
    if (!kind || !b.done || b.workerId !== null || b.workerRequested || !isReachable(w, b)) continue;
    const s = take(b.door);
    if (!s) return;
    b.workerRequested = true;
    s.tasks = [
      { t: 'goto', x: b.door.x, y: b.door.y },
      { t: 'become', b: b.id, kind },
    ];
  }

  for (const b of own) {
    for (const res of RESOURCES) {
      let need = demand(w, b, res);
      while (need-- > 0) {
        const from = nearestSupply(w, own, res, b);
        if (!from) break;
        const s = take(from.door);
        if (!s) return;
        assignDelivery(s, from, b, res);
      }
    }
  }

  for (const b of own) {
    if (!b.done || BUILDINGS[b.type].storage || !isReachable(w, b)) continue;
    for (const res of RESOURCES) {
      while (b.output[res] - b.outReserved[res] > 0) {
        const store = nearestStorage(w, owner, b.door);
        if (!store) return;
        const s = take(b.door);
        if (!s) return;
        assignDelivery(s, b, store, res);
      }
    }
  }
}

function nearestSupply(w: World, own: Building[], res: Resource, target: Building): Building | undefined {
  let best: Building | undefined;
  for (const b of own) {
    if (b === target || !b.done || !isReachable(w, b) || b.output[res] - b.outReserved[res] <= 0) continue;
    if (!best || dist(b.door, target.door) < dist(best.door, target.door)) best = b;
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
