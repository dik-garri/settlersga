import { Application } from 'pixi.js';
import { SpriteAtlas } from './render/atlas';
import { Camera } from './render/camera';
import { toScreen } from './render/iso';
import { GameRenderer } from './render/renderer';
import { TICKS_PER_SECOND } from './sim/config';
import { World } from './sim/world';
import { Hud } from './ui/hud';
import { InputController } from './ui/input';
import { createState } from './ui/state';

const TICK_MS = 1000 / TICKS_PER_SECOND;
const MAX_TICKS_PER_FRAME = 20;

async function main() {
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: '#1d2b3a',
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  document.getElementById('game')!.appendChild(app.canvas);

  const seedParam = new URLSearchParams(location.search).get('seed');
  const seed = seedParam ? Number(seedParam) : Math.floor(Math.random() * 1e9);
  const world = new World(seed);
  const state = createState();
  const atlas = new SpriteAtlas();
  const renderer = new GameRenderer(app, world, atlas);
  const camera = new Camera(renderer.world, renderer.bounds);
  const c = world.castle;
  const home = toScreen(c.x + 1, c.y + 1);
  camera.centerOn(home.x, home.y);

  const hud = new Hud(document.getElementById('hud')!, world, state);
  const input = new InputController(app.canvas, camera, renderer, world, state, {
    onSelectBuildType: (type) => hud.selectBuildType(type),
    onMessage: (text) => hud.toast(text),
  });

  // Fixed-step simulation, rendering interpolates between the last two ticks.
  let acc = 0;
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS, 250);
    input.update(dt);
    if (!state.paused) {
      acc += dt * state.speed;
      let n = 0;
      while (acc >= TICK_MS && n < MAX_TICKS_PER_FRAME) {
        world.step();
        acc -= TICK_MS;
        n++;
      }
      if (n === MAX_TICKS_PER_FRAME) acc = 0;
    }
    camera.apply(app.screen.width, app.screen.height);
    const now = performance.now();
    renderer.sync(acc / TICK_MS, now, input.ghost(), state.selected, state.hover);
    hud.update(now);
  });

  Object.assign(window, { world, seed });
  console.info(`Settlers prototype, seed ${seed} (add ?seed=${seed} to replay this map)`);
}

main();
