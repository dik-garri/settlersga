import { Container, Sprite, type Texture } from 'pixi.js';
import { ANIMAL_KINDS, type AnimalKind } from '../sim/config';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { dirFromTileVelocity, DIRS } from './anim';
import type { Point, Resource, Settler } from '../sim/types';
import {
  ANIMAL_CELLS,
  ANIMAL_COLUMNS,
  ANIMAL_GRAZE,
  ANIMAL_SCALE,
  ANIMAL_STAND,
  ANIMAL_STRIDE,
  ANIMAL_WALK,
  PACK,
  paintAnimal,
  paintPack,
} from './animalArt';
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
  add('pack', PACK.w, PACK.h, PACK.ax, PACK.ay, paintPack);
}

interface View {
  sprite: Sprite;
  dir: number;
  walked: number;
  lastX: number;
  lastY: number;
}

/** A settler drawn as an animal (`UNIT_ANIMALS`): the animal, its pack saddle and the goods on it. */
interface UnitView extends View {
  root: Container;
  owner: number;
  pack: Sprite;
  ware: Sprite;
  /** The second pack's good (`Settler.pack2`), beside the first. */
  ware2: Sprite;
}

/**
 * Draws the wild animals: one sprite each, among the depth-sorted objects only while on screen and,
 * with the fog on, only where the local player has sight (like other players' settlers).
 */
export class AnimalLayer {
  private readonly views = new Map<number, View>();
  /** [kind][dir][frame], resolved once. */
  private readonly tex: Record<AnimalKind, Texture[][]>;
  /** Settlers drawn as animals, by settler id. */
  private readonly units = new Map<number, UnitView>();
  private readonly packTex: Texture;

  constructor(
    private readonly sim: World,
    private readonly objects: Container,
    get: (name: string) => Texture,
    private readonly fogOn: boolean,
    private readonly wareTex: Record<Resource, Texture>,
  ) {
    this.tex = Object.fromEntries(
      ANIMAL_KINDS.map((k) => [k, DIRS.map((_, d) => Array.from({ length: ANIMAL_COLUMNS }, (_, f) => get(`animal:${k}:${d}:${f}`)))]),
    ) as Record<AnimalKind, Texture[][]>;
    this.packTex = get('pack');
  }

  /**
   * Draws a settler that is an animal (`UNIT_ANIMALS`: pack donkeys) like the wild ones, with its pack
   * saddle and, while loaded, the goods on top. Called by the renderer's settler loop instead of a figure.
   */
  syncUnit(s: Settler, kind: AnimalKind, alpha: number, timeMs: number, view: { x: number; y: number; w: number; h: number }): void {
    let v = this.units.get(s.id);
    if (!v) {
      const root = new Container();
      const sprite = new Sprite();
      const pack = new Sprite(this.packTex);
      pack.anchor.copyFrom(this.packTex.defaultAnchor!);
      pack.position.set(0, -PACK.back * ANIMAL_SCALE[kind]);
      const ware = new Sprite();
      ware.scale.set(0.8);
      ware.position.set(0, -PACK.back * ANIMAL_SCALE[kind] - 4);
      const ware2 = new Sprite();
      ware2.scale.set(0.8);
      ware2.position.set(5, -PACK.back * ANIMAL_SCALE[kind] - 2);
      sprite.scale.set(ANIMAL_SCALE[kind]);
      root.addChild(sprite, pack, ware, ware2);
      v = { root, sprite, pack, ware, ware2, owner: s.owner, dir: (s.id * 3) % DIRS.length, walked: 0, lastX: s.x, lastY: s.y };
      this.units.set(s.id, v);
    }
    const x = s.px + (s.x - s.px) * alpha;
    const y = s.py + (s.y - s.py) * alpha;
    const px = (x - y) * HALF_W;
    const py = (x + y) * HALF_H - this.sim.map.heightAt(x, y);
    const step = Math.hypot(x - v.lastX, y - v.lastY);
    if (step < 1.5) v.walked += step;
    v.lastX = x;
    v.lastY = y;
    const seen = !this.fogOn || s.owner === LOCAL_PLAYER || this.sim.isVisible(Math.round(x), Math.round(y), LOCAL_PLAYER);
    const onScreen =
      seen &&
      s.inside === null &&
      px > view.x - 40 &&
      px < view.x + view.w + 40 &&
      py > view.y - 20 &&
      py < view.y + view.h + 60;
    if (onScreen !== (v.root.parent === this.objects)) {
      if (onScreen) this.objects.addChild(v.root);
      else this.objects.removeChild(v.root);
    }
    if (!onScreen) return;
    this.pose(kind, s, v, timeMs, s.tasks.length === 0);
    this.showWare(v.ware, s.carrying);
    // A second pack of another good shows beside the first.
    this.showWare(v.ware2, s.pack2 && s.pack2.res !== s.carrying ? s.pack2.res : null);
    v.root.position.set(px, py);
    v.root.zIndex = depthOf(x, y) + 0.01;
  }

