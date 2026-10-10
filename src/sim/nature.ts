import {
  CROP_KINDS,
  CROP_RIPE,
  CROP_STUBBLE,
  FISH_MAX,
  GROW_EVERY,
  GROWTH,
  FISH_RESTOCK,
  S4_HEIGHT_PX,
  S4_TILES_PER_TILE,
  TERRAIN,
  TREE_MATURE,
  TREE_SPREAD,
  type GatherDef,
  type PlantDef,
} from './config';
import type { GameMap } from './map';
import { staysConnected } from './pathfinding';
import { route } from './walk';
import { markWalkable } from './regions';
import { workCentre } from './workArea';
import { randInt } from './rng';
import { Terrain, type Building, type PlantKind, type PlayerId, type Point, type Resource, type Settler } from './types';
import type { World } from './world';
import { hypot } from './fmath';

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
      w.map.growth[i] = 0;
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
    isTarget: (m, i) => TERRAIN[m.terrain[i] as Terrain].water && shore(m, i),
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
    take: (w, i) => reap(w, i),
  },
};

/** A ripe field is reaped: stubble while its kind has some (`GrowthDef.stubbleTicks`), else bare at once. */
function reap(w: World, i: number): void {
  const m = w.map;
  const def = GROWTH[CROP_KINDS[m.cropKind[i]]];
  m.growth[i] = 0;
  if (def.stubbleTicks) {
    m.crop[i] = CROP_STUBBLE;
    w.growing.add(i);
  } else {
    m.crop[i] = 0;
    m.cropKind[i] = 0;
  }
  m.touch(i);
}

/**
 * Settlers 4's `CSearchRoutines::CalcRawness` on one of our tiles: the steepest height difference
 * across it, in S4 height units (`S4_HEIGHT_PX`) over two S4 tiles — S4 compares the two neighbours
 * either side of a vertex along each of its three axes; our tile edge is `S4_TILES_PER_TILE` S4 tiles
 * long, its diagonal √2 times that.
 */
export function rawness(m: GameMap, x: number, y: number): number {
  const a = m.vertexHeight(x, y);
  const b = m.vertexHeight(x + 1, y);
  const c = m.vertexHeight(x, y + 1);
  const d = m.vertexHeight(x + 1, y + 1);
  const edge = Math.max(Math.abs(a - b), Math.abs(c - d), Math.abs(a - c), Math.abs(b - d));
  const diagonal = Math.max(Math.abs(a - d), Math.abs(b - c)) / Math.SQRT2;
  return (Math.max(edge, diagonal) * 2) / S4_TILES_PER_TILE / S4_HEIGHT_PX;
}

function field(kind: PlantKind): PlantRule {
  const code = CROP_KINDS.indexOf(kind);
  const maxSlope = GROWTH[kind].maxSlope;
  return {
    // Settlers 4 sows only on ground no steeper than `GrowthDef.maxSlope` (`SearchGrainSeedPos`).
    fits: (m, x, y) => maxSlope === undefined || rawness(m, x, y) <= maxSlope,
    // Fields stay walkable.
    isSafe: () => true,
    counts: (m, i) => m.crop[i] > 0 && m.crop[i] <= CROP_RIPE && m.cropKind[i] === code,
    plant: (w, i) => {
      w.map.crop[i] = 1;
      w.map.cropKind[i] = code;
      w.map.growth[i] = 0;
      w.map.touch(i);
      w.growing.add(i);
    },
  };
}

interface PlantRule {
  /** Cheap per-tile check of the ground (slope), run on every candidate; absent: any ground. */
  fits?(m: GameMap, x: number, y: number): boolean;
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
      w.map.growth[i] = 0;
      w.map.touch(i);
      w.growing.add(i);
      w.stats.treesPlanted++;
    },
  },
  grain: field('grain'),
};

const dist = (a: Point, b: Point) => hypot(a.x - b.x, a.y - b.y);

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
  const c = workCentre(home);
  for (let y = c.y - r; y <= c.y + r; y++) {
    for (let x = c.x - r; x <= c.x + r; x++) {
      if (!m.inBounds(x, y)) continue;
      const i = m.idx(x, y);
      if (!isGatherTarget(w, def.res, i, s.owner) || w.reservedTargets.has(i)) continue;
      if (dist({ x, y }, c) > r) continue;
      candidates.push({ x, y });
    }
  }
  candidates.sort((a, b) => dist(a, c) - dist(b, c));
  for (const c of candidates.slice(0, 6)) {
    const path = route(w, s, Math.round(s.x), Math.round(s.y), c.x, c.y, true);
    if (path) return { ...c, path };
  }
  return null;
}

