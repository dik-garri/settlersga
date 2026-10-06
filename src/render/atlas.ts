import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import { ORE_RESOURCES, oreOf, PROFESSIONS } from '../sim/config';
import { RESOURCES, type BuildingType, type Resource, type SettlerKind } from '../sim/types';
import {
  BUILDING_CANVAS,
  BUILDING_PAINTERS,
  groundVariants,
  paintBoulder,
  paintDeposit,
  paintField,
  paintVines,
  paintSign,
  paintFlag,
  paintGround,
  paintSettler,
  paintTree,
  paintWare,
  PLAYER_COLORS,
  type GroundKind,
  type SettlerFrame,
} from './sprites';

const RESOLUTION = 2;
const SIZE = 1024;
const PAD = 2;

interface Page {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

/**
 * Packs procedurally painted sprites into canvas pages (shelf packing). A new page starts when one
 * fills up, so content can grow freely; the GPU batches up to 16 textures per draw call.
 */
class AtlasBuilder {
  private readonly pages: Page[] = [];
  private readonly frames = new Map<string, { page: number; frame: Rectangle; ax: number; ay: number }>();
  private x = PAD;
  private y = PAD;
  private rowH = 0;

  constructor() {
    this.newPage();
  }

  private newPage(): void {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE * RESOLUTION;
    canvas.height = SIZE * RESOLUTION;
    this.pages.push({ canvas, ctx: canvas.getContext('2d')! });
    this.x = PAD;
    this.y = PAD;
    this.rowH = 0;
  }

  /** Paints a w×h sprite; (ax, ay) is the anchor point in sprite pixels. */
  add(name: string, w: number, h: number, ax: number, ay: number, paint: (ctx: CanvasRenderingContext2D) => void) {
    if (w + 2 * PAD > SIZE || h + 2 * PAD > SIZE) throw new Error(`sprite ${name} is larger than an atlas page`);
    if (this.x + w + PAD > SIZE) {
      this.x = PAD;
      this.y += this.rowH + PAD;
      this.rowH = 0;
    }
    if (this.y + h + PAD > SIZE) this.newPage();
    const { ctx } = this.pages[this.pages.length - 1];
    ctx.save();
    ctx.scale(RESOLUTION, RESOLUTION);
    ctx.translate(this.x, this.y);
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    paint(ctx);
    ctx.restore();
    this.frames.set(name, {
      page: this.pages.length - 1,
      frame: new Rectangle(this.x, this.y, w, h),
      ax: ax / w,
      ay: ay / h,
    });
    this.x += w + PAD;
    this.rowH = Math.max(this.rowH, h);
  }

  build(): Map<string, Texture> {
    const sources = this.pages.map((p) => new CanvasSource({ resource: p.canvas, resolution: RESOLUTION }));
    const out = new Map<string, Texture>();
    for (const [name, { page, frame, ax, ay }] of this.frames) {
      out.set(name, new Texture({ source: sources[page], frame, defaultAnchor: { x: ax, y: ay } }));
    }
    return out;
  }
}

export class SpriteAtlas {
  private readonly textures: Map<string, Texture>;
  private readonly cropped = new Map<string, Texture>();

