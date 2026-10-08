import { BUILDINGS, PROFESSIONS, RESOURCE_INFO, TRADE } from '../sim/config';
import { ENDLESS } from '../sim/economy';
import { isCutOff } from '../sim/land';
import { routeTarget } from '../sim/trade';
import { RESOURCES, type Building, type Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el } from './dom';
import { goodsLists } from './goodsLists';

/**
 * Trade in the building window, as in Settlers 4: a marketplace's route (the destination market and
 * which goods the donkeys take there), a donkey ranch's herd, and the note on buildings whose land
 * has no warehouse (cut off: carriers cannot reach them, only donkeys).
 */

const nameOf = (r: Resource) => RESOURCE_INFO[r].name;

/** The player's finished markets other than `b`. */
function otherMarkets(world: World, b: Building): Building[] {
  return [...world.buildings.values()].filter((m) => m.id !== b.id && m.owner === b.owner && m.done && BUILDINGS[m.type].market);
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
 * A market's name for the player: «Рынок №k», numbered by building id among the owner's markets
 * (sites included), so a number never changes while that market stands.
 */
export function marketName(world: World, m: Building): string {
  let k = 1;
  for (const o of world.buildings.values()) if (o.owner === m.owner && BUILDINGS[o.type].market && o.id < m.id) k++;
  return `Рынок №${k}`;
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
  if (isCutOff(world, b)) rows.push(['Снабжение', 'отрезано от складов — только ослами через рынок']);
  if (!b.done) return rows;
  if (def.market) {
    const to = routeTarget(world, b);
    rows.push(['Название', marketName(world, b)]);
    rows.push(['Маршрут', to ? `→ ${marketName(world, to)}, ${tilesBetween(b, to)} кл.` : 'не задан']);
    const d = donkeys(world, b.owner);
    rows.push(['Ослы', `${d.all} (свободны ${d.idle})`]);
    for (const r of RESOURCES) if (b.output[r] > 0) rows.push([`${nameOf(r)} (прибыло)`, String(b.output[r])]);
  }
  if (def.breeds) {
    const markets = [...world.buildings.values()].filter((m) => m.owner === b.owner && m.done && BUILDINGS[m.type].market).length;
    const d = donkeys(world, b.owner);
    rows.push([PROFESSIONS[def.breeds].name, `${d.all} / ${markets * TRADE.donkeysPerMarket}`]);
    if (markets === 0) rows.push(['Разведение', 'нет рынка — не нужны']);
    else if (d.all >= markets * TRADE.donkeysPerMarket) rows.push(['Разведение', 'ослов хватает']);
  }
  return rows;
}

/** A string that changes whenever the market controls must be redrawn. */
export function tradeKey(world: World, b: Building): string {
  if (!BUILDINGS[b.type].market) return '';
  return JSON.stringify([b.trade?.to ?? null, b.trade?.orders ?? {}, otherMarkets(world, b).map((m) => m.id)]);
}

/**
 * A market's commands: where its donkeys go, and — as in the warehouse window — two lists of goods,
 * carried and not; a click moves a good across. A click starts an endless order (the AI still places
 * finite ones through `orderTrade`; their remainder shows in the item's corner).
 */
export function tradeControls(world: World, b: Building): HTMLElement | null {
  if (!BUILDINGS[b.type].market || b.owner !== LOCAL_PLAYER || !b.done) return null;
  const box = el('div', 'eco-orders trade');
  box.append(el('h4', '', 'Куда'));
  const markets = otherMarkets(world, b);
  if (markets.length === 0) box.append(el('p', 'muted', 'Постройте второй рынок — ослы возят товары между рынками по любой земле.'));
  const to = b.trade?.to ?? null;
  const routes = el('div', 'info-actions');
  for (const m of markets) {
    routes.append(
      button(
        `→ ${marketName(world, m)} · ${tilesBetween(b, m)} кл.`,
        'Ослы повезут товары к этому рынку (маршрут виден на карте пунктиром)',
        () => world.setTradeRoute(b.id, m.id),
        m.id === to ? 'active' : '',
      ),
    );
  }
  if (to !== null) routes.append(button('✕', 'Снять маршрут', () => world.setTradeRoute(b.id, null)));
  box.append(routes);

  box.append(el('h4', '', 'Что возить'));
  box.append(el('p', 'muted', `Носильщики приносят товар на рынок, ослы берут до ${TRADE.donkeyLoad} штук за раз.`));
  box.append(
    goodsLists({
      inTitle: 'Возим',
      outTitle: 'Не возим',
      isIn: (r) => carried(b, r),
      set: (r, on) => world.orderTrade(b.id, r, on ? ENDLESS : 0),
      tipIn: (name) => `${name}: возим — нажмите, чтобы перестать (что ждёт на рынке, вернётся на склад)`,
      tipOut: (name) => `${name}: не возим — нажмите, чтобы возить без остановки`,
      noneTip: 'Не возить ничего: что ждёт на рынке, вернётся на склад',
      allTip: 'Возить всё без остановки',
      nameOf,
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
