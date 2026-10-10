import { describe, expect, it } from 'vitest';
import { LoopbackNetwork, VirtualClock, type LinkConditions, type LoopbackTransport } from '../src/net/loopback';
import { Lockstep, type DesyncReport, type LockstepMsg, type Turn } from '../src/net/lockstep';
import { bindLockstep, type LockstepSession } from '../src/net/session';
import { CODE_ALPHABET, CODE_LENGTH, normaliseCode, randomCode } from '../src/net/transport';

/** One browser of a simulated network game: a transport, its lockstep and a fake game loop. */
interface Player {
  seat: number;
  transport: LoopbackTransport;
  session: LockstepSession;
  played: Turn[];
  /** What this seat handed in, by turn. */
  sent: Map<number, unknown[]>;
  /** Virtual time of its next turn. */
  nextAt: number;
  stalls: number;
  desync: DesyncReport | null;
  hostLost: boolean;
  left: boolean;
  /** Corrupts this player's checksum from that turn on (a simulated desync). */
  corruptFrom: number;
  /** Running hash of everything played: the stand-in for `stateChecksum(world)`. */
  state: number;
}

const TURN_MS = 100; // e.g. 2 ticks of 50 ms at double speed; the scheduler does not care

function hash(h: number, text: string): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function makeGame(
  n: number,
  opts: { delay?: number; conditions?: Partial<LinkConditions>; seed?: number } = {},
): { clock: VirtualClock; net: LoopbackNetwork; players: Player[] } {
  const clock = new VirtualClock();
  const net = new LoopbackNetwork({ scheduler: clock, seed: opts.seed ?? 7, conditions: opts.conditions });
  const host = net.openHost('ABCDEF');
  const transports = [host, ...Array.from({ length: n - 1 }, (_, k) => net.connect('ABCDEF', `p${k + 2}`))];
  const seats = new Map(transports.map((t, k) => [k + 1, t.self]));
  const players: Player[] = transports.map((transport, k) => {
    const p = {
      seat: k + 1,
      transport,
      played: [],
      sent: new Map(),
      nextAt: 0,
      stalls: 0,
      desync: null,
      hostLost: false,
      left: false,
      corruptFrom: Infinity,
      state: 2166136261,
    } as unknown as Player;
    p.session = bindLockstep(transport, {
      seats,
      delay: opts.delay ?? 3,
      onDesync: (r) => (p.desync = r),
      onHostLost: () => (p.hostLost = true),
    });
    return p;
  });
  return { clock, net, players };
}

/** Some commands a seat issues in a turn (often none), deterministic per seat and turn. */
const commandsFor = (seat: number, turn: number): unknown[] =>
  (seat * 7 + turn) % 3 === 0 ? [] : Array.from({ length: (seat + turn) % 3 }, (_, i) => ({ seat, turn, i }));

/** Advances virtual time, letting every player run its loop every 10 ms. */
function run(game: { clock: VirtualClock; players: Player[] }, ms: number): void {
  for (let t = 0; t < ms; t += 10) {
    game.clock.advance(10);
    const now = game.clock.now();
    for (const p of game.players) {
      if (p.left || p.hostLost || now < p.nextAt) continue;
      const ls = p.session.lockstep;
      if (ls.canSubmit()) {
        const cmds = commandsFor(p.seat, ls.inputTurn);
        p.sent.set(ls.submit(cmds), cmds);
      }
      const turn = ls.next();
      if (!turn) {
        p.stalls++;
        continue;
      }
      p.played.push(turn);
      p.state = hash(p.state, JSON.stringify(turn));
      ls.checksum(turn.turn, turn.turn >= p.corruptFrom ? p.state ^ 1 : p.state);
      p.nextAt += TURN_MS;
    }
  }
}

/** Every player's played turns are the same, up to the shortest of them. */
function expectSameOrder(players: Player[]): number {
  const len = Math.min(...players.map((p) => p.played.length));
  const ref = JSON.stringify(players[0].played.slice(0, len));
  for (const p of players) expect(JSON.stringify(p.played.slice(0, len))).toBe(ref);
  return len;
}

describe('net: room codes', () => {
  it('makes and checks codes', () => {
    let s = 1;
    const code = randomCode(() => ((s = (s * 48271) % 2147483647) / 2147483647));
    expect(code).toHaveLength(CODE_LENGTH);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    expect(normaliseCode(code.toLowerCase().slice(0, 3) + ' - ' + code.slice(3))).toBe(code);
    expect(normaliseCode('ABC')).toBeNull();
    expect(normaliseCode('ABCDE0')).toBeNull(); // 0 is not in the alphabet
  });
});

