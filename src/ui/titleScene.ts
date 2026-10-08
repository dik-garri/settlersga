import type { Application } from 'pixi.js';
import type { AudioEngine } from '../audio/audio';
import type { SpriteAtlas } from '../render/atlas';
import { Camera } from '../render/camera';
import { toScreen } from '../render/iso';
import { GameRenderer } from '../render/renderer';
import { TICKS_PER_SECOND } from '../sim/config';
import { World } from '../sim/world';

/**
 * The live scene behind the intro and the main menu: a small settlement that the computer builds up
 * by itself (player 1 played by the AI, fixed seed, no fog), fast-forwarded to `WARMUP_MINUTES` in
 * slices so the page stays responsive, then played on at normal speed. The intro flies the camera in
 * from the edge of the land (`flyIn`); afterwards it drifts slowly round the castle.
 */
const SEED = 20261008;
const SIZE = 64;
const WARMUP_MINUTES = 14;
/** Ticks simulated per animation frame while warming up. */
const WARMUP_SLICE = 400;
const TICK_MS = 1000 / TICKS_PER_SECOND;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class TitleScene {
  readonly world = new World(SEED, { size: SIZE, players: 1, ai: [1], start: 'high' });
  /** 0..1 while warming up. */
  progress = 0;
  readonly ready: Promise<void>;
  private renderer: GameRenderer | null = null;
  private camera: Camera | null = null;
  private home = { x: 0, y: 0 };
  private flight: { from: { x: number; y: number; zoom: number }; start: number; ms: number } | null = null;
  private acc = 0;
  private readonly tick: (t: { deltaMS: number }) => void;
  private disposed = false;

  constructor(
    private readonly app: Application,
    atlas: Promise<SpriteAtlas>,
    private readonly audio: AudioEngine,
  ) {
    this.tick = (t) => this.frame(t.deltaMS);
    this.ready = this.warmUp(atlas);
  }

  private async warmUp(atlas: Promise<SpriteAtlas>): Promise<void> {
    const total = WARMUP_MINUTES * 60 * TICKS_PER_SECOND;
    while (this.world.tick < total) {
      for (let i = 0; i < WARMUP_SLICE && this.world.tick < total; i++) this.world.step();
      this.progress = (0.85 * this.world.tick) / total;
      await new Promise((r) => requestAnimationFrame(r));
      if (this.disposed) return;
    }
    const a = await atlas;
    if (this.disposed) return;
    this.renderer = new GameRenderer(this.app, this.world, a, false);
    this.renderer.onSound = (id, x, y) => this.audio.at(id, x, y);
    this.camera = new Camera(this.renderer.world, this.renderer.bounds);
    const c = this.world.castle;
    this.home = toScreen(c.x + 1, c.y + 1);
    this.camera.centerOn(this.home.x, this.home.y);
    this.camera.zoom = 1.1;
    this.progress = 1;
    this.app.ticker.add(this.tick);
  }

  /** Flies the camera in over `ms` from the far side of the settlement, close up. */
  flyIn(ms: number): void {
    this.flight = { from: { x: this.home.x - 520, y: this.home.y + 240, zoom: 1.8 }, start: performance.now(), ms };
  }

  private frame(dt: number): void {
    const { renderer, camera } = this;
    if (!renderer || !camera) return;
    this.acc += Math.min(dt, 250);
    let n = 0;
    while (this.acc >= TICK_MS && n < 5) {
      this.world.step();
      this.acc -= TICK_MS;
      n++;
    }
    if (n === 5) this.acc = 0;
    const now = performance.now();
    // Drift: a slow ellipse round the castle; the fly-in eases from its start onto that path.
    const a = now / 1000 / 70;
    const drift = { x: this.home.x + Math.cos(a) * 160, y: this.home.y + Math.sin(a) * 70, zoom: 1.1 };
    let { x, y, zoom } = drift;
    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / this.flight.ms);
      const k = ease(t);
      const f = this.flight.from;
      x = f.x + (drift.x - f.x) * k;
      y = f.y + (drift.y - f.y) * k;
      zoom = f.zoom + (drift.zoom - f.zoom) * k;
      if (t >= 1) this.flight = null;
    }
    camera.zoom = zoom;
    camera.centerOn(x, y);
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    camera.apply(w, h);
    const view = camera.viewRect(w, h);
    this.audio.listen(camera.x, camera.y, view.w / 2, camera.zoom);
    this.audio.update();
    renderer.sync(this.acc / TICK_MS, now, view, null, null, null);
  }

  /** Stops the scene and takes it off the stage (the atlas's textures stay for the game). */
  dispose(): void {
    this.disposed = true;
    this.app.ticker.remove(this.tick);
    if (this.renderer) {
      this.app.stage.removeChild(this.renderer.world);
      this.renderer.world.destroy({ children: true });
      this.renderer = null;
    }
  }
}
