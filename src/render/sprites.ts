/**
 * Procedural sprite painters. Everything is drawn with Canvas 2D at startup;
 * see atlas.ts for packing into a single texture.
 */
import type { BuildingType, Resource, SettlerKind } from '../sim/types';
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

export type GroundKind = 'grass' | 'sand' | 'water' | 'rock';

const GROUND_COLORS: Record<GroundKind, { base: string[]; dots: string[] }> = {
  grass: { base: ['#6a9a3c', '#6f9f40', '#64933a', '#73a145'], dots: ['#7fb04f', '#5a8733', '#88b85a'] },
  sand: { base: ['#d8c48a', '#d2bd82'], dots: ['#c7b077', '#e4d39d'] },
  water: { base: ['#2f6f9e', '#2c6995'], dots: ['#4f8fbd', '#3b7cab'] },
  rock: { base: ['#8a8378', '#837c71'], dots: ['#9b958b', '#6f695f'] },
};

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
  if (kind === 'water') {
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

export const BUILDING_CANVAS: Record<BuildingType | 'site', BuildingCanvas> = {
  castle: { w: 220, h: 250, ax: 110, ay: 190 },
  woodcutter: { w: 150, h: 140, ax: 75, ay: 100 },
  sawmill: { w: 150, h: 140, ax: 75, ay: 100 },
  forester: { w: 150, h: 140, ax: 75, ay: 100 },
  site: { w: 150, h: 90, ax: 75, ay: 50 },
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
  const [fx, fy] = P(0, 0, H + 88);
  ctx.strokeStyle = '#3b2b1a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(fx, fy - 18);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(fx, fy - 18);
  ctx.lineTo(fx + 14, fy - 14);
  ctx.lineTo(fx, fy - 10);
  ctx.closePath();
  ctx.fillStyle = '#2b5fb4';
  ctx.fill();
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

function paintSite(ctx: Ctx): void {
  const hw = 0.95;
  const hh = 0.95;
  poly(ctx, [[-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0], [-hw, hh, 0]], '#9a7a50');
  const rng = createRng(77);
  for (let i = 0; i < 40; i++) {
    const [x, y] = P(rng() * 1.8 - 0.9, rng() * 1.8 - 0.9, 0);
    ctx.fillStyle = rng() < 0.5 ? '#86683f' : '#ab8b5f';
    ctx.fillRect(x, y, 2, 1);
  }
  const post = (dx: number, dy: number) => {
    line(ctx, [dx, dy, 0], [dx, dy, 20], '#6b4a26', 2.5);
  };
  post(-0.75, -0.75);
  post(0.75, -0.75);
  line(ctx, [-0.75, -0.75, 18], [0.75, -0.75, 18], '#7a5530', 2);
  post(-0.75, 0.75);
  post(0.75, 0.75);
  line(ctx, [0.75, -0.75, 18], [0.75, 0.75, 18], '#7a5530', 2);
  line(ctx, [-0.75, 0.75, 18], [0.75, 0.75, 18], '#7a5530', 2);
}

export const BUILDING_PAINTERS: Record<BuildingType | 'site', (ctx: Ctx) => void> = {
  castle: paintCastle,
  woodcutter: paintWoodcutter,
  sawmill: paintSawmill,
  forester: paintForester,
  site: paintSite,
};

// ----------------------------------------------------------------- settlers

export type SettlerFrame = 'stand' | 'walk' | 'work';

const SETTLER_LOOK: Record<SettlerKind, { tunic: string; hat: string; tool?: 'axe' | 'hammer' | 'shovel' }> = {
  carrier: { tunic: '#3f6fb5', hat: '#6b4423' },
  builder: { tunic: '#d08a2c', hat: '#c23b2b', tool: 'hammer' },
  woodcutter: { tunic: '#3d7d3a', hat: '#2e4d22', tool: 'axe' },
  sawmiller: { tunic: '#8b5a2b', hat: '#d9c9a3' },
  forester: { tunic: '#7a9a3a', hat: '#5a4020', tool: 'shovel' },
};

/** Settler, 20×32 with the feet at (10, 29). */
export function paintSettler(ctx: Ctx, kind: SettlerKind, frame: SettlerFrame): void {
  const look = SETTLER_LOOK[kind];
  ctx.translate(10, 29);
  ctx.beginPath();
  ctx.ellipse(1, 0, 6, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fill();
  // Legs.
  ctx.fillStyle = '#3b3128';
  if (frame === 'walk') {
    ctx.fillRect(-4, -8, 2.5, 8);
    ctx.fillRect(1.5, -8, 2.5, 7);
  } else {
    ctx.fillRect(-2.5, -8, 2.2, 8);
    ctx.fillRect(0.5, -8, 2.2, 8);
  }
  // Tunic.
  ctx.fillStyle = look.tunic;
  ctx.beginPath();
  ctx.moveTo(-4.5, -8);
  ctx.lineTo(4.5, -8);
  ctx.lineTo(3.5, -17);
  ctx.lineTo(-3.5, -17);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shade(look.tunic, 0.75);
  ctx.fillRect(-4.3, -10, 8.6, 1.5);
  // Arms and tool.
  ctx.fillStyle = '#e9b98f';
  if (frame === 'work') {
    ctx.fillRect(3, -22, 2, 7);
    if (look.tool) {
      ctx.fillStyle = '#6b4a26';
      ctx.fillRect(3.5, -27, 1.5, 7);
      ctx.fillStyle = '#9aa0a6';
      if (look.tool === 'axe') ctx.fillRect(4.5, -27, 4, 3);
      else if (look.tool === 'shovel') ctx.fillRect(2.5, -31, 3.5, 4.5);
      else ctx.fillRect(2, -28, 5, 2.5);
    }
  } else {
    ctx.fillRect(3.3, -16, 1.8, 6);
    ctx.fillRect(-5.1, -16, 1.8, 6);
  }
  // Head and hat.
  ctx.beginPath();
  ctx.arc(0, -20, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = '#efc49c';
  ctx.fill();
  ctx.fillStyle = look.hat;
  ctx.beginPath();
  ctx.arc(0, -21, 3.6, Math.PI, 0);
  ctx.fill();
  ctx.fillRect(-4.5, -21.5, 9, 1.4);
}

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
  } else {
    ctx.fillStyle = '#e2bf86';
    ctx.fillRect(-7, -2, 14, 3.5);
    ctx.fillStyle = '#b8935c';
    ctx.fillRect(-7, 1, 14, 1);
  }
}

/** Flag on a pole marking a door, 14×28 with the pole base at (2, 26). */
export function paintFlag(ctx: Ctx): void {
  ctx.translate(2, 26);
  ctx.strokeStyle = '#4a3420';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -24);
  ctx.stroke();
  ctx.fillStyle = '#2b5fb4';
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(10, -21);
  ctx.lineTo(0, -17);
  ctx.closePath();
  ctx.fill();
}
