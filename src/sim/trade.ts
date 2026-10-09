import { BUILDINGS, costOf, HANDLE_TICKS, PROFESSIONS, TRADE } from './config';
import { ENDLESS, transportOrder } from './economy';
import { dropGoods } from './ground';
import { type Building, type PlayerId, type Point, type Resource, type Settler, type Task } from './types';
import type { World } from './world';

/**
 * Transport beyond the carriers' land, as in Settlers 4 (manual 17.1): a donkey ranch breeds donkeys
 * (`BuildingDef.breeds`), and a marketplace (`BuildingDef.market`) is the starting point of donkey
 * caravans. The player gives a market a route (`TradeRoute`: the destination market and how many of
 * which goods to send); carriers of the market's land bring those goods to its input, and an idle
 * donkey loads `TRADE.packs` packs of up to `TRADE.donkeyLoad` units of one good each (Settlers 4: two
 * packs of 8), walks over any land (also neutral or enemy) to the destination and puts them on that
 * market's output pile, where the carriers of that piece of land take over — so a cut-off piece of
 * land (`land.ts`) can be supplied.
 */

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const isMarket = (b: Building | undefined): b is Building => !!b && !!BUILDINGS[b.type].market;
const isDonkey = (s: Settler) => PROFESSIONS[s.kind].behavior === 'donkey';

/**
 * The market's destination, if it is still a market of the same player — finished, or a site:
 * donkeys bring a market site on a cut-off piece its own materials (`unloadTick`), since no carrier
 * of that piece has a warehouse to take them from.
 */
export function routeTarget(w: World, m: Building): Building | undefined {
  const to = m.trade?.to;
  if (to === null || to === undefined || to === m.id) return undefined;
  const t = w.buildings.get(to);
  return isMarket(t) && t.owner === m.owner ? t : undefined;
}

