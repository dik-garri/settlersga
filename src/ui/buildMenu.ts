import { buildingIcon, wareIcon } from '../render/atlas';
import { BUILDINGS, CATEGORIES, costOf } from '../sim/config';
import { RESOURCES, type Building, type BuildingType } from '../sim/types';
import type { World } from '../sim/world';
import { el, type View } from './dom';
import { nextBuildingOfType } from './find';
import { t } from './i18n';
import { buildingOpen, tabOpen } from './locks';
import { buildingName, categoryName } from './names';
import { tag } from './uiTarget';
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
  private readonly buttons = new Map<BuildingType, { b: HTMLButtonElement; count: HTMLElement; tip: string }>();
  private readonly tabTips: string[] = [];
  /** The locks last drawn (`GameState.locks`), so greying is redone only when they change. */
  private locksSeen: unknown = undefined;
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
      const tab = tag(el('button', 'cat-tab'), `build.tab.${category}`);
      tab.title = t('build.tabTip', { name: categoryName(category) });
      this.tabTips.push(tab.title);
      if (types[0]) tab.append(buildingIcon(types[0], 28));
      tab.onclick = () => {
        // A tab the tutorial has not opened yet stays shut.
        if (tabOpen(this.state.locks, category)) this.showTab(k);
        tab.blur();
      };
      tabs.append(tab);
      this.tabButtons.push(tab);
      const grid = el('div', 'build-grid');
      types.forEach((type, i) => {
        const b = tag(el('button', 'build-btn'), `build.item.${type}`);
        b.title = t('build.buttonTip', { name: buildingName(type), n: i + 1 });
        const count = el('span', 'build-count', '0');
        const pic = el('span', 'build-pic');
        pic.append(buildingIcon(type, 58));
        const cost = el('span', 'cost');
        cost.append(costLabel(type));
        b.append(count, pic, el('span', 'name', buildingName(type)), cost);
        b.onclick = () => {
          if (buildingOpen(this.state.locks, type)) this.select(this.state.placing === type ? null : type);
          b.blur();
        };
        b.oncontextmenu = (e) => {
          e.preventDefault();
          const next = nextBuildingOfType(this.world, this.state.localPlayer, type, this.lastFound);
          if (!next) return;
          this.lastFound = next.id;
          this.select(null);
          this.focus(next);
        };
        grid.append(b);
        this.buttons.set(type, { b, count, tip: b.title });
      });
      this.grids.push(grid);
    });
    this.el.append(tabs, this.title, ...this.grids);
    this.showTab(0);
  }

  showTab(t: number): void {
    // Tab and the digit keys skip the tabs the tutorial keeps shut.
    for (let k = 0; k < MENU.length; k++) {
      const i = (((t + k) % MENU.length) + MENU.length) % MENU.length;
      if (tabOpen(this.state.locks, MENU[i].category)) {
        t = i;
        break;
      }
    }
    this.tab = (t + MENU.length) % MENU.length;
    this.grids.forEach((g, i) => (g.hidden = i !== this.tab));
    this.tabButtons.forEach((b, i) => b.classList.toggle('active', i === this.tab));
    this.title.textContent = categoryName(MENU[this.tab].category);
  }

  nextTab(): void {
    this.showTab(this.tab + 1);
  }

  /** The n-th building (1-based) of the open category, unless the tutorial keeps it shut. */
  typeAt(n: number): BuildingType | undefined {
    const type = MENU[this.tab].types[n - 1];
    return type && buildingOpen(this.state.locks, type) ? type : undefined;
  }

  /** Greys out (with a lock and «opens later») the tabs and buildings the tutorial has not opened. */
  private showLocks(): void {
    const locks = this.state.locks;
    if (locks === this.locksSeen) return;
    this.locksSeen = locks;
    MENU.forEach(({ category }, k) => {
      const open = tabOpen(locks, category);
      this.tabButtons[k].classList.toggle('locked', !open);
      this.tabButtons[k].title = open ? this.tabTips[k] : `${this.tabTips[k]} — ${t('tut.ui.locked')}`;
    });
    for (const [type, { b, tip }] of this.buttons) {
      const open = buildingOpen(locks, type);
      b.classList.toggle('locked', !open);
      b.title = open ? tip : `${tip} — ${t('tut.ui.locked')}`;
    }
    if (!tabOpen(locks, MENU[this.tab].category)) this.showTab(this.tab);
  }

  update(): void {
    this.showLocks();
    const done = new Map<BuildingType, number>();
    const sites = new Map<BuildingType, number>();
    for (const b of this.world.buildings.values()) {
      if (b.owner !== this.state.localPlayer) continue;
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
