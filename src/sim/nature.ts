import {
  CROP_KINDS,
  CROP_GROW_CHANCE,
  CROP_GROW_EVERY,
  CROP_RIPE,
  FISH_MAX,
  FISH_RESTOCK,
  TREE_MATURE,
  type GatherDef,
  type PlantDef,
} from './config';
import type { GameMap } from './map';
import { findPath, staysConnected } from './pathfinding';
import { markWalkable } from './regions';
import { randInt } from './rng';
import { Terrain, type Building, type PlantKind, type PlayerId, type Point, type Resource, type Settler } from './types';
import type { World } from './world';

/** Map area the per-tick nature rates are tuned for; larger maps get proportionally more work. */
const REFERENCE_AREA = 64 * 64;

interface GatherRule {
  /** Whether the tile currently yields the resource. */
  isTarget(m: GameMap, i: number): boolean;
  /** Effect of taking one unit from the tile. */
  take(w: World, i: number): void;
}

const shore = (m: GameMap, i: number) => m.hasWalkableNeighbor(i % m.w, Math.floor(i / m.w));

/** Which map tiles yield a resource and what working them does to the tile. */
const GATHER_RULES: Partial<Record<Resource, GatherRule>> = {
  log: {
    isTarget: (m, i) => m.tree[i] === TREE_MATURE,
    take: (w, i) => {
      w.map.tree[i] = 0;
      w.map.touch(i);
      markWalkable(w.map, i % w.map.w, Math.floor(i / w.map.w));
    },
  },
  stone: {
    isTarget: (m, i) => m.stone[i] > 0,
    take: (w, i) => {
      w.map.stone[i]--;
      w.map.touch(i);
      markWalkable(w.map, i % w.map.w, Math.floor(i / w.map.w));
    },
  },
  water: {
    // Unlimited: any shore of open water.
    isTarget: (m, i) => m.terrain[i] === Terrain.Water && shore(m, i),
    take: () => {},
  },
  fish: {
    isTarget: (m, i) => m.fish[i] > 0 && shore(m, i),
    take: (w, i) => {
      w.map.fish[i]--;
    },
  },
  grain: {
    isTarget: (m, i) => m.crop[i] === CROP_RIPE && m.cropKind[i] === CROP_KINDS.indexOf('grain'),
    take: (w, i) => {
      w.map.crop[i] = 0;
      w.map.touch(i);
      w.fields.delete(i);
    },
  },
  grapes: {
    isTarget: (m, i) => m.crop[i] === CROP_RIPE && m.cropKind[i] === CROP_KINDS.indexOf('vine'),
    // Vines are perennial: after the harvest they grow fruit again instead of being replanted.
    take: (w, i) => {
      w.map.crop[i] = 2;
      w.map.touch(i);
    },
  },
};

function field(kind: PlantKind): PlantRule {
  const code = CROP_KINDS.indexOf(kind);
  return {
    // Fields stay walkable.
    isSafe: () => true,
    counts: (m, i) => m.crop[i] > 0 && m.cropKind[i] === code,
    plant: (w, i) => {
      w.map.crop[i] = 1;
      w.map.cropKind[i] = code;
      w.map.touch(i);
      w.fields.add(i);
    },
  };
}

interface PlantRule {
  /** Costlier checks, run only on the chosen candidate and again at planting time. */
  isSafe(w: World, x: number, y: number): boolean;
  /** Whether a tile counts towards `PlantDef.maxNearby`. */
  counts(m: GameMap, i: number): boolean;
  plant(w: World, i: number): void;
}

