import { CanvasSource, Container, Graphics, MeshSimple, Sprite, Texture, type Application } from 'pixi.js';
import { BUILD_TICKS_PER_UNIT, BUILDINGS, CROP_KINDS, SHOT_TICKS, TREE_MATURE } from '../sim/config';
import { RESOURCES, Terrain, type Building, type BuildingType, type Resource, type Settler } from '../sim/types';
import { CHUNK } from '../sim/map';
import { LOCAL_PLAYER, type World } from '../sim/world';
import type { SettlerTextures, SpriteAtlas } from './atlas';
import {
  dirFromTileVelocity,
  dirTowards,
  FACES_AWAY,
  idleDir,
  MIRRORED,
  PAINTED_DIR,
  WALK_FRAMES,
  walkBob,
  walkFrame,
  workFrame,
} from './anim';
import {
  ACTIONS,
  GATHER_ACTION,
  PLANT_ACTION,
  styleOf,
  type ActionId,
  type ActionDef,
  type SettlerStyle,
  type SoundId,
} from './animConfig';
import { Effects } from './effects';
import { AnimalLayer } from './animals';
import { setFrame, type Settler3d } from './settler3d';
import { BODY_STAND, BODY_WORK, CARRY_AT } from './settlerArt';
import { depthOf, HALF_H, HALF_W, toScreen, toTile } from './iso';
import { ART3D_BANNERS, ART3D_STAGES, PILE_MAX } from './art3d';
import { needsLevelling } from '../sim/digging';
import { pathLevel } from '../sim/paths';
import { chatPartner } from '../sim/idle';
import { BANNERS, EDGE_DIRS, GROUND_PRIORITY, groundVariants, PATH_VARIANTS, PLAYER_COLORS, type GroundKind } from './sprites';

const TERRAIN_KIND: Record<Terrain, GroundKind> = {
  [Terrain.Water]: 'water',
  [Terrain.Sand]: 'sand',
  [Terrain.Grass]: 'grass',
  [Terrain.Rock]: 'rock',
  [Terrain.Mountain]: 'mountain',
  [Terrain.Ford]: 'ford',
  [Terrain.Desert]: 'desert',
  [Terrain.Swamp]: 'swamp',
};

const TREE_SCALE = [0, 0.35, 0.55, 0.78, 1];

/** Chunk unloading (`unloadHiddenChunks`): built chunks kept regardless, hidden time before a chunk goes, and per call. */
const KEEP_CHUNKS = 256;
const UNLOAD_AFTER_MS = 20_000;
const UNLOADS_PER_CALL = 32;

/** First-time chunk builds allowed per frame (see `syncVisibleChunks`). */
const CHUNK_BUILDS_PER_FRAME = 6;

