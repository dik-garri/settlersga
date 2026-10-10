import type { DataConnection, Peer, PeerOptions } from 'peerjs';
import { Emitter, randomCode, type LeaveReason, type PeerId, type Transport, type TransportProvider } from './transport';

/**
 * Variant A of docs/NETWORK.md: WebRTC data channels between the browsers, found through the free
 * public PeerJS broker (0.peerjs.com — no account, no key) with public STUN servers. The host
 * registers the peer id `<prefix><code>`; a joining browser registers a random id and connects to
 * it. The broker only introduces the peers: once a data channel is open, game traffic goes straight
 * from browser to browser (or through the TURN relay when both sit behind strict NATs).
 *
 * `peerjs` is imported lazily, so it is not in the main bundle until someone opens a network game.
 * Channels are reliable and ordered (`reliable: true`), messages JSON. PeerJS's JSON channel
 * refuses messages over ~16 kB, so longer ones (a snapshot for a reconnect) are cut into chunks
 * and joined again on arrival. A heartbeat finds connections that died without a close.
 */

export interface PeerTransportOptions {
  /** Prefix of the host's PeerJS id, so our codes do not collide with other sites on the broker. */
  prefix?: string;
  /** Broker and ICE settings (host, port, path, secure, key, `config.iceServers`…); default: PeerJS cloud. */
  peer?: PeerOptions;
  /** Giving up on joining (ms). */
  connectTimeout?: number;
  /** Heartbeat period and the silence after which a connection counts as lost (ms). */
  heartbeat?: number;
  timeout?: number;
}

/**
 * Public ICE servers: Google's and Cloudflare's STUN (enough for most home routers), then the PeerJS
 * project's public TURN relay as a last resort behind strict NATs (free, shared, no guarantees).
 */
export const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
];

export const DEFAULT_PREFIX = 'settlersga-';
const CHUNK = 4000; // characters: ≤ 12 kB of UTF-8, under PeerJS's JSON limit
const DEFAULTS = { connectTimeout: 15_000, heartbeat: 1_000, timeout: 10_000 };

/** What travels on a data channel. */
type Frame = { d: unknown } | { hb: 1 } | { c: number; i: number; n: number; s: string } | { bye: LeaveReason };

/** The PeerJS provider: `host()` / `join(code)`. */
export function peerProvider(opts: PeerTransportOptions = {}): TransportProvider {
  return {
    host: (code) => PeerTransport.host(code, opts),
    join: (code) => PeerTransport.join(code, opts),
  };
}

async function loadPeer(): Promise<typeof Peer> {
  const mod = await import('peerjs');
  return mod.Peer;
}

const peerOptions = (opts: PeerTransportOptions): PeerOptions => ({
  ...opts.peer,
  config: { iceServers: DEFAULT_ICE, ...opts.peer?.config },
});

function opened(peer: Peer, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('signalling broker did not answer')), timeout);
    peer.once('open', (id) => {
      clearTimeout(timer);
      resolve(id);
    });
    peer.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface Conn {
  dc: DataConnection;
  lastSeen: number;
  /** Chunked messages being joined, by id. */
  parts: Map<number, string[]>;
}

export class PeerTransport extends Emitter implements Transport {
  readonly isHost: boolean;
  private conns = new Map<PeerId, Conn>();
  private closed = false;
  private chunkId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<Pick<PeerTransportOptions, 'connectTimeout' | 'heartbeat' | 'timeout'>>;

