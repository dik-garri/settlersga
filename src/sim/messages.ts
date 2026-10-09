import { MESSAGE_KEEP, MESSAGES, type MessageKind } from './config';
import type { PlayerId, Point, Resource } from './types';
import type { World } from './world';

/**
 * Messages for players, as in Settlers 4 (`CTextMsgHandler::AddWarningMsg`, manual §5.1): each has a
 * place on the map — the HUD shows the local player's on the ticker, Space jumps the camera to the
 * last one (again: the one before), a click on one jumps there. Written by the simulation (attacks,
 * towers taken and lost, a missing tool or carrier, a worked-out mine, ore found, a strike, a lookout
 * tower's alarm), read by nothing in it: a ring buffer of the last `MESSAGE_KEEP`, derived, not saved.
 * The same message (kind, player, building or good) comes at most every `MESSAGES[kind].every` ticks.
 */
export interface GameMessage {
  kind: MessageKind;
  player: PlayerId;
  /** Where on the map it happened (a building's door, a settler, a player's home). */
  x: number;
  y: number;
  tick: number;
  /** The building it is about, if any (its name goes into the text). */
  b?: number;
  /** The good it is about, if any (a missing tool, the ore found). */
  res?: Resource;
}

/** Tick until which each (player, kind, key) stays quiet (`MESSAGES[kind].every`; derived, per world). */
const last = new WeakMap<World, Map<string, number>>();

/**
 * Tells `player` about something at `at` (a building `b` and/or a good `res` it concerns). Returns
 * false when the same message was given less than `MESSAGES[kind].every` ticks ago.
 */
export function postMessage(
  w: World,
  kind: MessageKind,
  player: PlayerId,
  at: Point,
  about: { b?: number; res?: Resource } = {},
): boolean {
  const { every, perPlayer } = MESSAGES[kind];
  if (every > 0) {
    let seen = last.get(w);
    if (!seen) last.set(w, (seen = new Map()));
    const key = perPlayer ? `${player}:${kind}` : `${player}:${kind}:${about.b ?? ''}:${about.res ?? ''}`;
    if ((seen.get(key) ?? -1) > w.tick) return false;
    seen.set(key, w.tick + every);
    // Keys whose quiet time is over go once the map grows (a long game with many buildings).
    if (seen.size > 4 * MESSAGE_KEEP) for (const [k, until] of seen) if (until <= w.tick) seen.delete(k);
  }
  const list = w.messages;
  list.push({ kind, player, x: Math.round(at.x), y: Math.round(at.y), tick: w.tick, ...about });
  if (list.length > MESSAGE_KEEP) list.splice(0, list.length - MESSAGE_KEEP);
  return true;
}

/** The player's messages, newest last. */
export function messagesOf(w: World, player: PlayerId): GameMessage[] {
  return w.messages.filter((m) => m.player === player);
}
