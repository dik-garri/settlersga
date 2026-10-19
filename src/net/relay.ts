import { Emitter, randomCode, type LeaveReason, type PeerId, type Transport, type TransportProvider } from './transport';

/**
 * Variant B of docs/NETWORK.md (section 10): every browser opens a WebSocket to our relay on
 * Cloudflare (`relay/`), and the relay passes frames between the clients and the host. Unlike
 * WebRTC it needs no way through the players' routers, so it connects wherever the site opens. The
 * room is named after the game code; the relay only routes (`relay/src/room.ts`), everything else —
 * lobby, lockstep, order — stays with the host's browser, as with `PeerTransport`.
 *
 * Messages are JSON; ones longer than `CHUNK` characters go in pieces (the platform's frame limit is
 * 1 MiB). Every `heartbeat` ms the socket sends `ping`, which the relay answers with `pong` without
 * waking up; the host also asks the relay to sweep out clients that went silent. A socket that hears
 * nothing for `timeout` ms counts as broken. A relay of protocol 2 (`v` in its greeting) also passes
 * direct frames (`relayTo`: small messages straight to other members, for the voice); they arrive
 * as `relayed`, never as `message`, so nothing that trusts the host's word can be fooled by a peer.
 */

/** The relay deployed for the published game (`relay/wrangler.jsonc`); `?relay=` overrides it. */
export const DEFAULT_RELAY_URL = 'wss://settlers-relay.dik-garry-994.workers.dev';

/** The host's peer id on the relay (`room.ts` HOST). */
const HOST_ID = 'host';
const CHUNK = 200_000; // characters: ≤ 800 kB of UTF-8, under the 1 MiB frame limit
/** The relay protocol with direct frames (`room.ts` PROTOCOL), and their longest text (`DIRECT_MAX`). */
const DIRECT_PROTOCOL = 2;
const DIRECT_MAX = 4096;
const DEFAULTS = { connectTimeout: 8_000, heartbeat: 5_000, timeout: 20_000 };

