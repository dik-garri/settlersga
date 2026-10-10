import { Lockstep, type DesyncReport, type LockstepMsg, type LockstepOptions, type Seat } from './lockstep';
import type { PeerId, Transport } from './transport';

/**
 * Binds a `Lockstep` to a `Transport`: maps seats to peers, wraps the lockstep messages in their
 * own channel (`ch: 'ls'`, so the lobby, chat and snapshots can share the connection), and turns
 * a client's departure into `drop` on the host and the host's departure into `onHostLost` on a
 * client (the game cannot go on without the hub; see docs/NETWORK.md, «Выход игрока»).
 */

/** The lockstep channel's envelope on the transport. */
export interface LockstepEnvelope {
  ch: 'ls';
  m: LockstepMsg;
}

const isEnvelope = (x: unknown): x is LockstepEnvelope =>
  typeof x === 'object' && x !== null && (x as { ch?: unknown }).ch === 'ls' && typeof (x as { m?: unknown }).m === 'object';

export interface SessionOptions {
  /**
   * Every human seat and the peer that plays it (the host's included). Read live: a returning
   * player's new peer is set here by the owner (`NetCore`) and the session follows.
   */
  seats: Map<Seat, PeerId>;
  /** Input delay in turns. */
  delay: number;
  /** A browser joining a game under way: where its lockstep starts (`LockstepOptions.resume`). */
  resume?: LockstepOptions['resume'];
  /** The seats handing in batches now, when not every seat in `seats` does (a resumed game). */
  active?: Seat[];
  onDesync?: (report: DesyncReport) => void;
  /** Client: the host is gone. */
  onHostLost?: () => void;
  /** Host: a seat's player left (the computer takes it over from the turn the lockstep announces). */
  onSeatLeft?: (seat: Seat) => void;
}

export interface LockstepSession {
  lockstep: Lockstep;
  /** Unsubscribes from the transport (does not close it). */
  dispose(): void;
}

export function bindLockstep(transport: Transport, opts: SessionOptions): LockstepSession {
  const seatOf = (peer: PeerId): Seat | undefined => {
    for (const [seat, p] of opts.seats) if (p === peer) return seat;
    return undefined;
  };
  const local = seatOf(transport.self);
  const host = seatOf(transport.host);
  if (local === undefined || host === undefined) throw new Error('lockstep session: this peer and the host need a seat');
  const lockstep = new Lockstep({
    seats: opts.active ?? [...opts.seats.keys()],
    local,
    host,
    delay: opts.delay,
    resume: opts.resume,
    onDesync: opts.onDesync,
    send: (to, m) => {
      const env: LockstepEnvelope = { ch: 'ls', m };
      if (to === 'all') transport.broadcast(env);
      else {
        const peer = opts.seats.get(to);
        if (peer !== undefined) transport.send(peer, env);
      }
    },
  });
  const offMessage = transport.on('message', (from, msg) => {
    const seat = seatOf(from);
    if (seat !== undefined && isEnvelope(msg)) lockstep.receive(seat, msg.m);
  });
  const offLeave = transport.on('leave', (peer) => {
    const seat = seatOf(peer);
    if (seat === undefined) return;
    if (transport.isHost) {
      lockstep.drop(seat);
      opts.onSeatLeft?.(seat);
    } else if (peer === transport.host) opts.onHostLost?.();
  });
  return {
    lockstep,
    dispose: () => {
      offMessage();
      offLeave();
    },
  };
}
