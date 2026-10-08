import { settlerIcon, wareIcon } from '../render/atlas';
import { RESOURCE_INFO, TICKS_PER_SECOND } from '../sim/config';
import { isFighter } from '../sim/military';
import type { Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { ArmyView } from './armyPanel';
import { BuildView } from './buildMenu';
import { button, el, rowsTable, type View } from './dom';
import { inStorage, GoodsView } from './goodsView';
import { glyph, type GlyphName } from './icons';
import { InfoView } from './infoPanel';
import { OptionsView, SPEEDS } from './optionsView';
import { SettlerInfoView } from './settlerInfo';
import { UnitsView } from './unitsView';
import { SettlersView } from './settlersView';
import type { GameState, Placeable } from './state';
import { StatsView } from './statsView';

/**
 * The HUD, laid out like Settlers 4's: a framed panel down the left side of the screen — the minimap
 * on top, a row of gem buttons for the main menus (build, goods, settlers, statistics, army,
 * options), the open menu (or the selected building's window, which replaces it as in the original),
 * and a readout of key goods, settlers, soldiers and army strength at the bottom. The game view
 * starts right of the panel (`--side-w`). A small strip top right holds pause and speed, the message
 * ticker runs along the bottom of the view. All drawing is ours (CSS and inline SVG).
 */

type MenuId = 'build' | 'goods' | 'settlers' | 'stats' | 'army' | 'options';

const MENUS: { id: MenuId; glyph: GlyphName; title: string }[] = [
  { id: 'build', glyph: 'build', title: 'Строительство' },
  { id: 'goods', glyph: 'goods', title: 'Товары' },
  { id: 'settlers', glyph: 'settlers', title: 'Поселенцы' },
  { id: 'stats', glyph: 'stats', title: 'Статистика' },
  { id: 'army', glyph: 'army', title: 'Армия' },
  { id: 'options', glyph: 'options', title: 'Настройки' },
];

/** Goods always shown in the readout; everything else is in the goods menu. */
const PINNED: readonly Resource[] = ['plank', 'stone', 'log', 'bread', 'fish', 'meat', 'coal', 'iron', 'gold'];

/** How long a ticker message stays (ms). */
const MESSAGE_MS = 6000;

export interface HudOptions {
  params: URLSearchParams;
  /** The minimap canvas, framed at the top of the panel. */
  minimap: HTMLElement;
  /** Sound controls for the options menu. */
  sound: HTMLElement | null;
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

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly state: GameState,
    actions: { onSave(): void; onLoad(): void },
    opts: HudOptions,
  ) {
    const select = (type: Placeable | null) => this.selectBuildType(type);
    this.build = new BuildView(world, state, select);
    this.stats = new StatsView(world);
    this.info = new InfoView(world, state, (text) => this.toast(text));
    this.settlerInfo = new SettlerInfoView(world, state, {
      place: (p) => select(p),
      toast: (text) => this.toast(text),
    });
    this.unitsView = new UnitsView(world, state, (text) => this.toast(text));
    this.views = {
      build: this.build,
      goods: new GoodsView(world),
      settlers: new SettlersView(world, state, select),
      stats: this.stats,
      army: new ArmyView(world),
      options: new OptionsView(state, actions, opts.params, opts.sound),
    };

    const side = el('aside', 'side');
    const frame = el('div', 'side-frame');
    const map = el('div', 'mm-frame');
    map.append(opts.minimap);
    const tabs = el('nav', 'main-tabs');
    for (const m of MENUS) {
      const b = el('button', 'gem');
      b.title = m.title;
      b.append(glyph(m.glyph));
      b.onclick = () => {
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
    const pause = el('button', 'gem small');
    pause.title = 'Пауза (пробел)';
    pause.append(glyph('pause', 14));
    pause.onclick = () => {
      state.paused = !state.paused;
      pause.blur();
    };
    strip.append(pause);
    this.speedButtons.set('pause', pause);
    for (const s of SPEEDS) {
      const b = button(`${s}×`, `Скорость ${s}×`, () => {
        state.speed = s;
        state.paused = false;
      }, 'speed-btn');
      strip.append(b);
      this.speedButtons.set(s, b);
    }

    this.endEl.hidden = true;
    root.append(side, strip, this.hintEl, this.ticker, this.endEl);
    this.showMenu('build');
  }

  /** The always-visible stats block: key goods, settlers, soldiers and army strength (Settlers 4). */
  private readout(): HTMLElement {
    const box = el('div', 'readout');
    const goods = el('div', 'readout-goods');
    for (const r of PINNED) {
      const s = el('span', 'stat');
      s.title = RESOURCE_INFO[r].name;
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
      cell(settlerIcon('carrier', 26), this.people, 'Поселенцы'),
      cell(settlerIcon('soldier', 26), this.soldiers, 'Бойцы'),
      cell(el('span', 'strength-ico', '⚔'), this.strength, 'Сила армии на чужой земле: растёт с ценностью поселения'),
    );
    box.append(goods, army);
    return box;
  }

  private showMenu(id: MenuId): void {
    this.menu = id;
    for (const [m, b] of this.menuButtons) b.classList.toggle('active', m === id);
    this.mount(this.views[id], MENUS.find((m) => m.id === id)!.title);
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

  /** A message on the ticker at the bottom of the view; it fades after a few seconds. */
  toast(text: string): void {
    const m = el('div', 'msg', text);
    this.ticker.append(m);
    while (this.ticker.children.length > 4) this.ticker.firstElementChild!.remove();
    window.setTimeout(() => m.classList.add('gone'), MESSAGE_MS);
    window.setTimeout(() => m.remove(), MESSAGE_MS + 600);
  }

  update(nowMs: number): void {
    if (nowMs - this.lastUpdate < 150) return;
    this.lastUpdate = nowMs;
    const { world, state } = this;
    const outcome = world.outcome(LOCAL_PLAYER);
    if (outcome !== 'playing' && !this.ended) this.showEnd(outcome);
    this.stats.sample();

    // The selected building's window replaces the open menu, as in Settlers 4.
    if (state.selected !== null && world.buildings.has(state.selected)) {
      this.mount(this.info, 'Здание');
      for (const b of this.menuButtons.values()) b.classList.remove('active');
    } else if (state.selectedSettler !== null && world.getSettler(state.selectedSettler)) {
      this.mount(this.settlerInfo, 'Поселенец');
      for (const b of this.menuButtons.values()) b.classList.remove('active');
    } else if (state.selectedUnits.length > 0 && this.unitsView.units().length > 0) {
      // Selected army units: the selection panel, as in Settlers 4.
      this.mount(this.unitsView, 'Отряд');
      for (const b of this.menuButtons.values()) b.classList.remove('active');
    } else {
      if (state.selected !== null) state.selected = null;
      if (state.selectedSettler !== null) state.selectedSettler = null;
      this.showMenu(this.menu);
    }
    this.shown?.update(nowMs);

    for (const [r, value] of this.readoutValues) {
      const text = String(inStorage(world, r));
      if (value.textContent !== text) value.textContent = text;
    }
    let people = 0;
    let fighters = 0;
    for (const s of world.settlers) {
      if (s.owner !== LOCAL_PLAYER) continue;
      people++;
      if (isFighter(s)) fighters++;
    }
    this.people.textContent = String(people);
    this.soldiers.textContent = String(fighters);
    this.strength.textContent = `${Math.round(world.strengthOf())}%`;

    for (const [key, b] of this.speedButtons) {
      b.classList.toggle('active', key === 'pause' ? state.paused : !state.paused && state.speed === key);
    }
    this.hintEl.textContent =
      state.placing === 'geologist'
        ? 'ЛКМ по своей горе — отправить геолога · ПКМ / Esc — отмена'
        : state.placing === 'pioneer'
          ? 'ЛКМ у своей границы — первопроходец займёт ничейную землю · ПКМ / Esc — отмена'
          : state.placing === 'thief'
            ? 'ЛКМ по разведанному чужому зданию с товарами — послать вора · ПКМ / Esc — отмена'
            : state.placing
              ? 'ЛКМ — поставить (Shift — несколько) · ПКМ / Esc — отмена'
              : state.selectedUnits.length > 0
                ? 'ПКМ: бойцы — идти, атаковать, в гарнизон · геолог — разведать гору · первопроходец — занять землю · вор — украсть · Shift+ЛКМ — добавить · Esc — снять выбор'
                : 'ЛКМ-рамка или клик по бойцу — выбрать отряд · ПКМ/СКМ-перетаскивание, WASD — камера · колесо — зум · клик по зданию — его окно';
  }

  /** Victory or defeat: time played, a few totals, and a way to start over or keep watching. */
  private showEnd(outcome: 'won' | 'lost'): void {
    this.ended = true;
    const { world } = this;
    const seconds = Math.floor(world.tick / TICKS_PER_SECOND);
    const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    // Per-player facts only: `stats.produced` counts every player together.
    const mine = (p: number) => p === LOCAL_PLAYER;
    const land = world.map.owner.reduce((n, o) => n + (o !== 0 ? 1 : 0), 0);
    const ownLand = world.map.owner.reduce((n, o) => n + (mine(o) ? 1 : 0), 0);
    const soldiersOf = (own: boolean) => world.settlers.filter((s) => isFighter(s) && mine(s.owner) === own).length;
    const rows: [string, string][] = [
      ['Время игры', time],
      ['Ваших зданий', String([...world.buildings.values()].filter((b) => mine(b.owner)).length)],
      ['Ваших солдат', String(soldiersOf(true))],
      ['Солдат у противников', String(soldiersOf(false))],
      ['Ваша доля земли', `${land ? Math.round((100 * ownLand) / land) : 0}%`],
    ];
    this.endEl.innerHTML = '';
    this.endEl.append(
      el('h2', outcome === 'won' ? 'won' : 'lost', outcome === 'won' ? 'Победа!' : 'Поражение'),
      el('p', '', outcome === 'won' ? 'Все замки противников взяты.' : 'Ваш замок захвачен.'),
      rowsTable(rows),
    );
    const actions = el('div', 'info-actions');
    const again = el('button', 'active', 'Новая игра');
    again.onclick = () => {
      const params = new URLSearchParams(location.search);
      params.set('seed', String(Math.floor(Math.random() * 1e9)));
      params.delete('load');
      location.search = `?${params}`;
    };
    const watch = el('button', '', 'Смотреть дальше');
    watch.onclick = () => (this.endEl.hidden = true);
    actions.append(again, watch);
    this.endEl.append(actions);
    this.endEl.hidden = false;
  }
}
