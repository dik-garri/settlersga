import { buildingIcon } from '../render/atlas';
import { BUILDINGS, CATEGORIES, costOf, gatheredBy, INPUT_CAP, OUTPUT_CAP, PROFESSIONS, type Category } from '../sim/config';
import { hasGatherTargetNear } from '../sim/nature';
import { RESOURCES, type Building, type BuildingType, type Resource, type SettlerKind } from '../sim/types';
import type { World } from '../sim/world';
import type { GameState } from './state';

const SPEEDS = [1, 2, 4];
/** Player-buildable types per build-menu tab, in table order. */
const MENU = (Object.keys(CATEGORIES) as Category[]).map((category) => ({
  category,
  types: (Object.keys(BUILDINGS) as BuildingType[]).filter(
    (t) => BUILDINGS[t].playerBuildable && BUILDINGS[t].category === category,
  ),
}));

const RESOURCE_UI: Record<Resource, { icon: string; name: string }> = {
  log: { icon: '🪵', name: 'Брёвна' },
  plank: { icon: '🪚', name: 'Доски' },
  stone: { icon: '🪨', name: 'Камень' },
  water: { icon: '💧', name: 'Вода' },
  fish: { icon: '🐟', name: 'Рыба' },
  grain: { icon: '🌾', name: 'Зерно' },
  flour: { icon: '🥣', name: 'Мука' },
  bread: { icon: '🍞', name: 'Хлеб' },
  pig: { icon: '🐖', name: 'Свиньи' },
  meat: { icon: '🥩', name: 'Мясо' },
};

const GATHER_PLACE: Partial<Record<BuildingType, string>> = {
  woodcutter: 'в лесу',
  stonecutter: 'в каменоломне',
  waterworks: 'у воды',
  fisher: 'на берегу',
  farm: 'в поле',
};

