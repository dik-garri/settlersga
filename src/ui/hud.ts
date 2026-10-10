import { settlerIcon, wareIcon } from '../render/atlas';
import { MESSAGES, TICKS_PER_SECOND } from '../sim/config';
import { messagesOf } from '../sim/messages';
import { isFighter } from '../sim/military';
import { scoreOf } from '../sim/score';
import type { Building, PlayerId, Resource, Settler } from '../sim/types';
import type { World } from '../sim/world';
import { ArmyView } from './armyPanel';
import { BuildView } from './buildMenu';
import { button, el, rowsTable, type View } from './dom';
import { inStorage, GoodsView } from './goodsView';
import { t, withLang, type Key } from './i18n';
import { glyph, type GlyphName } from './icons';
import { InfoView } from './infoPanel';
import { MESSAGE_CYCLE_MS, messageText } from './messageText';
import { resName } from './names';
import { OptionsView, SPEEDS, type GameActions } from './optionsView';
import { SettlerInfoView } from './settlerInfo';
import { UnitsView } from './unitsView';
import { SettlersView } from './settlersView';
import { canChangeSpeed, chooseSpeed, setPaused, type GameState, type Placeable } from './state';
import { menuOpen, type MenuId } from './locks';
import { tag } from './uiTarget';
import { StatsView } from './statsView';

/**
 * The HUD, laid out like Settlers 4's: a framed panel down the left side of the screen — the minimap
 * on top, a row of gem buttons for the main menus (build, goods, settlers, statistics, army,
 * options), the open menu (or the selected building's window, which replaces it as in the original),
 * and a readout of key goods, settlers, soldiers and army strength at the bottom. The game view
 * starts right of the panel (`--side-w`). A small strip top right holds pause and speed, the message
 * ticker runs along the bottom of the view. All drawing is ours (CSS and inline SVG).
 */


const MENUS: { id: MenuId; glyph: GlyphName; title: Key }[] = [
  { id: 'build', glyph: 'build', title: 'hud.menu.build' },
  { id: 'goods', glyph: 'goods', title: 'hud.menu.goods' },
  { id: 'settlers', glyph: 'settlers', title: 'hud.menu.settlers' },
  { id: 'stats', glyph: 'stats', title: 'hud.menu.stats' },
  { id: 'army', glyph: 'army', title: 'hud.menu.army' },
  { id: 'options', glyph: 'options', title: 'hud.menu.options' },
];

/** Goods always shown in the readout; everything else is in the goods menu. */
const PINNED: readonly Resource[] = ['plank', 'stone', 'log', 'bread', 'fish', 'meat', 'coal', 'iron', 'gold'];

/** How long a ticker message stays (ms). */
const MESSAGE_MS = 6000;

/** What a rebuilt HUD (another language) takes over from the one it replaces. */
export interface HudMemo {
  menu: MenuId;
  ended: boolean;
  stats: StatsView;
  warned: WeakSet<object>;
}

export interface HudOptions {
  /** The minimap canvas, framed at the top of the panel (with its layer switches). */
  minimap: HTMLElement;
  /** Sound controls for the options menu. */
  sound: HTMLElement | null;
  /** Moves the camera to a tile (messages, «find» buttons). */
  jump: (x: number, y: number) => void;
  /** The HUD this one replaces (see `memo`). */
  memo?: HudMemo;
  /** A tutorial mission runs: its debrief replaces the end screen of a game. */
  noEndScreen?: boolean;
}

