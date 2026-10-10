import type { Seat } from './lockstep';
import type { PeerId, Transport } from './transport';

/**
 * Round trips and the «waiting for» line of a network game (docs/NETWORK.md sections 4 and 6),
 * for the lobby and the game alike. No timers of its own: the owner calls `update(now)` from its
 * loop, so tests run it on a virtual clock.
 *
 * - `PingMeter`: every peer pings the peers it is connected to every `every` ms (channel `ping`) and
 *   answers their pings; a round trip is the time from a ping to its answer. On the host that is
 *   every client, on a client the host.
 * - `NetStatus`: in a game the host also tells everybody once a second whose batch the game is
 *   waiting for and every seat's round trip to it (channel `st`), since a client knows neither.
 */

type PingMsg = { ch: 'ping'; t: number } | { ch: 'pong'; t: number };

const isPing = (x: unknown): x is PingMsg =>
  typeof x === 'object' && x !== null && ((x as PingMsg).ch === 'ping' || (x as PingMsg).ch === 'pong') && typeof (x as PingMsg).t === 'number';

/** Round trips a meter remembers per peer (`worst`: the jitter shows in the worst of them). */
const RECENT = 6;

export class PingMeter {
  private readonly rtts = new Map<PeerId, number>();
  private readonly recent = new Map<PeerId, number[]>();
  private last = -Infinity;
  private readonly off: () => void;

  constructor(
    private readonly transport: Transport,
    private readonly now: () => number,
    private readonly every = 1000,
  ) {
    this.off = transport.on('message', (from, msg) => {
      if (!isPing(msg)) return;
      if (msg.ch === 'ping') transport.send(from, { ch: 'pong', t: msg.t });
      else {
        const rtt = Math.max(0, this.now() - msg.t);
        this.rtts.set(from, rtt);
        const list = this.recent.get(from) ?? [];
        list.push(rtt);
        if (list.length > RECENT) list.shift();
        this.recent.set(from, list);
      }
    });
  }

  /** Sends the pings when due. */
  update(): void {
    const now = this.now();
    if (now - this.last < this.every) return;
    this.last = now;
    for (const p of this.transport.peers()) this.transport.send(p, { ch: 'ping', t: now });
  }

  /** The last round trip to a peer (ms), or null before the first answer. */
  rtt(peer: PeerId): number | null {
    return this.rtts.get(peer) ?? null;
  }

  /** The worst of the last few round trips to a peer (ms), or null before the first answer. */
  worst(peer: PeerId): number | null {
    const list = this.recent.get(peer);
    if (!list || list.length === 0) return null;
    let w = 0;
    for (const v of list) w = Math.max(w, v);
    return w;
  }

  forget(peer: PeerId): void {
    this.rtts.delete(peer);
    this.recent.delete(peer);
  }

  dispose(): void {
    this.off();
  }
}

interface StatusMsg {
  ch: 'st';
  /** Every client seat's round trip to the host (ms; null = not measured yet). */
  pings: [Seat, number | null][];
  /** Seats the host is waiting for. */
  waiting: Seat[];
}

const isStatus = (x: unknown): x is StatusMsg =>
  typeof x === 'object' && x !== null && (x as StatusMsg).ch === 'st' && Array.isArray((x as StatusMsg).pings) && Array.isArray((x as StatusMsg).waiting);

export interface NetStatusOptions {
  transport: Transport;
  /** Every human seat and its peer (read live: a returning player's new peer is set by the owner). */
  seats: Map<Seat, PeerId>;
  local: Seat;
  host: Seat;
  /** Whose batch the game waits for (the host's lockstep knows; a client only knows «the host»). */
  waitingFor: () => Seat[];
  now: () => number;
  /** How often the host tells everybody (ms). */
  every?: number;
}

export class NetStatus {
  readonly meter: PingMeter;
  private pingsBySeat = new Map<Seat, number | null>();
  private hostWaiting: Seat[] = [];
  private last = -Infinity;
  private readonly off: () => void;

  constructor(private readonly o: NetStatusOptions) {
    this.meter = new PingMeter(o.transport, o.now, o.every ?? 1000);
    this.off = o.transport.on('message', (from, msg) => {
      if (!isStatus(msg) || o.transport.isHost || from !== o.transport.host) return;
      this.pingsBySeat = new Map(msg.pings.filter(([s, v]) => Number.isInteger(s) && (v === null || typeof v === 'number')));
      this.hostWaiting = msg.waiting.filter((s) => Number.isInteger(s));
    });
  }

  /** Pings and (host) the status message, when due. */
  update(): void {
    this.meter.update();
    const t = this.o.transport;
    if (!t.isHost) return;
    const now = this.o.now();
    if (now - this.last < (this.o.every ?? 1000)) return;
    this.last = now;
    const pings: [Seat, number | null][] = [];
    const connected = t.peers();
    for (const [seat, peer] of this.o.seats) if (seat !== this.o.local && connected.includes(peer)) pings.push([seat, this.meter.rtt(peer)]);
    this.pingsBySeat = new Map(pings);
    this.hostWaiting = this.o.waitingFor();
    t.broadcast({ ch: 'st', pings, waiting: this.hostWaiting } satisfies StatusMsg);
  }

  /** A seat's round trip to the host (ms): on a client its own is measured directly. */
  ping(seat: Seat): number | null {
    if (seat === this.o.host) return null;
    if (!this.o.transport.isHost && seat === this.o.local) return this.meter.rtt(this.o.transport.host);
    return this.pingsBySeat.get(seat) ?? null;
  }

  /**
   * Whose batch the game waits for: the host knows; a client whose own game waits names the seats
   * the host last reported (or the host itself when it reported none — the host is the slow one).
   */
  waiting(stalled: boolean): Seat[] {
    if (this.o.transport.isHost) return stalled ? this.o.waitingFor() : [];
    if (!stalled) return [];
    const others = this.hostWaiting.filter((s) => s !== this.o.local);
    return others.length > 0 ? others : [this.o.host];
  }

  /** Host: the worst recent round trip to any player still connected (ms), null before any answer. */
  worstRtt(): number | null {
    let worst: number | null = null;
    const connected = this.o.transport.peers();
    for (const [seat, peer] of this.o.seats) {
      if (seat === this.o.local || !connected.includes(peer)) continue;
      const v = this.meter.worst(peer);
      if (v !== null) worst = Math.max(worst ?? 0, v);
    }
    return worst;
  }

  dispose(): void {
    this.off();
    this.meter.dispose();
  }
}
