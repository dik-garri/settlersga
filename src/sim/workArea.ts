import { BUILDINGS, PROFESSIONS, WORK_AREA } from './config';
import { centerOf } from './buildings';
import type { Building, BuildingType, PlayerId, Point } from './types';
import type { World } from './world';

/**
 * Work areas, as in Settlers 4: a gatherer, planter or hunter works within a radius of its hut's
 * door — or of a centre the player moved it to (`Building.workAt`, saved); a mine digs within a
 * radius of its centre (fixed: the ore lies under the mountain). The radius comes from the data
 * (`PROFESSIONS[worker].gather/plant/hunt.radius`, `BUILDINGS[type].mine.radius`).
 */

/** The work radius of a building type, or null if its worker does not work an area. */
export function workRadius(type: BuildingType): number | null {
  const def = BUILDINGS[type];
  if (def.mine) return def.mine.radius;
  const prof = def.worker ? PROFESSIONS[def.worker] : undefined;
  if (!prof) return null;
  const r = Math.max(prof.gather?.radius ?? 0, prof.plant?.radius ?? 0, prof.hunt?.radius ?? 0);
  return r > 0 ? r : null;
}

/** Whether the player may move the building's work area (gatherers, planters, hunters — not mines). */
export function movableWorkArea(type: BuildingType): boolean {
  return !BUILDINGS[type].mine && workRadius(type) !== null;
}

/** The default centre of a work area: the door of a hut, the centre of a mine (for a planned building too). */
export function defaultWorkCentre(type: BuildingType, door: Point, center: Point): Point {
  return BUILDINGS[type].mine ? center : door;
}

/** Where the building's work area is centred now. */
export function workCentre(b: Building): Point {
  return b.workAt ?? defaultWorkCentre(b.type, b.door, centerOf(b));
}

/**
 * Player command: centre the building's work area on (x, y), at most `WORK_AREA.maxShift` × its
 * radius from the door; null puts it back at the door. Returns false if not allowed.
 */
export function setWorkArea(w: World, id: number, at: Point | null, player: PlayerId): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !movableWorkArea(b.type)) return false;
  if (at === null) {
    b.workAt = null;
    return true;
  }
  const r = workRadius(b.type)!;
  const x = Math.round(at.x);
  const y = Math.round(at.y);
  if (!w.map.inBounds(x, y) || Math.hypot(x - b.door.x, y - b.door.y) > r * WORK_AREA.maxShift) return false;
  b.workAt = { x, y };
  return true;
}
