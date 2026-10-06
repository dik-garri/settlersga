import type { Camera } from '../render/camera';
import { toScreen, toTile } from '../render/iso';
import { TERRAIN } from '../sim/config';
import { Terrain } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';

const WIDTH = 220;
/** Terrain and trees are re-rasterised about this often (ms), a slice of rows per frame; buildings and the view frame every frame. */
const BASE_EVERY = 2000;


/**
 * Isometric overview in the corner: one pixel per tile, rotated like the main view. Clicking it moves
 * the camera there.
 */
export class Minimap {
  readonly el: HTMLCanvasElement;
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

  constructor(
    private readonly world: World,
    private readonly camera: Camera,
    /** Respect the local player's fog of war. */
    private readonly fogOn = true,
  ) {
    const { w, h } = world.map;
    this.sx = (WIDTH - 2 * this.pad) / (w + h);
    this.sy = this.sx / 2;
    this.cx = this.pad + h * this.sx;
    const height = Math.ceil((w + h) * this.sy + 2 * this.pad);
    const dpr = window.devicePixelRatio || 1;
    this.el = document.createElement('canvas');
    this.el.className = 'panel minimap';
    this.el.width = WIDTH * dpr;
    this.el.height = height * dpr;
    this.el.style.width = `${WIDTH}px`;
    this.el.style.height = `${height}px`;
    this.el.title = 'Клик — перейти';
    this.ctx = this.el.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.base = document.createElement('canvas');
    this.base.width = w;
    this.base.height = h;
    this.baseCtx = this.base.getContext('2d')!;
    this.image = this.baseCtx.createImageData(w, h);
    this.el.addEventListener('pointerdown', (e) => this.jump(e));
    this.rasterize(0, world.map.h);
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
      if (map.owner[i] !== LOCAL_PLAYER) light *= 0.6;
      r = Math.min(255, r * light);
      g = Math.min(255, g * light);
      b = Math.min(255, b * light);
      // Another player's land gets a red cast.
      if (map.owner[i] !== LOCAL_PLAYER && map.owner[i] !== 0) r = Math.min(255, r + 70);
      if (this.fogOn) {
        const x = i % map.w;
        const y = (i - x) / map.w;
        if (!this.world.isExplored(x, y, LOCAL_PLAYER)) [r, g, b] = [8, 10, 14];
        else if (!this.world.isVisible(x, y, LOCAL_PLAYER)) [r, g, b] = [r * 0.55, g * 0.55, b * 0.55];
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

  update(_nowMs: number, viewW: number, viewH: number): void {
    // About one full refresh per BASE_EVERY at 60 fps, whatever the map size.
    const { h } = this.world.map;
    const rows = Math.max(1, Math.ceil((h * 16) / BASE_EVERY));
    const y0 = this.nextRow;
    const y1 = Math.min(h, y0 + rows);
    this.rasterize(y0, y1);
    this.nextRow = y1 >= h ? 0 : y1;
    const { ctx } = this;
    ctx.save();
    ctx.clearRect(0, 0, WIDTH, this.el.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    // Image pixel (x, y) is tile (x, y): map it through the isometric transform.
    ctx.setTransform(this.sx * dpr, this.sy * dpr, -this.sx * dpr, this.sy * dpr, this.cx * dpr, this.pad * dpr);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.base, -0.5, -0.5);
    ctx.restore();

    for (const b of this.world.buildings.values()) {
      if (this.fogOn && b.owner !== LOCAL_PLAYER && !this.world.isExplored(b.door.x, b.door.y, LOCAL_PLAYER)) continue;
      const [x, y] = this.point(b.x + (b.w - 1) / 2, b.y + (b.h - 1) / 2);
      ctx.fillStyle = b.owner === LOCAL_PLAYER ? '#ffe08a' : '#e05a4a';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
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
  }
}
