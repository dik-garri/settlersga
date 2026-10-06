import type { Camera } from '../render/camera';
import { toScreen, toTile } from '../render/iso';
import { Terrain } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';

const WIDTH = 220;
/** Terrain and trees are re-rasterised this often (ms); buildings and the view frame every frame. */
const BASE_EVERY = 2000;

const TERRAIN_RGB: Record<Terrain, [number, number, number]> = {
  [Terrain.Water]: [47, 111, 158],
  [Terrain.Sand]: [216, 196, 138],
  [Terrain.Grass]: [106, 154, 60],
  [Terrain.Rock]: [110, 104, 96],
  [Terrain.Mountain]: [150, 141, 124],
};

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
  private lastBase = -Infinity;

  constructor(
    private readonly world: World,
    private readonly camera: Camera,
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
  }

  private jump(e: PointerEvent): void {
    const r = this.el.getBoundingClientRect();
    const a = (e.clientX - r.left - this.cx) / this.sx; // x − y
    const b = (e.clientY - r.top - this.pad) / this.sy; // x + y
    const p = toScreen((a + b) / 2, (b - a) / 2);
    this.camera.centerOn(p.x, p.y);
  }

  private rasterize(): void {
    const { map } = this.world;
    const d = this.image.data;
    for (let i = 0; i < map.terrain.length; i++) {
      let [r, g, b] = TERRAIN_RGB[map.terrain[i] as Terrain];
      if (map.tree[i]) [r, g, b] = [52, 96, 42];
      else if (map.stone[i]) [r, g, b] = [200, 192, 176];
      else if (map.crop[i]) [r, g, b] = [184, 160, 80];
      if (map.owner[i] !== LOCAL_PLAYER) {
        r *= 0.6;
        g *= 0.6;
        b *= 0.6;
        // Another player's land gets a red cast.
        if (map.owner[i] !== 0) r = Math.min(255, r + 70);
      }
      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
    this.baseCtx.putImageData(this.image, 0, 0);
  }

  private point(x: number, y: number): [number, number] {
    return [(x - y) * this.sx + this.cx, (x + y) * this.sy + this.pad];
  }

  update(nowMs: number, viewW: number, viewH: number): void {
    if (nowMs - this.lastBase > BASE_EVERY) {
      this.lastBase = nowMs;
      this.rasterize();
    }
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
