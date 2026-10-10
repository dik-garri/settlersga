import type { Seat } from './lockstep';
import type { PeerId, Transport } from './transport';

/**
 * The in-game chat of a network game (roadmap 6.6, docs/NETWORK.md section 1: Settlers 4 sends text
 * to everybody, to the allies only, to the enemies or to one player — we offer everybody and the
 * allies). Chat lines travel outside the lockstep on their own channel (`ch: 'chat'`): they change
 * nothing in the game, so they need no common turn. As everything else they go through the host,
 * which knows the seats and the teams: a client sends its line to the host, the host passes it on
 * to every seat that may read it (the speaker included, so everybody sees the lines in the host's
 * order) and drops lines that come too fast (`CHAT_BURST` at once, then one per `CHAT_REFILL_MS`).
 * No DOM; the owner gives the clock.
 */

/** Longest chat line (characters). */
export const CHAT_MAX = 200;
/** Lines kept. */
export const CHAT_KEEP = 50;
/** Lines a player may send at once, and how fast the allowance comes back (ms a line). */
export const CHAT_BURST = 5;
export const CHAT_REFILL_MS = 2000;

/** Who a line is for. */
export type ChatTo = 'all' | 'allies';

/** A chat line; `lobby` marks lines carried over from the lobby. */
export interface NetChatLine {
  seat: Seat;
  text: string;
  to: ChatTo;
  lobby?: boolean;
}

/** A chat line as typed: one line, trimmed, cut to `CHAT_MAX`; empty → null. */
export function cleanChat(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const s = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
  return s ? s : null;
}

/** A token bucket per key: `burst` at once, one more every `refillMs`. */
export class RateLimit {
  private readonly buckets = new Map<string | number, { tokens: number; at: number }>();

  constructor(
    private readonly burst = CHAT_BURST,
    private readonly refillMs = CHAT_REFILL_MS,
  ) {}

  /** Takes one token for `key` if there is one. */
  take(key: string | number, now: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + (now - b.at) / this.refillMs);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}

type ChatMsg = { ch: 'chat'; to: ChatTo; text: string; seat?: Seat };

const isChat = (x: unknown): x is ChatMsg =>
  typeof x === 'object' && x !== null && (x as ChatMsg).ch === 'chat' && typeof (x as ChatMsg).text === 'string';

const chatTo = (x: unknown): ChatTo => (x === 'allies' ? 'allies' : 'all');

export interface NetChatOptions {
  transport: Transport;
  /** Every human seat and its peer (read live: a returning player's new peer is set by the owner). */
  seats: Map<Seat, PeerId>;
  local: Seat;
  now: () => number;
  /** Whether two players are on one team (`World.allied`). */
  allied: (a: Seat, b: Seat) => boolean;
  /** Lines so far (the lobby's, or the host's for a returning player). */
  history?: NetChatLine[];
  /** A new line this browser may read. */
  onLine?: (line: NetChatLine) => void;
}

/** Why `say` did not send a line. */
export type SayResult = 'ok' | 'empty' | 'tooFast';

export class NetChat {
  readonly lines: NetChatLine[];
  private readonly limit = new RateLimit();
  private readonly off: () => void;

  constructor(private readonly o: NetChatOptions) {
    this.lines = (o.history ?? []).slice(-CHAT_KEEP);
    this.off = o.transport.on('message', (from, msg) => {
      if (isChat(msg)) this.receive(from, msg);
    });
  }

  /** Says something to everybody or to the allies. */
  say(text: string, to: ChatTo): SayResult {
    const s = cleanChat(text);
    if (!s) return 'empty';
    if (!this.limit.take(this.o.local, this.o.now())) return 'tooFast';
    if (this.o.transport.isHost) this.deliver(this.o.local, to, s);
    else this.o.transport.send(this.o.transport.host, { ch: 'chat', to, text: s } satisfies ChatMsg);
    return 'ok';
  }

  /** Whether the player of `seat` may read a line. */
  visibleTo(line: NetChatLine, seat: Seat): boolean {
    return line.to === 'all' || line.seat === seat || this.o.allied(line.seat, seat);
  }

  /** The lines a seat may read (the host hands them to a returning player). */
  linesFor(seat: Seat): NetChatLine[] {
    return this.lines.filter((l) => this.visibleTo(l, seat));
  }

  private seatOf(peer: PeerId): Seat | undefined {
    for (const [seat, p] of this.o.seats) if (p === peer) return seat;
    return undefined;
  }

  private receive(from: PeerId, m: ChatMsg): void {
    const text = cleanChat(m.text);
    if (!text) return;
    const t = this.o.transport;
    if (t.isHost) {
      const seat = this.seatOf(from);
      // Only seated players speak, and only as themselves; too fast is dropped.
      if (seat === undefined || !this.limit.take(seat, this.o.now())) return;
      this.deliver(seat, chatTo(m.to), text);
    } else if (from === t.host && Number.isInteger(m.seat)) this.add({ seat: m.seat!, text, to: chatTo(m.to) });
  }

  /** Host: a line goes to every seat that may read it, the speaker included. */
  private deliver(seat: Seat, to: ChatTo, text: string): void {
    const line: NetChatLine = { seat, text, to };
    const t = this.o.transport;
    const connected = t.peers();
    for (const [s, peer] of this.o.seats) {
      if (!this.visibleTo(line, s)) continue;
      if (s === this.o.local) this.add(line);
      else if (connected.includes(peer)) t.send(peer, { ch: 'chat', seat, to, text } satisfies ChatMsg);
    }
  }

  private add(line: NetChatLine): void {
    this.lines.push(line);
    if (this.lines.length > CHAT_KEEP) this.lines.shift();
    this.o.onLine?.(line);
  }

  dispose(): void {
    this.off();
  }
}