/** Whether anything the gatherer could work exists within its radius (ignores reservations and routes). */
export function hasGatherTargetNear(w: World, home: Building, def: GatherDef): boolean {
  const m = w.map;
  const c = workCentre(home);
  for (let y = c.y - def.radius; y <= c.y + def.radius; y++) {
    for (let x = c.x - def.radius; x <= c.x + def.radius; x++) {
      if (!m.inBounds(x, y) || dist({ x, y }, c) > def.radius) continue;
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
  if (!m.isPlantable(x, y) || m.hasDoorNear(x, y)) return false;
  return planting || !w.reservedPlots.has(m.idx(x, y));
}

/** Full check, used when the planting actually happens. `planting` skips the planter's own reservation. */
export function canPlant(w: World, what: PlantKind, x: number, y: number, owner: PlayerId, planting = false): boolean {
  const rule = PLANT_RULES[what];
  return plotLooksFree(w, x, y, owner, planting) && (!rule.fits || rule.fits(w.map, x, y)) && rule.isSafe(w, x, y);
}

export function plant(w: World, what: PlantKind, i: number): void {
  PLANT_RULES[what].plant(w, i);
}

/** How many plantings of the kind lie within the radius of the hut's door. */
function plantingsNear(w: World, home: Building, def: PlantDef): number {
  const m = w.map;
  const rule = PLANT_RULES[def.what];
  let n = 0;
  const c = workCentre(home);
  for (let y = c.y - def.radius; y <= c.y + def.radius; y++) {
    for (let x = c.x - def.radius; x <= c.x + def.radius; x++) {
      if (m.inBounds(x, y) && dist({ x, y }, c) <= def.radius && rule.counts(m, m.idx(x, y))) n++;
    }
  }
  return n;
}

/** A random reachable free plot around the hut, spreading plantings out; null when none or enough. */
export function findPlotFor(w: World, s: Settler, home: Building, def: PlantDef): Target | null {
  if (def.maxNearby !== undefined && plantingsNear(w, home, def) >= def.maxNearby) return null;
  const rule = PLANT_RULES[def.what];
  const candidates: Point[] = [];
  const r = def.radius;
  const c = workCentre(home);
  for (let y = c.y - r; y <= c.y + r; y++) {
    for (let x = c.x - r; x <= c.x + r; x++) {
      const d = dist({ x, y }, c);
      if (d < 2 || d > r || !plotLooksFree(w, x, y, s.owner, false)) continue;
      if (rule.fits && !rule.fits(w.map, x, y)) continue;
      if (def.what === 'tree' && treesAround(w.map, x, y) >= 4) continue;
      candidates.push({ x, y });
    }
  }
  for (let attempt = 0; attempt < 12 && candidates.length > 0; attempt++) {
    const [c] = candidates.splice(randInt(w.rng, candidates.length), 1);
    if (!PLANT_RULES[def.what].isSafe(w, c.x, c.y)) continue;
    const path = route(w, s, Math.round(s.x), Math.round(s.y), c.x, c.y, true);
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

/**
 * Whether the tile holds a planting whose timer runs: a sapling, an unripe field or stubble.
 * (`World.growing` lists exactly these; derived, rebuilt by `rebuildGrowing`.)
 */
function isGrowing(m: GameMap, i: number): boolean {
  if (m.tree[i] > 0) return m.tree[i] < TREE_MATURE;
  return m.crop[i] > 0 && m.crop[i] !== CROP_RIPE;
}

/** Collects the growing plantings from the map: at generation (young trees) and after a load. */
export function rebuildGrowing(w: World): void {
  w.growing.clear();
  const m = w.map;
  for (let i = 0; i < m.tree.length; i++) if (isGrowing(m, i)) w.growing.add(i);
}

/**
 * One timer step (`GROW_EVERY` ticks) for a growing planting: Settlers 4's fixed stage times
 * (`GROWTH`), no randomness. A tree or field moves to its next stage and stops once mature or ripe (a
 * ripe field never rots); stubble clears the tile once its time is up.
 */
function grow(w: World, i: number): void {
  const m = w.map;
  if (!isGrowing(m, i)) {
    w.growing.delete(i);
    return;
  }
  const tree = m.tree[i] > 0;
  const def = GROWTH[tree ? 'tree' : CROP_KINDS[m.cropKind[i]]];
  m.growth[i] += GROW_EVERY;
  if (!tree && m.crop[i] === CROP_STUBBLE) {
    if (m.growth[i] < (def.stubbleTicks ?? 0)) return;
    m.crop[i] = 0;
    m.cropKind[i] = 0;
  } else {
    if (m.growth[i] < def.stageTicks) return;
    if (tree) m.tree[i]++;
    else m.crop[i]++;
  }
  m.growth[i] = 0;
  m.touch(i);
  if (!isGrowing(m, i)) w.growing.delete(i);
}

/**
 * Plantings grow on their timers (`GROWTH`; the cost follows the number of growing plantings, never
 * the map area), trees seed (`TREE_SPREAD`), fish restock (`FISH_RESTOCK`; both 0 as in Settlers 4).
 */
export function updateNature(w: World): void {
  const m = w.map;
  const n = m.w * m.h;

  // No RNG and every tile on its own: the set's order (insertion, or index after a load) does not matter.
  if (w.tick % GROW_EVERY === 0) for (const i of w.growing) grow(w, i);

  scaled(w, TREE_SPREAD, () => {
    const i = randInt(w.rng, n);
    if (m.tree[i] !== TREE_MATURE) return;
    const x = (i % m.w) + randInt(w.rng, 5) - 2;
    const y = Math.floor(i / m.w) + randInt(w.rng, 5) - 2;
    if (!m.isPlantable(x, y) || m.hasDoorNear(x, y) || settlerNear(w, x, y)) return;
    if (treesAround(m, x, y) >= 5 || !staysConnected(m, x, y)) return;
    const j = m.idx(x, y);
    m.tree[j] = 1;
    m.growth[j] = 0;
    m.touch(j);
    w.growing.add(j);
  });

  scaled(w, FISH_RESTOCK, () => {
    const i = randInt(w.rng, n);
    if (TERRAIN[m.terrain[i] as Terrain].water && m.fish[i] < FISH_MAX && w.rng() < 0.5) m.fish[i]++;
  });
}