  private showWare(sprite: Sprite, res: Resource | null): void {
    sprite.visible = res !== null;
    if (!res) return;
    const t = this.wareTex[res];
    if (sprite.texture !== t) {
      sprite.texture = t;
      sprite.anchor.copyFrom(t.defaultAnchor!);
    }
  }

  /** The view root of a settler drawn as an animal, if it is on screen (for selection markers). */
  unitRoot(id: number): Container | undefined {
    const v = this.units.get(id);
    return v && v.root.parent && v.root.visible ? v.root : undefined;
  }

  /**
   * The front-most settler drawn as an animal under a screen point (canvas CSS pixels), with its depth,
   * or null: a hit test on the animal sprite's bounds (trimmed a little at the edges).
   */
  unitAt(sx: number, sy: number): { id: number; z: number } | null {
    let best: { id: number; z: number } | null = null;
    for (const [id, v] of this.units) {
      if (!v.root.parent || !v.root.visible) continue;
      const b = v.sprite.getBounds();
      const padX = b.width * 0.18;
      const padY = b.height * 0.15;
      if (sx < b.x + padX || sx > b.x + b.width - padX || sy < b.y + padY || sy > b.y + b.height - padY) continue;
      if (!best || v.root.zIndex > best.z) best = { id, z: v.root.zIndex };
    }
    return best;
  }

  /** Settlers drawn as animals whose feet (on screen) fall inside a rectangle of canvas CSS pixels. */
  unitsInRect(ax: number, ay: number, bx: number, by: number): number[] {
    const out: number[] = [];
    for (const [id, v] of this.units) {
      if (!v.root.parent || !v.root.visible) continue;
      const b = v.sprite.getBounds();
      const fx = b.x + b.width / 2;
      const fy = b.y + b.height * 0.85;
      if (fx >= ax && fx <= bx && fy >= ay && fy <= by) out.push(id);
    }
    return out;
  }

  /** How many settlers are drawn as animals (for the renderer's check for dead settlers). */
  get unitCount(): number {
    return this.units.size;
  }

  /** Drops the views of animal settlers that are gone (`alive` = the world's settler ids). */
  pruneUnits(alive: Map<number, unknown>, gone?: (root: Container, owner: number) => void): void {
    for (const [id, v] of this.units) {
      if (alive.has(id)) continue;
      gone?.(v.root, v.owner);
      v.root.destroy({ children: true });
      this.units.delete(id);
    }
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
      this.pose(a.kind, a, v, timeMs, true);
      v.sprite.position.set(px, py);
      v.sprite.zIndex = depthOf(x, y) + 0.01;
    }
  }

  /** Walk frames by distance walked; standing still, now and then grazing (when `graze`). */
  private pose(kind: AnimalKind, a: Point & { px: number; py: number; id: number }, v: View, timeMs: number, graze: boolean): void {
    const dx = a.x - a.px;
    const dy = a.y - a.py;
    const moving = dx !== 0 || dy !== 0;
    if (moving) v.dir = dirFromTileVelocity(dx, dy, v.dir);
    let frame: number;
    if (moving) frame = Math.floor((v.walked / ANIMAL_STRIDE[kind]) * ANIMAL_WALK) % ANIMAL_WALK;
    else frame = !graze || (Math.floor(timeMs / 2600) + a.id) % 3 === 0 ? ANIMAL_STAND : ANIMAL_GRAZE;
    const t = this.tex[kind][v.dir][frame];
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
