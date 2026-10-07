import { CanvasSource, Rectangle, Texture } from 'pixi.js';
import { ORE_RESOURCES, oreOf, SOLDIER_LEVELS } from '../sim/config';
import { RESOURCES, type BuildingType, type Resource, type SettlerKind } from '../sim/types';
import {
  BUILDING_CANVAS,
  BUILDING_PAINTERS,
  groundVariants,
  paintBoulder,
  paintDeposit,
  paintChevrons,
  paintField,
  paintSign,
  paintFlag,
  paintBanner,
  paintGround,
  paintGroundEdge,
  EDGE_DIRS,
  GROUND_PRIORITY,
  paintMillSails,
  paintTree,
  paintWare,
  PLAYER_COLORS,
  type GroundKind,
} from './sprites';
import { DIRS, WALK_FRAMES, WORK_FRAMES } from './anim';
import { ART3D_BUILDINGS, ART3D_PILES, ART3D_STAGED, ART3D_STAGES, ART3D_SPRITES, PILE_MAX, type Art3d } from './art3d';
import { ACTION_IDS, ACTIONS, HAT_STYLES, styleOf, TOOLS, type ActionId, type HatStyle, type ToolShape } from './animConfig';
import { paintFlash, paintGlint, paintGlow, paintPuff, paintSpark } from './fxArt';
import {
  actionPose,
  BODY_FRAMES,
  holdPose,
  paintArm,
  paintBody,
  paintHat,
  paintHead,
  paintSettlerPortrait,
  paintTunic,
  SETTLER_AX,
  SETTLER_AY,
  SETTLER_H,
  SETTLER_W,
} from './settlerArt';

/** Painted settler directions (see `anim.ts`). */
const PAINTED_DIRS = 5;

