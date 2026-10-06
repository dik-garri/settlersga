import { saveWorld, type SaveData } from '../sim/save';
import type { World } from '../sim/world';

const SAVE_KEY = 'settlers.save.v1';

/** Browser persistence for a single save slot. Every access is guarded: storage may be unavailable. */
export function storeSave(world: World): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(saveWorld(world)));
    return true;
  } catch {
    return false;
  }
}

export function readSave(): SaveData | null {
  try {
    const text = localStorage.getItem(SAVE_KEY);
    return text ? (JSON.parse(text) as SaveData) : null;
  } catch {
    return null;
  }
}

export function hasSave(): boolean {
  return readSave() !== null;
}
