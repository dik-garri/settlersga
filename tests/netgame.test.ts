import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LoopbackNetwork, VirtualClock, type LinkConditions, type LoopbackTransport } from '../src/net/loopback';
import type { DesyncReport } from '../src/net/lockstep';
import { CHECKSUM_EVERY, NetMatch, replaySums, TURN_TICKS, type MatchEvent } from '../src/net/match';
import { bindLockstep, type LockstepSession } from '../src/net/session';
import { NetStatus } from '../src/net/status';
import { stateChecksum } from '../src/sim/checksum';
import type { Command } from '../src/sim/commands';
import { verifyReplay, replayOf } from '../src/sim/replay';
import type { BuildingType, PlayerId } from '../src/sim/types';
import { World, type WorldOptions } from '../src/sim/world';
import { cleanChat, delayFor, freeSlot, LobbyClient, LobbyHost, lobbyProblem, parseStart, seatsOf } from '../src/ui/lobby';
import { defaultSetup, worldArgs, type GameSetup } from '../src/ui/setup';
import { base } from './helpers';

/** One browser of a network game, headless: its transport, lockstep, match and world. */
interface Peer {
  seat: number;
  transport: LoopbackTransport;
  session: LockstepSession;
  match: NetMatch;
  world: World;
  events: MatchEvent[];
  desync: DesyncReport | null;
  hostLost: boolean;
  /** Left the game (its loop no longer runs). */
  gone: boolean;
}

interface Game {
  clock: VirtualClock;
  net: LoopbackNetwork;
  peers: Peer[];
}

/** A network game of `humans` browsers on a loopback network; everybody builds the same world. */
function netGame(o: { humans: number; seed: number; world: WorldOptions; delay?: number; conditions?: Partial<LinkConditions>; seeds?: number[] }): Game {
  const clock = new VirtualClock();
  const net = new LoopbackNetwork({ scheduler: clock, seed: 5, conditions: o.conditions });
  const host = net.openHost('NETGAM');
  const transports = [host, ...Array.from({ length: o.humans - 1 }, (_, k) => net.connect('NETGAM', `p${k + 2}`))];
  const seats = new Map(transports.map((t, k) => [k + 1, t.self]));
  const peers = transports.map((transport, k) => {
    const world = new World(o.seeds?.[k] ?? o.seed, o.world);
    const p = { seat: k + 1, transport, world, events: [], desync: null, hostLost: false, gone: false } as unknown as Peer;
    p.session = bindLockstep(transport, { seats, delay: o.delay ?? 2, onHostLost: () => (p.hostLost = true) });
    p.match = new NetMatch({ world, lockstep: p.session.lockstep, onDesync: (r) => (p.desync = r), onEvent: (e) => p.events.push(e) });
    world.sendAhead = (cmd) => p.match.queue(cmd);
    return p;
  });
  return { clock, net, peers };
}

/** Lets `ms` of virtual time pass, every browser running its loop every `step` ms. */
function run(g: Game, ms: number, step = 20, each?: (ms: number) => void): void {
  for (let t = 0; t < ms; t += step) {
    g.clock.advance(step);
    for (const p of g.peers) if (!p.gone) p.match.advance(step);
    each?.(t);
  }
}

