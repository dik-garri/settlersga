import {
  DEPOSIT_STONE,
  FISH_MAX,
  FORD_EVERY,
  ORE_AMOUNT,
  ORE_RESOURCES,
  BIOMES,
  RIVERS_PER_64,
  TERRAIN,
  TREE_MATURE,
  type BuildGround,
} from './config';
import { createRng, randInt, type Rng } from './rng';
import { Terrain, type Point } from './types';

/** Edge length, in tiles, of the square chunks used to track changes. */
export const CHUNK = 16;

export class GameMap {
  readonly terrain: Uint8Array;
  /** 0 = no tree, 1..TREE_MATURE = growth stage. Trees block movement. */
  readonly tree: Uint8Array;
  /** Stone units left in a deposit on this tile, 0 if none. Deposits block movement. */
  readonly stone: Uint8Array;
  /** Field stage, 0 = no field, and its kind (`CROP_KINDS` index). Fields are walkable but not buildable. */
  readonly crop: Uint8Array;
  readonly cropKind: Uint8Array;
  /** Fish left in a water tile. */
  readonly fish: Uint8Array;
  /** Ore kind under a mountain tile (`ORE_RESOURCES` index + 1, 0 = none) and units left. */
  readonly ore: Uint8Array;
  readonly oreAmount: Uint8Array;
  /** Bit (player − 1) set once that player's geologist examined the tile. */
  readonly prospected: Uint8Array;
  /** Bit (player − 1) set once that player has seen the tile (fog of war; see fog.ts). */
  readonly explored: Uint8Array;
  /** Path wear from settlers' steps (`paths.ts`, `PATHS`): dusty path, then road. */
  readonly wear: Uint8Array;
  /** Player id owning the tile's territory, 0 if nobody. */
  readonly owner: Uint8Array;
  /** Building id occupying the tile, 0 if none. */
  readonly building: Int32Array;
  /** Building id whose door is on this tile, 0 if none. */
  readonly door: Int32Array;
  /**
   * Terrain elevation in screen pixels per tile corner: (w+1)×(h+1) vertices, vertex (vx, vy) being
   * the corner at tile coordinates (vx − ½, vy − ½). Set at generation; at runtime only diggers change
   * it, through `setVertexHeight`.
   */
  readonly height: Uint8Array;
  /** Per chunk: bumped whenever a corner of one of its tiles changes height. Derived, not saved. */
  readonly heightVersion: Uint32Array;