/** The part of a WebSocket the transport uses (the browser's, or a fake in tests). */
export interface SocketLike {
  readonly readyState: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RelayTransportOptions {
  /** The relay's base address (`wss://…`). */
  url?: string;
  /** Opens a socket (default: the browser's `WebSocket`). */
  socket?: (url: string) => SocketLike;
  connectTimeout?: number;
  heartbeat?: number;
  timeout?: number;
}

/** A payload: a whole message or one piece of a long one. */
type Payload = { d: unknown } | { c: number; i: number; n: number; s: string };
/** Frames from the relay (`room.ts`). */
type Incoming =
  | { t: 'ready'; v?: number }
  | { t: 'taken' | 'nohost' | 'full' }
  | { t: 'welcome'; p: string; v?: number }
  | { t: 'join'; p: string }
  | { t: 'leave'; p?: string; r?: LeaveReason }
  | (Payload & { f?: string; r?: 1 });

/** Whether the relay's greeting says it passes direct frames (an older relay says nothing). */
const directOf = (first: Incoming): boolean => 'v' in first && typeof first.v === 'number' && first.v >= DIRECT_PROTOCOL;

/** The relay provider: `host()` / `join(code)`. */
export function relayProvider(opts: RelayTransportOptions = {}): TransportProvider {
  return {
    host: (code) => RelayTransport.host(code, opts),
    join: (code) => RelayTransport.join(code, opts),
  };
}

const OPEN = 1;

/** Opens a room socket and waits for the relay's first word (`ready`/`welcome` or a refusal). */
function connect(url: string, opts: RelayTransportOptions): Promise<{ ws: SocketLike; first: Incoming }> {
  const make = opts.socket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  const timeout = opts.connectTimeout ?? DEFAULTS.connectTimeout;
  return new Promise((resolve, reject) => {
    let ws: SocketLike;
    try {
      ws = make(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let done = false;
    const finish = (err: Error | null, first?: Incoming): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.onmessage = ws.onclose = ws.onerror = null;
      if (err) {
        try {
          ws.close();
        } catch {
          // never opened
        }
        reject(err);
      } else resolve({ ws, first: first! });
    };
    const timer = setTimeout(() => finish(new Error('the relay did not answer')), timeout);
    ws.onmessage = (ev) => {
      try {
        finish(null, JSON.parse(String(ev.data)) as Incoming);
      } catch {
        finish(new Error('the relay sent something odd'));
      }
    };
    ws.onclose = () => finish(new Error('the relay closed the connection'));
    ws.onerror = () => finish(new Error('the relay cannot be reached'));
  });
}

const roomUrl = (base: string, code: string, role: 'host' | 'join'): string =>
  `${base.replace(/\/+$/, '')}/room/${code}?role=${role}`;

export class RelayTransport extends Emitter implements Transport {
  readonly isHost: boolean;
  /** Host: the clients on the relay; client: the host while the room is open. */
  private members = new Set<PeerId>();
  /** Long messages being joined, by sender and id. */
  private parts = new Map<string, string[]>();
  private closed = false;
  private chunkId = 0;
  private lastSeen = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<Pick<RelayTransportOptions, 'heartbeat' | 'timeout'>>;

  private constructor(
    private ws: SocketLike,
    readonly self: PeerId,
    readonly host: PeerId,
    readonly code: string,
    opts: RelayTransportOptions,
    /** The relay passes direct frames (protocol 2): `relayTo` works. */
    readonly direct = false,
  ) {
    super();
    this.isHost = self === host;
    this.opts = { ...DEFAULTS, ...opts };
    if (!this.isHost) this.members.add(host);
    ws.onmessage = (ev) => this.onFrame(String(ev.data));
    ws.onclose = () => this.broken();
    ws.onerror = () => this.broken();
    this.timer = setInterval(() => this.beat(), this.opts.heartbeat);
    globalThis.addEventListener?.('pagehide', this.onPageHide);
  }

  private onPageHide = (): void => {
    this.raw(JSON.stringify({ bye: 'closed' }));
  };

  /** Opens a game: takes the room `code` on the relay (a fresh random code if a host is there). */
  static async host(code: string | undefined, opts: RelayTransportOptions = {}): Promise<RelayTransport> {
    const base = opts.url ?? DEFAULT_RELAY_URL;
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = attempt === 0 && code ? code : randomCode();
      const { ws, first } = await connect(roomUrl(base, c, 'host'), opts);
      if ('t' in first && first.t === 'ready') return new RelayTransport(ws, HOST_ID, HOST_ID, c, opts, directOf(first));
      ws.close();
      if (!('t' in first) || first.t !== 'taken') throw new Error(`the relay refused: ${JSON.stringify(first)}`);
    }
    throw new Error('could not get a free game code');
  }

  /** Joins the game with this code; rejects if no host has it open on the relay. */
  static async join(code: string, opts: RelayTransportOptions = {}): Promise<RelayTransport> {
    const base = opts.url ?? DEFAULT_RELAY_URL;
    const { ws, first } = await connect(roomUrl(base, code, 'join'), opts);
    if ('t' in first && first.t === 'welcome') return new RelayTransport(ws, first.p, HOST_ID, code, opts, directOf(first));
    ws.close();
    throw new Error('t' in first && first.t === 'nohost' ? 'no such game on the relay' : `the relay refused: ${JSON.stringify(first)}`);
  }

  peers(): PeerId[] {
    return [...this.members];
  }

  send(to: PeerId, msg: unknown): void {
    if (this.closed || !this.members.has(to)) return;
    this.payloads(msg, (p) => this.raw(JSON.stringify(this.isHost ? { to, ...p } : p)));
  }

  broadcast(msg: unknown): void {
    if (this.closed || this.members.size === 0) return;
    // The host's broadcast is one frame for the relay to copy, not one per client.
    if (this.isHost) this.payloads(msg, (p) => this.raw(JSON.stringify({ to: '*', ...p })));
    else this.send(this.host, msg);
  }

  relayTo(peers: PeerId[], msg: unknown): boolean {
    if (!this.direct || this.closed || this.ws.readyState !== OPEN) return false;
    const to = peers.filter((p) => p !== this.self);
    if (to.length === 0) return true;
    const text = JSON.stringify({ to, d: msg ?? null });
    if (text.length > DIRECT_MAX) return false;
    this.raw(text);
    return true;
  }

  kick(peer: PeerId): void {
    if (!this.isHost || !this.members.has(peer)) return;
    this.raw(JSON.stringify({ kick: peer }));
    this.drop(peer, 'kicked');
  }

  close(): void {
    if (this.closed) return;
    this.raw(JSON.stringify({ bye: 'closed' }));
    this.shut();
    // Give the goodbye a moment to leave before the socket goes.
    setTimeout(() => this.ws.close(1000, 'bye'), 200);
  }

  /** The message as one payload, or in pieces when it is long. */
  private payloads(msg: unknown, out: (p: Payload) => void): void {
    const text = JSON.stringify(msg ?? null);
    if (text.length <= CHUNK) {
      out({ d: msg ?? null });
      return;
    }
    const id = this.chunkId++;
    const n = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < n; i++) out({ c: id, i, n, s: text.slice(i * CHUNK, (i + 1) * CHUNK) });
  }

