import { wareIcon } from '../render/atlas';
import { BUILDINGS, RESOURCE_GROUPS, RESOURCE_INFO, type ResourceGroup } from '../sim/config';
import { RESOURCES, type Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el, type View } from './dom';
import { DistributionView } from './economyPanel';

/** Total of `res` in the local player's warehouses. */
export function inStorage(world: World, res: Resource): number {
  let n = 0;
  for (const b of world.buildings.values()) {
    if (b.owner === LOCAL_PLAYER && BUILDINGS[b.type].storage) n += b.output[res];
  }
  return n;
}

/**
 * The goods menu (Settlers 4's goods and production overviews): every good in the player's
 * warehouses by group, and on the second page the distribution of goods between consumers.
 */
export class GoodsView implements View {
  readonly el = el('div', 'view goods-view');
  private readonly stock = el('div');
  private readonly distribution: DistributionView;
  private readonly values: [Resource, HTMLElement][] = [];
  private page: 'stock' | 'distribution' = 'stock';
  private readonly pageButtons: Record<'stock' | 'distribution', HTMLButtonElement>;

  constructor(private readonly world: World) {
    this.distribution = new DistributionView(world);
    for (const [group, title] of Object.entries(RESOURCE_GROUPS) as [ResourceGroup, string][]) {
      this.stock.append(el('h4', '', title));
      const grid = el('div', 'stock-grid');
      for (const r of RESOURCES) {
        if (RESOURCE_INFO[r].group !== group) continue;
        const value = el('b', '', '0');
        const row = el('span', 'stock-row');
        row.title = RESOURCE_INFO[r].name;
        row.append(wareIcon(r, 18), el('span', 'stock-name', RESOURCE_INFO[r].name), value);
        grid.append(row);
        this.values.push([r, value]);
      }
      this.stock.append(grid);
    }
    const pages = el('div', 'page-tabs');
    this.pageButtons = {
      stock: button('Склад', 'Все товары на складах', () => this.show('stock')),
      distribution: button('Распределение', 'Кому сколько товара', () => this.show('distribution')),
    };
    pages.append(this.pageButtons.stock, this.pageButtons.distribution);
    this.el.append(pages, this.stock, this.distribution.el);
    this.show('stock');
  }

  private show(page: 'stock' | 'distribution'): void {
    this.page = page;
    this.stock.hidden = page !== 'stock';
    this.distribution.el.hidden = page !== 'distribution';
    this.pageButtons.stock.classList.toggle('active', page === 'stock');
    this.pageButtons.distribution.classList.toggle('active', page === 'distribution');
    this.update();
  }

  update(): void {
    if (this.page === 'distribution') {
      this.distribution.update();
      return;
    }
    for (const [r, value] of this.values) {
      const text = String(inStorage(this.world, r));
      if (value.textContent !== text) value.textContent = text;
    }
  }
}