  /** Chunk grid size and a change counter per chunk (see `touch`). Derived, not saved. */
  readonly chunksX: number;
  readonly chunksY: number;
  readonly chunkVersion: Uint32Array;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    const n = w * h;
    this.chunksX = Math.ceil(w / CHUNK);
    this.chunksY = Math.ceil(h / CHUNK);
    this.chunkVersion = new Uint32Array(this.chunksX * this.chunksY);
    this.heightVersion = new Uint32Array(this.chunksX * this.chunksY);
    this.terrain = new Uint8Array(n).fill(Terrain.Grass);
    this.tree = new Uint8Array(n);
    this.stone = new Uint8Array(n);
    this.crop = new Uint8Array(n);
    this.cropKind = new Uint8Array(n);
    this.fish = new Uint8Array(n);
    this.ore = new Uint8Array(n);
    this.oreAmount = new Uint8Array(n);
    this.prospected = new Uint8Array(n);
    this.explored = new Uint8Array(n);
    this.wear = new Uint8Array(n);
    this.owner = new Uint8Array(n);
    this.building = new Int32Array(n);
    this.door = new Int32Array(n);
    this.height = new Uint8Array((w + 1) * (h + 1));
  }

  vertexHeight(vx: number, vy: number): number {
    const x = Math.min(this.w, Math.max(0, vx));
    const y = Math.min(this.h, Math.max(0, vy));
    return this.height[y * (this.w + 1) + x];
  }

  /** Runtime height change of one corner; marks every chunk whose tiles touch it. */
  setVertexHeight(vx: number, vy: number, h: number): void {
    if (vx < 0 || vy < 0 || vx > this.w || vy > this.h) return;
    this.height[vy * (this.w + 1) + vx] = Math.max(0, Math.min(255, h));
    for (let ty = vy - 1; ty <= vy; ty++) {
      for (let tx = vx - 1; tx <= vx; tx++) {
        if (this.inBounds(tx, ty)) this.heightVersion[this.chunkOf(tx, ty)]++;
      }
    }
  }

  /** Elevation at a fractional tile position (tile centers are integers), bilinear between corners. */
  heightAt(fx: number, fy: number): number {
    const u = Math.min(this.w, Math.max(0, fx + 0.5));
    const v = Math.min(this.h, Math.max(0, fy + 0.5));
    const x0 = Math.min(this.w - 1, Math.floor(u));
    const y0 = Math.min(this.h - 1, Math.floor(v));
    const tx = u - x0;
    const ty = v - y0;
    const a = this.vertexHeight(x0, y0);
    const b = this.vertexHeight(x0 + 1, y0);
    const c = this.vertexHeight(x0, y0 + 1);
    const d = this.vertexHeight(x0 + 1, y0 + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /** Max − min elevation over all corners of the tiles x0..x1 × y0..y1 (inclusive). */
  heightRange(x0: number, y0: number, x1: number, y1: number): number {
    let lo = Infinity;
    let hi = -Infinity;
    for (let vy = y0; vy <= y1 + 1; vy++) {
      for (let vx = x0; vx <= x1 + 1; vx++) {
        const h = this.vertexHeight(vx, vy);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    return hi - lo;
  }

  chunkOf(x: number, y: number): number {
    return Math.floor(y / CHUNK) * this.chunksX + Math.floor(x / CHUNK);
  }

  /**
   * Records that a tile's visible contents changed, so views only re-scan dirty chunks.
   * Every runtime write to `tree`, `stone`, `crop`, `prospected`, or `oreAmount` reaching 0 must call this.
   */
  touch(i: number): void {
    this.chunkVersion[this.chunkOf(i % this.w, Math.floor(i / this.w))]++;
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  isPassableTerrain(x: number, y: number): boolean {
    return TERRAIN[this.terrain[this.idx(x, y)] as Terrain].walkable;
  }

  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    return this.isPassableTerrain(x, y) && this.tree[i] === 0 && this.stone[i] === 0 && this.building[i] === 0;
  }

  /**
   * Free tile whose terrain accepts the given kind of footprint (`TERRAIN[t].build`): ordinary
   * buildings by default, mines with 'mountain'. A `Terrain` argument stands for the kind that
   * terrain accepts (Grass → ordinary, Mountain → mines).
   */
  isBuildable(x: number, y: number, ground: BuildGround | Terrain = 'ground'): boolean {
    if (!this.inBounds(x, y)) return false;
    const want = typeof ground === 'number' ? (TERRAIN[ground].build ?? 'ground') : ground;
    return TERRAIN[this.terrain[this.idx(x, y)] as Terrain].build === want && this.isFree(x, y);
  }

  /** Free tile where a tree or a field may be planted. */
  isPlantable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return TERRAIN[this.terrain[this.idx(x, y)] as Terrain].plantable && this.isFree(x, y);
  }

  /** Nothing on the tile: no tree, deposit, field, building or door. */
  private isFree(x: number, y: number): boolean {
    const i = this.idx(x, y);
    return (
      this.tree[i] === 0 && this.stone[i] === 0 && this.crop[i] === 0 && this.building[i] === 0 && this.door[i] === 0
    );
  }

  /** A water or other blocked tile that can be worked from an orthogonally adjacent walkable tile. */
  hasWalkableNeighbor(x: number, y: number): boolean {
    return (
      this.isWalkable(x + 1, y) || this.isWalkable(x - 1, y) || this.isWalkable(x, y + 1) || this.isWalkable(x, y - 1)
    );
  }

  hasDoorNear(x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (this.inBounds(nx, ny) && this.door[this.idx(nx, ny)] !== 0) return true;
      }
    }
    return false;
  }
}

