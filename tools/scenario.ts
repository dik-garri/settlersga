/** Shared helpers for headless tools (probe, bench). Not part of the game bundle. */
import type { Building, BuildingType, PlayerId } from '../src/sim/types';
import { LOCAL_PLAYER, type World } from '../src/sim/world';

/** Places a building as close as possible to (x, y), searching outward up to `radius` tiles. */
export function placeNear(
  world: World,
  type: BuildingType,
  x: number,
  y: number,
  radius = 12,
  player: PlayerId = LOCAL_PLAYER,
): Building | null {
  const spots: { x: number; y: number; d: number }[] = [];
  for (let ty = Math.round(y) - radius; ty <= Math.round(y) + radius; ty++) {
    for (let tx = Math.round(x) - radius; tx <= Math.round(x) + radius; tx++) {
      spots.push({ x: tx, y: ty, d: Math.hypot(tx - x, ty - y) });
    }
  }
  spots.sort((a, b) => a.d - b.d);
  for (const s of spots) {
    if (s.d > radius || !world.canPlace(type, s.x, s.y, player)) continue;
    const b = world.placeBuilding(type, s.x, s.y, player);
    if (b) return b;
  }
  return null;
}

export function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