export class Hud {
  private readonly views: Record<MenuId, View>;
  private readonly build: BuildView;
  private readonly stats: StatsView;
  private readonly info: InfoView;
  private readonly settlerInfo: SettlerInfoView;
  private readonly unitsView: UnitsView;
  private menu: MenuId = 'build';
  private readonly menuButtons = new Map<MenuId, HTMLButtonElement>();
  private readonly title = el('h3', 'content-title');
  private readonly body = el('div', 'content-body');
  private shown: View | null = null;
  private readonly readoutValues: [Resource, HTMLElement][] = [];
  private readonly people = el('b', '', '0');
  private readonly soldiers = el('b', '', '0');
  private readonly strength = el('b', '', '0%');
  private readonly speedButtons = new Map<number | 'pause', HTMLButtonElement>();
  private readonly hintEl = el('div', 'hint');
  private readonly ticker = el('div', 'ticker');
  private readonly endEl = el('div', 'panel end-screen');
  /** The end screen was shown (and possibly dismissed to keep watching). */
  private ended = false;
  private lastUpdate = 0;
  /** The HUD's top-level elements, for `dispose`. */
  private parts: HTMLElement[] = [];
  private readonly jump: (x: number, y: number) => void;
  /** Messages of the simulation (`World.messages`) already shown on the ticker. */
  private readonly warned: WeakSet<object>;
  /** Space: the message it jumped to last (index among the local player's, from the newest), and when. */
  private jumped = { k: -1, at: -Infinity };
  /** How often the camera went to a message (Space or a click on the ticker), for the tutorial. */
  jumps = 0;
  private readonly noEndScreen: boolean;
  private locksSeen: unknown = undefined;

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly state: GameState,
    actions: GameActions,
    opts: HudOptions,
  ) {
    const select = (type: Placeable | null) => this.selectBuildType(type);
    this.jump = opts.jump;
    this.noEndScreen = !!opts.noEndScreen;
    this.warned = opts.memo?.warned ?? new WeakSet<object>();
    this.ended = opts.memo?.ended ?? false;
    this.build = new BuildView(world, state, select, (b) => this.focusBuilding(b));
    this.stats = new StatsView(world, state.localPlayer);
    if (opts.memo) this.stats.carry(opts.memo.stats);
    this.info = new InfoView(world, state, (text) => this.toast(text), (b) => this.focusBuilding(b));
    this.settlerInfo = new SettlerInfoView(world, state, {
      place: (p) => select(p),
      toast: (text) => this.toast(text),
    });
    this.unitsView = new UnitsView(world, state, (text) => this.toast(text));
    this.views = {
      build: this.build,
      goods: new GoodsView(world, state.localPlayer),
      settlers: new SettlersView(world, state, select, (s) => this.focusSettler(s)),
      stats: this.stats,
      army: new ArmyView(world, state.localPlayer),
      options: new OptionsView(state, actions, opts.sound),
    };

    const side = el('aside', 'side');
    const frame = el('div', 'side-frame');
    const map = tag(el('div', 'mm-frame'), 'minimap');
    map.append(opts.minimap);
    const tabs = el('nav', 'main-tabs');
    for (const m of MENUS) {
      const b = tag(el('button', 'gem'), `menu.${m.id}`);
      b.title = t(m.title);
      b.append(glyph(m.glyph));
      b.onclick = () => {
        b.blur();
        // A main menu the tutorial has not opened yet stays shut.
        if (!menuOpen(this.state.locks, m.id)) return;
        this.state.selected = null;
        this.state.selectedSettler = null;
        this.state.selectedUnits = [];
        this.showMenu(m.id);
        b.blur();
      };
      tabs.append(b);
      this.menuButtons.set(m.id, b);
    }
    const content = el('section', 'content');
    content.append(this.title, this.body);
    frame.append(map, tabs, content, this.readout());
    side.append(frame);

    const strip = el('div', 'strip');
    const pause = tag(el('button', 'gem small'), 'speed.pause');
    pause.title = t('hud.pauseTip');
    pause.append(glyph('pause', 14));
    pause.onclick = () => {
      setPaused(state, !state.paused);
      pause.blur();
    };
    strip.append(pause);
    this.speedButtons.set('pause', pause);
    for (const s of SPEEDS) {
      const b = button(`${s}×`, canChangeSpeed(state) ? t('options.speedTip', { n: s }) : t('net.speedHost'), () => chooseSpeed(state, s), 'speed-btn');
      b.disabled = !canChangeSpeed(state);
      tag(b, `speed.${s}`);
      strip.append(b);
      this.speedButtons.set(s, b);
    }

    tag(this.ticker, 'hud.ticker');
    this.endEl.hidden = true;
    this.parts = [side, strip, this.hintEl, this.ticker, this.endEl];
    root.append(...this.parts);
    this.showMenu(opts.memo?.menu ?? 'build');
  }

  /** What a HUD built to replace this one (in another language) takes over. */
  memo(): HudMemo {
    return { menu: this.menu, ended: this.ended, stats: this.stats, warned: this.warned };
  }

  /** The open main menu, or null while a building's, settler's or units' window replaces it. */
  get openMenu(): MenuId | null {
    return this.shown === this.views[this.menu] ? this.menu : null;
  }

  /** Takes the HUD off the page (the minimap and sound controls go with the next one). */
  dispose(): void {
    for (const p of this.parts) p.remove();
  }

  /** The always-visible stats block: key goods, settlers, soldiers and army strength (Settlers 4). */
  private readout(): HTMLElement {
    const box = el('div', 'readout');
    const goods = el('div', 'readout-goods');
    for (const r of PINNED) {
      const s = el('span', 'stat');
      s.title = resName(r);
      const value = el('b', '', '0');
      s.append(wareIcon(r, 20), value);
      goods.append(s);
      this.readoutValues.push([r, value]);
    }
    const army = el('div', 'readout-army');
    const cell = (icon: HTMLElement, value: HTMLElement, title: string) => {
      const s = el('span', 'stat');
      s.title = title;
      s.append(icon, value);
      return s;
    };
    army.append(
      cell(settlerIcon('carrier', 26), this.people, t('hud.readout.settlers')),
      cell(settlerIcon('soldier', 26), this.soldiers, t('hud.readout.fighters')),
      cell(el('span', 'strength-ico', '⚔'), this.strength, t('hud.readout.strength')),
    );
    box.append(goods, army);
    return box;
  }

  private showMenu(id: MenuId): void {
    this.menu = id;
    for (const [m, b] of this.menuButtons) b.classList.toggle('active', m === id);
    this.mount(this.views[id], t(MENUS.find((m) => m.id === id)!.title));
  }

  private mount(view: View, title: string): void {
    this.title.textContent = title;
    if (this.shown === view) return;
    this.shown = view;
    this.body.replaceChildren(view.el);
    view.update(performance.now());
  }

  showTab(t: number): void {
    this.showMenu('build');
    this.build.showTab(t);
  }

  nextTab(): void {
    if (this.menu !== 'build' || this.state.selected !== null || this.state.selectedSettler !== null) {
      this.state.selected = null;
      this.state.selectedSettler = null;
      this.showMenu('build');
      return;
    }
    this.build.nextTab();
  }

  /** Digit hotkey: the n-th building (1-based) of the open build category. */
  hotkey(n: number): void {
    if (this.menu !== 'build') this.showMenu('build');
    const type = this.build.typeAt(n);
    if (type) this.selectBuildType(this.state.placing === type ? null : type);
  }

  selectBuildType(type: Placeable | null): void {
    this.state.placing = type;
    if (type) {
      this.state.selected = null;
      this.state.selectedSettler = null;
    }
  }

  /**
   * The local player's new messages on the ticker (Settlers 4's messages, `messages.ts`): a click jumps
   * the camera there, as Space does to the last one.
   */
  private showMessages(): void {
    for (const m of this.world.messages) {
      if (m.player !== this.state.localPlayer || this.warned.has(m)) continue;
      this.warned.add(m);
      this.toast(messageText(this.world, m), { at: m, alert: MESSAGES[m.kind].alert });
    }
  }

  /**
   * Space (Settlers 4): the camera jumps to the last message; pressed again soon after, to the one
   * before, and so on back through the list.
   */
  jumpToMessage(): boolean {
    const mine = messagesOf(this.world, this.state.localPlayer);
    if (mine.length === 0) return false;
    const now = performance.now();
    const k = now - this.jumped.at < MESSAGE_CYCLE_MS ? (this.jumped.k + 1) % mine.length : 0;
    this.jumped = { k, at: now };
    this.jumps++;
    const m = mine[mine.length - 1 - k];
    this.jump(m.x, m.y);
    this.toast(`${messageText(this.world, m)} (${k + 1}/${mine.length})`, { at: m });
    return true;
  }

  /** Selects a building and centres the camera on it («next building of this type»). */
  focusBuilding(b: Building): void {
    this.state.selected = b.id;
    this.state.selectedSettler = null;
    this.state.selectedUnits = [];
    this.jump(b.door.x, b.door.y);
  }

  /** Selects a settler and centres the camera on him («find settler»). */
  focusSettler(s: Settler): void {
    this.state.selected = null;
    this.state.selectedUnits = [];
    this.state.selectedSettler = s.id;
    this.jump(s.x, s.y);
  }

  /**
   * A message on the ticker at the bottom of the view; it fades after a few seconds. With `at` a
   * click on it moves the camera there.
   */
  toast(text: string, opts: { at?: { x: number; y: number }; alert?: boolean } = {}): void {
    const m = el('div', opts.alert ? 'msg alert' : 'msg', text);
    const at = opts.at;
    if (at) {
      m.classList.add('jump');
      m.title = t('hud.messageTip');
      m.onclick = () => {
        this.jumps++;
        this.jump(at.x, at.y);
      };
    }
    this.ticker.append(m);
    while (this.ticker.children.length > 4) this.ticker.firstElementChild!.remove();
    window.setTimeout(() => m.classList.add('gone'), MESSAGE_MS);
    window.setTimeout(() => m.remove(), MESSAGE_MS + 600);
  }

  update(nowMs: number): void {
    if (nowMs - this.lastUpdate < 150) return;
    this.lastUpdate = nowMs;
    const { world, state } = this;
    const outcome = world.outcome(this.state.localPlayer);
    if (outcome !== 'playing' && !this.ended && !this.noEndScreen) this.showEnd(outcome);
    if (state.locks !== this.locksSeen) {
      this.locksSeen = state.locks;
      for (const [m, b] of this.menuButtons) {
        const open = menuOpen(state.locks, m);
        b.classList.toggle('locked', !open);
        b.title = open ? t(MENUS.find((x) => x.id === m)!.title) : `${t(MENUS.find((x) => x.id === m)!.title)} — ${t('tut.ui.locked')}`;
      }
      if (!menuOpen(state.locks, this.menu)) this.menu = 'build';
    }
    this.stats.sample();
    this.showMessages();

    // The selected building's window replaces the open menu, as in Settlers 4.
    if (state.selected !== null && world.buildings.has(state.selected)) {
      this.mount(this.info, t('hud.title.building'));
      for (const b of this.menuButtons.values()) b.classList.remove('active');
    } else if (state.selectedSettler !== null && world.getSettler(state.selectedSettler)) {
      this.mount(this.settlerInfo, t('hud.title.settler'));
      for (const b of this.menuButtons.values()) b.classList.remove('active');
    } else if (state.selectedUnits.length > 0 && this.unitsView.units().length > 0) {
      // Selected army units: the selection panel, as in Settlers 4.
      this.mount(this.unitsView, t('hud.title.units'));
      for (const b of this.menuButtons.values()) b.classList.remove('active');
    } else {
      if (state.selected !== null) state.selected = null;
      if (state.selectedSettler !== null) state.selectedSettler = null;
      this.showMenu(this.menu);
    }
    this.shown?.update(nowMs);

    for (const [r, value] of this.readoutValues) {
      const text = String(inStorage(world, r, state.localPlayer));
      if (value.textContent !== text) value.textContent = text;
    }
    let people = 0;
    let fighters = 0;
    for (const s of world.settlers) {
      if (s.owner !== this.state.localPlayer) continue;
      people++;
      if (isFighter(s)) fighters++;
    }
    this.people.textContent = String(people);
    this.soldiers.textContent = String(fighters);
    this.strength.textContent = `${Math.round(world.strengthOf(this.state.localPlayer))}%`;

    for (const [key, b] of this.speedButtons) {
      const on = key === 'pause' ? state.paused : !state.paused && state.speed === key;
      b.classList.toggle('active', on);
      // The tutorial's highlight moves past a speed already chosen (or a faster one).
      if (key === 'pause' ? on : !state.paused && state.speed >= key) b.dataset.uiOn = '1';
      else delete b.dataset.uiOn;
    }
    const hint = t(
      state.placing === 'geologist'
        ? 'hud.hint.geologist'
        : state.placing === 'pioneer'
          ? 'hud.hint.pioneer'
          : state.placing === 'thief'
            ? 'hud.hint.thief'
            : state.placing
              ? 'hud.hint.placing'
              : state.selectedUnits.length > 0
                ? 'hud.hint.units'
                : 'hud.hint.idle',
    );
    if (this.hintEl.textContent !== hint) this.hintEl.textContent = hint;
  }

  /** Victory or defeat: time played, a few totals, and a way to start over or keep watching. */
  private showEnd(outcome: 'won' | 'lost'): void {
    this.ended = true;
    const { world } = this;
    const seconds = Math.floor(world.tick / TICKS_PER_SECOND);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    // Per-player facts only: `stats.produced` counts every player together.
    const mine = (p: number) => p === this.state.localPlayer;
    const land = world.map.owner.reduce((n, o) => n + (o !== 0 ? 1 : 0), 0);
    const ownLand = world.map.owner.reduce((n, o) => n + (mine(o) ? 1 : 0), 0);
    const soldiersOf = (own: boolean) => world.settlers.filter((s) => isFighter(s) && mine(s.owner) === own).length;
    const rows: [string, string][] = [
      [t('end.time'), time],
      [t('end.buildings'), String([...world.buildings.values()].filter((b) => mine(b.owner)).length)],
      [t('end.soldiers'), String(soldiersOf(true))],
      [t('end.enemySoldiers'), String(soldiersOf(false))],
      [t('end.land'), `${land ? Math.round((100 * ownLand) / land) : 0}%`],
    ];
    this.endEl.innerHTML = '';
    this.endEl.append(
      el('h2', outcome === 'won' ? 'won' : 'lost', outcome === 'won' ? t('end.won') : t('end.lost')),
      el('p', '', outcome === 'won' ? t('end.wonText') : t('end.lostText')),
      rowsTable(rows),
      el('h4', '', t('end.score')),
      scoreTable(world, this.state.localPlayer),
    );
    const actions = el('div', 'info-actions');
    const again = el('button', 'active', t('menu.new'));
    // The setup screen of the main menu, with the last game's settings.
    again.onclick = () => (location.href = withLang(`${location.pathname}?menu=new`));
    const watch = el('button', '', t('end.watch'));
    watch.onclick = () => (this.endEl.hidden = true);
    actions.append(again, watch);
    this.endEl.append(actions);
    this.endEl.hidden = false;
  }
}

