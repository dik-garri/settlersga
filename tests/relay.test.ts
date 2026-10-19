import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECT_BURST, DIRECT_MAX, DirectLimit, HOST, MAX_PEERS, SILENT_MS, closed, message, opened, refusal, type Role, type RoomSockets } from '../relay/src/room';
import { fallbackProvider } from '../src/net/provider';
import { RelayTransport, type RelayTransportOptions, type SocketLike } from '../src/net/relay';
import type { LeaveReason, Transport, TransportProvider } from '../src/net/transport';

/**
 * The relay (variant B) end to end in memory: `room.ts` — the Durable Object's routing — behind fake
 * sockets that behave like the platform's (frames delivered asynchronously, `ping` answered with
 * `pong` without reaching the room), and `RelayTransport` on the browser side.
 */

interface Server {
  tag: string;
  client: FakeSocket;
  at: number;
  pinged: number;
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  server: Server | null = null;
  /** Stops answering pings (a browser whose network died without a close). */
  mute = false;
  constructor(private relay: FakeRelay, readonly room: string) {}
  send(text: string): void {
    if (this.readyState !== 1 || this.mute) return;
    const s = this.server!;
    if (text === 'ping') {
      s.pinged = Date.now();
      this.deliver('pong');
      return;
    }
    const r = this.relay.sockets(this.room);
    queueMicrotask(() => {
      if (this.relay.open(this.room).includes(s)) message(r, s, text, Date.now());
    });
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const s = this.server;
    if (!s || !this.relay.open(this.room).includes(s)) return;
    this.relay.remove(this.room, s);
    queueMicrotask(() => closed(this.relay.sockets(this.room), s));
  }
  deliver(text: string): void {
    queueMicrotask(() => {
      if (this.readyState === 1) this.onmessage?.({ data: text });
    });
  }
}