  constructor() {
    const a = new AtlasBuilder();
    for (const kind of ['grass', 'sand', 'water', 'rock', 'mountain'] as GroundKind[]) {
      for (let v = 0; v < groundVariants(kind); v++) {
        a.add(`ground:${kind}:${v}`, 66, 34, 33, 17, (ctx) => paintGround(ctx, kind, v));
      }
    }
    for (let v = 0; v < 4; v++) a.add(`tree:${v}`, 48, 80, 24, 72, (ctx) => paintTree(ctx, v));
    for (let v = 0; v < 2; v++) a.add(`boulder:${v}`, 52, 40, 26, 30, (ctx) => paintBoulder(ctx, v));
    for (let code = 0; code <= ORE_RESOURCES.length; code++) {
      a.add(`sign:${code}`, 18, 30, 6, 28, (ctx) => paintSign(ctx, oreOf(code)));
    }
    for (let v = 1; v <= 4; v++) {
      a.add(`field:grain:${v}`, 66, 40, 33, 24, (ctx) => paintField(ctx, v));
      a.add(`field:vine:${v}`, 66, 40, 33, 24, (ctx) => paintVines(ctx, v));
    }
    for (let v = 0; v < 3; v++) a.add(`deposit:${v}`, 56, 44, 28, 34, (ctx) => paintDeposit(ctx, v));
    for (const [type, c] of Object.entries(BUILDING_CANVAS)) {
      a.add(`building:${type}`, c.w, c.h, c.ax, c.ay, (ctx) => {
        ctx.translate(c.ax, c.ay);
        BUILDING_PAINTERS[type as keyof typeof BUILDING_PAINTERS](ctx);
      });
    }
    for (const kind of Object.keys(PROFESSIONS) as SettlerKind[]) {
      for (const frame of ['stand', 'walk', 'work'] as SettlerFrame[]) {
        a.add(`settler:${kind}:${frame}`, 20, 32, 10, 29, (ctx) => paintSettler(ctx, kind, frame));
      }
    }
    for (const res of RESOURCES) a.add(`ware:${res}`, 16, 10, 8, 5, (ctx) => paintWare(ctx, res));
    // Per-player variants: door flags and soldiers in the owner's colour.
    PLAYER_COLORS.forEach((color, k) => {
      a.add(`flag:${k + 1}`, 14, 28, 2, 26, (ctx) => paintFlag(ctx, color));
      for (const frame of ['stand', 'walk', 'work'] as SettlerFrame[]) {
        a.add(`settler:soldier:${frame}:${k + 1}`, 20, 32, 10, 29, (ctx) => paintSettler(ctx, 'soldier', frame, color));
      }
    });
    this.textures = a.build();
  }

  get(name: string): Texture {
    const t = this.textures.get(name);
    if (!t) throw new Error(`unknown sprite ${name}`);
    return t;
  }

  /** The texture with its top cut off so only the bottom `fraction` shows; anchor keeps the base fixed. */
  bottomPart(name: string, fraction: number): Texture {
    const steps = 20;
    const step = Math.max(1, Math.round(fraction * steps));
    const key = `${name}@${step}`;
    let t = this.cropped.get(key);
    if (!t) {
      const full = this.get(name);
      const f = full.frame;
      const keep = Math.max(1, Math.round((f.height * step) / steps));
      const cut = f.height - keep;
      const anchorPx = full.defaultAnchor!.y * f.height;
      t = new Texture({
        source: full.source,
        frame: new Rectangle(f.x, f.y + cut, f.width, keep),
        defaultAnchor: { x: full.defaultAnchor!.x, y: (anchorPx - cut) / keep },
      });
      this.cropped.set(key, t);
    }
    return t;
  }
}

/** Standalone ware icon for HTML UI, drawn by the same painter as goods on the map. */
export function wareIcon(res: Resource, size = 18): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.className = 'ware-icon';
  const ctx = canvas.getContext('2d')!;
  const scale = size / 16;
  ctx.scale(dpr * scale, dpr * scale);
  ctx.translate(0, 3);
  paintWare(ctx, res);
  return canvas;
}

/** Standalone settler portrait for HTML UI. */
export function settlerIcon(kind: SettlerKind, size = 56): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d')!;
  const scale = (size / 32) * 0.95;
  ctx.scale(dpr * scale, dpr * scale);
  ctx.translate((size / scale - 20) / 2, 1);
  paintSettler(ctx, kind, 'work');
  return canvas;
}

/** Standalone icon canvas for HTML UI. */
export function buildingIcon(type: BuildingType, size = 56): HTMLCanvasElement {
  const c = BUILDING_CANVAS[type];
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d')!;
  const scale = size / Math.max(c.w, c.h);
  ctx.scale(dpr, dpr);
  // Painters draw around the footprint center; shift so the whole sprite fits.
  ctx.translate(size / 2, (c.ay / c.h) * size);
  ctx.scale(scale, scale);
  BUILDING_PAINTERS[type](ctx);
  return canvas;
}