/**
 * Every player's final score (`scoreOf`, Settlers 4's formula): the parts and the total, best first.
 * Hovering the header shows the formula.
 */
function scoreTable(world: World, me: PlayerId): HTMLTableElement {
  const table = el('table', 'score-table');
  table.title = t('end.scoreTip');
  const head = el('tr');
  const cols: Key[] = ['end.col.player', 'stats.col.killed', 'stats.col.settlers', 'stats.col.fighters', 'end.col.gold', 'end.col.ore', 'end.col.food', 'end.col.buildings', 'stats.col.score'];
  for (const h of cols) head.append(el('th', '', t(h)));
  table.append(head);
  const rows = world.players.map((p) => ({ p, sc: scoreOf(world, p.id) })).sort((a, b) => b.sc.total - a.sc.total || a.p.id - b.p.id);
  for (const { p, sc } of rows) {
    const tr = el('tr', p.id === me ? 'mine' : '');
    const name = p.id === me ? t('common.you') : `${t('common.player', { id: p.id })}${world.isDefeated(p.id) ? ' †' : ''}`;
    for (const v of [name, sc.kills, sc.settlers, sc.fighters, sc.gold, sc.ore, sc.food, sc.buildings]) tr.append(el('td', '', String(v)));
    tr.append(el('td', '', String(sc.total)));
    table.append(tr);
  }
  return table;
}
