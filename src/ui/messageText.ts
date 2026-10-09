import type { GameMessage } from '../sim/messages';
import type { World } from '../sim/world';
import { t } from './i18n';
import { buildingName, messageTemplate, resLower } from './names';

/** Space pressed again within this many ms goes one message further back (Settlers 4). */
export const MESSAGE_CYCLE_MS = 4000;

/** The ticker text of a simulation message (`msg.<kind>` in the dictionaries: `{b}` the building, `{res}` the good). */
export function messageText(w: World, m: GameMessage): string {
  const b = m.b !== undefined ? w.buildings.get(m.b) : undefined;
  return t(messageTemplate(m.kind), {
    b: b ? buildingName(b.type) : t('msg.someBuilding'),
    res: m.res ? resLower(m.res) : '',
  });
}
