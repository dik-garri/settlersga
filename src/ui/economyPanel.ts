import { buildingIcon, settlerIcon, wareIcon } from '../render/atlas';
import { BUILDINGS, CARRIER_RESERVE, INPUT_CAP, ORDERABLE } from '../sim/config';
import {
  carrierReserve,
  consumersOf,
  distributableGoods,
  distributionWeight,
  economyOf,
  ENDLESS,
  transportOrder,
  workerOrder,
  workersOf,
  type TransportMove,
} from '../sim/economy';
import type { Building, Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { storageFill } from '../sim/storage';
import { button, el, type View } from './dom';
import { goodsLists } from './goodsLists';
import { lower, t } from './i18n';
import { buildingName, profName, resLower, resName } from './names';
import { tag } from './uiTarget';

/**
 * Economy settings as in Settlers 4 (`sim/economy.ts`): the settlers menu's worker orders and the goods
 * menu's distribution (views of the side panel), plus controls inside building windows — the
 * toolsmith's order queue and a warehouse's accepted goods.
 */

const nameOf = (r: Resource) => resName(r);

/** Settlers menu: builders, diggers and specialists ordered from free carriers (Settlers 4). */
export class WorkersView implements View {
  readonly el = el('div', 'view workers-view');
  private key = '';

  constructor(private readonly world: World) {}

  update(): void {
    const w = this.world;
    const workers = ORDERABLE.map((k) => [workersOf(w, LOCAL_PLAYER, k), workerOrder(w, LOCAL_PLAYER, k)]);
    const reserve = carrierReserve(w, LOCAL_PLAYER);
    const key = JSON.stringify([workers, reserve]);
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    // Settlers 4's carrier reserve: no carrier takes up a job while no more than this are left.
    this.el.append(el('h4', '', t('eco.reserve')));
    this.el.append(el('p', 'muted', t('eco.reserveNote', { min: CARRIER_RESERVE.min })));
    const keep = tag(el('div', 'eco-row carrier-reserve'), 'settlers.reserve');
    const setReserve = (n: number) => {
      w.setCarrierReserve(n);
      this.update();
    };
    keep.append(
      settlerIcon('carrier', 28),
      el('span', 'eco-name', profName('carrier')),
      el('b', '', String(reserve)),
      button('−5', t('eco.less5'), () => setReserve(reserve - 5)),
      button('−1', t('eco.less1'), () => setReserve(reserve - 1)),
      button('+1', t('eco.more1'), () => setReserve(reserve + 1)),
      button('+5', t('eco.more5'), () => setReserve(reserve + 5)),
    );
    this.el.append(keep);
    this.el.append(el('h4', '', t('eco.workers')));
    this.el.append(el('p', 'muted', t('eco.workersNote')));
    ORDERABLE.forEach((kind, i) => {
      const [have, ordered] = workers[i];
      const row = el('div', 'eco-row');
      row.append(settlerIcon(kind, 28), el('span', 'eco-name', profName(kind)), el('b', '', `${have} / ${ordered}`));
      const set = (n: number) => {
        w.orderWorkers(kind, Math.max(0, n));
        this.update();
      };
      row.append(
        button('−1', t('eco.orderLess'), () => set(ordered - 1)),
        button('+1', t('eco.orderOne'), () => set(ordered + 1)),
        button('+5', t('eco.orderFive'), () => set(ordered + 5)),
        button('↩', t('eco.dismissOne'), () => {
          w.dismissSpecialist(kind);
          this.update();
        }),
      );
      this.el.append(row);
    });
  }
}

/**
 * Goods menu, transport part: the order in which carriers move goods when they are short (Settlers
 * 4's transport priority list); each good moves a place up or down, or to the top or bottom.
 */
export class TransportView implements View {
  readonly el = el('div', 'view transport-view');
  private key = '';

  constructor(private readonly world: World) {}

  update(): void {
    const w = this.world;
    const order = transportOrder(w, LOCAL_PLAYER);
    const key = order.join();
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    this.el.append(el('h4', '', t('eco.transport')));
    this.el.append(el('p', 'muted', t('eco.transportNote')));
    const list = el('div', 'transport-list');
    const move = (res: Resource, how: TransportMove) => {
      w.moveTransport(res, how);
      this.update();
    };
    order.forEach((res, i) => {
      const row = el('div', 'eco-row transport-row');
      const first = i === 0;
      const last = i === order.length - 1;
      const up = button('↑', t('eco.up'), () => move(res, 'up'));
      const top = tag(button('⤒', t('eco.top'), () => move(res, 'top')), `transport.${res}.top`, first);
      const down = button('↓', t('eco.down'), () => move(res, 'down'));
      const bottom = button('⤓', t('eco.bottom'), () => move(res, 'bottom'));
      up.disabled = top.disabled = first;
      down.disabled = bottom.disabled = last;
      row.append(el('span', 'transport-rank', String(i + 1)), wareIcon(res, 18), el('span', 'eco-name', nameOf(res)), top, up, down, bottom);
      list.append(row);
    });
    this.el.append(list);
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
    this.el.append(el('h4', '', t('eco.distribution')));
    this.el.append(el('p', 'muted', t('eco.distributionNote')));
    for (const res of distributableGoods()) {
      const block = tag(el('div', 'eco-dist'), `distribution.${res}`);
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
        row.append(buildingIcon(type, 22), el('span', 'eco-name', buildingName(type)), slider, el('b', '', `${Math.round((100 * weight) / total)}%`));
        block.append(row);
      }
      this.el.append(block);
    }
  }
}

