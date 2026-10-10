import { BUILDINGS } from './config';
import { centerOf } from './buildings';
import { outdoorFighters } from './field';
import { postMessage } from './messages';
import type { Building } from './types';
import type { World } from './world';
import { within } from './fmath';

/**
 * The lookout tower's alarm, as Settlers 4's `CLookoutTowerRole::LogicUpdate`: it first orders its
 * occupant (`BuildingDef.worker`); while he is inside, every `alarm.every` ticks it looks for a hostile
 * fighter outdoors within `alarm.radius` of it (`CScanner::FindAnyEnemyFighter`) and tells its owner
 * (`MESSAGES.alarm`) — once, until no enemy is left in range (`Building.alarm`). Its sight is data
 * (`BuildingDef.vision`, `fog.ts`).
 *
 * Cost: one pass over the outdoor fighters (cached per tick) per lookout every `alarm.every` ticks.
 */
export function updateLookout(w: World, b: Building): void {
  const alarm = BUILDINGS[b.type].alarm;
  if (!alarm || !b.done || (w.tick + b.id) % alarm.every !== 0) return;
  const keeper = w.getSettler(b.workerId);
  if (!keeper || keeper.inside !== b.id || w.dying.has(keeper.id)) {
    delete b.alarm;
    return;
  }
  const c = centerOf(b);
  let enemy = false;
  for (const s of outdoorFighters(w)) {
    if (s.owner !== b.owner && !w.allied(s.owner, b.owner) && within(s.x - c.x, s.y - c.y, alarm.radius)) {
      enemy = true;
      break;
    }
  }
  if (!enemy) {
    delete b.alarm;
    return;
  }
  if (b.alarm) return;
  b.alarm = true;
  postMessage(w, 'alarm', b.owner, b.door, { b: b.id });
}
