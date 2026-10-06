import { TREE_MATURE, type GatherDef, type PlantDef } from './config';
import type { GameMap } from './map';
import { findPath, staysConnected } from './pathfinding';
import { markWalkable } from './regions';
import { randInt } from './rng';
import type { Building, PlayerId, Point, Resource, Settler } from './types';
import type { World } from './world';

/** Which map tiles yield a resource and what working them does to the tile. */
const GATHER_RULES: Partial<Record<Resource, { isTarget(m: GameMap, i: number): boolean; take(m: GameMap, i: number): void }>> = {
  log: {
    isTarget: (m, i) => m.tree[i] === TREE_MATURE,
    take: (m, i) => {
      m.tree[i] = 0;
      m.touch(i);
    },
  },
  stone: {
    isTarget: (m, i) => m.stone[i] > 0,
    take: (m, i) => {
      m.stone[i]--;
      m.touch(i);
    },
  },
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export type Target = Point & { path: Point[] };

export function isGatherTarget(w: World, res: Resource, i: number, owner: PlayerId): boolean {
  const rule = GATHER_RULES[res];
  return !!rule && w.map.owner[i] === owner && rule.isTarget(w.map, i);
}

/** Removes one unit of `res` from the tile. */
export function harvest(w: World, res: Resource, i: number): void {
  GATHER_RULES[res]!.take(w.map, i);
  markWalkable(w.map, i % w.map.w, Math.floor(i / w.map.w));
}

/** Nearest reachable, unreserved target within the gatherer's radius of its hut. */
export function findGatherTarget(w: World, s: Settler, home: Building, def: GatherDef): Target | null {
  const m = w.map;
  const candidates: Point[] = [];
  const r = def.radius;
  for (let y = home.door.y - r; y <= home.door.y + r; y++) {
    for (let x = home.door.x - r; x <= home.door.x + r; x++) {
      if (!m.inBounds(x, y)) continue;
      const i = m.idx(x, y);
      if (!isGatherTarget(w, def.res, i, s.owner) || w.reservedTargets.has(i)) continue;
      if (dist({ x, y }, home.door) > r) continue;
      candidates.push({ x, y });
    }
  }
  candidates.sort((a, b) => dist(a, home.door) - dist(b, home.door));
  for (const c of candidates.slice(0, 6)) {
    const path = findPath(m, Math.round(s.x), Math.round(s.y), c.x, c.y, true);
    if (path) return { ...c, path };
  }
  return null;
}

export function treesAround(m: GameMap, x: number, y: number): number {
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (m.inBounds(x + dx, y + dy) && m.tree[m.idx(x + dx, y + dy)]) count++;
    }
  }
  return count;
}

export function settlerNear(w: World, x: number, y: number): boolean {
  return w.settlers.some(
    (s) =>
      (Math.round(s.x) === x && Math.round(s.y) === y) ||
      (s.path.length > 0 && s.path[0].x === x && s.path[0].y === y),
  );
}

/**
 * Whether a sapling may go on this tile: own free grass, not next to a door, nobody standing there,
 * and blocking it does not cut any walking route.
 * `planting` skips the reservation check for the forester who holds it.
 */
export function canPlant(w: World, x: number, y: number, owner: PlayerId, planting = false): boolean {
  return plotLooksFree(w, x, y, owner, planting) && plotIsSafe(w, x, y);
}

/** Cheap per-tile checks, fine to run over a whole search radius. */
function plotLooksFree(w: World, x: number, y: number, owner: PlayerId, planting = false): boolean {
  const m = w.map;
  if (!m.inBounds(x, y) || m.owner[m.idx(x, y)] !== owner) return false;
  if (!m.isBuildable(x, y) || m.hasDoorNear(x, y)) return false;
  return planting || !w.reservedPlots.has(m.idx(x, y));
}

/** Costlier checks (other settlers, route connectivity), run only on the chosen candidate. */
function plotIsSafe(w: World, x: number, y: number): boolean {
  return !settlerNear(w, x, y) && staysConnected(w.map, x, y);
}

/** A random reachable free plot around the forester's hut, spreading the new forest out. */
export function findPlotFor(w: World, s: Settler, home: Building, def: PlantDef): Target | null {
  const candidates: Point[] = [];
  const r = def.radius;
  for (let y = home.door.y - r; y <= home.door.y + r; y++) {
    for (let x = home.door.x - r; x <= home.door.x + r; x++) {
      const d = dist({ x, y }, home.door);
      if (d < 2 || d > r || !plotLooksFree(w, x, y, s.owner)) continue;
      if (treesAround(w.map, x, y) >= 4) continue;
      candidates.push({ x, y });
    }
  }
  for (let attempt = 0; attempt < 12 && candidates.length > 0; attempt++) {
    const [c] = candidates.splice(randInt(w.rng, candidates.length), 1);
    if (!plotIsSafe(w, c.x, c.y)) continue;
    const path = findPath(w.map, Math.round(s.x), Math.round(s.y), c.x, c.y, true);
    if (path) return { ...c, path };
  }
  return null;
}

/** Saplings grow, mature trees occasionally seed a neighbouring tile. */
export function updateTrees(w: World): void {
  const m = w.map;
  const n = m.w * m.h;
  for (let k = 0; k < 20; k++) {
    const i = randInt(w.rng, n);
    if (m.tree[i] > 0 && m.tree[i] < TREE_MATURE && w.rng() < 0.3) {
      m.tree[i]++;
      m.touch(i);
    }
  }
  if (w.rng() < 0.1) {
    const i = randInt(w.rng, n);
    if (m.tree[i] !== TREE_MATURE) return;
    const x = (i % m.w) + randInt(w.rng, 5) - 2;
    const y = Math.floor(i / m.w) + randInt(w.rng, 5) - 2;
    if (!m.isBuildable(x, y) || m.hasDoorNear(x, y) || settlerNear(w, x, y)) return;
    if (treesAround(m, x, y) >= 5 || !staysConnected(m, x, y)) return;
    m.tree[m.idx(x, y)] = 1;
    m.touch(m.idx(x, y));
  }
}
