import { Graphics } from 'pixi.js';

/** A tutorial mark on the map (tile coordinates, fractional allowed): an arrow, or with `ring` a circle of that many tiles. */
export interface GuideMark {
  x: number;
  y: number;
  ring?: number;
}

interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen pixels of an arrow (kept the same at every zoom). */
const ARROW = { w: 26, h: 40, head: 22, lift: 30 };
const FILL = 0xe0402a;
const RIM = 0x3a1206;
const GOLD = 0xffd34a;

/**
 * The tutorial's marks on the map (Settlers 4's world cursor, our own drawing): a bobbing arrow over
 * each marked tile with a ring at its foot, a pulsing circle round a marked area, and — for a mark
 * outside the view — a pointer at the edge of the view in its direction. One `Graphics` above the
 * objects and under the fog (so a mark on unexplored land stays dark, as everything there), redrawn
 * every frame only while there are marks. Sizes stay constant on screen at any zoom.
 */
export class GuideLayer {
  readonly g = new Graphics();
  private marks: GuideMark[] = [];
  private drawn = false;

  constructor(private readonly surface: (x: number, y: number) => { x: number; y: number }) {}

  set(marks: GuideMark[]): void {
    this.marks = marks;
  }

  update(timeMs: number, view: ViewRect, zoom: number): void {
    const g = this.g;
    if (this.marks.length === 0) {
      if (this.drawn) g.clear();
      this.drawn = false;
      return;
    }
    g.clear();
    this.drawn = true;
    const k = 1 / Math.max(0.1, zoom);
    const pulse = 0.5 + 0.5 * Math.sin(timeMs / 260);
    const bob = Math.sin(timeMs / 220) * 6 * k;
    for (const m of this.marks) {
      const p = this.surface(m.x, m.y);
      if (m.ring !== undefined) {
        // A tile radius r is an ellipse of r·32√2 by r·16√2 screen pixels.
        const rx = m.ring * 45.25;
        const ry = m.ring * 22.63;
        g.ellipse(p.x, p.y, rx, ry).fill({ color: GOLD, alpha: 0.08 + 0.06 * pulse });
        g.ellipse(p.x, p.y, rx, ry).stroke({ width: 3 * k, color: GOLD, alpha: 0.65 + 0.3 * pulse });
      }
      const margin = 46 * k;
      const inside = p.x > view.x + margin && p.x < view.x + view.w - margin && p.y > view.y + margin && p.y < view.y + view.h - margin;
      if (inside) {
        if (m.ring === undefined) this.arrow(p.x, p.y, k, bob, pulse);
      } else this.edgePointer(p, view, margin, k, pulse);
    }
  }

  /** A downward arrow over (x, y), its tip `lift` above the ground, and a ring round the foot. */
  private arrow(x: number, y: number, k: number, bob: number, pulse: number): void {
    const g = this.g;
    g.ellipse(x, y, 20 * k, 10 * k).stroke({ width: 2.5 * k, color: GOLD, alpha: 0.6 + 0.35 * pulse });
    const tip = y - ARROW.lift * k + bob;
    const w = (ARROW.w / 2) * k;
    const shaft = w * 0.42;
    const headTop = tip - ARROW.head * k;
    const top = tip - ARROW.h * k;
    const pts = [x, tip, x - w, headTop, x - shaft, headTop, x - shaft, top, x + shaft, top, x + shaft, headTop, x + w, headTop];
    g.poly(pts).fill({ color: FILL, alpha: 0.95 });
    g.poly(pts).stroke({ width: 2 * k, color: RIM, alpha: 0.9 });
    g.poly([x - shaft * 0.4, top + 3 * k, x - shaft * 0.4, headTop - 1 * k]).stroke({ width: 2 * k, color: 0xffb08a, alpha: 0.7 });
  }

  /** A triangle at the view's edge pointing towards a mark outside it. */
  private edgePointer(p: { x: number; y: number }, view: ViewRect, margin: number, k: number, pulse: number): void {
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const sx = Math.abs(dx) > 1e-6 ? (view.w / 2 - margin) / Math.abs(dx) : Infinity;
    const sy = Math.abs(dy) > 1e-6 ? (view.h / 2 - margin) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy, 1);
    const x = cx + dx * s;
    const y = cy + dy * s;
    const a = Math.atan2(dy, dx);
    const len = 26 * k;
    const half = 13 * k;
    const tip = { x: x + Math.cos(a) * len * 0.6, y: y + Math.sin(a) * len * 0.6 };
    const back = { x: x - Math.cos(a) * len * 0.4, y: y - Math.sin(a) * len * 0.4 };
    const nx = -Math.sin(a) * half;
    const ny = Math.cos(a) * half;
    const pts = [tip.x, tip.y, back.x + nx, back.y + ny, back.x - nx, back.y - ny];
    this.g.circle(x, y, 22 * k).fill({ color: RIM, alpha: 0.35 + 0.2 * pulse });
    this.g.poly(pts).fill({ color: FILL, alpha: 0.95 });
    this.g.poly(pts).stroke({ width: 2 * k, color: GOLD, alpha: 0.9 });
  }
}