function valueNoise(rng: Rng, w: number, h: number, cell: number): Float32Array {
  const gw = Math.ceil(w / cell) + 2;
  const gh = Math.ceil(h / cell) + 2;
  const grid = new Float32Array(gw * gh);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const out = new Float32Array(w * h);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x / cell;
      const gy = y / cell;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const a = grid[y0 * gw + x0];
      const b = grid[y0 * gw + x0 + 1];
      const c = grid[(y0 + 1) * gw + x0];
      const d = grid[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/**
 * Deserts on dry grass far from water and swamps on low, wet ground next to it, from a moisture
 * noise of their own RNG stream (so the rest of the generation does not shift). Start areas are
 * left untouched.
 */
function addBiomes(map: GameMap, height: Float32Array, starts: readonly Point[], rng: Rng): void {
  const { w, h } = map;
  const moisture = fractalNoise(rng, w, h);
  // Distance (4-neighbour steps) to the nearest water or ford, for every tile.
  const dist = new Int32Array(w * h).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < dist.length; i++) {
    const t = map.terrain[i] as Terrain;
    if (TERRAIN[t].water || t === Terrain.Ford) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!map.inBounds(nx, ny)) continue;
      const ni = map.idx(nx, ny);
      if (dist[ni] >= 0) continue;
      dist[ni] = dist[i] + 1;
      queue.push(ni);
    }
  }
  const clear = BIOMES.startClearance;
  const nearStart = (x: number, y: number) => starts.some((s) => Math.hypot(x - s.x, y - s.y) <= clear);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = map.idx(x, y);
      const t = map.terrain[i] as Terrain;
      if ((t !== Terrain.Grass && t !== Terrain.Sand) || nearStart(x, y)) continue;
      const d = dist[i] < 0 ? Infinity : dist[i];
      let biome: Terrain | null = null;
      if (t === Terrain.Grass && moisture[i] < BIOMES.desertDryness && d >= BIOMES.desertWaterDistance) {
        biome = Terrain.Desert;
      } else if (
        moisture[i] > BIOMES.swampWetness &&
        d <= BIOMES.swampWaterDistance &&
        height[i] < BIOMES.swampMaxHeight
      ) {
        biome = Terrain.Swamp;
      }
      if (biome === null) continue;
      map.terrain[i] = biome;
      map.tree[i] = 0;
    }
  }
}

function fractalNoise(rng: Rng, w: number, h: number): Float32Array {
  const layers: [number, number][] = [
    [16, 0.55],
    [8, 0.3],
    [4, 0.15],
  ];
  const out = new Float32Array(w * h);
  for (const [cell, weight] of layers) {
    const n = valueNoise(rng, w, h, cell);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * weight;
  }
  return out;
}

/**
 * Resources every start is guaranteed, the same for each player (fair starts) and at the same
 * offsets from the castle centre. Mountains are lobes of ore, each big enough for its own mine;
 * `elevate` gives every lobe a summit. Quarries are fields of stone boulders. The near mountain (coal
 * and iron) lies inside the castle's land; the far one (stone and gold) just beyond it, so it takes
 * a tower to reach, as gold usually does in Settlers 4. Lobe radii grow a little with the map
 * (`guaranteeScale`), so bigger maps get more.
 */
export const START_GUARANTEES = {
  mountains: [
    {
      dx: -2,
      dy: -8,
      lobes: [
        { dx: -1.8, dy: 0, r: 2.1, ore: 'coal' as const },
        { dx: 1.8, dy: 0, r: 2.1, ore: 'ironore' as const },
      ],
    },
    {
      dx: 9,
      dy: 8,
      lobes: [
        { dx: -1.8, dy: 0, r: 2.1, ore: 'stone' as const },
        { dx: 1.8, dy: 0, r: 2.1, ore: 'goldore' as const },
      ],
    },
  ],
  /** Ore units per tile of a guaranteed lobe, on 64×64 and on 256×256 and larger (natural ore: 6–14). */
  oreAmount: [32, 48] as const,
  quarries: [
    { dx: -7, dy: 3, r: 2.3, chance: 0.85 },
    { dx: 4, dy: -12, r: 1.8, chance: 0.8 },
  ],
};

/** Guaranteed lobes grow from their base radius on 64×64 by up to +0.8 tile on 256×256 and larger. */
function guaranteeScale(size: number): number {
  return 0.8 * Math.min(1, Math.max(0, (size - 64) / 192));
}

