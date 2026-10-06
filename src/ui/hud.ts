import { buildingIcon } from '../render/atlas';
import { BUILDINGS, costOf, gatheredBy, INPUT_CAP, OUTPUT_CAP, PROFESSIONS } from '../sim/config';
import { RESOURCES, type Building, type BuildingType, type Resource, type SettlerKind } from '../sim/types';
import type { World } from '../sim/world';
import type { GameState } from './state';

const SPEEDS = [1, 2, 4];
const PLAYER_BUILDINGS: BuildingType[] = ['woodcutter', 'sawmill', 'forester', 'stonecutter', 'tower'];

const RESOURCE_UI: Record<Resource, { icon: string; name: string }> = {
  log: { icon: '🪵', name: 'Брёвна' },
  plank: { icon: '🪚', name: 'Доски' },
  stone: { icon: '🪨', name: 'Камень' },
};

const GATHER_PLACE: Partial<Record<BuildingType, string>> = {
  woodcutter: 'в лесу',
  stonecutter: 'в каменоломне',
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
    PLAYER_BUILDINGS.forEach((type, i) => {
      const def = BUILDINGS[type];
      const b = el('button', 'build-btn');
      b.append(buildingIcon(type), el('span', 'name', def.name), el('span', 'cost', `${costLabel(type)} · [${i + 1}]`));
      b.onclick = () => {
        this.selectBuildType(state.placing === type ? null : type);
        b.blur();
      };
      build.append(b);
      this.buildButtons.set(type, b);
    });

    this.infoEl.hidden = true;
    root.append(top, speed, build, this.infoEl, this.hintEl, this.toastEl);
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

    const counts: Record<SettlerKind, number> = {
      carrier: 0,
      builder: 0,
      woodcutter: 0,
      sawmiller: 0,
      forester: 0,
      stonecutter: 0,
      guard: 0,
    };
    let busy = 0;
    for (const s of world.settlers) {
      counts[s.kind]++;
      if (s.kind === 'carrier' && s.tasks.length > 0) busy++;
    }
    this.popEl.textContent =
      `Поселенцы: ${world.settlers.length} · носильщики ${busy}/${counts.carrier} заняты · ` +
      `строители ${counts.builder} · лесорубы ${counts.woodcutter} · пильщики ${counts.sawmiller} · ` +
      `лесничие ${counts.forester} · каменотёсы ${counts.stonecutter} · стражники ${counts.guard}`;

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
    s.append(el('span', 'icon', icon), el('b', '', String(value)), el('span', 'label', label));
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
      case 'gather': {
        const gather = gatheredBy(b.type)!;
        if (b.output[gather.res] >= OUTPUT_CAP) return 'склад полон';
        return outside ? (GATHER_PLACE[b.type] ?? 'работает') : 'отдыхает';
      }
      default:
        return 'работает';
    }
  }
}
