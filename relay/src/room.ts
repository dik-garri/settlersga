/**
 * The room logic of the WebSocket relay (variant B of docs/NETWORK.md, section 10): one room per game
 * code, one host and up to `MAX_PEERS` other browsers. The relay knows nothing of the game: it routes
 * frames between the clients and the host — the star `Transport` (src/net/transport.ts) already has —
 * and tells the host who came and who left. Pure: the Durable Object (`index.ts`) and the tests
 * (tests/relay.test.ts) give it the sockets through `RoomSockets`.
 *
 * Protocol (JSON text frames; `ping` → `pong` is answered by the platform without waking the room):
 * - host → relay: `{ to: <peer> | '*', …payload }`, `{ kick: <peer> }`, `{ bye: <reason> }`, `{ chk: 1 }`
 *   (sweep: clients silent for `SILENT_MS` are dropped as lost);
 * - client → relay: `{ …payload }` (for the host), `{ bye: <reason> }`;
 * - anyone → relay (protocol 2): `{ to: [<peer>, …], d }` — a **direct frame** (the voice), passed
 *   straight to those members of the room (`'host'` included), never through the host's browser;
 * - relay → host: `{ t: 'ready', v }`, `{ t: 'join', p }`, `{ t: 'leave', p, r }`, `{ f: <peer>, …payload }`;
 * - relay → client: `{ t: 'welcome', p, v }`, `{ …payload }`, `{ t: 'leave', r }`;
 * - relay → the addressees of a direct frame: `{ f: <sender>, r: 1, d }` — `f` is the sender's tag as
 *   the relay knows it, so nobody can speak for another;
 * - refusals before closing: `{ t: 'taken' }` (a host is there already), `{ t: 'nohost' }`, `{ t: 'full' }`.
 * A payload is whatever the transport puts in it (`{ d }` or a chunk `{ c, i, n, s }`); the relay
 * passes it on untouched apart from the routing fields. `v` (`PROTOCOL`) tells a browser what the relay
 * can do: a relay without it (protocol 1) has no direct frames, and the game sends its voice through
 * the host as before; a browser of before protocol 2 ignores `v` and never sends a direct frame.
 */

export type Role = 'host' | 'join';
export type LeaveReason = 'closed' | 'lost' | 'kicked';

/** Browsers per room besides the host (the game has four seats; a few more for lobby visitors). */
export const MAX_PEERS = 8;
/** A client whose last `ping` is older than this is dropped on the host's next sweep. */
export const SILENT_MS = 20_000;
/** The longest frame passed on (the platform's WebSocket limit is 1 MiB). */
export const MAX_FRAME = 1_000_000;
/** WebSocket close codes the relay uses (4000–4999 are free for applications). */
export const CLOSE = { normal: 1000, refused: 4001, kicked: 4002, lost: 4003 } as const;

/** What the relay can do, announced in `ready`/`welcome`: 2 = direct frames. */
export const PROTOCOL = 2;
/** The longest direct frame (characters: a 40 ms voice frame is under 1 000). */
export const DIRECT_MAX = 4096;
/** Direct frames a socket may send at once, and how many a second after that (the voice sends 25). */
export const DIRECT_BURST = 50;
export const DIRECT_PER_S = 40;

/**
 * The direct frames' allowance per socket (a token bucket by tag). In memory only: after the room
 * hibernates it starts full again, which costs nothing and allows nothing a socket could not do anyway.
 */
