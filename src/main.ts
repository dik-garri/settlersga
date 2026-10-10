import { Application } from 'pixi.js';
import { AudioEngine } from './audio/audio';
import { loadArt3d } from './render/art3d';
import { SpriteAtlas } from './render/atlas';
import { Camera } from './render/camera';
import { toScreen, toTile } from './render/iso';
import { GameRenderer } from './render/renderer';
import { TICKS_PER_SECOND } from './sim/config';
import { saveWorld } from './sim/save';
import { World } from './sim/world';
import { audioControls } from './ui/audioControls';
import { el } from './ui/dom';
import { Hud } from './ui/hud';
import { isLang, lang, LANG_EVENT, pickLang, setAddressLang, setLang, t, withLang } from './ui/i18n';
import { InputController } from './ui/input';
import { Intro } from './ui/intro';
import { MainMenu } from './ui/menu';
import { Minimap } from './ui/minimap';
import { PauseMenu } from './ui/pauseMenu';
import { readPrefs } from './ui/prefs';
import { AUTO_ID, browserSlots, type SlotMeta } from './ui/saves';
import { devWorldArgs, launchOf, worldArgs, type GameSetup } from './ui/setup';
import { createState, isCommand } from './ui/state';
import { TitleScene } from './ui/titleScene';
import { MISSIONS, missionById } from './tutorial/missions';
import { readMarks } from './tutorial/progress';
import { missionWorld, TutorialRunner, type MissionProgress } from './tutorial/runner';
import type { MissionDef, UiProbe } from './tutorial/types';
import { TutorialView } from './tutorial/view';
import { replayTools } from './dev/replayTools';
import type { Transport } from './net/transport';
import { ChatBox, chatLineText } from './ui/chatView';
import type { StartInfo } from './ui/lobby';
import type { NetLaunchExtra } from './ui/lobbyView';
import { NetGame } from './ui/netGame';
import { ownName } from './ui/playerNames';
import { NAME_EVENT } from './ui/settingsPanel';
import { downloadJson, NetPanel, netWindow } from './ui/netView';

/** A network game: the connections the lobby made, what the host decided at «Start», the chat so far. */
interface NetStart {
  transport: Transport;
  info: StartInfo;
  extra: NetLaunchExtra;
}

/** A tutorial mission to run in a game: from a step (0-based), or loaded with its progress. */
type TutorialStart = { def: MissionDef; step: number } | { def: MissionDef; progress: MissionProgress };

/** The mission of a loaded slot, if it was saved during one. */
function savedMission(mission: MissionProgress | undefined): TutorialStart | undefined {
  const def = mission ? missionById(mission.id) : undefined;
  return def && mission ? { def, progress: mission } : undefined;
}

const TICK_MS = 1000 / TICKS_PER_SECOND;
const MAX_TICKS_PER_FRAME = 20;
/** The autosave slot is rewritten every this many game minutes. */
const AUTOSAVE_MINUTES = 5;

const randomSeed = () => Math.floor(Math.random() * 1e9);

/**
 * Start-up, as in Settlers 4: the intro (every normal start, unless turned off in the settings), then the main menu over a
 * live scene; a game starts from the menu without reloading the page. A development address
 * (`?seed`, `?size`, `?demo`, `?load`… — see `launchOf`) starts its game at once.
 */
