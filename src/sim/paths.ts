import { PATHS } from './config';
import type { GameMap } from './map';
import { Terrain } from './types';
import type { World } from './world';

/**
 * Paths worn by walking, as in Settlers 4: `map.wear` grows with every step onto a tile and decays
 * slowly when the tile is not used; from `PATHS.levels` thresholds it shows as a dusty path, then a
 * road, where settlers walk faster. `World.worn` lists the tiles with any wear (derived, rebuilt on
 * load), so decay costs O(worn tiles), not O(map).
 */

const wearable = new Uint8Array(256);
for (const t of PATHS.terrains) wearable[t] = 1;

/** Path level of a wear value: 0 none, 1 dusty path, 2 road… */
export function pathLevel(wear: number): number {
  let k = 0;
  while (k < PATHS.levels.length && wear >= PATHS.levels[k].wear) k++;
  return k;
}

/** Walking speed factor on the tile (1 off paths). */
export function pathSpeed(map: GameMap, i: number): number {
  const wear = map.wear[i];
  if (wear < PATHS.levels[0].wear) return 1;
  const k = pathLevel(wear);
  return k === 0 ? 1 : PATHS.levels[k - 1].speed;
}

/** A settler stepped onto tile `i`. */
export function wearTile(w: World, i: number): void {
  const m = w.map;
  if (!wearable[m.terrain[i] as Terrain] || m.crop[i] > 0) return;
  const before = m.wear[i];
  if (before >= 255) return;
  const after = Math.min(255, before + PATHS.perStep);
  m.wear[i] = after;
  w.worn.add(i);
  if (pathLevel(after) !== pathLevel(before)) m.touch(i);
}

/** Unused paths fade: every `decayEvery` ticks each worn tile loses `decay`. */
export function updatePaths(w: World): void {
  if (w.tick % PATHS.decayEvery !== 0 || w.worn.size === 0) return;
  const m = w.map;
  for (const i of w.worn) {
    const before = m.wear[i];
    const after = Math.max(0, before - PATHS.decay);
    m.wear[i] = after;
    if (pathLevel(after) !== pathLevel(before)) m.touch(i);
    if (after === 0) w.worn.delete(i);
  }
}

export function rebuildWorn(w: World): void {
  w.worn.clear();
  const m = w.map;
  for (let i = 0; i < m.wear.length; i++) if (m.wear[i] > 0) w.worn.add(i);
}
