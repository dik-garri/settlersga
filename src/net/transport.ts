/**
 * The network transport of phase 6 (docs/NETWORK.md): reliable, ordered messages between the
 * browsers of one game, in a star around the host. The host is connected to every other peer; a
 * peer that is not the host is connected only to the host, who relays what the others must see
 * (the lockstep turns, `lockstep.ts`). Two implementations: `PeerTransport` (WebRTC data channels,
 * signalling through the public PeerJS broker, `peer.ts`) and `LoopbackTransport` (in memory, for
 * tests, `loopback.ts`); a WebSocket relay (variant B) would be a third behind the same interface.
 *
 * Messages are plain JSON values. A transport never loses or reorders a message on a connection
 * that stays open; a connection that breaks is reported as a `leave` and never comes back by
 * itself (a reconnecting browser joins again, as a new peer).
 */

/** A peer's address on the transport (a PeerJS id, a loopback name). */
export type PeerId = string;

/** Why a peer left: it closed the connection, the connection broke or timed out, or the host removed it. */
export type LeaveReason = 'closed' | 'lost' | 'kicked';

export interface TransportEvents {
  /** A message from a directly connected peer. */
  message: (from: PeerId, msg: unknown) => void;
  /** A peer connected (on the host: a new player; on a client: only the host, once). */
  join: (peer: PeerId) => void;
  /** A connected peer is gone. On a client, the host leaving ends the session. */
  leave: (peer: PeerId, reason: LeaveReason) => void;
  /** Something went wrong that is not a leave (signalling lost, a message too big…). */
  error: (err: Error) => void;
}

export interface Transport {
  /** This browser's address. */
  readonly self: PeerId;
  /** The host's address (= `self` on the host). */
  readonly host: PeerId;
  readonly isHost: boolean;
  /** The room code others join with (the host's code; on a client, the code it joined). */
  readonly code: string;
  /** The peers this browser is connected to: every client on the host, the host on a client. */
  peers(): PeerId[];
  /** Sends a message to one connected peer (ignored if it is not connected any more). */
  send(to: PeerId, msg: unknown): void;
  /** Sends a message to every connected peer. */
  broadcast(msg: unknown): void;
  /** Host only: drops a peer (it gets a `leave` with reason `kicked` on its side). */
  kick(peer: PeerId): void;
  /** Subscribes to an event; returns the unsubscribe function. */
  on<K extends keyof TransportEvents>(event: K, fn: TransportEvents[K]): () => void;
  /** Closes every connection; no events are emitted afterwards. */
  close(): void;
}

/** Creating or joining a game: what the lobby needs from a transport implementation. */
export interface TransportProvider {
  /** Opens a game as host; `code` asks for a room code (a random one when omitted or taken). */
  host(code?: string): Promise<Transport>;
  /** Joins the game with this room code; rejects if there is none or it cannot be reached. */
  join(code: string): Promise<Transport>;
}

/** Room codes: six letters and digits without look-alikes (no 0/O, 1/I/L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/** A random room code (`rand` returns [0, 1); UI-side randomness, never the simulation's). */
export function randomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let k = 0; k < CODE_LENGTH; k++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

/** A code typed by a player, normalised (upper case, spaces and dashes dropped); null if invalid. */
export function normaliseCode(text: string): string | null {
  const s = text.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** The event plumbing shared by the transports. */
export class Emitter {
  private handlers: { [K in keyof TransportEvents]: Set<TransportEvents[K]> } = {
    message: new Set(),
    join: new Set(),
    leave: new Set(),
    error: new Set(),
  };
  private muted = false;

  on<K extends keyof TransportEvents>(event: K, fn: TransportEvents[K]): () => void {
    const set = this.handlers[event] as Set<TransportEvents[K]>;
    set.add(fn);
    return () => set.delete(fn);
  }

  protected emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): void {
    if (this.muted) return;
    for (const fn of [...(this.handlers[event] as Set<(...a: unknown[]) => void>)]) fn(...args);
  }

  /** Stops every further event (after `close`). */
  protected silence(): void {
    this.muted = true;
  }
}
