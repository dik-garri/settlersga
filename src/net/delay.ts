import { TICKS_PER_SECOND } from '../sim/config';
import { TURN_TICKS } from './match';

/**
 * The input delay of a network game (docs/NETWORK.md sections 2 and 6): how many turns ahead a
 * player's batch is played. Long enough that a batch reaches the host and the sealed turn comes back
 * before it is due (no stall), short enough that orders feel quick. The lobby picks the first one
 * from its pings (`delayFor`); in the game the host keeps it fitting (`DelayTuner`, roadmap 6.7).
 */

/** Input delay bounds (turns at 1×); at a higher speed a turn is shorter, so the bounds scale with it. */
export const MIN_DELAY = 2;
export const MAX_DELAY = 6;
/** Spare time on top of the round trip (ms): a sealed turn must also be handled on both ends. */
const MARGIN_MS = 100;

/**
 * The input delay for the worst round trip: ⌈(RTT + 100 ms) / turn⌉ turns, within 2…6 turns at 1×
 * (×2: 4…12, the same real time).
 */
export function delayFor(maxRtt: number, turnTicks = TURN_TICKS, speed = 1): number {
  const turnMs = (turnTicks * 1000) / TICKS_PER_SECOND / speed;
  const lo = Math.round(MIN_DELAY * speed);
  const hi = Math.round(MAX_DELAY * speed);
  return Math.max(lo, Math.min(hi, Math.ceil((Math.max(0, maxRtt) + MARGIN_MS) / turnMs)));
}

export interface DelayTunerOptions {
  turnTicks?: number;
  /** How long the round trips must allow a shorter delay before the host shortens it (ms). */
  downAfter?: number;
}

/**
 * The host's adaptive input delay (roadmap 6.7). Fed the worst recent round trip to any player, the
 * delay in force and the speed, it says when to announce another delay: at once when the round trips
 * need a longer one (stalls cost more than latency), one turn shorter only after the round trips
 * have allowed it for `downAfter` ms (no see-saw on a jittery link). One change at a time: while an
 * announced change has not been played yet (`pending`), it says nothing.
 */
export class DelayTuner {
  private lowSince: number | null = null;
  /** The delay announced and not in force yet, and when (forgotten after `downAfter`: it got lost). */
  private asked: number | null = null;
  private askedAt = 0;
  private readonly turnTicks: number;
  private readonly downAfter: number;

  constructor(o: DelayTunerOptions = {}) {
    this.turnTicks = o.turnTicks ?? TURN_TICKS;
    this.downAfter = o.downAfter ?? 10_000;
  }

  /** Whether an announced change is still on its way. */
  pending(current: number, now = 0): boolean {
    if (this.asked !== null && (this.asked === current || now - this.askedAt > this.downAfter)) this.asked = null;
    return this.asked !== null;
  }

  /** The delay to announce now, or null. */
  update(now: number, worstRtt: number | null, current: number, speed: number): number | null {
    if (worstRtt === null || this.pending(current, now)) return null;
    const want = delayFor(worstRtt, this.turnTicks, speed);
    if (want > current) {
      this.lowSince = null;
      this.askedAt = now;
      return (this.asked = want);
    }
    if (want < current) {
      if (this.lowSince === null) this.lowSince = now;
      if (now - this.lowSince >= this.downAfter) {
        this.lowSince = null;
        this.askedAt = now;
        return (this.asked = current - 1);
      }
      return null;
    }
    this.lowSince = null;
    return null;
  }
}