/** Typed lookups of the settler layer textures, so per-frame updates build no strings. */
export interface SettlerTextures {
  /** [paintedDir][bodyFrame]: walk frames, stand, work stance. */
  body: Texture[][];
  tunic: Texture[];
  head: Texture[];
  hat: Record<HatStyle, Texture[]>;
  /** [tool][paintedDir][frame]: walk frames 0..3, then standing. */
  holdArm: Record<ToolShape, Texture[][]>;
  /** [action][paintedDir][workFrame]. */
  workArm: Record<ActionId, Texture[][]>;
}

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

  /** Registers `name` as another name for the already painted sprite `of`. */
  alias(name: string, of: string): void {
    const f = this.frames.get(of);
    if (!f) throw new Error(`alias ${name}: no sprite ${of}`);
    this.frames.set(name, f);
  }

  build(): Map<string, Texture> {
    // The last page is cut down to the rows it uses, so a spill-over page costs only what it holds.
    const last = this.pages[this.pages.length - 1];
    const used = Math.min(SIZE, this.y + this.rowH + PAD);
    if (used < SIZE) {
      const canvas = document.createElement('canvas');
      canvas.width = SIZE * RESOLUTION;
      canvas.height = Math.ceil(used * RESOLUTION);
      canvas.getContext('2d')!.drawImage(last.canvas, 0, 0);
      last.canvas = canvas;
    }
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

  /** Pre-rendered 3D sprites replacing some procedural ones (`?art=3d`, see `art3d.ts`). */
  readonly art3d: Art3d | null;
  /** Ground kinds drawn from a seamless texture: tile (x, y) uses variant (x mod p) + p·(y mod p). */
  readonly groundPeriod: Partial<Record<GroundKind, number>> = {};

  constructor(art3d: Art3d | null = null) {
    this.art3d = art3d;
    iconArt = art3d;
    const a = new AtlasBuilder();
    // Textured ground (`?art=3d`): seamless diamonds cut from one periodic texture per kind.
    const textured = (kind: GroundKind) => (art3d?.ground.kinds.includes(kind) ? art3d.images.get(`ground-${kind}`)! : null);
    for (const kind of GROUND_PRIORITY) {
      const sheet = textured(kind);
      if (sheet) {
        const p = art3d!.ground.period;
        this.groundPeriod[kind] = p;
        for (let v = 0; v < p * p; v++) a.add(`ground:${kind}:${v}`, 66, 34, 33, 17, (ctx) => drawFrame(ctx, sheet, v, 66, 34));
        continue;
      }
      for (let v = 0; v < groundVariants(kind); v++) {
        a.add(`ground:${kind}:${v}`, 66, 34, 33, 17, (ctx) => paintGround(ctx, kind, v));
      }
    }
    // Transition overlays sit on the same page as the ground (the ground mesh uses one texture).
    for (const kind of GROUND_PRIORITY) {
      const sheet = textured(kind);
      for (let dir = 0; dir < EDGE_DIRS.length; dir++) {
        a.add(`edge:${kind}:${dir}`, 66, 34, 33, 17, (ctx) => {
          ctx.save();
          paintGroundEdge(ctx, kind, dir);
          ctx.restore();
          if (!sheet) return;
          // Keep the procedural ragged mask, take the colour from the texture.
          ctx.globalCompositeOperation = 'source-atop';
          drawFrame(ctx, sheet, 0, 66, 34);
        });
      }
    }
    for (let v = 0; v < 4; v++) a.add(`tree:${v}`, 48, 80, 24, 72, (ctx) => paintTree(ctx, v));
    for (let v = 0; v < 2; v++) a.add(`boulder:${v}`, 52, 40, 26, 30, (ctx) => paintBoulder(ctx, v));
    for (let code = 0; code <= ORE_RESOURCES.length; code++) {
      a.add(`sign:${code}`, 18, 30, 6, 28, (ctx) => paintSign(ctx, oreOf(code)));
    }
    for (let v = 1; v <= 4; v++) {
      a.add(`field:grain:${v}`, 66, 40, 33, 24, (ctx) => paintField(ctx, v));
    }
    for (let v = 0; v < 3; v++) a.add(`deposit:${v}`, 56, 44, 28, 34, (ctx) => paintDeposit(ctx, v));
    for (const [type, c] of Object.entries(BUILDING_CANVAS)) {
      a.add(`building:${type}`, c.w, c.h, c.ax, c.ay, (ctx) => {
        ctx.translate(c.ax, c.ay);
        BUILDING_PAINTERS[type as keyof typeof BUILDING_PAINTERS](ctx);
      });
    }
    // Settler layers: shared by every profession and player (tunic and hat are tinted at runtime).
    const S = (name: string, paint: (ctx: CanvasRenderingContext2D) => void) =>
      a.add(name, SETTLER_W, SETTLER_H, SETTLER_AX, SETTLER_AY, paint);
    // Arm poses repeat across tools' walk frames and actions; each distinct pose is painted once.
    const arms = new Map<string, string>();
    const arm = (name: string, pd: number, turns: number, tool: ToolShape, pull: number) => {
      const key = `${tool}:${pd}:${turns}:${pull}`;
      const same = arms.get(key);
      if (same) return a.alias(name, same);
      arms.set(key, name);
      S(name, (ctx) => paintArm(ctx, pd, turns, tool, pull));
    };
    for (let pd = 0; pd < PAINTED_DIRS; pd++) {
      for (let f = 0; f < BODY_FRAMES; f++) S(`sb:${pd}:${f}`, (ctx) => paintBody(ctx, pd, f));
      S(`st:${pd}`, (ctx) => paintTunic(ctx, pd));
      S(`shd:${pd}`, (ctx) => paintHead(ctx, pd));
      for (const style of HAT_STYLES) S(`sht:${style}:${pd}`, (ctx) => paintHat(ctx, pd, style));
      for (const tool of TOOLS) {
        for (let f = 0; f <= WALK_FRAMES; f++) arm(`sa:hold:${tool}:${pd}:${f}`, pd, holdPose(tool, f), tool, 0);
      }
      for (const action of ACTION_IDS) {
        for (let f = 0; f < WORK_FRAMES; f++) {
          const pose = actionPose(action, f);
          arm(`sa:work:${action}:${pd}:${f}`, pd, pose.arm, ACTIONS[action].tool, pose.pull);
        }
      }
    }
    // Live effects.
    a.add('fx:puff', 32, 32, 16, 16, paintPuff);
    a.add('fx:spark', 8, 8, 4, 4, paintSpark);
    a.add('fx:glow', 48, 48, 24, 24, paintGlow);
    a.add('fx:glint', 16, 6, 8, 3, paintGlint);
    a.add('fx:flash', 16, 16, 8, 8, paintFlash);
    a.add('fx:sails', 92, 92, 46, 46, paintMillSails);
    for (const res of RESOURCES) a.add(`ware:${res}`, 16, 10, 8, 5, (ctx) => paintWare(ctx, res));
    // Per-player door flags (fighters' colours are tints, see `SettlerTextures`).
    PLAYER_COLORS.forEach((color, k) => {
      a.add(`flag:${k + 1}`, 14, 28, 2, 26, (ctx) => paintFlag(ctx, color));
      a.add(`banner:${k + 1}`, 30, 52, 15, 50, (ctx) => paintBanner(ctx, color));
    });
    for (let level = 1; level < SOLDIER_LEVELS.length; level++) {
      a.add(`chevrons:${level}`, 12, 10, 6, 5, (ctx) => paintChevrons(ctx, level));
    }
    if (art3d) addArt3d(a, art3d);
    this.textures = a.build();
  }

  /** [dir][column] of the 3D carrier sheet (`?art=3d`), or null. */
  carrier3d(): Texture[][] | null {
    const art = this.art3d;
    if (!art) return null;
    return DIRS.map((_, d) => Array.from({ length: art.carrier.columns }, (_, c) => this.get(`c3d:${d}:${c}`)));
  }

  /** Settler layer lookups, resolved once. */
  settlerTextures(): SettlerTextures {
    const dirs = [...Array(PAINTED_DIRS).keys()];
    const hat = {} as Record<HatStyle, Texture[]>;
    for (const style of HAT_STYLES) hat[style] = dirs.map((pd) => this.get(`sht:${style}:${pd}`));
    const holdArm = {} as Record<ToolShape, Texture[][]>;
    for (const tool of TOOLS) {
      holdArm[tool] = dirs.map((pd) => [...Array(WALK_FRAMES + 1).keys()].map((f) => this.get(`sa:hold:${tool}:${pd}:${f}`)));
    }
    const workArm = {} as Record<ActionId, Texture[][]>;
    for (const action of ACTION_IDS) {
      workArm[action] = dirs.map((pd) => [...Array(WORK_FRAMES).keys()].map((f) => this.get(`sa:work:${action}:${pd}:${f}`)));
    }
    return {
      body: dirs.map((pd) => [...Array(BODY_FRAMES).keys()].map((f) => this.get(`sb:${pd}:${f}`))),
      tunic: dirs.map((pd) => this.get(`st:${pd}`)),
      head: dirs.map((pd) => this.get(`shd:${pd}`)),
      hat,
      holdArm,
      workArm,
    };
  }

  has(name: string): boolean {
    return this.textures.has(name);
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
/** The 3D art the HTML icons use too (`?art=3d`), set by the `SpriteAtlas`. */
let iconArt: Art3d | null = null;
/** Opaque bounds of each 3D image, so icons are cropped to what is drawn. */
const opaqueBounds = new Map<HTMLImageElement, { x: number; y: number; w: number; h: number }>();

function boundsOf(img: HTMLImageElement, sx = 0, sy = 0, sw = img.width, sh = img.height) {
  const key = img;
  const cached = sx === 0 && sy === 0 && sw === img.width ? opaqueBounds.get(key) : undefined;
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  let x0 = sw;
  let y0 = sh;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (data[(y * sw + x) * 4 + 3] < 40) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const b = x1 < 0 ? { x: sx, y: sy, w: sw, h: sh } : { x: sx + x0, y: sy + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  if (sx === 0 && sy === 0 && sw === img.width) opaqueBounds.set(key, b);
  return b;
}

/** A square HTML icon canvas showing (part of) an image, cropped to its opaque pixels and centred. */
function imageIcon(img: HTMLImageElement, size: number, className: string, frame?: [number, number, number, number]) {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  if (className) canvas.className = className;
  const b = frame ? boundsOf(img, ...frame) : boundsOf(img);
  const k = (size * dpr) / Math.max(b.w, b.h);
  const w = b.w * k;
  const h = b.h * k;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, b.x, b.y, b.w, b.h, (size * dpr - w) / 2, (size * dpr - h) / 2, w, h);
  return canvas;
}

export function wareIcon(res: Resource, size = 18): HTMLCanvasElement {
  const img3d = iconArt?.images.get(res === 'log' ? 'log' : '');
  if (img3d) return imageIcon(img3d, size, 'ware-icon');
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
  const sheet = kind === 'carrier' ? iconArt?.images.get('carrier') : undefined;
  if (sheet && iconArt) {
    // Standing, facing south-east (row 1 of the sheet).
    const { cell, columns, walk } = iconArt.carrier;
    const r = sheet.width / (cell[0] * columns);
    return imageIcon(sheet, size, '', [walk * cell[0] * r, 1 * cell[1] * r, cell[0] * r, cell[1] * r]);
  }
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext('2d')!;
  const scale = (size / SETTLER_H) * 1.05;
  ctx.scale(dpr * scale, dpr * scale);
  ctx.translate((size / scale - SETTLER_W) / 2, -1);
  const st = styleOf(kind);
  // Facing south-east, mid-swing of the profession's work.
  paintSettlerPortrait(ctx, 1, st.fighter ? PLAYER_COLORS[0] : st.tunic, st.hat, st.hatStyle, st.work, 1);
  return canvas;
}

/** Standalone icon canvas for HTML UI. */
export function buildingIcon(type: BuildingType, size = 56): HTMLCanvasElement {
  const img3d = iconArt?.images.get(type);
  if (img3d) return imageIcon(img3d, size, '');
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

/** Draws frame `k` of a horizontal strip of w×h (logical) frames at the context origin. */
function drawFrame(ctx: CanvasRenderingContext2D, sheet: HTMLImageElement, k: number, w: number, h: number): void {
  const r = sheet.height / h;
  ctx.drawImage(sheet, k * w * r, 0, w * r, h * r, 0, 0, w, h);
}

/** Registers the 3D sprites under the keys of the procedural ones they replace (later wins). */
function addArt3d(a: AtlasBuilder, art: Art3d): void {
  const one = (key: string, name: string) => {
    const s = ART3D_SPRITES[name];
    const img = art.images.get(name)!;
    a.add(key, s.w, s.h, s.ax, s.ay, (ctx) => ctx.drawImage(img, 0, 0, s.w, s.h));
  };
  for (const type of Object.keys(ART3D_BUILDINGS)) one(`building:${type}`, type);
  for (const type of ART3D_STAGED) {
    for (let k = 0; k < ART3D_STAGES; k++) one(`stage:${type}:${k}`, `${type}-s${k}`);
  }
  for (const res of ART3D_PILES) {
    for (let n = 1; n <= PILE_MAX; n++) one(`pile:${res}:${n}`, `pile-${res}-${n}`);
  }
  one('tree:0', 'tree');
  for (let v = 1; v < 4; v++) a.alias(`tree:${v}`, 'tree:0');
  for (let v = 0; v < 3; v++) one(`deposit:${v}`, `deposit${v}`);
  one('ware:log', 'log');
  const { cell, anchor, columns } = art.carrier;
  const sheet = art.images.get('carrier')!;
  const [w, h] = cell;
  const r = sheet.width / (w * columns); // the sheet's resolution
  for (let d = 0; d < DIRS.length; d++) {
    for (let c = 0; c < columns; c++) {
      a.add(`c3d:${d}:${c}`, w, h, anchor[0], anchor[1], (ctx) =>
        ctx.drawImage(sheet, c * w * r, d * h * r, w * r, h * r, 0, 0, w, h),
      );
    }
  }
}
