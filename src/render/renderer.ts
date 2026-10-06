import { Container, Graphics, Sprite, type Application } from 'pixi.js';
import { BUILD_TICKS_PER_UNIT, BUILDINGS, CROP_KINDS, TREE_MATURE } from '../sim/config';
import { RESOURCES, Terrain, type Building, type BuildingType, type Resource, type Settler } from '../sim/types';
import { CHUNK } from '../sim/map';
import { LOCAL_PLAYER, type World } from '../sim/world';
import type { SpriteAtlas } from './atlas';
import { depthOf, HALF_H, HALF_W, toScreen, toTile } from './iso';
import { groundVariants, type GroundKind } from './sprites';

const TERRAIN_KIND: Record<Terrain, GroundKind> = {
  [Terrain.Water]: 'water',
  [Terrain.Sand]: 'sand',
  [Terrain.Grass]: 'grass',
  [Terrain.Rock]: 'rock',
  [Terrain.Mountain]: 'mountain',
};

const TREE_SCALE = [0, 0.35, 0.55, 0.78, 1];

/** Cheap deterministic per-tile hash for picking sprite variants. */
function hash(i: number): number {
  let h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

interface BuildingView {
  /** Tiles the body and the door pile are registered under (see `addStatic`). */
  at: { x: number; y: number };
  doorAt: { x: number; y: number };
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

/** Visible world area in world pixels. */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Sprites reach this far above their tile (tall towers) and below it (shadows), in world pixels. */
const OVERDRAW_UP = 260;
const OVERDRAW_DOWN = 40;

/** Highlighted circle of tiles, e.g. where a geologist would look. */
export interface Area {
  x: number;
  y: number;
  r: number;
  valid: boolean;
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
  /**
   * Scaling: the map is cut into CHUNK×CHUNK tile chunks. Only chunks intersecting the view keep
   * their ground visible and their static objects in `objects`, so per-frame sorting and drawing
   * cost follows the screen, not the map. Settlers join `objects` only while on screen.
   */
  private readonly groundChunks: Container[] = [];
  private readonly chunkObjects: Set<Container>[] = [];
  private readonly chunkVisible: Uint8Array;
  private readonly chunkBounds: Float32Array;
  /** Last `map.chunkVersion` seen per chunk; trees and deposits are re-synced only for changed chunks. */
  private readonly chunkSeen: Int32Array;
  private view: ViewRect = { x: 0, y: 0, w: 0, h: 0 };
  private readonly territory = new Container();
  private readonly territoryChunks: Graphics[] = [];
  /** Owner per tile as last drawn; 255 forces the first draw. */
  private readonly ownerSeen: Uint8Array;
  private territoryVersion = -1;
  private readonly marks = new Graphics();
  private readonly objects = new Container({ sortableChildren: true });
  private readonly ghostLayer = new Container();
  private readonly ghostSprite: Sprite;

  private readonly treeSprites: (Sprite | null)[];
  private readonly treeState: Uint8Array;
  private readonly depositSprites: (Sprite | null)[];
  private readonly cropSprites: (Sprite | null)[];
  /** Geologist signs for the local player; state is ore code + 1, 0 = none. */
  private readonly signSprites: (Sprite | null)[];
  private readonly signState: Uint8Array;
  private readonly cropState: Uint8Array;
  /** Rendered deposit size per tile: 0 = none, otherwise size class + 1. */
  private readonly depositState: Uint8Array;
  private readonly buildingViews = new Map<number, BuildingView>();
  private readonly settlerViews = new Map<number, SettlerView>();

  constructor(
    app: Application,
    private readonly sim: World,
    private readonly atlas: SpriteAtlas,
  ) {
    this.world.addChild(this.ground, this.territory, this.marks, this.objects, this.ghostLayer);
    app.stage.addChild(this.world);
    this.ghostSprite = new Sprite();
    this.ghostSprite.alpha = 0.75;
    this.ghostLayer.addChild(this.ghostSprite);

    const { map } = sim;
    const n = map.w * map.h;
    this.treeSprites = new Array(n).fill(null);
    this.treeState = new Uint8Array(n);
    this.depositSprites = new Array(n).fill(null);
    this.depositState = new Uint8Array(n);
    this.cropSprites = new Array(n).fill(null);
    this.signSprites = new Array(n).fill(null);
    this.signState = new Uint8Array(n);
    this.cropState = new Uint8Array(n);
    const chunks = map.chunksX * map.chunksY;
    this.ownerSeen = new Uint8Array(n).fill(255);
    for (let c = 0; c < chunks; c++) {
      const g = new Graphics();
      g.visible = false;
      this.territoryChunks.push(g);
      this.territory.addChild(g);
    }
    this.chunkVisible = new Uint8Array(chunks);
    this.chunkSeen = new Int32Array(chunks).fill(-1);
    this.chunkBounds = new Float32Array(chunks * 4);
    for (let c = 0; c < chunks; c++) {
      this.chunkObjects.push(new Set());
      const x0 = (c % map.chunksX) * CHUNK;
      const y0 = Math.floor(c / map.chunksX) * CHUNK;
      const x1 = Math.min(map.w, x0 + CHUNK) - 1;
      const y1 = Math.min(map.h, y0 + CHUNK) - 1;
      this.chunkBounds.set(
        [
          (x0 - y1) * HALF_W - HALF_W,
          (x0 + y0) * HALF_H - HALF_H - OVERDRAW_UP,
          (x1 - y0) * HALF_W + HALF_W,
          (x1 + y1) * HALF_H + HALF_H + OVERDRAW_DOWN,
        ],
        c * 4,
      );
    }
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
    for (let c = 0; c < map.chunksX * map.chunksY; c++) {
      const chunk = new Container();
      chunk.visible = false;
      this.groundChunks.push(chunk);
    }
    // Chunk containers in depth order so their 1px overlaps stack like the tiles inside them.
    [...this.groundChunks.keys()]
      .sort((a, b) => (a % map.chunksX) + Math.floor(a / map.chunksX) - ((b % map.chunksX) + Math.floor(b / map.chunksX)))
      .forEach((c) => this.ground.addChild(this.groundChunks[c]));

    for (let d = 0; d <= map.w + map.h - 2; d++) {
      for (let x = Math.max(0, d - map.h + 1); x <= Math.min(d, map.w - 1); x++) {
        const y = d - x;
        const i = map.idx(x, y);
        const kind = TERRAIN_KIND[map.terrain[i] as Terrain];
        const v = hash(i) % groundVariants(kind);
        const tile = new Sprite(this.atlas.get(`ground:${kind}:${v}`));
        const p = toScreen(x, y);
        tile.position.set(p.x, p.y);
        this.groundChunks[map.chunkOf(x, y)].addChild(tile);
        // Cliffs are covered in boulders; walkable slopes only get the odd small stone.
        if (kind === 'rock' || (kind === 'mountain' && hash(i + 3) % 4 === 0)) {
          const rock = new Sprite(this.atlas.get(`boulder:${hash(i + 7) % 2}`));
          rock.position.set(p.x + ((hash(i) >> 8) % 7) - 3, p.y + 2);
          rock.scale.set((kind === 'rock' ? 0.8 : 0.4) + ((hash(i) >> 4) % 4) * 0.08);
          rock.zIndex = depthOf(x, y);
          this.addStatic(rock, x, y);
        }
      }
    }
  }

  /** Registers a non-moving object with its chunk; it is in the scene only while the chunk is visible. */
  private addStatic(obj: Container, x: number, y: number): void {
    const c = this.sim.map.chunkOf(Math.round(x), Math.round(y));
    this.chunkObjects[c].add(obj);
    if (this.chunkVisible[c]) this.objects.addChild(obj);
  }

  private removeStatic(obj: Container, x: number, y: number): void {
    this.chunkObjects[this.sim.map.chunkOf(Math.round(x), Math.round(y))].delete(obj);
    obj.destroy();
  }

  /**
   * Brings sprites in line with the simulation. `alpha` ∈ [0,1) interpolates between ticks;
   * `view` is the visible world area used for culling.
   */
  sync(
    alpha: number,
    timeMs: number,
    view: ViewRect,
    ghost: Ghost | null,
    selected: number | null,
    hover: { x: number; y: number } | null,
    area: Area | null = null,
  ) {
    this.view = view;
    this.syncTerritory();
    this.syncVisibleChunks();
    this.syncChangedTiles();
    this.syncBuildings();
    this.syncSettlers(alpha, timeMs);
    this.drawMarks(ghost, selected, hover, area);
  }

  private syncVisibleChunks(): void {
    const { x, y, w, h } = this.view;
    const b = this.chunkBounds;
    for (let c = 0; c < this.chunkVisible.length; c++) {
      const k = c * 4;
      const visible = b[k] < x + w && b[k + 2] > x && b[k + 1] < y + h && b[k + 3] > y ? 1 : 0;
      if (visible === this.chunkVisible[c]) continue;
      this.chunkVisible[c] = visible;
      this.groundChunks[c].visible = visible === 1;
      this.territoryChunks[c].visible = visible === 1;
      for (const obj of this.chunkObjects[c]) {
        if (visible) this.objects.addChild(obj);
        else this.objects.removeChild(obj);
      }
    }
  }

  private syncChangedTiles(): void {
    const { map } = this.sim;
    for (let c = 0; c < this.chunkSeen.length; c++) {
      if (map.chunkVersion[c] === this.chunkSeen[c]) continue;
      this.chunkSeen[c] = map.chunkVersion[c];
      const x0 = (c % map.chunksX) * CHUNK;
      const y0 = Math.floor(c / map.chunksX) * CHUNK;
      for (let y = y0; y < Math.min(map.h, y0 + CHUNK); y++) {
        for (let x = x0; x < Math.min(map.w, x0 + CHUNK); x++) {
          const i = map.idx(x, y);
          this.syncTree(i);
          this.syncDeposit(i);
          this.syncCrop(i);
          this.syncSign(i);
        }
      }
    }
  }

  private syncTree(i: number): void {
    const { map } = this.sim;
    const stage = map.tree[i];
    if (stage === this.treeState[i]) return;
    this.treeState[i] = stage;
    let s = this.treeSprites[i];
    const x = i % map.w;
    const y = Math.floor(i / map.w);
    if (stage === 0) {
      if (s) {
        this.removeStatic(s, x, y);
        this.treeSprites[i] = null;
      }
      return;
    }
    if (!s) {
      const h = hash(i);
      s = new Sprite(this.atlas.get(`tree:${h % 4}`));
      const p = toScreen(x, y);
      s.position.set(p.x + ((h >> 6) % 9) - 4, p.y + ((h >> 10) % 5) - 2);
      s.zIndex = depthOf(x, y);
      this.addStatic(s, x, y);
      this.treeSprites[i] = s;
    }
    const flip = hash(i + 1) % 2 ? -1 : 1;
    const scale = TREE_SCALE[Math.min(stage, TREE_MATURE)];
    s.scale.set(scale * flip, scale);
  }

  /**
   * Dims land outside the local player's territory and outlines the border. On a territory change
   * only chunks whose ownership changed (plus their neighbours, whose border edges may move) are redrawn.
   */
  private syncTerritory(): void {
    if (this.sim.territoryVersion === this.territoryVersion) return;
    this.territoryVersion = this.sim.territoryVersion;
    const { map } = this.sim;
    const dirty = new Set<number>();
    for (let i = 0; i < map.owner.length; i++) {
      if (map.owner[i] === this.ownerSeen[i]) continue;
      this.ownerSeen[i] = map.owner[i];
      const x = i % map.w;
      const y = Math.floor(i / map.w);
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (map.inBounds(x + dx, y + dy)) dirty.add(map.chunkOf(x + dx, y + dy));
      }
    }
    for (const c of dirty) this.drawTerritoryChunk(c);
  }

  private drawTerritoryChunk(c: number): void {
    const { map } = this.sim;
    const g = this.territoryChunks[c];
    g.clear();
    const x0 = (c % map.chunksX) * CHUNK;
    const y0 = Math.floor(c / map.chunksX) * CHUNK;
    const x1 = Math.min(map.w, x0 + CHUNK);
    const y1 = Math.min(map.h, y0 + CHUNK);
    const owned = (x: number, y: number) => map.inBounds(x, y) && map.owner[map.idx(x, y)] === LOCAL_PLAYER;
    let dim = false;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (owned(x, y)) continue;
        g.poly(this.diamond(x, y));
        dim = true;
      }
    }
    if (dim) g.fill({ color: 0x0b1420, alpha: 0.3 });
    let border = false;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!owned(x, y)) continue;
        const p = toScreen(x, y);
        const top = [p.x, p.y - HALF_H] as const;
        const right = [p.x + HALF_W, p.y] as const;
        const bottom = [p.x, p.y + HALF_H] as const;
        const left = [p.x - HALF_W, p.y] as const;
        const edges: [readonly [number, number], readonly [number, number], boolean][] = [
          [right, bottom, !owned(x + 1, y)],
          [left, top, !owned(x - 1, y)],
          [bottom, left, !owned(x, y + 1)],
          [top, right, !owned(x, y - 1)],
        ];
        for (const [a, b, edge] of edges) {
          if (!edge) continue;
          g.moveTo(a[0], a[1]);
          g.lineTo(b[0], b[1]);
          border = true;
        }
      }
    }
    if (border) g.stroke({ width: 3, color: 0x2b5fb4, alpha: 0.85 });
  }

  /** Fields are flat, so they live in the ground layer of their chunk rather than among sorted objects. */
  private syncCrop(i: number): void {
    const { map } = this.sim;
    const stage = map.crop[i];
    // Kind and stage together, so a field replaced by another kind is redrawn.
    const state = stage === 0 ? 0 : map.cropKind[i] * 8 + stage;
    if (state === this.cropState[i]) return;
    this.cropState[i] = state;
    let s = this.cropSprites[i];
    if (stage === 0) {
      s?.destroy();
      this.cropSprites[i] = null;
      return;
    }
    const x = i % map.w;
    const y = Math.floor(i / map.w);
    if (!s) {
      s = new Sprite();
      const p = toScreen(x, y);
      s.position.set(p.x, p.y);
      this.groundChunks[map.chunkOf(x, y)].addChild(s);
      this.cropSprites[i] = s;
    }
    s.texture = this.atlas.get(`field:${CROP_KINDS[map.cropKind[i]]}:${stage}`);
    s.anchor.copyFrom(s.texture.defaultAnchor!);
  }

  private syncSign(i: number): void {
    const { map } = this.sim;
    const seen = (map.prospected[i] & (1 << (LOCAL_PLAYER - 1))) !== 0;
    const state = seen ? map.ore[i] * (map.oreAmount[i] > 0 ? 1 : 0) + 1 : 0;
    if (state === this.signState[i]) return;
    this.signState[i] = state;
    const x = i % map.w;
    const y = Math.floor(i / map.w);
    let s = this.signSprites[i];
    if (!s) {
      s = new Sprite();
      const p = toScreen(x, y);
      s.position.set(p.x + 8, p.y + 4);
      s.zIndex = depthOf(x, y) + 0.02;
      this.addStatic(s, x, y);
      this.signSprites[i] = s;
    }
    s.texture = this.atlas.get(`sign:${state - 1}`);
    s.anchor.copyFrom(s.texture.defaultAnchor!);
  }

  private syncDeposit(i: number): void {
    const { map } = this.sim;
    const left = map.stone[i];
    const state = left === 0 ? 0 : left >= 6 ? 3 : left >= 3 ? 2 : 1;
    if (state === this.depositState[i]) return;
    this.depositState[i] = state;
    let s = this.depositSprites[i];
    const x = i % map.w;
    const y = Math.floor(i / map.w);
    if (state === 0) {
      if (s) this.removeStatic(s, x, y);
      this.depositSprites[i] = null;
      return;
    }
    if (!s) {
      const p = toScreen(x, y);
      s = new Sprite();
      s.position.set(p.x, p.y);
      s.scale.x = hash(i + 3) % 2 ? -1 : 1;
      s.zIndex = depthOf(x, y);
      this.addStatic(s, x, y);
      this.depositSprites[i] = s;
    }
    s.texture = this.atlas.get(`deposit:${state - 1}`);
    s.anchor.copyFrom(s.texture.defaultAnchor!);
  }

  private syncBuildings(): void {
    for (const [id, v] of this.buildingViews) {
      if (this.sim.buildings.has(id)) continue;
      // Demolished.
      this.removeStatic(v.body, v.at.x, v.at.y);
      this.removeStatic(v.front, v.doorAt.x, v.doorAt.y);
      this.buildingViews.delete(id);
    }
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
    const site = new Sprite(this.atlas.get(b.w >= 3 ? 'building:site3' : 'building:site2'));
    const main = new Sprite();
    body.addChild(site, main);

    const front = new Container();
    const d = toScreen(b.door.x, b.door.y);
    front.position.set(d.x, d.y);
    front.zIndex = depthOf(b.door.x, b.door.y) - 0.05;
    const flag = new Sprite(this.atlas.get('flag'));
    flag.position.set(-16, 3);
    front.addChild(flag);

    this.addStatic(body, cx, cy);
    this.addStatic(front, b.door.x, b.door.y);
    const v: BuildingView = { at: { x: cx, y: cy }, doorAt: { ...b.door }, body, site, main, front, pileKey: '' };
    this.buildingViews.set(b.id, v);
    return v;
  }

  /** Goods lying at the door: output pile on the right, input pile on the left. */
  private syncPile(b: Building, v: BuildingView): void {
    if (BUILDINGS[b.type].storage) return;
    // Materials on a site not yet built in; the builder uses planks first, then stone.
    const used = b.done ? 0 : Math.floor(b.progress / BUILD_TICKS_PER_UNIT);
    const usedPlanks = Math.min(used, b.delivered.plank);
    const waitingPlank = b.done ? 0 : b.delivered.plank - usedPlanks;
    const waitingStone = b.done ? 0 : b.delivered.stone - Math.min(b.delivered.stone, used - usedPlanks);
    const out = RESOURCES.map((r) => b.output[r]).join(',');
    const inp = RESOURCES.map((r) => b.input[r]).join(',');
    const key = `${out},${inp},${waitingPlank},${waitingStone}`;
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
    for (const r of RESOURCES) stack(r, b.output[r], 8);
    for (const r of RESOURCES) stack(r, b.input[r], -34);
    stack('plank', waitingPlank, -34);
    stack('stone', waitingStone, -50);
  }

  private syncSettlers(alpha: number, timeMs: number): void {
    for (const s of this.sim.settlers) {
      let v = this.settlerViews.get(s.id);
      if (!v) v = this.createSettlerView(s);
      const x = s.px + (s.x - s.px) * alpha;
      const y = s.py + (s.y - s.py) * alpha;
      const p = toScreen(x, y);
      const view = this.view;
      const onScreen =
        s.inside === null &&
        p.x > view.x - 40 &&
        p.x < view.x + view.w + 40 &&
        p.y > view.y - 20 &&
        p.y < view.y + view.h + 60;
      if (onScreen !== (v.root.parent === this.objects)) {
        if (onScreen) this.objects.addChild(v.root);
        else this.objects.removeChild(v.root);
      }
      if (!onScreen) continue;

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

  private drawMarks(
    ghost: Ghost | null,
    selected: number | null,
    hover: { x: number; y: number } | null,
    area: Area | null,
  ): void {
    const g = this.marks;
    g.clear();
    this.ghostSprite.visible = false;

    if (area) {
      const color = area.valid ? 0xffe066 : 0xff5a5a;
      for (let y = Math.ceil(area.y - area.r); y <= area.y + area.r; y++) {
        for (let x = Math.ceil(area.x - area.r); x <= area.x + area.r; x++) {
          if (Math.hypot(x - area.x, y - area.y) <= area.r && this.sim.map.inBounds(x, y)) {
            g.poly(this.diamond(x, y, 1)).fill({ color, alpha: 0.22 });
          }
        }
      }
    }

    if (hover && !ghost && !area && this.sim.map.inBounds(hover.x, hover.y)) {
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
