import { cleanName } from '../net/names';
import type { PlayerId } from '../sim/types';
import type { World } from '../sim/world';
import { lower, t } from './i18n';
import { aiLevelName } from './names';
import { readPrefs, writePrefs } from './prefs';
import { activeSlots, type GameSetup } from './setup';

/**
 * Player names in the interface (docs/NETWORK.md section 15). The own name comes from the
 * preferences (`Prefs.name`, set in the settings or on the lobby screen); without one it is the
 * interface language's default name with this browser's number («Поселенец 427»). In a game the
 * interface keeps the names of the human players by player id (`GameState.names`: in a network game
 * from the setup the host sent at «Start», on one machine the own name); computer players are named
 * by their difficulty («Компьютер (средний)»), anybody else «Игрок N». Names are interface data only —
 * the simulation never sees them.
 */

/** The default name's number when storage keeps nothing (one per page load). */
let fallbackTag: number | null = null;

/** This browser's number for the default name (drawn once and kept in the preferences). */
function nameTag(): number {
  const p = readPrefs();
  if (p.nameTag !== undefined) return p.nameTag;
  fallbackTag ??= 100 + Math.floor(Math.random() * 900);
  writePrefs({ nameTag: fallbackTag });
  return fallbackTag;
}

/** The name a player has before choosing one, in the interface language. */
export function defaultName(): string {
  return t('name.default', { n: nameTag() });
}

/** The own name: the one chosen, else the default. */
export function ownName(): string {
  return readPrefs().name ?? defaultName();
}

/** The name chosen in the settings or the lobby, or null for none (the field then shows the default as a hint). */
export function chosenName(): string | null {
  return readPrefs().name ?? null;
}

/** Keeps a new own name (cleaned; empty = back to the default) and returns the name now in force. */
export function setOwnName(raw: string): string {
  const name = cleanName(raw);
  writePrefs({ name: name ?? undefined });
  return name ?? defaultName();
}

/** The human players' names of a setup by player id (position among the slots that play, as `worldArgs`). */
export function namesOf(setup: GameSetup): Map<PlayerId, string> {
  const out = new Map<PlayerId, string>();
  activeSlots(setup).forEach((s, k) => {
    const name = cleanName(s.name);
    if (name && (s.kind === 'human' || s.kind === 'remote')) out.set(k + 1, name);
  });
  return out;
}

/** A human seat's player: his name, else «Игрок N» (also while the computer plays a departed player's seat). */
export function seatName(names: ReadonlyMap<PlayerId, string>, id: PlayerId): string {
  return names.get(id) ?? t('common.player', { id });
}

/** A player's name for the screens: the known name, a computer by its difficulty, else «Игрок N». */
export function playerLabel(world: World, names: ReadonlyMap<PlayerId, string>, id: PlayerId): string {
  const name = names.get(id);
  if (name) return name;
  const level = world.aiLevel(id);
  if (level !== null) return t('name.computer', { level: lower(aiLevelName(level)) });
  return t('common.player', { id });
}

/** A row label in the players' tables: the name, «(вы)» for the own one, a cross for the defeated. */
export function playerRowLabel(world: World, names: ReadonlyMap<PlayerId, string>, id: PlayerId, me: PlayerId): string {
  const name = playerLabel(world, names, id);
  if (id === me) return t('name.you', { name });
  return world.isDefeated(id) ? `${name} †` : name;
}