/** Every guaranteed ore lobe around these starts, in map coordinates. */
export function guaranteedLobes(starts: readonly Point[], size: number) {
  const grow = guaranteeScale(size);
  const [lo, hi] = START_GUARANTEES.oreAmount;
  const amount = Math.round(lo + ((hi - lo) * grow) / 0.8);
  return starts.flatMap((st) =>
    START_GUARANTEES.mountains.flatMap((m) =>
      m.lobes.map((l) => ({
        x: st.x + m.dx + l.dx,
        y: st.y + m.dy + l.dy,
        r: l.r + grow,
        ore: l.ore,
        amount,
      })),
    ),
  );
}

/**
 * Generates terrain, forests and ore. Around every start position (castle center) a meadow is
 * cleared and a grove, a quarry, a coal/iron mountain and a pond are guaranteed.
 */
export function generateMap(seed: number, size: number, starts: readonly Point[]): GameMap {
  const rng = createRng(seed);
  const map = new GameMap(size, size);
  const height = fractalNoise(rng, size, size);
  const forest = fractalNoise(rng, size, size);
  const oreNoise = ORE_RESOURCES.map(() => fractalNoise(rng, size, size));
  /** Ore under a mountain tile: the strongest ore noise above its threshold, otherwise some stone. */
  const seedOre = (i: number) => {
    const thresholds = [0.56, 0.6, 0.68, 2];
    let best = -1;
    for (let k = 0; k < thresholds.length; k++) {
      if (oreNoise[k][i] > thresholds[k] && (best < 0 || oreNoise[k][i] > oreNoise[best][i])) best = k;
    }
    if (best < 0 && rng() < 0.35) best = ORE_RESOURCES.indexOf('stone');
    if (best < 0) return;
    map.ore[i] = best + 1;
    map.oreAmount[i] = ORE_AMOUNT[0] + randInt(rng, ORE_AMOUNT[1] - ORE_AMOUNT[0] + 1);
  };

  // Large maps get mountain ranges: ridges of a low-frequency noise lift land into chains.
  // Separate RNG streams keep the rest of the generation (and every 64×64 map) unchanged.
  addRidges(height, size, createRng(seed ^ 0x2c1b3c6d));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = map.idx(x, y);
      // Push edges down so the map is framed by water.
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      const h = height[i] - (edge < 4 ? (4 - edge) * 0.08 : 0);
      height[i] = h;
      let t = Terrain.Grass;
      if (h < 0.3) t = Terrain.Water;
      else if (h < 0.35) t = Terrain.Sand;
      else if (h > 0.84) t = Terrain.Rock;
      else if (h > 0.7) t = Terrain.Mountain;
      map.terrain[i] = t;
      if (t === Terrain.Mountain) seedOre(i);
      if (t === Terrain.Water) map.fish[i] = FISH_MAX;
      if (t === Terrain.Grass && forest[i] > 0.55 && rng() < 0.75) {
        map.tree[i] = rng() < 0.85 ? TREE_MATURE : 2 + randInt(rng, 2);
      }
    }
  }

  carveRivers(map, height, starts, createRng(seed ^ 0x51ed2704));
  addBiomes(map, height, starts, createRng(seed ^ 0x6b43a9b5));

  const depositAt = (cx0: number, cy0: number, radius: number, chance: number, r: Rng = rng) => {
    for (let y = Math.floor(cy0 - radius); y <= cy0 + radius; y++) {
      for (let x = Math.floor(cx0 - radius); x <= cx0 + radius; x++) {
        if (!map.inBounds(x, y) || Math.hypot(x - cx0, y - cy0) > radius || r() > chance) continue;
        const i = map.idx(x, y);
        if (map.terrain[i] !== Terrain.Grass) continue;
        map.tree[i] = 0;
        map.fish[i] = 0;
        map.stone[i] = DEPOSIT_STONE[0] + randInt(r, DEPOSIT_STONE[1] - DEPOSIT_STONE[0] + 1);
      }
    }
  };

  // Scattered stone deposits.
  // About 7 deposits per 64×64, scaled with map area.
  const deposits = Math.max(1, Math.round((7 * size * size) / (64 * 64)));
  for (let k = 0; k < deposits; k++) depositAt(4 + randInt(rng, size - 8), 4 + randInt(rng, size - 8), 1.6, 0.65);

  const prepareStart = (cx: number, cy: number) => {
    // Clear a meadow for the castle.
    for (let y = cy - 6; y <= cy + 6; y++) {
      for (let x = cx - 6; x <= cx + 6; x++) {
        if (!map.inBounds(x, y)) continue;
        const i = map.idx(x, y);
        map.terrain[i] = Terrain.Grass;
        map.tree[i] = 0;
        map.stone[i] = 0;
        map.fish[i] = 0;
        map.ore[i] = 0;
        map.oreAmount[i] = 0;
      }
    }

    // Guarantee a grove a short walk from the castle.
    const gx = cx + 8;
    const gy = cy - 3;
    for (let y = gy - 3; y <= gy + 3; y++) {
      for (let x = gx - 3; x <= gx + 3; x++) {
        if (!map.inBounds(x, y)) continue;
        if (Math.hypot(x - gx, y - gy) > 3.2) continue;
        const i = map.idx(x, y);
        map.terrain[i] = Terrain.Grass;
        map.stone[i] = 0;
        map.fish[i] = 0;
        map.ore[i] = 0;
        map.oreAmount[i] = 0;
        if (rng() < 0.7) map.tree[i] = TREE_MATURE;
      }
    }

    // Guaranteed quarries: the first from the main stream (as it always was), the others from their
    // own stream so adding one never shifts the rest of the generation.
    START_GUARANTEES.quarries.forEach((q, k) => depositAt(cx + q.dx, cy + q.dy, q.r, q.chance, k === 0 ? rng : extra));

    // Guaranteed mountains: coal and iron inside the starting territory, stone and gold beyond it.
    for (const lobe of guaranteedLobes([{ x: cx, y: cy }], size)) {
      for (let y = Math.floor(lobe.y - lobe.r); y <= lobe.y + lobe.r; y++) {
        for (let x = Math.floor(lobe.x - lobe.r); x <= lobe.x + lobe.r; x++) {
          if (!map.inBounds(x, y) || Math.hypot(x - lobe.x, y - lobe.y) > lobe.r) continue;
          const i = map.idx(x, y);
          map.terrain[i] = Terrain.Mountain;
          map.tree[i] = 0;
          map.stone[i] = 0;
          map.fish[i] = 0;
          map.ore[i] = ORE_RESOURCES.indexOf(lobe.ore) + 1;
          map.oreAmount[i] = lobe.amount;
        }
      }
    }

    // Guarantee a pond inside the starting territory: water for wells, fish for fishers.
    const px = cx - 1;
    const py = cy + 8;
    for (let y = py - 3; y <= py + 3; y++) {
      for (let x = px - 3; x <= px + 3; x++) {
        if (!map.inBounds(x, y)) continue;
        const d = Math.hypot(x - px, y - py);
        const i = map.idx(x, y);
        map.ore[i] = 0;
        map.oreAmount[i] = 0;
        if (d <= 1.7) {
          map.terrain[i] = Terrain.Water;
          map.fish[i] = FISH_MAX;
        } else if (d <= 2.7 && map.terrain[i] !== Terrain.Water) {
          map.terrain[i] = Terrain.Sand;
        } else continue;
        map.tree[i] = 0;
        map.stone[i] = 0;
      }
    }
  };
  const extra = createRng(seed ^ 0x3a7f19c5);
  for (const st of starts) prepareStart(st.x, st.y);
  // Swamps, forests and boulders must not cut land apart.
  connectLand(map, starts);

  elevate(
    map,
    height,
    starts.map((st) => ({ cx: st.x, cy: st.y, r: 6 })),
    guaranteedLobes(starts, size),
  );
  return map;
}