export class DirectLimit {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  take(tag: string, now: number): boolean {
    const b = this.buckets.get(tag) ?? { tokens: DIRECT_BURST, at: now };
    b.tokens = Math.min(DIRECT_BURST, b.tokens + ((now - b.at) * DIRECT_PER_S) / 1000);
    b.at = now;
    this.buckets.set(tag, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(tag: string): void {
    this.buckets.delete(tag);
  }
}

/** The host's tag; a client's tag is its peer id. */
export const HOST = 'host';

/** What the room needs from the platform. */
export interface RoomSockets<S> {
  /** Every open socket of the room. */
  all(): S[];
  /** The socket's tag: `HOST` or the client's peer id. */
  tagOf(s: S): string;
  send(s: S, text: string): void;
  close(s: S, code: number, reason: string): void;
  /** When the socket last pinged (or opened), ms since the epoch. */
  lastSeen(s: S): number;
  /** The room's allowance for direct frames (one per room, kept while it is awake). */
  limit: DirectLimit;
}

const LEAVES: readonly string[] = ['closed', 'lost', 'kicked'];
const reasonOf = (r: unknown): LeaveReason => (typeof r === 'string' && LEAVES.includes(r) ? (r as LeaveReason) : 'closed');

function hostOf<S>(r: RoomSockets<S>, except?: S): S | undefined {
  return r.all().find((s) => s !== except && r.tagOf(s) === HOST);
}

function clientsOf<S>(r: RoomSockets<S>, except?: S): S[] {
  return r.all().filter((s) => s !== except && r.tagOf(s) !== HOST);
}

/** Before accepting a socket: why it is refused (sent as `{ t }` before closing), or null. */
export function refusal<S>(r: RoomSockets<S>, role: Role): 'taken' | 'nohost' | 'full' | null {
  const host = hostOf(r);
  if (role === 'host') return host ? 'taken' : null;
  if (!host) return 'nohost';
  return clientsOf(r).length >= MAX_PEERS ? 'full' : null;
}

/** A socket was accepted with its tag: greet it and tell the host. */
export function opened<S>(r: RoomSockets<S>, s: S): void {
  const tag = r.tagOf(s);
  if (tag === HOST) {
    r.send(s, JSON.stringify({ t: 'ready', v: PROTOCOL }));
    return;
  }
  r.send(s, JSON.stringify({ t: 'welcome', p: tag, v: PROTOCOL }));
  const host = hostOf(r, s);
  if (host) r.send(host, JSON.stringify({ t: 'join', p: tag }));
}

/** A frame arrived on `from`. */
export function message<S>(r: RoomSockets<S>, from: S, text: string, now: number): void {
  if (text.length > MAX_FRAME) return;
  let f: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    f = v as Record<string, unknown>;
  } catch {
    return;
  }
  const tag = r.tagOf(from);
  if (Array.isArray(f.to)) direct(r, tag, f, text.length, now);
  else if (tag === HOST) fromHost(r, from, f, now);
  else fromClient(r, from, tag, f);
}

/**
 * A direct frame (protocol 2): to the members of the room it names, stamped with the sender's tag.
 * Only small whole messages (`d`, no pieces), only to members other than the sender, at most
 * `DIRECT_BURST` at once and `DIRECT_PER_S` a second per socket; anything else is dropped silently.
 */
function direct<S>(r: RoomSockets<S>, tag: string, f: Record<string, unknown>, length: number, now: number): void {
  const to = f.to as unknown[];
  if (length > DIRECT_MAX || to.length === 0 || to.length > MAX_PEERS + 1 || !('d' in f) || 'c' in f) return;
  const want = new Set<string>();
  for (const p of to) if (typeof p === 'string' && p !== tag) want.add(p);
  if (want.size === 0 || !r.limit.take(tag, now)) return;
  const text = JSON.stringify({ d: f.d, f: tag, r: 1 });
  for (const s of r.all()) if (want.has(r.tagOf(s))) r.send(s, text);
}

function fromHost<S>(r: RoomSockets<S>, host: S, f: Record<string, unknown>, now: number): void {
  if ('bye' in f) {
    hostGone(r, host, reasonOf(f.bye));
    r.close(host, CLOSE.normal, 'bye');
    return;
  }
  if ('chk' in f) {
    for (const s of clientsOf(r)) if (now - r.lastSeen(s) > SILENT_MS) dropClient(r, s, 'lost', CLOSE.lost);
    return;
  }
  if (typeof f.kick === 'string') {
    const s = clientsOf(r).find((c) => r.tagOf(c) === f.kick);
    if (s) {
      r.send(s, JSON.stringify({ t: 'leave', r: 'kicked' }));
      r.close(s, CLOSE.kicked, 'kicked');
    }
    return;
  }
  const to = f.to;
  if (typeof to !== 'string') return;
  delete f.to;
  const text = JSON.stringify(f);
  for (const s of clientsOf(r)) if (to === '*' || r.tagOf(s) === to) r.send(s, text);
}

function fromClient<S>(r: RoomSockets<S>, from: S, tag: string, f: Record<string, unknown>): void {
  if ('bye' in f) {
    dropClient(r, from, reasonOf(f.bye), CLOSE.normal);
    return;
  }
  const host = hostOf(r);
  if (!host) return;
  // The relay names the sender; a client cannot pass its frame off as a direct one either.
  delete f.r;
  r.send(host, JSON.stringify({ ...f, f: tag }));
}

/** Closes a client and tells the host (once: `closed` on the same socket finds it gone). */
function dropClient<S>(r: RoomSockets<S>, s: S, reason: LeaveReason, code: number): void {
  r.limit.forget(r.tagOf(s));
  const host = hostOf(r);
  if (host) r.send(host, JSON.stringify({ t: 'leave', p: r.tagOf(s), r: reason }));
  r.close(s, code, reason);
}

/** The host is gone: every client hears it and is closed. */
function hostGone<S>(r: RoomSockets<S>, host: S, reason: LeaveReason): void {
  for (const s of clientsOf(r, host)) {
    r.send(s, JSON.stringify({ t: 'leave', r: reason }));
    r.close(s, CLOSE.normal, 'host gone');
  }
}

/**
 * A socket closed or failed (`all()` may still list it). After a bye, a kick or a sweep the host
 * hears of the same client twice; the transport ignores a leave of a peer it no longer has.
 */
export function closed<S>(r: RoomSockets<S>, s: S): void {
  if (r.tagOf(s) === HOST) {
    hostGone(r, s, 'lost');
    return;
  }
  const host = hostOf(r, s);
  if (host) r.send(host, JSON.stringify({ t: 'leave', p: r.tagOf(s), r: 'lost' }));
}
