import { Application } from 'pixi.js';
import { SpriteAtlas } from './render/atlas';
import { Camera } from './render/camera';
import { toScreen } from './render/iso';
import { GameRenderer } from './render/renderer';
import { TICKS_PER_SECOND } from './sim/config';
import { World } from './sim/world';
import { Hud } from './ui/hud';
import { InputController } from './ui/input';
import { Minimap } from './ui/minimap';
import { createState } from './ui/state';
import { hasSave, readSave, storeSave } from './ui/storage';

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

  const params = new URLSearchParams(location.search);
  const seed = params.has('seed') ? Number(params.get('seed')) : Math.floor(Math.random() * 1e9);
  const size = params.has('size') ? Number(params.get('size')) : undefined;
  const save = params.has('load') ? readSave() : null;
  if (params.has('load')) {
    // Loading is one-shot: a later refresh should not silently reload the slot.
    params.delete('load');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }
  // The local player and one computer opponent unless ?players= says otherwise; ?ai=off keeps the
  // opponents passive.
  const players = params.has('players') ? Number(params.get('players')) : 2;
  const ai = params.get('ai') === 'off' ? [] : Array.from({ length: players - 1 }, (_, k) => k + 2);
  const world = save ? World.load(save) : new World(seed, { size, players, ai });
  const state = createState();
  const atlas = new SpriteAtlas();
  state.fog = params.get('fog') !== 'off';
  const renderer = new GameRenderer(app, world, atlas, state.fog);
  const camera = new Camera(renderer.world, renderer.bounds);
  const c = world.castle;
  const home = toScreen(c.x + 1, c.y + 1);
  camera.centerOn(home.x, home.y);

  const hud = new Hud(document.getElementById('hud')!, world, state, {
    onSave: () => hud.toast(storeSave(world) ? 'Игра сохранена' : 'Не удалось сохранить'),
    onLoad: () => {
      if (!hasSave()) return hud.toast('Сохранений нет');
      location.search = '?load=1';
    },
  });
  const minimap = new Minimap(world, camera, state.fog);
  document.getElementById('hud')!.append(minimap.el);
  const input = new InputController(app.canvas, camera, renderer, world, state, {
    onSelectBuildType: (type) => hud.selectBuildType(type),
    onHotkey: (n) => hud.hotkey(n),
    onNextTab: () => hud.nextTab(),
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
    const view = camera.viewRect(app.screen.width, app.screen.height);
    renderer.sync(acc / TICK_MS, now, view, input.ghost(), state.selected, state.hover, input.area());
    hud.update(now);
    minimap.update(now, app.screen.width, app.screen.height);
  });

  Object.assign(window, { world, seed, state, renderer, camera });
  if (save) console.info(`Loaded save at tick ${world.tick}`);
  else console.info(`Settlers prototype, seed ${seed} (add ?seed=${seed} to replay this map)`);
}

main();
