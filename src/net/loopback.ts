import { Emitter, randomCode, type LeaveReason, type PeerId, type Transport, type TransportProvider } from './transport';

/**
 * An in-memory transport: several peers of one game in one process, for tests and headless tools.
 * It keeps the promises of a real one — a star around the host, reliable and ordered per
 * connection, JSON-only payloads (every message is copied through `JSON.stringify`) — and can make
 * the network worse on purpose: one-way latency, jitter, and losses that the reliable channel hides
 * as a resend after `resend` ms (head-of-line blocking: later messages wait for the resent one, as
 * on a real SCTP/TCP stream). Time comes from a `Scheduler`, so tests run on a `VirtualClock`.
 */

/** Where delayed deliveries are scheduled. */
export interface Scheduler {
  now(): number;
  after(ms: number, fn: () => void): void;
}

/** Real time (`setTimeout`), for a loopback game in the browser. */
export const realScheduler: Scheduler = {
  now: () => (globalThis.performance ? globalThis.performance.now() : Date.now()),
  after: (ms, fn) => void setTimeout(fn, ms),
};

/** Virtual time for tests: nothing happens until `advance`. Ties run in scheduling order. */
export class VirtualClock implements Scheduler {
  private t = 0;
  private seq = 0;
  private queue: { at: number; seq: number; fn: () => void }[] = [];

  now(): number {
    return this.t;
  }

  after(ms: number, fn: () => void): void {
    this.queue.push({ at: this.t + Math.max(0, ms), seq: this.seq++, fn });
  }

  /** Moves time forward by `ms`, running everything due on the way, in time order. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let best = -1;
      for (let k = 0; k < this.queue.length; k++) {
        const e = this.queue[k];
        if (e.at > end) continue;
        if (best < 0 || e.at < this.queue[best].at || (e.at === this.queue[best].at && e.seq < this.queue[best].seq)) best = k;
      }
      if (best < 0) break;
      const [e] = this.queue.splice(best, 1);
      this.t = e.at;
      e.fn();
    }
    this.t = end;
  }

  /** Deliveries still waiting. */
  pending(): number {
    return this.queue.length;
  }
}

/** How bad a connection is. All times in milliseconds. */
export interface LinkConditions {
  /** One-way delay. */
  latency: number;
  /** Extra delay, uniform in [0, jitter). */
  jitter: number;
  /** Chance a message is lost on the wire and sent again (repeatedly, each time with this chance). */
  drop: number;
  /** How long a lost message takes to be sent again. */
  resend: number;
}

const PERFECT: LinkConditions = { latency: 0, jitter: 0, drop: 0, resend: 200 };

/** A small seeded generator for jitter and losses (deterministic tests; not the simulation's `Rng`). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Link {
  open: boolean;
  /** When the last message on this direction is delivered (keeps the order). */
  lastAt: number;
}

/** The in-memory "internet": rooms by code, links between their peers. */
export class LoopbackNetwork implements TransportProvider {
  readonly scheduler: Scheduler;
  private conditions: LinkConditions;
  private perPeer = new Map<PeerId, Partial<LinkConditions>>();
  private rand: () => number;
  private rooms = new Map<string, LoopbackTransport>();
  private nextPeer = 1;
  /** Directed links, keyed `from>to`. */
  private links = new Map<string, Link>();

  constructor(opts: { scheduler?: Scheduler; seed?: number; conditions?: Partial<LinkConditions> } = {}) {
    this.scheduler = opts.scheduler ?? realScheduler;
    this.conditions = { ...PERFECT, ...opts.conditions };
    this.rand = mulberry32(opts.seed ?? 1);
  }

  /** Every link's conditions. */
  setConditions(c: Partial<LinkConditions>): void {
    this.conditions = { ...this.conditions, ...c };
  }

  /** Extra conditions on every link touching one peer (added to the general ones): a slow player. */
  setPeerConditions(peer: PeerId, c: Partial<LinkConditions>): void {
    this.perPeer.set(peer, { ...this.perPeer.get(peer), ...c });
  }

  host(code?: string): Promise<Transport> {
    return Promise.resolve(this.openHost(code));
  }

