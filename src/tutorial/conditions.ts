import { available } from '../sim/buildings';
import { BUILDINGS, CARRIER_RESERVE, ORE_RESOURCES } from '../sim/config';
import { carrierReserve, economyOf, ENDLESS, transportOrder } from '../sim/economy';
import { isFighter } from '../sim/military';
import { RESOURCES, type Building, type PlayerId, type Settler } from '../sim/types';
import type { World } from '../sim/world';
import type { Condition, ConditionKind, Probe, SettingCheck, SettingKind, Snapshot, UiCheck, UiCheckKind } from './types';

/**
 * Step conditions as tables (docs/TUTORIAL.md §3.2): one predicate per kind, read-only queries of the
 * world through its public API and of the interface through `UiProbe`. The mapped types make the
 * compiler demand an entry for every kind, so a mission is data and a new kind is one entry here. A
 * check costs O(the player's buildings or settlers) or less; only `claimed` counts the map.
 */

type Table<U extends { [k in T]: string }, T extends string> = {
  [K in U[T]]: (c: Extract<U, Record<T, K>>, p: Probe) => boolean;
};

const own = (w: World, player: PlayerId): Building[] => [...w.buildings.values()].filter((b) => b.owner === player);

/** Tiles the player owns (a pass over the map: taken once at the start and by `claimed` checks). */
export function landOf(w: World, player: PlayerId): number {
  let n = 0;
  for (const o of w.map.owner) if (o === player) n++;
  return n;
}

/** The counts relative conditions compare with, taken now. */
export function snapshot(w: World, player: PlayerId, withLand = true): Snapshot {
  const stock: Snapshot['stock'] = {};
  const produced: Snapshot['produced'] = {};
  for (const r of RESOURCES) {
    stock[r] = available(w, player, r);
    produced[r] = w.stats.produced[r];
  }
  const fighters = w.settlers.filter((s) => s.owner === player && isFighter(s) && !w.dying.has(s.id)).length;
  return { tick: w.tick, stock, produced, fighters, land: withLand ? landOf(w, player) : 0 };
}

const UNIT_TEST: Record<'fighter' | 'striker', (s: Settler) => boolean> = {
  fighter: (s) => isFighter(s),
  striker: (s) => !!s.strike,
};

const near = (p: Probe, at: { x: number; y: number }, anchor: Parameters<Probe['anchor']>[0] | undefined, r: number | undefined): boolean => {
  if (!anchor) return true;
  const q = p.anchor(anchor);
  return !!q && Math.hypot(at.x - q.x, at.y - q.y) <= (r ?? 5);
};

export const SETTINGS: Table<SettingCheck, 's'> = {
  accepts: (c, { world, player }) =>
    own(world, player).some((b) => b.done && BUILDINGS[b.type].storage && c.res.every((r) => b.accept?.includes(r))),
  priority: (c, { world, player }) => own(world, player).some((b) => b.priority && (!c.site || !b.done)),
  stopped: (c, { world, player }) => {
    const of = own(world, player).filter((b) => b.type === c.type);
    return c.on ? of.some((b) => b.stopped) : of.length > 0 && of.every((b) => !b.stopped);
  },
  transportTop: (c, { world, player }) => transportOrder(world, player)[0] === c.res,
  reserve: (_c, { world, player }) => carrierReserve(world, player) !== CARRIER_RESERVE.default,
  workAt: (c, { world, player }) => own(world, player).some((b) => b.type === c.type && !!b.workAt),
  toolOrder: (c, { world, player }) => {
    const n = economyOf(world, player).toolOrders[c.res] ?? 0;
    return n === ENDLESS || n >= c.min;
  },
  distribution: (c, { world, player }) => Object.keys(economyOf(world, player).distribution[c.res] ?? {}).length > 0,
  tradeRoute: (c, { world, player }) =>
    own(world, player).some((b) => !!b.trade && b.trade.to !== null && (b.trade.orders[c.res] ?? 0) !== 0),
};

export const UI_CHECKS: Table<UiCheck, 'u'> = {
  cameraMoved: (c, { ui, stepUi }) => Math.hypot(ui.camera.x - stepUi.camera.x, ui.camera.y - stepUi.camera.y) >= c.tiles,
  zoomChanged: (_c, { ui, stepUi }) => Math.abs(ui.zoom - stepUi.zoom) >= 0.15,
  menuOpen: (c, { ui }) => ui.menu === c.menu,
  selected: (c, { ui, world }) => ui.selected !== null && world.buildings.get(ui.selected)?.type === c.type,
  placing: (c, { ui }) => ui.placing === c.what,
  selectedUnits: (c, { ui }) => ui.selectedUnits >= c.min,
  group: (c, { ui }) => (ui.groups[c.n] ?? 0) > 0,
  jumpedToMessage: (_c, { ui, stepUi }) => ui.jumps > stepUi.jumps,
  speed: (c, { ui }) => !ui.paused && ui.speed >= c.min,
};