async function main() {
  const params = new URLSearchParams(location.search);
  const launch = launchOf(params);
  const prefs = readPrefs();
  // The interface language: ?lang, else the one chosen in the settings, else the browser's (en/de), else Russian.
  const asked = params.get('lang');
  setAddressLang(isLang(asked) ? asked : null);
  setLang(pickLang(asked, prefs.lang, navigator.languages ?? [navigator.language]));
  showLang();
  window.addEventListener(LANG_EVENT, () => {
    // A choice in the settings wins over the address from now on.
    setAddressLang(null);
    const p = new URLSearchParams(location.search);
    if (p.has('lang')) {
      p.delete('lang');
      history.replaceState(null, '', `${location.pathname}${p.size ? `?${p}` : ''}`);
    }
    showLang();
  });
  const app = new Application();
  await app.init({
    resizeTo: document.getElementById('game')!,
    background: '#1d2b3a',
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  document.getElementById('game')!.appendChild(app.canvas);

  // Sound starts on the first gesture.
  const audio = new AudioEngine();
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);

  // The pre-rendered 3D art is the default; the settings (or ?art=classic) pick the procedural painters.
  const art3d = params.has('art') ? params.get('art') !== 'classic' : prefs.art === '3d';
  const atlas = (async () => new SpriteAtlas(art3d ? await loadArt3d() : null))();

  // Every normal start plays the intro before the menu. Back from a game (?menu, «Выход») the menu opens
  // at once, and ?menu=new opens the setup screen; the parameter is dropped from the address right
  // away, so reloading that page is a normal start again (intro first).
  // A friend's link (?join=<code>): straight to the network lobby, connecting.
  if (launch.kind === 'join') return title(app, atlas, audio, { setup: false, intro: false, join: launch.code });
  if (launch.kind === 'menu') {
    const fromGame = params.has('menu');
    const setup = params.get('menu') === 'new';
    if (fromGame || params.has('game')) {
      params.delete('menu');
      params.delete('game');
      history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
    }
    return title(app, atlas, audio, { setup, intro: !fromGame });
  }

  // One-shot parameters: a refresh should not silently load a slot again.
  if (launch.kind === 'load') {
    params.delete('load');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }
  let world: World;
  let seed = 0;
  let tutorial: TutorialStart | undefined;
  if (launch.kind === 'load') {
    const slots = browserSlots();
    const id = launch.slot ?? slots.latest()?.id;
    const data = id ? await slots.read(id) : null;
    if (!data) return title(app, atlas, audio, { setup: false, intro: false, notice: t('menu.saveNotFound') });
    world = World.load(data);
    tutorial = savedMission(slots.meta(id!)?.mission);
  } else if (launch.kind === 'tutorial') {
    // A tutorial mission straight from the address (development: ?tutorial=<id>&step=<n>).
    const def = missionById(launch.id);
    if (!def || def.soon) return title(app, atlas, audio, { setup: false, intro: false });
    world = missionWorld(def);
    seed = def.world.seed;
    tutorial = { def, step: launch.step - 1 };
  } else if (launch.kind === 'demo') {
    // A development showcase that builds itself up to show everything at once (src/dev).
    world = (await import('./dev/showcase')).buildShowcase();
  } else if (launch.kind === 'setup') {
    const args = worldArgs(launch.setup, randomSeed());
    seed = args.seed;
    world = new World(args.seed, args.opts);
  } else {
    const args = devWorldArgs(params, randomSeed());
    seed = args.seed;
    world = new World(args.seed, args.opts);
  }
  // The demo shows no fog unless asked (?fog=on).
  const fog = tutorial
    ? tutorial.def.world.fog && params.get('fog') !== 'off'
    : launch.kind === 'setup'
      ? launch.setup.fog
      : launch.kind === 'demo'
        ? params.get('fog') === 'on'
        : params.get('fog') !== 'off';
  game(app, await atlas, audio, world, { fog, seed, autosave: launch.kind !== 'demo', tutorial });
}

/** The intro (when due) and the main menu over the title scene, until a game starts. */
async function title(
  app: Application,
  atlas: Promise<SpriteAtlas>,
  audio: AudioEngine,
  opts: { setup: boolean; intro: boolean; notice?: string; join?: string },
) {
  document.body.classList.add('title-mode');
  app.resize();
  const root = el('div', 'title-root');
  root.append(el('div', 'title-vignette'));
  document.body.append(root);
  const scene = new TitleScene(app, atlas, audio);
  const intro = new Intro(scene, audio);

  const begin = async (make: () => Promise<World | null>, fog: boolean, seed: number, tutorial?: TutorialStart, net?: NetStart) => {
    menu.el.classList.add('busy');
    menu.say(t('menu.preparing'));
    // Let the notice paint before the map is generated.
    await new Promise((r) => setTimeout(r, 30));
    let world: World | null = null;
    try {
      world = await make();
    } catch (e) {
      console.error(e);
    }
    if (!world) {
      menu.el.classList.remove('busy');
      menu.say(t('menu.openFailed'));
      net?.transport.close();
      return;
    }
    const a = await atlas;
    scene.dispose();
    root.remove();
    document.body.classList.remove('title-mode');
    app.resize();
    // A refresh during the game returns to the menu, not to a stale ?menu=new — but a network
    // client's tab keeps the room's code, so a reload goes back to the game (roadmap 6.7).
    const back = net && !net.transport.isHost ? `${location.pathname}?join=${net.transport.code}` : location.pathname;
    history.replaceState(null, '', withLang(back));
    game(app, a, audio, world, { fog, seed, autosave: true, tutorial, net });
  };
  const menu = new MainMenu(
    {
      start: (setup: GameSetup) => {
        const { seed, opts } = worldArgs(setup, randomSeed());
        void begin(async () => new World(seed, opts), setup.fog, seed);
      },
      network: (transport, info, extra) => {
        // Every browser builds the same world: from the host's seed and setup, from the same network
        // save (each reads its own copy), or — returning to a game under way — from the host's snapshot.
        const make = async () => {
          if (extra.resume) return World.load(extra.resume.data);
          if (info.load) {
            const slots = browserSlots();
            const meta = slots.findNet(info.load.id, info.load.sum);
            const data = meta ? await slots.read(meta.id) : null;
            return data ? World.load(data) : null;
          }
          const { seed, opts } = worldArgs(info.setup, info.seed);
          return new World(seed, opts);
        };
        void begin(make, info.setup.fog, info.seed, undefined, { transport, info, extra });
      },
      load: (meta: SlotMeta) => {
        const mission = savedMission(meta.mission);
        void begin(
          async () => {
            const data = await browserSlots().read(meta.id);
            return data ? World.load(data) : null;
          },
          mission ? mission.def.world.fog : true,
          0,
          mission,
        );
      },
      tutorials: () => {
        const marks = readMarks();
        return MISSIONS.map((m) => ({ id: m.id, title: m.title, summary: m.summary, minutes: m.minutes, done: !!marks.done[m.id], soon: !!m.soon }));
      },
      tutorial: (id: string) => {
        const def = missionById(id);
        if (def && !def.soon) void begin(async () => missionWorld(def), def.world.fog, def.world.seed, { def, step: 0 });
      },
      intro: () => void playIntro(),
      artChanged: () => location.reload(),
    },
    audio,
  );
  const playIntro = async () => {
    menu.el.hidden = true;
    try {
      await intro.play(root);
    } catch (e) {
      // Whatever went wrong, the menu still comes up.
      console.error(e);
      intro.el.remove();
    } finally {
      menu.el.hidden = false;
      menu.show('main');
    }
  };
  root.append(menu.el);
  menu.say(opts.notice ?? '');
  if (opts.join) menu.show('network', { join: opts.join });
  else if (opts.intro && readPrefs().showIntro) await playIntro();
  else menu.show(opts.setup ? 'new' : 'main');
  Object.assign(window, { scene, menu });
}

/** A running game: renderer, side panel, input, the game menu and the fixed-step loop. */
function game(
  app: Application,
  atlas: SpriteAtlas,
  audio: AudioEngine,
  world: World,
  opts: { fog: boolean; seed: number; autosave: boolean; tutorial?: TutorialStart; net?: NetStart },
) {
  // In a network game this browser plays its own seat; on one machine, player 1.
  const slots = browserSlots();
  const net = opts.net
    ? new NetGame(world, opts.net.transport, opts.net.info, { slots, resume: opts.net.extra.resume?.resume, chat: opts.net.extra.chat })
    : null;
  const state = createState(net?.local);
  // Player names (interface only): a network game's from the setup the host sent, else the own one.
  const own = new Map([[state.localPlayer, ownName()]]);
  state.names = net ? net.names : own;
  // On one machine a new name (the settings) or language (a default name is the language's) shows at once.
  if (!net) window.addEventListener(NAME_EVENT, () => own.set(state.localPlayer, ownName()));
  state.fog = opts.fog;
  if (net) state.net = { pause: (on) => net.match.setPaused(on), speed: net.isHost ? (v) => net.match.setSpeed(v) : null };
  const renderer = new GameRenderer(app, world, atlas, state.fog, state.localPlayer);
  const camera = new Camera(renderer.world, renderer.bounds);
  const mid = world.homeOf(state.localPlayer);
  const home = toScreen(mid.x, mid.y);
  camera.centerOn(home.x, home.y);
  renderer.onSound = (id, x, y) => audio.at(id, x, y);

  // A tutorial mission under way (`src/tutorial`): its progress goes into the save slot's description.
  let tutorial: TutorialView | null = null;
  const missionMeta = () => ({ mission: tutorial?.progress() ?? undefined });
  // A network game saves on every machine at a common turn (roadmap 6.6): the request goes to the match.
  const save = async (name: string, id?: string) =>
    net ? net.requestSave(name) : !!(await slots.write(saveWorld(world), name, Date.now(), id, missionMeta()));
  // Loading or leaving starts the page over: nothing of this game is left behind.
  // Leaving a network game says goodbye first: the others' computers take this seat over.
  const leave = () => net?.close();
  const pause = new PauseMenu(world, state, {
    save,
    load: (meta) => {
      leave();
      location.href = withLang(`${location.pathname}?load=${encodeURIComponent(meta.id)}`);
    },
    quit: () => {
      leave();
      location.href = withLang(`${location.pathname}?menu`);
    },
  }, audio);

  // The minimap is framed at the top of the side panel, as wide as the panel's inside (--mm-w).
  const hudEl = document.getElementById('hud')!;
  const mmWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mm-w')) || 252;
  const minimap = new Minimap(world, camera, state.fog, mmWidth, state.localPlayer);
  const sound = audioControls(audio);
  const jump = (x: number, y: number) => {
    const p = toScreen(x, y);
    camera.centerOn(p.x, p.y - world.map.heightAt(x, y));
  };
  const makeHud = (previous?: Hud) =>
    new Hud(
      hudEl,
      world,
      state,
      { onSave: () => pause.open('save'), onLoad: () => pause.open('load'), onMenu: () => pause.open('main') },
      { minimap: minimap.box, sound, jump, memo: previous?.memo(), noEndScreen: !!opts.tutorial },
    );
  let hud = makeHud();
  /** What the tutorial's conditions see of the interface. */
  const uiProbe = (): UiProbe => {
    const c = toTile(camera.x, camera.y);
    return {
      menu: hud.openMenu,
      selected: state.selected,
      selectedUnits: state.selectedUnits.length,
      groups: state.groups.map((g) => g.length),
      camera: { x: c.x, y: c.y },
      zoom: camera.zoom,
      placing: state.placing,
      speed: state.speed,
      paused: state.paused,
      jumps: hud.jumps,
    };
  };
  if (opts.tutorial) {
    const tut = opts.tutorial;
    const runner =
      'progress' in tut ? TutorialRunner.restore(tut.def, tut.progress) : TutorialRunner.start(tut.def, world, uiProbe(), { from: tut.step });
    // The interface opens only what the mission has reached, from the first frame.
    state.locks = runner.model(world).locks;
    tutorial = new TutorialView(runner, world, hudEl, {
      state,
      jump,
      marks: (m) => {
        renderer.setGuide(m);
        minimap.setMarks(m);
      },
      startMission: (id) => (location.href = withLang(`${location.pathname}?tutorial=${encodeURIComponent(id)}`)),
      toMenu: () => (location.href = withLang(`${location.pathname}?menu`)),
    });
  }
  hudEl.append(pause.el);
  if (net) {
    // The network game's status under the speed strip, its messages on the ticker, its end windows.
    const panel = new NetPanel({
      world,
      match: net.match,
      status: net.status,
      seats: [...net.seats.keys()].sort((a, b) => a - b),
      local: net.local,
      host: net.hostSeat,
      nameOf: (seat) => net.nameOf(seat),
      kick: net.isHost ? (seat) => net.kick(seat) : null,
      chat: () => chat.toggle(),
      rejoin: net.isHost
        ? {
            asked: () => net.core.askedSeats(),
            askerName: (s) => net.core.askerName(s),
            accept: (s) => void net.core.acceptRejoin(s),
            refuse: (s) => net.core.refuseRejoin(s),
          }
        : null,
    });
    // The chat box over the ticker (Enter or the panel's button), rebuilt in another language.
    const makeChat = () =>
      new ChatBox({ local: net.local, nameOf: (seat) => net.nameOf(seat), lines: () => net.core.chat.lines, say: (text, to) => net.say(text, to), toast: (text) => hud.toast(text) });
    let chat = makeChat();
    hudEl.append(panel.el, chat.el);
    window.addEventListener(LANG_EVENT, () => {
      const old = chat;
      chat = makeChat();
      old.el.replaceWith(chat.el);
    });
    window.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if (e.key !== 'Enter' || typing || state.menu || chat.isOpen) return;
      e.preventDefault();
      chat.open();
    });
    app.ticker.add(() => panel.update(performance.now()));
    const toMenu = () => {
      net.close();
      location.href = withLang(`${location.pathname}?menu`);
    };
    const show = (box: HTMLElement) => {
      hudEl.querySelector('.net-window')?.remove();
      hudEl.append(box);
    };
    net.hooks = {
      toast: (text) => hud.toast(text),
      chat: (line) => {
        // New lines go to the ticker while the box is closed.
        if (!chat.isOpen) hud.toast(chatLineText(line, (seat) => net.nameOf(seat)));
        chat.refresh();
      },
      desync: (r) =>
        show(
          netWindow(t('net.desync.title'), t('net.desync.text', { turn: r.turn }), [
            [t('net.desync.report'), () => downloadJson(`settlers-desync-p${net.local}-t${r.turn}.json`, net.report()), true],
            [t('net.toMenu'), toMenu],
          ]),
        ),
      hostLost: () => {
        const saveIt = async () => {
          // A network save of the last turn played: loadable in the lobby with a new host.
          const ok = await net.saveNow(t('net.savedName', { min: Math.floor(world.tick / (60 * TICKS_PER_SECOND)) }));
          hud.toast(ok ? t('net.saved') : t('saves.failed'));
        };
        show(netWindow(t('net.hostLost.title'), t('net.hostLost.text'), [[t('net.save'), () => void saveIt(), true], [t('net.toMenu'), toMenu]]));
      },
    };
  }
  // Another language chosen in the settings: the side panel is built again in it (menus, windows,
  // statistics and messages carry over); the pause menu and the minimap redraw themselves.
  window.addEventListener(LANG_EVENT, () => {
    // A default name is the language's («Поселенец 427» / "Settler 427").
    if (!net) own.set(state.localPlayer, ownName());
    const previous = hud;
    previous.dispose();
    hud = makeHud(previous);
    hudEl.append(pause.el);
  });
  hudEl.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) audio.ui('click');
  });
  const input = new InputController(app.canvas, camera, renderer, world, state, {
    onSelectBuildType: (type) => hud.selectBuildType(type),
    onHotkey: (n) => hud.hotkey(n),
    onNextTab: () => hud.nextTab(),
    onMessage: (text) => hud.toast(text),
    onMenu: () => pause.open('main'),
    onLastMessage: () => hud.jumpToMessage(),
    onSpace: () => tutorial?.space() ?? false,
  });

  // Autosave: every few game minutes into its own slot (compressed in the background).
  const autosaveEvery = AUTOSAVE_MINUTES * 60 * TICKS_PER_SECOND;
  let nextAutosave = world.tick + autosaveEvery;
  const autosave = () => {
    nextAutosave = world.tick + autosaveEvery;
    void slots.write(saveWorld(world), t('saves.auto'), Date.now(), AUTO_ID, missionMeta()).then((m) => {
      if (m) hud.toast(t('saves.auto'));
    });
  };

  // Fixed-step simulation, rendering interpolates between the last two ticks.
  let acc = 0;
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS, 250);
    input.update(dt);
    if (net) {
      // The network game plays the sealed turns as they come (`NetGame.pump`); pause and speed are
      // everybody's, so the interface shows the match's.
      net.pump();
      state.paused = net.match.paused;
      state.speed = net.match.speed;
      acc = net.match.alpha * TICK_MS;
      // (The network autosave is the match's: a network save at a common turn, `NetGame`.)
    } else if (!state.paused) {
      acc += dt * state.speed;
      let n = 0;
      while (acc >= TICK_MS && n < MAX_TICKS_PER_FRAME) {
        world.step();
        acc -= TICK_MS;
        n++;
        // The tutorial checks its conditions at least every five ticks, even in a long frame.
        if (tutorial && world.tick % 5 === 0) tutorial.tick(uiProbe());
      }
      if (n === MAX_TICKS_PER_FRAME) acc = 0;
      if (opts.autosave && world.tick >= nextAutosave && world.outcome(state.localPlayer) === 'playing') autosave();
    }
    camera.apply(app.screen.width, app.screen.height);
    const now = performance.now();
    const view = camera.viewRect(app.screen.width, app.screen.height);
    audio.listen(camera.x, camera.y, view.w / 2, camera.zoom);
    audio.update();
    const placing = state.placing && !isCommand(state.placing) ? state.placing : null;
    renderer.sync(acc / TICK_MS, now, view, input.ghost(), state.selected, state.hover, input.area(), placing, state.selectedSettler, state.selectedUnits, state.groups);
    hud.update(now);
    // Once a frame as well: interface steps («Next», camera, menus) go on while the game is paused.
    if (tutorial) {
      tutorial.tick(uiProbe());
      tutorial.update(now);
    }
    minimap.update(now, app.screen.width, app.screen.height);
  });

  Object.assign(window, { world, seed: opts.seed, state, renderer, camera, audio, pause, tutorial, replay: replayTools(world), net });
  if (opts.seed) console.info(`Settlers prototype, seed ${opts.seed} (add ?seed=${opts.seed} to replay this map)`);
  else console.info(`Game at tick ${world.tick}`);
}

/** The page's language and title. */
function showLang(): void {
  document.documentElement.lang = lang();
  document.title = t('app.pageTitle');
}

main();
