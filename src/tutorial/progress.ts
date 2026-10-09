import type { KeyValue } from '../ui/saves';
import type { MissionId } from './types';

/**
 * Which tutorial missions this browser has completed (the main menu's marks), under
 * `localStorage['settlers.tutorial']`: `{ done: { [mission]: { at, minutes } } }`. Every storage
 * access is guarded, as for the other settings; without storage nothing is remembered. The progress
 * of a mission under way is not here but in the save slot's description (`SlotMeta.mission`).
 */
export const MARKS_KEY = 'settlers.tutorial';

export interface TutorialMarks {
  done: Partial<Record<MissionId, { at: number; minutes: number }>>;
}

function browserStore(): KeyValue | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readMarks(store: KeyValue | null = browserStore()): TutorialMarks {
  try {
    const raw = JSON.parse(store?.getItem(MARKS_KEY) ?? 'null') as TutorialMarks | null;
    return raw && typeof raw === 'object' && raw.done && typeof raw.done === 'object' ? { done: raw.done } : { done: {} };
  } catch {
    return { done: {} };
  }
}

/** Marks a mission completed (the best time is kept). */
export function markDone(id: MissionId, minutes: number, now: number, store: KeyValue | null = browserStore()): TutorialMarks {
  const marks = readMarks(store);
  const old = marks.done[id];
  marks.done[id] = { at: now, minutes: old ? Math.min(old.minutes, minutes) : minutes };
  try {
    store?.setItem(MARKS_KEY, JSON.stringify(marks));
  } catch {
    // Not remembered.
  }
  return marks;
}
