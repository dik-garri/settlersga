import { t } from './i18n';
import type { SaveData } from '../sim/save';
import type { MissionProgress } from '../tutorial/runner';

/**
 * Save slots in browser storage, as in Settlers 4's load screen: any number of named saves plus one
 * autosave slot, each listed with its date, map size, players and game time. A slot's data lives
 * under its own key, gzip-compressed when the browser can (a 256×256 game shrinks from ~2 MB of JSON to
 * ~150 KB, so many slots fit the storage quota); the index holds only the descriptions. Every storage
 * access is guarded — storage may be missing or full — and failures come back as null/false.
 */

export interface SlotMeta {
  id: string;
  name: string;
  /** Wall-clock time of the save (ms since 1970). */
  savedAt: number;
  /** Game time and what was played. */
  tick: number;
  size: number;
  players: number;
  auto?: boolean;
  /**
   * A tutorial mission under way (its step automaton's progress, `TutorialRunner.serialize`): the
   * mission goes on from there when the slot is loaded. Not part of `SaveData`, which stays pure
   * simulation state; the progress means nothing without the world it is saved with.
   */
  mission?: MissionProgress;
}

/** The part of `Storage` the slots use (a test passes a Map-backed fake). */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const INDEX = 'settlers.saves';
const PREFIX = 'settlers.save.';
/** The single slot of earlier versions; listed while it exists. */
const LEGACY = 'settlers.save.v1';
export const AUTO_ID = 'auto';

export function describe(data: SaveData): Pick<SlotMeta, 'tick' | 'size' | 'players'> {
  return { tick: data.tick, size: data.map.w, players: data.players.length };
}

/** Text → storable string: `gz:` + base64 of the gzip stream, or the text itself without CompressionStream. */
export async function pack(text: string): Promise<string> {
  if (typeof CompressionStream === 'undefined') return text;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `gz:${btoa(bin)}`;
}

export async function unpack(stored: string): Promise<string> {
  if (!stored.startsWith('gz:')) return stored;
  const bin = atob(stored.slice(3));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export class SaveSlots {
  constructor(private readonly store: KeyValue | null) {}

  private get(key: string): string | null {
    try {
      return this.store?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private index(): SlotMeta[] {
    try {
      const list = JSON.parse(this.get(INDEX) ?? '[]') as SlotMeta[];
      return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeIndex(list: SlotMeta[]): boolean {
    try {
      this.store?.setItem(INDEX, JSON.stringify(list));
      return !!this.store;
    } catch {
      return false;
    }
  }

  /** Every slot, newest first (the old single slot, if still there, last). */
  list(): SlotMeta[] {
    const out = this.index().sort((a, b) => b.savedAt - a.savedAt);
    const legacy = this.get(LEGACY);
    if (legacy) {
      try {
        out.push({ id: 'v1', name: t('saves.legacy'), savedAt: 0, ...describe(JSON.parse(legacy) as SaveData) });
      } catch {
        // Unreadable: not listed.
      }
    }
    return out;
  }

  latest(): SlotMeta | null {
    return this.list()[0] ?? null;
  }

  /** The slot's description, if it exists. */
  meta(id: string): SlotMeta | null {
    return this.list().find((m) => m.id === id) ?? null;
  }

  /**
   * Stores `data` in slot `id` (a new slot when omitted; `AUTO_ID` for the autosave), described as
   * `name`. Returns the slot, or null if storage is unavailable or full.
   */
  async write(data: SaveData, name: string, now: number, id?: string, extra: Pick<SlotMeta, 'mission'> = {}): Promise<SlotMeta | null> {
    if (!this.store) return null;
    const list = this.index();
    const slotId = id ?? `s${now.toString(36)}${list.length}`;
    const meta: SlotMeta = {
      id: slotId,
      name,
      savedAt: now,
      ...describe(data),
      ...(slotId === AUTO_ID ? { auto: true } : {}),
      ...(extra.mission ? { mission: extra.mission } : {}),
    };
    try {
      this.store.setItem(PREFIX + slotId, await pack(JSON.stringify(data)));
    } catch {
      return null;
    }
    if (!this.writeIndex([...list.filter((m) => m.id !== slotId), meta])) return null;
    return meta;
  }

  async read(id: string): Promise<SaveData | null> {
    const stored = this.get(id === 'v1' ? LEGACY : PREFIX + id);
    if (!stored) return null;
    try {
      return JSON.parse(await unpack(stored)) as SaveData;
    } catch {
      return null;
    }
  }

  remove(id: string): boolean {
    try {
      this.store?.removeItem(id === 'v1' ? LEGACY : PREFIX + id);
    } catch {
      return false;
    }
    return id === 'v1' || this.writeIndex(this.index().filter((m) => m.id !== id));
  }
}

/** The slots in this browser's localStorage (none when storage is blocked). */
export function browserSlots(): SaveSlots {
  try {
    return new SaveSlots(window.localStorage);
  } catch {
    return new SaveSlots(null);
  }
}

/** «1:05:30» or «12:07» of game time. */
export function gameTime(tick: number, ticksPerSecond: number): string {
  const s = Math.floor(tick / ticksPerSecond);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}
