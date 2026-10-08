import { Graphics } from 'pixi.js';
import { doorOf } from '../sim/buildings';
import { BUILDINGS } from '../sim/config';
import type { BuildingType, Point } from '../sim/types';
import { defaultWorkCentre, workCentre, workRadius } from '../sim/workArea';
import type { World } from '../sim/world';

/** What the work-area overlay shows this frame. */
export interface WorkAreaShown {
  type: BuildingType;
  centre: Point;
  /** A preview of a centre the player is about to choose (drawn livelier). */
  preview?: boolean;
}

/**
 * The work area of a gatherer, planter, hunter or mine, as in Settlers 4: a soft field of the tiles
 * within its radius with a bright rim, under everything standing on the map. Shown while such a
 * building is being placed (centred where its door would be), while one is selected, and while the
 * player moves its centre. Redrawn only when what is shown changes.
 */
export class WorkAreaLayer {
  readonly g = new Graphics();
  private key = '';

  constructor(
    private readonly sim: World,
    private readonly diamond: (x: number, y: number) => number[],
    private readonly corner: (vx: number, vy: number) => Point,
    private readonly surface: (x: number, y: number) => Point,
  ) {}

  /** The area a building of `type` would work if placed with its top tile at (x, y). */
  static forPlan(type: BuildingType, x: number, y: number): WorkAreaShown | null {
    if (workRadius(type) === null) return null;
    const def = BUILDINGS[type];
    const door = doorOf(x, y, def.w, def.h);
    const centre = defaultWorkCentre(type, door, { x: x + (def.w - 1) / 2, y: y + (def.h - 1) / 2 });
    return { type, centre };
  }

  /** The area of an existing building, or null if it works none. */
  forBuilding(id: number | null): WorkAreaShown | null {
    const b = id !== null ? this.sim.buildings.get(id) : undefined;
    if (!b || workRadius(b.type) === null) return null;
    return { type: b.type, centre: workCentre(b) };
  }

  update(shown: WorkAreaShown | null): void {
    const r = shown ? workRadius(shown.type) : null;
    const key = shown && r !== null ? `${shown.type}|${shown.centre.x},${shown.centre.y}|${r}|${shown.preview ? 1 : 0}` : '';
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clear();
    if (!shown || r === null) return;
    const { map } = this.sim;
    const { x: cx, y: cy } = shown.centre;
    const inside = (x: number, y: number) => map.inBounds(x, y) && Math.hypot(x - cx, y - cy) <= r;
    const x0 = Math.floor(cx - r);
    const x1 = Math.ceil(cx + r);
    const y0 = Math.floor(cy - r);
    const y1 = Math.ceil(cy + r);
    const fill = shown.preview ? 0xfff0a0 : 0xffe08a;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (inside(x, y)) g.poly(this.diamond(x, y));
    }
    g.fill({ color: fill, alpha: shown.preview ? 0.26 : 0.2 });
    // The rim: tile edges between a tile inside and one outside.
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inside(x, y)) continue;
        const edges: [number, number, number, number, boolean][] = [
          [x, y, x + 1, y, !inside(x, y - 1)],
          [x + 1, y, x + 1, y + 1, !inside(x + 1, y)],
          [x + 1, y + 1, x, y + 1, !inside(x, y + 1)],
          [x, y + 1, x, y, !inside(x - 1, y)],
        ];
        for (const [ax, ay, bx, by, edge] of edges) {
          if (!edge) continue;
          const a = this.corner(ax, ay);
          const b = this.corner(bx, by);
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
        }
      }
    }
    g.stroke({ width: 3, color: fill, alpha: 1 });
    // The centre: a small ring where the worker heads first.
    const c = this.surface(cx, cy);
    g.ellipse(c.x, c.y, 9, 4.5).stroke({ width: 2, color: fill, alpha: 0.95 });
    g.ellipse(c.x, c.y, 2.5, 1.3).fill({ color: fill, alpha: 0.95 });
  }
}
