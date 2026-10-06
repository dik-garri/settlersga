import { DEPOSIT_STONE, FISH_MAX, ORE_AMOUNT, ORE_RESOURCES, TREE_MATURE } from './config';
import { createRng, randInt, type Rng } from './rng';
import { Terrain } from './types';

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
  /** Player id owning the tile's territory, 0 if nobody. */
  readonly owner: Uint8Array;
  /** Building id occupying the tile, 0 if none. */
  readonly building: Int32Array;
  /** Building id whose door is on this tile, 0 if none. */
  readonly door: Int32Array;
  /**
   * Terrain elevation in screen pixels per tile corner: (w+1)×(h+1) vertices, vertex (vx, vy) being
   * the corner at tile coordinates (vx − ½, vy − ½). Set at generation, static afterwards.
   */
  readonly height: Uint8Array;

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
    this.terrain = new Uint8Array(n).fill(Terrain.Grass);
    this.tree = new Uint8Array(n);
    this.stone = new Uint8Array(n);
    this.crop = new Uint8Array(n);
    this.cropKind = new Uint8Array(n);
    this.fish = new Uint8Array(n);
    this.ore = new Uint8Array(n);
    this.oreAmount = new Uint8Array(n);
    this.prospected = new Uint8Array(n);
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
    const t = this.terrain[this.idx(x, y)];
    return t === Terrain.Grass || t === Terrain.Sand || t === Terrain.Mountain;
  }

  isWalkable(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    return this.isPassableTerrain(x, y) && this.tree[i] === 0 && this.stone[i] === 0 && this.building[i] === 0;
  }

  /** Free tile of the given terrain (grass by default, mountain for mines) a footprint may cover. */
  isBuildable(x: number, y: number, terrain: Terrain = Terrain.Grass): boolean {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    return (
      this.terrain[i] === terrain &&
      this.tree[i] === 0 &&
      this.stone[i] === 0 &&
      this.crop[i] === 0 &&
      this.building[i] === 0 &&
      this.door[i] === 0
    );
  }

  /** A water or other blocked tile that can be worked from an orthogonally adjacent walkable tile. */
  hasWalkableNeighbor(x: number, y: number): boolean {
    return this.isWalkable(x + 1, y) || this.isWalkable(x - 1, y) || this.isWalkable(x, y + 1) || this.isWalkable(x, y - 1);
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

/** Generates terrain and forests. The area around (cx, cy) is cleared for the castle. */
export function generateMap(seed: number, size: number, cx: number, cy: number): GameMap {
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

  const depositAt = (cx0: number, cy0: number, radius: number, chance: number) => {
    for (let y = Math.floor(cy0 - radius); y <= cy0 + radius; y++) {
      for (let x = Math.floor(cx0 - radius); x <= cx0 + radius; x++) {
        if (!map.inBounds(x, y) || Math.hypot(x - cx0, y - cy0) > radius || rng() > chance) continue;
        const i = map.idx(x, y);
        if (map.terrain[i] !== Terrain.Grass) continue;
        map.tree[i] = 0;
        map.fish[i] = 0;
        map.stone[i] = DEPOSIT_STONE[0] + randInt(rng, DEPOSIT_STONE[1] - DEPOSIT_STONE[0] + 1);
      }
    }
  };

  // Scattered stone deposits.
  // About 7 deposits per 64×64, scaled with map area.
  const deposits = Math.max(1, Math.round((7 * size * size) / (64 * 64)));
  for (let k = 0; k < deposits; k++) depositAt(4 + randInt(rng, size - 8), 4 + randInt(rng, size - 8), 1.6, 0.65);

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

  // Guarantee a quarry on the other side.
  depositAt(cx - 7, cy + 3, 2.3, 0.85);

  // Guarantee a small mountain with coal and iron inside the starting territory.
  const mx = cx - 2;
  const my = cy - 8;
  for (let y = my - 3; y <= my + 3; y++) {
    for (let x = mx - 3; x <= mx + 3; x++) {
      if (!map.inBounds(x, y) || Math.hypot(x - mx, y - my) > 2.8) continue;
      const i = map.idx(x, y);
      map.terrain[i] = Terrain.Mountain;
      map.tree[i] = 0;
      map.stone[i] = 0;
      map.fish[i] = 0;
      map.ore[i] = ORE_RESOURCES.indexOf(x < mx ? 'coal' : 'ironore') + 1;
      map.oreAmount[i] = ORE_AMOUNT[1];
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

  elevate(map, height, { cx, cy, r: 6 }, { x: mx, y: my, r: 2.8 });
  return map;
}

/**
 * Corner heights from the final terrain and the height noise: water at 0, gentle sand and grass,
 * mountains clearly raised, rock peaks highest. The castle meadow is levelled and the guaranteed
 * mountain gets a summit. Uses no randomness, so it does not change the rest of the generation.
 */
function elevate(
  map: GameMap,
  noise: Float32Array,
  meadow: { cx: number; cy: number; r: number },
  summit: { x: number; y: number; r: number },
): void {
  const { w, h } = map;
  const tile = new Float32Array(w * h);
  for (let i = 0; i < tile.length; i++) {
    const n = noise[i];
    switch (map.terrain[i] as Terrain) {
      case Terrain.Water:
        tile[i] = 0;
        break;
      case Terrain.Sand:
        tile[i] = 3;
        break;
      case Terrain.Grass:
        tile[i] = 4 + Math.min(12, Math.max(0, (n - 0.35) * 30));
        break;
      case Terrain.Mountain:
        tile[i] = 12 + (Math.max(n, 0.7) - 0.7) * 400;
        break;
      case Terrain.Rock:
        tile[i] = 70 + (Math.max(n, 0.84) - 0.84) * 420;
        break;
    }
  }
  // Level the castle meadow to its mean height, easing back to the natural ground over a few tiles.
  const BLEND = 4;
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
  // Give the guaranteed mountain a summit.
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
        if (map.terrain[i] === Terrain.Water) wet = true;
        total += tile[i];
        k++;
      }
      map.height[vy * (w + 1) + vx] = wet || k === 0 ? 0 : Math.min(255, Math.round(total / k));
    }
  }
}
