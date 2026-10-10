import type { Camera } from '../render/camera';
import { toScreen, toTile } from '../render/iso';
import { TERRAIN } from '../sim/config';
import { isFighter } from '../sim/military';
import { Terrain, type PlayerId } from '../sim/types';
import type { World } from '../sim/world';
import { PLAYER_COLORS } from '../render/sprites';
import { LANG_EVENT, t, type Key } from './i18n';
import { minimapTip } from './tips';
import { tip } from './tooltip';

/** What the minimap shows (Settlers 4's minimap switches); land is the territory tint of the overview. */
export type MinimapLayer = 'buildings' | 'fighters' | 'settlers' | 'land';
const LAYERS: { id: MinimapLayer; label: string; title: Key }[] = [
  { id: 'buildings', label: '⌂', title: 'minimap.buildings' },
  { id: 'fighters', label: '⚔', title: 'minimap.fighters' },
  { id: 'settlers', label: '☺', title: 'minimap.settlers' },
  { id: 'land', label: '▦', title: 'minimap.land' },
];

/** Terrain and trees are re-rasterised about this often (ms), a slice of rows per frame; buildings and the view frame every frame. */
const BASE_EVERY = 2000;


/**
 * Isometric overview in the corner: one pixel per tile, rotated like the main view. Clicking it moves
 * the camera there.
 */
export class Minimap {
  readonly el: HTMLCanvasElement;
  /** The layer switches under the map (Settlers 4: buildings, fighters, settlers, land). */
  readonly controls: HTMLElement;
  /** The map and its switches, as framed in the side panel. */
  readonly box: HTMLElement;
  readonly layers: Record<MinimapLayer, boolean> = { buildings: true, fighters: true, settlers: false, land: true };
  private readonly ctx: CanvasRenderingContext2D;
  private readonly base: HTMLCanvasElement;
  private readonly baseCtx: CanvasRenderingContext2D;
  private readonly image: ImageData;
  /** Tile → minimap pixel: x' = (x − y)·sx + cx, y' = (x + y)·sy + pad. */
  private readonly sx: number;
  private readonly sy: number;
  private readonly cx: number;
  private readonly pad = 4;
  /** Next row to rasterise: the overview is refreshed a slice of rows per frame, never all at once. */
  private nextRow = 0;
  /** The tutorial's marks (tile points), blinking on the overview so a mark out of view is found. */
  private marks: readonly { x: number; y: number }[] = [];

  constructor(
    private readonly world: World,
    private readonly camera: Camera,
    /** Respect the local player's fog of war. */
    private readonly fogOn = true,
    /** CSS width of the minimap (it is framed at the top of the side panel). */
    width = 220,
    /** The player this browser plays: its land, fog and units. */
    private readonly me: PlayerId,
  ) {
    const { w, h } = world.map;
    this.sx = (width - 2 * this.pad) / (w + h);
    this.sy = this.sx / 2;
    this.cx = this.pad + h * this.sx;
    const height = Math.ceil((w + h) * this.sy + 2 * this.pad);
    const dpr = window.devicePixelRatio || 1;
    this.el = document.createElement('canvas');
    this.el.className = 'minimap';
    this.el.width = Math.round(width * dpr);
    this.el.height = height * dpr;
    this.el.style.width = `${width}px`;
    this.el.style.height = `${height}px`;
    this.ctx = this.el.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.base = document.createElement('canvas');
    this.base.width = w;
    this.base.height = h;
    this.baseCtx = this.base.getContext('2d')!;
    this.image = this.baseCtx.createImageData(w, h);
    this.el.addEventListener('pointerdown', (e) => this.jump(e));
    this.controls = document.createElement('div');
    this.controls.className = 'mm-layers';
    for (const l of LAYERS) {
      const b = document.createElement('button');
      b.textContent = l.label;
      b.classList.toggle('active', this.layers[l.id]);
      b.onclick = () => {
        this.setLayer(l.id, !this.layers[l.id]);
        b.classList.toggle('active', this.layers[l.id]);
        b.blur();
      };
      this.controls.append(b);
    }
    this.box = document.createElement('div');
    this.box.className = 'mm-box';
    this.box.append(this.el, this.controls);
    this.label();
    window.addEventListener(LANG_EVENT, () => this.label());
    this.rasterize(0, world.map.h);
  }

  /** Hover help and accessible names in the current language (the tips themselves are built when shown). */
  private label(): void {
    tip(this.el, () => t('minimap.jumpTip'));
    LAYERS.forEach((l, k) => {
      const b = this.controls.children[k] as HTMLElement;
      tip(b, () => minimapTip(l.id, t(l.title)));
      b.setAttribute('aria-label', t(l.title));
    });
  }

  /** Turns a layer on or off (the land tint at once: the overview is re-rasterised). */
  setLayer(layer: MinimapLayer, on: boolean): void {
    this.layers[layer] = on;
    if (layer === 'land') this.rasterize(0, this.world.map.h);
  }

  private jump(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    const a = (e.clientX - r.left - this.cx) / this.sx; // x − y
    const b = (e.clientY - r.top - this.pad) / this.sy; // x + y
    const p = toScreen((a + b) / 2, (b - a) / 2);
    this.camera.centerOn(p.x, p.y);
  }

