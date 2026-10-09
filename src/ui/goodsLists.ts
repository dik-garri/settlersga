import { wareIcon } from '../render/atlas';
import { RESOURCES, type Resource } from '../sim/types';
import { button, el } from './dom';
import { t } from './i18n';

/**
 * Two lists of goods with big icons, as in Settlers 4's warehouse window: what is in (accepted,
 * carried…) and what is not; a click on a good moves it to the other list, and «все»/«ничего» move
 * every good at once. Shared by the warehouse and the market windows so they always look and behave
 * the same.
 */
export interface GoodsListsSpec {
  /** Titles of the two lists, e.g. «Принимает» / «Не принимает». */
  inTitle: string;
  outTitle: string;
  /** Whether the good is in the first list. */
  isIn: (res: Resource) => boolean;
  /** Moves the good: `on` = into the first list. */
  set: (res: Resource, on: boolean) => void;
  /** Tooltips for a good in each list and for the «ничего»/«все» buttons. */
  tipIn: (name: string) => string;
  tipOut: (name: string) => string;
  noneTip: string;
  allTip: string;
  /** Good names. */
  nameOf: (res: Resource) => string;
  /** A count shown on a good in the first list (and its `data-*` key for in-place refresh). */
  count?: (res: Resource) => { value: number; dataKey: string };
  /** An extra corner label on a good in the first list, e.g. the rest of a finite order. */
  corner?: (res: Resource) => string | null;
  /** Show the count on goods in the second list too (the warehouse shows its stock in both). */
  countBoth?: boolean;
}

export function goodsLists(spec: GoodsListsSpec): HTMLElement {
  const wrap = el('div', 'accepts');
  const column = (on: boolean) => {
    const col = el('div', `accept-col ${on ? 'yes' : 'no'}`);
    const head = el('div', 'accept-head');
    const n = RESOURCES.filter((r) => spec.isIn(r) === on).length;
    head.append(el('span', '', `${on ? spec.inTitle : spec.outTitle} (${n})`));
    head.append(
      button(on ? t('lists.none') : t('lists.all'), on ? spec.noneTip : spec.allTip, () => {
        for (const r of RESOURCES) spec.set(r, !on);
      }),
    );
    col.append(head);
    const list = el('div', 'accept-list');
    for (const r of RESOURCES) {
      if (spec.isIn(r) !== on) continue; // the other list's
      const name = spec.nameOf(r);
      const item = button('', on ? spec.tipIn(name) : spec.tipOut(name), () => spec.set(r, !on), 'accept-item');
      item.append(wareIcon(r, 34));
      if (on || spec.countBoth) {
        const label = on ? spec.corner?.(r) : null;
        if (label) item.append(el('span', 'trade-left', label));
        const c = spec.count?.(r);
        if (c) {
          const span = el('span', 'acc-count', String(c.value));
          span.dataset[c.dataKey] = r;
          item.append(span);
        }
      }
      list.append(item);
    }
    if (!list.firstChild) list.append(el('div', 'accept-empty', on ? t('lists.nothing') : '—'));
    col.append(list);
    return col;
  };
  wrap.append(column(true), column(false));
  return wrap;
}
