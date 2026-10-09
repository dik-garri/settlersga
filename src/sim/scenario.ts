import { addBuilding, centerOf, spawnSettler } from './buildings';
import { BUILDINGS, ORDERABLE } from './config';
import { orderWorkers, setAccepts, workerOrder } from './economy';
import { dropGoods } from './ground';
import { enterGarrison } from './military';
import { claimChanged } from './territory';
import { RESOURCES, type Building, type BuildingType, type PlayerId, type Resource, type SettlerKind } from './types';
import type { World } from './world';

/**
 * A scenario's start, as a Settlers 4 mission map gives it (the second tutorial starts with a
 * woodcutter, a sawmill and a stonecutter already standing): finished buildings, goods on the ground
 * and people for a player, applied once when the world is made (`WorldOptions.scenario`, after the
 * players' own starts, as the computer players' start help). What it makes is ordinary world state
 * and is saved as such; the simulation keeps no trace of a scenario. Plain data.
 */
export interface ScenarioBuilding {
  type: BuildingType;
  /** Where to look for room: an offset from the player's start position; the nearest fitting spot wins. */
  near: { dx: number; dy: number };
  /** A name the scenario's author gives the building (`World.tags`), for whoever started the scenario. */
  tag?: string;
  /** A ready-made worker of its profession comes with it (and takes it up at once, `isReadyWorker`). */
  worker?: boolean;
  /** A military building's swordsmen, inside from the start (it holds its land at once). */
  garrison?: number;
  /** A warehouse's accepted goods (`setAccepts`; a new one takes nothing): a list, or every good. */
  accepts?: Resource[] | 'all';
}

export interface ScenarioPlayer {
  player: PlayerId;
  buildings?: ScenarioBuilding[];
  /** Goods laid on the ground by the start tower, pile by pile, as the start's own. */
  piles?: [Resource, number][];
  /** Extra people at the start tower (orderable ones raise the player's orders with them). */
  people?: Partial<Record<SettlerKind, number>>;
  /** Beds the player starts with instead of `startBeds` (e.g. fewer, so carriers strike). */
  beds?: number;
}

export type ScenarioDef = ScenarioPlayer[];

/** How far from the wanted spot a scenario building may land. */
const PLACE_RADIUS = 10;

/**
 * A finished building of `owner`'s on the free spot nearest (x, y) — within `radius`, ring after ring —
 * placed directly (scenarios and the dev showcase); null if none fits.
 */
export function placeFinished(w: World, type: BuildingType, owner: PlayerId, x: number, y: number, radius = PLACE_RADIUS): Building | null {
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !w.canPlace(type, x + dx, y + dy, owner)) continue;
        const b = addBuilding(w, type, x + dx, y + dy, owner, true);
        claimChanged(w, b);
        return b;
      }
    }
  }
  return null;
}

/**
 * Applies a scenario to a freshly made world. Deterministic (no RNG); throws if a building finds no
 * room, so a scenario that no longer fits its map fails loudly in the tests.
 */
export function applyScenario(w: World, def: ScenarioDef): void {
  for (const sp of def) {
    const p = w.players[sp.player - 1];
    if (!p) continue;
    const tower = w.buildingAt(p.home.x, p.home.y);
    if (!tower) continue;
    const c = centerOf(tower);
    const cx = Math.round(c.x);
    const cy = Math.round(c.y);
    for (const sb of sp.buildings ?? []) {
      const b = placeFinished(w, sb.type, sp.player, cx + sb.near.dx, cy + sb.near.dy);
      if (!b) throw new Error(`scenario: no room for ${sb.type}`);
      if (sb.tag) w.tags.set(sb.tag, b.id);
      for (let k = 0; k < (sb.garrison ?? 0); k++) enterGarrison(w, b, spawnSettler(w, 'soldier', b));
      for (const res of sb.accepts === 'all' ? RESOURCES : (sb.accepts ?? [])) setAccepts(w, sp.player, b.id, res, true);
      const job = BUILDINGS[sb.type].worker;
      if (sb.worker && job) spawnSettler(w, job, tower);
    }
    for (const [res, n] of sp.piles ?? []) dropGoods(w, { x: cx, y: cy }, res, n);
    for (const [kind, n] of Object.entries(sp.people ?? {}) as [SettlerKind, number][]) {
      for (let i = 0; i < n; i++) spawnSettler(w, kind, tower);
      if (ORDERABLE.includes(kind)) orderWorkers(w, sp.player, kind, workerOrder(w, sp.player, kind) + n);
    }
    if (sp.beds !== undefined) p.startBeds = sp.beds;
  }
}
