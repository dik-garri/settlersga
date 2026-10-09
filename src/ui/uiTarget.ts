import type { Category } from '../sim/config';
import type { BuildingType, Resource, SettlerKind } from '../sim/types';
import type { CommandId, MenuId } from './locks';
import type { SPEEDS } from './optionsView';

/**
 * Marks on interface elements that the tutorial can point at (Settlers 4's `SetButtonMarker`): an
 * element tagged with `tag(el, id)` carries `data-ui="<id>"`, and a mission step names the chain of
 * targets to light up (menu → tab → button). The ids are a typed union, so a mission naming an
 * element that does not exist fails the typecheck; an element that went missing from the page is
 * reported in the console by the tutorial view.
 */
export type UiTarget =
  | `menu.${MenuId}`
  | `build.tab.${Category}`
  | `build.item.${BuildingType}`
  | `speed.${(typeof SPEEDS)[number]}`
  | 'speed.pause'
  | 'info.priority'
  | 'info.stop'
  | 'info.demolish'
  | 'info.workArea'
  | 'info.accept'
  | `accept.${Resource}`
  | `info.toolOrder.${Resource}`
  | 'info.mineFood'
  | 'goods.stock'
  | 'goods.transport'
  | 'goods.distribution'
  | `transport.${Resource}.top`
  | `distribution.${Resource}`
  | 'settlers.beds'
  | 'settlers.reserve'
  | `settlers.cmd.${CommandId}`
  /** A worker order's «+1» (builders, diggers, specialists). */
  | `settlers.order.${SettlerKind}`
  /** A market's destination buttons, and a good in its «not carried» list. */
  | 'trade.route'
  | `trade.goods.${Resource}`
  /** A military building's garrison: «Fill», and −/+ per kind. */
  | 'garrison.fill'
  | `garrison.${'melee' | 'ranged'}.${'plus' | 'minus'}`
  /** A recruit order (kind, level from 1, button). */
  | `recruit.${SettlerKind}.${1 | 2 | 3}.${'plus1' | 'plus5' | 'endless'}`
  | 'hud.ticker'
  | 'minimap';

/**
 * Tags an element as tutorial target `id`. With `on` the element counts as already used (a good
 * already accepted, a switch already on), so the highlight chain moves past it.
 */
export function tag<E extends HTMLElement>(el: E, id: UiTarget, on = false): E {
  el.dataset.ui = id;
  if (on) el.dataset.uiOn = '1';
  else delete el.dataset.uiOn;
  return el;
}
