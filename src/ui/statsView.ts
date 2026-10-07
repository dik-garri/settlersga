import { wareIcon } from '../render/atlas';
import { BUILDINGS, PROFESSIONS, RESOURCE_INFO, TICKS_PER_SECOND } from '../sim/config';
import { RESOURCES, type BuildingType, type SettlerKind, type Stock } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { el, type View } from './dom';

/**
 * The statistics menu: production over the last minutes and in total, population by profession and
 * buildings by type. `stats.produced` is sampled once per game minute (UI-only history).
 */
export class StatsView implements View {
  readonly el = el('div', 'view stats-view');
  /** `stats.produced` sampled once per game minute, newest last (for "last 10 minutes"). */
  private readonly history: Stock[] = [];
  private lastSampleTick = -Infinity;
  private lastRender = -Infinity;

  constructor(private readonly world: World) {}

  /** Keeps the minute samples going even while the view is hidden. */
  sample(): void {
    const { world } = this;
    if (world.tick - this.lastSampleTick < TICKS_PER_SECOND * 60) return;
    this.lastSampleTick = world.tick;
    this.history.push({ ...world.stats.produced });
    if (this.history.length > 11) this.history.shift();
  }

  update(nowMs: number): void {
    if (nowMs - this.lastRender < 1000) return;
    this.lastRender = nowMs;
    const { world } = this;
    const total = world.stats.produced;
    const old = this.history[0] ?? total;
    const minutes = Math.max(1, this.history.length - 1);
    this.el.innerHTML = '';
    this.el.append(el('h4', '', `Производство (за ${minutes} мин / всего)`));
    const grid = el('div', 'stats-grid');
    for (const r of RESOURCES) {
      if (total[r] === 0) continue;
      const row = el('span', 'stock-row');
      row.append(wareIcon(r, 16), el('span', 'stock-name', RESOURCE_INFO[r].name), el('b', '', `${total[r] - old[r]} / ${total[r]}`));
      grid.append(row);
    }
    this.el.append(grid);

    const kinds = new Map<SettlerKind, number>();
    for (const s of world.settlers) if (s.owner === LOCAL_PLAYER) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    this.el.append(el('h4', '', 'Население'));
    const people = el('div', 'stats-grid');
    for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
      const row = el('span', 'stock-row');
      row.append(el('span', 'stock-name', PROFESSIONS[kind].name), el('b', '', String(n)));
      people.append(row);
    }
    this.el.append(people);

    const types = new Map<BuildingType, number>();
    for (const b of world.buildings.values()) if (b.owner === LOCAL_PLAYER) types.set(b.type, (types.get(b.type) ?? 0) + 1);
    this.el.append(el('h4', '', 'Здания'));
    const houses = el('div', 'stats-grid');
    for (const [type, n] of [...types].sort((a, b) => b[1] - a[1])) {
      const row = el('span', 'stock-row');
      row.append(el('span', 'stock-name', BUILDINGS[type].name), el('b', '', String(n)));
      houses.append(row);
    }
    this.el.append(houses);
  }
}
