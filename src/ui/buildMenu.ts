import { buildingIcon, wareIcon } from '../render/atlas';
import { BUILDINGS, CATEGORIES, costOf } from '../sim/config';
import { RESOURCES, type Building, type BuildingType } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { el, type View } from './dom';
import { nextBuildingOfType } from './find';
import { t } from './i18n';
import { buildingName, categoryName } from './names';
import type { GameState, Placeable } from './state';

/**
 * The build menu of the side panel, laid out like Settlers 4's: a row of category buttons (each shows
 * a building of its tab), then a two-column grid of building pictures with how many the player has
 * (finished, and sites in brackets), the name and the cost. Digits pick the n-th building of the open
 * category, Tab cycles categories. A right click on a building jumps to the player's next building
 * (or site) of that type, as in Settlers 4.
 */

/** Player-buildable types per build-menu category. */
export const MENU = CATEGORIES.map((category) => ({
  category,
  types: (Object.keys(BUILDINGS) as BuildingType[]).filter(
    (t) => BUILDINGS[t].playerBuildable && BUILDINGS[t].category === category,
  ),
}));

/** "2 [plank] 1 [stone]" with drawn ware icons. */
export function costLabel(type: BuildingType): HTMLElement {
  const cost = costOf(type);
  const out = el('span', 'cost-items');
  for (const r of RESOURCES) {
    if (cost[r] > 0) out.append(String(cost[r]), wareIcon(r, 13), ' ');
  }
  return out;
}

export class BuildView implements View {
  readonly el = el('div', 'view build-view');
  private readonly tabButtons: HTMLButtonElement[] = [];
  private readonly grids: HTMLElement[] = [];
  private readonly buttons = new Map<BuildingType, { b: HTMLButtonElement; count: HTMLElement }>();
  private readonly title = el('h4', 'view-sub');
  private tab = 0;
  /** The building the last right click jumped to (the next one comes after it). */
  private lastFound: number | null = null;

  constructor(
    private readonly world: World,
    private readonly state: GameState,
    private readonly select: (type: Placeable | null) => void,
    private readonly focus: (b: Building) => void,
  ) {
    const tabs = el('div', 'cat-tabs');
    MENU.forEach(({ category, types }, k) => {
      const tab = el('button', 'cat-tab');
      tab.title = t('build.tabTip', { name: categoryName(category) });
      if (types[0]) tab.append(buildingIcon(types[0], 28));
      tab.onclick = () => {
        this.showTab(k);
        tab.blur();
      };
      tabs.append(tab);
      this.tabButtons.push(tab);
      const grid = el('div', 'build-grid');
      types.forEach((type, i) => {
        const b = el('button', 'build-btn');
        b.title = t('build.buttonTip', { name: buildingName(type), n: i + 1 });
        const count = el('span', 'build-count', '0');
        const pic = el('span', 'build-pic');
        pic.append(buildingIcon(type, 58));
        const cost = el('span', 'cost');
        cost.append(costLabel(type));
        b.append(count, pic, el('span', 'name', buildingName(type)), cost);
        b.onclick = () => {
          this.select(this.state.placing === type ? null : type);
          b.blur();
        };
        b.oncontextmenu = (e) => {
          e.preventDefault();
          const next = nextBuildingOfType(this.world, type, this.lastFound);
          if (!next) return;
          this.lastFound = next.id;
          this.select(null);
          this.focus(next);
        };
        grid.append(b);
        this.buttons.set(type, { b, count });
      });
      this.grids.push(grid);
    });
    this.el.append(tabs, this.title, ...this.grids);
    this.showTab(0);
  }

  showTab(t: number): void {
    this.tab = (t + MENU.length) % MENU.length;
    this.grids.forEach((g, i) => (g.hidden = i !== this.tab));
    this.tabButtons.forEach((b, i) => b.classList.toggle('active', i === this.tab));
    this.title.textContent = categoryName(MENU[this.tab].category);
  }

  nextTab(): void {
    this.showTab(this.tab + 1);
  }

  /** The n-th building (1-based) of the open category. */
  typeAt(n: number): BuildingType | undefined {
    return MENU[this.tab].types[n - 1];
  }

  update(): void {
    const done = new Map<BuildingType, number>();
    const sites = new Map<BuildingType, number>();
    for (const b of this.world.buildings.values()) {
      if (b.owner !== LOCAL_PLAYER) continue;
      const m = b.done ? done : sites;
      m.set(b.type, (m.get(b.type) ?? 0) + 1);
    }
    for (const [type, { b, count }] of this.buttons) {
      b.classList.toggle('active', this.state.placing === type);
      const n = done.get(type) ?? 0;
      const s = sites.get(type) ?? 0;
      const text = s > 0 ? `${n}+${s}` : String(n);
      if (count.textContent !== text) count.textContent = text;
    }
  }
}