  private constructor(
    private peer: Peer,
    readonly self: PeerId,
    readonly host: PeerId,
    readonly code: string,
    opts: PeerTransportOptions,
  ) {
    super();
    this.isHost = self === host;
    this.opts = { ...DEFAULTS, ...opts };
    this.timer = setInterval(() => this.beat(), this.opts.heartbeat);
    // Losing the broker does not touch open channels; the host reconnects so new players can still join.
    peer.on('disconnected', () => {
      if (!this.closed && this.isHost) peer.reconnect();
    });
    peer.on('error', (err) => {
      if (!this.closed) this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
    // A closed tab says goodbye, so the others need not wait for the heartbeat timeout.
    globalThis.addEventListener?.('pagehide', this.onPageHide);
  }

  private onPageHide = (): void => {
    for (const c of this.conns.values()) this.frame(c, { bye: 'closed' });
  };

  /** Opens a game: registers `<prefix><code>` on the broker (a fresh random code if taken). */
  static async host(code: string | undefined, opts: PeerTransportOptions = {}): Promise<PeerTransport> {
    const PeerCtor = await loadPeer();
    const prefix = opts.prefix ?? DEFAULT_PREFIX;
    const timeout = opts.connectTimeout ?? DEFAULTS.connectTimeout;
    for (let attempt = 0; attempt < 5; attempt++) {
      const c = attempt === 0 && code ? code : randomCode();
      const peer = new PeerCtor(prefix + c, peerOptions(opts));
      try {
        const id = await opened(peer, timeout);
        const t = new PeerTransport(peer, id, id, c, opts);
        peer.on('connection', (dc) => t.accept(dc));
        return t;
      } catch (err) {
        peer.destroy();
        if ((err as { type?: string }).type !== 'unavailable-id') throw err;
      }
    }
    throw new Error('could not get a free game code');
  }

  /** Joins the game with this code. */
  static async join(code: string, opts: PeerTransportOptions = {}): Promise<PeerTransport> {
    const PeerCtor = await loadPeer();
    const prefix = opts.prefix ?? DEFAULT_PREFIX;
    const timeout = opts.connectTimeout ?? DEFAULTS.connectTimeout;
    const peer = new PeerCtor(peerOptions(opts));
    try {
      const self = await opened(peer, timeout);
      const hostId = prefix + code;
      const dc = peer.connect(hostId, { reliable: true, serialization: 'json' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the host did not answer')), timeout);
        dc.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        peer.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const t = new PeerTransport(peer, self, hostId, code, opts);
      t.attach(dc);
      return t;
    } catch (err) {
      peer.destroy();
      throw err;
    }
  }

  peers(): PeerId[] {
    return [...this.conns.keys()];
  }

  send(to: PeerId, msg: unknown): void {
    const c = this.conns.get(to);
    if (!c || this.closed) return;
    const text = JSON.stringify(msg ?? null);
    if (text.length <= CHUNK) {
      this.frame(c, { d: msg ?? null });
      return;
    }
    const id = this.chunkId++;
    const n = Math.ceil(text.length / CHUNK);
    for (let i = 0; i < n; i++) this.frame(c, { c: id, i, n, s: text.slice(i * CHUNK, (i + 1) * CHUNK) });
  }

  broadcast(msg: unknown): void {
    for (const p of this.conns.keys()) this.send(p, msg);
  }

  kick(peer: PeerId): void {
    const c = this.conns.get(peer);
    if (!this.isHost || !c) return;
    this.frame(c, { bye: 'kicked' });
    this.drop(peer, 'kicked');
  }

  close(): void {
    if (this.closed) return;
    for (const c of this.conns.values()) this.frame(c, { bye: 'closed' });
    this.closed = true;
    this.silence();
    if (this.timer) clearInterval(this.timer);
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    // Give the goodbyes a moment to leave before the channels go.
    setTimeout(() => this.peer.destroy(), 200);
  }

  private frame(c: Conn, f: Frame): void {
    try {
      c.dc.send(f);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Host: a browser connected. */
  private accept(dc: DataConnection): void {
    if (this.closed) return;
    dc.once('open', () => this.attach(dc));
  }

  private attach(dc: DataConnection): void {
    const peer = dc.peer;
    const c: Conn = { dc, lastSeen: Date.now(), parts: new Map() };
    this.conns.set(peer, c);
    dc.on('data', (raw) => this.onFrame(peer, c, raw as Frame));
    dc.on('close', () => this.drop(peer, 'lost'));
    dc.on('error', () => this.drop(peer, 'lost'));
    this.emit('join', peer);
  }

  private onFrame(peer: PeerId, c: Conn, f: Frame): void {
    if (this.conns.get(peer) !== c) return;
    c.lastSeen = Date.now();
    if (!f || typeof f !== 'object') return;
    if ('d' in f) this.emit('message', peer, f.d);
    else if ('c' in f) {
      let parts = c.parts.get(f.c);
      if (!parts) c.parts.set(f.c, (parts = []));
      parts[f.i] = f.s;
      if (parts.filter((s) => s !== undefined).length === f.n) {
        c.parts.delete(f.c);
        this.emit('message', peer, JSON.parse(parts.join('')) as unknown);
      }
    } else if ('bye' in f) this.drop(peer, f.bye);
  }

  private beat(): void {
    const now = Date.now();
    for (const [peer, c] of this.conns) {
      if (now - c.lastSeen > this.opts.timeout) this.drop(peer, 'lost');
      else this.frame(c, { hb: 1 });
    }
  }

  private drop(peer: PeerId, reason: LeaveReason): void {
    const c = this.conns.get(peer);
    if (!c) return;
    this.conns.delete(peer);
    try {
      c.dc.close();
    } catch {
      // already closed
    }
    this.emit('leave', peer, reason);
  }
}
