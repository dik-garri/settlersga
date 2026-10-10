import { Graphics } from 'pixi.js';
import { BUILDINGS } from '../sim/config';
import { routeTarget } from '../sim/trade';
import type { Building, PlayerId, Point } from '../sim/types';
import type { World } from '../sim/world';

/** Tiles per dash and per gap, and between direction marks, along a caravan line. */
const DASH = 0.7;
const GAP = 0.45;
const MARK_EVERY = 3;
/** How finely the line follows the terrain (tiles per sample). */
const STEP = 0.35;
/** The dark rim under the line. */
const OUTLINE = 0x1c140c;

/**
 * Caravan routes of the local player's markets, under everything standing on the map: a dashed line
 * in the player's colour from a market to its destination, with chevrons pointing the way the
 * donkeys go. Every route shows faintly; the selected market's route is drawn bright. Redrawn only
 * when the routes or the selection change.
 */
export class TradeRouteLayer {
  readonly g = new Graphics();
  private key = '';

  constructor(
    private readonly sim: World,
    /** Whose routes are drawn: the player this browser plays. */
    private readonly me: PlayerId,
    private readonly surface: (x: number, y: number) => Point,
    private readonly color: (player: number) => number,
  ) {}

  update(selected: number | null): void {
    const routes: [Building, Building][] = [];
    for (const b of this.sim.buildings.values()) {
      if (b.owner !== this.me || !BUILDINGS[b.type].market || !b.done) continue;
      const to = routeTarget(this.sim, b);
      if (to) routes.push([b, to]);
    }
    const key = `${selected}|${routes.map(([a, b]) => `${a.id}>${b.id}`).join(',')}`;
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clear();
    const color = this.color(this.me);
    for (const [from, to] of routes) {
      const bright = from.id === selected || to.id === selected;
      this.drawRoute(from.door, to.door, color, bright ? 1 : 0.4, bright ? 3 : 1.5);
    }
  }

  private drawRoute(a: Point, b: Point, color: number, alpha: number, width: number): void {
    const g = this.g;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1) return;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const at = (d: number) => this.surface(a.x + ux * d, a.y + uy * d);
    // Dashes that follow the ground.
    const dashes = () => {
      for (let d = 0.6; d < len - 0.6; d += DASH + GAP) {
        const end = Math.min(d + DASH, len - 0.6);
        const p0 = at(d);
        g.moveTo(p0.x, p0.y);
        for (let t = d + STEP; t < end; t += STEP) {
          const p = at(t);
          g.lineTo(p.x, p.y);
        }
        const p1 = at(end);
        g.lineTo(p1.x, p1.y);
      }
    };
    // Chevrons pointing towards the destination.
    const chevrons = () => {
      for (let d = MARK_EVERY / 2; d < len - 1; d += MARK_EVERY) {
        const tip = at(d + 0.25);
        const back = at(d - 0.25);
        const dx = tip.x - back.x;
        const dy = tip.y - back.y;
        const n = Math.hypot(dx, dy) || 1;
        const sx = (dx / n) * 7;
        const sy = (dy / n) * 7;
        g.moveTo(tip.x - sx - sy * 0.8, tip.y - sy + sx * 0.8);
        g.lineTo(tip.x, tip.y);
        g.lineTo(tip.x - sx + sy * 0.8, tip.y - sy - sx * 0.8);
      }
    };
    // A dark rim under the colour keeps the line readable on grass, sand and water alike.
    const rim = { color: OUTLINE, alpha: alpha * 0.55, cap: 'round', join: 'round' } as const;
    const ink = { color, alpha, cap: 'round', join: 'round' } as const;
    dashes();
    g.stroke({ ...rim, width: width + 2.5 });
    chevrons();
    g.stroke({ ...rim, width: width + 3 });
    dashes();
    g.stroke({ ...ink, width });
    chevrons();
    g.stroke({ ...ink, width: width + 0.5 });
  }
}
