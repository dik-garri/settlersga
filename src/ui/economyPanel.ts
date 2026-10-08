import { buildingIcon, settlerIcon, wareIcon } from '../render/atlas';
import { BUILDINGS, ORDERABLE, PROFESSIONS, RESOURCE_INFO } from '../sim/config';
import {
  consumersOf,
  distributableGoods,
  distributionWeight,
  economyOf,
  ENDLESS,
  workerOrder,
  workersOf,
} from '../sim/economy';
import type { Building, Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { storageFill } from '../sim/storage';
import { button, el, type View } from './dom';
import { goodsLists } from './goodsLists';

/**
 * Economy settings as in Settlers 4 (`sim/economy.ts`): the settlers menu's worker orders and the goods
 * menu's distribution (views of the side panel), plus controls inside building windows — the
 * toolsmith's order queue and a warehouse's accepted goods.
 */

const nameOf = (r: Resource) => RESOURCE_INFO[r].name;

/** Settlers menu: builders, diggers and specialists ordered from free carriers (Settlers 4). */
export class WorkersView implements View {
  readonly el = el('div', 'view workers-view');
  private key = '';

  constructor(private readonly world: World) {}

  update(): void {
    const w = this.world;
    const workers = ORDERABLE.map((k) => [workersOf(w, LOCAL_PLAYER, k), workerOrder(w, LOCAL_PLAYER, k)]);
    const key = JSON.stringify(workers);
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    this.el.append(el('h4', '', 'Заказ рабочих'));
    this.el.append(
      el('p', 'muted', 'Строители, землекопы и специалисты набираются из свободных носильщиков с инструментом — сколько заказано.'),
    );
    ORDERABLE.forEach((kind, i) => {
      const [have, ordered] = workers[i];
      const row = el('div', 'eco-row');
      row.append(settlerIcon(kind, 28), el('span', 'eco-name', PROFESSIONS[kind].name), el('b', '', `${have} / ${ordered}`));
      const set = (n: number) => {
        w.orderWorkers(kind, Math.max(0, n));
        this.update();
      };
      row.append(
        button('−1', 'Заказать на одного меньше', () => set(ordered - 1)),
        button('+1', 'Заказать ещё одного', () => set(ordered + 1)),
        button('+5', 'Заказать ещё пятерых', () => set(ordered + 5)),
        button('↩', 'Отпустить одного свободного (на своей земле): снова станет носильщиком', () => {
          w.dismissSpecialist(kind);
          this.update();
        }),
      );
      this.el.append(row);
    });
  }
}

/** Goods menu, distribution part: which share of a good each kind of consumer gets (Settlers 4). */
export class DistributionView implements View {
  readonly el = el('div', 'view distribution-view');
  private key = '';

  constructor(private readonly world: World) {}

  update(): void {
    const w = this.world;
    const key = JSON.stringify(economyOf(w, LOCAL_PLAYER).distribution);
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    this.el.append(el('h4', '', 'Распределение товаров'));
    this.el.append(el('p', 'muted', 'Какую долю товара получает каждый вид зданий. Без настройки делится поровну.'));
    for (const res of distributableGoods()) {
      const block = el('div', 'eco-dist');
      const head = el('div', 'eco-row');
      head.append(wareIcon(res, 18), el('span', 'eco-name', nameOf(res)));
      block.append(head);
      const types = consumersOf(res);
      const total = types.reduce((n, t) => n + distributionWeight(w, LOCAL_PLAYER, res, t), 0) || 1;
      for (const type of types) {
        const weight = distributionWeight(w, LOCAL_PLAYER, res, type);
        const row = el('label', 'eco-row eco-share');
        const slider = el('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = '100';
        slider.step = '10';
        slider.value = String(weight);
        slider.oninput = () => w.setDistribution(res, type, Number(slider.value));
        slider.onchange = () => this.update();
        row.append(buildingIcon(type, 22), el('span', 'eco-name', BUILDINGS[type].name), slider, el('b', '', `${Math.round((100 * weight) / total)}%`));
        block.append(row);
      }
      this.el.append(block);
    }
  }
}

/** Rows for the building window that the economy adds (mine attempts, house size). */
export function economyRows(b: Building): [string, string][] {
  const def = BUILDINGS[b.type];
  const rows: [string, string][] = [];
  if (def.mine && b.done) {
    rows.push(['Любимая еда', nameOf(def.mine.favourite).toLowerCase()]);
    rows.push(['Попыток в запасе', String(b.attempts ?? 0)]);
  }
  if (def.storage) rows.push(...storageRows(b));
  // As in Settlers 4 a new warehouse takes nothing until goods are ticked in its window.
  if (def.storage && !b.accept?.length) rows.push(['Принимает', 'ничего — отметьте товары']);
  return rows;
}

/** How full a warehouse is (Settlers 4: piles of 8, a good may take several; `sim/storage.ts`). */
export function storageRows(b: Building): [string, string][] {
  const def = BUILDINGS[b.type].storage;
  if (!def || !b.done) return [];
  const fill = storageFill(b);
  if (fill.capacity === Infinity) return [['Вместимость', 'без предела']];
  const rows: [string, string][] = [['Заполнено', `${fill.units} / ${fill.capacity}`]];
  if (fill.maxPiles !== undefined) rows.push(['Стопки', `${fill.piles} из ${fill.maxPiles} (по ${def.perPile} шт.)`]);
  const full = fill.units >= fill.capacity || (fill.maxPiles !== undefined && (fill.piles ?? 0) >= fill.maxPiles);
  if (full) rows.push(['Статус', 'полон: новые товары ждут у производителей']);
  return rows;
}

/** A good's count in a warehouse window, with the piles it takes when the warehouse stacks in piles. */
export function stockText(b: Building, res: Resource): string {
  const n = b.output[res];
  const per = BUILDINGS[b.type].storage?.perPile;
  if (!per || n <= 0) return String(n);
  const piles = Math.ceil(n / per);
  const ten = piles % 10;
  const teen = piles % 100 >= 11 && piles % 100 <= 14;
  const word = ten === 1 && !teen ? 'стопка' : ten >= 2 && ten <= 4 && !teen ? 'стопки' : 'стопок';
  return `${n} · ${piles} ${word}`;
}

/** A string that changes whenever the economy controls of this building must be redrawn. */
export function economyKey(world: World, b: Building): string {
  const def = BUILDINGS[b.type];
  if (def.recipe?.orderable) return JSON.stringify(economyOf(world, b.owner).toolOrders);
  if (def.storage) return JSON.stringify(b.accept ?? []);
  return '';
}

/** The toolsmith's order queue: per tool, +1 / +5 / endless / clear. */
export function toolOrderControls(world: World, b: Building): HTMLElement | null {
  const recipe = BUILDINGS[b.type].recipe;
  if (!recipe?.orderable || b.owner !== LOCAL_PLAYER) return null;
  const orders = economyOf(world, b.owner).toolOrders;
  const box = el('div', 'eco-orders');
  box.append(el('h4', '', 'Заказы'), el('p', 'muted', 'Заказанное куётся первым, потом — что нужно поселению.'));
  for (const res of recipe.outputChoice ?? []) {
    const n = orders[res];
    const row = el('div', 'eco-row');
    row.append(wareIcon(res, 18), el('span', 'eco-name', nameOf(res)), el('b', '', n === undefined ? '—' : n === ENDLESS ? '∞' : String(n)));
    row.append(
      button('+1', 'Заказать ещё один', () => world.orderTool(res, 1)),
      button('+5', 'Заказать ещё пять', () => world.orderTool(res, 5)),
      button('∞', 'Ковать без остановки', () => world.orderTool(res, ENDLESS)),
      button('✕', 'Отменить заказ', () => world.orderTool(res, 0)),
    );
    box.append(row);
  }
  return box;
}

/** A warehouse's accepted goods, as in Settlers 4: two lists, a click moves a good across. */
export function warehouseControls(world: World, b: Building): HTMLElement | null {
  if (!BUILDINGS[b.type].storage || b.owner !== LOCAL_PLAYER || !b.done) return null;
  // Counts (`data-res`) are refreshed in place by `refreshStockCounts`.
  const box = el('div', 'eco-orders');
  box.append(
    goodsLists({
      inTitle: 'Принимает',
      outTitle: 'Не принимает',
      isIn: (res) => !!b.accept?.includes(res),
      set: (res, on) => world.setAccepts(b.id, res, on),
      tipIn: (name) => `${name}: везут сюда — нажмите, чтобы не принимать`,
      tipOut: (name) => `${name}: сюда не везут — нажмите, чтобы принимать`,
      noneTip: 'Не принимать ничего',
      allTip: 'Принимать всё',
      nameOf,
      count: (res) => ({ value: b.output[res], dataKey: 'res' }),
      countBoth: true,
    }),
  );
  return box;
}

/** Updates the stock counts of a warehouse window without rebuilding it (buttons stay clickable). */
export function refreshStockCounts(root: HTMLElement, b: Building): void {
  for (const n of root.querySelectorAll<HTMLElement>('.acc-count')) {
    const v = String(b.output[n.dataset.res as Resource]);
    if (n.textContent !== v) n.textContent = v;
  }
}