export const CONDITIONS: Table<Condition, 'k'> = {
  ack: (_c, p) => p.acked,
  after: (c, p) => p.world.tick - p.step.tick >= c.s * 10,
  building: (c, p) => {
    const { world, player } = p;
    const state = c.state ?? 'done';
    let n = 0;
    for (const b of world.buildings.values()) {
      if (b.type !== c.type) continue;
      if ((c.owner ?? 'me') === 'me' ? b.owner !== player : world.allied(b.owner, player)) continue;
      if (state === 'done' ? !b.done : state === 'site' ? b.done : false) continue;
      if (!near(p, b.door, c.near, c.r)) continue;
      n++;
    }
    return n >= (c.min ?? 1);
  },
  stock: (c, p) => available(p.world, p.player, c.res) >= c.min + (c.relative ? (p.start.stock[c.res] ?? 0) : 0),
  stockAt: (c, { world, player }) => {
    let n = 0;
    for (const b of own(world, player)) if (b.type === c.type && b.done) n += b.output[c.res];
    return n >= c.min;
  },
  produced: (c, p) => p.world.stats.produced[c.res] - (p.start.produced[c.res] ?? 0) >= c.min,
  units: (c, p) => {
    const test = c.kind === 'fighter' || c.kind === 'striker' ? UNIT_TEST[c.kind] : (s: Settler) => s.kind === c.kind;
    let n = 0;
    for (const s of p.world.settlers) {
      if (s.owner !== p.player || p.world.dying.has(s.id) || !test(s) || !near(p, s, c.near, c.r)) continue;
      n++;
    }
    if (c.relative && c.kind === 'fighter') n -= p.start.fighters;
    return n >= (c.min ?? 0) && (c.max === undefined || n <= c.max);
  },
  garrison: (c, { world, player }) => own(world, player).some((b) => b.type === c.type && b.done && b.garrison.length >= c.min),
  attempts: (c, { world, player }) => own(world, player).some((b) => b.type === c.type && b.done && (b.attempts ?? 0) >= c.min),
  setting: (c, p) => (SETTINGS[c.is.s] as (s: SettingCheck, p: Probe) => boolean)(c.is, p),
  ui: (c, p) => (UI_CHECKS[c.is.u] as (u: UiCheck, p: Probe) => boolean)(c.is, p),
  explored: (c, p) => {
    const q = p.anchor(c.at);
    return !!q && p.world.isExplored(Math.round(q.x), Math.round(q.y), p.player);
  },
  prospected: (c, p) => {
    const q = p.anchor(c.at);
    if (!q) return false;
    const m = p.world.map;
    const code = c.ore ? ORE_RESOURCES.indexOf(c.ore) + 1 : 0;
    let n = 0;
    for (let y = Math.floor(q.y - c.r); y <= q.y + c.r; y++) {
      for (let x = Math.floor(q.x - c.r); x <= q.x + c.r; x++) {
        if (Math.hypot(x - q.x, y - q.y) > c.r || !p.world.isProspected(x, y, p.player)) continue;
        if (code && (m.ore[m.idx(x, y)] !== code || m.oreAmount[m.idx(x, y)] <= 0)) continue;
        n++;
      }
    }
    return n >= c.min;
  },
  claimed: (c, p) => landOf(p.world, p.player) - p.start.land >= c.min,
  captured: (c, p) => (p.world.stats.war[p.player]?.captured ?? 0) >= c.min,
  outcome: (c, p) => p.world.outcome(p.player) === c.is,
  all: (c, p) => c.of.every((x) => check(x, p)),
  any: (c, p) => c.of.some((x) => check(x, p)),
};

/** Whether the condition holds now. */
export function check(c: Condition, p: Probe): boolean {
  return (CONDITIONS[c.k] as (c: Condition, p: Probe) => boolean)(c, p);
}

/** Every kind has an entry (for the tests: the tables are complete at run time too). */
export const CONDITION_KINDS = Object.keys(CONDITIONS) as ConditionKind[];
export const SETTING_KINDS = Object.keys(SETTINGS) as SettingKind[];
export const UI_CHECK_KINDS = Object.keys(UI_CHECKS) as UiCheckKind[];