const PLANT_RULES: Record<PlantKind, PlantRule> = {
  tree: {
    // Saplings block movement, so they must not cut routes.
    isSafe: (w, x, y) => !settlerNear(w, x, y) && staysConnected(w.map, x, y),
    counts: (m, i) => m.tree[i] > 0,
    plant: (w, i) => {
      w.map.tree[i] = 1;
      w.map.touch(i);
      w.stats.treesPlanted++;
    },
  },
  grain: field('grain'),
  vine: field('vine'),
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export type Target = Point & { path: Point[] };

export function isGatherTarget(w: World, res: Resource, i: number, owner: PlayerId): boolean {
  const rule = GATHER_RULES[res];
  return !!rule && w.map.owner[i] === owner && rule.isTarget(w.map, i);
}

/** Takes one unit of `res` from the tile. */
export function harvest(w: World, res: Resource, i: number): void {
  GATHER_RULES[res]!.take(w, i);
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

/** Whether anything the gatherer could work exists within its radius (ignores reservations and routes). */
export function hasGatherTargetNear(w: World, home: Building, def: GatherDef): boolean {
  const m = w.map;
  for (let y = home.door.y - def.radius; y <= home.door.y + def.radius; y++) {
    for (let x = home.door.x - def.radius; x <= home.door.x + def.radius; x++) {
      if (!m.inBounds(x, y) || dist({ x, y }, home.door) > def.radius) continue;
      if (isGatherTarget(w, def.res, m.idx(x, y), home.owner)) return true;
    }
  }
  return false;
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

/** Own free grass, away from doors, not already promised to another planter. Cheap per tile. */
function plotLooksFree(w: World, x: number, y: number, owner: PlayerId, planting: boolean): boolean {
  const m = w.map;
  if (!m.inBounds(x, y) || m.owner[m.idx(x, y)] !== owner) return false;
  if (!m.isBuildable(x, y) || m.hasDoorNear(x, y)) return false;
  return planting || !w.reservedPlots.has(m.idx(x, y));
}

/** Full check, used when the planting actually happens. `planting` skips the planter's own reservation. */
export function canPlant(w: World, what: PlantKind, x: number, y: number, owner: PlayerId, planting = false): boolean {
  return plotLooksFree(w, x, y, owner, planting) && PLANT_RULES[what].isSafe(w, x, y);
}

export function plant(w: World, what: PlantKind, i: number): void {
  PLANT_RULES[what].plant(w, i);
}

/** How many plantings of the kind lie within the radius of the hut's door. */
function plantingsNear(w: World, home: Building, def: PlantDef): number {
  const m = w.map;
  const rule = PLANT_RULES[def.what];
  let n = 0;
  for (let y = home.door.y - def.radius; y <= home.door.y + def.radius; y++) {
    for (let x = home.door.x - def.radius; x <= home.door.x + def.radius; x++) {
      if (m.inBounds(x, y) && dist({ x, y }, home.door) <= def.radius && rule.counts(m, m.idx(x, y))) n++;
    }
  }
  return n;
}

/** A random reachable free plot around the hut, spreading plantings out; null when none or enough. */
export function findPlotFor(w: World, s: Settler, home: Building, def: PlantDef): Target | null {
  if (def.maxNearby !== undefined && plantingsNear(w, home, def) >= def.maxNearby) return null;
  const candidates: Point[] = [];
  const r = def.radius;
  for (let y = home.door.y - r; y <= home.door.y + r; y++) {
    for (let x = home.door.x - r; x <= home.door.x + r; x++) {
      const d = dist({ x, y }, home.door);
      if (d < 2 || d > r || !plotLooksFree(w, x, y, s.owner, false)) continue;
      if (def.what === 'tree' && treesAround(w.map, x, y) >= 4) continue;
      candidates.push({ x, y });
    }
  }
  for (let attempt = 0; attempt < 12 && candidates.length > 0; attempt++) {
    const [c] = candidates.splice(randInt(w.rng, candidates.length), 1);
    if (!PLANT_RULES[def.what].isSafe(w, c.x, c.y)) continue;
    const path = findPath(w.map, Math.round(s.x), Math.round(s.y), c.x, c.y, true);
    if (path) return { ...c, path };
  }
  return null;
}

/** Runs `attempt` on average `perReferenceArea` times per tick, scaled to the map's area. */
function scaled(w: World, perReferenceArea: number, attempt: () => void): void {
  let expected = (perReferenceArea * w.map.w * w.map.h) / REFERENCE_AREA;
  while (expected > 0) {
    if (expected >= 1 || w.rng() < expected) attempt();
    expected -= 1;
  }
}

/** Trees grow and seed, fields ripen, fish restock. */
export function updateNature(w: World): void {
  const m = w.map;
  const n = m.w * m.h;

  scaled(w, 20, () => {
    const i = randInt(w.rng, n);
    if (m.tree[i] > 0 && m.tree[i] < TREE_MATURE && w.rng() < 0.3) {
      m.tree[i]++;
      m.touch(i);
    }
  });

  scaled(w, 0.1, () => {
    const i = randInt(w.rng, n);
    if (m.tree[i] !== TREE_MATURE) return;
    const x = (i % m.w) + randInt(w.rng, 5) - 2;
    const y = Math.floor(i / m.w) + randInt(w.rng, 5) - 2;
    if (!m.isBuildable(x, y) || m.hasDoorNear(x, y) || settlerNear(w, x, y)) return;
    if (treesAround(m, x, y) >= 5 || !staysConnected(m, x, y)) return;
    m.tree[m.idx(x, y)] = 1;
    m.touch(m.idx(x, y));
  });

  scaled(w, FISH_RESTOCK, () => {
    const i = randInt(w.rng, n);
    if (m.terrain[i] === Terrain.Water && m.fish[i] < FISH_MAX && w.rng() < 0.5) m.fish[i]++;
  });

  if (w.tick % CROP_GROW_EVERY === 0 && w.fields.size > 0) {
    // Sorted so the RNG is consumed in the same order after a save/load.
    for (const i of [...w.fields].sort((a, b) => a - b)) {
      if (m.crop[i] < CROP_RIPE && w.rng() < CROP_GROW_CHANCE) {
        m.crop[i]++;
        m.touch(i);
      }
    }
  }
}
