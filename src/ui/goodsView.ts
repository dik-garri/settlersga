import { wareIcon } from '../render/atlas';
import { BUILDINGS, RESOURCE_GROUPS, RESOURCE_INFO } from '../sim/config';
import { groundStock } from '../sim/ground';
import { RESOURCES, type Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el, type View } from './dom';
import { DistributionView, TransportView } from './economyPanel';
import { t } from './i18n';
import { groupName, resName } from './names';

type Page = 'stock' | 'distribution' | 'transport';

/**
 * Total of `res` in the local player's warehouses and lying on the ground of its land (the start
 * goods, ruins: Settlers 4 has no headquarters).
 */
export function inStorage(world: World, res: Resource): number {
  let n = groundStock(world, LOCAL_PLAYER, res);
  for (const b of world.buildings.values()) {
    if (b.owner === LOCAL_PLAYER && BUILDINGS[b.type].storage) n += b.output[res];
  }
  return n;
}

/**
 * The goods menu (Settlers 4's goods and production overviews): every good in the player's
 * warehouses and on the ground of its land by group, on the second page the distribution of goods
 * between consumers and on the third the transport priority.
 */
export class GoodsView implements View {
  readonly el = el('div', 'view goods-view');
  private readonly stock = el('div');
  private readonly distribution: DistributionView;
  private readonly transport: TransportView;
  private readonly values: [Resource, HTMLElement][] = [];
  private page: Page = 'stock';
  private readonly pageButtons: Record<Page, HTMLButtonElement>;

  constructor(private readonly world: World) {
    this.distribution = new DistributionView(world);
    this.transport = new TransportView(world);
    for (const group of RESOURCE_GROUPS) {
      this.stock.append(el('h4', '', groupName(group)));
      const grid = el('div', 'stock-grid');
      for (const r of RESOURCES) {
        if (RESOURCE_INFO[r].group !== group) continue;
        const value = el('b', '', '0');
        const row = el('span', 'stock-row');
        row.title = resName(r);
        row.append(wareIcon(r, 18), el('span', 'stock-name', resName(r)), value);
        grid.append(row);
        this.values.push([r, value]);
      }
      this.stock.append(grid);
    }
    const pages = el('div', 'page-tabs');
    this.pageButtons = {
      stock: button(t('goods.stock'), t('goods.stockTip'), () => this.show('stock')),
      distribution: button(t('goods.distribution'), t('goods.distributionTip'), () => this.show('distribution')),
      transport: button(t('goods.transport'), t('goods.transportTip'), () => this.show('transport')),
    };
    pages.append(this.pageButtons.stock, this.pageButtons.distribution, this.pageButtons.transport);
    this.el.append(pages, this.stock, this.distribution.el, this.transport.el);
    this.show('stock');
  }

  private show(page: Page): void {
    this.page = page;
    this.stock.hidden = page !== 'stock';
    this.distribution.el.hidden = page !== 'distribution';
    this.transport.el.hidden = page !== 'transport';
    for (const p of Object.keys(this.pageButtons) as Page[]) this.pageButtons[p].classList.toggle('active', page === p);
    this.update();
  }

  update(): void {
    if (this.page === 'distribution') {
      this.distribution.update();
      return;
    }
    if (this.page === 'transport') {
      this.transport.update();
      return;
    }
    for (const [r, value] of this.values) {
      const text = String(inStorage(this.world, r));
      if (value.textContent !== text) value.textContent = text;
    }
  }
}
