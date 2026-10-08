import { wareIcon } from '../render/atlas';
import { BUILDINGS, PROFESSIONS, RESOURCE_INFO, TRADE } from '../sim/config';
import { ENDLESS } from '../sim/economy';
import { isCutOff } from '../sim/land';
import { routeTarget } from '../sim/trade';
import { RESOURCES, type Building, type Resource } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el } from './dom';

/**
 * Trade in the building window, as in Settlers 4: a marketplace's route (the destination market,
 * which goods and how many the donkeys take there), a donkey ranch's herd, and the note on buildings
 * whose land has no warehouse (cut off: carriers cannot reach them, only donkeys).
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

const where = (m: Building) => `${m.door.x}, ${m.door.y}`;

/** Rows for the building window: route and orders of a market, the herd of a ranch, cut-off land. */
export function tradeRows(world: World, b: Building): [string, string][] {
  const def = BUILDINGS[b.type];
  const rows: [string, string][] = [];
  if (b.owner !== LOCAL_PLAYER) return rows;
  if (isCutOff(world, b)) rows.push(['Снабжение', 'отрезано от складов — только ослами через рынок']);
  if (!b.done) return rows;
  if (def.market) {
    const to = routeTarget(world, b);
    rows.push(['Маршрут', to ? `к рынку (${where(to)})` : 'не задан']);
    const d = donkeys(world, b.owner);
    rows.push(['Ослы', `${d.all} (свободны ${d.idle})`]);
    for (const r of RESOURCES) {
      const order = b.trade?.orders[r];
      const loading = b.trade?.loading[r] ?? 0;
      if (!order && b.input[r] === 0 && loading === 0) continue;
      const left = order === ENDLESS ? '∞' : String(order ?? 0);
      rows.push([`${nameOf(r)} →`, `осталось ${left} · ждёт ${b.input[r] - loading} · грузят ${loading}`]);
    }
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
export function tradeKey(world: World, b: Building, pick: Resource): string {
  if (!BUILDINGS[b.type].market) return '';
  return JSON.stringify([b.trade?.to ?? null, b.trade?.orders ?? {}, otherMarkets(world, b).map((m) => m.id), pick]);
}

/**
 * A market's commands: where its donkeys go, and per good how many to send (+1 / +5 / endless /
 * cancel). `pick` is the good chosen in the grid; `onPick` changes it.
 */
export function tradeControls(world: World, b: Building, pick: Resource, onPick: (r: Resource) => void): HTMLElement | null {
  if (!BUILDINGS[b.type].market || b.owner !== LOCAL_PLAYER || !b.done) return null;
  const box = el('div', 'eco-orders trade');
  box.append(el('h4', '', 'Куда'));
  const markets = otherMarkets(world, b);
  if (markets.length === 0) box.append(el('p', 'muted', 'Постройте второй рынок — ослы возят товары между рынками по любой земле.'));
  const to = b.trade?.to ?? null;
  const routes = el('div', 'info-actions');
  for (const m of markets) {
    routes.append(
      button(`→ (${where(m)})`, 'Ослы повезут товары к этому рынку', () => world.setTradeRoute(b.id, m.id), m.id === to ? 'active' : ''),
    );
  }
  if (to !== null) routes.append(button('✕', 'Снять маршрут', () => world.setTradeRoute(b.id, null)));
  box.append(routes);

  box.append(el('h4', '', 'Что отправлять'));
  box.append(el('p', 'muted', `Носильщики приносят товар на рынок, ослы берут до ${TRADE.donkeyLoad} штук за раз.`));
  const grid = el('div', 'eco-accept');
  for (const res of RESOURCES) {
    const ordered = !!b.trade?.orders[res];
    const cls = `eco-toggle${ordered || res === pick ? ' on' : ''}${res === pick ? ' picked' : ''}`;
    const t = button('', nameOf(res), () => onPick(res), cls);
    t.append(wareIcon(res, 16));
    grid.append(t);
  }
  box.append(grid);
  const n = b.trade?.orders[pick];
  const row = el('div', 'eco-row');
  row.append(wareIcon(pick, 18), el('span', 'eco-name', nameOf(pick)), el('b', '', n === undefined ? '—' : n === ENDLESS ? '∞' : String(n)));
  row.append(
    button('+1', 'Отправить ещё одну штуку', () => world.orderTrade(b.id, pick, 1)),
    button('+5', 'Отправить ещё пять', () => world.orderTrade(b.id, pick, 5)),
    button('∞', 'Возить без остановки', () => world.orderTrade(b.id, pick, ENDLESS)),
    button('✕', 'Отменить: что ждёт на рынке, вернётся на склад', () => world.orderTrade(b.id, pick, 0)),
  );
  box.append(row);
  return box;
}
