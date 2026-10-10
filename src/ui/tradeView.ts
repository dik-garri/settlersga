import { BUILDINGS, PROFESSIONS, TRADE } from '../sim/config';
import { ENDLESS } from '../sim/economy';
import { isCutOff } from '../sim/land';
import { routeTarget } from '../sim/trade';
import { RESOURCES, type Building, type Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el } from './dom';
import { goodsLists } from './goodsLists';
import { t } from './i18n';
import { profName, resName } from './names';
import { tag } from './uiTarget';

/**
 * Trade in the building window, as in Settlers 4: a marketplace's route (the destination market and
 * which goods the donkeys take there), a donkey ranch's herd, and the note on buildings whose land
 * has no warehouse (cut off: carriers cannot reach them, only donkeys).
 */

const nameOf = (r: Resource) => resName(r);

/**
 * The player's markets other than `b`, sites too: donkeys bring a market site what it still lacks
 * (`unloadTick`), so a market on cut-off land can be built at all.
 */
function otherMarkets(world: World, b: Building): Building[] {
  return [...world.buildings.values()].filter((m) => m.id !== b.id && m.owner === b.owner && BUILDINGS[m.type].market);
}

/** The player's donkeys: all of them and those standing idle. */
function donkeys(world: World, owner: number): { all: number; idle: number } {
  let all = 0;
  let idle = 0;
  for (const s of world.settlers) {
    if (s.owner !== owner || PROFESSIONS[s.kind].behavior !== 'donkey') continue;
    all++;
    if (s.tasks.length === 0) idle++;
  }
  return { all, idle };
}

/**
 * A market's name for the player: «Рынок №k» (`trade.marketName`), numbered by building id among the owner's markets
 * (sites included), so a number never changes while that market stands.
 */
export function marketName(world: World, m: Building): string {
  let k = 1;
  for (const o of world.buildings.values()) if (o.owner === m.owner && BUILDINGS[o.type].market && o.id < m.id) k++;
  return t('trade.marketName', { k });
}

/** Straight-line distance between two buildings' doors, in tiles. */
const tilesBetween = (a: Building, b: Building) => Math.round(Math.hypot(a.door.x - b.door.x, a.door.y - b.door.y));

/** Whether the market has an order (finite or endless) for the good. */
const carried = (b: Building, r: Resource) => b.trade?.orders[r] !== undefined;

/** Units of the good waiting on the market's input pile, not yet in a donkey's pack. */
const waitingAt = (b: Building, r: Resource) => b.input[r] - (b.trade?.loading[r] ?? 0);

/** Rows for the building window: route of a market, the herd of a ranch, cut-off land. */
export function tradeRows(world: World, b: Building): [string, string][] {
  const def = BUILDINGS[b.type];
  const rows: [string, string][] = [];
  if (b.owner !== LOCAL_PLAYER) return rows;
  if (isCutOff(world, b)) rows.push([t('trade.supply'), t('trade.cutOff')]);
  if (!b.done) return rows;
  if (def.market) {
    const to = routeTarget(world, b);
    rows.push([t('trade.name'), marketName(world, b)]);
    rows.push([t('trade.route'), to ? t('trade.routeTo', { market: marketName(world, to), n: tilesBetween(b, to) }) : t('trade.noRoute')]);
    const d = donkeys(world, b.owner);
    rows.push([t('trade.donkeys'), t('trade.donkeysIdle', { n: d.all, idle: d.idle })]);
    for (const r of RESOURCES) if (b.output[r] > 0) rows.push([t('trade.arrived', { name: nameOf(r) }), String(b.output[r])]);
  }
  if (def.breeds) {
    const markets = [...world.buildings.values()].filter((m) => m.owner === b.owner && m.done && BUILDINGS[m.type].market).length;
    const d = donkeys(world, b.owner);
    rows.push([profName(def.breeds), `${d.all} / ${markets * TRADE.donkeysPerMarket}`]);
    if (markets === 0) rows.push([t('trade.breeding'), t('trade.noMarket')]);
    else if (d.all >= markets * TRADE.donkeysPerMarket) rows.push([t('trade.breeding'), t('trade.enough')]);
  }
  return rows;
}

/** A string that changes whenever the market controls must be redrawn. */
export function tradeKey(world: World, b: Building): string {
  if (!BUILDINGS[b.type].market) return '';
  return JSON.stringify([b.trade?.to ?? null, b.trade?.orders ?? {}, otherMarkets(world, b).map((m) => [m.id, m.done])]);
}

/**
 * A market's commands: where its donkeys go, and — as in the warehouse window — two lists of goods,
 * carried and not; a click moves a good across. A click starts an endless order (the AI still places
 * finite ones through `orderTrade`; their remainder shows in the item's corner).
 */
export function tradeControls(world: World, b: Building): HTMLElement | null {
  if (!BUILDINGS[b.type].market || b.owner !== LOCAL_PLAYER || !b.done) return null;
  const box = el('div', 'eco-orders trade');
  box.append(el('h4', '', t('trade.where')));
  const markets = otherMarkets(world, b);
  if (markets.length === 0) box.append(el('p', 'muted', t('trade.buildSecond')));
  const to = b.trade?.to ?? null;
  const routes = el('div', 'info-actions');
  for (const m of markets) {
    const label = t('trade.toMarket', { market: marketName(world, m), n: tilesBetween(b, m) });
    const go = button(
      m.done ? label : `${label} ${t('trade.site')}`,
      m.done ? t('trade.toMarketTip') : t('trade.toSiteTip'),
      () => world.issue({ kind: 'setTradeRoute', player: LOCAL_PLAYER, id: b.id, to: m.id }),
      m.id === to ? 'active' : '',
    );
    // The tutorial's mark: any destination, until a route is chosen.
    routes.append(tag(go, 'trade.route', to !== null));
  }
  if (to !== null) routes.append(button('✕', t('trade.clearRoute'), () => world.issue({ kind: 'setTradeRoute', player: LOCAL_PLAYER, id: b.id, to: null })));
  box.append(routes);

  box.append(el('h4', '', t('trade.what')));
  box.append(el('p', 'muted', t('trade.packs', { n: TRADE.packs, load: TRADE.donkeyLoad })));
  box.append(
    goodsLists({
      inTitle: t('trade.carried'),
      outTitle: t('trade.notCarried'),
      isIn: (r) => carried(b, r),
      set: (r, on) => world.issue({ kind: 'orderTrade', player: LOCAL_PLAYER, id: b.id, res: r, count: on ? ENDLESS : 0 }),
      tipIn: (name) => t('trade.tipIn', { name }),
      tipOut: (name) => t('trade.tipOut', { name }),
      noneTip: t('trade.noneTip'),
      allTip: t('trade.allTip'),
      nameOf,
      tagOut: (r) => `trade.goods.${r}`,
      // The rest of a finite order (the AI places those) in the corner; units waiting on the market.
      corner: (r) => {
        const order = b.trade?.orders[r];
        return order !== undefined && order !== ENDLESS ? String(order) : null;
      },
      count: (r) => ({ value: waitingAt(b, r), dataKey: 'tradeRes' }),
    }),
  );
  return box;
}

/** Refresh the waiting counts on a market's carried goods in place (no re-render). */
export function refreshTradeCounts(root: HTMLElement, b: Building): void {
  for (const n of root.querySelectorAll<HTMLElement>('[data-trade-res]')) {
    n.textContent = String(waitingAt(b, n.dataset.tradeRes as Resource));
  }
}
