import { Container, Sprite, type Texture } from 'pixi.js';
import { ANIMAL_KINDS, type AnimalKind } from '../sim/config';
import type { Animal } from '../sim/animals';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { dirFromTileVelocity, DIRS } from './anim';
import { ANIMAL_CELLS, ANIMAL_COLUMNS, ANIMAL_GRAZE, ANIMAL_SCALE, ANIMAL_STAND, ANIMAL_STRIDE, ANIMAL_WALK, paintAnimal } from './animalArt';
import type { Art3d } from './art3d';
import { depthOf, HALF_H, HALF_W } from './iso';

type Add = (name: string, w: number, h: number, ax: number, ay: number, paint: (ctx: CanvasRenderingContext2D) => void) => void;

/** Registers `animal:<kind>:<dir>:<frame>`: the Blender sheets when loaded, else the painters. */
export function addAnimalSprites(add: Add, art: Art3d | null): void {
  for (const kind of ANIMAL_KINDS) {
    const c = ANIMAL_CELLS[kind];
    const sheet = art?.images.get(`animal-${kind}`);
    for (let d = 0; d < DIRS.length; d++) {
      for (let f = 0; f < ANIMAL_COLUMNS; f++) {
        add(`animal:${kind}:${d}:${f}`, c.w, c.h, c.ax, c.ay, (ctx) => {
          if (!sheet) return paintAnimal(ctx, kind, d, f);
          const r = sheet.width / (c.w * ANIMAL_COLUMNS);
          ctx.drawImage(sheet, f * c.w * r, d * c.h * r, c.w * r, c.h * r, 0, 0, c.w, c.h);
        });
      }
    }
  }
}

interface View {
  sprite: Sprite;
  dir: number;
  walked: number;
  lastX: number;
  lastY: number;
}

/**
 * Draws the wild animals: one sprite each, among the depth-sorted objects only while on screen and,
 * with the fog on, only where the local player has sight (like other players' settlers).
 */
export class AnimalLayer {
  private readonly views = new Map<number, View>();
  /** [kind][dir][frame], resolved once. */
  private readonly tex: Record<AnimalKind, Texture[][]>;

  constructor(
    private readonly sim: World,
    private readonly objects: Container,
    get: (name: string) => Texture,
    private readonly fogOn: boolean,
  ) {
    this.tex = Object.fromEntries(
      ANIMAL_KINDS.map((k) => [k, DIRS.map((_, d) => Array.from({ length: ANIMAL_COLUMNS }, (_, f) => get(`animal:${k}:${d}:${f}`)))]),
    ) as Record<AnimalKind, Texture[][]>;
  }

  sync(alpha: number, timeMs: number, view: { x: number; y: number; w: number; h: number }): void {
    const { map } = this.sim;
    if (this.views.size > this.sim.animals.length) this.prune();
    for (const a of this.sim.animals) {
      let v = this.views.get(a.id);
      if (!v) {
        v = { sprite: new Sprite(), dir: (a.id * 3) % DIRS.length, walked: 0, lastX: a.x, lastY: a.y };
        v.sprite.scale.set(ANIMAL_SCALE[a.kind]);
        this.views.set(a.id, v);
      }
      const x = a.px + (a.x - a.px) * alpha;
      const y = a.py + (a.y - a.py) * alpha;
      const px = (x - y) * HALF_W;
      const py = (x + y) * HALF_H - map.heightAt(x, y);
      const step = Math.hypot(x - v.lastX, y - v.lastY);
      if (step < 1.5) v.walked += step;
      v.lastX = x;
      v.lastY = y;
      const seen = !this.fogOn || this.sim.isVisible(Math.round(x), Math.round(y), LOCAL_PLAYER);
      const onScreen =
        seen && px > view.x - 40 && px < view.x + view.w + 40 && py > view.y - 20 && py < view.y + view.h + 60;
      if (onScreen !== (v.sprite.parent === this.objects)) {
        if (onScreen) this.objects.addChild(v.sprite);
        else this.objects.removeChild(v.sprite);
      }
      if (!onScreen) continue;
      this.pose(a, v, timeMs);
      v.sprite.position.set(px, py);
      v.sprite.zIndex = depthOf(x, y) + 0.01;
    }
  }

  private pose(a: Animal, v: View, timeMs: number): void {
    const dx = a.x - a.px;
    const dy = a.y - a.py;
    const moving = dx !== 0 || dy !== 0;
    if (moving) v.dir = dirFromTileVelocity(dx, dy, v.dir);
    let frame: number;
    if (moving) frame = Math.floor((v.walked / ANIMAL_STRIDE[a.kind]) * ANIMAL_WALK) % ANIMAL_WALK;
    else frame = (Math.floor(timeMs / 2600) + a.id) % 3 === 0 ? ANIMAL_STAND : ANIMAL_GRAZE;
    const t = this.tex[a.kind][v.dir][frame];
    if (v.sprite.texture !== t) {
      v.sprite.texture = t;
      v.sprite.anchor.copyFrom(t.defaultAnchor!);
    }
  }

  private prune(): void {
    const alive = new Set(this.sim.animals.map((a) => a.id));
    for (const [id, v] of this.views) {
      if (alive.has(id)) continue;
      v.sprite.destroy();
      this.views.delete(id);
    }
  }
}
