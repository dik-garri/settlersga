import { CanvasSource, Texture } from 'pixi.js';
import { PLAYER_COLORS } from './sprites';

/**
 * Small pictures the renderer used to draw with `Graphics` for every chunk it built — the territory
 * dimming, the border posts and the pebbles along narrow water — painted once into one sheet, so a
 * chunk's overlays are a textured mesh of quads (`QuadBuffer`) instead of paths Pixi triangulates on
 * first render. On a fast flight over a 1024×1024 map that triangulation was most of the garbage
 * made per frame (heaps of number arrays and batches promoted before the next major collection).
 */

/** A picture in the sheet: its box in world pixels round its anchor and its texture coordinates. */
export interface OverlayFrame {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Top left, top right, bottom right, bottom left (u, v): a quad's corners in `overlayQuad`'s order. */
  uv: Float32Array;
}

/** Pixels of the sheet per world pixel. */
const RES = 4;
/** Grey tones of a pebble (`0x8a8f94` ± k steps of `0x0d0d0d`, as the old `streamBanks`). */
export const PEBBLE_TONES = 5;
/** A pebble of radius 1 at its anchor (the body's centre); its shadow falls down-right. */
const PEBBLE_BOX = { x0: -1.5, y0: -1.0, x1: 2.0, y1: 1.6 };
/** A border post at its foot: the shadow, the post and the cube on top (the old `drawBorder`). */
const POST_BOX = { x0: -4, y0: -9.5, x1: 5.5, y1: 2.5 };
/** The pebble sheet is drawn at this many pixels per world pixel of a radius-1 pebble. */
const PEBBLE_RES = 12;

let sheet: { texture: Texture; dim: OverlayFrame; pebbles: OverlayFrame[]; posts: OverlayFrame[] } | null = null;

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

function shade(color: string, k: number): string {
  const c = parseInt(color.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return hex((ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255));
}

/** The sheet, painted on first use. */
export function overlaySheet(): { texture: Texture; dim: OverlayFrame; pebbles: OverlayFrame[]; posts: OverlayFrame[] } {
  if (sheet) return sheet;
  const pw = Math.ceil((PEBBLE_BOX.x1 - PEBBLE_BOX.x0) * PEBBLE_RES) + 2;
  const ph = Math.ceil((PEBBLE_BOX.y1 - PEBBLE_BOX.y0) * PEBBLE_RES) + 2;
  const qw = Math.ceil((POST_BOX.x1 - POST_BOX.x0) * RES) + 2;
  const qh = Math.ceil((POST_BOX.y1 - POST_BOX.y0) * RES) + 2;
  const W = 6 + PEBBLE_TONES * pw + PLAYER_COLORS.length * qw;
  const H = Math.max(ph, qh, 6);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const frame = (px: number, py: number, w: number, h: number, box: typeof PEBBLE_BOX): OverlayFrame => {
    const [u0, v0, u1, v1] = [px / W, py / H, (px + w) / W, (py + h) / H];
    return { ...box, uv: Float32Array.of(u0, v0, u1, v0, u1, v1, u0, v1) };
  };

  // The territory dimming: a 6×6 block of one colour, sampled at its centre.
  ctx.fillStyle = 'rgba(11, 20, 32, 0.3)';
  ctx.fillRect(0, 0, 6, 6);
  const dim: OverlayFrame = { x0: 0, y0: 0, x1: 0, y1: 0, uv: new Float32Array(8) };
  for (let k = 0; k < 8; k += 2) dim.uv.set([3 / W, 3 / H], k);

  const ellipse = (cx: number, cy: number, rx: number, ry: number, fill: string) => {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  };

  // Pebbles: the old shadow offset (0.6, 0.8 px) is for a pebble of the mean radius 1.35.
  const pebbles: OverlayFrame[] = [];
  for (let k = 0; k < PEBBLE_TONES; k++) {
    const left = 6 + k * pw + 1;
    const ox = left - PEBBLE_BOX.x0 * PEBBLE_RES;
    const oy = 1 - PEBBLE_BOX.y0 * PEBBLE_RES;
    const s = PEBBLE_RES;
    const grey = 0x8a8f94 + (k - 2) * 0x0d0d0d;
    ellipse(ox + (0.6 / 1.35) * s, oy + (0.8 / 1.35) * s, 1.2 * s, 0.7 * s, 'rgba(32, 38, 42, 0.45)');
    ellipse(ox, oy, 1.2 * s, 0.75 * s, hex(grey));
    ellipse(ox - 0.35 * s, oy - 0.25 * s, 0.45 * s, 0.25 * s, 'rgba(232, 236, 239, 0.7)');
    pebbles.push(frame(left, 1, pw - 2, ph - 2, PEBBLE_BOX));
  }

  // Border posts, one per player colour.
  const posts: OverlayFrame[] = [];
  for (let k = 0; k < PLAYER_COLORS.length; k++) {
    const left = 6 + PEBBLE_TONES * pw + k * qw + 1;
    ctx.save();
    ctx.translate(left - POST_BOX.x0 * RES, 1 - POST_BOX.y0 * RES);
    ctx.scale(RES, RES);
    ellipse(2, 0.8, 3, 1.4, 'rgba(0, 0, 0, 0.35)');
    ctx.fillStyle = '#2a2620';
    ctx.fillRect(-0.9, -6, 1.8, 6);
    const color = PLAYER_COLORS[k];
    const s = 2.6;
    const top = -7.5;
    const poly = (pts: number[], fill: string) => {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    poly([0, top - s * 0.5, s, top, 0, top + s * 0.5, -s, top], shade(color, 1.25));
    poly([-s, top, 0, top + s * 0.5, 0, top + s * 0.5 + s, -s, top + s], color);
    poly([0, top + s * 0.5, s, top, s, top + s, 0, top + s * 0.5 + s], shade(color, 0.65));
    ctx.restore();
    posts.push(frame(left, 1, qw - 2, qh - 2, POST_BOX));
  }

  const texture = new Texture({ source: new CanvasSource({ resource: canvas, scaleMode: 'linear' }) });
  sheet = { texture, dim, pebbles, posts };
  return sheet;
}