/** Stretches of land smaller than this are not worth a passage of their own. */
const POCKET = 6;

/**
 * Keeps the land in one piece. Swamps are impassable (as in Settlers 4), and generated forests
 * block walking too, so they could cut land apart — even one castle from the others. Two passes:
 * first across swamps (by terrain alone: no land a swamp encloses is lost; tiny pockets drown in
 * it), then across forests (no clearing a forest encloses is unreachable; tracks are felled).
 */
function connectLand(map: GameMap, starts: readonly Point[]): void {
  if (starts.length === 0) return;
  const terrainOk = (i: number) => TERRAIN[map.terrain[i] as Terrain].walkable;
  bridge(
    map,
    map.idx(starts[0].x, starts[0].y),
    terrainOk,
    (i) => map.terrain[i] === Terrain.Swamp,
    (i) => {
      map.terrain[i] = Terrain.Grass;
    },
    (k) => {
      map.terrain[k] = Terrain.Swamp;
      map.tree[k] = 0;
      map.stone[k] = 0;
      map.ore[k] = 0;
      map.oreAmount[k] = 0;
    },
  );
  bridge(
    map,
    map.idx(starts[0].x, starts[0].y),
    (i) => terrainOk(i) && map.tree[i] === 0 && map.stone[i] === 0,
    (i) => terrainOk(i) && map.tree[i] !== 0,
    (i) => {
      map.tree[i] = 0;
    },
    null,
  );
}

