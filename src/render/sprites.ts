/**
 * Procedural sprite painters. Everything is drawn with Canvas 2D at startup;
 * see atlas.ts for packing into a single texture.
 */
import type { BuildingType, Resource } from '../sim/types';
import { createRng } from '../sim/rng';
import { HALF_H, HALF_W } from './iso';

type Ctx = CanvasRenderingContext2D;
type V3 = readonly [number, number, number];

// ------------------------------------------------------------------ helpers

/** 3D point in tile units (dx, dy) and pixel height z → canvas point. */
function P(dx: number, dy: number, z: number): [number, number] {
  return [(dx - dy) * HALF_W, (dx + dy) * HALF_H - z];
}

function poly(ctx: Ctx, pts: readonly V3[], fill: string, stroke?: string): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = P(p[0], p[1], p[2]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function line(ctx: Ctx, a: V3, b: V3, color: string, width = 1): void {
  ctx.beginPath();
  ctx.moveTo(...P(a[0], a[1], a[2]));
  ctx.lineTo(...P(b[0], b[1], b[2]));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

function shadow(ctx: Ctx, hw: number, hh: number, shift = 0.35): void {
  poly(
    ctx,
    [
      [-hw + shift, -hh, 0],
      [hw + shift, -hh, 0],
      [hw + shift, hh + shift * 0.5, 0],
      [-hw + shift, hh + shift * 0.5, 0],
    ],
    'rgba(0,0,0,0.22)',
  );
}

/** Visible walls of a box centered at (cx, cy): the +y face (front-left) and +x face (front-right). */
function walls(
  ctx: Ctx,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  z0: number,
  h: number,
  color: string,
): void {
  const z1 = z0 + h;
  poly(
    ctx,
    [
      [cx - hw, cy + hh, z0],
      [cx + hw, cy + hh, z0],
      [cx + hw, cy + hh, z1],
      [cx - hw, cy + hh, z1],
    ],
    color,
  );
  poly(
    ctx,
    [
      [cx + hw, cy - hh, z0],
      [cx + hw, cy + hh, z0],
      [cx + hw, cy + hh, z1],
      [cx + hw, cy - hh, z1],
    ],
    shade(color, 0.72),
  );
}

function box(ctx: Ctx, cx: number, cy: number, hw: number, hh: number, z0: number, h: number, color: string) {
  walls(ctx, cx, cy, hw, hh, z0, h, color);
  const z1 = z0 + h;
  poly(
    ctx,
    [
      [cx - hw, cy - hh, z1],
      [cx + hw, cy - hh, z1],
      [cx + hw, cy + hh, z1],
      [cx - hw, cy + hh, z1],
    ],
    shade(color, 1.12),
  );
}

/** Gable roof with the ridge running along x; overhang only on the eaves. */
function gableRoof(ctx: Ctx, hw: number, hh: number, z: number, rise: number, color: string, wall: string) {
  const o = 0.14;
  poly(
    ctx,
    [
      [-hw, -hh - o, z - 3],
      [hw, -hh - o, z - 3],
      [hw, 0, z + rise],
      [-hw, 0, z + rise],
    ],
    shade(color, 0.8),
  );
  poly(
    ctx,
    [
      [hw, -hh, z],
      [hw, hh, z],
      [hw, 0, z + rise],
    ],
    shade(wall, 0.72),
  );
  poly(
    ctx,
    [
      [-hw, hh + o, z - 3],
      [hw, hh + o, z - 3],
      [hw, 0, z + rise],
      [-hw, 0, z + rise],
    ],
    color,
  );
  // Roof texture stripes and ridge.
  for (let t = 0.2; t < 1; t += 0.2) {
    line(ctx, [-hw, (hh + o) * t, z - 3 + (rise + 3) * (1 - t)], [hw, (hh + o) * t, z - 3 + (rise + 3) * (1 - t)], shade(color, 0.85));
  }
  line(ctx, [-hw, 0, z + rise], [hw, 0, z + rise], shade(color, 1.25), 2);
}

function pyramidRoof(ctx: Ctx, a: number, z: number, rise: number, color: string) {
  const apex: V3 = [0, 0, z + rise];
  poly(ctx, [[-a, -a, z], [-a, a, z], apex], shade(color, 0.7));
  poly(ctx, [[-a, -a, z], [a, -a, z], apex], shade(color, 0.85));
  poly(ctx, [[-a, a, z], [a, a, z], apex], color);
  poly(ctx, [[a, -a, z], [a, a, z], apex], shade(color, 0.75));
}

/** Rectangle on the +y face between dx0..dx1 and z0..z1. */
function frontQuad(ctx: Ctx, hh: number, dx0: number, dx1: number, z0: number, z1: number, color: string) {
  poly(ctx, [[dx0, hh, z0], [dx1, hh, z0], [dx1, hh, z1], [dx0, hh, z1]], color);
}

/** Rectangle on the +x face between dy0..dy1 and z0..z1. */
function sideQuad(ctx: Ctx, hw: number, dy0: number, dy1: number, z0: number, z1: number, color: string) {
  poly(ctx, [[hw, dy0, z0], [hw, dy1, z0], [hw, dy1, z1], [hw, dy0, z1]], color);
}

function logEnds(ctx: Ctx, at: [number, number], count: number) {
  for (let i = 0; i < count; i++) {
    const row = i < 3 ? 0 : 1;
    const x = at[0] + (i % 3) * 6 + row * 3;
    const y = at[1] - row * 5;
    ctx.beginPath();
    ctx.ellipse(x, y, 3.2, 3, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#c99b62';
    ctx.fill();
    ctx.strokeStyle = '#6e4521';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- terrain

export type GroundKind = 'grass' | 'sand' | 'water' | 'rock' | 'mountain' | 'ford' | 'desert' | 'swamp';

const GROUND_COLORS: Record<GroundKind, { base: string[]; dots: string[] }> = {
  grass: { base: ['#6a9a3c', '#6f9f40', '#64933a', '#73a145'], dots: ['#7fb04f', '#5a8733', '#88b85a'] },
  sand: { base: ['#d8c48a', '#d2bd82'], dots: ['#c7b077', '#e4d39d'] },
  water: { base: ['#2f6f9e', '#2c6995'], dots: ['#4f8fbd', '#3b7cab'] },
  rock: { base: ['#8a8378', '#837c71'], dots: ['#9b958b', '#6f695f'] },
  mountain: { base: ['#9a8f7c', '#948a77', '#a09582'], dots: ['#b0a690', '#7e7462', '#8c8a6a'] },
  ford: { base: ['#5f97b4', '#6a9fb8'], dots: ['#cdbb86', '#8fbfd6'] },
  desert: { base: ['#ddb978', '#d8b271', '#e1c083'], dots: ['#c9a062', '#ecd29a', '#b98f55'] },
  swamp: { base: ['#4f5f3a', '#55653d', '#4a5a37'], dots: ['#2f4f4f', '#6f7f45', '#3a4a2a'] },
};

/** Ground kinds in blending order: a tile's higher-priority neighbours fade over its edges. */
export const GROUND_PRIORITY: readonly GroundKind[] = [
  'water',
  'ford',
  'swamp',
  'sand',
  'desert',
  'grass',
  'mountain',
  'rock',
];

/**
 * Transition overlays: which edge or corner of a tile the neighbour sits at, as tile-local (u, v)
 * offsets (u along tile x, v along tile y; the neighbour is at u/v = 1 for +1, 0 for −1).
 */
export const EDGE_DIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

/**
 * A ground tile of `kind` faded out towards the tile's centre from the edge or corner `dir`
 * (index into `EDGE_DIRS`), with a ragged noisy border. Same 66×34 canvas as `paintGround`.
 */
export function paintGroundEdge(ctx: Ctx, kind: GroundKind, dir: number): void {
  const scale = 2;
  const tmp = document.createElement('canvas');
  tmp.width = 66 * scale;
  tmp.height = 34 * scale;
  const t = tmp.getContext('2d')!;
  t.scale(scale, scale);
  paintGround(t, kind, 0);
  const img = t.getImageData(0, 0, tmp.width, tmp.height);
  const [du, dv] = EDGE_DIRS[dir];
  const rng = createRng(4000 + dir * 31 + kind.length);
  // Coarse value noise for a ragged border.
  const grid = Array.from({ length: 9 * 9 }, () => rng());
  const noise = (u: number, v: number) => {
    const gx = Math.max(0, Math.min(7.999, u * 8));
    const gy = Math.max(0, Math.min(7.999, v * 8));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const tx = gx - x0;
    const ty = gy - y0;
    const a = grid[y0 * 9 + x0];
    const b = grid[y0 * 9 + x0 + 1];
    const c = grid[(y0 + 1) * 9 + x0];
    const d = grid[(y0 + 1) * 9 + x0 + 1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
  for (let py = 0; py < tmp.height; py++) {
    for (let px = 0; px < tmp.width; px++) {
      // Canvas pixel → tile-local (u, v): the diamond's top corner is (33, 0), u runs down-right.
      const sx = (px + 0.5) / scale - 33;
      const sy = (py + 0.5) / scale;
      const u = (sx / 32 + sy / 16) / 2;
      const v = (sy / 16 - sx / 32) / 2;
      // Distance from the neighbour's edge (0 at the edge, 1 at the far side), or from its corner.
      const eu = du > 0 ? 1 - u : u;
      const ev = dv > 0 ? 1 - v : v;
      const d = du !== 0 && dv !== 0 ? Math.hypot(eu, ev) * 1.25 : du !== 0 ? eu : ev;
      const reach = 0.42 + (noise(u, v) - 0.5) * 0.3;
      const m = Math.max(0, Math.min(1, (reach - d) / 0.18));
      img.data[(py * tmp.width + px) * 4 + 3] *= m;
    }
  }
  t.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0, 66, 34);
}

export function groundVariants(kind: GroundKind): number {
  return GROUND_COLORS[kind].base.length;
}

/** Diamond tile, 66×34 canvas with the tile center at (33, 17). Slightly oversized to hide seams. */
export function paintGround(ctx: Ctx, kind: GroundKind, variant: number): void {
  const { base, dots } = GROUND_COLORS[kind];
  ctx.translate(33, 17);
  ctx.beginPath();
  ctx.moveTo(0, -17);
  ctx.lineTo(33, 0);
  ctx.lineTo(0, 17);
  ctx.lineTo(-33, 0);
  ctx.closePath();
  ctx.fillStyle = base[variant];
  ctx.fill();
  ctx.save();
  ctx.clip();
  const rng = createRng(kind.length * 1000 + variant * 77 + 3);
  if (kind === 'water' || kind === 'ford') {
    for (let i = 0; i < 4; i++) {
      const x = rng() * 44 - 22;
      const y = rng() * 18 - 9;
      ctx.beginPath();
      ctx.moveTo(x - 6, y);
      ctx.quadraticCurveTo(x - 3, y - 2, x, y);
      ctx.quadraticCurveTo(x + 3, y + 2, x + 6, y);
      ctx.strokeStyle = dots[i % dots.length];
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (kind === 'ford') {
      // Shallow: pebbles show through.
      for (let i = 0; i < 14; i++) {
        ctx.fillStyle = 'rgba(214,196,138,0.75)';
        ctx.fillRect(rng() * 52 - 26, rng() * 24 - 12, 2, 1.5);
      }
    }
  } else if (kind === 'desert') {
    // Wind ripples and a few cracks in baked ground.
    for (let i = 0; i < 6; i++) {
      const x = rng() * 46 - 23;
      const y = rng() * 20 - 10;
      ctx.beginPath();
      ctx.moveTo(x - 7, y + 1);
      ctx.quadraticCurveTo(x, y - 2, x + 7, y + 1);
      ctx.strokeStyle = dots[i % 2 === 0 ? 1 : 2];
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    for (let i = 0; i < 2; i++) {
      const x = rng() * 30 - 15;
      const y = rng() * 12 - 6;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 3, y + 1.5);
      ctx.lineTo(x + 5, y + 0.5);
      ctx.strokeStyle = 'rgba(120,80,40,0.45)';
      ctx.stroke();
    }
  } else if (kind === 'swamp') {
    // Dark puddles and reed tufts.
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(rng() * 36 - 18, rng() * 14 - 7, 5 + rng() * 4, 2 + rng() * 1.5, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(40,70,72,0.75)';
      ctx.fill();
    }
    ctx.strokeStyle = '#7f8f4a';
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const x = rng() * 48 - 24;
      const y = rng() * 22 - 11;
      for (const dx of [-1, 0, 1]) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y);
        ctx.lineTo(x + dx * 2, y - 4 - rng() * 2);
        ctx.stroke();
      }
    }
  } else if (kind === 'mountain') {
    // Rocky slope: light ledges with dark cracks under them.
    for (let i = 0; i < 5; i++) {
      const x = rng() * 44 - 22;
      const y = rng() * 18 - 9;
      const len = 6 + rng() * 8;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(x - len / 2, y);
      ctx.lineTo(x, y - 3);
      ctx.lineTo(x + len / 2, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(40,32,24,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - len / 2, y);
      ctx.lineTo(x + len / 2, y + 1);
      ctx.stroke();
    }
  } else {
    const count = kind === 'grass' ? 26 : 18;
    for (let i = 0; i < count; i++) {
      const x = rng() * 64 - 32;
      const y = rng() * 32 - 16;
      ctx.fillStyle = dots[Math.floor(rng() * dots.length)];
      if (kind === 'grass') ctx.fillRect(x, y, 1, 2 + Math.floor(rng() * 2));
      else ctx.fillRect(x, y, 2, 1);
    }
  }
  ctx.restore();
}

/** Boulder for rock tiles, 52×40 with the base at (26, 30). */
export function paintBoulder(ctx: Ctx, variant: number): void {
  ctx.translate(26, 30);
  const rng = createRng(500 + variant);
  ctx.beginPath();
  ctx.ellipse(4, 2, 20, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fill();
  const blobs = variant === 0 ? 3 : 2;
  for (let i = 0; i < blobs; i++) {
    const bx = (i - (blobs - 1) / 2) * 11 + rng() * 4;
    const by = -2 - rng() * 3;
    const r = 10 + rng() * 5;
    ctx.beginPath();
    ctx.moveTo(bx - r, by);
    ctx.lineTo(bx - r * 0.6, by - r * 0.9);
    ctx.lineTo(bx + r * 0.2, by - r * 1.2);
    ctx.lineTo(bx + r * 0.9, by - r * 0.6);
    ctx.lineTo(bx + r, by);
    ctx.closePath();
    ctx.fillStyle = '#8f8a80';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bx - r * 0.6, by - r * 0.9);
    ctx.lineTo(bx + r * 0.2, by - r * 1.2);
    ctx.lineTo(bx + r * 0.1, by - r * 0.3);
    ctx.lineTo(bx - r, by);
    ctx.closePath();
    ctx.fillStyle = '#aaa59b';
    ctx.fill();
    ctx.strokeStyle = '#5f5a52';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx - r, by);
    ctx.lineTo(bx + r, by);
    ctx.stroke();
  }
}

/** Cut stone block in canvas pixels; (x, y) is the bottom-front corner. */
function stoneBlock(ctx: Ctx, x: number, y: number, w: number, h: number, tone: number): void {
  const d = w * 0.35;
  const base = '#c9c1ae';
  ctx.fillStyle = shade(base, 0.78 * tone);
  ctx.fillRect(x, y - h, w, h);
  ctx.beginPath();
  ctx.moveTo(x + w, y);
  ctx.lineTo(x + w + d, y - d * 0.5);
  ctx.lineTo(x + w + d, y - h - d * 0.5);
  ctx.lineTo(x + w, y - h);
  ctx.closePath();
  ctx.fillStyle = shade(base, 0.6 * tone);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - h);
  ctx.lineTo(x + w, y - h);
  ctx.lineTo(x + w + d, y - h - d * 0.5);
  ctx.lineTo(x + d, y - h - d * 0.5);
  ctx.closePath();
  ctx.fillStyle = shade(base, 1.05 * tone);
  ctx.fill();
}

/** Quarriable stone deposit, 56×44 with the base at (28, 34). Size 0–2 shrinks as it is mined. */
export function paintDeposit(ctx: Ctx, size: number): void {
  ctx.translate(28, 34);
  ctx.beginPath();
  ctx.ellipse(3, 1, 22, 8, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.fill();
  const blocks: [number, number, number, number, number][][] = [
    [
      [-8, 4, 12, 8, 1],
      [2, 6, 10, 7, 0.92],
    ],
    [
      [-16, 4, 14, 10, 0.95],
      [-2, 7, 14, 9, 1],
      [-9, -5, 12, 9, 1.05],
    ],
    [
      [-19, 3, 14, 11, 0.95],
      [-5, 7, 15, 10, 1],
      [6, 2, 12, 9, 0.9],
      [-13, -7, 13, 10, 1.05],
      [0, -3, 12, 9, 1],
    ],
  ];
  for (const [x, y, w, h, tone] of blocks[size]) stoneBlock(ctx, x, y, w, h, tone);
}

/** Tree, 48×80 with the trunk base at (24, 72). Variants 0–1 conifers, 2–3 broadleaf. */
export function paintTree(ctx: Ctx, variant: number): void {
  ctx.translate(24, 72);
  ctx.beginPath();
  ctx.ellipse(5, 0, 14, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();
  ctx.fillStyle = '#5e3b1f';
  ctx.fillRect(-2.5, -16, 5, 16);
  if (variant < 2) {
    const tiers = 3;
    const dark = variant === 0 ? '#2f5a2a' : '#355f2e';
    const light = variant === 0 ? '#447a35' : '#4c843b';
    for (let i = 0; i < tiers; i++) {
      const base = -12 - i * 14;
      const half = 17 - i * 4;
      const top = base - 24;
      ctx.beginPath();
      ctx.moveTo(-half, base);
      ctx.lineTo(0, top);
      ctx.lineTo(half, base);
      ctx.closePath();
      ctx.fillStyle = dark;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-half, base);
      ctx.lineTo(0, top);
      ctx.lineTo(-2, base);
      ctx.closePath();
      ctx.fillStyle = light;
      ctx.fill();
    }
  } else {
    const rng = createRng(900 + variant);
    const blobs: [number, number, number][] = [
      [0, -40, 15],
      [-10, -32, 11],
      [10, -31, 11],
      [-4, -50, 10],
      [7, -46, 10],
    ];
    for (const [x, y, r] of blobs) {
      ctx.beginPath();
      ctx.arc(x, y, r + rng() * 2, 0, Math.PI * 2);
      ctx.fillStyle = variant === 2 ? '#3f7a2e' : '#4a8233';
      ctx.fill();
    }
    for (const [x, y, r] of blobs) {
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = variant === 2 ? '#5b9a3e' : '#68a647';
      ctx.fill();
    }
  }
}

// --------------------------------------------------------------- buildings

export interface BuildingCanvas {
  w: number;
  h: number;
  /** Footprint center in canvas pixels. */
  ax: number;
  ay: number;
}

const SMALL: BuildingCanvas = { w: 150, h: 140, ax: 75, ay: 100 };
const LARGE: BuildingCanvas = { w: 220, h: 190, ax: 110, ay: 135 };

/** Sprite canvas per building; `site2`/`site3` are construction sites for 2×2 and 3×3 footprints. */
export const BUILDING_CANVAS: Record<BuildingType | 'site2' | 'site3', BuildingCanvas> = {
  castle: { w: 220, h: 250, ax: 110, ay: 190 },
  house_small: SMALL,
  house_medium: SMALL,
  house_large: LARGE,
  woodcutter: SMALL,
  sawmill: SMALL,
  forester: SMALL,
  stonecutter: SMALL,
  waterworks: SMALL,
  fisher: SMALL,
  farm: LARGE,
  mill: { w: 150, h: 210, ax: 75, ay: 165 },
  bakery: SMALL,
  pigfarm: SMALL,
  slaughterhouse: SMALL,
  coalmine: SMALL,
  ironmine: SMALL,
  goldmine: SMALL,
  stonemine: SMALL,
  warehouse: SMALL,
  vineyard: SMALL,
  winery: SMALL,
  ironsmelter: SMALL,
  goldsmelter: SMALL,
  toolsmith: SMALL,
  weaponsmith: SMALL,
  tower: { w: 150, h: 210, ax: 75, ay: 170 },
  bigtower: { w: 170, h: 240, ax: 85, ay: 190 },
  fortress: { w: 230, h: 260, ax: 115, ay: 195 },
  site2: { w: 150, h: 90, ax: 75, ay: 50 },
  site3: { w: 220, h: 120, ax: 110, ay: 65 },
};

function paintCastle(ctx: Ctx): void {
  const hw = 1.3;
  const hh = 1.3;
  const H = 42;
  const stone = '#a8a294';
  shadow(ctx, hw, hh, 0.5);
  walls(ctx, 0, 0, hw, hh, 0, H, stone);
  for (let z = 7; z < H; z += 7) {
    line(ctx, [-hw, hh, z], [hw, hh, z], shade(stone, 0.82));
    line(ctx, [hw, -hh, z], [hw, hh, z], shade(stone, 0.6));
  }
  for (let z = 0, row = 0; z < H; z += 7, row++) {
    for (let t = -hw + (row % 2 ? 0.15 : 0.3); t < hw; t += 0.32) {
      line(ctx, [t, hh, z], [t, hh, Math.min(z + 7, H)], shade(stone, 0.82));
      line(ctx, [hw, t, z], [hw, t, Math.min(z + 7, H)], shade(stone, 0.6));
    }
  }
  poly(ctx, [[-hw, -hh, H], [hw, -hh, H], [hw, hh, H], [-hw, hh, H]], shade(stone, 0.9));
  // Back crenellations, then the keep, then front crenellations.
  const merlon = (cx: number, cy: number) => box(ctx, cx, cy, 0.09, 0.09, H, 7, stone);
  for (let t = -hw + 0.09; t <= hw; t += 0.36) {
    merlon(t, -hh + 0.09);
    merlon(-hw + 0.09, t);
  }
  const k = 0.6;
  box(ctx, 0, 0, k, k, H, 46, '#b4ae9f');
  frontQuad(ctx, k, -0.15, 0.15, H + 26, H + 38, '#3a3430');
  sideQuad(ctx, k, -0.15, 0.15, H + 26, H + 38, '#2c2724');
  pyramidRoof(ctx, k + 0.1, H + 46, 42, '#b23a2c');
  // The banner on the roof tip is a separate per-owner sprite (`BANNERS`).
  for (let t = -hw + 0.09; t <= hw; t += 0.36) {
    merlon(t, hh - 0.09);
    merlon(hw - 0.09, t);
  }
  // Gate in front of the door tile (dx = +1).
  frontQuad(ctx, hh, 0.72, 1.24, 0, 24, '#3d2a1a');
  frontQuad(ctx, hh, 0.76, 1.2, 0, 21, '#5a3d22');
  line(ctx, [0.98, hh, 0], [0.98, hh, 21], '#3d2a1a');
  frontQuad(ctx, hh, -0.7, -0.5, 22, 30, '#2c2724');
  sideQuad(ctx, hw, -0.4, -0.2, 22, 30, '#221e1b');
  sideQuad(ctx, hw, 0.4, 0.6, 22, 30, '#221e1b');
}

function paintWoodcutter(ctx: Ctx): void {
  const hw = 0.8;
  const hh = 0.8;
  const H = 26;
  const plaster = '#e6d8b8';
  const beam = '#5b3a1e';
  shadow(ctx, hw, hh);
  walls(ctx, 0, 0, hw, hh, 0, H, plaster);
  for (const t of [-hw, -0.25, 0.25, hw]) {
    line(ctx, [t, hh, 0], [t, hh, H], beam, 2);
    line(ctx, [hw, t, 0], [hw, t, H], shade(beam, 0.8), 2);
  }
  line(ctx, [-hw, hh, H * 0.55], [hw, hh, H * 0.55], beam, 2);
  line(ctx, [hw, -hh, H * 0.55], [hw, hh, H * 0.55], shade(beam, 0.8), 2);
  line(ctx, [-hw, hh, 0], [-0.25, hh, H * 0.55], beam, 1.5);
  frontQuad(ctx, hh, 0.32, 0.7, 0, 17, '#4a2c14');
  frontQuad(ctx, hh, -0.6, -0.35, 9, 15, '#33302c');
  sideQuad(ctx, hw, -0.4, -0.1, 16, 22, '#2a2724');
  gableRoof(ctx, hw, hh, H, 28, '#9c5530', plaster);
  // Firewood stacked against the side wall.
  const [lx, ly] = P(hw + 0.18, 0.05, 0);
  logEnds(ctx, [lx - 4, ly - 2], 5);
}

function paintSawmill(ctx: Ctx): void {
  const hw = 0.8;
  const hh = 0.8;
  const H = 24;
  const wood = '#b27f4c';
  shadow(ctx, hw, hh);
  walls(ctx, 0, 0, hw, hh, 0, H, wood);
  for (let t = -hw + 0.12; t < hw; t += 0.12) {
    line(ctx, [t, hh, 0], [t, hh, H], shade(wood, 0.82));
    line(ctx, [hw, t, 0], [hw, t, H], shade(wood, 0.6));
  }
  frontQuad(ctx, hh, 0.3, 0.72, 0, 18, '#3e2a18');
  gableRoof(ctx, hw, hh, H, 22, '#5f6d7c', wood);
  // Circular saw on the side wall.
  const [sx, sy] = P(hw, 0.05, 12);
  ctx.beginPath();
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = i % 2 ? 7.5 : 10;
    ctx.lineTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r * 0.9);
  }
  ctx.closePath();
  ctx.fillStyle = '#c9ced4';
  ctx.fill();
  ctx.strokeStyle = '#6b7178';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#4a4f55';
  ctx.fill();
  const [lx, ly] = P(-0.3, hh + 0.3, 0);
  ctx.fillStyle = '#8a5a2c';
  ctx.fillRect(lx - 16, ly - 5, 22, 5);
  ctx.fillStyle = '#d9b27a';
  ctx.fillRect(lx - 14, ly - 9, 20, 3);
}

/** Small sapling drawn directly in canvas pixels at (x, y). */
function sapling(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.fillStyle = '#5e3b1f';
  ctx.fillRect(x - 0.6 * s, y - 5 * s, 1.2 * s, 5 * s);
  ctx.beginPath();
  ctx.moveTo(x - 4 * s, y - 3 * s);
  ctx.lineTo(x, y - 11 * s);
  ctx.lineTo(x + 4 * s, y - 3 * s);
  ctx.closePath();
  ctx.fillStyle = '#4f8a3a';
  ctx.fill();
}

function paintForester(ctx: Ctx): void {
  const hw = 0.75;
  const hh = 0.75;
  const H = 22;
  const logs = '#8a5a32';
  shadow(ctx, hw, hh);
  // Fenced nursery bed in front of the hut.
  poly(ctx, [[-0.95, hh + 0.1, 0], [0.2, hh + 0.1, 0], [0.2, hh + 0.5, 0], [-0.95, hh + 0.5, 0]], '#6e5233');
  walls(ctx, 0, 0, hw, hh, 0, H, logs);
  for (let z = 3; z < H; z += 4) {
    line(ctx, [-hw, hh, z], [hw, hh, z], shade(logs, 0.7), 1.5);
    line(ctx, [hw, -hh, z], [hw, hh, z], shade(logs, 0.55), 1.5);
  }
  frontQuad(ctx, hh, 0.32, 0.68, 0, 16, '#3e2716');
  sideQuad(ctx, hw, -0.35, -0.05, 10, 16, '#2a2724');
  gableRoof(ctx, hw, hh, H, 24, '#4f7a3a', logs);
  for (const dx of [-0.8, -0.45, -0.1]) {
    const [x, y] = P(dx, hh + 0.3, 0);
    sapling(ctx, x, y, 0.9);
  }
}

function paintStonecutter(ctx: Ctx): void {
  const hw = 0.78;
  const hh = 0.78;
  const H = 24;
  const stone = '#9d988c';
  shadow(ctx, hw, hh);
  walls(ctx, 0, 0, hw, hh, 0, H, stone);
  for (let z = 6; z < H; z += 6) {
    line(ctx, [-hw, hh, z], [hw, hh, z], shade(stone, 0.8));
    line(ctx, [hw, -hh, z], [hw, hh, z], shade(stone, 0.6));
  }
  for (let z = 0, row = 0; z < H; z += 6, row++) {
    for (let t = -hw + (row % 2 ? 0.12 : 0.28); t < hw; t += 0.32) {
      line(ctx, [t, hh, z], [t, hh, Math.min(z + 6, H)], shade(stone, 0.8));
      line(ctx, [hw, t, z], [hw, t, Math.min(z + 6, H)], shade(stone, 0.6));
    }
  }
  frontQuad(ctx, hh, 0.32, 0.68, 0, 16, '#4a3420');
  sideQuad(ctx, hw, -0.4, -0.12, 11, 17, '#2a2724');
  gableRoof(ctx, hw, hh, H, 22, '#6e4a33', stone);
  // Cut blocks stacked by the wall.
  const [bx, by] = P(-0.55, hh + 0.35, 0);
  stoneBlock(ctx, bx - 10, by, 9, 6, 1);
  stoneBlock(ctx, bx, by + 2, 9, 6, 0.92);
  stoneBlock(ctx, bx - 5, by - 6, 9, 6, 1.05);
}

function paintTower(ctx: Ctx): void {
  const a = 0.5;
  const H = 66;
  const stone = '#a39d90';
  shadow(ctx, 0.75, 0.75, 0.6);
  // Low wall ring around the foot of the tower.
  box(ctx, 0, 0, 0.8, 0.8, 0, 6, '#8f897d');
  walls(ctx, 0, 0, a, a, 6, H - 6, stone);
  for (let z = 12, row = 0; z < H; z += 7, row++) {
    line(ctx, [-a, a, z], [a, a, z], shade(stone, 0.82));
    line(ctx, [a, -a, z], [a, a, z], shade(stone, 0.6));
    const t = row % 2 ? -0.15 : 0.15;
    line(ctx, [t, a, z], [t, a, z + 7], shade(stone, 0.82));
    line(ctx, [a, t, z], [a, t, z + 7], shade(stone, 0.6));
  }
  frontQuad(ctx, a, 0.05, 0.4, 6, 22, '#3d2a1a');
  frontQuad(ctx, a, -0.12, 0.08, 40, 50, '#2c2724');
  sideQuad(ctx, a, -0.1, 0.1, 44, 54, '#221e1b');
  // Wooden lookout with a pointed roof and the player's banner.
  box(ctx, 0, 0, a + 0.12, a + 0.12, H, 10, '#8a5a32');
  for (const t of [-0.3, 0, 0.3]) {
    line(ctx, [t, a + 0.12, H], [t, a + 0.12, H + 10], '#5e3b1f');
    line(ctx, [a + 0.12, t, H], [a + 0.12, t, H + 10], '#4a2e18');
  }
  pyramidRoof(ctx, a + 0.2, H + 10, 34, '#9e3328');
  // The banner on the roof tip is a separate per-owner sprite (`BANNERS`).
}

/** Big tower: a broader, taller stone tower with a crenellated platform and a high roof. */
function paintBigTower(ctx: Ctx): void {
  const a = 0.62;
  const H = 82;
  const stone = '#9c968a';
  shadow(ctx, 0.85, 0.85, 0.7);
  box(ctx, 0, 0, 0.9, 0.9, 0, 8, '#8a8478');
  walls(ctx, 0, 0, a, a, 8, H - 8, stone);
  for (let z = 14, row = 0; z < H; z += 7, row++) {
    line(ctx, [-a, a, z], [a, a, z], shade(stone, 0.82));
    line(ctx, [a, -a, z], [a, a, z], shade(stone, 0.6));
    const t = row % 2 ? -0.2 : 0.2;
    line(ctx, [t, a, z], [t, a, z + 7], shade(stone, 0.82));
    line(ctx, [a, t, z], [a, t, z + 7], shade(stone, 0.6));
  }
  frontQuad(ctx, a, 0.08, 0.48, 8, 26, '#3d2a1a');
  for (const z of [38, 60]) {
    frontQuad(ctx, a, -0.3, -0.12, z, z + 9, '#2c2724');
    sideQuad(ctx, a, -0.25, -0.07, z + 3, z + 12, '#221e1b');
    sideQuad(ctx, a, 0.2, 0.38, z + 3, z + 12, '#221e1b');
  }
  // Crenellated platform.
  const p = a + 0.14;
  box(ctx, 0, 0, p, p, H, 6, shade(stone, 1.05));
  const merlon = (cx: number, cy: number) => box(ctx, cx, cy, 0.07, 0.07, H + 6, 6, stone);
  for (let t = -p + 0.07; t <= p; t += 0.27) {
    merlon(t, -p + 0.07);
    merlon(-p + 0.07, t);
  }
  pyramidRoof(ctx, a - 0.05, H + 6, 38, '#8e2e24');
  for (let t = -p + 0.07; t <= p; t += 0.27) {
    merlon(t, p - 0.07);
    merlon(p - 0.07, t);
  }
}

/** Fortress: a walled square with two corner towers and a central keep. */
function paintFortress(ctx: Ctx): void {
  const hw = 1.3;
  const hh = 1.3;
  const H = 30;
  const stone = '#a29c8f';
  shadow(ctx, hw, hh, 0.6);
  const tower = (cx: number, cy: number, h: number) => {
    walls(ctx, cx, cy, 0.32, 0.32, 0, h, '#aaa498');
    pyramidRoof2(cx, cy, 0.38, h, 24);
  };
  const pyramidRoof2 = (cx: number, cy: number, r: number, z: number, rise: number) => {
    const apex: V3 = [cx, cy, z + rise];
    poly(ctx, [[cx - r, cy - r, z], [cx - r, cy + r, z], apex], shade('#8e2e24', 0.7));
    poly(ctx, [[cx - r, cy - r, z], [cx + r, cy - r, z], apex], shade('#8e2e24', 0.85));
    poly(ctx, [[cx - r, cy + r, z], [cx + r, cy + r, z], apex], '#8e2e24');
    poly(ctx, [[cx + r, cy - r, z], [cx + r, cy + r, z], apex], shade('#8e2e24', 0.75));
  };
  // Back tower, walls, keep, front tower.
  tower(-hw + 0.25, -hh + 0.25, H + 26);
  walls(ctx, 0, 0, hw, hh, 0, H, stone);
  for (let z = 7; z < H; z += 7) {
    line(ctx, [-hw, hh, z], [hw, hh, z], shade(stone, 0.82));
    line(ctx, [hw, -hh, z], [hw, hh, z], shade(stone, 0.6));
  }
  poly(ctx, [[-hw, -hh, H], [hw, -hh, H], [hw, hh, H], [-hw, hh, H]], shade(stone, 0.9));
  const merlon = (cx: number, cy: number) => box(ctx, cx, cy, 0.08, 0.08, H, 6, stone);
  for (let t = -hw + 0.08; t <= hw; t += 0.33) {
    merlon(t, -hh + 0.08);
    merlon(-hw + 0.08, t);
  }
  box(ctx, 0, 0, 0.55, 0.55, H, 36, '#b0aa9c');
  frontQuad(ctx, 0.55, -0.12, 0.12, H + 18, H + 28, '#3a3430');
  sideQuad(ctx, 0.55, -0.12, 0.12, H + 18, H + 28, '#2c2724');
  pyramidRoof(ctx, 0.62, H + 36, 34, '#8e2e24');
  for (let t = -hw + 0.08; t <= hw; t += 0.33) {
    merlon(t, hh - 0.08);
    merlon(hw - 0.08, t);
  }
  tower(hw - 0.25, hh - 0.25, H + 18);
  // Gate in front of the door tile (dx = +1).
  frontQuad(ctx, hh, 0.74, 1.22, 0, 22, '#3d2a1a');
  frontQuad(ctx, hh, 0.78, 1.18, 0, 19, '#5a3d22');
}

/**
 * Where a building's owner banner stands, in sprite pixels from the footprint center (the roof tip).
 * The renderer places the `flag:<owner>` sprite there, so it follows conquests.
 */
export const BANNERS: Partial<Record<BuildingType, { x: number; y: number }>> = {
  castle: { x: 0, y: -130 },
  tower: { x: 0, y: -110 },
  bigtower: { x: 0, y: -126 },
  fortress: { x: 0, y: -100 },
};

function paintSite(ctx: Ctx, half: number): void {
  const hw = half - 0.05;
  const hh = half - 0.05;
  poly(ctx, [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]], '#9a7a50');
  const rng = createRng(77);
  for (let i = 0; i < 40 * half; i++) {
    const [x, y] = P((rng() * 2 - 1) * hw, (rng() * 2 - 1) * hh, 0);
    ctx.fillStyle = rng() < 0.5 ? '#86683f' : '#ab8b5f';
    ctx.fillRect(x, y, 2, 1);
  }
  const k = half - 0.25;
  const post = (dx: number, dy: number) => line(ctx, [dx, dy, 0], [dx, dy, 20], '#6b4a26', 2.5);
  post(-k, -k);
  post(k, -k);
  line(ctx, [-k, -k, 18], [k, -k, 18], '#7a5530', 2);
  post(-k, k);
  post(k, k);
  line(ctx, [k, -k, 18], [k, k, 18], '#7a5530', 2);
  line(ctx, [-k, k, 18], [k, k, 18], '#7a5530', 2);
}

// ------------------------------------------------- data-described buildings

type Deco =
  | 'chimney'
  | 'well'
  | 'nets'
  | 'pen'
  | 'sacks'
  | 'oven'
  | 'meat'
  | 'hay'
  | 'furnace'
  | 'anvil'
  | 'crates'
  | 'barrels';

/** A gabled building described by data, so new building types rarely need a hand-written painter. */
interface Style {
  hw: number;
  hh: number;
  H: number;
  wall: string;
  roof: string;
  rise: number;
  /** Door position along the front wall (tile units from the footprint center). */
  doorDx: number;
  timber?: boolean;
  /** Number of window rows. */
  floors?: number;
  deco?: Deco[];
}

function paintDeco(ctx: Ctx, st: Style, deco: Deco): void {
  const { hw, hh, H, rise } = st;
  switch (deco) {
    case 'chimney': {
      // Smoke is a live effect (see `buildingFxAnchors`).
      box(ctx, -hw * 0.45, -hh * 0.25, 0.08, 0.08, H, rise * 0.8 + 6, '#8c4a3a');
      return;
    }
    case 'well': {
      const [x, y] = P(-hw - 0.2, hh + 0.25, 0);
      ctx.fillStyle = '#8f8a80';
      ctx.fillRect(x - 7, y - 8, 14, 8);
      ctx.beginPath();
      ctx.ellipse(x, y - 8, 7, 3, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#2f6f9e';
      ctx.fill();
      ctx.strokeStyle = '#5e3b1f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 8);
      ctx.lineTo(x - 6, y - 20);
      ctx.moveTo(x + 6, y - 8);
      ctx.lineTo(x + 6, y - 20);
      ctx.stroke();
      ctx.fillStyle = '#7f3f22';
      ctx.beginPath();
      ctx.moveTo(x - 9, y - 19);
      ctx.lineTo(x, y - 25);
      ctx.lineTo(x + 9, y - 19);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'nets': {
      const a = P(hw + 0.25, -hh * 0.6, 0);
      const b = P(hw + 0.25, hh * 0.6, 0);
      ctx.strokeStyle = '#5e3b1f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(a[0], a[1] - 16);
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0], b[1] - 16);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(230,220,190,0.8)';
      ctx.lineWidth = 0.7;
      for (let t = 0; t <= 1.001; t += 0.2) {
        ctx.beginPath();
        ctx.moveTo(a[0] + (b[0] - a[0]) * t, a[1] - 15 + (b[1] - a[1]) * t);
        ctx.lineTo(a[0] + (b[0] - a[0]) * t, a[1] - 3 + (b[1] - a[1]) * t);
        ctx.stroke();
      }
      for (let k = 0; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(a[0], a[1] - 15 + k * 4);
        ctx.lineTo(b[0], b[1] - 15 + k * 4);
        ctx.stroke();
      }
      return;
    }
    case 'pen': {
      const pts: V3[] = [
        [-hw - 0.1, hh + 0.15, 0],
        [hw * 0.2, hh + 0.15, 0],
        [hw * 0.2, hh + 0.65, 0],
        [-hw - 0.1, hh + 0.65, 0],
      ];
      poly(ctx, pts, '#8a6a3c');
      const [px, py] = P(-hw * 0.45, hh + 0.4, 0);
      ctx.fillStyle = '#e8a0a0';
      ctx.beginPath();
      ctx.ellipse(px, py - 4, 6, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px + 6, py - 5, 2.5, 0, Math.PI * 2);
      ctx.fill();
      for (let k = 0; k < 4; k++) {
        const dx = -hw - 0.1 + ((hw * 0.3 + 0.1) * k) / 3;
        line(ctx, [dx, hh + 0.65, 0], [dx, hh + 0.65, 7], '#6b4a26', 1.5);
      }
      line(ctx, [-hw - 0.1, hh + 0.65, 5], [hw * 0.2, hh + 0.65, 5], '#6b4a26', 1.5);
      return;
    }
    case 'sacks': {
      const [x, y] = P(-hw * 0.3, hh + 0.3, 0);
      for (const [dx, dy] of [
        [-6, 0],
        [2, 1],
        [-2, -5],
      ]) {
        ctx.fillStyle = '#efe9da';
        ctx.beginPath();
        ctx.ellipse(x + dx, y + dy - 4, 4, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#b9ad94';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      return;
    }
    case 'oven': {
      const [x, y] = P(hw + 0.3, 0.1, 0);
      ctx.fillStyle = '#b7643e';
      ctx.beginPath();
      ctx.ellipse(x, y - 1, 12, 9, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#ffb347';
      ctx.beginPath();
      ctx.ellipse(x - 3, y - 2, 3.5, 3, 0, Math.PI, 0);
      ctx.fill();
      return;
    }
    case 'meat': {
      for (const dy of [-0.35, 0.1]) {
        const [x, y] = P(hw, dy, H * 0.55);
        ctx.fillStyle = '#b5413a';
        ctx.beginPath();
        ctx.ellipse(x + 2, y + 3, 3, 4.5, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#3b2b1a';
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(x + 2, y - 3);
        ctx.lineTo(x + 2, y - 1);
        ctx.stroke();
      }
      return;
    }
    case 'furnace': {
      // Brick stack and fire mouth; smoke and the pulsing glow are live effects.
      box(ctx, hw * 0.35, -hh * 0.35, 0.16, 0.16, H, st.rise + 14, '#8c4a3a');
      const [gx, gy] = P(hw, hh * 0.2, 6);
      ctx.fillStyle = '#5a2a14';
      ctx.fillRect(gx - 1, gy - 6, 6, 6);
      ctx.fillStyle = '#ff8a2a';
      ctx.fillRect(gx, gy - 5, 4, 4);
      return;
    }
    case 'anvil': {
      const [x, y] = P(hw + 0.3, hh * 0.3, 0);
      ctx.fillStyle = '#5e3b1f';
      ctx.fillRect(x - 3, y - 6, 6, 6);
      ctx.fillStyle = '#4a4f55';
      ctx.fillRect(x - 6, y - 9, 12, 3);
      ctx.beginPath();
      ctx.moveTo(x + 6, y - 9);
      ctx.lineTo(x + 10, y - 8);
      ctx.lineTo(x + 6, y - 6);
      ctx.closePath();
      ctx.fill();
      return;
    }
    case 'crates': {
      const crate = (dx: number, dy: number, z: number) => box(ctx, dx, dy, 0.13, 0.13, z, 9, '#a07a4a');
      crate(hw + 0.25, -hh * 0.4, 0);
      crate(hw + 0.25, -hh * 0.1, 0);
      crate(hw + 0.25, -hh * 0.25, 9);
      crate(-hw * 0.5, hh + 0.3, 0);
      const [bx, by] = P(-hw * 0.05, hh + 0.35, 0);
      ctx.fillStyle = '#7a5530';
      ctx.beginPath();
      ctx.ellipse(bx, by - 5, 4, 5.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#4a3420';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(bx - 4, by - 7);
      ctx.lineTo(bx + 4, by - 7);
      ctx.moveTo(bx - 4, by - 3);
      ctx.lineTo(bx + 4, by - 3);
      ctx.stroke();
      return;
    }
    case 'barrels': {
      for (const [dx, dy] of [
        [hw + 0.25, -hh * 0.3],
        [hw + 0.25, hh * 0.15],
      ]) {
        const [x, y] = P(dx, dy, 0);
        ctx.fillStyle = '#7a4a22';
        ctx.beginPath();
        ctx.ellipse(x, y - 6, 5, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#3b2b1a';
        ctx.lineWidth = 1;
        for (const k of [-3, 3]) {
          ctx.beginPath();
          ctx.moveTo(x - 4.6, y - 6 + k);
          ctx.lineTo(x + 4.6, y - 6 + k);
          ctx.stroke();
        }
      }
      return;
    }
    case 'hay': {
      const [x, y] = P(hw + 0.35, hh * 0.4, 0);
      ctx.fillStyle = '#d9b44a';
      ctx.beginPath();
      ctx.ellipse(x, y - 6, 10, 8, 0, Math.PI, 0);
      ctx.fillRect(x - 10, y - 6, 20, 5);
      ctx.fill();
      ctx.strokeStyle = '#b8932f';
      ctx.lineWidth = 0.8;
      for (let k = -6; k <= 6; k += 4) {
        ctx.beginPath();
        ctx.moveTo(x + k, y - 1);
        ctx.lineTo(x + k * 0.6, y - 12);
        ctx.stroke();
      }
      return;
    }
  }
}

function paintStyled(ctx: Ctx, st: Style): void {
  const { hw, hh, H, wall, doorDx } = st;
  const beam = '#5b3a1e';
  shadow(ctx, hw, hh);
  // Ground-level decorations behind the walls go first, the rest after the roof.
  for (const d of st.deco ?? []) if (d === 'pen' || d === 'hay') paintDeco(ctx, st, d);
  walls(ctx, 0, 0, hw, hh, 0, H, wall);
  if (st.timber) {
    for (let t = -hw; t <= hw + 0.001; t += hw / 2) line(ctx, [t, hh, 0], [t, hh, H], beam, 2);
    for (let t = -hh; t <= hh + 0.001; t += hh / 2) line(ctx, [hw, t, 0], [hw, t, H], shade(beam, 0.8), 2);
  }
  const floors = st.floors ?? 1;
  for (let f = 0; f < floors; f++) {
    const z0 = 8 + (f * (H - 8)) / floors;
    const z1 = z0 + 7;
    for (const dx of [-hw * 0.55, -hw * 0.1]) frontQuad(ctx, hh, dx - 0.1, dx + 0.08, z0, z1, '#34302b');
    for (const dy of [-hh * 0.45, hh * 0.25]) sideQuad(ctx, hw, dy - 0.1, dy + 0.08, z0, z1, '#2a2724');
    if (f > 0) line(ctx, [-hw, hh, z0 - 3], [hw, hh, z0 - 3], shade(wall, 0.75), 1.5);
  }
  frontQuad(ctx, hh, doorDx - 0.18, Math.min(hw - 0.04, doorDx + 0.18), 0, 15, '#4a2c14');
  gableRoof(ctx, hw, hh, H, st.rise, st.roof, wall);
  for (const d of st.deco ?? []) if (d !== 'pen' && d !== 'hay') paintDeco(ctx, st, d);
}

const STYLES: Partial<Record<BuildingType, Style>> = {
  house_small: {
    hw: 0.7,
    hh: 0.7,
    H: 22,
    wall: '#ead9b8',
    roof: '#b4472f',
    rise: 22,
    doorDx: 0.5,
    timber: true,
    deco: ['chimney'],
  },
  house_medium: {
    hw: 0.75,
    hh: 0.75,
    H: 36,
    wall: '#e4d3b0',
    roof: '#943a2a',
    rise: 24,
    doorDx: 0.5,
    timber: true,
    floors: 2,
    deco: ['chimney'],
  },
  house_large: {
    hw: 1.25,
    hh: 1.1,
    H: 36,
    wall: '#ded0b4',
    roof: '#5d6b7c',
    rise: 30,
    doorDx: 1,
    floors: 2,
    deco: ['chimney'],
  },
  waterworks: { hw: 0.6, hh: 0.6, H: 20, wall: '#a8a294', roof: '#6e4a33', rise: 20, doorDx: 0.5, deco: ['well'] },
  fisher: { hw: 0.65, hh: 0.65, H: 20, wall: '#a07a50', roof: '#c4a35a', rise: 22, doorDx: 0.5, deco: ['nets'] },
  farm: {
    hw: 1.2,
    hh: 1.0,
    H: 30,
    wall: '#9c4a32',
    roof: '#5a4030',
    rise: 34,
    doorDx: 1,
    deco: ['hay'],
  },
  bakery: {
    hw: 0.7,
    hh: 0.7,
    H: 24,
    wall: '#efe2c4',
    roof: '#a8502f',
    rise: 22,
    doorDx: 0.5,
    timber: true,
    deco: ['oven', 'chimney', 'sacks'],
  },
  pigfarm: { hw: 0.6, hh: 0.6, H: 20, wall: '#a07a50', roof: '#c4a35a', rise: 20, doorDx: 0.5, deco: ['pen'] },
  slaughterhouse: { hw: 0.7, hh: 0.7, H: 24, wall: '#c9c0ae', roof: '#7a2e24', rise: 22, doorDx: 0.5, deco: ['meat'] },
  vineyard: {
    hw: 0.6,
    hh: 0.6,
    H: 20,
    wall: '#e8dcc0',
    roof: '#a8502f',
    rise: 18,
    doorDx: 0.5,
    deco: ['barrels'],
  },
  winery: {
    hw: 0.7,
    hh: 0.7,
    H: 24,
    wall: '#cbb79a',
    roof: '#6a2f3a',
    rise: 22,
    doorDx: 0.5,
    timber: true,
    deco: ['barrels', 'chimney'],
  },
  warehouse: {
    hw: 0.65,
    hh: 0.8,
    H: 20,
    wall: '#9c7a50',
    roof: '#6e4a33',
    rise: 20,
    doorDx: 0.5,
    timber: true,
    deco: ['crates'],
  },
  ironsmelter: { hw: 0.7, hh: 0.7, H: 22, wall: '#8f7f6e', roof: '#4a4f55', rise: 18, doorDx: 0.5, deco: ['furnace'] },
  goldsmelter: { hw: 0.7, hh: 0.7, H: 22, wall: '#a89c80', roof: '#7a5a20', rise: 18, doorDx: 0.5, deco: ['furnace'] },
  weaponsmith: {
    hw: 0.7,
    hh: 0.7,
    H: 24,
    wall: '#b9a98c',
    roof: '#3f3a36',
    rise: 22,
    doorDx: 0.5,
    deco: ['furnace', 'anvil'],
  },
  toolsmith: {
    hw: 0.7,
    hh: 0.7,
    H: 24,
    wall: '#d8c8a8',
    roof: '#5a5048',
    rise: 22,
    doorDx: 0.5,
    timber: true,
    deco: ['chimney', 'anvil'],
  },
};

function paintMill(ctx: Ctx): void {
  const a = 0.55;
  const H = 52;
  const stone = '#b8b0a0';
  shadow(ctx, 0.7, 0.7, 0.5);
  walls(ctx, 0, 0, a, a, 0, H, stone);
  for (let z = 8; z < H; z += 8) {
    line(ctx, [-a, a, z], [a, a, z], shade(stone, 0.82));
    line(ctx, [a, -a, z], [a, a, z], shade(stone, 0.6));
  }
  frontQuad(ctx, a, 0.3, 0.5, 0, 15, '#4a2c14');
  frontQuad(ctx, a, -0.15, 0.05, 30, 38, '#34302b');
  pyramidRoof(ctx, a + 0.12, H, 30, '#6e4a33');
  // The sails are a separate, rotating sprite at `MILL_HUB` (see `paintMillSails`); only the hub here.
  const [hx, hy] = MILL_HUB;
  ctx.beginPath();
  ctx.arc(hx, hy, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#3b2b1a';
  ctx.fill();
  paintDeco(ctx, { hw: a, hh: a, H, wall: stone, roof: '', rise: 0, doorDx: 0.4 }, 'sacks');
}

const MILL_A = 0.55;
const MILL_H = 52;
/** Mill sail hub relative to the footprint center (building anchor), in pixels. */
export const MILL_HUB: [number, number] = P(MILL_A + 0.02, 0.1, MILL_H - 6);

/** Mill sails, 92×92 around the hub at the centre; rotated at runtime. */
export function paintMillSails(ctx: Ctx): void {
  ctx.translate(46, 46);
  for (let k = 0; k < 4; k++) {
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#6b4a26';
    ctx.fillRect(-1, 0, 2, 40);
    ctx.fillStyle = 'rgba(240,232,212,0.92)';
    ctx.fillRect(1, 10, 8, 28);
    ctx.strokeStyle = '#8a7a5c';
    ctx.lineWidth = 0.6;
    ctx.strokeRect(1, 10, 8, 28);
  }
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#3b2b1a';
  ctx.fill();
}

/** Mine entrance dug into the slope, with a cart of its ore. */
function paintMine(ctx: Ctx, ore: string): void {
  shadow(ctx, 0.85, 0.85, 0.3);
  // Rock mound.
  const rock = '#8d8576';
  ctx.fillStyle = rock;
  const [lx, ly] = P(-0.95, 0.9, 0);
  const [rx, ry] = P(0.95, -0.9, 0);
  const [tx, ty] = P(-0.3, -0.3, 34);
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.quadraticCurveTo(tx - 30, ty + 6, tx, ty);
  ctx.quadraticCurveTo(tx + 34, ty + 4, rx, ry);
  ctx.lineTo(...P(0.95, 0.9, 0));
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(rock, 1.15);
  ctx.beginPath();
  ctx.moveTo(lx + 10, ly - 6);
  ctx.quadraticCurveTo(tx - 22, ty + 8, tx, ty + 2);
  ctx.quadraticCurveTo(tx - 4, ty + 22, lx + 18, ly - 4);
  ctx.closePath();
  ctx.fill();
  // Timbered entrance on the front slope, at the door side.
  const h = 18;
  frontQuad(ctx, 0.9, 0.18, 0.72, 0, h, '#1c1814');
  line(ctx, [0.18, 0.9, 0], [0.18, 0.9, h], '#6b4a26', 3);
  line(ctx, [0.72, 0.9, 0], [0.72, 0.9, h], '#6b4a26', 3);
  line(ctx, [0.12, 0.9, h], [0.78, 0.9, h], '#6b4a26', 3.5);
  // Rails and a cart.
  line(ctx, [0.3, 0.9, 0], [0.3, 1.35, 0], '#5a5048', 1);
  line(ctx, [0.6, 0.9, 0], [0.6, 1.35, 0], '#5a5048', 1);
  const [cx, cy] = P(0.45, 1.2, 0);
  ctx.fillStyle = '#5e4a36';
  ctx.fillRect(cx - 7, cy - 9, 14, 7);
  ctx.fillStyle = ore;
  ctx.beginPath();
  ctx.ellipse(cx, cy - 9, 6.5, 3, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = '#2b2622';
  ctx.beginPath();
  ctx.arc(cx - 4, cy - 1.5, 1.8, 0, Math.PI * 2);
  ctx.arc(cx + 4, cy - 1.5, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

/** Ore colours, shared by mines, ore wares and geologist signs (index = `map.ore` code − 1). */
export const ORE_COLORS: Record<string, string> = {
  coal: '#2a2724',
  ironore: '#8e5a44',
  goldore: '#e2b93b',
  stone: '#b8b0a0',
};

/** Geologist's sign, 18×30 with the post foot at (6, 28). `ore` null = nothing found. */
export function paintSign(ctx: Ctx, ore: string | null): void {
  ctx.translate(6, 28);
  ctx.strokeStyle = '#5e3b1f';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -22);
  ctx.stroke();
  ctx.fillStyle = '#d9c39a';
  ctx.fillRect(-1, -24, 12, 9);
  ctx.strokeStyle = '#8a6a3c';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(-1, -24, 12, 9);
  if (ore) {
    ctx.beginPath();
    ctx.arc(5, -19.5, 3, 0, Math.PI * 2);
    ctx.fillStyle = ORE_COLORS[ore];
    ctx.fill();
  } else {
    ctx.strokeStyle = '#7a2e24';
    ctx.beginPath();
    ctx.moveTo(2.5, -22);
    ctx.lineTo(7.5, -17);
    ctx.moveTo(7.5, -22);
    ctx.lineTo(2.5, -17);
    ctx.stroke();
  }
}

const styled = (type: BuildingType) => (ctx: Ctx) => paintStyled(ctx, STYLES[type]!);

/** Where live building effects attach, relative to the footprint center (building anchor), in pixels. */
export interface FxAnchors {
  smoke: [number, number][];
  glow: [number, number][];
  hub: [number, number] | null;
}

const fxAnchorCache = new Map<BuildingType, FxAnchors>();

/** Chimney tops, fire mouths and the mill hub of a building's sprite (empty lists if none). */
export function buildingFxAnchors(type: BuildingType): FxAnchors {
  let a = fxAnchorCache.get(type);
  if (a) return a;
  a = { smoke: [], glow: [], hub: type === 'mill' ? MILL_HUB : null };
  const st = STYLES[type];
  for (const d of st?.deco ?? []) {
    const { hw, hh, H, rise } = st!;
    if (d === 'chimney') a.smoke.push(P(-hw * 0.45, -hh * 0.25, H + rise * 0.8 + 8));
    if (d === 'furnace') {
      a.smoke.push(P(hw * 0.35, -hh * 0.35, H + rise + 16));
      const [gx, gy] = P(hw, hh * 0.2, 6);
      a.glow.push([gx + 2, gy - 3]);
    }
    if (d === 'oven') {
      const [x, y] = P(hw + 0.3, 0.1, 0);
      a.glow.push([x - 3, y - 3]);
    }
  }
  fxAnchorCache.set(type, a);
  return a;
}

export const BUILDING_PAINTERS: Record<BuildingType | 'site2' | 'site3', (ctx: Ctx) => void> = {
  castle: paintCastle,
  house_small: styled('house_small'),
  house_medium: styled('house_medium'),
  house_large: styled('house_large'),
  woodcutter: paintWoodcutter,
  sawmill: paintSawmill,
  forester: paintForester,
  stonecutter: paintStonecutter,
  waterworks: styled('waterworks'),
  fisher: styled('fisher'),
  farm: styled('farm'),
  mill: paintMill,
  bakery: styled('bakery'),
  pigfarm: styled('pigfarm'),
  slaughterhouse: styled('slaughterhouse'),
  coalmine: (ctx) => paintMine(ctx, ORE_COLORS.coal),
  ironmine: (ctx) => paintMine(ctx, ORE_COLORS.ironore),
  goldmine: (ctx) => paintMine(ctx, ORE_COLORS.goldore),
  stonemine: (ctx) => paintMine(ctx, ORE_COLORS.stone),
  ironsmelter: styled('ironsmelter'),
  goldsmelter: styled('goldsmelter'),
  toolsmith: styled('toolsmith'),
  weaponsmith: styled('weaponsmith'),
  warehouse: styled('warehouse'),
  vineyard: styled('vineyard'),
  winery: styled('winery'),
  tower: paintTower,
  bigtower: paintBigTower,
  fortress: paintFortress,
  site2: (ctx) => paintSite(ctx, 1),
  site3: (ctx) => paintSite(ctx, 1.5),
};

// -------------------------------------------------------------------- fields

/** Vine row on one tile, same canvas as a field. Stage 1 cutting … 4 with grapes. */
export function paintVines(ctx: Ctx, stage: number): void {
  ctx.translate(33, 24);
  ctx.beginPath();
  ctx.moveTo(0, -15);
  ctx.lineTo(30, 0);
  ctx.lineTo(0, 15);
  ctx.lineTo(-30, 0);
  ctx.closePath();
  ctx.fillStyle = '#8a6a42';
  ctx.fill();
  // Two trellis rows along the tile's x axis.
  for (const row of [-0.22, 0.22]) {
    const [x0, y0] = P(-0.4, row, 0);
    const [x1, y1] = P(0.4, row, 0);
    ctx.strokeStyle = '#5e3b1f';
    ctx.lineWidth = 1;
    for (const t of [0, 0.5, 1]) {
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 10);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 8);
    ctx.lineTo(x1, y1 - 8);
    ctx.stroke();
    if (stage === 1) continue;
    const leaves = stage === 2 ? 3 : 7;
    for (let k = 0; k < leaves; k++) {
      const t = (k + 0.5) / leaves;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t - 8;
      ctx.fillStyle = stage >= 3 ? '#4f8a3a' : '#7fb04f';
      ctx.beginPath();
      ctx.arc(x, y, stage === 2 ? 1.6 : 2.6, 0, Math.PI * 2);
      ctx.fill();
      if (stage === 4 && k % 2 === 0) {
        ctx.fillStyle = '#6a2c6e';
        ctx.beginPath();
        ctx.arc(x + 1, y + 3, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

/** Grain field on one tile, 66×40 with the tile center at (33, 24). Stage 1 sown … 4 ripe. */
export function paintField(ctx: Ctx, stage: number): void {
  ctx.translate(33, 24);
  ctx.beginPath();
  ctx.moveTo(0, -15);
  ctx.lineTo(30, 0);
  ctx.lineTo(0, 15);
  ctx.lineTo(-30, 0);
  ctx.closePath();
  ctx.fillStyle = stage <= 2 ? '#8a6a42' : stage === 3 ? '#6f7d3a' : '#a08a3a';
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Furrows run along the tile's x axis.
  for (let k = -0.8; k <= 0.8; k += 0.2) {
    const [x0, y0] = P(-0.5, k * 0.5, 0);
    const [x1, y1] = P(0.5, k * 0.5, 0);
    ctx.strokeStyle = 'rgba(60,40,20,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.restore();
  if (stage === 1) return;
  const rng = createRng(31 + stage);
  const color = stage === 2 ? '#7fb04f' : stage === 3 ? '#5f9a35' : '#e2c25a';
  const height = stage === 2 ? 2 : stage === 3 ? 6 : 9;
  for (let k = 0; k < 46; k++) {
    const [x, y] = P(rng() - 0.5, rng() - 0.5, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 2, y - height);
    ctx.stroke();
    if (stage === 4) {
      ctx.fillStyle = '#f0d77a';
      ctx.fillRect(x - 1, y - height - 1, 2, 2);
    }
  }
}

// ----------------------------------------------------------------- settlers

/** Player colours (index = player id − 1): flags, borders, soldiers' tunics. */
export const PLAYER_COLORS: readonly string[] = ['#2b5fb4', '#c0392b', '#2e8b57', '#d4a017'];

// Settlers are layered sprites painted in `settlerArt.ts`.

// -------------------------------------------------------------------- goods

/** Ware, 16×10 centered at (8, 5). */
export function paintWare(ctx: Ctx, res: Resource): void {
  ctx.translate(8, 5);
  if (res === 'log') {
    ctx.fillStyle = '#7a4c25';
    ctx.fillRect(-6, -2.5, 11, 5);
    ctx.beginPath();
    ctx.ellipse(5, 0, 2, 2.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#d0a36a';
    ctx.fill();
    ctx.strokeStyle = '#5a361a';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  } else if (res === 'stone') {
    stoneBlock(ctx, -5, 4, 8, 5, 1);
  } else if (res === 'plank') {
    ctx.fillStyle = '#e2bf86';
    ctx.fillRect(-7, -2, 14, 3.5);
    ctx.fillStyle = '#b8935c';
    ctx.fillRect(-7, 1, 14, 1);
  } else {
    paintFood(ctx, res);
  }
}

function blob(ctx: Ctx, x: number, y: number, rx: number, ry: number, fill: string, stroke?: string): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
}

function paintFood(ctx: Ctx, res: Resource): void {
  switch (res) {
    case 'water':
      ctx.fillStyle = '#7a8a96';
      ctx.fillRect(-4, -3, 8, 7);
      blob(ctx, 0, -3, 4, 1.5, '#4f8fbd');
      return;
    case 'fish':
      blob(ctx, -1, 0, 5.5, 2.5, '#9fb7c6', '#5f7d8f');
      ctx.fillStyle = '#9fb7c6';
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(7.5, -3);
      ctx.lineTo(7.5, 3);
      ctx.closePath();
      ctx.fill();
      return;
    case 'grain':
      ctx.strokeStyle = '#d9b44a';
      ctx.lineWidth = 1.2;
      for (let k = -3; k <= 3; k += 1.5) {
        ctx.beginPath();
        ctx.moveTo(0, 4);
        ctx.lineTo(k, -4);
        ctx.stroke();
      }
      ctx.fillStyle = '#8a6a2c';
      ctx.fillRect(-2, 0, 4, 1.5);
      return;
    case 'flour':
      blob(ctx, 0, 0, 4.5, 4.5, '#f2ede2', '#b9ad94');
      ctx.fillStyle = '#b9ad94';
      ctx.fillRect(-1.5, -5, 3, 1.5);
      return;
    case 'bread':
      blob(ctx, 0, 0, 6, 3.5, '#b8783a', '#7a4a1e');
      ctx.strokeStyle = '#e0b07a';
      ctx.lineWidth = 0.8;
      for (const k of [-2.5, 0, 2.5]) {
        ctx.beginPath();
        ctx.moveTo(k - 1, -2);
        ctx.lineTo(k + 1, 1);
        ctx.stroke();
      }
      return;
    case 'pig':
      blob(ctx, -1, 0, 5.5, 3.5, '#e8a0a0', '#b86e6e');
      blob(ctx, 4.5, -1, 2.5, 2.2, '#e8a0a0', '#b86e6e');
      return;
    case 'meat':
      blob(ctx, -1, 0, 5, 3.5, '#b5413a', '#7a221c');
      ctx.fillStyle = '#efe6d2';
      ctx.fillRect(3, -1, 4, 2);
      return;
    case 'coal':
    case 'ironore':
    case 'goldore':
      for (const [x, y, r] of [
        [-3, 1, 3],
        [2, 1.5, 2.8],
        [-0.5, -1.8, 2.6],
      ]) {
        blob(ctx, x, y, r, r * 0.85, ORE_COLORS[res], shade(ORE_COLORS[res], 0.6));
        blob(ctx, x - r * 0.35, y - r * 0.35, r * 0.3, r * 0.25, 'rgba(255,255,255,0.35)');
      }
      return;
    case 'grapes':
      for (const [x, y] of [
        [-2, -2],
        [1, -2],
        [-0.5, 0.5],
        [2.5, 0.5],
        [1, 3],
      ]) {
        blob(ctx, x, y, 1.9, 1.9, '#6a2c6e', '#3f1840');
      }
      ctx.fillStyle = '#4f8a3a';
      ctx.fillRect(-1, -5, 3, 1.5);
      return;
    case 'wine':
      ctx.fillStyle = '#5a1e2a';
      ctx.beginPath();
      ctx.ellipse(0, 1, 3.5, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-1.2, -5, 2.4, 4);
      ctx.fillStyle = '#d9c39a';
      ctx.fillRect(-1.4, -6, 2.8, 1.5);
      return;
    case 'iron':
    case 'gold': {
      const c = res === 'iron' ? '#9aa0a6' : '#e2b93b';
      ctx.fillStyle = shade(c, 0.75);
      ctx.beginPath();
      ctx.moveTo(-7, 3);
      ctx.lineTo(7, 3);
      ctx.lineTo(5, -2);
      ctx.lineTo(-5, -2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = shade(c, 1.15);
      ctx.fillRect(-5, -3, 10, 1.5);
      return;
    }
    default:
      paintTool(ctx, res);
  }
}

/** Tool wares: drawn in the 16×10 ware box around the origin. */
function paintTool(ctx: Ctx, res: Resource): void {
  const wood = '#8a5a2c';
  const steel = '#9aa0a6';
  ctx.lineCap = 'round';
  const handle = (x0: number, y0: number, x1: number, y1: number) => {
    ctx.strokeStyle = wood;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  ctx.fillStyle = steel;
  ctx.strokeStyle = steel;
  switch (res) {
    case 'axe':
      handle(-6, 4, 5, -3);
      ctx.fillStyle = steel;
      ctx.beginPath();
      ctx.moveTo(3, -4);
      ctx.lineTo(7, -5);
      ctx.lineTo(7, 1);
      ctx.lineTo(4, -1);
      ctx.closePath();
      ctx.fill();
      return;
    case 'saw':
      ctx.fillRect(-7, -2, 11, 3);
      for (let x = -7; x < 4; x += 2) {
        ctx.beginPath();
        ctx.moveTo(x, 1);
        ctx.lineTo(x + 1, 3);
        ctx.lineTo(x + 2, 1);
        ctx.fill();
      }
      ctx.fillStyle = wood;
      ctx.fillRect(4, -3, 3, 5);
      return;
    case 'pickaxe':
      handle(-1, 5, 1, -2);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-7, 0);
      ctx.quadraticCurveTo(1, -6, 8, 0);
      ctx.stroke();
      return;
    case 'shovel':
      handle(-7, 2, 3, 0);
      ctx.beginPath();
      ctx.ellipse(5.5, -0.5, 3, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'scythe':
      handle(-6, 5, 2, -4);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(2, -4);
      ctx.quadraticCurveTo(8, -3, 7, 3);
      ctx.stroke();
      return;
    case 'rod':
      handle(-7, 4, 6, -4);
      ctx.strokeStyle = '#d9d2c0';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(6, -4);
      ctx.lineTo(6, 3);
      ctx.stroke();
      return;
    case 'hammer':
      handle(-6, 4, 3, -2);
      ctx.fillRect(1, -5, 6, 4);
      return;
    case 'bow':
      ctx.strokeStyle = '#7a4a22';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(-2, 0, 6.5, -Math.PI / 2.6, Math.PI / 2.6);
      ctx.stroke();
      ctx.strokeStyle = '#e8e2d0';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(0.6, -5.7);
      ctx.lineTo(0.6, 5.7);
      ctx.stroke();
      return;
    case 'sword':
      ctx.strokeStyle = '#d6dadf';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-6, 4);
      ctx.lineTo(6, -4);
      ctx.stroke();
      handle(-7, 5, -5, 3);
      ctx.fillStyle = '#8a6a2c';
      ctx.fillRect(-6, 1, 3, 3);
      return;
  }
}

/** Rank badge above a fighter's head: `level` gold chevrons, 12×10 centred at (6, 5). */
export function paintChevrons(ctx: Ctx, level: number): void {
  ctx.translate(6, 5);
  ctx.strokeStyle = '#3b2b1a';
  ctx.fillStyle = '#f2c94c';
  for (let k = 0; k < level; k++) {
    const y = 2 - k * 3.5;
    ctx.beginPath();
    ctx.moveTo(-5, y);
    ctx.lineTo(0, y - 3);
    ctx.lineTo(5, y);
    ctx.lineTo(5, y + 1.6);
    ctx.lineTo(0, y - 1.4);
    ctx.lineTo(-5, y + 1.6);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
}

/** Flag on a pole marking a door, 14×28 with the pole base at (2, 26), in the owner's colour. */
export function paintFlag(ctx: Ctx, color = PLAYER_COLORS[0]): void {
  ctx.translate(2, 26);
  ctx.strokeStyle = '#4a3420';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -24);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(10, -21);
  ctx.lineTo(0, -17);
  ctx.closePath();
  ctx.fill();
}