/** The free spot for a building nearest the player's start (+ an offset). */
function spotFor(w: World, type: BuildingType, dx: number, dy: number, player: PlayerId) {
  const c = base(w, player);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < w.map.h; y++) {
    for (let x = 0; x < w.map.w; x++) {
      if (!w.canPlace(type, x, y, player)) continue;
      const d = (x - c.x - dx) ** 2 + (y - c.y - dy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best!;
}

/**
 * Every browser still playing brought to the tick of the one furthest ahead (the turns it played are
 * sealed and delivered by then), so their whole states can be compared.
 */
function align(g: Game): void {
  g.clock.advance(1_000);
  const live = g.peers.filter((p) => !p.gone);
  const tick = Math.max(...live.map((p) => p.world.tick));
  for (const p of live) for (let guard = 0; p.world.tick < tick && guard < 2_000; guard++) p.match.advance(100, 1);
}

/** The full state checksums of the browsers still playing, at one tick. */
function sums(g: Game): string[] {
  align(g);
  return g.peers.filter((p) => !p.gone).map((p) => `${p.world.tick}:${stateChecksum(p.world)}`);
}
const MIN = 60_000;

describe('network game: lockstep over the world', () => {
  it('three browsers and a computer player play the same game; every order lands everywhere', () => {
    const g = netGame({
      humans: 3,
      seed: 21,
      world: { size: 96, players: 4, ai: [4] },
      delay: 3,
      conditions: { latency: 40, jitter: 40, drop: 0.02, resend: 150 },
    });
    const placed = new Map<number, { x: number; y: number }>();
    run(g, 4 * MIN, 20, (t) => {
      for (const p of g.peers) {
        // Each player orders on its own machine, at its own moments.
        if (t === 8_000 + p.seat * 1_000) {
          const at = spotFor(p.world, 'woodcutter', 4, 1, p.seat);
          placed.set(p.seat, at);
          expect(p.world.issue({ kind: 'placeBuilding', player: p.seat, type: 'woodcutter', x: at.x, y: at.y })).toBe(true);
          // Nothing applied yet: it comes back in a sealed turn.
          expect(p.world.buildingAt(at.x, at.y)).toBeUndefined();
        }
        if (t === 15_000 + p.seat * 700) p.world.issue({ kind: 'orderWorkers', player: p.seat, prof: 'builder', count: 4 + p.seat });
        if (t === 30_000 + p.seat * 300) {
          const b = p.world.buildingAt(placed.get(p.seat)!.x, placed.get(p.seat)!.y)!;
          p.world.issue({ kind: 'setPriority', player: p.seat, id: b.id, on: true });
        }
      }
    });
    const worlds = g.peers.map((p) => p.world);
    expect(worlds[0].tick).toBeGreaterThan(4 * 600 - 60);
    expect(new Set(sums(g)).size).toBe(1);
    expect(g.peers.every((p) => p.desync === null)).toBe(true);
    // Every machine applied the same orders between the same ticks, the computer's too.
    const logs = worlds.map((w) => JSON.stringify(w.commandLog));
    expect(new Set(logs).size).toBe(1);
    expect(worlds[0].commandLog.some((r) => r.ai && r.cmd.player === 4)).toBe(true);
    for (const [seat, at] of placed) {
      for (const w of worlds) {
        const b = w.buildingAt(at.x, at.y)!;
        expect(b.owner).toBe(seat);
        expect(b.type).toBe('woodcutter');
        // (The priority went with the finished site, as in S4; the order itself was applied.)
        expect(w.commandLog.some((r) => r.cmd.kind === 'setPriority' && r.cmd.player === seat && r.cmd.id === b.id)).toBe(true);
        expect(w.players[seat - 1].economy!.orders.builder).toBe(4 + seat);
      }
    }
    // The orders came in as the seat that sent them.
    expect(worlds[0].commandLog.filter((r) => !r.ai).every((r) => r.cmd.kind !== 'placeBuilding' || placed.get(r.cmd.player))).toBe(true);
    // A network game replays from seed, setup and log like any other.
    expect(verifyReplay(replayOf(worlds[1])!).ok).toBe(true);
    // Checksums went round all the time.
    expect(g.peers[1].match.sums.length).toBeGreaterThan(20);
  });

  it('ignores what a batch may not carry and stamps the sender as the player', () => {
    const g = netGame({ humans: 2, seed: 4, world: { size: 64, players: 2 } });
    run(g, 2_000);
    const [a, b] = g.peers;
    const goods = (w: World) => w.stacks.size;
    const before = goods(a.world);
    // Straight into the outbox: a forged player and a grant.
    b.match.queue({ kind: 'grant', player: 2, res: 'plank', n: 50 } as Command);
    b.match.queue({ kind: 'orderWorkers', player: 1, prof: 'digger', count: 9 } as Command);
    b.match.queue({ kind: 'nonsense', player: 2 } as unknown as Command);
    run(g, 3_000);
    for (const p of g.peers) {
      expect(goods(p.world)).toBe(before);
      expect(p.world.players[0].economy!.orders.digger).not.toBe(9);
      expect(p.world.players[1].economy!.orders.digger).toBe(9);
    }
    expect(new Set(sums(g)).size).toBe(1);
  });

  it('a player who leaves is taken over by the computer at one turn on every machine', () => {
    const g = netGame({ humans: 3, seed: 9, world: { size: 96, players: 3 }, conditions: { latency: 30, jitter: 20 } });
    run(g, 20_000);
    const leaver = g.peers[2];
    leaver.transport.close();
    leaver.gone = true;
    run(g, 2 * MIN);
    const stay = g.peers.slice(0, 2);
    for (const p of stay) {
      expect(p.world.aiLevel(3)).toBe('medium');
      expect(p.events.filter((e) => e.kind === 'takeover')).toHaveLength(1);
    }
    expect(stay[0].events.find((e) => e.kind === 'takeover')).toEqual(stay[1].events.find((e) => e.kind === 'takeover'));
    const takeover = (w: World) => w.commandLog.find((r) => r.cmd.kind === 'aiTakeover');
    expect(takeover(stay[0].world)).toEqual(takeover(stay[1].world));
    // The computer plays the seat: it gave orders in the departed player's name.
    expect(stay[0].world.commandLog.some((r) => r.ai && r.cmd.player === 3)).toBe(true);
    expect(new Set(sums(g)).size).toBe(1);
    // The game did not stop for long: it went on to the end at full pace.
    expect(stay[0].world.tick).toBeGreaterThan(((20_000 + 2 * MIN) / 100) * 0.95);
  });

  it('a lost connection (no goodbye) is noticed and handed over the same way', () => {
    const g = netGame({ humans: 2, seed: 9, world: { size: 64, players: 2 } });
    run(g, 5_000);
    g.net.disconnect('p2');
    g.peers[1].gone = true;
    run(g, 10_000);
    expect(g.peers[0].world.aiLevel(2)).toBe('medium');
    expect(g.peers[0].match.waiting).toBe(false);
  });

  it('the host leaving ends the game for the others', () => {
    const g = netGame({ humans: 2, seed: 3, world: { size: 64, players: 2 } });
    run(g, 5_000);
    g.peers[0].transport.close();
    g.peers[0].gone = true;
    run(g, 2_000);
    const c = g.peers[1];
    expect(c.hostLost).toBe(true);
    const tick = c.world.tick;
    run(g, 5_000);
    expect(c.world.tick).toBe(tick);
    expect(c.match.waiting).toBe(true);
  });

  it('finds a forced desync, on every machine, at one turn, and stops', () => {
    const g = netGame({ humans: 2, seed: 6, world: { size: 64, players: 2 }, conditions: { latency: 20 } });
    run(g, 10_000);
    const [a, b] = g.peers;
    expect(a.desync).toBeNull();
    // Something only one machine did.
    b.world.settlers[3].x += 0.001;
    run(g, 5_000);
    expect(a.desync).not.toBeNull();
    expect(b.desync).toEqual(a.desync);
    const r = a.desync!;
    // The sums name the section that differs: the settlers.
    const parts = r.sums.map(([, s]) => String(s).split('.'));
    const differ = parts[0].map((x, k) => x !== parts[1][k]);
    expect(differ[2]).toBe(true); // settlers
    expect(differ[1]).toBe(false); // map layers
    expect(r.agreed).not.toBeNull();
    expect(r.agreed!).toBeLessThan(r.turn);
    expect(a.match.stopped && b.match.stopped).toBe(true);
    const tick = a.world.tick;
    run(g, 2_000);
    expect(a.world.tick).toBe(tick);
    const file = b.match.report();
    expect(file.desync).toEqual(r);
    expect(file.sums.at(-1)!.turn).toBeGreaterThanOrEqual(r.turn);
    expect(file.replay!.log.length).toBe(b.world.commandLog.length);
    // Played again from the commands (tools/replay.ts): the honest machine's sums all match, the
    // other's part at the first checksum after its state went astray, in the settlers.
    expect(replaySums(a.match.report()).every((c) => c.ok)).toBe(true);
    const checks = replaySums(file);
    const bad = checks.find((c) => !c.ok)!;
    expect(bad.turn).toBe(r.turn);
    expect(bad.differ).toContain('settlers');
    expect(checks.filter((c) => c.turn < r.turn).every((c) => c.ok)).toBe(true);
  });

  it('compares the generated worlds before the first turn', () => {
    const g = netGame({ humans: 2, seed: 1, seeds: [1, 2], world: { size: 64, players: 2 } });
    run(g, 1_000);
    expect(g.peers[0].desync?.turn).toBe(-1);
    expect(g.peers[1].desync?.turn).toBe(-1);
  });

  it('pause and speed take effect at one turn everywhere; only the host sets the speed', () => {
    const g = netGame({ humans: 2, seed: 2, world: { size: 64, players: 2 }, conditions: { latency: 25 } });
    run(g, 3_000);
    const [h, c] = g.peers;
    c.match.setPaused(true);
    run(g, 1_000);
    expect(h.match.paused && c.match.paused).toBe(true);
    expect(h.match.pausedBy).toBe(2);
    const stoppedAt = h.world.tick;
    expect(c.world.tick).toBe(stoppedAt);
    run(g, 3_000);
    expect(h.world.tick).toBe(stoppedAt);
    h.match.setPaused(false);
    // A client cannot change the speed: its request does not even leave.
    c.match.setSpeed(4);
    h.match.setSpeed(2);
    run(g, 1_000);
    expect(h.match.paused || c.match.paused).toBe(false);
    expect([h.match.speed, c.match.speed]).toEqual([2, 2]);
    const t0 = h.world.tick;
    run(g, 10_000);
    // About twenty ticks a second now (some lost while the turns caught up).
    expect(h.world.tick - t0).toBeGreaterThan(180);
    expect(new Set(sums(g)).size).toBe(1);
    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toEqual(['pause', 'pause', 'speed']);
    expect(c.events).toEqual(h.events);
  });

  it('a slow machine holds everybody, and the status says who', () => {
    const g = netGame({ humans: 3, seed: 2, world: { size: 64, players: 3 } });
    const statuses = g.peers.map(
      (p) =>
        new NetStatus({
          transport: p.transport,
          seats: new Map(g.peers.map((q) => [q.seat, q.transport.self])),
          local: p.seat,
          host: 1,
          waitingFor: () => p.session.lockstep.waitingFor(),
          now: () => g.clock.now(),
        }),
    );
    run(g, 3_000, 20, () => statuses.forEach((s) => s.update()));
    // Seat 3's browser freezes (a long frame, a hidden tab without a timer).
    g.peers[2].gone = true;
    run(g, 3_000, 20, () => statuses.forEach((s) => s.update()));
    expect(g.peers[0].match.waiting && g.peers[1].match.waiting).toBe(true);
    expect(statuses[0].waiting(true)).toEqual([3]);
    expect(statuses[1].waiting(true)).toEqual([3]);
    expect(statuses[1].ping(2)).not.toBeNull();
    expect(statuses[0].ping(3)).not.toBeNull();
    // Back: it catches up quickly (more than real time per call) and everybody goes on.
    g.peers[2].gone = false;
    run(g, 3_000, 20, () => statuses.forEach((s) => s.update()));
    expect(g.peers.every((p) => !p.match.waiting)).toBe(true);
    expect(Math.abs(g.peers[2].world.tick - g.peers[0].world.tick)).toBeLessThanOrEqual(2 * TURN_TICKS * 3);
  });
});

describe('network game: World.issue sends ahead', () => {
  it('tells the interface the likely outcome and queues a copy', () => {
    const w = new World(3, { size: 64, players: 2 });
    const sent: Command[] = [];
    w.sendAhead = (c) => sent.push(c);
    const at = spotFor(w, 'woodcutter', 4, 0, 1);
    expect(w.issue({ kind: 'placeBuilding', player: 1, type: 'woodcutter', x: at.x, y: at.y })).toBe(true);
    expect(w.issue({ kind: 'placeBuilding', player: 1, type: 'woodcutter', x: 0, y: 0 })).toBe(false);
    const ids = [5, 6, 7];
    expect(w.issue({ kind: 'orderMove', player: 1, ids, x: 3, y: 3 })).toBe(3);
    ids.push(8);
    expect(w.issue({ kind: 'demolish', player: 1, id: 4 })).toBe(true);
    // Malformed: refused at once, nothing sent.
    expect(w.issue({ kind: 'demolish', player: 1, id: 'x' } as never)).toBe(false);
    expect(sent.map((c) => c.kind)).toEqual(['placeBuilding', 'placeBuilding', 'orderMove', 'demolish']);
    expect((sent[2] as { ids: number[] }).ids).toEqual([5, 6, 7]);
    // Nothing happened to the world.
    expect(w.commandLog).toHaveLength(0);
    expect(w.buildingAt(at.x, at.y)).toBeUndefined();
  });

  it('a takeover makes a human player a computer one, once', () => {
    const w = new World(5, { size: 64, players: 2 });
    expect(w.aiLevel(2)).toBeNull();
    expect(w.apply({ kind: 'aiTakeover', player: 2 })).toBe(true);
    expect(w.apply({ kind: 'aiTakeover', player: 2 })).toBe(false);
    expect(w.aiLevel(2)).toBe('medium');
    for (let i = 0; i < 600; i++) w.step();
    expect(w.commandLog.some((r) => r.ai && r.cmd.player === 2)).toBe(true);
  });
});

describe('network lobby', () => {
  const BUILD = 'test.1';
  const lobbyNet = () => {
    const clock = new VirtualClock();
    const net = new LoopbackNetwork({ scheduler: clock, conditions: { latency: 15 } });
    const ht = net.openHost('LOBBY2');
    const setup: GameSetup = { ...defaultSetup(), mode: 'network', size: 64 };
    setup.slots[1].kind = 'remote';
    setup.slots[2] = { ...setup.slots[2], kind: 'ai' };
    const host = new LobbyHost(ht, setup, BUILD, () => clock.now());
    const tick = (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        clock.advance(50);
        host.update();
        for (const c of clients) c.update();
      }
    };
    const clients: LobbyClient[] = [];
    const join = (build = BUILD) => {
      const c = new LobbyClient(net.connect('LOBBY2'), build, () => clock.now());
      clients.push(c);
      return c;
    };
    return { clock, net, host, join, tick };
  };

  it('seats newcomers, shares the setup live, relays chat and starts everybody alike', () => {
    const L = lobbyNet();
    const a = L.join();
    L.tick(200);
    expect(a.slot).toBe(1);
    expect(a.setup?.size).toBe(64);
    expect(L.host.problem()).toMatch(/готов/);
    // A second one opens the first closed slot.
    const b = L.join();
    L.tick(200);
    expect(b.slot).toBe(3);
    expect(L.host.setup.slots[3].kind).toBe('remote');
    // The host edits; everybody sees it.
    L.host.setup.size = 96;
    L.host.setup.start = 'high';
    L.host.changed();
    L.tick(200);
    expect(a.setup?.size).toBe(96);
    expect(b.setup?.start).toBe('high');
    // A player picks its team; chat goes round.
    a.setTeam(3);
    b.say('  привет   всем ');
    L.host.sayOwn('hi');
    L.tick(200);
    expect(L.host.setup.slots[1].team).toBe(3);
    expect(b.setup?.slots[1].team).toBe(3);
    // The host's own line is out at once, the player's comes through the host.
    expect(a.chat).toEqual([
      { slot: 0, text: 'hi' },
      { slot: 3, text: 'привет всем' },
    ]);
    expect(L.host.chat).toEqual(a.chat);
    // Ready flags; pings measured.
    a.setReady(true);
    L.tick(2_500);
    expect(L.host.problem()).toMatch(/готов/);
    b.setReady(true);
    L.tick(2_500);
    expect(L.host.problem()).toBeNull();
    expect(a.members.find((m) => m.slot === 3)?.ready).toBe(true);
    expect(a.members.every((m) => m.ping !== null && m.ping >= 25)).toBe(true);
    expect(a.rtt()).not.toBeNull();
    // Start: every browser gets the same seats and the same world.
    const info = L.host.start(777)!;
    L.tick(200);
    expect(a.started).toEqual(info);
    expect(b.started).toEqual(info);
    expect(info.seed).toBe(777);
    expect(info.seats).toEqual([
      [1, L.host.transport.self],
      [2, a.transport.self],
      [4, b.transport.self],
    ]);
    expect(info.delay).toBe(delayFor(Math.max(...a.members.map((m) => m.ping ?? 0))));
    const worlds = [info, a.started!, b.started!].map((s) => {
      const { seed, opts } = worldArgs(s.setup, 0);
      return new World(seed, opts);
    });
    expect(new Set(worlds.map((w) => stateChecksum(w))).size).toBe(1);
    // Player 3 is the computer on every machine; the humans are 1, 2 and 4.
    expect(worlds[0].ai.map((x) => x.player)).toEqual([3]);
    // Nobody gets in any more.
    const late = L.join();
    L.tick(200);
    expect(late.refused?.why).toBe('started');
  });

  it('refuses another build and a full game, with the reason', () => {
    const L = lobbyNet();
    const old = L.join('other.0');
    L.tick(200);
    expect(old.refused).toEqual({ why: 'version', build: BUILD });
    expect(L.host.members.size).toBe(0);
    L.join();
    L.join();
    L.tick(200);
    const third = L.join();
    L.tick(200);
    expect(third.refused?.why).toBe('full');
  });

  it('a player leaving frees the seat; a kicked one goes; the host changing a seat moves its player', () => {
    const L = lobbyNet();
    const a = L.join();
    const b = L.join();
    L.tick(200);
    a.transport.close();
    L.tick(200);
    expect([...L.host.members.values()].map((m) => m.slot)).toEqual([3]);
    expect(L.host.problem()).toMatch(/заняты/);
    // The host makes b's slot a computer: b moves to the free network slot.
    L.host.setup.slots[3].kind = 'ai';
    L.host.changed();
    L.tick(200);
    expect([...L.host.members.values()].map((m) => m.slot)).toEqual([1]);
    L.host.kick(1);
    L.tick(200);
    expect(L.host.members.size).toBe(0);
    expect(b.hostLost).toBe(true);
  });

  it('pure helpers: delay, chat, seats, start parsing', () => {
    expect(delayFor(0)).toBe(2);
    expect(delayFor(150)).toBe(2);
    expect(delayFor(450)).toBe(3);
    expect(delayFor(5000)).toBe(6);
    expect(cleanChat('  a \n b ')).toBe('a b');
    expect(cleanChat('   ')).toBeNull();
    expect(cleanChat('x'.repeat(500))!.length).toBe(200);
    const s = defaultSetup();
    s.mode = 'network';
    s.slots[1].kind = 'remote';
    s.slots[2].kind = 'ai';
    s.slots[3].kind = 'remote';
    expect([...seatsOf(s)]).toEqual([
      [1, 0],
      [2, 1],
      [4, 3],
    ]);
    expect(freeSlot(s, new Set([1]))).toBe(3);
    expect(freeSlot(s, new Set([1, 3]))).toBeNull();
    expect(lobbyProblem(s, [{ slot: 1, ready: true, ping: 1 }])).toMatch(/заняты/);
    expect(lobbyProblem(s, [{ slot: 1, ready: true, ping: 1 }, { slot: 3, ready: true, ping: null }])).toBeNull();
    expect(parseStart({ setup: s, seed: 5, seats: [[1, 'a'], ['x', 2]], delay: 99 })).toEqual({
      setup: s,
      seed: 5,
      seats: [[1, 'a']],
      delay: 2,
      turnTicks: TURN_TICKS,
      checksumEvery: CHECKSUM_EVERY,
    });
    expect(parseStart({ seed: 5 })).toBeNull();
  });
});

describe('the local player', () => {
  it('the interface asks the game state who plays here, never LOCAL_PLAYER', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk('src/ui');
    files.push('src/main.ts');
    const offenders = files
      .filter((f) => !f.endsWith('state.ts'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, k) => [line, k] as const)
          .filter(([line]) => /\bLOCAL_PLAYER\b/.test(line) && !/^\s*(\/\/|\*)/.test(line))
          .map(([line, k]) => `${f}:${k + 1}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});
