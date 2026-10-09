import { BUILDINGS, MESSAGES, RESOURCE_INFO } from '../sim/config';
import type { GameMessage } from '../sim/messages';
import type { World } from '../sim/world';

/** Space pressed again within this many ms goes one message further back (Settlers 4). */
export const MESSAGE_CYCLE_MS = 4000;

/** The ticker text of a simulation message (`MESSAGES[kind].text`: `{b}` the building, `{res}` the good). */
export function messageText(w: World, m: GameMessage): string {
  const b = m.b !== undefined ? w.buildings.get(m.b) : undefined;
  return MESSAGES[m.kind].text
    .replace('{b}', b ? BUILDINGS[b.type].name : 'Здание')
    .replace('{res}', m.res ? RESOURCE_INFO[m.res].name.toLowerCase() : '');
}