/** Cheap deterministic per-tile hash for picking sprite variants. */
function hash(i: number): number {
  let h = Math.imul(i ^ 0x5bd1e995, 0x27d4eb2d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Offsets (tile units) for duelling pairs, so simultaneous fights at one door stay apart. */
const FIGHT_SPOTS: readonly [number, number][] = [
  [0, 0],
  [0.32, -0.32],
  [-0.32, 0.32],
  [0.38, 0.12],
  [-0.12, -0.38],
  [0.12, 0.42],
];

interface BuildingView {
  /** Owner the flag was last drawn for (buildings change hands when conquered). */
  owner: number;
  flag: Sprite;
  /** Whether the flag sits on the finished building's roof yet. */
  flagPlaced: boolean;
  /** Owner banner on the roof (castle, towers), shown once the building stands. */
  banner: Sprite | null;
  /** Tiles the body and the door pile are registered under (see `addStatic`). */
  at: { x: number; y: number };
  doorAt: { x: number; y: number };
  body: Container;
  site: Sprite;
  main: Sprite;
  front: Container;
  pileKey: string;
}

/**
 * A settler on screen: layered sprites (see `settlerArt.ts`) in a root that is mirrored for the
 * westward directions. Tunic and hat are tinted per profession, or per owner for fighters.
 */
interface SettlerView {
  root: Container;
  body: Sprite;
  tunic: Sprite;
  head: Sprite;
  hat: Sprite;
  /** Near arm with its tool; moved behind the body when the settler faces away. */
  arm: Sprite;
  ware: Sprite;
  /** Rank badge for fighters above level 0. */
  rank: Sprite;
  /** Index into `DIRS` the settler last moved or looked in. */
  dir: number;
  /** Tiles walked so far (drives the walk cycle, so feet do not slide). */
  walked: number;
  lastX: number;
  lastY: number;
  armBehind: boolean;
  /** Hit points last seen, to flash on a blow. */
  hp: number;
  /** Profession the layers are styled for (`retool`/`become` change it). */
  kind: string;
  /** Work frame last shown, to fire the action's sound once per loop. */
  frame: number;
}

const toTint = (hex: string) => Number.parseInt(hex.slice(1), 16);

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
  /** Per chunk: the mesh + shading container, replaced when heights change. */
  private readonly groundLayers: (Container | null)[] = [];
  /** One texture over the ground atlas page, shared by all ground meshes. */
  private readonly groundSheet: Texture;
  /** Last `map.heightVersion` the ground of each chunk was built for. */
  private readonly heightSeen: Uint32Array;
  /**
   * Scaling (512×512): a chunk's ground, boulders, territory overlay and tile objects are built the
   * first time it comes into view (`ensureChunk`), not at start-up; until then changes only mark it.
   */
  private readonly chunkReady: Uint8Array;
  private readonly territoryPending: Uint8Array;
  /**
   * Scaling (1024×1024): a built chunk out of view for `UNLOAD_AFTER_MS` gives its render data back
   * (`unloadChunk`) — ground mesh, shading, decals, boulders, trees, deposits, signs, territory and
   * fog — and is rebuilt by `ensureChunk` when it comes into view again. Buildings stay.
   */
  private readonly chunkHiddenAt: Float64Array;
  private readonly boulders: Container[][] = [];
  private lastUnload = 0;
  private lastHeightSync = 0;
  /** Where each static object stands (tile coordinates) and its offset from that surface point. */
  private readonly staticAt = new WeakMap<Container, { x: number; y: number; ox: number; oy: number }>();
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
  /** Arrows in flight (`World.shots`), redrawn every frame above everything standing on the ground. */
  private readonly shots = new Graphics();
  private readonly ghostLayer = new Container();
  /** Placement hints: a dot on every spot in view where the chosen building fits. */
  private readonly hints = new Graphics();
  private hintKey = '';
  private hintAt = 0;
  private readonly ghostSprite: Sprite;
  /**
   * Fog of war for the local player, above the objects, soft-edged as in Settlers 4: per chunk a
   * tiny canvas with one pixel per tile (plus a one-tile margin) whose alpha is that tile's darkness
   * — black where unexplored, a veil where explored but out of sight — stretched over the chunk's
   * tile corners (raised by the terrain height) with linear filtering, so darkness fades smoothly
   * across tile boundaries. Redrawn (throttled) only for visible chunks whose per-tile state
   * changed; objects on unexplored tiles are hidden.
   */
  private readonly fog = new Container();
  private readonly fogChunks: Container[] = [];
  /** Per chunk: the darkness canvas and its mesh (built lazily, rebuilt when heights change). */
  private readonly fogCanvas: (HTMLCanvasElement | null)[] = [];
  private readonly fogMesh: (MeshSimple | null)[] = [];
  private readonly fogTex: (Texture | null)[] = [];
  /** Per chunk: tile states (with the margin) as last drawn. */
  private readonly fogPrev: (Uint8Array | null)[] = [];
  /** Per tile as last drawn: 0 unexplored, 1 explored, 2 in sight; 255 forces a redraw. */
  private readonly fogSeen: Uint8Array;
  private lastFogSync = -Infinity;

  private readonly treeSprites: (Sprite | null)[];
  private readonly treeState: Uint8Array;
  private readonly depositSprites: (Sprite | null)[];
  private readonly cropSprites: (Sprite | null)[];
  /** Worn path decals per tile (`paths.ts`) and the level last drawn. */
  private readonly pathSprites: (Sprite | null)[];
  private readonly pathState: Uint8Array;
  /** Geologist signs for the local player; state is ore code + 1, 0 = none. */
  private readonly signSprites: (Sprite | null)[];
  private readonly signState: Uint8Array;
  private readonly cropState: Uint8Array;
  /** Rendered deposit size per tile: 0 = none, otherwise size class + 1. */
  private readonly depositState: Uint8Array;
  private readonly buildingViews = new Map<number, BuildingView>();
  private readonly settlerViews = new Map<number, SettlerView>();

  private readonly settlerTex: SettlerTextures;
  /** Wild animals (`animals.ts`). */
  private readonly animals: AnimalLayer;
  /** Pre-rendered 3D settlers (`?art=3d`), replacing the layered figure. */
  private readonly settler3d: Settler3d | null;
  private readonly wareTex = {} as Record<Resource, Texture>;
  private readonly playerTint = PLAYER_COLORS.map(toTint);
  private readonly tints = new Map<string, number>();
  /** Live visual effects (smoke, sails, glows, dust, falling trees, water glints, hit flashes). */
  private readonly effects: Effects;
  private nowMs = 0;
  private lastFrameMs = 0;
  /** Newest arrow already heard (`World.shots` tick). */
  private lastShotTick = -1;
  /** Scratch target of `workTarget`. */
  private tx = 0;
  private ty = 0;

  /**
   * Positional sound hook, set by `main.ts`: sound id and its world pixel position. The renderer
   * calls it only for things on screen, so the audio side just attenuates and rate-limits.
   */
  onSound: ((id: SoundId, x: number, y: number) => void) | null = null;
  private readonly sound = (id: SoundId, x: number, y: number): void => {
    const v = this.view;
    if (!this.onSound || x < v.x - 64 || x > v.x + v.w + 64 || y < v.y - 64 || y > v.y + v.h + 96) return;
    this.onSound(id, x, y);
  };

  constructor(
    app: Application,
    private readonly sim: World,
    private readonly atlas: SpriteAtlas,
    /** Draw the fog of war (`?fog=off` disables it for debugging). */
    private readonly fogOn = true,
  ) {
    this.world.addChild(this.ground, this.territory, this.marks, this.hints, this.objects, this.shots, this.fog, this.ghostLayer);
    this.settlerTex = atlas.settlerTextures();
    this.animals = new AnimalLayer(sim, this.objects, (n) => atlas.get(n), fogOn);
    this.settler3d = atlas.art3d?.settlers ?? null;
    for (const r of RESOURCES) this.wareTex[r] = atlas.get(`ware:${r}`);
    this.effects = new Effects(atlas, sim, (x, y) => this.surface(x, y), this.sound);
    // Glints sit right on the ground; smoke and sparks above the objects but under the fog.
    this.world.addChildAt(this.effects.waterLayer, this.world.getChildIndex(this.ground) + 1);
    this.world.addChildAt(this.effects.fxLayer, this.world.getChildIndex(this.fog));
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
    this.pathSprites = new Array(n).fill(null);
    this.pathState = new Uint8Array(n);
    this.signSprites = new Array(n).fill(null);
    this.signState = new Uint8Array(n);
    this.cropState = new Uint8Array(n);
    const chunks = map.chunksX * map.chunksY;
    this.ownerSeen = new Uint8Array(n).fill(255);
    this.fogSeen = new Uint8Array(n).fill(255);
    for (let c = 0; c < chunks; c++) {
      const g = new Graphics();
      g.visible = false;
      this.territoryChunks.push(g);
      this.territory.addChild(g);
      const f = new Container();
      f.visible = false;
      this.fogChunks.push(f);
      this.fog.addChild(f);
      this.fogCanvas.push(null);
      this.fogMesh.push(null);
      this.fogTex.push(null);
      this.fogPrev.push(null);
    }
    this.chunkVisible = new Uint8Array(chunks);
    this.chunkSeen = new Int32Array(chunks).fill(-1);
    this.heightSeen = new Uint32Array(chunks);
    this.chunkReady = new Uint8Array(chunks);
    this.territoryPending = new Uint8Array(chunks);
    this.chunkHiddenAt = new Float64Array(chunks);
    this.chunkBounds = new Float32Array(chunks * 4);
    this.groundSheet = new Texture({ source: this.atlas.get('ground:grass:0').source });
    for (let c = 0; c < chunks; c++) {
      this.chunkObjects.push(new Set());
      this.boulders.push([]);
      this.computeChunkBounds(c);
    }
    this.buildGround();
  }

  /** Screen bounds of a chunk for culling, lifted by its highest corner (raised ground shows higher). */
  private computeChunkBounds(c: number): void {
    const { map } = this.sim;
    const x0 = (c % map.chunksX) * CHUNK;
    const y0 = Math.floor(c / map.chunksX) * CHUNK;
    const x1 = Math.min(map.w, x0 + CHUNK) - 1;
    const y1 = Math.min(map.h, y0 + CHUNK) - 1;
    let lift = 0;
    for (let vy = y0; vy <= y1 + 1; vy++) for (let vx = x0; vx <= x1 + 1; vx++) lift = Math.max(lift, map.vertexHeight(vx, vy));
    this.chunkBounds.set(
      [
        (x0 - y1) * HALF_W - HALF_W,
        (x0 + y0) * HALF_H - HALF_H - OVERDRAW_UP - lift,
        (x1 - y0) * HALF_W + HALF_W,
        (x1 + y1) * HALF_H + HALF_H + OVERDRAW_DOWN,
      ],
      c * 4,
    );
  }

  /** Bounds of the map in world pixels: [minX, minY, maxX, maxY]. */
  get bounds(): [number, number, number, number] {
    const { w, h } = this.sim.map;
    return [-(h - 1) * HALF_W, 0, (w - 1) * HALF_W, (w + h - 2) * HALF_H];
  }

  /** Screen position of a point on the terrain surface (tile coordinates, fractional allowed). */
  private surface(x: number, y: number): { x: number; y: number } {
    const p = toScreen(x, y);
    p.y -= this.sim.map.heightAt(x, y);
    return p;
  }

  /** Screen position of tile corner (vx, vy) of the vertex grid, i.e. tile coordinates (vx − ½, vy − ½). */
  private corner(vx: number, vy: number): { x: number; y: number } {
    const p = toScreen(vx - 0.5, vy - 0.5);
    p.y -= this.sim.map.vertexHeight(vx, vy);
    return p;
  }

  /**
   * World pixel → fractional tile coordinates on the terrain surface. A point on screen lies above
   * ground that is `height` lower on the flat projection, so the guess is refined a few times.
   */
  pickTile(wx: number, wy: number): { x: number; y: number } {
    let t = toTile(wx, wy);
    for (let k = 0; k < 4; k++) t = toTile(wx, wy + this.sim.map.heightAt(t.x, t.y));
    return t;
  }

  /**
   * Ground is one textured mesh per chunk whose vertices are the tile corners raised by their
   * height (shared corners, so no seams), plus a slope-shading layer lit from the top-left. Each
   * chunk's ground can be rebuilt on its own when diggers change heights (`syncHeights`).
   */
  private buildGround(): void {
    const { map } = this.sim;
    for (let c = 0; c < map.chunksX * map.chunksY; c++) {
      const chunk = new Container();
      chunk.visible = false;
      this.groundChunks.push(chunk);
      this.groundLayers.push(null);
    }
    // Chunk containers in depth order so overlapping slopes stack like the tiles inside them.
    [...this.groundChunks.keys()]
      .sort((a, b) => (a % map.chunksX) + Math.floor(a / map.chunksX) - ((b % map.chunksX) + Math.floor(b / map.chunksX)))
      .forEach((c) => this.ground.addChild(this.groundChunks[c]));
    for (let c = 0; c < this.groundChunks.length; c++) this.heightSeen[c] = map.heightVersion[c];
  }

  /** First time a chunk comes into view: build its ground, boulders and pending overlays. */
  private ensureChunk(c: number): void {
    if (this.chunkReady[c]) return;
    this.chunkReady[c] = 1;
    this.buildChunkGround(c);
    this.placeBoulders(c);
    if (this.territoryPending[c]) {
      this.territoryPending[c] = 0;
      this.drawTerritoryChunk(c);
    }
  }

  /** Cliffs are covered in boulders; walkable slopes only get the odd small stone. */
  private placeBoulders(c: number): void {
    const { map } = this.sim;
    const x0 = (c % map.chunksX) * CHUNK;
    const y0 = Math.floor(c / map.chunksX) * CHUNK;
    for (let y = y0; y < Math.min(map.h, y0 + CHUNK); y++) {
      for (let x = x0; x < Math.min(map.w, x0 + CHUNK); x++) {
        const i = map.idx(x, y);
        const kind = TERRAIN_KIND[map.terrain[i] as Terrain];
        if (kind !== 'rock' && !(kind === 'mountain' && hash(i + 3) % 4 === 0)) continue;
        const rock = new Sprite(this.atlas.get(`boulder:${hash(i + 7) % 2}`));
        const p = this.surface(x, y);
        rock.position.set(p.x + ((hash(i) >> 8) % 7) - 3, p.y + 2);
        rock.scale.set((kind === 'rock' ? 0.8 : 0.4) + ((hash(i) >> 4) % 4) * 0.08);
        rock.zIndex = depthOf(x, y);
        this.addStatic(rock, x, y);
        this.boulders[c].push(rock);
      }
    }
  }

  /**
   * (Re)builds one chunk's ground mesh and shading. Tiles go back to front; after each tile's own
   * texture come the transition overlays of its higher-priority neighbours (fading in from the
   * shared edge or corner), so terrain borders blend instead of stepping.
   */
  private buildChunkGround(c: number): void {
    const { map } = this.sim;
    const source = this.groundSheet.source;
    const x0 = (c % map.chunksX) * CHUNK;
    const y0 = Math.floor(c / map.chunksX) * CHUNK;
    const x1 = Math.min(map.w, x0 + CHUNK);
    const y1 = Math.min(map.h, y0 + CHUNK);
    const vertices: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const shade = new Graphics();
    const levels = new Map<number, number[][]>();
    const kindAt = (x: number, y: number) =>
      map.inBounds(x, y) ? TERRAIN_KIND[map.terrain[map.idx(x, y)] as Terrain] : undefined;
    const priority = (k: GroundKind | undefined) => (k ? GROUND_PRIORITY.indexOf(k) : -1);
    const quadOf = (tex: Texture, quad: { x: number; y: number }[]) => {
      if (tex.source !== source) throw new Error('ground sprites must share one atlas page');
      // Sample slightly inside the painted diamond so antialiased edges never show as seams.
      const f = tex.frame;
      const uv = [
        [f.x + 33, f.y + 2],
        [f.x + 63.5, f.y + 17],
        [f.x + 33, f.y + 32],
        [f.x + 2.5, f.y + 17],
      ];
      const k = vertices.length / 2;
      for (let q = 0; q < 4; q++) {
        vertices.push(quad[q].x, quad[q].y);
        uvs.push(uv[q][0] / source.width, uv[q][1] / source.height);
      }
      indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
    };
    for (let d = x0 + y0; d <= x1 - 1 + y1 - 1; d++) {
      for (let x = Math.max(x0, d - (y1 - 1)); x <= Math.min(x1 - 1, d - y0); x++) {
        const y = d - x;
        const i = map.idx(x, y);
        const kind = kindAt(x, y)!;
        const quad = [this.corner(x, y), this.corner(x + 1, y), this.corner(x + 1, y + 1), this.corner(x, y + 1)];
        const period = this.atlas.groundPeriod[kind];
        const variant = period ? (x % period) + period * (y % period) : hash(i) % groundVariants(kind);
        quadOf(this.atlas.get(`ground:${kind}:${variant}`), quad);
        const own = priority(kind);
        EDGE_DIRS.forEach(([du, dv], dir) => {
          const n = kindAt(x + du, y + dv);
          if (!n || priority(n) <= own) return;
          // A corner overlay is redundant where an edge neighbour of the same kind already covers it.
          if (du !== 0 && dv !== 0 && (kindAt(x + du, y) === n || kindAt(x, y + dv) === n)) return;
          quadOf(this.atlas.get(`edge:${n}:${dir}`), quad);
        });

        const level = this.slopeLight(x, y);
        if (level !== 0) {
          const list = levels.get(level) ?? [];
          list.push(quad.flatMap((p) => [p.x, p.y]));
          levels.set(level, list);
        }
      }
    }
    for (const [level, polys] of levels) {
      for (const pts of polys) shade.poly(pts);
      shade.fill(level > 0 ? { color: 0xfff4d8, alpha: level * 0.05 } : { color: 0x0c0a14, alpha: -level * 0.07 });
    }
    const layer = new Container();
    layer.addChild(
      new MeshSimple({
        texture: this.groundSheet,
        vertices: new Float32Array(vertices),
        uvs: new Float32Array(uvs),
        indices: new Uint32Array(indices),
      }),
      shade,
    );
    // The ground layer stays below the chunk's field decals.
    this.groundLayers[c]?.destroy({ children: true });
    this.groundLayers[c] = layer;
    this.groundChunks[c].addChildAt(layer, 0);
  }

  /**
   * Diggers change corner heights at runtime: rebuild the ground of the chunks they touched, redraw
   * their territory overlay, re-seat everything standing there and lift the culling bounds.
   * Throttled, since a digger moves a corner a few times per second.
   */
  private syncHeights(timeMs: number): void {
    if (timeMs - this.lastHeightSync < 120) return;
    this.lastHeightSync = timeMs;
    const { map } = this.sim;
    for (let c = 0; c < this.heightSeen.length; c++) {
      if (map.heightVersion[c] === this.heightSeen[c]) continue;
      this.heightSeen[c] = map.heightVersion[c];
      this.computeChunkBounds(c);
      if (!this.chunkReady[c]) continue; // built from the new heights when it comes into view
      this.buildChunkGround(c);
      this.drawTerritoryChunk(c);
      // The fog mesh follows the new heights (its texture is kept).
      this.fogMesh[c]?.destroy();
      this.fogMesh[c] = null;
      for (const obj of this.chunkObjects[c]) {
        const at = this.staticAt.get(obj);
        if (!at) continue;
        const p = this.surface(at.x, at.y);
        obj.position.set(p.x + at.ox, p.y + at.oy);
      }
      const x0 = (c % map.chunksX) * CHUNK;
      const y0 = Math.floor(c / map.chunksX) * CHUNK;
      for (let y = y0; y < Math.min(map.h, y0 + CHUNK); y++) {
        for (let x = x0; x < Math.min(map.w, x0 + CHUNK); x++) {
          for (const decal of [this.cropSprites[map.idx(x, y)], this.pathSprites[map.idx(x, y)]]) {
            if (!decal) continue;
            const p = this.surface(x, y);
            decal.position.set(p.x, p.y);
          }
        }
      }
    }
  }

  /**
   * Slope shading for a tile as a signed level (−7 dark … +5 light): the surface normal from its
   * corner heights against a light from the top-left of the screen (tile −x) and above.
   */
  private slopeLight(x: number, y: number): number {
    const m = this.sim.map;
    const top = m.vertexHeight(x, y);
    const right = m.vertexHeight(x + 1, y);
    const bottom = m.vertexHeight(x + 1, y + 1);
    const left = m.vertexHeight(x, y + 1);
    // Height change per tile along tile x and y, against a tile's ground length in pixels.
    const run = HALF_W * Math.SQRT2;
    const gx = (right - top + bottom - left) / 2 / run;
    const gy = (left - top + bottom - right) / 2 / run;
    const lit = (1 + 1.4 * (gx + 0.35 * gy)) / Math.sqrt(1 + gx * gx + gy * gy) - 1;
    return Math.max(-7, Math.min(5, Math.round(lit * 14)));
  }

  /** Registers a non-moving object with its chunk; it is in the scene only while the chunk is visible. */
  private addStatic(obj: Container, x: number, y: number): void {
    const c = this.sim.map.chunkOf(Math.round(x), Math.round(y));
    const p = this.surface(x, y);
    this.staticAt.set(obj, { x, y, ox: obj.position.x - p.x, oy: obj.position.y - p.y });
    obj.visible = this.explored(x, y);
    this.chunkObjects[c].add(obj);
    if (this.chunkVisible[c]) this.objects.addChild(obj);
  }

  private removeStatic(obj: Container, x: number, y: number, chunk?: number): void {
    this.chunkObjects[chunk ?? this.sim.map.chunkOf(Math.round(x), Math.round(y))].delete(obj);
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
    placing: BuildingType | null = null,
  ) {
    this.view = view;
    this.nowMs = timeMs;
    this.syncHeights(timeMs);
    this.syncTerritory();
    this.syncVisibleChunks();
    this.unloadHiddenChunks(timeMs);
    this.syncChangedTiles();
    this.syncBuildings();
    this.syncSettlers(alpha, timeMs);
    this.animals.sync(alpha, timeMs, view);
    this.swayTrees(timeMs);
    this.effects.update(this.lastFrameMs ? timeMs - this.lastFrameMs : 16, timeMs, this.chunkVisible);
    this.lastFrameMs = timeMs;
    this.syncFog(timeMs);
    this.drawShots(alpha);
    this.drawMarks(ghost, selected, hover, area);
    this.drawHints(placing, timeMs);
  }

  /**
   * While a building is being placed, marks every spot in view where it fits, at the centre of the
   * would-be footprint (as in Settlers 4): green on level ground, yellow where a digger must level
   * it first. Recomputed when the view, the type, territory or buildings change, and every 600 ms
   * (trees grow, settlers move); only tiles the player owns are tested, so the cost follows the
   * visible territory.
   */
  private drawHints(type: BuildingType | null, timeMs: number): void {
    if (!type) {
      if (this.hintKey) {
        this.hints.clear();
        this.hintKey = '';
      }
      return;
    }
    const v = this.view;
    const key = `${type}|${Math.round(v.x / 64)},${Math.round(v.y / 64)},${Math.round(v.w / 64)}|${this.sim.territoryVersion}|${this.sim.buildingsVersion}`;
    if (key === this.hintKey && timeMs - this.hintAt < 600) return;
    this.hintKey = key;
    this.hintAt = timeMs;
    const g = this.hints;
    g.clear();
    const { map } = this.sim;
    const def = BUILDINGS[type];
    const corners = [toTile(v.x, v.y), toTile(v.x + v.w, v.y), toTile(v.x, v.y + v.h), toTile(v.x + v.w, v.y + v.h)];
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x))) - 2);
    const x1 = Math.min(map.w - 1, Math.ceil(Math.max(...corners.map((c) => c.x))) + 2);
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y))) - 2);
    const y1 = Math.min(map.h - 1, Math.ceil(Math.max(...corners.map((c) => c.y))) + 2);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (map.owner[map.idx(x, y)] !== LOCAL_PLAYER || !this.sim.canPlace(type, x, y)) continue;
        const cx = x + (def.w - 1) / 2;
        const cy = y + (def.h - 1) / 2;
        const p = this.surface(cx, cy);
        if (p.x < v.x - 32 || p.x > v.x + v.w + 32 || p.y < v.y - 32 || p.y > v.y + v.h + 32) continue;
        const flat = def.terrain === 'mountain' || !needsLevelling(map, type, x, y);
        g.ellipse(p.x, p.y, flat ? 6 : 4.5, flat ? 3.2 : 2.4).fill({ color: flat ? 0x4fd84a : 0xe8cf3a, alpha: 0.9 });
        g.ellipse(p.x, p.y, flat ? 6 : 4.5, flat ? 3.2 : 2.4).stroke({ width: 1, color: 0x10240c, alpha: 0.7 });
      }
    }
  }

  /** Whether the local player has seen the tile (always true with the fog off). */
  private explored(x: number, y: number): boolean {
    return !this.fogOn || this.sim.isExplored(Math.round(x), Math.round(y), LOCAL_PLAYER);
  }

  private syncFog(timeMs: number): void {
    if (!this.fogOn || timeMs - this.lastFogSync < 150) return;
    this.lastFogSync = timeMs;
    const { map } = this.sim;
    for (let c = 0; c < this.fogChunks.length; c++) {
      if (!this.chunkVisible[c]) continue;
      const x0 = (c % map.chunksX) * CHUNK;
      const y0 = Math.floor(c / map.chunksX) * CHUNK;
      const x1 = Math.min(map.w, x0 + CHUNK);
      const y1 = Math.min(map.h, y0 + CHUNK);
      // The chunk's tiles plus a one-tile margin (it feeds the blend at the edges), as last drawn.
      const W = CHUNK + 2;
      let prev = this.fogPrev[c];
      let changed = prev === null || this.fogMesh[c] === null;
      if (!prev) prev = this.fogPrev[c] = new Uint8Array(W * W);
      for (let ty = 0; ty < W; ty++) {
        for (let tx = 0; tx < W; tx++) {
          const x = Math.min(map.w - 1, Math.max(0, x0 - 1 + tx));
          const y = Math.min(map.h - 1, Math.max(0, y0 - 1 + ty));
          const st = this.fogState(x, y);
          if (st !== prev[ty * W + tx]) {
            prev[ty * W + tx] = st;
            changed = true;
          }
          if (x >= x0 && x < x1 && y >= y0 && y < y1) this.fogSeen[map.idx(x, y)] = st;
        }
      }
      if (!changed) continue;
      this.drawFogChunk(c, x0, y0, x1, y1, prev);
      for (const obj of this.chunkObjects[c]) {
        const at = this.staticAt.get(obj);
        if (at) obj.visible = this.fogSeen[map.idx(Math.round(at.x), Math.round(at.y))] !== 0;
      }
    }
  }

  private fogState(x: number, y: number): number {
    return !this.sim.isExplored(x, y, LOCAL_PLAYER) ? 0 : this.sim.isVisible(x, y, LOCAL_PLAYER) ? 2 : 1;
  }

  private drawFogChunk(c: number, x0: number, y0: number, x1: number, y1: number, states: Uint8Array): void {
    const W = CHUNK + 2;
    let canvas = this.fogCanvas[c];
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = W;
      this.fogCanvas[c] = canvas;
    }
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(W, W);
    const ALPHA = [255, 107, 0]; // unexplored, explored out of sight (0.42), in sight
    for (let k = 0; k < W * W; k++) {
      img.data[k * 4] = 5;
      img.data[k * 4 + 1] = 7;
      img.data[k * 4 + 2] = 10;
      img.data[k * 4 + 3] = ALPHA[states[k]];
    }
    ctx.putImageData(img, 0, 0);
    let tex = this.fogTex[c];
    if (tex) tex.source.update();
    else tex = this.fogTex[c] = new Texture({ source: new CanvasSource({ resource: canvas, scaleMode: 'linear' }) });
    if (this.fogMesh[c]) return;
    const vertices: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const cols = x1 - x0 + 1;
    for (let vy = y0; vy <= y1; vy++) {
      for (let vx = x0; vx <= x1; vx++) {
        const p = this.corner(vx, vy);
        vertices.push(p.x, p.y);
        // Corner (vx, vy) sits at tile coordinate (vx − ½, vy − ½); texel k's centre is tile x0 − 1 + k.
        uvs.push((vx - x0 + 1) / W, (vy - y0 + 1) / W);
      }
    }
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < x1 - x0; x++) {
        const a = y * cols + x;
        indices.push(a, a + 1, a + cols + 1, a, a + cols + 1, a + cols);
      }
    }
    const mesh = new MeshSimple({
      texture: tex,
      vertices: new Float32Array(vertices),
      uvs: new Float32Array(uvs),
      indices: new Uint32Array(indices),
    });
    this.fogMesh[c] = mesh;
    this.fogChunks[c].addChild(mesh);
  }

  /** Each arrow flies on a shallow arc from the shooter's shoulder to the target. */
  private drawShots(alpha: number): void {
    const g = this.shots;
    g.clear();
    const now = this.sim.tick + alpha;
    let newest = this.lastShotTick;
    for (const shot of this.sim.shots) {
      if (shot.tick > this.lastShotTick) {
        newest = Math.max(newest, shot.tick);
        const from = this.surface(shot.x0, shot.y0);
        this.sound('twang', from.x, from.y);
      }
    }
    this.lastShotTick = newest;
    for (const shot of this.sim.shots) {
      const p = Math.min(1, Math.max(0, (now - shot.tick) / SHOT_TICKS));
      const a = this.surface(shot.x0, shot.y0);
      const b = this.surface(shot.x1, shot.y1);
      const at = (k: number) => ({
        x: a.x + (b.x - a.x) * k,
        y: a.y - 18 + (b.y - 12 - (a.y - 18)) * k - Math.sin(Math.PI * k) * 14,
      });
      const head = at(p);
      const tail = at(Math.max(0, p - 0.18));
      const color = Number.parseInt(PLAYER_COLORS[(shot.owner - 1) % PLAYER_COLORS.length].slice(1), 16);
      g.moveTo(tail.x, tail.y).lineTo(head.x, head.y).stroke({ width: 1.5, color: 0x3b2b1a });
      g.circle(tail.x, tail.y, 1.2).fill({ color });
    }
  }

  /**
   * Gives back the render data of chunks long out of view: at most a few per call, the longest
   * hidden first, and only while more chunks are built than `KEEP_CHUNKS` (so small maps never
   * unload). Called about once a second.
   */
  private unloadHiddenChunks(timeMs: number): void {
    if (timeMs - this.lastUnload < 1000) return;
    this.lastUnload = timeMs;
    let ready = 0;
    for (let c = 0; c < this.chunkReady.length; c++) ready += this.chunkReady[c];
    if (ready <= KEEP_CHUNKS) return;
    const stale: number[] = [];
    for (let c = 0; c < this.chunkReady.length; c++) {
      if (this.chunkReady[c] && !this.chunkVisible[c] && timeMs - this.chunkHiddenAt[c] > UNLOAD_AFTER_MS) stale.push(c);
    }
    stale.sort((a, b) => this.chunkHiddenAt[a] - this.chunkHiddenAt[b] || a - b);
    for (const c of stale.slice(0, Math.min(UNLOADS_PER_CALL, ready - KEEP_CHUNKS))) this.unloadChunk(c);
  }

  private unloadChunk(c: number): void {
    const { map } = this.sim;
    this.chunkReady[c] = 0;
    this.groundLayers[c]?.destroy({ children: true });
    this.groundLayers[c] = null;
    for (const rock of this.boulders[c]) this.removeStatic(rock, 0, 0, c);
    this.boulders[c] = [];
    const x0 = (c % map.chunksX) * CHUNK;
    const y0 = Math.floor(c / map.chunksX) * CHUNK;
    for (let y = y0; y < Math.min(map.h, y0 + CHUNK); y++) {
      for (let x = x0; x < Math.min(map.w, x0 + CHUNK); x++) {
        const i = map.idx(x, y);
        for (const list of [this.treeSprites, this.depositSprites, this.signSprites]) {
          const sprite = list[i];
          if (sprite) this.removeStatic(sprite, x, y);
          list[i] = null;
        }
        for (const list of [this.cropSprites, this.pathSprites]) {
          list[i]?.destroy();
          list[i] = null;
        }
        this.treeState[i] = 0;
        this.depositState[i] = 0;
        this.signState[i] = 0;
        this.cropState[i] = 0;
        this.pathState[i] = 0;
      }
    }
    // Tiles re-sync on the next view; territory is redrawn by `ensureChunk`.
    this.chunkSeen[c] = -1;
    this.territoryChunks[c].clear();
    this.territoryPending[c] = 1;
    this.fogMesh[c]?.destroy();
    this.fogMesh[c] = null;
    this.fogTex[c]?.destroy(true);
    this.fogTex[c] = null;
    this.fogCanvas[c] = null;
    this.fogPrev[c] = null;
  }

  private syncVisibleChunks(): void {
    const { x, y, w, h } = this.view;
    const b = this.chunkBounds;
    // Building a chunk for the first time is the costly part; spread a sudden zoom-out over frames.
    let builds = CHUNK_BUILDS_PER_FRAME;
    for (let c = 0; c < this.chunkVisible.length; c++) {
      const k = c * 4;
      const visible = b[k] < x + w && b[k + 2] > x && b[k + 1] < y + h && b[k + 3] > y ? 1 : 0;
      if (visible === this.chunkVisible[c]) continue;
      if (visible && !this.chunkReady[c] && builds-- <= 0) continue; // next frame
      this.chunkVisible[c] = visible;
      if (visible) this.ensureChunk(c);
      else this.chunkHiddenAt[c] = this.nowMs;
      this.groundChunks[c].visible = visible === 1;
      this.territoryChunks[c].visible = visible === 1;
      this.fogChunks[c].visible = visible === 1 && this.fogOn;
      for (const obj of this.chunkObjects[c]) {
        if (visible) this.objects.addChild(obj);
        else this.objects.removeChild(obj);
      }
    }
  }

  private syncChangedTiles(): void {
    const { map } = this.sim;
    for (let c = 0; c < this.chunkSeen.length; c++) {
      // Chunks out of view keep a stale version and catch up once they are shown.
      if (!this.chunkVisible[c] || map.chunkVersion[c] === this.chunkSeen[c]) continue;
      this.chunkSeen[c] = map.chunkVersion[c];
      const x0 = (c % map.chunksX) * CHUNK;
      const y0 = Math.floor(c / map.chunksX) * CHUNK;
      for (let y = y0; y < Math.min(map.h, y0 + CHUNK); y++) {
        for (let x = x0; x < Math.min(map.w, x0 + CHUNK); x++) {
          const i = map.idx(x, y);
          this.syncTree(i);
          this.syncDeposit(i);
          this.syncCrop(i);
          this.syncPath(i);
          this.syncSign(i);
        }
      }
    }
  }

  private syncTree(i: number): void {
    const { map } = this.sim;
    const stage = map.tree[i];
    if (stage === this.treeState[i]) return;
    const felled = this.treeState[i] === TREE_MATURE && stage === 0;
    this.treeState[i] = stage;
    let s = this.treeSprites[i];
    const x = i % map.w;
    const y = Math.floor(i / map.w);
    if (stage === 0) {
      if (s) {
        // A felled tree topples over before it goes; the sprite leaves its chunk right away.
        const sprite = s;
        if (felled && this.effects.fellTree(sprite, this.nowMs, (t) => t.destroy())) {
          this.chunkObjects[map.chunkOf(x, y)].delete(sprite);
          this.sound('fall', sprite.x, sprite.y);
        } else {
          this.removeStatic(sprite, x, y);
        }
        this.treeSprites[i] = null;
      }
      return;
    }
    if (!s) {
      const h = hash(i);
      s = new Sprite(this.atlas.get(`tree:${h % 4}`));
      s.label = 'tree';
      const p = this.surface(x, y);
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
    for (const c of dirty) {
      if (this.chunkReady[c]) this.drawTerritoryChunk(c);
      else this.territoryPending[c] = 1;
    }
  }

  private drawTerritoryChunk(c: number): void {
    const { map } = this.sim;
    const g = this.territoryChunks[c];
    g.clear();
    const x0 = (c % map.chunksX) * CHUNK;
    const y0 = Math.floor(c / map.chunksX) * CHUNK;
    const x1 = Math.min(map.w, x0 + CHUNK);
    const y1 = Math.min(map.h, y0 + CHUNK);
    const ownerAt = (x: number, y: number) => (map.inBounds(x, y) ? map.owner[map.idx(x, y)] : 0);
    let dim = false;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (ownerAt(x, y) === LOCAL_PLAYER) continue;
        g.poly(this.diamond(x, y));
        dim = true;
      }
    }
    if (dim) g.fill({ color: 0x0b1420, alpha: 0.3 });
    // Every player's border in its colour: edges between a tile it owns and one it does not.
    const owners = new Set<number>();
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (ownerAt(x, y)) owners.add(ownerAt(x, y));
    for (const player of owners) this.drawBorder(g, player, x0, y0, x1, y1, ownerAt);
  }

  /**
   * A player's border as in Settlers 4: a row of little posts topped with a cube in the player's
   * colour, two on every border edge (between an owned tile and one that is not).
   */
  private drawBorder(
    g: Graphics,
    player: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    ownerAt: (x: number, y: number) => number,
  ): void {
    const owned = (x: number, y: number) => ownerAt(x, y) === player;
    const color = PLAYER_COLORS[(player - 1) % PLAYER_COLORS.length];
    const posts: [number, number][] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!owned(x, y)) continue;
        // Edges as [corner a, corner b, outside]; a post sits at the edge's midpoint.
        const edges: [number, number, number, number, boolean][] = [
          [x + 1, y, x + 1, y + 1, !owned(x + 1, y)],
          [x, y + 1, x, y, !owned(x - 1, y)],
          [x + 1, y + 1, x, y + 1, !owned(x, y + 1)],
          [x, y, x + 1, y, !owned(x, y - 1)],
        ];
        for (const [ax, ay, bx, by, edge] of edges) {
          if (!edge) continue;
          // Two posts per edge, at a quarter and three quarters of its length.
          const a = this.corner(ax, ay);
          const b = this.corner(bx, by);
          for (const t of [0.25, 0.75]) posts.push([a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t]);
        }
      }
    }
    if (posts.length === 0) return;
    // Shadows, then posts, then the cubes (three faces each: lit top, left side, darker right side).
    for (const [px, py] of posts) g.ellipse(px + 2, py + 0.8, 3, 1.4);
    g.fill({ color: 0x000000, alpha: 0.35 });
    for (const [px, py] of posts) g.rect(px - 0.9, py - 6, 1.8, 6);
    g.fill({ color: 0x2a2620 });
    const s = 2.6;
    for (const [px, py] of posts) {
      const top = py - 7.5;
      g.poly([px, top - s * 0.5, px + s, top, px, top + s * 0.5, px - s, top]);
    }
    g.fill({ color: shadeColor(color, 1.25) });
    for (const [px, py] of posts) {
      const top = py - 7.5;
      g.poly([px - s, top, px, top + s * 0.5, px, top + s * 0.5 + s, px - s, top + s]);
    }
    g.fill({ color });
    for (const [px, py] of posts) {
      const top = py - 7.5;
      g.poly([px, top + s * 0.5, px + s, top, px + s, top + s, px, top + s * 0.5 + s]);
    }
    g.fill({ color: shadeColor(color, 0.65) });
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
      const p = this.surface(x, y);
      s.position.set(p.x, p.y);
      this.groundChunks[map.chunkOf(x, y)].addChild(s);
      this.cropSprites[i] = s;
    }
    s.texture = this.atlas.get(`field:${CROP_KINDS[map.cropKind[i]]}:${stage}`);
    s.anchor.copyFrom(s.texture.defaultAnchor!);
  }

  /** Worn paths: a ground decal per level (dusty path, road), under fields and everything standing. */
  private syncPath(i: number): void {
    const { map } = this.sim;
    const level = pathLevel(map.wear[i]);
    if (level === this.pathState[i]) return;
    this.pathState[i] = level;
    let s = this.pathSprites[i];
    if (level === 0) {
      s?.destroy();
      this.pathSprites[i] = null;
      return;
    }
    const x = i % map.w;
    const y = Math.floor(i / map.w);
    if (!s) {
      s = new Sprite();
      const p = this.surface(x, y);
      s.position.set(p.x, p.y);
      // Right above the ground mesh (child 0), below the field decals.
      this.groundChunks[map.chunkOf(x, y)].addChildAt(s, Math.min(1, this.groundChunks[map.chunkOf(x, y)].children.length));
      this.pathSprites[i] = s;
    }
    s.texture = this.atlas.get(`path:${level}:${hash(i) % PATH_VARIANTS}`);
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
      const p = this.surface(x, y);
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
      const p = this.surface(x, y);
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
      this.effects.detachBuilding(id);
    }
    for (const b of this.sim.buildings.values()) {
      let v = this.buildingViews.get(b.id);
      if (!v) v = this.createBuildingView(b);
      if (v.owner !== b.owner) {
        v.owner = b.owner;
        v.flag.texture = this.atlas.get(`flag:${b.owner}`);
        if (v.banner) v.banner.texture = this.atlas.get(`banner:${b.owner}`);
      }
      if (v.banner) v.banner.visible = b.done;
      v.flag.visible = !v.banner && this.occupied(b);
      if (v.flag.visible && !v.flagPlaced) {
        const top = this.atlas.topOf(`building:${b.type}`);
        v.flag.position.set(top.x, top.y + 2);
        v.flagPlaced = true;
      }
      const progress = this.sim.buildProgress(b);
      const staged = this.atlas.has(`stage:${b.type}:0`);
      v.site.visible = !b.done && !staged;
      if (!b.done && staged) {
        // Pre-rendered construction stages: stakes while the diggers clear the site, then the timber
        // frame, the lower walls and the walls with half the roof as the builders work.
        const stage = !b.levelled ? 0 : Math.min(ART3D_STAGES - 1, 1 + Math.floor(progress * (ART3D_STAGES - 1)));
        v.main.texture = this.atlas.get(`stage:${b.type}:${stage}`);
        v.main.anchor.copyFrom(v.main.texture.defaultAnchor!);
        v.main.visible = true;
      } else if (b.done) {
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

  /**
   * The door flag goes up once a building is in use: a workplace when its worker has moved in, a
   * military building while garrisoned (the castle always), anything else once built.
   */
  private occupied(b: Building): boolean {
    if (!b.done) return false;
    const def = BUILDINGS[b.type];
    if (def.worker) return b.workerId !== null;
    if (def.garrison) return b.garrison.length > 0 || !!def.garrison.claimsWhenEmpty;
    return true;
  }

  private createBuildingView(b: Building): BuildingView {
    const cx = b.x + (b.w - 1) / 2;
    const cy = b.y + (b.h - 1) / 2;
    const p = this.surface(cx, cy);
    const body = new Container();
    body.position.set(p.x, p.y);
    body.zIndex = depthOf(cx, cy) + 0.25;
    const site = new Sprite(this.atlas.get(b.w >= 3 ? 'building:site3' : 'building:site2'));
    const main = new Sprite();
    body.addChild(site, main);
    // The owner's banner over military buildings; a 3D model brings its own pole position.
    const at = (this.atlas.art3d && ART3D_BANNERS[b.type]) || BANNERS[b.type];
    const banner = at ? new Sprite(this.atlas.get(`banner:${b.owner}`)) : null;
    if (banner && at) {
      banner.position.set(at.x, at.y);
      banner.visible = b.done;
      body.addChild(banner);
    }

    const front = new Container();
    const d = this.surface(b.door.x, b.door.y);
    front.position.set(d.x, d.y);
    front.zIndex = depthOf(b.door.x, b.door.y) - 0.05;
    // The flag stands on top of the building (placed when the finished texture is shown); military
    // buildings show their banner instead.
    const flag = new Sprite(this.atlas.get(`flag:${b.owner}`));
    flag.visible = false;
    body.addChild(flag);
    this.effects.attachBuilding(b, body);

    this.addStatic(body, cx, cy);
    this.addStatic(front, b.door.x, b.door.y);
    const v: BuildingView = {
      owner: b.owner,
      flag,
      flagPlaced: false,
      banner,
      at: { x: cx, y: cy },
      doorAt: { ...b.door },
      body,
      site,
      main,
      front,
      pileKey: '',
    };
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
    // Drop the old pile.
    while (v.front.children.length > 0) v.front.children[0].destroy();
    // Each kind of goods gets its own spot: output to the right of the door (down the +x edge),
    // inputs and site materials to the left along the front wall; a fifth kind starts a second row
    // nearer the camera.
    const spot = (side: 1 | -1, k: number): [number, number] => {
      const col = k % 4;
      const row = Math.floor(k / 4);
      return side === 1
        ? [20 + col * 17 - row * 16, -4 + col * 8.5 + row * 8]
        : [-22 - col * 17 - row * 16, -4 - col * 8.5 + row * 8];
    };
    // Next free spot per side; goods beyond PILE_MAX start another pile on the next spot.
    const next = { [1]: 0, [-1]: 0 };
    const stack = (res: Resource, count: number, side: 1 | -1) => {
      for (let left = count; left > 0; left -= PILE_MAX) {
        const n = Math.min(left, PILE_MAX);
        const [x, y] = spot(side, next[side]++);
        // A pre-rendered pile of exactly this many (`?art=3d`), else single wares stacked up.
        const pile = `pile:${res}:${n}`;
        if (this.atlas.has(pile)) {
          const s = new Sprite(this.atlas.get(pile));
          s.position.set(x, y);
          v.front.addChild(s);
          continue;
        }
        for (let i = 0; i < n; i++) {
          const s = new Sprite(this.atlas.get(`ware:${res}`));
          s.position.set(x - 12 + (i % 2) * 7, y + 12 - Math.floor(i / 2) * 4);
          v.front.addChild(s);
        }
      }
    };
    for (const r of RESOURCES) if (b.output[r] > 0) stack(r, b.output[r], 1);
    for (const r of RESOURCES) if (b.input[r] > 0) stack(r, b.input[r], -1);
    if (waitingPlank > 0) stack('plank', waitingPlank, -1);
    if (waitingStone > 0) stack('stone', waitingStone, -1);
  }

  private syncSettlers(alpha: number, timeMs: number): void {
    if (this.settlerViews.size > this.sim.settlers.length) {
      // Some settlers died.
      for (const [id, v] of this.settlerViews) {
        if (this.sim.settlerById.has(id)) continue;
        v.root.destroy({ children: true });
        this.settlerViews.delete(id);
      }
    }
    for (const s of this.sim.settlers) {
      let v = this.settlerViews.get(s.id);
      if (!v) v = this.createSettlerView(s);
      let x = s.px + (s.x - s.px) * alpha;
      let y = s.py + (s.y - s.py) * alpha;
      const foe = s.opponent !== null ? this.sim.getSettler(s.opponent) : undefined;
      if (foe) {
        // Several duels at one door: each pair gets its own spot instead of drawing on top of the others.
        const [ox, oy] = FIGHT_SPOTS[Math.min(s.id, foe.id) % FIGHT_SPOTS.length];
        x += ox;
        y += oy;
      }
      // Screen point on the terrain (inline `surface`, no allocation per settler).
      const px = (x - y) * HALF_W;
      const py = (x + y) * HALF_H - this.sim.map.heightAt(x, y);
      const view = this.view;
      // Other players' settlers show only where the local player has sight.
      const seen =
        !this.fogOn || s.owner === LOCAL_PLAYER || this.sim.isVisible(Math.round(x), Math.round(y), LOCAL_PLAYER);
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
      const hurt = s.hp < v.hp;
      v.hp = s.hp;
      // Walked distance drives the walk cycle; jumps (entering, leaving, loading) do not count.
      const step = Math.abs(x - v.lastX) + Math.abs(y - v.lastY);
      if (step < 1.5) v.walked += Math.hypot(x - v.lastX, y - v.lastY);
      v.lastX = x;
      v.lastY = y;
      if (!onScreen) continue;
      if (hurt) {
        this.effects.hit(px, py - 16);
        this.sound('clash', px, py);
      }
      if (v.kind !== s.kind) this.styleSettler(v, s);
      const style = styleOf(s.kind);

      const dx = s.x - s.px;
      const dy = s.y - s.py;
      const moving = dx !== 0 || dy !== 0;
      const working = s.working || foe !== undefined;
      let dir = v.dir;
      if (foe) dir = dirTowards(s.x, s.y, foe.x, foe.y, dir);
      else if (moving) dir = dirFromTileVelocity(dx, dy, dir);
      else if (working && this.workTarget(s)) dir = dirTowards(s.x, s.y, this.tx, this.ty, dir);
      // Idle settlers chatting in pairs (`idle.ts`) face each other.
      const partner = !moving && !working && s.chatWith !== null ? chatPartner(this.sim, s) : undefined;
      if (partner) dir = dirTowards(s.x, s.y, partner.x, partner.y, dir);
      v.dir = dir;
      // Idle settlers glance around now and then (not while talking to someone).
      const shown = moving || working || partner ? dir : idleDir(timeMs, s.id, dir);
      const pd = PAINTED_DIR[shown];
      const tex = this.settlerTex;

      // Work or hold frame: the same indices drive the layered figure and the 3D frames.
      let action: ActionId | null = null;
      let f: number;
      if (working) {
        action = this.actionOf(s, style);
        const def: ActionDef = ACTIONS[action];
        f = workFrame(timeMs, s.id, def.loopMs);
        if (f !== v.frame) {
          v.frame = f;
          if (def.sound && f === def.soundFrame) this.sound(def.sound, px, py);
        }
      } else {
        v.frame = -1;
        f = moving ? walkFrame(v.walked) : WALK_FRAMES;
      }
      const tool = s.carrying !== null ? 'carry' : style.holds;
      const s3d = this.settler3d;
      let bob = 0;
      if (s3d) {
        // Pre-rendered figure: full frame, its tunic/shield part tinted, the hat on top; 8 painted
        // directions, so no mirroring.
        const fr = action ? s3d.work[action][shown][f] : s3d.hold[tool][shown][f];
        setFrame(v.body, fr.full);
        v.tunic.visible = fr.tint !== null;
        if (fr.tint) setFrame(v.tunic, fr.tint);
        const hat = s3d.hats[style.hatStyle][shown];
        v.hat.visible = hat !== null;
        if (hat) setFrame(v.hat, hat);
        v.head.visible = v.arm.visible = false;
        v.root.scale.x = 1;
        const away = s3d.carryBehind[shown];
        if (away !== v.armBehind) {
          v.armBehind = away;
          v.root.setChildIndex(v.ware, away ? 0 : 5);
        }
      } else {
        if (action) {
          v.body.texture = tex.body[pd][BODY_WORK];
          v.arm.texture = tex.workArm[action][pd][f];
        } else {
          v.body.texture = tex.body[pd][moving ? f : BODY_STAND];
          v.arm.texture = tex.holdArm[tool][pd][f];
          if (moving) bob = walkBob(f);
        }
        v.tunic.texture = tex.tunic[pd];
        v.head.texture = tex.head[pd];
        v.hat.texture = tex.hat[style.hatStyle][pd];
        const behind = FACES_AWAY[pd];
        if (behind !== v.armBehind) {
          // Facing away, the near arm, its tool and the goods in hand are hidden behind the body.
          v.armBehind = behind;
          v.root.setChildIndex(v.arm, behind ? 0 : 4);
          v.root.setChildIndex(v.ware, behind ? 0 : 5);
        }
        v.root.scale.x = MIRRORED[shown] ? -1 : 1;
      }

      v.rank.visible = s.level > 0;
      if (s.level > 0) v.rank.texture = this.atlas.get(`chevrons:${s.level}`);
      v.root.position.set(px, py + bob);
      v.root.zIndex = depthOf(x, y) + 0.01;
      v.ware.visible = s.carrying !== null;
      if (s.carrying) {
        v.ware.texture = this.wareTex[s.carrying];
        const at = s3d ? s3d.carryAt[shown][action ? WALK_FRAMES : f] : CARRY_AT[pd];
        v.ware.position.set(at[0], at[1]);
      }
    }
  }

  /** What a working settler is doing: the task's own action (sowing, reaping…) or the profession's. */
  private actionOf(s: Settler, style: SettlerStyle): ActionId {
    const t = s.tasks[0];
    if (t?.t === 'plant') return PLANT_ACTION[t.what];
    if (t?.t === 'gather') return GATHER_ACTION[t.res] ?? style.work;
    return style.work;
  }

  /** Puts the point a working settler faces in `tx/ty`; false when the task has none. */
  private workTarget(s: Settler): boolean {
    const t = s.tasks[0];
    if (!t) return false;
    if (t.t === 'gather' || t.t === 'plant' || t.t === 'prospect') {
      this.tx = t.x;
      this.ty = t.y;
      return true;
    }
    if (t.t === 'build' || t.t === 'dig' || t.t === 'assault') {
      const b = this.buildingViews.get(t.b);
      if (!b) return false;
      this.tx = b.at.x;
      this.ty = b.at.y;
      return true;
    }
    return false;
  }

  /** Tints the layers for the settler's profession (fighters wear their owner's colour). */
  private styleSettler(v: SettlerView, s: Settler): void {
    const style = styleOf(s.kind);
    v.kind = s.kind;
    // 3D figures wear their owner's colour, as in Settlers 4 (the tool and hat tell the profession).
    const own = style.fighter || this.settler3d !== null;
    v.tunic.tint = own ? this.playerTint[(s.owner - 1) % this.playerTint.length] : this.tintOf(style.tunic);
    v.hat.tint = this.tintOf(style.hat);
  }

  private tintOf(hex: string): number {
    let t = this.tints.get(hex);
    if (t === undefined) {
      t = toTint(hex);
      this.tints.set(hex, t);
    }
    return t;
  }

  /** Trees in visible chunks lean gently in the wind (a skew about the trunk base). */
  private swayTrees(timeMs: number): void {
    // Far out the sway is invisible; skip the work.
    if (this.view.w > 3200) return;
    const { map } = this.sim;
    const t = timeMs * 0.0012;
    for (let c = 0; c < this.chunkVisible.length; c++) {
      if (!this.chunkVisible[c]) continue;
      const x0 = (c % map.chunksX) * CHUNK;
      const y0 = Math.floor(c / map.chunksX) * CHUNK;
      const x1 = Math.min(map.w, x0 + CHUNK);
      const y1 = Math.min(map.h, y0 + CHUNK);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const tree = this.treeSprites[y * map.w + x];
          if (tree) tree.skew.x = Math.sin(t + x * 0.37 + y * 0.23) * 0.03;
        }
      }
    }
  }

  private createSettlerView(s: Settler): SettlerView {
    const tex = this.settlerTex;
    const root = new Container();
    const layer = (t: Texture) => {
      const sp = new Sprite(t);
      sp.anchor.copyFrom(t.defaultAnchor!);
      return sp;
    };
    const body = layer(tex.body[2][BODY_STAND]);
    const tunic = layer(tex.tunic[2]);
    const head = layer(tex.head[2]);
    const hat = layer(tex.hat.cap[2]);
    const arm = layer(tex.holdArm.none[2][WALK_FRAMES]);
    const ware = new Sprite(this.wareTex.log);
    ware.scale.set(0.85);
    ware.visible = false;
    const rank = new Sprite(this.atlas.get('chevrons:1'));
    rank.position.set(0, this.settler3d ? this.settler3d.rankY : -40);
    rank.visible = false;
    root.addChild(body, tunic, head, hat, arm, ware, rank);
    const v: SettlerView = {
      root,
      body,
      tunic,
      head,
      hat,
      arm,
      ware,
      rank,
      dir: 2,
      walked: 0,
      lastX: s.x,
      lastY: s.y,
      armBehind: false,
      hp: s.hp,
      kind: '',
      frame: -1,
    };
    this.styleSettler(v, s);
    this.settlerViews.set(s.id, v);
    return v;
  }

  /** Tile outline following the terrain, shrunk towards its center by `inset` pixels (vertically). */
  private diamond(x: number, y: number, inset = 0): number[] {
    const c = this.surface(x, y);
    const k = 1 - inset / HALF_H;
    return [this.corner(x, y), this.corner(x + 1, y), this.corner(x + 1, y + 1), this.corner(x, y + 1)].flatMap((p) => [
      c.x + (p.x - c.x) * k,
      c.y + (p.y - c.y) * k,
    ]);
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
      const p = this.surface(ghost.x + (def.w - 1) / 2, ghost.y + (def.h - 1) / 2);
      this.ghostSprite.texture = this.atlas.get(`building:${ghost.type}`);
      this.ghostSprite.anchor.copyFrom(this.ghostSprite.texture.defaultAnchor!);
      this.ghostSprite.position.set(p.x, p.y);
      this.ghostSprite.tint = ghost.valid ? 0xc8ffc8 : 0xff9090;
      this.ghostSprite.visible = true;
    }
  }
}

/** A colour (0xRRGGBB, or a CSS hex string) scaled in brightness, clamped. */
function shadeColor(color: number | string, k: number): number {
  const c = typeof color === 'string' ? parseInt(color.replace('#', ''), 16) : color;
  const ch = (v: number) => Math.min(255, Math.round(v * k));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}