  private rasterize(y0: number, y1: number): void {
    const { map } = this.world;
    const d = this.image.data;
    for (let i = y0 * map.w; i < y1 * map.w; i++) {
      let [r, g, b] = TERRAIN[map.terrain[i] as Terrain].rgb;
      if (map.tree[i]) [r, g, b] = [52, 96, 42];
      else if (map.stone[i]) [r, g, b] = [200, 192, 176];
      else if (map.crop[i]) [r, g, b] = [184, 160, 80];
      // Higher ground is brighter, so mountains read on the overview too.
      let light = 0.85 + Math.min(1, map.heightAt(i % map.w, Math.floor(i / map.w)) / 100) * 0.45;
      const land = this.layers.land;
      if (land && map.owner[i] !== this.me) light *= 0.6;
      r = Math.min(255, r * light);
      g = Math.min(255, g * light);
      b = Math.min(255, b * light);
      // Another player's land gets a cast of his colour.
      const o = map.owner[i];
      if (land && o !== this.me && o !== 0) {
        const c = parseInt(PLAYER_COLORS[(o - 1) % PLAYER_COLORS.length].slice(1), 16);
        r = Math.min(255, r * 0.6 + ((c >> 16) & 255) * 0.45);
        g = Math.min(255, g * 0.6 + ((c >> 8) & 255) * 0.45);
        b = Math.min(255, b * 0.6 + (c & 255) * 0.45);
      }
      if (this.fogOn) {
        const x = i % map.w;
        const y = (i - x) / map.w;
        if (!this.world.isExplored(x, y, this.me)) [r, g, b] = [8, 10, 14];
        else if (!this.world.isVisible(x, y, this.me)) [r, g, b] = [r * 0.55, g * 0.55, b * 0.55];
      }
      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
    this.baseCtx.putImageData(this.image, 0, 0, 0, y0, map.w, y1 - y0);
  }

  private point(x: number, y: number): [number, number] {
    return [(x - y) * this.sx + this.cx, (x + y) * this.sy + this.pad];
  }

  /** The tutorial's marks to blink (`GuideMark`s; none = nothing drawn). */
  setMarks(marks: readonly { x: number; y: number }[]): void {
    this.marks = marks;
  }

  update(nowMs: number, viewW: number, viewH: number): void {
    // About one full refresh per BASE_EVERY at 60 fps, whatever the map size.
    const { h } = this.world.map;
    const rows = Math.max(1, Math.ceil((h * 16) / BASE_EVERY));
    const y0 = this.nextRow;
    const y1 = Math.min(h, y0 + rows);
    this.rasterize(y0, y1);
    this.nextRow = y1 >= h ? 0 : y1;
    const { ctx } = this;
    ctx.save();
    // Clear in device pixels: the context is scaled by the pixel ratio, which may be below 1.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    const dpr = window.devicePixelRatio || 1;
    // Image pixel (x, y) is tile (x, y): map it through the isometric transform.
    ctx.setTransform(this.sx * dpr, this.sy * dpr, -this.sx * dpr, this.sy * dpr, this.cx * dpr, this.pad * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, -0.5, -0.5);
    ctx.restore();

    if (this.layers.buildings) {
      for (const b of this.world.buildings.values()) {
        if (this.fogOn && b.owner !== this.me && !this.world.isExplored(b.door.x, b.door.y, this.me)) continue;
        const [x, y] = this.point(b.x + (b.w - 1) / 2, b.y + (b.h - 1) / 2);
        ctx.fillStyle = b.owner === this.me ? '#ffe08a' : '#e05a4a';
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    if (this.layers.fighters || this.layers.settlers) {
      // Outdoor settlers as dots, other players' only where the local player sees (fog).
      for (const s of this.world.settlers) {
        if (s.inside !== null) continue;
        const fighter = isFighter(s);
        if (fighter ? !this.layers.fighters : !this.layers.settlers) continue;
        if (this.fogOn && s.owner !== this.me && !this.world.isVisible(Math.round(s.x), Math.round(s.y), this.me)) continue;
        const [x, y] = this.point(s.x, s.y);
        ctx.fillStyle = fighter ? PLAYER_COLORS[(s.owner - 1) % PLAYER_COLORS.length] : s.owner === this.me ? '#f4f0e0' : '#c8b8a8';
        const r = fighter ? 1.2 : 0.8;
        ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }

    const v = this.camera.viewRect(viewW, viewH);
    const corners = [
      toTile(v.x, v.y),
      toTile(v.x + v.w, v.y),
      toTile(v.x + v.w, v.y + v.h),
      toTile(v.x, v.y + v.h),
    ].map((t) => this.point(t.x, t.y));
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    corners.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();

    // The tutorial's marks: a blinking ring with a dot (on for 0.6 s, off for 0.3 s).
    if (this.marks.length > 0 && nowMs % 900 < 600) {
      ctx.lineWidth = 1.5;
      for (const m of this.marks) {
        const [x, y] = this.point(m.x, m.y);
        ctx.strokeStyle = '#ffd34a';
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = '#e0402a';
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
  }
}