  private raw(text: string): void {
    if (this.ws.readyState !== OPEN) return;
    try {
      this.ws.send(text);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onFrame(text: string): void {
    if (this.closed) return;
    this.lastSeen = Date.now();
    if (text === 'pong') return;
    let f: Incoming;
    try {
      f = JSON.parse(text) as Incoming;
    } catch {
      return;
    }
    if (!f || typeof f !== 'object') return;
    if ('t' in f) {
      if (f.t === 'join' && this.isHost && !this.members.has(f.p)) {
        this.members.add(f.p);
        this.emit('join', f.p);
      } else if (f.t === 'leave') {
        // The host hears of a client; a client hears that the host (and so the room) is gone.
        if (this.isHost) {
          if (f.p) this.drop(f.p, f.r ?? 'lost');
        } else {
          this.drop(this.host, f.r ?? 'closed');
          this.shut();
        }
      }
      return;
    }
    // A direct frame: from any member, named by the relay; only the voice listens to these.
    if (f.r === 1) {
      if (typeof f.f === 'string' && f.f !== this.self && 'd' in f) this.emit('relayed', f.f, f.d);
      return;
    }
    const from = this.isHost ? f.f : this.host;
    if (!from || !this.members.has(from)) return;
    if ('d' in f) this.emit('message', from, f.d);
    else if ('c' in f) {
      const key = `${from}:${f.c}`;
      let parts = this.parts.get(key);
      if (!parts) this.parts.set(key, (parts = []));
      parts[f.i] = f.s;
      if (parts.filter((s) => s !== undefined).length === f.n) {
        this.parts.delete(key);
        this.emit('message', from, JSON.parse(parts.join('')) as unknown);
      }
    }
  }

  private beat(): void {
    if (Date.now() - this.lastSeen > this.opts.timeout) {
      this.broken();
      return;
    }
    this.raw('ping');
    if (this.isHost && this.members.size > 0) this.raw(JSON.stringify({ chk: 1 }));
  }

  /** The socket to the relay broke: everyone this browser was connected to is lost. */
  private broken(): void {
    if (this.closed) return;
    for (const p of [...this.members]) this.drop(p, 'lost');
    this.shut();
    try {
      this.ws.close();
    } catch {
      // closed already
    }
  }

  private drop(peer: PeerId, reason: LeaveReason): void {
    if (!this.members.delete(peer)) return;
    for (const key of [...this.parts.keys()]) if (key.startsWith(`${peer}:`)) this.parts.delete(key);
    this.emit('leave', peer, reason);
  }

  /** No more events or heartbeats. */
  private shut(): void {
    this.closed = true;
    this.silence();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
  }
}
