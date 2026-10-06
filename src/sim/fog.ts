import { centerOf } from './buildings';
import { BUILDINGS, FOG } from './config';
import type { PlayerId } from './types';
import type { World } from './world';

/**
 * Fog of war, per player. `map.explored` (saved) remembers what a player has ever seen. What they
 * see right now is derived, never saved:
 * - `vision`: tiles within sight of the player's buildings (bit player − 1), rebuilt only when
 *   buildings or territory change;
 * - `seenUntil`: per player, the tick until which a tile stays in sight after a settler passed by;
 *   settlers stamp their surroundings every `FOG.settlerEvery` ticks.
 * Cost: O(settlers × disc) every few ticks plus O(map + buildings × disc) per building change.
 * The AI reads only `explored` and building sight (`inBuildingSight`), both reproducible after a load.
 */
export interface FogState {
  vision: Uint8Array;
  seenUntil: Uint32Array[];
  /** `buildingsVersion` / `territoryVersion` the vision was built for. */
  builtFor: [number, number];
}

export function createFog(): FogState {
  return { vision: new Uint8Array(0), seenUntil: [], builtFor: [-1, -1] };
}

/** Tile offsets within a radius, cached per radius. */
const discs = new Map<number, Int16Array>();
function disc(r: number): Int16Array {
  let d = discs.get(r);
  if (!d) {
    const pts: number[] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) pts.push(dx, dy);
    }
    d = Int16Array.from(pts);
    discs.set(r, d);
  }
  return d;
}

function stamp(w: World, cx: number, cy: number, r: number, visit: (i: number) => void): void {
  const m = w.map;
  const d = disc(r);
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let k = 0; k < d.length; k += 2) {
    const x = x0 + d[k];
    const y = y0 + d[k + 1];
    if (x >= 0 && y >= 0 && x < m.w && y < m.h) visit(y * m.w + x);
  }
}

/** How far a building sees: its territory radius plus a margin, or a small default. */
export function visionRadius(type: keyof typeof BUILDINGS): number {
  const t = BUILDINGS[type].territory;
  return t ? t + FOG.territoryMargin : FOG.buildingRadius;
}

function rebuildVision(w: World): void {
  const f = w.fog;
  const m = w.map;
  if (f.vision.length !== m.w * m.h) f.vision = new Uint8Array(m.w * m.h);
  else f.vision.fill(0);
  for (const b of w.buildings.values()) {
    const bit = 1 << (b.owner - 1);
    const c = centerOf(b);
    // Sites see only a little; a finished building its full range (territory changes trigger a rebuild).
    stamp(w, c.x, c.y, b.done ? visionRadius(b.type) : FOG.buildingRadius, (i) => {
      f.vision[i] |= bit;
      m.explored[i] |= bit;
    });
  }
  f.builtFor = [w.buildingsVersion, w.territoryVersion];
}

/** Rebuilds the building vision if it is stale (e.g. right after a load); cheap otherwise. */
export function ensureVision(w: World): void {
  if (w.fog.vision.length !== w.map.w * w.map.h || w.fog.builtFor[0] !== w.buildingsVersion || w.fog.builtFor[1] !== w.territoryVersion) {
    rebuildVision(w);
  }
}

/** Whether a tile is within sight of the player's buildings — derived from saved state only, so
 * deterministic across save/load (unlike settlers' passing sight). The AI uses this. */
export function inBuildingSight(w: World, i: number, player: PlayerId): boolean {
  return ((w.fog.vision[i] ?? 0) & (1 << (player - 1))) !== 0;
}

/** Called once per tick at the end of `World.step`. */
export function updateFog(w: World): void {
  const f = w.fog;
  const m = w.map;
  while (f.seenUntil.length < w.players.length) f.seenUntil.push(new Uint32Array(m.w * m.h));
  if (f.builtFor[0] !== w.buildingsVersion || f.builtFor[1] !== w.territoryVersion) rebuildVision(w);
  if (w.tick % FOG.settlerEvery !== 0) return;
  const until = w.tick + FOG.settlerEvery;
  for (const s of w.settlers) {
    if (s.inside !== null || w.dying.has(s.id)) continue; // inside: the building's vision covers it
    const bit = 1 << (s.owner - 1);
    const seen = f.seenUntil[s.owner - 1];
    stamp(w, s.x, s.y, FOG.settlerRadius, (i) => {
      seen[i] = until;
      m.explored[i] |= bit;
    });
  }
}

export function isExplored(w: World, i: number, player: PlayerId): boolean {
  return (w.map.explored[i] & (1 << (player - 1))) !== 0;
}

export function isVisible(w: World, i: number, player: PlayerId): boolean {
  if ((w.fog.vision[i] ?? 0) & (1 << (player - 1))) return true;
  const seen = w.fog.seenUntil[player - 1];
  return !!seen && seen[i] >= w.tick;
}
