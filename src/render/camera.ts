import type { Container } from 'pixi.js';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;

/** Pans and zooms the world container. (x, y) is the world pixel at the screen center. */
export class Camera {
  x = 0;
  y = 0;
  zoom = 1;

  constructor(
    private readonly target: Container,
    private readonly bounds: [number, number, number, number],
  ) {}

  centerOn(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.clamp();
  }

  panScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
    this.clamp();
  }

  /** Zooms keeping the world point under (sx, sy) fixed. */
  zoomAt(factor: number, sx: number, sy: number, viewW: number, viewH: number): void {
    const before = this.toWorld(sx, sy, viewW, viewH);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const after = this.toWorld(sx, sy, viewW, viewH);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.clamp();
  }

  toWorld(sx: number, sy: number, viewW: number, viewH: number): { x: number; y: number } {
    return { x: (sx - viewW / 2) / this.zoom + this.x, y: (sy - viewH / 2) / this.zoom + this.y };
  }

  apply(viewW: number, viewH: number): void {
    this.target.scale.set(this.zoom);
    this.target.position.set(Math.round(viewW / 2 - this.x * this.zoom), Math.round(viewH / 2 - this.y * this.zoom));
  }

  private clamp(): void {
    const [minX, minY, maxX, maxY] = this.bounds;
    this.x = Math.min(maxX, Math.max(minX, this.x));
    this.y = Math.min(maxY, Math.max(minY, this.y));
  }
}
