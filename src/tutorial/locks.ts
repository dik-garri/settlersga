import { noLocksOpen, openMore, type Locks } from '../ui/locks';
import { MISSIONS } from './missions';
import type { MissionDef } from './types';

/**
 * What a mission leaves open at a step (docs/TUTORIAL.md §2.2): everything the missions before it
 * opened (their own and their steps'), its own `unlock`, and its steps' up to this one — the same
 * whether the mission was reached in order or started directly.
 */
export function locksFor(def: MissionDef, step: number): Locks {
  let l = noLocksOpen();
  for (const m of MISSIONS) {
    if (m.id === def.id) break;
    l = openMore(l, m.unlock);
    for (const s of m.steps) l = openMore(l, s.unlock);
  }
  l = openMore(l, def.unlock);
  for (let k = 0; k <= step && k < def.steps.length; k++) l = openMore(l, def.steps[k].unlock);
  return l;
}