  join(code: string): Promise<Transport> {
    try {
      return Promise.resolve(this.connect(code));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  /** Opens a room at once (the synchronous form of `host`). */
  openHost(code?: string): LoopbackTransport {
    let c = code ?? randomCode(this.rand);
    while (this.rooms.has(c)) c = randomCode(this.rand);
    const t = new LoopbackTransport(this, `host-${c}`, `host-${c}`, c);
    this.rooms.set(c, t);
    return t;
  }

  /** Joins a room at once (the synchronous form of `join`); `name` picks the peer's address. */
  connect(code: string, name?: PeerId): LoopbackTransport {
    const host = this.rooms.get(code);
    if (!host || host.isClosed) throw new Error(`no game with code ${code}`);
    const self = name ?? `peer-${this.nextPeer++}`;
    const t = new LoopbackTransport(this, self, host.self, code);
    this.links.set(`${self}>${host.self}`, { open: true, lastAt: 0 });
    this.links.set(`${host.self}>${self}`, { open: true, lastAt: 0 });
    host.attach(t);
    t.attach(host);
    return t;
  }

  /** Breaks a peer's connections without a goodbye (a crashed tab, a lost network): both ends see `lost`. */
  disconnect(peer: PeerId): void {
    for (const t of this.endpoints(peer)) this.breakLink(peer, t, 'lost', 'lost');
  }

  private endpoints(peer: PeerId): LoopbackTransport[] {
    const out: LoopbackTransport[] = [];
    for (const room of this.rooms.values()) {
      if (room.self === peer) out.push(...room.connected());
      else if (room.has(peer)) out.push(room);
    }
    return out;
  }

  /** Closes the link between `peer` and `other` at once; in-flight messages are lost. */
  private breakLink(peer: PeerId, other: LoopbackTransport, mine: LeaveReason, theirs: LeaveReason): void {
    const a = this.links.get(`${peer}>${other.self}`);
    const b = this.links.get(`${other.self}>${peer}`);
    if (!a?.open && !b?.open) return;
    if (a) a.open = false;
    if (b) b.open = false;
    const me = this.find(peer);
    me?.detach(other.self, mine);
    other.detach(peer, theirs);
  }

  private find(peer: PeerId): LoopbackTransport | undefined {
    for (const room of this.rooms.values()) {
      if (room.self === peer) return room;
      const c = room.peer(peer);
      if (c) return c;
    }
    return undefined;
  }

  private delay(from: PeerId, to: PeerId): number {
    const a = this.perPeer.get(from) ?? {};
    const b = this.perPeer.get(to) ?? {};
    const c = this.conditions;
    const latency = c.latency + (a.latency ?? 0) + (b.latency ?? 0);
    const jitter = c.jitter + (a.jitter ?? 0) + (b.jitter ?? 0);
    const drop = Math.min(0.95, c.drop + (a.drop ?? 0) + (b.drop ?? 0));
    const resend = Math.max(c.resend, a.resend ?? 0, b.resend ?? 0);
    let d = latency + this.rand() * jitter;
    while (drop > 0 && this.rand() < drop) d += resend;
    return d;
  }

  /** @internal Queues a message on the directed link, keeping its order. */
  deliver(from: LoopbackTransport, to: LoopbackTransport, msg: unknown): void {
    const link = this.links.get(`${from.self}>${to.self}`);
    if (!link?.open) return;
    const copy = JSON.parse(JSON.stringify(msg ?? null)) as unknown;
    const now = this.scheduler.now();
    const at = Math.max(now + this.delay(from.self, to.self), link.lastAt);
    link.lastAt = at;
    this.scheduler.after(at - now, () => {
      if (link.open) to.receive(from.self, copy);
    });
  }

  /** @internal A goodbye: delivered after the messages already on the way, then the link closes. */
  goodbye(from: LoopbackTransport, to: LoopbackTransport, reason: LeaveReason): void {
    const link = this.links.get(`${from.self}>${to.self}`);
    const back = this.links.get(`${to.self}>${from.self}`);
    if (!link?.open) return;
    // Nothing more goes back to the leaver.
    if (back) back.open = false;
    from.detach(to.self, null);
    const now = this.scheduler.now();
    const at = Math.max(now + this.delay(from.self, to.self), link.lastAt);
    link.lastAt = at;
    this.scheduler.after(at - now, () => {
      if (!link.open) return;
      link.open = false;
      to.detach(from.self, reason);
    });
  }
}

/** One peer's end of the loopback network. */
export class LoopbackTransport extends Emitter implements Transport {
  readonly isHost: boolean;
  private conns = new Map<PeerId, LoopbackTransport>();
  private closedFlag = false;

  constructor(
    private net: LoopbackNetwork,
    readonly self: PeerId,
    readonly host: PeerId,
    readonly code: string,
  ) {
    super();
    this.isHost = self === host;
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  peers(): PeerId[] {
    return [...this.conns.keys()];
  }

  /** @internal */
  connected(): LoopbackTransport[] {
    return [...this.conns.values()];
  }

  /** @internal */
  has(peer: PeerId): boolean {
    return this.conns.has(peer);
  }

  /** @internal */
  peer(peer: PeerId): LoopbackTransport | undefined {
    return this.conns.get(peer);
  }

  send(to: PeerId, msg: unknown): void {
    const t = this.conns.get(to);
    if (t && !this.closedFlag) this.net.deliver(this, t, msg);
  }

  broadcast(msg: unknown): void {
    for (const p of this.conns.keys()) this.send(p, msg);
  }

  kick(peer: PeerId): void {
    const t = this.conns.get(peer);
    if (!this.isHost || !t) return;
    this.net.goodbye(this, t, 'kicked');
    this.emit('leave', peer, 'kicked');
  }

  close(): void {
    if (this.closedFlag) return;
    for (const t of [...this.conns.values()]) this.net.goodbye(this, t, 'closed');
    this.closedFlag = true;
    this.silence();
  }

  /** @internal A connection opened. */
  attach(other: LoopbackTransport): void {
    this.conns.set(other.self, other);
    this.emit('join', other.self);
  }

  /** @internal A connection closed; `reason` null = quietly (our own goodbye). */
  detach(peer: PeerId, reason: LeaveReason | null): void {
    if (!this.conns.delete(peer)) return;
    if (reason) this.emit('leave', peer, reason);
  }

  /** @internal */
  receive(from: PeerId, msg: unknown): void {
    if (!this.closedFlag && this.conns.has(from)) this.emit('message', from, msg);
  }
}