describe('net: loopback transport', () => {
  it('keeps the order under jitter and losses, and copies payloads as JSON', () => {
    const clock = new VirtualClock();
    const net = new LoopbackNetwork({ scheduler: clock, seed: 3, conditions: { latency: 20, jitter: 80, drop: 0.3, resend: 150 } });
    const host = net.openHost('QQQQQQ');
    const client = net.connect('QQQQQQ', 'c');
    const got: unknown[] = [];
    host.on('message', (from, msg) => {
      expect(from).toBe('c');
      got.push(msg);
    });
    const payload = { n: 0, nested: { a: [1, 2] } };
    for (let n = 0; n < 200; n++) {
      payload.n = n;
      client.send(host.self, payload);
    }
    clock.advance(10_000);
    expect(got.map((m) => (m as { n: number }).n)).toEqual(Array.from({ length: 200 }, (_, n) => n));
    expect(got[0]).not.toBe(payload);
  });

  it('is a star: the host sees every client, a client only the host', () => {
    const net = new LoopbackNetwork({ scheduler: new VirtualClock() });
    const host = net.openHost('STARRR');
    const a = net.connect('STARRR', 'a');
    const b = net.connect('STARRR', 'b');
    expect(host.peers().sort()).toEqual(['a', 'b']);
    expect(a.peers()).toEqual([host.self]);
    expect(b.isHost).toBe(false);
    expect(() => net.connect('NOSUCH')).toThrow();
  });

  it('reports leaves: a goodbye after the messages in flight, a lost peer at once, a kick', () => {
    const clock = new VirtualClock();
    const net = new LoopbackNetwork({ scheduler: clock, conditions: { latency: 50 } });
    const host = net.openHost('LEAVES');
    const a = net.connect('LEAVES', 'a');
    const b = net.connect('LEAVES', 'b');
    const c = net.connect('LEAVES', 'c');
    const log: string[] = [];
    host.on('message', (from, m) => log.push(`${from}:${String(m)}`));
    host.on('leave', (p, why) => log.push(`${p} left ${why}`));
    let kicked = '';
    c.on('leave', (p, why) => (kicked = `${p} ${why}`));
    a.send(host.self, 'last words');
    a.close();
    net.disconnect('b');
    host.kick('c');
    clock.advance(200);
    expect(log).toEqual(['b left lost', 'c left kicked', 'a:last words', 'a left closed']);
    expect(kicked).toBe(`${host.self} kicked`);
    expect(host.peers()).toEqual([]);
  });
});

