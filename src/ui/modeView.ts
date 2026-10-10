import { wareIcon } from '../render/atlas';
import { TICKS_PER_SECOND } from '../sim/config';
import { economyEndTick, economyTally, type EconomyTally } from '../sim/modes';
import type { PlayerId } from '../sim/types';
import type { World } from '../sim/world';
import { el } from './dom';
import { t } from './i18n';
import { modeName, resName } from './names';

/**
 * The victory mode in the interface (`modes.ts`): its name and, in the economic mode, the time left
 * and the comparison of the seven goods (Settlers 4's economy statistics, `CStateEcoStatistic`) —
 * shown live in the statistics menu and, as decided, on the end screen.
 */

/** «mm:ss» of game time. */
export function clock(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / TICKS_PER_SECOND));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** One line for the side panel: the mode, and in the economic mode the time to the count. Null in conquest. */
export function modeLine(world: World): string | null {
  const mode = world.rules?.mode ?? 'conquest';
  if (mode === 'conquest') return null;
  if (mode !== 'economy') return modeName(mode);
  if (world.result || world.tick >= economyEndTick()) return `${modeName(mode)} · ${t('ecowin.done')}`;
  return `${modeName(mode)} · ${t('ecowin.left', { time: clock(economyEndTick() - world.tick) })}`;
}

/** Names of a side's players, «you» first. */
function sideNames(ids: PlayerId[], me: PlayerId): string {
  return ids.map((id) => (id === me ? t('common.you') : t('common.player', { id }))).join(', ');
}

/**
 * The comparison table: per good the stock of alliance 1 and of all the others, the leader marked,
 * then the goods won and the sums. `tally` defaults to the comparison right now.
 */
export function economyTable(world: World, me: PlayerId, tally: EconomyTally = economyTally(world)): HTMLElement {
  const box = el('div', 'eco-compare');
  const mineA = tally.sideA.includes(me);
  const table = el('table', 'stats-table eco-table');
  const head = el('tr');
  const others = world.players.filter((p) => !tally.sideA.includes(p.id)).map((p) => p.id);
  const colA = el('th', mineA ? 'mine' : '', t('ecowin.sideA'));
  colA.title = sideNames(tally.sideA, me);
  const colB = el('th', mineA ? '' : 'mine', t('ecowin.sideB'));
  colB.title = sideNames(others, me);
  head.append(el('th', '', t('ecowin.good')), colA, colB);
  table.append(head);
  for (const r of tally.rows) {
    const tr = el('tr');
    const name = el('td', 'eco-name');
    name.append(wareIcon(r.res, 16), document.createTextNode(` ${resName(r.res)}`));
    tr.append(name, el('td', r.a > r.b ? 'lead' : '', String(r.a)), el('td', r.b > r.a ? 'lead' : '', String(r.b)));
    table.append(tr);
  }
  const wins = el('tr', 'eco-sum');
  wins.append(el('td', '', t('ecowin.wins')), el('td', '', String(tally.winsA)), el('td', '', String(tally.winsB)));
  const sums = el('tr', 'eco-sum');
  sums.append(el('td', '', t('ecowin.sum')), el('td', '', String(tally.sumA)), el('td', '', String(tally.sumB)));
  table.append(wins, sums);
  box.append(table, el('p', 'muted', t('ecowin.sides', { a: sideNames(tally.sideA, me), b: sideNames(others, me) })));
  return box;
}

/** The end screen's sentence on how the economic mode was decided. */
export function economyVerdict(world: World, me: PlayerId): string {
  const r = world.result;
  if (!r) return '';
  const won = r.winners.includes(me);
  const { winsA, winsB, sumA, sumB } = r.tally;
  const why =
    r.by === 'goods'
      ? t('end.eco.goods', { a: winsA, b: winsB })
      : r.by === 'sum'
        ? t('end.eco.sum', { a: winsA, b: winsB, sa: sumA, sb: sumB })
        : t('end.eco.coin');
  return `${t(won ? 'end.eco.won' : 'end.eco.lost')} ${why}`;
}