/**
 * Connects every sizeable component of `land` (4-connected) that `barrier` tiles separate from the
 * component holding `from`: a breadth-first search crosses only barrier tiles, and whenever it
 * reaches another such component, the barrier tiles on the way back are opened (a 4-connected
 * track, so no corner cutting is needed) and that component joins the search. Components smaller
 * than POCKET get no track: those enclosed by barrier alone are `drown`ed (when given), others are
 * crossed as they are. Land cut off by anything else (water) stays as it was — rivers have fords.
 * Deterministic, no RNG, O(map).
 */
function bridge(
  map: GameMap,
  from: number,
  land: (i: number) => boolean,
  barrier: (i: number) => boolean,
  open: (i: number) => void,
  drown: ((i: number) => void) | null,
): void {
  const { w, h } = map;
  const n = w * h;
  const near = (i: number, f: (j: number) => void) => {
    const x = i % w;
    if (x > 0) f(i - 1);
    if (x < w - 1) f(i + 1);
    if (i >= w) f(i - w);
    if (i < n - w) f(i + w);
  };
  const comp = new Int32Array(n).fill(-1);
  const members: number[][] = [];
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0 || !land(i)) continue;
    const id = members.length;
    const list = [i];
    comp[i] = id;
    for (let q = 0; q < list.length; q++) {
      near(list[q], (j) => {
        if (comp[j] < 0 && land(j)) {
          comp[j] = id;
          list.push(j);
        }
      });
    }
    members.push(list);
  }
  if (comp[from] < 0) return;
  const linked = new Uint8Array(members.length);
  const parent = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const queue: number[] = [];
  const join = (id: number) => {
    linked[id] = 1;
    for (const i of members[id]) {
      seen[i] = 1;
      parent[i] = -1;
      queue.push(i);
    }
  };
  join(comp[from]);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    near(i, (j) => {
      if (seen[j]) return;
      if (barrier(j)) {
        seen[j] = 1;
        parent[j] = i;
        queue.push(j);
        return;
      }
      const id = comp[j];
      if (id < 0 || linked[id]) return;
      linked[id] = 1;
      if (members[id].length < POCKET) {
        // No track of its own: drowned when barrier alone encloses it, else crossed as it is.
        const enclosed =
          drown !== null &&
          members[id].every((k) => {
            let ok = true;
            near(k, (o) => {
              if (comp[o] !== id && !barrier(o) && land(o)) ok = false;
            });
            return ok;
          });
        for (const k of members[id]) {
          if (enclosed) drown!(k);
          seen[k] = 1;
          parent[k] = k === j ? i : j;
          queue.push(k);
        }
        return;
      }
      // Open the barrier from here back to linked land (pockets on the way are crossed as they are).
      for (let k = i; k >= 0 && parent[k] !== -1; k = parent[k]) if (barrier(k)) open(k);
      join(id);
    });
  }
}

/** Ridge weight grows from nothing on 64×64 to full strength on 192×192 and larger. */
function addRidges(height: Float32Array, size: number, rng: Rng): void {
  const weight = Math.min(1, Math.max(0, (size - 64) / 128));
  if (weight === 0) return;
  const broad = valueNoise(rng, size, size, Math.max(16, size / 4));
  const fine = valueNoise(rng, size, size, Math.max(8, size / 10));
  for (let i = 0; i < height.length; i++) {
    const n = broad[i] * 0.7 + fine[i] * 0.3;
    const ridge = Math.pow(1 - Math.abs(2 * n - 1), 6); // 1 on the ridge line, falling off fast
    // Ranges rise from land, not from the open sea.
    const land = Math.min(1, Math.max(0, (height[i] - 0.33) / 0.15));
    height[i] += weight * land * Math.max(0, ridge - 0.5) * 0.8;
  }
}

