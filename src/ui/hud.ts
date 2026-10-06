import { buildingIcon, settlerIcon, wareIcon } from '../render/atlas';
import {
  BUILDINGS,
  CATEGORIES,
  costOf,
  gatheredBy,
  INPUT_CAP,
  OUTPUT_CAP,
  PROFESSIONS,
  RESOURCE_GROUPS,
  RESOURCE_INFO,
  TICKS_PER_SECOND,
  type Category,
  type ResourceGroup,
} from '../sim/config';
import { available, chooseOutput, oreLeft } from '../sim/buildings';
import { isFighter, keepOf } from '../sim/military';
import { hasGatherTargetNear } from '../sim/nature';
import { RESOURCES, type Building, type BuildingType, type Resource, type Settler, type SettlerKind, type Stock } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import type { GameState, Placeable } from './state';

const SPEEDS = [1, 2, 4];
/** Commands that, like buildings, are aimed at a tile from the build menu. */
const COMMANDS: Record<Exclude<Placeable, BuildingType>, { name: string; category: Category; hint: string }> = {
  geologist: { name: 'Геолог', category: 'mining', hint: 'разведка' },
};

/** Player-buildable types, then commands, per build-menu tab. */
const MENU = (Object.keys(CATEGORIES) as Category[]).map((category) => ({
  category,
  types: [
    ...(Object.keys(BUILDINGS) as BuildingType[]).filter(
      (t) => BUILDINGS[t].playerBuildable && BUILDINGS[t].category === category,
    ),
    ...(Object.keys(COMMANDS) as (keyof typeof COMMANDS)[]).filter((c) => COMMANDS[c].category === category),
  ] as Placeable[],
}));

const isBuilding = (p: Placeable): p is BuildingType => p in BUILDINGS;

/** Shown permanently in the top bar; everything else is in the stock panel (📦). */
const PINNED: readonly Resource[] = ['plank', 'stone', 'bread', 'fish', 'meat', 'coal', 'iron', 'gold', 'sword'];

const nameOf = (r: Resource) => RESOURCE_INFO[r].name;

