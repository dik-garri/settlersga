import type { Seat } from '../net/lockstep';
import { REJOIN_GRACE_MS } from '../net/core';

/**
 * A client's way back into a network game after a reload (roadmap 6.7): the tab remembers the room
 * and its seat in `sessionStorage` (per tab, so it survives a reload but not a new tab), and the
 * address keeps `?join=<code>` while the game runs, so a reload opens the lobby, which asks the host
 * for that seat. Storage access is guarded.
 */

const KEY = 'settlers.netSeat';

interface Hint {
  code: string;
  seat: Seat;
  at: number;
}

/** Remembers the room and the seat of the game this tab plays. */
export function keepRejoin(code: string, seat: Seat): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ code, seat, at: Date.now() } satisfies Hint));
  } catch {
    // Not kept: the player picks the seat by hand.
  }
}

/** The seat this tab played in the room `code`, if it was there lately. */
export function rejoinSeat(code: string): Seat | null {
  try {
    const h = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Hint | null;
    if (h && h.code === code && Number.isInteger(h.seat) && Date.now() - h.at < REJOIN_GRACE_MS * 3) return h.seat;
  } catch {
    // Unreadable: none.
  }
  return null;
}

/** The game was left on purpose: nothing to come back to. */
export function forgetRejoin(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}