/** Rivers keep this far from every start so the guaranteed start area stays intact. */
const RIVER_START_CLEARANCE = 13;

/**
 * Rivers flow from high ground downhill (4-connected, slight meander) into existing water; one that
 * gets stuck in a basin ends in a small lake. Banks turn to sand, and every `FORD_EVERY` tiles a
 * straight stretch becomes a walkable ford, so rivers never split the land.
 */
function carveRivers(map: GameMap, height: Float32Array, starts: readonly Point[], rng: Rng): void {
  const size = map.w;
  const count = Math.max(1, Math.round((RIVERS_PER_64 * size * size) / (64 * 64)));
  const nearStart = (x: number, y: number) => starts.some((s) => Math.hypot(x - s.x, y - s.y) < RIVER_START_CLEARANCE);
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let k = 0; k < count; k++) {
    let src = -1;
    for (let attempt = 0; attempt < 80 && src < 0; attempt++) {
      const x = randInt(rng, size);
      const y = randInt(rng, size);
      const i = map.idx(x, y);
      const t = map.terrain[i];
      if (nearStart(x, y)) continue;
      if (t === Terrain.Mountain || (t === Terrain.Grass && height[i] > 0.58)) src = i;
    }
    if (src < 0) continue;
    const path: number[] = [];
    const visited = new Set<number>();
    let cur = src;
    let reachedWater = false;
    for (let step = 0; step < size * 3; step++) {
      visited.add(cur);
      if (map.terrain[cur] === Terrain.Water) {
        reachedWater = true;
        break;
      }
      path.push(cur);
      const cx = cur % size;
      const cy = Math.floor(cur / size);
      let next = -1;
      let nextH = Infinity;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!map.inBounds(nx, ny)) continue;
        const ni = map.idx(nx, ny);
        if (visited.has(ni) || map.terrain[ni] === Terrain.Rock || nearStart(nx, ny)) continue;
        const h = height[ni] + rng() * 0.03; // meander
        if (h < nextH) {
          next = ni;
          nextH = h;
        }
      }
      // Stuck, or would have to climb noticeably: the river ends here in a lake.
      if (next < 0 || height[next] > height[cur] + 0.03) break;
      cur = next;
    }
    if (path.length < 4) continue;

    const wet = (i: number) => {
      map.terrain[i] = Terrain.Water;
      map.fish[i] = FISH_MAX;
      map.tree[i] = 0;
      map.stone[i] = 0;
      map.ore[i] = 0;
      map.oreAmount[i] = 0;
    };
    for (const i of path) wet(i);
    if (!reachedWater) {
      const end = path[path.length - 1];
      const ex = end % size;
      const ey = Math.floor(end / size);
      for (let y = ey - 2; y <= ey + 2; y++) {
        for (let x = ex - 2; x <= ex + 2; x++) {
          if (!map.inBounds(x, y) || Math.hypot(x - ex, y - ey) > 1.8 || nearStart(x, y)) continue;
          if (map.terrain[map.idx(x, y)] !== Terrain.Rock) wet(map.idx(x, y));
        }
      }
    }
    // Sandy banks.
    for (const i of path) {
      const x = i % size;
      const y = Math.floor(i / size);
      for (const [dx, dy] of DIRS) {
        if (!map.inBounds(x + dx, y + dy)) continue;
        const ni = map.idx(x + dx, y + dy);
        if (map.terrain[ni] === Terrain.Grass && rng() < 0.6) {
          map.terrain[ni] = Terrain.Sand;
          map.tree[ni] = 0;
        }
      }
    }
    // Fords on straight stretches (land on both banks), roughly every FORD_EVERY tiles.
    const straight = (p: number) => {
      const a = path[p - 1];
      const b = path[p + 1];
      return (
        a !== undefined && b !== undefined && (a % size === b % size || Math.floor(a / size) === Math.floor(b / size))
      );
    };
    for (let p = Math.floor(FORD_EVERY / 2); p < path.length - 1; p += FORD_EVERY) {
      let q = p;
      while (q < path.length - 1 && !straight(q)) q++;
      if (q >= path.length - 1) break;
      map.terrain[path[q]] = Terrain.Ford;
      map.fish[path[q]] = 0;
      p = q;
    }
  }
}

