import { BUILDINGS, HANDLE_TICKS, PROFESSIONS, TRADE } from './config';
import { ENDLESS } from './economy';
import { RESOURCES, type Building, type PlayerId, type Point, type Resource, type Settler, type Task } from './types';
import type { World } from './world';

/**
 * Transport beyond the carriers' land, as in Settlers 4 (manual 17.1): a donkey ranch breeds donkeys
 * (`BuildingDef.breeds`), and a marketplace (`BuildingDef.market`) is the starting point of donkey
 * caravans. The player gives a market a route (`TradeRoute`: the destination market and how many of
 * which goods to send); carriers of the market's land bring those goods to its input, and an idle
 * donkey loads up to `TRADE.donkeyLoad` units of one good, walks over any land (also neutral or
 * enemy) to the destination and puts them on that market's output pile, where the carriers of that
 * piece of land take over — so a cut-off piece of land (`land.ts`) can be supplied.
 */

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const isMarket = (b: Building | undefined): b is Building => !!b && !!BUILDINGS[b.type].market;
const isDonkey = (s: Settler) => PROFESSIONS[s.kind].behavior === 'donkey';

/** The market's destination, if it is still a finished market of the same player. */
export function routeTarget(w: World, m: Building): Building | undefined {
  const to = m.trade?.to;
  if (to === null || to === undefined || to === m.id) return undefined;
  const t = w.buildings.get(to);
  return isMarket(t) && t.done && t.owner === m.owner ? t : undefined;
}

/** Units of `res` a market still wants its carriers to bring for its route (part of `demand`). */
export function marketWants(b: Building, res: Resource): number {
  const order = b.trade?.orders[res];
  if (!order || !BUILDINGS[b.type].market || !b.done || b.trade?.to == null) return 0;
  const target = order === ENDLESS ? TRADE.stock : Math.min(order, TRADE.stock);
  return Math.max(0, target - b.input[res] - b.inbound[res]);
}

/** Whether the player's donkey ranches should breed another donkey (fewer than the markets use). */
export function wantsDonkeys(w: World, owner: PlayerId): boolean {
  let markets = 0;
  for (const b of w.buildings.values()) if (b.owner === owner && b.done && isMarket(b)) markets++;
  if (markets === 0) return false;
  let donkeys = 0;
  for (const s of w.settlers) if (s.owner === owner && isDonkey(s) && !w.dying.has(s.id)) donkeys++;
  return donkeys < markets * TRADE.donkeysPerMarket;
}

/** The player's nearest finished marketplace (where an idle donkey waits). */
export function nearestMarket(w: World, owner: PlayerId, near: Point): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of w.buildings.values()) {
    if (b.owner !== owner || !b.done || !isMarket(b)) continue;
    const d = dist(b.door, near);
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/**
 * Sends idle donkeys on trips: for every market with a route, every ordered good (in resource
 * order) whose waiting units make a full load — or the rest of the order, or all there is while
 * nothing more is on the way — goes with the nearest idle donkey.
 */
export function dispatchTrade(w: World, owner: PlayerId): void {
  const idle = w.settlers.filter((s) => s.owner === owner && isDonkey(s) && s.tasks.length === 0 && !w.dying.has(s.id));
  if (idle.length === 0) return;
  for (const m of w.buildings.values()) {
    if (m.owner !== owner || !m.done || !isMarket(m) || !m.trade) continue;
    const to = routeTarget(w, m);
    if (!to) continue;
    for (const res of RESOURCES) {
      const order = m.trade.orders[res];
      if (!order) continue;
      const loading = m.trade.loading[res] ?? 0;
      const waiting = m.input[res] - loading;
      const left = order === ENDLESS ? Infinity : order - loading;
      if (waiting <= 0 || left <= 0) continue;
      const full = Math.min(TRADE.donkeyLoad, left);
      const n = Math.min(full, waiting);
      if (n < full && m.inbound[res] > 0) continue; // more is coming: wait for a full load
      let k = 0;
      for (let i = 1; i < idle.length; i++) if (dist(idle[i], m.door) < dist(idle[k], m.door)) k = i;
      const s = idle.splice(k, 1)[0];
      m.trade.loading[res] = loading + n;
      s.path = [];
      s.tasks = [
        { t: 'goto', x: m.door.x, y: m.door.y },
        { t: 'load', b: m.id, res, n },
        { t: 'goto', x: to.door.x, y: to.door.y },
        { t: 'unload', b: to.id },
      ];
      if (idle.length === 0) return;
    }
  }
}

/** Releases a `load` task's reservation (from `abort`, or once loaded). */
export function releaseLoad(w: World, task: Extract<Task, { t: 'load' }>): void {
  const m = w.buildings.get(task.b);
  if (!m?.trade) return;
  const left = (m.trade.loading[task.res] ?? 0) - task.n;
  if (left > 0) m.trade.loading[task.res] = left;
  else delete m.trade.loading[task.res];
}

/** The donkey at the market's door takes its load; the units leave the order. */
export function loadTick(w: World, s: Settler, task: Extract<Task, { t: 'load' }>): boolean {
  const m = w.buildings.get(task.b);
  releaseLoad(w, task);
  const n = m?.trade ? Math.min(task.n, m.input[task.res]) : 0;
  if (!m?.trade || n <= 0) return false;
  m.input[task.res] -= n;
  const order = m.trade.orders[task.res];
  if (order !== undefined && order !== ENDLESS) {
    if (order - n > 0) m.trade.orders[task.res] = order - n;
    else delete m.trade.orders[task.res];
  }
  s.carrying = task.res;
  s.load = n;
  s.tasks.shift();
  s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
  return true;
}

/** The donkey puts its packs onto the destination market's output pile. */
export function unloadTick(w: World, s: Settler, task: Extract<Task, { t: 'unload' }>): boolean {
  const m = w.buildings.get(task.b);
  if (!isMarket(m) || m.owner !== s.owner) return false;
  if (s.carrying) m.output[s.carrying] += s.load ?? 1;
  s.carrying = null;
  delete s.load;
  s.tasks.shift();
  s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
  return true;
}

/**
 * A donkey whose trip failed with goods in its packs takes them to the nearest market of its owner;
 * with none left, they are lost.
 */
export function donkeyAbort(w: World, s: Settler): void {
  const res = s.carrying;
  if (!res) return;
  const home = nearestMarket(w, s.owner, s);
  if (home) {
    s.tasks = [
      { t: 'goto', x: home.door.x, y: home.door.y },
      { t: 'unload', b: home.id },
    ];
  } else {
    w.stats.lost[res] += s.load ?? 1;
    s.carrying = null;
    delete s.load;
  }
}

/** Idle donkeys wait at the nearest market (or the ranch they came from), out of the way. */
export function donkeyIdle(w: World, s: Settler): void {
  const at =
    nearestMarket(w, s.owner, s) ?? (s.inside !== null ? w.buildings.get(s.inside) : undefined) ?? w.castleOf(s.owner);
  if (Math.abs(s.x - at.door.x) <= 1 && Math.abs(s.y - at.door.y) <= 1) return;
  s.tasks = [{ t: 'goto', x: at.door.x, y: at.door.y, adj: true }];
}