const GATHER_PLACE: Partial<Record<BuildingType, string>> = {
  woodcutter: 'в лесу',
  stonecutter: 'в каменоломне',
  waterworks: 'у воды',
  fisher: 'на берегу',
  farm: 'в поле',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "мечник ×2 (★1 ×1), лучник ×1": fighters by profession, with how many hold each rank above 0. */
function composition(fighters: Settler[]): string {
  const byKind = new Map<SettlerKind, Settler[]>();
  for (const s of fighters) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  return [...byKind]
    .map(([kind, list]) => {
      const ranks = new Map<number, number>();
      for (const s of list) if (s.level > 0) ranks.set(s.level, (ranks.get(s.level) ?? 0) + 1);
      const r = [...ranks].sort((a, b) => b[0] - a[0]).map(([l, n]) => `★${l} ×${n}`);
      return `${PROFESSIONS[kind].name.toLowerCase()} ×${list.length}${r.length ? ` (${r.join(', ')})` : ''}`;
    })
    .join(', ');
}

/** "2 [plank] 1 [stone]" with drawn ware icons. */
function costLabel(type: BuildingType): HTMLElement {
  const cost = costOf(type);
  const out = el('span', 'cost-items');
  for (const r of RESOURCES) {
    if (cost[r] > 0) out.append(String(cost[r]), wareIcon(r, 14), ' ');
  }
  return out;
}

/** Total of `res` in the local player's warehouses. */
function inStorage(world: World, res: Resource): number {
  let n = 0;
  for (const b of world.buildings.values()) {
    if (b.owner === LOCAL_PLAYER && BUILDINGS[b.type].storage) n += b.output[res];
  }
  return n;
}

/** HTML overlay: stock, population, speed, build menu and info about the selected building. */
export class Hud {
  private readonly stockEl = el('div', 'stock');
  private readonly stockPanel = el('div', 'panel stock-panel');
  private readonly statsPanel = el('div', 'panel stats-panel');
  /** `stats.produced` sampled once per game minute, newest last (for "last 10 minutes"). */
  private readonly history: Stock[] = [];
  private lastSampleTick = -Infinity;
  private lastStats = -Infinity;
  /** Number elements per resource, in the top bar and the stock panel; built once, updated in place. */
  private readonly stockValues: [Resource, HTMLElement][] = [];
  private readonly popEl = el('div', 'pop');
  /** Season, year and how far into the season (a thin bar). */
  private readonly seasonEl = el('div', 'season');
  private readonly seasonBar = el('span', 'season-bar');
  private readonly speedButtons = new Map<number | 'pause', HTMLButtonElement>();
  private readonly buildButtons = new Map<Placeable, HTMLButtonElement>();
  private readonly tabButtons: HTMLButtonElement[] = [];
  private readonly tabRows: HTMLElement[] = [];
  private tab = 0;
  private readonly infoEl = el('div', 'panel info');
  private readonly hintEl = el('div', 'hint');
  private readonly toastEl = el('div', 'toast');
  private readonly endEl = el('div', 'panel end-screen');
  /** The end screen was shown (and possibly dismissed to keep watching). */
  private ended = false;
  private lastUpdate = 0;
  /** Building whose demolition awaits a second click. */
  private confirmDemolish: number | null = null;
  /** Soldiers to send with the next attack (clamped to what is available). */
  private attackCount = 1;
  /** Re-render the info panel only when its content changes, so buttons in it stay clickable. */
  private infoKey = '';
  private toastTimer = 0;

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly state: GameState,
    actions: { onSave(): void; onLoad(): void },
  ) {
    const top = el('div', 'panel top');
    for (const r of PINNED) this.stockEl.append(this.stat(r));
    const more = el('button', 'stock-toggle', '📦');
    more.title = 'Весь склад';
    more.onclick = () => {
      this.stockPanel.hidden = !this.stockPanel.hidden;
      this.statsPanel.hidden = true;
      more.blur();
    };
    const stats = el('button', 'stock-toggle', '📊');
    stats.title = 'Статистика';
    stats.onclick = () => {
      this.statsPanel.hidden = !this.statsPanel.hidden;
      this.lastStats = -Infinity;
      this.stockPanel.hidden = true;
      stats.blur();
    };
    this.stockEl.append(more, stats);
    this.statsPanel.hidden = true;
    this.seasonEl.title = 'Время года';
    top.append(this.stockEl, this.seasonEl, this.popEl);
    this.stockPanel.hidden = true;
    for (const [group, title] of Object.entries(RESOURCE_GROUPS) as [ResourceGroup, string][]) {
      this.stockPanel.append(el('h4', '', title));
      const grid = el('div', 'stock-grid');
      for (const r of RESOURCES) {
        if (RESOURCE_INFO[r].group !== group) continue;
        const value = el('b', '', '0');
        const row = el('span', 'stock-row');
        row.append(wareIcon(r), el('span', '', nameOf(r)), value);
        grid.append(row);
        this.stockValues.push([r, value]);
      }
      this.stockPanel.append(grid);
    }

    const speed = el('div', 'panel speed');
    const pause = el('button', '', '⏸');
    pause.title = 'Пауза (пробел)';
    pause.onclick = () => {
      state.paused = !state.paused;
      pause.blur();
    };
    speed.append(pause);
    this.speedButtons.set('pause', pause);
    for (const s of SPEEDS) {
      const b = el('button', '', `${s}×`);
      b.onclick = () => {
        state.speed = s;
        state.paused = false;
        b.blur();
      };
      speed.append(b);
      this.speedButtons.set(s, b);
    }
    const save = el('button', 'sep', '💾');
    save.title = 'Сохранить игру';
    save.onclick = () => {
      actions.onSave();
      save.blur();
    };
    const load = el('button', '', '📂');
    load.title = 'Загрузить сохранение';
    load.onclick = () => {
      actions.onLoad();
      load.blur();
    };
    speed.append(save, load);

    const build = el('div', 'panel build');
    const tabs = el('div', 'tabs');
    MENU.forEach(({ category, types }, t) => {
      const tab = el('button', 'tab', CATEGORIES[category]);
      tab.title = 'Tab — следующая вкладка';
      tab.onclick = () => {
        this.showTab(t);
        tab.blur();
      };
      tabs.append(tab);
      this.tabButtons.push(tab);
      const row = el('div', 'build-row');
      types.forEach((type, i) => {
        const b = el('button', 'build-btn');
        if (isBuilding(type)) {
          const cost = el('span', 'cost');
          cost.append(costLabel(type), `· [${i + 1}]`);
          b.append(buildingIcon(type), el('span', 'name', BUILDINGS[type].name), cost);
        } else {
          const cmd = COMMANDS[type];
          b.append(settlerIcon(type), el('span', 'name', cmd.name), el('span', 'cost', `${cmd.hint} · [${i + 1}]`));
        }
        b.onclick = () => {
          this.selectBuildType(state.placing === type ? null : type);
          b.blur();
        };
        row.append(b);
        this.buildButtons.set(type, b);
      });
      this.tabRows.push(row);
    });
    build.append(tabs, ...this.tabRows);
    this.showTab(0);

    this.infoEl.hidden = true;
    this.endEl.hidden = true;
    root.append(top, this.stockPanel, this.statsPanel, speed, build, this.infoEl, this.hintEl, this.toastEl, this.endEl);
  }

  showTab(t: number): void {
    this.tab = (t + MENU.length) % MENU.length;
    this.tabRows.forEach((row, i) => (row.hidden = i !== this.tab));
    this.tabButtons.forEach((b, i) => b.classList.toggle('active', i === this.tab));
  }

  nextTab(): void {
    this.showTab(this.tab + 1);
  }

  /** Digit hotkey: the n-th building (1-based) of the open tab. */
  hotkey(n: number): void {
    const type = MENU[this.tab].types[n - 1];
    if (type) this.selectBuildType(this.state.placing === type ? null : type);
  }

  selectBuildType(type: Placeable | null): void {
    this.state.placing = type;
    if (type) this.state.selected = null;
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }

  update(nowMs: number): void {
    if (nowMs - this.lastUpdate < 150) return;
    this.lastUpdate = nowMs;
    const { world, state } = this;
    const outcome = world.outcome(LOCAL_PLAYER);
    if (outcome !== 'playing' && !this.ended) this.showEnd(outcome);
    for (const [r, value] of this.stockValues) value.textContent = String(inStorage(world, r));
    if (world.tick - this.lastSampleTick >= TICKS_PER_SECOND * 60) {
      this.lastSampleTick = world.tick;
      this.history.push({ ...world.stats.produced });
      if (this.history.length > 11) this.history.shift();
    }
    if (!this.statsPanel.hidden && nowMs - this.lastStats > 1000) {
      this.lastStats = nowMs;
      this.renderStats();
    }

    const counts = new Map<SettlerKind, number>();
    let busy = 0;
    let people = 0;
    for (const s of world.settlers) {
      if (s.owner !== LOCAL_PLAYER) continue;
      people++;
      counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
      if (s.kind === 'carrier' && s.tasks.length > 0) busy++;
    }
    const workers = [...counts]
      .filter(([kind]) => kind !== 'carrier')
      .map(([kind, n]) => `${PROFESSIONS[kind].name.toLowerCase()} ${n}`)
      .join(' · ');
    const season = world.season();
    const icon = ['🌱', '☀️', '🍂', '❄️'][season.index] ?? '';
    this.seasonEl.textContent = `${icon} ${season.def.name} · год ${season.year + 1} `;
    this.seasonBar.style.setProperty('--p', `${Math.round(season.progress * 100)}%`);
    this.seasonEl.append(this.seasonBar);
    this.popEl.textContent =
      `Поселенцы: ${people} · носильщики ${busy}/${counts.get('carrier') ?? 0} заняты` +
      (workers ? ` · ${workers}` : '');

    for (const [key, b] of this.speedButtons) {
      b.classList.toggle('active', key === 'pause' ? state.paused : !state.paused && state.speed === key);
    }
    for (const [type, b] of this.buildButtons) b.classList.toggle('active', state.placing === type);

    this.hintEl.textContent = state.placing === 'geologist'
      ? 'ЛКМ по своей горе — отправить геолога · ПКМ / Esc — отмена'
      : state.placing
      ? 'ЛКМ — поставить (Shift — несколько) · ПКМ / Esc — отмена'
      : 'Перетаскивание / WASD — камера · колесо — зум · клик по зданию — информация';

    this.renderInfo();
  }

  private stat(r: Resource): HTMLElement {
    const s = el('span', 'stat');
    s.title = nameOf(r);
    const value = el('b', '', '0');
    s.append(wareIcon(r, 20), value);
    this.stockValues.push([r, value]);
    return s;
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
    );
    const table = el('dl');
    for (const [k, v] of rows) table.append(el('dt', '', k), el('dd', '', v));
    this.endEl.append(table);
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

  private renderStats(): void {
    const { world } = this;
    const total = world.stats.produced;
    const old = this.history[0] ?? total;
    const minutes = Math.max(1, this.history.length - 1);
    this.statsPanel.innerHTML = '';
    this.statsPanel.append(el('h4', '', `Производство (за ${minutes} мин / всего)`));
    const grid = el('div', 'stats-grid');
    for (const r of RESOURCES) {
      if (total[r] === 0) continue;
      const row = el('span', 'stock-row');
      row.append(wareIcon(r), el('span', '', nameOf(r)), el('b', '', `${total[r] - old[r]} / ${total[r]}`));
      grid.append(row);
    }
    this.statsPanel.append(grid);

    const kinds = new Map<SettlerKind, number>();
    for (const s of world.settlers) if (s.owner === LOCAL_PLAYER) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    this.statsPanel.append(el('h4', '', 'Население'));
    const people = el('div', 'stats-grid');
    for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
      const row = el('span', 'stock-row');
      row.append(el('span', '', PROFESSIONS[kind].name), el('b', '', String(n)));
      people.append(row);
    }
    this.statsPanel.append(people);

    const types = new Map<BuildingType, number>();
    for (const b of world.buildings.values()) if (b.owner === LOCAL_PLAYER) types.set(b.type, (types.get(b.type) ?? 0) + 1);
    this.statsPanel.append(el('h4', '', 'Здания'));
    const houses = el('div', 'stats-grid');
    for (const [type, n] of [...types].sort((a, b) => b[1] - a[1])) {
      const row = el('span', 'stock-row');
      row.append(el('span', '', BUILDINGS[type].name), el('b', '', String(n)));
      houses.append(row);
    }
    this.statsPanel.append(houses);
  }

  private renderInfo(): void {
    const b = this.state.selected !== null ? this.world.buildings.get(this.state.selected) : undefined;
    this.infoEl.hidden = !b;
    if (!b) {
      this.confirmDemolish = null;
      this.infoKey = '';
      return;
    }
    if (this.confirmDemolish !== null && this.confirmDemolish !== b.id) this.confirmDemolish = null;
    const def = BUILDINGS[b.type];
    const rows: [string, string][] = [];
    const enemy = b.owner !== LOCAL_PLAYER;
    const canSend = enemy && def.garrison && b.done ? this.world.availableAttackers(b.id) : 0;
    // Out of sight (fog of war) other players' buildings show only what is known from afar.
    const sighted = !this.state.fog || this.world.isVisible(b.door.x, b.door.y);
    if (enemy) {
      rows.push(['Владелец', `игрок ${b.owner}`]);
      if (!sighted) rows.push(['Обзор', 'нет — подойдите ближе']);
      if (def.garrison && b.done) {
        rows.push(['Защитников', sighted ? String(b.garrison.length) : '?']);
        if (def.garrison.defense && def.garrison.defense > 1) {
          rows.push(['Бонус обороны', `+${Math.round((def.garrison.defense - 1) * 100)}%`]);
        }
        rows.push(['Можно послать', String(canSend)]);
        this.attackCount = Math.max(1, Math.min(this.attackCount, canSend));
        rows.push(['Отправить', String(this.attackCount)]);
        if (canSend > 0) rows.push(['Пойдут', composition(this.world.attackerComposition(b.id, this.attackCount))]);
      }
    } else if (!b.done) {
      rows.push(['Стройка', `${Math.floor(this.world.buildProgress(b) * 100)}%`]);
      const cost = costOf(b.type);
      for (const r of RESOURCES) {
        if (cost[r] > 0) rows.push([nameOf(r), `${b.delivered[r]} / ${cost[r]} (в пути ${b.inbound[r]})`]);
      }
      if (!b.levelled) rows.push(['Выравнивание', b.diggerId !== null ? 'землекоп работает' : 'ждёт землекопа']);
      rows.push(['Строитель', b.builderId !== null ? 'на месте или в пути' : 'ожидается']);
    } else if (def.residence) {
      rows.push(['Жители', `${b.spawned} / ${def.residence.capacity}`]);
      rows.push(['Статус', b.spawned < def.residence.capacity ? 'заселяется' : 'заселён']);
    } else if (def.garrison || def.storage) {
      if (def.garrison) {
        rows.push(['Гарнизон', `${b.garrison.length} / ${def.garrison.capacity}`]);
        const members = b.garrison.map((id) => this.world.getSettler(id)).filter((s): s is Settler => !!s);
        if (members.length > 0) rows.push(['Состав', composition(members)]);
        rows.push(['Не покидают', String(keepOf(b))]);
        if (def.garrison.trains) rows.push(['Обучение', `золото: ${def.storage ? b.output.gold : b.input.gold}`]);
        if (b.garrisonInbound > 0) rows.push(['Идут в гарнизон', String(b.garrisonInbound)]);
      }
      if (def.territory) rows.push(['Радиус земли', `${def.territory} клеток`]);
      for (const r of RESOURCES) if (def.storage && b.output[r] > 0) rows.push([nameOf(r), String(b.output[r])]);
    } else {
      const worker = this.world.getSettler(b.workerId);
      const tool = PROFESSIONS[def.worker!].tool;
      const workerName = worker
        ? PROFESSIONS[worker.kind].name
        : b.workerRequested
          ? 'идёт'
          : tool && available(this.world, b.owner, tool) === 0
            ? `нет инструмента: ${nameOf(tool).toLowerCase()}`
            : 'нет свободных носильщиков';
      rows.push(['Работник', workerName]);
      rows.push(['Статус', this.status(b)]);
      const gather = gatheredBy(b.type);
      if (def.recipe) {
        for (const r of RESOURCES) {
          if (def.recipe.inputs[r]) rows.push([`${nameOf(r)} (вход)`, `${b.input[r]} / ${INPUT_CAP}`]);
        }
        const anyOf = def.recipe.inputsAnyOf;
        if (anyOf) {
          const held = anyOf.map((r) => `${nameOf(r).toLowerCase()} ${b.input[r]}`).join(', ');
          rows.push(['Еда (вход)', `${held} / ${INPUT_CAP}`]);
        }
        if (def.mine) rows.push(['Руды в радиусе', String(oreLeft(this.world, b))]);
        for (const r of RESOURCES) {
          if (def.recipe.outputs[r]) rows.push([nameOf(r), `${b.output[r]} / ${OUTPUT_CAP}`]);
        }
        for (const r of def.recipe.outputChoice ?? []) {
          if (b.output[r] > 0) rows.push([nameOf(r), `${b.output[r]} / ${OUTPUT_CAP}`]);
        }
      } else if (gather) {
        rows.push([nameOf(gather.res), `${b.output[gather.res]} / ${OUTPUT_CAP}`]);
      } else if (b.type === 'forester') {
        rows.push(['Посажено всего', String(this.world.stats.treesPlanted)]);
      }
      if (def.territory) rows.push(['Радиус земли', `${def.territory} клеток`]);
    }
    if (b.priority) rows.push(['Приоритет', 'да']);
    const key = JSON.stringify([b.id, rows, this.confirmDemolish === b.id]);
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.infoEl.innerHTML = '';
    this.infoEl.append(el('h3', '', def.name));
    const table = el('dl');
    for (const [k, v] of rows) table.append(el('dt', '', k), el('dd', '', v));
    this.infoEl.append(table);
    if (enemy) {
      if (def.garrison && b.done) this.infoEl.append(this.attackControls(b, canSend));
      return;
    }
    if (!def.playerBuildable) return;
    const actions = el('div', 'info-actions');
    if (!b.done || def.recipe || def.residence) {
      const prio = el('button', b.priority ? 'active' : '', b.priority ? '⬆ Приоритет: да' : '⬆ Приоритет');
      prio.title = 'Обслуживать в первую очередь: материалы, сырьё, строители';
      prio.onclick = () => this.world.setPriority(b.id, !b.priority);
      actions.append(prio);
    }
    const confirming = this.confirmDemolish === b.id;
    const demolish = el('button', confirming ? 'danger' : '', confirming ? 'Точно снести?' : '🔨 Снести');
    demolish.onclick = () => {
      if (!confirming) {
        this.confirmDemolish = b.id;
        return;
      }
      this.confirmDemolish = null;
      if (this.world.demolish(b.id)) this.state.selected = null;
    };
    actions.append(demolish);
    this.infoEl.append(actions);
  }

  private attackControls(b: Building, available: number): HTMLElement {
    const actions = el('div', 'info-actions');
    const less = el('button', '', '−');
    less.onclick = () => (this.attackCount = Math.max(1, this.attackCount - 1));
    const more = el('button', '', '+');
    more.onclick = () => (this.attackCount = Math.min(available, this.attackCount + 1));
    const go = el('button', available > 0 ? 'danger' : '', `⚔ Атаковать (${Math.min(this.attackCount, available)})`);
    go.disabled = available === 0;
    go.title = available > 0 ? 'Солдаты из ваших военных зданий поблизости' : 'Рядом нет свободных солдат';
    go.onclick = () => {
      const sent = this.world.attack(b.id, this.attackCount);
      this.toast(sent > 0 ? `В атаку: ${sent}` : 'Некого отправить');
    };
    actions.append(less, more, go);
    return actions;
  }

  private status(b: Building): string {
    if (b.workerId === null) return 'ждёт работника';
    const def = BUILDINGS[b.type];
    const behavior = PROFESSIONS[def.worker!].behavior;
    const w = this.world.getSettler(b.workerId);
    const outside = w !== undefined && w.inside === null;
    switch (behavior) {
      case 'workshop': {
        const recipe = def.recipe!;
        if (def.mine && oreLeft(this.world, b) === 0) return 'выработана';
        if (recipe.outputChoice && !chooseOutput(this.world, b, recipe)) return 'запас полон, заказов нет';
        if (RESOURCES.some((r) => b.output[r] + (recipe.outputs[r] ?? 0) > OUTPUT_CAP)) return 'склад полон';
        const missing = RESOURCES.filter((r) => b.input[r] < (recipe.inputs[r] ?? 0)).map((r) =>
          nameOf(r).toLowerCase(),
        );
        if (recipe.inputsAnyOf && !recipe.inputsAnyOf.some((r) => b.input[r] > 0)) missing.push('еды');
        if (missing.length > 0) return `нет: ${missing.join(', ')}`;
        return 'работает';
      }
      case 'plant':
        return outside ? 'сажает деревья' : 'отдыхает';
      case 'garrison':
        return 'охраняет границу';
      case 'gather':
      case 'farm': {
        const gather = gatheredBy(b.type)!;
        if (b.output[gather.res] >= OUTPUT_CAP) return 'склад полон';
        if (outside) return GATHER_PLACE[b.type] ?? 'работает';
        if (behavior === 'gather' && !hasGatherTargetNear(this.world, b, gather)) {
          return `нет поблизости: ${nameOf(gather.res).toLowerCase()}`;
        }
        return 'отдыхает';
      }
      default:
        return 'работает';
    }
  }
}