/** Whether the market has an order (finite or endless) for the good. */
export function marketOrdered(b: Building, res: Resource): boolean {
  return !!b.trade?.orders[res];
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
 * Sends idle donkeys on trips, as Settlers 4's market (`LoadDonkey`): for every market with a route
 * the ordered goods (in the player's transport priority) go into the packs of the nearest idle
 * donkey — one good per pack, a good may fill both — and it leaves once its packs are full, or once
 * no ordered good it still has room for has more on the way (the rest of a finite order, or all
 * there is).
 */
export function dispatchTrade(w: World, owner: PlayerId): void {
  const idle = w.settlers.filter((s) => s.owner === owner && isDonkey(s) && s.tasks.length === 0 && !w.dying.has(s.id));
  if (idle.length === 0) return;
  const order = transportOrder(w, owner);
  for (const m of w.buildings.values()) {
    // A stopped market sends no donkeys, and none go to a stopped one (`stop.ts`).
    if (m.owner !== owner || !m.done || !isMarket(m) || !m.trade || m.stopped) continue;
    const to = routeTarget(w, m);
    if (!to || to.stopped) continue;
    // One donkey after another, while this market has a load to send.
    while (idle.length > 0) {
      const loads = packLoads(m, order);
      if (!loads) break;
      let k = 0;
      for (let i = 1; i < idle.length; i++) if (dist(idle[i], m.door) < dist(idle[k], m.door)) k = i;
      const s = idle.splice(k, 1)[0];
      for (const l of loads) m.trade.loading[l.res] = (m.trade.loading[l.res] ?? 0) + l.n;
      s.path = [];
      s.tasks = [{ t: 'goto', x: m.door.x, y: m.door.y }, ...loads, { t: 'goto', x: to.door.x, y: to.door.y }, { t: 'unload', b: to.id }];
    }
  }
}

/**
 * The packs the market's next donkey would take (one `load` task each), or null while there is none
 * worth sending yet: nothing waiting, or packs not full while more of an ordered good is coming.
 */
function packLoads(m: Building, order: readonly Resource[]): Extract<Task, { t: 'load' }>[] | null {
  const trade = m.trade!;
  const loads: Extract<Task, { t: 'load' }>[] = [];
  let packs = TRADE.packs;
  let moreComing = false;
  for (const res of order) {
    if (packs === 0) break;
    const want = trade.orders[res];
    if (!want) continue;
    const loading = trade.loading[res] ?? 0;
    const left = want === ENDLESS ? Infinity : want - loading;
    if (left <= 0) continue;
    const room = Math.min(left, packs * TRADE.donkeyLoad);
    const n = Math.min(m.input[res] - loading, room);
    if (n < room && m.inbound[res] > 0) moreComing = true;
    for (let rest = n; rest > 0 && packs > 0; packs--) {
      const k = Math.min(rest, TRADE.donkeyLoad);
      loads.push({ t: 'load', b: m.id, res, n: k });
      rest -= k;
    }
  }
  return loads.length === 0 || (packs > 0 && moreComing) ? null : loads;
}

/** Releases a `load` task's reservation (from `abort`, or once loaded). */
export function releaseLoad(w: World, task: Extract<Task, { t: 'load' }>): void {
  const m = w.buildings.get(task.b);
  if (!m?.trade) return;
  const left = (m.trade.loading[task.res] ?? 0) - task.n;
  if (left > 0) m.trade.loading[task.res] = left;
  else delete m.trade.loading[task.res];
}

/** What a donkey carries: its first pack (`carrying` × `load`) and its second (`pack2`), if any. */
export function packsOf(s: Settler): { res: Resource; n: number }[] {
  const out: { res: Resource; n: number }[] = [];
  if (s.carrying) out.push({ res: s.carrying, n: s.load ?? 1 });
  if (s.pack2) out.push({ ...s.pack2 });
  return out;
}

function emptyPacks(s: Settler): void {
  s.carrying = null;
  delete s.load;
  delete s.pack2;
}

/** The donkey at the market's door fills a pack (its first, else its second); the units leave the order. */
export function loadTick(w: World, s: Settler, task: Extract<Task, { t: 'load' }>): boolean {
  const m = w.buildings.get(task.b);
  releaseLoad(w, task);
  const n = m?.trade ? Math.min(task.n, m.input[task.res]) : 0;
  if (!m?.trade || n <= 0) {
    // A second pack that finds nothing left stays empty; the trip fails only with nothing loaded.
    if (!s.carrying) return false;
    s.tasks.shift();
    return true;
  }
  m.input[task.res] -= n;
  const order = m.trade.orders[task.res];
  if (order !== undefined && order !== ENDLESS) {
    if (order - n > 0) m.trade.orders[task.res] = order - n;
    else delete m.trade.orders[task.res];
  }
  if (!s.carrying) {
    s.carrying = task.res;
    s.load = n;
  } else s.pack2 = { res: task.res, n };
  s.tasks.shift();
  s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
  return true;
}

/**
 * The donkey puts its packs onto the destination market's output pile; a market still under
 * construction first takes what its site lacks as delivered material, the rest waits on its pile.
 */
export function unloadTick(w: World, s: Settler, task: Extract<Task, { t: 'unload' }>): boolean {
  const m = w.buildings.get(task.b);
  if (!isMarket(m) || m.owner !== s.owner) return false;
  for (const pack of packsOf(s)) {
    let n = pack.n;
    if (!m.done) {
      const lacking = Math.max(0, (costOf(m.type)[pack.res] ?? 0) - m.delivered[pack.res] - m.inbound[pack.res]);
      const used = Math.min(n, lacking);
      m.delivered[pack.res] += used;
      n -= used;
    }
    m.output[pack.res] += n;
  }
  emptyPacks(s);
  s.tasks.shift();
  s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
  return true;
}

/**
 * A donkey whose trip failed with goods in its packs takes them to the nearest market of its owner;
 * with none left, it puts them down on the ground where it stands (`ground.ts`).
 */
export function donkeyAbort(w: World, s: Settler): void {
  if (!s.carrying) return;
  const home = nearestMarket(w, s.owner, s);
  if (home) {
    s.tasks = [
      { t: 'goto', x: home.door.x, y: home.door.y },
      { t: 'unload', b: home.id },
    ];
  } else {
    for (const pack of packsOf(s)) dropGoods(w, s, pack.res, pack.n);
    emptyPacks(s);
  }
}

/**
 * Idle donkeys wait at the nearest market, out of the way; with none (the start's donkeys, S4's
 * `START_CONDITIONS.donkeys`) they step out of the building they are in and stand by.
 */
export function donkeyIdle(w: World, s: Settler): void {
  const at = nearestMarket(w, s.owner, s);
  if (!at) {
    s.inside = null;
    return;
  }
  if (Math.abs(s.x - at.door.x) <= 1 && Math.abs(s.y - at.door.y) <= 1) return;
  s.tasks = [{ t: 'goto', x: at.door.x, y: at.door.y, adj: true }];
}
