import { Container, Graphics, Sprite, type Application } from 'pixi.js';
import { BUILD_TICKS_PER_UNIT, BUILDINGS, TREE_MATURE } from '../sim/config';
import { Terrain, type Building, type BuildingType, type Resource, type Settler } from '../sim/types';
import type { World } from '../sim/world';
import type { SpriteAtlas } from './atlas';
import { depthOf, HALF_H, HALF_W, toScreen, toTile } from './iso';
import { groundVariants, type GroundKind } from './sprites';

const TERRAIN_KIND: Record<Terrain, GroundKind> = {
  [Terrain.Water]: 'water',
  [Terrain.Sand]: 'sand',
  [Terrain.Grass]: 'grass',
  [Terrain.Rock]: 'rock',
};

const TREE_SCALE = [0, 0.35, 0.55, 0.78, 1];

/** Cheap deterministic per-tile hash for picking sprite variants. */
function hash(i: number): number {
  let h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

interface BuildingView {
  body: Container;
  site: Sprite;
  main: Sprite;
  front: Container;
  pileKey: string;
}

interface SettlerView {
  root: Container;
  body: Sprite;
  ware: Sprite;
  facing: 1 | -1;
}

export interface Ghost {
  type: BuildingType;
  x: number;
  y: number;
  valid: boolean;
}

export class GameRenderer {
  /** World-space root; the camera moves and scales it. */
  readonly world = new Container();
  private readonly ground = new Container();
  private readonly marks = new Graphics();
  private readonly objects = new Container({ sortableChildren: true });
  private readonly ghostLayer = new Container();
  private readonly ghostSprite: Sprite;

  private readonly treeSprites: (Sprite | null)[];
  private readonly treeState: Uint8Array;
  private readonly buildingViews = new Map<number, BuildingView>();
  private readonly settlerViews = new Map<number, SettlerView>();

  constructor(
    app: Application,
    private readonly sim: World,
    private readonly atlas: SpriteAtlas,
  ) {
    this.world.addChild(this.ground, this.marks, this.objects, this.ghostLayer);
    app.stage.addChild(this.world);
    this.ghostSprite = new Sprite();
    this.ghostSprite.alpha = 0.75;
    this.ghostLayer.addChild(this.ghostSprite);

    const n = sim.map.w * sim.map.h;
    this.treeSprites = new Array(n).fill(null);
    this.treeState = new Uint8Array(n);
    this.buildGround();
  }

  /** Bounds of the map in world pixels: [minX, minY, maxX, maxY]. */
  get bounds(): [number, number, number, number] {
    const { w, h } = this.sim.map;
    return [-(h - 1) * HALF_W, 0, (w - 1) * HALF_W, (w + h - 2) * HALF_H];
  }

  /** World pixel → fractional tile coordinates. */
  pickTile(wx: number, wy: number): { x: number; y: number } {
    return toTile(wx, wy);
  }

  private buildGround(): void {
    const { map } = this.sim;
    for (let d = 0; d <= map.w + map.h - 2; d++) {
      for (let x = Math.max(0, d - map.h + 1); x <= Math.min(d, map.w - 1); x++) {
        const y = d - x;
        const i = map.idx(x, y);
        const kind = TERRAIN_KIND[map.terrain[i] as Terrain];
        const v = hash(i) % groundVariants(kind);
        const tile = new Sprite(this.atlas.get(`ground:${kind}:${v}`));
        const p = toScreen(x, y);
        tile.position.set(p.x, p.y);
        this.ground.addChild(tile);
        if (kind === 'rock') {
          const rock = new Sprite(this.atlas.get(`boulder:${hash(i + 7) % 2}`));
          rock.position.set(p.x + ((hash(i) >> 8) % 7) - 3, p.y + 2);
          rock.scale.set(0.8 + ((hash(i) >> 4) % 4) * 0.08);
          rock.zIndex = depthOf(x, y);
          this.objects.addChild(rock);
        }
      }
    }
  }

  /** Brings sprites in line with the simulation. `alpha` ∈ [0,1) interpolates between ticks. */
  sync(alpha: number, timeMs: number, ghost: Ghost | null, selected: number | null, hover: { x: number; y: number } | null) {
    this.syncTrees();
    this.syncBuildings();
    this.syncSettlers(alpha, timeMs);
    this.drawMarks(ghost, selected, hover);
  }

  private syncTrees(): void {
    const { map } = this.sim;
    for (let i = 0; i < map.tree.length; i++) {
      const stage = map.tree[i];
      if (stage === this.treeState[i]) continue;
      this.treeState[i] = stage;
      let s = this.treeSprites[i];
      if (stage === 0) {
        if (s) {
          s.destroy();
          this.treeSprites[i] = null;
        }
        continue;
      }
      if (!s) {
        const x = i % map.w;
        const y = Math.floor(i / map.w);
        const h = hash(i);
        s = new Sprite(this.atlas.get(`tree:${h % 4}`));
        const p = toScreen(x, y);
        s.position.set(p.x + ((h >> 6) % 9) - 4, p.y + ((h >> 10) % 5) - 2);
        s.zIndex = depthOf(x, y);
        this.objects.addChild(s);
        this.treeSprites[i] = s;
      }
      const flip = hash(i + 1) % 2 ? -1 : 1;
      s.scale.set(TREE_SCALE[Math.min(stage, TREE_MATURE)] * flip, TREE_SCALE[Math.min(stage, TREE_MATURE)]);
    }
  }

  private syncBuildings(): void {
    for (const b of this.sim.buildings.values()) {
      let v = this.buildingViews.get(b.id);
      if (!v) v = this.createBuildingView(b);
      const progress = this.sim.buildProgress(b);
      v.site.visible = !b.done;
      if (b.done) {
        v.main.texture = this.atlas.get(`building:${b.type}`);
        v.main.anchor.copyFrom(v.main.texture.defaultAnchor!);
        v.main.visible = true;
      } else if (progress > 0) {
        v.main.texture = this.atlas.bottomPart(`building:${b.type}`, progress);
        v.main.anchor.copyFrom(v.main.texture.defaultAnchor!);
        v.main.visible = true;
      } else {
        v.main.visible = false;
      }
      this.syncPile(b, v);
    }
  }

  private createBuildingView(b: Building): BuildingView {
    const cx = b.x + (b.w - 1) / 2;
    const cy = b.y + (b.h - 1) / 2;
    const p = toScreen(cx, cy);
    const body = new Container();
    body.position.set(p.x, p.y);
    body.zIndex = depthOf(cx, cy) + 0.25;
    const site = new Sprite(this.atlas.get('building:site'));
    const main = new Sprite();
    body.addChild(site, main);

    const front = new Container();
    const d = toScreen(b.door.x, b.door.y);
    front.position.set(d.x, d.y);
    front.zIndex = depthOf(b.door.x, b.door.y) - 0.05;
    const flag = new Sprite(this.atlas.get('flag'));
    flag.position.set(-16, 3);
    front.addChild(flag);

    this.objects.addChild(body, front);
    const v: BuildingView = { body, site, main, front, pileKey: '' };
    this.buildingViews.set(b.id, v);
    return v;
  }

  /** Goods lying at the door: output pile on the right, input pile on the left. */
  private syncPile(b: Building, v: BuildingView): void {
    if (b.type === 'castle') return;
    const waiting = b.done
      ? 0
      : b.delivered.plank - Math.floor(b.progress / BUILD_TICKS_PER_UNIT);
    const key = `${b.output.log},${b.output.plank},${b.input.log},${waiting}`;
    if (key === v.pileKey) return;
    v.pileKey = key;
    // Keep the flag (child 0), drop the old pile.
    while (v.front.children.length > 1) v.front.children[1].destroy();
    const stack = (res: Resource, count: number, ox: number) => {
      for (let i = 0; i < count; i++) {
        const s = new Sprite(this.atlas.get(`ware:${res}`));
        s.position.set(ox + (i % 2) * 7, 8 - Math.floor(i / 2) * 4);
        v.front.addChild(s);
      }
    };
    stack('log', b.output.log, 8);
    stack('plank', b.output.plank, 8);
    stack('log', b.input.log, -34);
    stack('plank', waiting, -34);
  }

  private syncSettlers(alpha: number, timeMs: number): void {
    for (const s of this.sim.settlers) {
      let v = this.settlerViews.get(s.id);
      if (!v) v = this.createSettlerView(s);
      v.root.visible = s.inside === null;
      if (!v.root.visible) continue;

      const x = s.px + (s.x - s.px) * alpha;
      const y = s.py + (s.y - s.py) * alpha;
      const p = toScreen(x, y);
      const moving = s.x !== s.px || s.y !== s.py;
      const sdx = s.x - s.px - (s.y - s.py);
      if (sdx > 0.01) v.facing = 1;
      else if (sdx < -0.01) v.facing = -1;

      let frame = 'stand';
      if (s.working) frame = Math.floor(timeMs / 220) % 2 ? 'work' : 'stand';
      else if (moving) frame = Math.floor(timeMs / 160) % 2 ? 'walk' : 'stand';
      v.body.texture = this.atlas.get(`settler:${s.kind}:${frame}`);
      v.body.scale.x = v.facing;

      v.root.position.set(p.x, p.y - (moving && frame === 'walk' ? 1 : 0));
      v.root.zIndex = depthOf(x, y) + 0.01;
      v.ware.visible = s.carrying !== null;
      if (s.carrying) v.ware.texture = this.atlas.get(`ware:${s.carrying}`);
    }
  }

  private createSettlerView(s: Settler): SettlerView {
    const root = new Container();
    const body = new Sprite(this.atlas.get(`settler:${s.kind}:stand`));
    const ware = new Sprite(this.atlas.get('ware:log'));
    ware.position.set(0, -27);
    ware.visible = false;
    root.addChild(body, ware);
    this.objects.addChild(root);
    const v: SettlerView = { root, body, ware, facing: 1 };
    this.settlerViews.set(s.id, v);
    return v;
  }

  private diamond(x: number, y: number, inset = 0): number[] {
    const p = toScreen(x, y);
    const w = HALF_W - inset * 2;
    const h = HALF_H - inset;
    return [p.x, p.y - h, p.x + w, p.y, p.x, p.y + h, p.x - w, p.y];
  }

  private drawMarks(ghost: Ghost | null, selected: number | null, hover: { x: number; y: number } | null): void {
    const g = this.marks;
    g.clear();
    this.ghostSprite.visible = false;

    if (hover && !ghost && this.sim.map.inBounds(hover.x, hover.y)) {
      g.poly(this.diamond(hover.x, hover.y, 1)).stroke({ width: 1.5, color: 0xffffff, alpha: 0.45 });
    }

    const sel = selected !== null ? this.sim.buildings.get(selected) : undefined;
    if (sel) {
      for (let dy = 0; dy < sel.h; dy++) {
        for (let dx = 0; dx < sel.w; dx++) {
          g.poly(this.diamond(sel.x + dx, sel.y + dy)).fill({ color: 0xffe066, alpha: 0.18 });
        }
      }
      g.poly(this.diamond(sel.door.x, sel.door.y, 2)).stroke({ width: 2, color: 0xffe066, alpha: 0.9 });
    }

    if (ghost) {
      const def = BUILDINGS[ghost.type];
      const color = ghost.valid ? 0x7dff7d : 0xff5a5a;
      for (let dy = 0; dy < def.h; dy++) {
        for (let dx = 0; dx < def.w; dx++) {
          g.poly(this.diamond(ghost.x + dx, ghost.y + dy, 1)).fill({ color, alpha: 0.3 });
        }
      }
      g.poly(this.diamond(ghost.x + def.w - 1, ghost.y + def.h, 2)).stroke({ width: 2, color, alpha: 0.9 });
      const p = toScreen(ghost.x + (def.w - 1) / 2, ghost.y + (def.h - 1) / 2);
      this.ghostSprite.texture = this.atlas.get(`building:${ghost.type}`);
      this.ghostSprite.anchor.copyFrom(this.ghostSprite.texture.defaultAnchor!);
      this.ghostSprite.position.set(p.x, p.y);
      this.ghostSprite.tint = ghost.valid ? 0xc8ffc8 : 0xff9090;
      this.ghostSprite.visible = true;
    }
  }
}
