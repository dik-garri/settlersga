import type { Building, BuildingType, Settler, SettlerKind } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';

/**
 * Settlers 4's «find» buttons: the next own building (or site) of a type after `after` (by id, round
 * the list), or the next own settler of a profession — for the building window, the build menu's
 * right click and the settlers menu.
 */
export function nextBuildingOfType(w: World, type: BuildingType, after: number | null): Building | undefined {
  let first: Building | undefined;
  let next: Building | undefined;
  for (const b of w.buildings.values()) {
    if (b.owner !== LOCAL_PLAYER || b.type !== type) continue;
    if (!first || b.id < first.id) first = b;
    if (after !== null && b.id > after && (!next || b.id < next.id)) next = b;
  }
  return next ?? first;
}

export function nextSettlerOfKind(w: World, kind: SettlerKind, after: number | null): Settler | undefined {
  let first: Settler | undefined;
  let next: Settler | undefined;
  for (const s of w.settlers) {
    if (s.owner !== LOCAL_PLAYER || s.kind !== kind || w.dying.has(s.id)) continue;
    if (!first || s.id < first.id) first = s;
    if (after !== null && s.id > after && (!next || s.id < next.id)) next = s;
  }
  return next ?? first;
}
