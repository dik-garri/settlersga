import { nearestStorage } from './buildings';
import { PIONEER, PROFESSIONS, THIEF } from './config';
import { workerOrder } from './economy';
import { restIdle } from './idle';
import { isFighter, killSettler } from './military';
import { RESOURCES, type Building, type PlayerId, type Resource, type Settler, type Task } from './types';
import type { World } from './world';

/**
 * Specialists, as in Settlers 4: made from free carriers on the player's order (`ORDERABLE`, like
 * builders), then sent on errands.
 *
 * Pioneer: `sendPioneer` points him at neutral land next to his owner's; there he claims tiles one by
 * one — each a neutral, passable tile 4-adjacent to the owner's land within `PIONEER.radius` of the
 * spot, the nearest first — until `PIONEER.maxTiles` are his or none is left. A claim is recorded in
 * `map.claimed` (saved) and the tile's `map.owner` is set at once; `recomputeTerritory` keeps giving
 * claimed tiles to their claimant wherever no military building claims them, so land a tower or castle
 * claims always wins, and the claim comes back if that building goes. Pioneers never claim owned land.
 *
 * Thief: `sendThief` points him at a foreign, explored building with goods at its door (or in stock);
 * he walks there unnoticed, takes one unit of its most plentiful good in `THIEF.stealTicks` and carries
 * it to his owner's nearest warehouse, then goes back for more until the building is bare or gone.
 * On hostile land he may be caught (`thiefWatch`): every `THIEF.checkEvery` ticks any hostile fighter
 * outdoors within `THIEF.catchRadius`, or garrisoned hostile building whose door is that close, catches
 * him with `THIEF.catchChance` (world RNG) — he dies, and whatever he carries is lost.
 *
 * Both keep their errand in `Settler.errand` (saved); without one they idle with the crowd.
 * `dismissSpecialist` turns an idle one standing on his owner's land back into a carrier (bringing the
 * tool back to a warehouse) and lowers the order.
 */

const N4: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** Whether a pioneer of `player` may claim the tile: neutral, passable, next to the player's land. */
export function claimable(w: World, x: number, y: number, player: PlayerId): boolean {
  const m = w.map;
  if (!m.inBounds(x, y)) return false;
  const i = m.idx(x, y);
  if (m.owner[i] !== 0 || !m.isWalkable(x, y)) return false;
  return N4.some(([dx, dy]) => m.inBounds(x + dx, y + dy) && m.owner[m.idx(x + dx, y + dy)] === player);
}

