import { MILL_SAIL_FRAMES } from './art3d';
import { Container, Sprite, type Texture } from 'pixi.js';
import { TERRAIN } from '../sim/config';
import type { Building } from '../sim/types';
import type { World } from '../sim/world';
import type { SpriteAtlas } from './atlas';
import { BUILDING_FX, WORKING_GRACE_MS, type SoundId } from './animConfig';
import { CHUNK } from '../sim/map';
import { ART3D_FX } from './art3d';
import { buildingFxAnchors, type FxAnchors } from './sprites';

/** Particle budget: the oldest particles are recycled first when it runs out. */
const MAX_PARTICLES = 700;
const SMOKE_EVERY_MS = 170;
const DUST_EVERY_MS = 220;
const FALL_MS = 750;
const FADE_MS = 350;
/** Death puff (`soul`): how long it stays in the air, how fast it rises (px/s), how late it fades. */
const SOUL_MS = 3800;
const SOUL_RISE = 14;
const SOUL_FADE = 3;
/** A working building's ambient sound (saw, anvil, furnace) repeats this often. */
const AMBIENT_EVERY_MS = 1300;

type Point = { x: number; y: number };

/** `a` moved towards `b` by `t` (0..1), per channel: lighter shades of a player's colour. */
function mixTint(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return Math.round(ca + (cb - ca) * t) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

interface BuildingFxView {
  b: Building;
  body: Container;
  smoke: [number, number][];
  smokeTint: number;
  smokeMode: 'always' | 'working' | null;
  glows: Sprite[];
  sails: Sprite | null;
  /** How far the sails have turned (radians). */
  sailAngle: number;
  lastTimer: number;
  lastProgress: number;
  activeUntil: number;
  /** Accumulated time towards the next puff. */
  emitMs: number;
  ambient: SoundId | null;
  soundMs: number;
  wasDone: boolean;
}

interface Falling {
  sprite: Sprite;
  start: number;
  dir: number;
  baseScaleX: number;
  done: (s: Sprite) => void;
  landed: boolean;
}

/**
 * Live, purely visual effects. Everything here reads sim state and never writes it; all sprites are
 * pooled or attached to existing views, so a steady frame allocates nothing. Effects run only for
 * things on screen (buildings in the scene, visible chunks).
 */
export class Effects {
  /** Smoke, dust, sparks and hit flashes: above the objects, under the fog. */
  readonly fxLayer = new Container();
  /** Sun glints on water: just above the ground. */
  readonly waterLayer = new Container();

  private readonly pool: Sprite[] = [];
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly age = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly s0 = new Float32Array(MAX_PARTICLES);
  private readonly s1 = new Float32Array(MAX_PARTICLES);
  private readonly a0 = new Float32Array(MAX_PARTICLES);
  /** Fade-out curve: alpha × (1 − k^fade) over the life k (1 = linear; higher holds longer, then goes). */
  private readonly fade = new Float32Array(MAX_PARTICLES);
  /** Round-robin slot for the next particle (recycles the oldest). */
  private next = 0;

  private readonly buildings = new Map<number, BuildingFxView>();
  private readonly falling: Falling[] = [];
  private readonly waterChunks: (Container | null)[];
  private readonly glintPhase: Float32Array[] = [];
  private readonly tex: Record<'puff' | 'spark' | 'glow' | 'glint' | 'flash' | 'sails', Texture>;
  /** 3D buildings are drawn (`?art=3d`): their effects sit at the anchors their renders recorded. */
  private readonly art3d: boolean;
  /** Pre-rendered 3D sail frames over a quarter turn (`?art=3d`), or null for the flat rotating sprite. */
  private readonly sailFrames: Texture[] | null;

  constructor(
    atlas: SpriteAtlas,
    private readonly sim: World,
    private readonly surface: (x: number, y: number) => Point,
    /** Positional sound hook (world pixels); the renderer filters what is off screen. */
    private readonly sound: (id: SoundId, x: number, y: number) => void,
  ) {
    this.art3d = atlas.art3d !== null;
    this.sailFrames = atlas.has('sails3d:0')
      ? Array.from({ length: MILL_SAIL_FRAMES }, (_, k) => atlas.get(`sails3d:${k}`))
      : null;
    this.tex = {
      puff: atlas.get('fx:puff'),
      spark: atlas.get('fx:spark'),
      glow: atlas.get('fx:glow'),
      glint: atlas.get('fx:glint'),
      flash: atlas.get('fx:flash'),
      sails: atlas.get('fx:sails'),
    };
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const s = new Sprite(this.tex.puff);
      s.visible = false;
      this.fxLayer.addChild(s);
      this.pool.push(s);
    }
    this.waterChunks = new Array(sim.map.chunksX * sim.map.chunksY).fill(null);
  }

  // ------------------------------------------------------------- particles

  private emit(
    tex: Texture,
    x: number,
    y: number,
    vx: number,
    vy: number,
    lifeMs: number,
    scale0: number,
    scale1: number,
    alpha: number,
    tint: number,
    fade = 1,
    add = false,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    const s = this.pool[i];
    s.texture = tex;
    s.anchor.set(0.5);
    s.tint = tint;
    s.blendMode = add || tex === this.tex.spark || tex === this.tex.flash ? 'add' : 'normal';
    s.visible = true;
    this.px[i] = x;
    this.py[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = lifeMs;
    this.s0[i] = scale0;
    this.s1[i] = scale1;
    this.a0[i] = alpha;
    this.fade[i] = fade;
    s.position.set(x, y);
    s.scale.set(scale0);
    s.alpha = alpha;
  }

  private stepParticles(dtMs: number): void {
    const dt = dtMs / 1000;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const s = this.pool[i];
      if (!s.visible) continue;
      this.age[i] += dtMs;
      const k = this.age[i] / this.life[i];
      if (k >= 1) {
        s.visible = false;
        continue;
      }
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      s.position.set(this.px[i], this.py[i]);
      s.scale.set(this.s0[i] + (this.s1[i] - this.s0[i]) * k);
      // Fade in quickly, out slowly.
      const f = this.fade[i];
      s.alpha = this.a0[i] * Math.min(1, k * 6) * (1 - (f === 1 ? k : k ** f));
    }
  }

  /** A sword blow landed: white star and a few sparks at the screen point. */
  hit(x: number, y: number): void {
    this.emit(this.tex.flash, x, y, 0, 0, 160, 0.5, 1.1, 1, 0xffffff);
    for (let k = 0; k < 5; k++) {
      const a = Math.random() * Math.PI * 2;
      const v = 30 + Math.random() * 40;
      this.emit(this.tex.spark, x, y, Math.cos(a) * v, Math.sin(a) * v - 20, 320, 0.9, 0.4, 1, 0xffffff);
    }
  }

  /**
   * A unit died at the screen point (its feet): a cloud of its owner's colour with a bright core rises
   * slowly from the body, stays clearly visible for most of its `SOUL_MS` and only then fades, with two
   * smaller wisps trailing it.
   */
  soul(x: number, y: number, tint: number): void {
    const light = mixTint(tint, 0xffffff, 0.55);
    this.emit(this.tex.puff, x, y - 16, 0, -SOUL_RISE, SOUL_MS, 0.9, 2.0, 1, tint, SOUL_FADE);
    this.emit(this.tex.puff, x, y - 16, 0, -SOUL_RISE, SOUL_MS, 0.6, 1.3, 1, mixTint(tint, 0xffffff, 0.2), SOUL_FADE); // denser body
    this.emit(this.tex.puff, x, y - 17, 0, -SOUL_RISE, SOUL_MS * 0.9, 0.45, 0.9, 0.75, light, SOUL_FADE, true); // light core
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      this.emit(this.tex.puff, x + side * 8, y - 8, side * 4, -SOUL_RISE * 0.75 - Math.random() * 4, SOUL_MS * 0.8, 0.5, 1.0, 0.9, tint, SOUL_FADE);
    }
  }

  /** Soft puffs of dust or leaves at a screen point. */
  burst(x: number, y: number, tint: number, count: number, spread: number): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      this.emit(
        this.tex.puff,
        x + Math.cos(a) * spread,
        y + Math.sin(a) * spread * 0.5,
        Math.cos(a) * 18,
        -8 - Math.random() * 10,
        700 + Math.random() * 400,
        0.25,
        0.6,
        0.55,
        tint,
      );
    }
  }

  // -------------------------------------------------------------- buildings

  /** Effect anchors of a building type: the 3D model's (`ART3D_FX`) under `?art=3d`, else the painter's. */
  private anchorsOf(type: Building['type']): FxAnchors {
    const base = buildingFxAnchors(type);
    const art = this.art3d ? ART3D_FX[type] : undefined;
    if (!art) return base;
    return { smoke: art.smoke ?? base.smoke, glow: art.glow ?? base.glow, hub: art.hub ?? base.hub };
  }

  /** Called when the renderer creates a building view; adds sails and fire glows to its body. */
  attachBuilding(b: Building, body: Container): void {
    const fx = BUILDING_FX[b.type];
    const anchors = this.anchorsOf(b.type);
    const v: BuildingFxView = {
      b,
      body,
      smoke: fx?.smoke ? anchors.smoke : [],
      smokeTint: fx?.glow ? 0x6a6662 : 0xdcdcdc,
      smokeMode: fx?.smoke ?? null,
      glows: [],
      sails: null,
      sailAngle: 0,
      lastTimer: b.timer,
      lastProgress: b.progress,
      activeUntil: 0,
      emitMs: Math.random() * SMOKE_EVERY_MS,
      ambient: fx?.sound ?? null,
      soundMs: Math.random() * AMBIENT_EVERY_MS,
      wasDone: b.done,
    };
    if (fx?.glow) {
      for (const [gx, gy] of anchors.glow) {
        const g = new Sprite(this.tex.glow);
        g.anchor.set(0.5);
        g.position.set(gx, gy);
        g.blendMode = 'add';
        g.visible = false;
        body.addChild(g);
        v.glows.push(g);
      }
    }
    if (fx?.sails && this.sailFrames) {
      // 3D sails: a frame on the building's own canvas, flipped through as they turn.
      const s = new Sprite(this.sailFrames[0]);
      s.anchor.copyFrom(this.sailFrames[0].defaultAnchor!);
      s.visible = false;
      body.addChild(s);
      v.sails = s;
    } else if (fx?.sails && anchors.hub) {
      const s = new Sprite(this.tex.sails);
      s.anchor.set(0.5);
      s.position.set(anchors.hub[0], anchors.hub[1]);
      s.scale.set(0.95, 0.9);
      s.visible = false;
      body.addChild(s);
      v.sails = s;
    }
    this.buildings.set(b.id, v);
  }

  /** Called when the renderer drops a building view (its sprites die with the body). */
  detachBuilding(id: number): void {
    this.buildings.delete(id);
  }

  private updateBuildings(dtMs: number, timeMs: number): void {
    for (const v of this.buildings.values()) {
      const { b, body } = v;
      // A workshop's recipe timer only moves while it works.
      if (b.timer !== v.lastTimer) {
        v.lastTimer = b.timer;
        v.activeUntil = timeMs + WORKING_GRACE_MS;
      }
      const working = b.done && timeMs < v.activeUntil;
      const onScreen = body.parent !== null && body.visible;
      if (v.sails) {
        v.sails.visible = b.done;
        if (onScreen && b.done) {
          v.sailAngle = (v.sailAngle + (dtMs / 1000) * (working ? 2.2 : 0.12)) % (Math.PI * 2);
          if (this.sailFrames) {
            // Four arms repeat every quarter turn.
            const q = (v.sailAngle % (Math.PI / 2)) / (Math.PI / 2);
            v.sails.texture = this.sailFrames[Math.floor(q * MILL_SAIL_FRAMES) % MILL_SAIL_FRAMES];
          } else {
            v.sails.rotation = v.sailAngle;
          }
        }
      }
      for (const g of v.glows) {
        g.visible = working && onScreen;
        if (g.visible) {
          g.alpha = 0.55 + 0.3 * Math.sin(timeMs * 0.011 + b.id) + 0.1 * Math.sin(timeMs * 0.037);
          g.scale.set(0.8 + 0.12 * Math.sin(timeMs * 0.007 + b.id));
        }
      }
      const finished = b.done && !v.wasDone;
      v.wasDone = b.done;
      if (!onScreen) continue;
      if (finished) {
        this.burst(body.x, body.y - 8, 0xd8c8a0, 8, 22);
        this.sound('complete', body.x, body.y);
      }
      if (working && v.ambient) {
        v.soundMs += dtMs;
        if (v.soundMs > AMBIENT_EVERY_MS) {
          v.soundMs = 0;
          this.sound(v.ambient, body.x, body.y - 20);
        }
      }
      // Construction dust while the builder works.
      if (!b.done) {
        if (b.progress !== v.lastProgress) {
          v.lastProgress = b.progress;
          v.emitMs += dtMs;
          if (v.emitMs > DUST_EVERY_MS) {
            v.emitMs = 0;
            const ox = (Math.random() - 0.5) * 40;
            this.burst(body.x + ox, body.y - Math.random() * 10, 0xc8a878, 1, 4);
          }
        }
        continue;
      }
      const smoking = v.smokeMode === 'always' || (v.smokeMode === 'working' && working);
      if (!smoking || v.smoke.length === 0) continue;
      v.emitMs += dtMs;
      if (v.emitMs < SMOKE_EVERY_MS) continue;
      v.emitMs = 0;
      for (const [sx, sy] of v.smoke) {
        this.emit(
          this.tex.puff,
          body.x + sx + (Math.random() - 0.5) * 2,
          body.y + sy,
          5 + Math.random() * 6,
          -16 - Math.random() * 6,
          2600 + Math.random() * 900,
          0.18,
          0.85,
          v.smokeMode === 'always' ? 0.42 : 0.6,
          v.smokeTint,
        );
      }
    }
  }

  // ------------------------------------------------------------------ trees

  /**
   * A tree was felled: animate the sprite falling over and fading, then hand it to `done` (which
   * destroys it). Returns false if the sprite is off screen (nothing to animate).
   */
  fellTree(sprite: Sprite, timeMs: number, done: (s: Sprite) => void): boolean {
    if (sprite.parent === null || !sprite.visible) return false;
    const dir = Math.random() < 0.5 ? -1 : 1;
    this.falling.push({ sprite, start: timeMs, dir, baseScaleX: sprite.scale.x, done, landed: false });
    return true;
  }

  private updateFalling(timeMs: number): void {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      const t = timeMs - f.start;
      const k = Math.min(1, t / FALL_MS);
      // Accelerating fall about the trunk base.
      f.sprite.rotation = f.dir * 1.42 * k * k;
      f.sprite.skew.x = 0;
      if (k >= 1 && !f.landed) {
        f.landed = true;
        const tipX = f.sprite.x + f.dir * 34;
        this.burst(tipX, f.sprite.y - 6, 0x7fa860, 4, 8);
      }
      if (t > FALL_MS) f.sprite.alpha = Math.max(0, 1 - (t - FALL_MS) / FADE_MS);
      if (t > FALL_MS + FADE_MS) {
        this.falling.splice(i, 1);
        f.done(f.sprite);
      }
    }
  }

  // ------------------------------------------------------------------ water

  /** Drops a chunk's glints (the renderer unloads chunks long out of view); rebuilt when seen again. */
  unloadChunk(c: number): void {
    this.waterChunks[c]?.destroy({ children: true });
    this.waterChunks[c] = null;
  }

  /** Lazily builds one glint per few water tiles of a chunk the first time it is seen. */
  private waterChunk(c: number): Container | null {
    let ct = this.waterChunks[c];
    if (ct !== null) return ct;
    const { map } = this.sim;
    const x0 = (c % map.chunksX) * CHUNK;
    const y0 = Math.floor(c / map.chunksX) * CHUNK;
    ct = new Container();
    const phases: number[] = [];
    for (let y = y0; y < Math.min(map.h, y0 + CHUNK); y++) {
      for (let x = x0; x < Math.min(map.w, x0 + CHUNK); x++) {
        const i = map.idx(x, y);
        if (!TERRAIN[map.terrain[i] as keyof typeof TERRAIN].water) continue;
        const h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
        if (h % 3 !== 0) continue;
        const g = new Sprite(this.tex.glint);
        g.anchor.set(0.5);
        const p = this.surface(x + ((h >>> 8) % 100) / 100 - 0.5, y + ((h >>> 16) % 100) / 100 - 0.5);
        g.position.set(p.x, p.y);
        g.scale.set(1 + ((h >>> 4) % 5) * 0.15, 1);
        g.alpha = 0;
        ct.addChild(g);
        phases.push(((h >>> 12) % 1000) / 1000 * Math.PI * 2);
      }
    }
    this.glintPhase[c] = Float32Array.from(phases);
    this.waterLayer.addChild(ct);
    this.waterChunks[c] = ct;
    return ct;
  }

  private updateWater(timeMs: number, chunkVisible: Uint8Array): void {
    for (let c = 0; c < chunkVisible.length; c++) {
      const existing = this.waterChunks[c];
      if (!chunkVisible[c]) {
        if (existing) existing.visible = false;
        continue;
      }
      const ct = existing ?? this.waterChunk(c)!;
      ct.visible = true;
      const phase = this.glintPhase[c];
      const kids = ct.children;
      for (let k = 0; k < kids.length; k++) {
        const v = Math.sin(timeMs * 0.0021 + phase[k]);
        // Brief sparkles: mostly invisible, a sharp peak now and then.
        kids[k].alpha = v > 0.6 ? (v - 0.6) * 2.2 : 0;
      }
    }
  }

  // ---------------------------------------------------------------- update

  /** Advances every effect; `chunkVisible` is the renderer's per-chunk on-screen flags. */
  update(dtMs: number, timeMs: number, chunkVisible: Uint8Array): void {
    const dt = Math.min(dtMs, 100);
    this.updateBuildings(dt, timeMs);
    this.updateFalling(timeMs);
    this.updateWater(timeMs, chunkVisible);
    this.stepParticles(dt);
  }
}
