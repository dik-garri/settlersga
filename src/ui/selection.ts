/**
 * Selecting units by type, as Settlers 4's input processor does (`CInputProcessor`, manual §5.2.4 and
 * the keyboard table). Pure functions over the world, so they are tested headless.
 *
 * - **Selection type** (`GetEntitySelectionType`): fighters by kind — every level of the kind together
 *   (S4's warrior type) —, specialists by kind.
 * - **Shift + click** on an own unit (`SelectTypeInSurrounding` → `SelectAllInSurrounding`): the units
 *   of its type «in the vicinity» — S4 walks 3000 positions of its spiral round the click (a disc of
 *   ≈ 29 of its tiles) —, **Alt + click** the same «in the sector» over 19823 positions (≈ 74 of its
 *   tiles); both only in the clicked unit's sector (`CWorldManager::SectorId`: the connected walkable
 *   area, our `regions.ts`), at most `SELECTION_MAX`.
 * - **Ctrl + click** (`DotSelection` with the append flag) adds a unit of the selection's type or takes
 *   it out again; a unit of another type starts a new selection.
 * - **Backspace** (`InjuredOut` with 0): takes the healthy units out of the selection — those not
 *   below half their hit points (`WOUNDED_AT`) —, so the wounded can be sent to the healer.
 */
import { S4_TILES_PER_TILE, WOUNDED_AT } from '../sim/config';
import { maxHp } from '../sim/combat';
import { isFighter } from '../sim/military';
import { sameRegion } from '../sim/regions';
import { isSpecialist } from '../sim/specialists';
import type { PlayerId, Settler } from '../sim/types';
import type { World } from '../sim/world';

/** Settlers 4 never selects more than 100 units at once (`m_vSelection.size() >= 0x64`). */
export const SELECTION_MAX = 100;

/**
 * Radius of the disc S4's distance-sorted spiral covers with `positions` positions, in our tiles: a
 * position of its hexagonal grid takes ≈ 0.866 of a tile width squared (rows 0.866 apart), so
 * r = √(positions · 0.866 / π) of its tiles (3500 → 31.1, as docs/PROPORTIONS.md measured), ÷
 * `S4_TILES_PER_TILE`.
 */
const spiralRadius = (positions: number) => Math.round(Math.sqrt((positions * 0.866) / Math.PI) / S4_TILES_PER_TILE);

/** Radii of the type selections, in our tiles (S4: spirals of 3000 and 19823 positions ≈ 29 and 74 of its tiles). */
export const SELECT_RADIUS = {
  /** Shift + click: «select units of the same type in the vicinity» (10). */
  vicinity: spiralRadius(3000),
  /** Alt + click: «select units of the same type in the sector» (25). */
  sector: spiralRadius(19823),
};

/** Whether the unit can be selected for orders: an own fighter or specialist, alive and outdoors. */
export function selectable(w: World, s: Settler | undefined, player: PlayerId): s is Settler {
  return !!s && s.owner === player && !w.dying.has(s.id) && s.inside === null && (isFighter(s) || isSpecialist(s));
}

/** Settlers 4's selection type: the profession (a fighter's level does not split it). */
export function selectionType(s: Settler): string {
  return s.kind;
}

/**
 * Shift/Alt + click on `unit`: it and the player's selectable units of its type within `radius` tiles
 * in its sector, nearest first, at most `SELECTION_MAX`.
 */
export function sameTypeAround(w: World, unit: Settler, radius: number, player: PlayerId): number[] {
  if (!selectable(w, unit, player)) return [];
  const m = w.map;
  const tile = (s: Settler) => m.idx(Math.round(s.x), Math.round(s.y));
  const at = tile(unit);
  const type = selectionType(unit);
  const found: { id: number; d: number }[] = [];
  for (const s of w.settlers) {
    if (!selectable(w, s, player) || selectionType(s) !== type) continue;
    const d = Math.hypot(s.x - unit.x, s.y - unit.y);
    if (d > radius) continue;
    if (s !== unit && !sameRegion(m, at, tile(s))) continue;
    found.push({ id: s.id, d: s === unit ? -1 : d });
  }
  found.sort((a, b) => a.d - b.d || a.id - b.id);
  return found.slice(0, SELECTION_MAX).map((f) => f.id);
}

/**
 * Ctrl + click on `unit` with `selection` (S4's `DotSelection`, append): a unit of the selection's type
 * (that of its first unit) is added, or taken out if it is in already; any other starts a new one.
 */
export function toggleInSelection(w: World, selection: readonly number[], unit: Settler): number[] {
  const first = selection.map((id) => w.getSettler(id)).find((s) => !!s && !w.dying.has(s.id));
  if (!first || selectionType(first) !== selectionType(unit)) return [unit.id];
  if (selection.includes(unit.id)) return selection.filter((id) => id !== unit.id);
  return selection.length >= SELECTION_MAX ? [...selection] : [...selection, unit.id];
}

/** Whether a unit counts as wounded: below `WOUNDED_AT` of its hit points (S4: hp < max / 2). */
export function wounded(s: Settler): boolean {
  return s.hp < maxHp(s) * WOUNDED_AT;
}

/** Backspace: the selection without its healthy units (S4's «exclude healthy soldiers»). */
export function withoutHealthy(w: World, selection: readonly number[]): number[] {
  return selection.filter((id) => {
    const s = w.getSettler(id);
    return !!s && !w.dying.has(id) && wounded(s);
  });
}
