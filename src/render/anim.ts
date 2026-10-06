/**
 * Pure animation helpers shared by the renderer and the sound director (no Pixi, no DOM), so they
 * can be unit-tested and so sounds stay in sync with the frames on screen.
 */

/**
 * Screen directions, clockwise from east (screen y points down). Five are painted; the three
 * westward ones are their eastward mirrors (`PAINTED_DIR`, `MIRRORED`).
 */
export const DIRS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE'] as const;
export type Dir = (typeof DIRS)[number];

/** Painted direction index (0 E, 1 SE, 2 S, 3 NE, 4 N) for each of the 8 directions. */
export const PAINTED_DIR: readonly number[] = [0, 1, 2, 1, 0, 3, 4, 3];
/** Whether a direction is drawn as the horizontal mirror of its painted counterpart. */
export const MIRRORED: readonly boolean[] = [false, false, false, true, true, true, false, false];
/** Screen angle (radians, y down) each painted direction is drawn at. */
export const PAINTED_ANGLE: readonly number[] = [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4, -Math.PI / 2];
/** Painted directions in which the figure faces away from the camera (tool arm behind the body). */
export const FACES_AWAY: readonly boolean[] = [false, false, false, true, true];

/** Tile-space velocity → screen-space vector of the isometric projection (unit tiles). */
export function screenDelta(dx: number, dy: number): [number, number] {
  return [dx - dy, (dx + dy) / 2];
}

/**
 * Index into `DIRS` for a movement in tile space; `fallback` when not moving.
 * Sectors are 45° wide around each screen direction.
 */
export function dirFromTileVelocity(dx: number, dy: number, fallback: number): number {
  const [sx, sy] = screenDelta(dx, dy);
  if (sx * sx + sy * sy < 1e-8) return fallback;
  const a = Math.atan2(sy, sx); // −π..π, 0 = east, π/2 = south
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}

/** Index into `DIRS` facing from one tile point towards another. */
export function dirTowards(fromX: number, fromY: number, toX: number, toY: number, fallback: number): number {
  return dirFromTileVelocity(toX - fromX, toY - fromY, fallback);
}

/** Frames in a walk cycle and tiles walked per full cycle (so feet do not slide). */
export const WALK_FRAMES = 4;
export const STRIDE_TILES = 0.9;

/** Walk frame from the distance a settler has walked (tile units). */
export function walkFrame(distance: number): number {
  const f = Math.floor((distance / STRIDE_TILES) * WALK_FRAMES);
  return ((f % WALK_FRAMES) + WALK_FRAMES) % WALK_FRAMES;
}

/** Frames in a work loop. */
export const WORK_FRAMES = 4;

/** Work frame at `timeMs` for an action looping every `loopMs`; settlers are desynchronised by id. */
export function workFrame(timeMs: number, id: number, loopMs: number): number {
  const t = timeMs + ((id * 2654435761) >>> 0) % loopMs;
  return Math.floor((t / loopMs) * WORK_FRAMES) % WORK_FRAMES;
}

/** Fractional loop position (0..1) of the same clock, for effects that interpolate between frames. */
export function workPhase(timeMs: number, id: number, loopMs: number): number {
  const t = timeMs + ((id * 2654435761) >>> 0) % loopMs;
  return (t % loopMs) / loopMs;
}

/**
 * Idle settlers glance around now and then: the direction they look at, given the direction they
 * were facing. Deterministic in time and id, changes every few seconds.
 */
export function idleDir(timeMs: number, id: number, facing: number): number {
  const slot = Math.floor((timeMs + id * 977) / 3200);
  const h = (Math.imul(slot ^ (id * 0x45d9f3b), 0x27d4eb2d) >>> 0) % 7;
  // Mostly keep facing; sometimes look a quarter to the side.
  if (h < 4) return facing;
  return (facing + (h < 6 ? 1 : 7)) % 8;
}

/** Vertical bob (pixels) of the body over a walk cycle. */
export function walkBob(frame: number): number {
  return frame % 2 === 1 ? -1 : 0;
}