/** The platform: rooms of accepted sockets, and the `index.ts` accept/refuse step. */
class FakeRelay {
  private rooms = new Map<string, Server[]>();
  private limits = new Map<string, DirectLimit>();
  private n = 0;
  /** Plays a relay of before protocol 2: its greetings say nothing of direct frames. */
  constructor(private readonly old = false) {}
  open(room: string): Server[] {
    return this.rooms.get(room) ?? [];
  }
  remove(room: string, s: Server): void {
    this.rooms.set(room, this.open(room).filter((x) => x !== s));
  }
  sockets(room: string): RoomSockets<Server> {
    return {
      all: () => [...this.open(room)],
      tagOf: (s) => s.tag,
      send: (s, text) => s.client.deliver(this.old && /^\{"t":"(ready|welcome)"/.test(text) ? text.replace(/,"v":\d+/, '') : text),
      close: (s) => {
        if (!this.open(room).includes(s)) return;
        this.remove(room, s);
        queueMicrotask(() => {
          s.client.readyState = 3;
          s.client.onclose?.({});
        });
      },
      lastSeen: (s) => Math.max(s.at, s.pinged),
      limit: this.limits.get(room) ?? this.limits.set(room, new DirectLimit()).get(room)!,
    };
  }
  socket = (url: string): SocketLike => {
    const m = /\/room\/([A-Z0-9]+)\?role=(host|join)$/.exec(url)!;
    const room = m[1];
    const role = m[2] as Role;
    const ws = new FakeSocket(this, room);
    queueMicrotask(() => {
      ws.readyState = 1;
      const r = this.sockets(room);
      const refused = refusal(r, role);
      if (refused) {
        ws.deliver(JSON.stringify({ t: refused }));
        queueMicrotask(() => ws.close());
        return;
      }
      const s: Server = { tag: role === 'host' ? HOST : `p${++this.n}`, client: ws, at: Date.now(), pinged: 0 };
      ws.server = s;
      this.rooms.set(room, [...this.open(room), s]);
      opened(r, s);
    });
    return ws;
  };
}

const flush = async (): Promise<void> => {
  for (let k = 0; k < 20; k++) await Promise.resolve();
};

function setup(old = false) {
  const relay = new FakeRelay(old);
  const opts: RelayTransportOptions = { url: 'wss://relay.test', socket: relay.socket, heartbeat: 1000, timeout: 30_000 };
  return { relay, opts };
}

function record(t: Transport) {
  const got: { from: string; msg: unknown }[] = [];
  const joins: string[] = [];
  const leaves: [string, LeaveReason][] = [];
  t.on('message', (from, msg) => got.push({ from, msg }));
  t.on('join', (p) => joins.push(p));
  t.on('leave', (p, r) => leaves.push([p, r]));
  const direct: { from: string; msg: unknown }[] = [];
  t.on('relayed', (from, msg) => direct.push({ from, msg }));
  return { got, joins, leaves, direct };
}

/** A transport's raw socket, to send frames a modified browser could. */
const rawOf = (t: Transport) => (text: string) => (t as unknown as { ws: SocketLike }).ws.send(text);

describe('relay transport (variant B)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('hosts a room, lets clients join and passes messages both ways', async () => {
    const { opts } = setup();
    const host = await RelayTransport.host('ABCDEF', opts);
    expect(host.isHost).toBe(true);
    expect(host.code).toBe('ABCDEF');
    const h = record(host);
    const a = await RelayTransport.join('ABCDEF', opts);
    const b = await RelayTransport.join('ABCDEF', opts);
    await flush();
    const ra = record(a);
    const rb = record(b);
    expect(h.joins).toEqual([a.self, b.self]);
    expect(host.peers()).toEqual([a.self, b.self]);
    expect(a.peers()).toEqual([host.self]);
    expect(a.host).toBe(host.self);

    a.send(a.host, { hi: 'from a' });
    b.broadcast({ hi: 'from b' });
    await flush();
    expect(h.got).toEqual([
      { from: a.self, msg: { hi: 'from a' } },
      { from: b.self, msg: { hi: 'from b' } },
    ]);

    host.send(b.self, { only: 'b' });
    host.broadcast({ all: 1 });
    await flush();
    expect(ra.got).toEqual([{ from: host.self, msg: { all: 1 } }]);
    expect(rb.got).toEqual([
      { from: host.self, msg: { only: 'b' } },
      { from: host.self, msg: { all: 1 } },
    ]);
    host.close();
    a.close();
    b.close();
  });

  it('takes another code when a host has the room, and refuses a join with no host', async () => {
    const { opts } = setup();
    const first = await RelayTransport.host('ABCDEF', opts);
    const second = await RelayTransport.host('ABCDEF', opts);
    expect(second.code).not.toBe('ABCDEF');
    await expect(RelayTransport.join('ZZZZZZ', opts)).rejects.toThrow(/no such game/);
    first.close();
    second.close();
  });

  it('refuses joins over the room limit', async () => {
    const { opts } = setup();
    const host = await RelayTransport.host('ROOMXX', opts);
    const clients: Transport[] = [];
    for (let k = 0; k < MAX_PEERS; k++) clients.push(await RelayTransport.join('ROOMXX', opts));
    await expect(RelayTransport.join('ROOMXX', opts)).rejects.toThrow(/refused/);
    for (const c of clients) c.close();
    host.close();
  });

  it('cuts long messages into pieces and joins them again', async () => {
    const { opts } = setup();
    const host = await RelayTransport.host('LONGGG', opts);
    const a = await RelayTransport.join('LONGGG', opts);
    await flush();
    const h = record(host);
    const ra = record(a);
    const big = { text: 'x'.repeat(650_000), n: 7 };
    a.send(a.host, big);
    host.send(a.self, big);
    host.broadcast({ text: 'y'.repeat(450_000) });
    await flush();
    expect(h.got).toEqual([{ from: a.self, msg: big }]);
    expect(ra.got.map((g) => g.msg)).toEqual([big, { text: 'y'.repeat(450_000) }]);
    host.close();
    a.close();
  });

  it('tells the host who left and why, and the clients when the host goes', async () => {
    const { opts } = setup();
    const host = await RelayTransport.host('LEAVES', opts);
    const a = await RelayTransport.join('LEAVES', opts);
    const b = await RelayTransport.join('LEAVES', opts);
    const c = await RelayTransport.join('LEAVES', opts);
    await flush();
    const h = record(host);
    const rb = record(b);
    const rc = record(c);

    a.close(); // says goodbye
    host.kick(b.self);
    await flush();
    // The kick is the host's own act and counts at once; a's goodbye comes through the relay.
    expect(h.leaves).toEqual([
      [b.self, 'kicked'],
      [a.self, 'closed'],
    ]);
    expect(rb.leaves).toEqual([[b.host, 'kicked']]);
    expect(host.peers()).toEqual([c.self]);

    host.close();
    await flush();
    expect(rc.leaves).toEqual([[c.host, 'closed']]);
    expect(c.peers()).toEqual([]);
  });

  it('drops a client that went silent, and a client whose relay went silent drops the host', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'Date'] });
    const { opts } = setup();
    const hostP = RelayTransport.host('QUIETS', opts);
    await flush();
    const host = await hostP;
    const aP = RelayTransport.join('QUIETS', opts);
    await flush();
    const a = await aP;
    const bP = RelayTransport.join('QUIETS', opts);
    await flush();
    const b = await bP;
    await flush();
    const h = record(host);
    const rb = record(b);

    (a as unknown as { ws: FakeSocket }).ws.mute = true; // its pings stop reaching the relay
    for (let t = 0; t < SILENT_MS + 3000; t += 1000) {
      vi.advanceTimersByTime(1000);
      await flush();
    }
    expect(h.leaves).toEqual([[a.self, 'lost']]);
    expect(host.peers()).toEqual([b.self]);
    expect(rb.leaves).toEqual([]);

    // b stops hearing anything at all: after its timeout it counts the host as lost.
    (b as unknown as { ws: FakeSocket }).ws.onmessage = null;
    vi.advanceTimersByTime(31_000);
    await flush();
    expect(rb.leaves).toEqual([[b.host, 'lost']]);
    host.close();
  });
});