function costLabel(type: BuildingType): string {
  const cost = costOf(type);
  return RESOURCES.filter((r) => cost[r] > 0)
    .map((r) => `${cost[r]} ${RESOURCE_UI[r].icon}`)
    .join(' ');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** HTML overlay: stock, population, speed, build menu and info about the selected building. */
export class Hud {
  private readonly stockEl = el('div', 'stock');
  private readonly popEl = el('div', 'pop');
  private readonly speedButtons = new Map<number | 'pause', HTMLButtonElement>();
  private readonly buildButtons = new Map<BuildingType, HTMLButtonElement>();
  private readonly tabButtons: HTMLButtonElement[] = [];
  private readonly tabRows: HTMLElement[] = [];
  private tab = 0;
  private readonly infoEl = el('div', 'panel info');
  private readonly hintEl = el('div', 'hint');
  private readonly toastEl = el('div', 'toast');
  private lastUpdate = 0;
  private toastTimer = 0;

  constructor(
    root: HTMLElement,
    private readonly world: World,
    private readonly state: GameState,
    actions: { onSave(): void; onLoad(): void },
  ) {
    const top = el('div', 'panel top');
    top.append(this.stockEl, this.popEl);

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
        const def = BUILDINGS[type];
        const b = el('button', 'build-btn');
        b.append(buildingIcon(type), el('span', 'name', def.name), el('span', 'cost', `${costLabel(type)} · [${i + 1}]`));
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
    root.append(top, speed, build, this.infoEl, this.hintEl, this.toastEl);
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

  selectBuildType(type: BuildingType | null): void {
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
    const store = world.castle.output;

    this.stockEl.innerHTML = '';
    this.stockEl.append(...RESOURCES.map((r) => this.stat(RESOURCE_UI[r].icon, RESOURCE_UI[r].name, store[r])));

    const counts = new Map<SettlerKind, number>();
    let busy = 0;
    for (const s of world.settlers) {
      counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
      if (s.kind === 'carrier' && s.tasks.length > 0) busy++;
    }
    const workers = [...counts]
      .filter(([kind]) => kind !== 'carrier')
      .map(([kind, n]) => `${PROFESSIONS[kind].name.toLowerCase()} ${n}`)
      .join(' · ');
    this.popEl.textContent =
      `Поселенцы: ${world.settlers.length} · носильщики ${busy}/${counts.get('carrier') ?? 0} заняты` +
      (workers ? ` · ${workers}` : '');

    for (const [key, b] of this.speedButtons) {
      b.classList.toggle('active', key === 'pause' ? state.paused : !state.paused && state.speed === key);
    }
    for (const [type, b] of this.buildButtons) b.classList.toggle('active', state.placing === type);

    this.hintEl.textContent = state.placing
      ? 'ЛКМ — поставить (Shift — несколько) · ПКМ / Esc — отмена'
      : 'Перетаскивание / WASD — камера · колесо — зум · клик по зданию — информация';

    this.renderInfo();
  }

  private stat(icon: string, label: string, value: number): HTMLElement {
    const s = el('span', 'stat');
    s.title = label;
    s.append(el('span', 'icon', icon), el('b', '', String(value)));
    return s;
  }

  private renderInfo(): void {
    const b = this.state.selected !== null ? this.world.buildings.get(this.state.selected) : undefined;
    this.infoEl.hidden = !b;
    if (!b) return;
    const def = BUILDINGS[b.type];
    const rows: [string, string][] = [];
    if (!b.done) {
      rows.push(['Стройка', `${Math.floor(this.world.buildProgress(b) * 100)}%`]);
      const cost = costOf(b.type);
      for (const r of RESOURCES) {
        if (cost[r] > 0) rows.push([RESOURCE_UI[r].name, `${b.delivered[r]} / ${cost[r]} (в пути ${b.inbound[r]})`]);
      }
      rows.push(['Строитель', b.builderId !== null ? 'на месте или в пути' : 'ожидается']);
    } else if (def.residence) {
      rows.push(['Жители', `${b.spawned} / ${def.residence.capacity}`]);
      rows.push(['Статус', b.spawned < def.residence.capacity ? 'заселяется' : 'заселён']);
    } else if (def.storage) {
      for (const r of RESOURCES) rows.push([RESOURCE_UI[r].name, String(b.output[r])]);
    } else {
      const worker = this.world.getSettler(b.workerId);
      const workerName = worker ? PROFESSIONS[worker.kind].name : b.workerRequested ? 'идёт' : 'нет свободных';
      rows.push(['Работник', workerName]);
      rows.push(['Статус', this.status(b)]);
      const gather = gatheredBy(b.type);
      if (def.recipe) {
        for (const r of RESOURCES) {
          if (def.recipe.inputs[r]) rows.push([`${RESOURCE_UI[r].name} (вход)`, `${b.input[r]} / ${INPUT_CAP}`]);
        }
        for (const r of RESOURCES) {
          if (def.recipe.outputs[r]) rows.push([RESOURCE_UI[r].name, `${b.output[r]} / ${OUTPUT_CAP}`]);
        }
      } else if (gather) {
        rows.push([RESOURCE_UI[gather.res].name, `${b.output[gather.res]} / ${OUTPUT_CAP}`]);
      } else if (b.type === 'forester') {
        rows.push(['Посажено всего', String(this.world.stats.treesPlanted)]);
      }
      if (def.territory) rows.push(['Радиус земли', `${def.territory} клеток`]);
    }
    this.infoEl.innerHTML = '';
    this.infoEl.append(el('h3', '', def.name));
    const table = el('dl');
    for (const [k, v] of rows) table.append(el('dt', '', k), el('dd', '', v));
    this.infoEl.append(table);
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
        if (RESOURCES.some((r) => b.output[r] + (recipe.outputs[r] ?? 0) > OUTPUT_CAP)) return 'склад полон';
        const missing = RESOURCES.filter((r) => b.input[r] < (recipe.inputs[r] ?? 0));
        if (missing.length > 0) return `нет: ${missing.map((r) => RESOURCE_UI[r].name.toLowerCase()).join(', ')}`;
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
          return `нет поблизости: ${RESOURCE_UI[gather.res].name.toLowerCase()}`;
        }
        return 'отдыхает';
      }
      default:
        return 'работает';
    }
  }
}