/** The claimable tile within `PIONEER.radius` of (cx, cy) nearest to `from` (ties: lowest index). */
function nextClaim(w: World, cx: number, cy: number, player: PlayerId, from: { x: number; y: number }) {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  const r = PIONEER.radius;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (Math.hypot(x - cx, y - cy) > r || !claimable(w, x, y, player)) continue;
      const d = Math.hypot(x - from.x, y - from.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/** The player's idle specialist of `kind` nearest to (x, y). */
function idleSpecialist(w: World, player: PlayerId, kind: 'pioneer' | 'thief', x: number, y: number): Settler | undefined {
  let best: Settler | undefined;
  let bestD = Infinity;
  for (const s of w.settlers) {
    if (s.owner !== player || s.kind !== kind || s.tasks.length > 0 || s.errand) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Player command: send an idle pioneer to push the border around (x, y). */
export function sendPioneer(w: World, x: number, y: number, player: PlayerId): boolean {
  if (!nextClaim(w, x, y, player, { x, y })) return false;
  const s = idleSpecialist(w, player, 'pioneer', x, y);
  if (!s) return false;
  s.errand = { x, y, n: PIONEER.maxTiles };
  return true;
}

/** Whether a thief of `player` may be sent to rob `b`: foreign, not allied, explored, with goods. */
export function robbable(w: World, b: Building, player: PlayerId): boolean {
  if (b.owner === player || w.allied(b.owner, player) || !b.done) return false;
  if (!w.isExplored(b.door.x, b.door.y, player)) return false;
  return lootOf(b) !== null;
}

/** The good a thief takes from the building: its most plentiful one not promised to a carrier. */
function lootOf(b: Building): Resource | null {
  let best: Resource | null = null;
  let most = 0;
  for (const r of RESOURCES) {
    const n = b.output[r] - b.outReserved[r];
    if (n > most) {
      most = n;
      best = r;
    }
  }
  return best;
}

/** Player command: send an idle thief to rob building `targetId`. */
export function sendThief(w: World, targetId: number, player: PlayerId): boolean {
  const b = w.buildings.get(targetId);
  if (!b || !robbable(w, b, player)) return false;
  const s = idleSpecialist(w, player, 'thief', b.door.x, b.door.y);
  if (!s) return false;
  s.errand = { x: b.door.x, y: b.door.y, b: b.id };
  return true;
}

/**
 * Player command: one idle specialist (or other orderable worker) of `kind` on his owner's land goes
 * back to being a carrier, bringing his tool back to a warehouse; the order drops by one.
 */
export function dismissSpecialist(w: World, kind: Settler['kind'], player: PlayerId): boolean {
  const m = w.map;
  const s = w.settlers.find(
    (o) =>
      o.owner === player &&
      o.kind === kind &&
      o.tasks.length === 0 &&
      !o.errand &&
      o.inside === null &&
      m.owner[m.idx(Math.round(o.x), Math.round(o.y))] === player,
  );
  if (!s) return false;
  w.orderWorkers(kind, Math.max(0, workerOrder(w, player, kind) - 1), player);
  s.kind = 'carrier';
  s.hp = 0;
  const tool = PROFESSIONS[kind].tool;
  const store = tool ? nearestStorage(w, player, s) : undefined;
  if (tool && store) {
    s.carrying = tool;
    store.inbound[tool]++;
    s.tasks = [
      { t: 'goto', x: store.door.x, y: store.door.y },
      { t: 'drop', b: store.id, res: tool, back: true },
    ];
  }
  return true;
}

/** Idle pioneer: claim the next tile of the errand, or hang about once it is done. */
export function pioneerIdle(w: World, s: Settler): void {
  const e = s.errand;
  if (e && (e.n ?? 0) > 0) {
    const t = nextClaim(w, e.x, e.y, s.owner, s);
    if (t) {
      s.tasks = [
        { t: 'goto', x: t.x, y: t.y },
        { t: 'claim', x: t.x, y: t.y, n: PIONEER.claimTicks },
      ];
      return;
    }
  }
  s.errand = null;
  restIdle(w, s);
}

/** `claim` task: work the border stone, then the tile is the owner's (if still claimable). */
export function claimTick(w: World, s: Settler, task: Extract<Task, { t: 'claim' }>): void {
  s.working = true;
  if (--task.n > 0) return;
  s.tasks.shift();
  if (!claimable(w, task.x, task.y, s.owner)) return;
  const m = w.map;
  const i = m.idx(task.x, task.y);
  m.claimed[i] = s.owner;
  m.owner[i] = s.owner;
  w.pioneerLand++;
  w.territoryVersion++;
  if (s.errand && s.errand.n !== undefined) s.errand.n--;
}

/** Idle thief: (back) to the building he was sent to rob, while there is loot; else hang about. */
export function thiefIdle(w: World, s: Settler): void {
  const e = s.errand;
  const b = e?.b !== undefined ? w.buildings.get(e.b) : undefined;
  if (b && robbable(w, b, s.owner)) {
    s.tasks = [
      { t: 'goto', x: b.door.x, y: b.door.y },
      { t: 'steal', b: b.id, n: THIEF.stealTicks },
    ];
    return;
  }
  s.errand = null;
  restIdle(w, s);
}

/** `steal` task: after `n` ticks at the door, take one good and carry it to a warehouse at home. */
export function stealTick(w: World, s: Settler, task: Extract<Task, { t: 'steal' }>): void {
  const b = w.buildings.get(task.b);
  if (!b || b.owner === s.owner || w.allied(b.owner, s.owner)) {
    s.tasks.shift();
    return;
  }
  s.working = true;
  if (--task.n > 0) return;
  s.tasks.shift();
  const res = lootOf(b);
  if (!res) return;
  const store = nearestStorage(w, s.owner, s, res);
  if (!store) return;
  b.output[res]--;
  s.carrying = res;
  store.inbound[res]++;
  s.tasks = [
    { t: 'goto', x: store.door.x, y: store.door.y },
    { t: 'drop', b: store.id, res },
  ];
}

/**
 * A thief on hostile land may be caught (see the module comment). Called every tick for thieves; the
 * check runs every `THIEF.checkEvery` ticks, staggered by id.
 */
export function thiefWatch(w: World, s: Settler): void {
  if (s.inside !== null || (w.tick + s.id) % THIEF.checkEvery !== 0) return;
  const m = w.map;
  const x = Math.round(s.x);
  const y = Math.round(s.y);
  if (!m.inBounds(x, y)) return;
  const owner = m.owner[m.idx(x, y)];
  if (owner === 0 || owner === s.owner || w.allied(owner, s.owner)) return;
  const r = THIEF.catchRadius;
  let watched = false;
  for (const o of w.settlers) {
    if (o.inside !== null || !isFighter(o) || o.owner === s.owner || w.allied(o.owner, s.owner)) continue;
    if (Math.hypot(o.x - s.x, o.y - s.y) <= r) {
      watched = true;
      break;
    }
  }
  if (!watched) {
    for (const b of w.buildings.values()) {
      if (b.garrison.length === 0 || b.owner === s.owner || w.allied(b.owner, s.owner)) continue;
      if (Math.hypot(b.door.x - s.x, b.door.y - s.y) <= r) {
        watched = true;
        break;
      }
    }
  }
  if (!watched || w.rng() >= THIEF.catchChance) return;
  if (s.carrying) w.stats.lost[s.carrying]++;
  s.carrying = null;
  w.stats.thievesCaught++;
  killSettler(w, s);
}