describe('direct frames (protocol 2: the voice past the host)', () => {
  it('go straight to the members named, stamped with the sender; never as the host\'s messages', async () => {
    const { opts } = setup();
    const host = await RelayTransport.host('DIRECT', opts);
    const a = await RelayTransport.join('DIRECT', opts);
    const b = await RelayTransport.join('DIRECT', opts);
    const c = await RelayTransport.join('DIRECT', opts);
    await flush();
    expect([host, a, b, c].map((t) => t.direct)).toEqual([true, true, true, true]);
    const [h, ra, rb, rc] = [host, a, b, c].map(record);
    expect(a.relayTo([b.self, host.self], { ch: 'voice', n: 1 })).toBe(true);
    expect(host.relayTo([a.self, c.self], { ch: 'voice', n: 2 })).toBe(true);
    await flush();
    expect(rb.direct).toEqual([{ from: a.self, msg: { ch: 'voice', n: 1 } }]);
    expect(h.direct).toEqual([{ from: a.self, msg: { ch: 'voice', n: 1 } }]);
    expect(ra.direct).toEqual([{ from: host.self, msg: { ch: 'voice', n: 2 } }]);
    expect(rc.direct).toEqual([{ from: host.self, msg: { ch: 'voice', n: 2 } }]);
    // Nothing of it reached the ordinary messages, which trust the host's word.
    for (const r of [h, ra, rb, rc]) expect(r.got).toEqual([]);
    for (const t of [a, b, c, host]) t.close();
  });

  it('cannot be passed off as another sender, and addressees outside the room are skipped', async () => {
    const { opts } = setup();
    const host = await RelayTransport.host('SPOOFS', opts);
    const a = await RelayTransport.join('SPOOFS', opts);
    const b = await RelayTransport.join('SPOOFS', opts);
    await flush();
    const [h, rb] = [host, b].map(record);
    const raw = rawOf(a);
    // A modified browser names someone else as the sender: the relay stamps its own tag over it.
    raw(JSON.stringify({ to: [b.self], d: 'x', f: HOST, r: 1 }));
    raw(JSON.stringify({ to: [b.self], f: HOST, r: 1, d: 'y' }));
    // A plain frame for the host dressed up as a direct one stays a plain message from a.
    raw(JSON.stringify({ d: 'plain', r: 1, f: b.self }));
    // Addressees that are not there, the sender itself, nobody, rubbish: nothing goes anywhere.
    raw(JSON.stringify({ to: ['p999', 'nobody', a.self], d: 'lost' }));
    raw(JSON.stringify({ to: [], d: 'none' }));
    raw(JSON.stringify({ to: [42, null, { x: 1 }], d: 'junk' }));
    await flush();
    expect(rb.direct).toEqual([
      { from: a.self, msg: 'x' },
      { from: a.self, msg: 'y' },
    ]);
    expect(h.got).toEqual([{ from: a.self, msg: 'plain' }]);
    expect(h.direct).toEqual([]);
    for (const t of [a, b, host]) t.close();
  });

  it('are small, whole and limited per socket', async () => {
    const { opts } = setup();
    const host = await RelayTransport.host('LIMITS', opts);
    const a = await RelayTransport.join('LIMITS', opts);
    const b = await RelayTransport.join('LIMITS', opts);
    await flush();
    const rb = record(b);
    const raw = rawOf(a);
    // Too long (the transport itself refuses it, so the caller goes through the host), or in pieces.
    expect(a.relayTo([b.self], 'z'.repeat(DIRECT_MAX))).toBe(false);
    raw(JSON.stringify({ to: [b.self], d: 'z'.repeat(DIRECT_MAX) }));
    raw(JSON.stringify({ to: [b.self], c: 1, i: 0, n: 1, s: '"piece"' }));
    await flush();
    expect(rb.direct).toEqual([]);
    // A flood: the relay passes a burst's worth.
    for (let k = 0; k < 3 * DIRECT_BURST; k++) a.relayTo([b.self], k);
    await flush();
    expect(rb.direct.length).toBe(DIRECT_BURST);
    expect(rb.direct.map((x) => x.msg)).toEqual([...Array(DIRECT_BURST).keys()]);
    for (const t of [a, b, host]) t.close();
  });

  it('an older relay (no protocol 2 in its greeting): relayTo refuses, the old frames still work', async () => {
    const { opts } = setup(true);
    const host = await RelayTransport.host('OLDREL', opts);
    const a = await RelayTransport.join('OLDREL', opts);
    await flush();
    expect([host.direct, a.direct]).toEqual([false, false]);
    expect(a.relayTo([host.self], 'v')).toBe(false);
    expect(host.relayTo([a.self], 'v')).toBe(false);
    const [h, ra] = [host, a].map(record);
    a.send(a.host, 'hello');
    host.send(a.self, 'back');
    await flush();
    expect(h.got).toEqual([{ from: a.self, msg: 'hello' }]);
    expect(ra.got).toEqual([{ from: host.self, msg: 'back' }]);
    for (const t of [a, host]) t.close();
  });
});

describe('transport fallback', () => {
  const fake = (name: string, works: boolean): TransportProvider => ({
    host: async () => {
      if (!works) throw new Error(`${name} down`);
      return { code: name } as unknown as Transport;
    },
    join: async () => {
      if (!works) throw new Error(`${name} down`);
      return { code: name } as unknown as Transport;
    },
  });

  it('uses the relay when it answers, else WebRTC', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await fallbackProvider(fake('relay', true), fake('peer', true)).host()).code).toBe('relay');
    expect((await fallbackProvider(fake('relay', false), fake('peer', true)).host()).code).toBe('peer');
    expect((await fallbackProvider(fake('relay', false), fake('peer', true)).join('ABCDEF')).code).toBe('peer');
    await expect(fallbackProvider(fake('relay', false), fake('peer', false)).join('ABCDEF')).rejects.toThrow('peer down');
    warn.mockRestore();
  });
});