/** Rows for the building window that the economy adds (warehouse fill and what it takes in). */
export function economyRows(b: Building): [string, string][] {
  const def = BUILDINGS[b.type];
  const rows: [string, string][] = [];
  if (def.storage) rows.push(...storageRows(b));
  // As in Settlers 4 a new warehouse takes nothing until goods are ticked in its window.
  if (def.storage && !b.accept?.length) rows.push([t('eco.accepts'), t('eco.acceptsNothing')]);
  return rows;
}

/**
 * A mine's food rows (Settlers 4: each food eaten buys attempts, the favourite more): what it holds,
 * its favourite and the attempts left. Their own table in the building window, for the tutorial's mark.
 */
export function mineRows(b: Building): [string, string][] {
  const def = BUILDINGS[b.type];
  const anyOf = def.recipe?.inputsAnyOf;
  if (!def.mine || !anyOf || !b.done) return [];
  const held = anyOf.map((r) => `${resLower(r)} ${b.input[r]}`).join(', ');
  return [
    [t('info.foodInput'), `${held} / ${INPUT_CAP}`],
    [t('eco.favourite'), lower(nameOf(def.mine.favourite))],
    [t('eco.attempts'), String(b.attempts ?? 0)],
  ];
}

/** How full a warehouse is (Settlers 4: piles of 8, a good may take several; `sim/storage.ts`). */
export function storageRows(b: Building): [string, string][] {
  const def = BUILDINGS[b.type].storage;
  if (!def || !b.done) return [];
  const fill = storageFill(b);
  if (fill.capacity === Infinity) return [[t('eco.capacity'), t('eco.unlimited')]];
  const rows: [string, string][] = [[t('eco.filled'), `${fill.units} / ${fill.capacity}`]];
  if (fill.maxPiles !== undefined) rows.push([t('eco.piles'), t('eco.pilesOf', { n: fill.piles ?? 0, m: fill.maxPiles, per: def.perPile ?? 0 })]);
  const full = fill.units >= fill.capacity || (fill.maxPiles !== undefined && (fill.piles ?? 0) >= fill.maxPiles);
  if (full) rows.push([t('info.status'), t('eco.full')]);
  return rows;
}

/** A good's count in a warehouse window, with the piles it takes when the warehouse stacks in piles. */
export function stockText(b: Building, res: Resource): string {
  const n = b.output[res];
  const per = BUILDINGS[b.type].storage?.perPile;
  if (!per || n <= 0) return String(n);
  return `${n} · ${t('eco.pileCount', { n: Math.ceil(n / per) })}`;
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
  box.append(el('h4', '', t('eco.orders')), el('p', 'muted', t('eco.ordersNote')));
  for (const res of recipe.outputChoice ?? []) {
    const n = orders[res];
    const row = tag(el('div', 'eco-row'), `info.toolOrder.${res}`);
    row.append(wareIcon(res, 18), el('span', 'eco-name', nameOf(res)), el('b', '', n === undefined ? '—' : n === ENDLESS ? '∞' : String(n)));
    row.append(
      button('+1', t('eco.toolOne'), () => world.orderTool(res, 1)),
      button('+5', t('eco.toolFive'), () => world.orderTool(res, 5)),
      button('∞', t('eco.toolEndless'), () => world.orderTool(res, ENDLESS)),
      button('✕', t('eco.cancelOrder'), () => world.orderTool(res, 0)),
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
      inTitle: t('eco.accepts'),
      outTitle: t('eco.refuses'),
      isIn: (res) => !!b.accept?.includes(res),
      set: (res, on) => world.setAccepts(b.id, res, on),
      tipIn: (name) => t('eco.tipIn', { name }),
      tipOut: (name) => t('eco.tipOut', { name }),
      noneTip: t('eco.noneTip'),
      allTip: t('eco.allTip'),
      nameOf,
      count: (res) => ({ value: b.output[res], dataKey: 'res' }),
      countBoth: true,
      tagOut: (res) => `accept.${res}`,
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