describe('net: lockstep', () => {
  it('rejects a bad set-up and batches too far ahead', () => {
    const send = () => {};
    expect(() => new Lockstep({ seats: [1, 2], local: 1, host: 1, delay: 0, send })).toThrow();
    expect(() => new Lockstep({ seats: [1, 2], local: 3, host: 1, delay: 2, send })).toThrow();
    const ls = new Lockstep({ seats: [1], local: 1, host: 1, delay: 2, send });
    expect(ls.submit([])).toBe(2);
    expect(ls.canSubmit()).toBe(false);
    expect(() => ls.submit([])).toThrow();
    // The first `delay` turns are sealed and empty for everyone.
    expect(ls.next()).toEqual({ turn: 0, inputs: [{ seat: 1, cmds: [] }], dropped: [] });
    expect(ls.submit(['x'])).toBe(3);
  });

  it('host ignores late and duplicate batches, and batches from strangers', () => {
    const out: LockstepMsg[] = [];
    const ls = new Lockstep({ seats: [1, 2], local: 1, host: 1, delay: 1, send: (_to, m) => out.push(m) });
    ls.receive(2, { k: 'in', turn: 1, cmds: ['a'] });
    ls.receive(2, { k: 'in', turn: 1, cmds: ['dup'] });
    ls.receive(3, { k: 'in', turn: 1, cmds: ['stranger'] });
    expect(ls.waitingFor()).toEqual([]); // turn 0 is sealed already
    ls.next();
    expect(ls.waitingFor()).toEqual([1]);
    ls.submit(['h']);
    expect(ls.next()).toEqual({ turn: 1, inputs: [{ seat: 1, cmds: ['h'] }, { seat: 2, cmds: ['a'] }], dropped: [] });
    ls.receive(2, { k: 'in', turn: 1, cmds: ['late'] });
    expect(out.filter((m) => m.k === 'turn')).toHaveLength(1);
  });

  for (const n of [2, 3, 4]) {
    it(`${n} peers with latency and jitter play the same turns in the same order`, () => {
      const game = makeGame(n, { delay: 3, conditions: { latency: 40, jitter: 60 }, seed: n });
      run(game, 30_000);
      const len = expectSameOrder(game.players);
      expect(len).toBeGreaterThan(200);
      // Every turn holds every seat's batch, sorted by seat, exactly as that seat handed it in.
      for (const turn of game.players[0].played) {
        expect(turn.inputs.map((x) => x.seat)).toEqual(Array.from({ length: n }, (_, k) => k + 1));
        for (const x of turn.inputs) {
          const sent = game.players[x.seat - 1].sent.get(turn.turn);
          expect(x.cmds).toEqual(turn.turn < 3 ? [] : sent);
        }
      }
      for (const p of game.players) expect(p.desync).toBeNull();
    });
  }

  it('keeps the order with lost packets resent (head-of-line delays)', () => {
    const game = makeGame(3, { delay: 2, conditions: { latency: 30, jitter: 30, drop: 0.2, resend: 250 }, seed: 11 });
    run(game, 30_000);
    expect(expectSameOrder(game.players)).toBeGreaterThan(100);
  });

  it('enough input delay hides the latency; too little stalls', () => {
    const smooth = makeGame(3, { delay: 4, conditions: { latency: 60, jitter: 20 } });
    run(smooth, 20_000);
    const tight = makeGame(3, { delay: 1, conditions: { latency: 60, jitter: 20 } });
    run(tight, 20_000);
    expectSameOrder(smooth.players);
    expectSameOrder(tight.players);
    const stalls = (g: { players: Player[] }) => g.players.reduce((s, p) => s + p.stalls, 0);
    // Round trip client → host → client ≈ 140 ms against a 400 ms window: practically no stalls.
    expect(stalls(smooth)).toBeLessThan(10);
    // (The loop then catches up, as the game's accumulator does, so both end at the same turn.)
    expect(stalls(tight)).toBeGreaterThan(stalls(smooth) + 100);
  });

  it('a slow peer stalls everyone, and the host knows whom it waits for', () => {
    const game = makeGame(3, { delay: 2, conditions: { latency: 10 } });
    game.net.setPeerConditions('p3', { latency: 400 });
    const waited = new Set<number>();
    for (let k = 0; k < 200; k++) {
      run(game, 50);
      for (const s of game.players[0].session.lockstep.waitingFor()) waited.add(s);
    }
    expectSameOrder(game.players);
    expect(waited.has(3)).toBe(true);
    expect(waited.has(2)).toBe(false);
    // 10 s at 100 ms a turn would be 100 turns; the slow seat's 800 ms round trip holds everyone back.
    for (const p of game.players) expect(p.played.length).toBeLessThan(40);
    // Everyone is held back alike: nobody runs ahead of the others by more than the pipeline.
    const counts = game.players.map((p) => p.played.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(game.players[0].session.lockstep.delay + 1);
  });

  it('a peer that leaves is dropped from a turn everyone agrees on, and the rest play on', () => {
    const game = makeGame(4, { delay: 3, conditions: { latency: 30, jitter: 30 } });
    run(game, 5_000);
    game.players[2].left = true;
    game.net.disconnect('p3');
    run(game, 10_000);
    const rest = game.players.filter((p) => !p.left);
    const len = expectSameOrder(rest);
    const turns = rest[0].played.slice(0, len);
    const at = turns.findIndex((t) => t.dropped.length > 0);
    expect(at).toBeGreaterThan(0);
    expect(turns[at].dropped).toEqual([3]);
    expect(turns.filter((t) => t.dropped.length > 0)).toHaveLength(1);
    for (const t of turns.slice(at)) expect(t.inputs.map((x) => x.seat)).toEqual([1, 2, 4]);
    for (const t of turns.slice(0, at)) expect(t.inputs.map((x) => x.seat)).toEqual([1, 2, 3, 4]);
    expect(game.players[0].session.lockstep.activeSeats()).toEqual([1, 2, 4]);
    // No stall for long after the drop: the game went on at full pace.
    expect(turns.length - at).toBeGreaterThan(80);
  });

  it('a client that quits cleanly is dropped too; the host quitting ends the game for the clients', () => {
    const game = makeGame(3, { delay: 2, conditions: { latency: 20 } });
    run(game, 2_000);
    game.players[1].left = true;
    game.players[1].transport.close();
    run(game, 2_000);
    expect(game.players[0].session.lockstep.activeSeats()).toEqual([1, 3]);
    game.players[0].left = true;
    game.players[0].transport.close();
    run(game, 1_000);
    expect(game.players[2].hostLost).toBe(true);
    expect(game.players[1].hostLost).toBe(false); // it had left already
  });

  it('a checksum mismatch is reported once, on every peer, with the turn and the sums', () => {
    const game = makeGame(3, { delay: 2, conditions: { latency: 25, jitter: 25 } });
    game.players[1].corruptFrom = 40;
    run(game, 15_000);
    for (const p of game.players) {
      expect(p.desync).not.toBeNull();
      expect(p.desync!.turn).toBe(40);
      expect(p.desync!.sums.map(([s]) => s)).toContain(2);
      expect(new Set(p.desync!.sums.map(([, v]) => v)).size).toBeGreaterThan(1);
    }
    expect(JSON.stringify(game.players[2].desync)).toBe(JSON.stringify(game.players[0].desync));
  });

  it('agreeing checksums are forgotten, so the host keeps no history', () => {
    const game = makeGame(2, { delay: 2, conditions: { latency: 10 } });
    run(game, 20_000);
    expect(game.players[0].desync).toBeNull();
    const sums = (game.players[0].session.lockstep as unknown as { sums: Map<number, unknown> }).sums;
    expect(sums.size).toBeLessThan(5);
  });
});