/**
 * Corner heights from the final terrain and the height noise: water at 0, gentle sand and grass,
 * mountains clearly raised, rock peaks highest. The castle meadow is levelled and the guaranteed
 * mountain gets a summit. Uses no randomness, so it does not change the rest of the generation.
 */
function elevate(
  map: GameMap,
  noise: Float32Array,
  meadows: { cx: number; cy: number; r: number }[],
  summits: { x: number; y: number; r: number }[],
): void {
  const { w, h } = map;
  const tile = new Float32Array(w * h);
  for (let i = 0; i < tile.length; i++) {
    const n = noise[i];
    switch (map.terrain[i] as Terrain) {
      case Terrain.Water:
      case Terrain.Ford:
        tile[i] = 0;
        break;
      case Terrain.Sand:
        tile[i] = 3;
        break;
      case Terrain.Grass:
      case Terrain.Desert:
        tile[i] = 4 + Math.min(12, Math.max(0, (n - 0.35) * 30));
        break;
      case Terrain.Swamp:
        tile[i] = 2;
        break;
      case Terrain.Mountain:
        tile[i] = 12 + (Math.max(n, 0.7) - 0.7) * 400;
        break;
      case Terrain.Rock:
        tile[i] = 70 + (Math.max(n, 0.84) - 0.84) * 420;
        break;
    }
  }
  // Level each castle meadow to its mean height, easing back to the natural ground over a few tiles.
  const BLEND = 4;
  for (const meadow of meadows) {
    let sum = 0;
    let count = 0;
    for (let y = meadow.cy - meadow.r; y <= meadow.cy + meadow.r; y++) {
      for (let x = meadow.cx - meadow.r; x <= meadow.cx + meadow.r; x++) {
        if (map.inBounds(x, y) && map.terrain[map.idx(x, y)] === Terrain.Grass) {
          sum += tile[map.idx(x, y)];
          count++;
        }
      }
    }
    const level = count ? sum / count : 6;
    const reach = meadow.r + BLEND;
    for (let y = meadow.cy - reach; y <= meadow.cy + reach; y++) {
      for (let x = meadow.cx - reach; x <= meadow.cx + reach; x++) {
        if (!map.inBounds(x, y)) continue;
        const i = map.idx(x, y);
        const t = map.terrain[i];
        if (t !== Terrain.Grass && t !== Terrain.Sand) continue;
        const d = Math.max(Math.abs(x - meadow.cx), Math.abs(y - meadow.cy));
        const k = Math.min(1, Math.max(0, (d - meadow.r) / BLEND));
        tile[i] = level + (tile[i] - level) * k;
      }
    }
  }
  // Give each guaranteed mountain a summit.
  for (const summit of summits)
    for (let y = Math.floor(summit.y - summit.r); y <= summit.y + summit.r; y++) {
      for (let x = Math.floor(summit.x - summit.r); x <= summit.x + summit.r; x++) {
        if (!map.inBounds(x, y)) continue;
        const d = Math.hypot(x - summit.x, y - summit.y);
        const i = map.idx(x, y);
        if (d <= summit.r && map.terrain[i] === Terrain.Mountain) tile[i] = Math.max(tile[i], 14 + (summit.r - d) * 16);
      }
    }
  // Each corner averages its tiles; any water around it pins it to the water surface.
  for (let vy = 0; vy <= h; vy++) {
    for (let vx = 0; vx <= w; vx++) {
      let total = 0;
      let k = 0;
      let wet = false;
      for (const [tx, ty] of [
        [vx - 1, vy - 1],
        [vx, vy - 1],
        [vx - 1, vy],
        [vx, vy],
      ]) {
        if (!map.inBounds(tx, ty)) continue;
        const i = map.idx(tx, ty);
        if (map.terrain[i] === Terrain.Water || map.terrain[i] === Terrain.Ford) wet = true;
        total += tile[i];
        k++;
      }
      map.height[vy * (w + 1) + vx] = wet || k === 0 ? 0 : Math.min(255, Math.round(total / k));
    }
  }
}
