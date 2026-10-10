import { describe, expect, it } from 'vitest';
import { CHAT_BURST, type NetChatLine } from '../src/net/chat';
import { applySeatControls, NetCore, type NetStartBase, type SeatControlKind } from '../src/net/core';
import { DelayTuner, delayFor } from '../src/net/delay';
import { Lockstep, type LockstepMsg } from '../src/net/lockstep';
import { LoopbackNetwork, VirtualClock, type LinkConditions, type LoopbackTransport } from '../src/net/loopback';
import { SAVE_EVERY_TICKS, type MatchEvent, type NetSave } from '../src/net/match';
import { stateChecksum } from '../src/sim/checksum';
import type { SaveData } from '../src/sim/save';
import type { BuildingType, PlayerId } from '../src/sim/types';
import { World, type WorldOptions } from '../src/sim/world';
import { LobbyClient, LobbyHost, type StartInfo } from '../src/ui/lobby';
import { SaveSlots, type KeyValue } from '../src/ui/saves';
import { defaultSetup, type GameSetup } from '../src/ui/setup';
import { base } from './helpers';

/**
 * Network games 6.6–6.7 headless: the chat, network saves and loading them, a player dropping and
 * coming back, the adaptive input delay, duplicate and late messages. Every browser is a `NetCore`
 * (what `ui/netGame.ts` wraps) on a loopback network with a virtual clock.
 */

const BUILD = 'dev';

interface Peer {
  seat: number;
  transport: LoopbackTransport;
  core: NetCore;
  world: World;
  events: MatchEvent[];
  chat: NetChatLine[];
  asked: number[];
  hostLost: boolean;
  gone: boolean;
}

interface Game {
  clock: VirtualClock;
  net: LoopbackNetwork;
  peers: Peer[];
  start: NetStartBase;
  /** Lobby clients being driven by `run` (a returning browser before its game starts). */
  lobbies: LobbyClient[];
}

interface GameOpts {
  humans: number;
  seed: number;
  world: WorldOptions;
  delay?: number;
  conditions?: Partial<LinkConditions>;
  /** The worlds every browser starts from (a loaded save); default: generated. */
  data?: SaveData;
  control?: [number, SeatControlKind][];
  chat?: NetChatLine[];
  tuneDelay?: boolean;
  code?: string;
}

function makePeer(g: Game, transport: LoopbackTransport, seat: number, world: World, extra: Partial<ConstructorParameters<typeof NetCore>[0]> = {}): Peer {
  const p = { seat, transport, world, events: [], chat: [], asked: [], hostLost: false, gone: false } as unknown as Peer;
  p.core = new NetCore({
    world,
    transport,
    start: g.start,
    build: BUILD,
    now: () => g.clock.now(),
    tuneDelay: extra.tuneDelay ?? false,
    ...extra,
    hooks: {
      event: (e) => p.events.push(e),
      chat: (l) => p.chat.push(l),
      hostLost: () => (p.hostLost = true),
      rejoinAsked: (s) => p.asked.push(s),
    },
  });
  return p;
}

function coreGame(o: GameOpts): Game {
  const clock = new VirtualClock();
  const net = new LoopbackNetwork({ scheduler: clock, seed: 7, conditions: o.conditions });
  const code = o.code ?? 'CORE22';
  const host = net.openHost(code);
  const transports = [host, ...Array.from({ length: o.humans - 1 }, (_, k) => net.connect(code, `p${k + 2}`))];
  // What the lobby would have sent (a returning browser gets it again, so it carries a setup).
  const setup: GameSetup = { ...defaultSetup(), mode: 'network', seed: o.seed };
  const start: StartInfo = { setup, seed: o.seed, seats: transports.map((t, k) => [k + 1, t.self]), delay: o.delay ?? 2, turnTicks: 2, checksumEvery: 5 };
  const g: Game = { clock, net, peers: [], start, lobbies: [] };
  g.peers = transports.map((t, k) => {
    const world = o.data ? World.load(o.data) : new World(o.seed, o.world);
    if (o.control) applySeatControls(world, o.control);
    return makePeer(g, t, k + 1, world, { tuneDelay: o.tuneDelay ?? false, chat: o.chat, humanSeats: o.control?.map(([s]) => s) });
  });
  return g;
}

function run(g: Game, ms: number, step = 20, each?: (t: number) => void): void {
  for (let t = 0; t < ms; t += step) {
    g.clock.advance(step);
    for (const p of g.peers) if (!p.gone) p.core.pump(step, p.core.catchingUp ? 400 : 20);
    for (const l of g.lobbies) l.update();
    each?.(t);
  }
}

/** Every browser still playing brought to the tick of the one furthest ahead. */
function align(g: Game): void {
  g.clock.advance(1_000);
  const live = g.peers.filter((p) => !p.gone);
  const tick = Math.max(...live.map((p) => p.world.tick));
  for (const p of live) for (let guard = 0; p.world.tick < tick && guard < 4_000; guard++) p.core.match.advance(100, 1);
}

function sums(g: Game): string[] {
  align(g);
  return g.peers.filter((p) => !p.gone).map((p) => `${p.world.tick}:${stateChecksum(p.world)}`);
}

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

/** Runs until `done` (at most `ms`). */
function until(g: Game, done: () => boolean, ms = 20_000): void {
  for (let t = 0; t < ms && !done(); t += 20) run(g, 20);
  expect(done()).toBe(true);
}

const saves = (p: Peer) => p.events.filter((e): e is { kind: 'save'; save: NetSave } => e.kind === 'save').map((e) => e.save);

/** A localStorage stand-in. */
class MemoryStore implements KeyValue {
  readonly m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe('network chat (6.6)', () => {
  it('goes to everybody or to the allies only, through the host, rate-limited, with the lobby history', () => {
    const lobby: NetChatLine[] = [{ seat: 2, text: 'gl hf', to: 'all', lobby: true }];
    const g = coreGame({ humans: 3, seed: 3, world: { size: 64, players: 3, teams: [1, 1, 2] }, conditions: { latency: 30, jitter: 20, drop: 0.05 }, chat: lobby });
    const [a, b, c] = g.peers;
    run(g, 1_000);
    expect(a.core.chat.lines).toEqual(lobby);
    expect(a.core.say('  привет   всем ', 'all')).toBe('ok');
    expect(b.core.say('за мной', 'allies')).toBe('ok');
    expect(c.core.say('   ', 'all')).toBe('empty');
    run(g, 1_000);
    const texts = (p: Peer) => p.chat.map((l) => `${l.seat}:${l.to}:${l.text}`);
    expect(texts(a)).toEqual(['1:all:привет всем', '2:allies:за мной']);
    expect(texts(b)).toEqual(['1:all:привет всем', '2:allies:за мной']);
    // Player 3 is on the other team: the allies' line never reaches his browser.
    expect(texts(c)).toEqual(['1:all:привет всем']);
    // Flooding: the browser itself refuses after the burst…
    const said = Array.from({ length: 10 }, (_, k) => c.core.say(`spam ${k}`, 'all'));
    expect(said.filter((r) => r === 'ok')).toHaveLength(CHAT_BURST);
    expect(said.at(-1)).toBe('tooFast');
    run(g, 1_000);
    expect(a.chat.filter((l) => l.seat === 3)).toHaveLength(CHAT_BURST);
    // …and the host drops what a modified browser would send past it.
    for (let k = 0; k < 10; k++) c.transport.send(c.transport.host, { ch: 'chat', to: 'all', text: `raw ${k}` });
    run(g, 1_000);
    expect(a.chat.filter((l) => l.text.startsWith('raw')).length).toBeLessThanOrEqual(1);
    // A player cannot speak for another seat.
    c.transport.send(c.transport.host, { ch: 'chat', to: 'all', text: 'fake', seat: 1 });
    run(g, 3_000);
    expect(a.chat.filter((l) => l.text === 'fake').every((l) => l.seat === 3)).toBe(true);
    // The chat changed nothing in the game.
    expect(new Set(sums(g)).size).toBe(1);
  });
});

describe('network saves (6.6)', () => {
  it('a save request is a common event: every browser takes the same save at the same tick, once a minute', () => {
    const g = coreGame({ humans: 3, seed: 8, world: { size: 64, players: 3, ai: [] }, conditions: { latency: 40, jitter: 30, drop: 0.02 } });
    const [a, b, c] = g.peers;
    run(g, 20_000);
    b.core.requestSave('Вечерняя партия');
    c.core.requestSave('second');
    run(g, 2_000);
    const got = g.peers.map(saves);
    expect(got.map((s) => s.length)).toEqual([1, 1, 1]);
    const [s0, s1, s2] = got.map((s) => s[0]);
    expect(s0.seat).toBe(2);
    expect(s0.name).toBe('Вечерняя партия');
    expect(new Set([s0.tick, s1.tick, s2.tick]).size).toBe(1);
    expect(new Set([s0.sum, s1.sum, s2.sum]).size).toBe(1);
    expect(JSON.stringify(s1.data)).toBe(JSON.stringify(s0.data));
    expect(JSON.stringify(s2.data)).toBe(JSON.stringify(s0.data));
    // The second request in the same minute is refused everywhere, alike.
    const refused = (p: Peer) => p.events.filter((e) => e.kind === 'saveRefused');
    expect(refused(a)).toHaveLength(1);
    expect(refused(b)).toEqual(refused(a));
    // A minute of game time later it is allowed again.
    a.core.requestSave('later');
    run(g, 1_000);
    expect(saves(a)).toHaveLength(1);
    run(g, (SAVE_EVERY_TICKS / 10) * 1000);
    a.core.requestSave('later');
    run(g, 1_000);
    expect(g.peers.map((p) => saves(p).length)).toEqual([2, 2, 2]);
    // The save holds the world as it was: loading it gives the same checksum everywhere.
    const loaded = World.load(s0.data);
    expect(stateChecksum(loaded)).toBe(stateChecksum(World.load(s2.data)));
    expect(new Set(sums(g)).size).toBe(1);
  });

  it('the autosave is a network save at a common turn too', () => {
    const g = coreGame({ humans: 2, seed: 2, world: { size: 64, players: 2 } });
    for (const p of g.peers) p.core.dispose();
    g.peers = g.peers.map((p) => makePeer(g, p.transport, p.seat, new World(2, { size: 64, players: 2 }), { autosaveEvery: 300 }));
    run(g, 70_000);
    const [x, y] = g.peers.map((p) => saves(p).filter((s) => s.auto));
    expect(x.length).toBeGreaterThanOrEqual(2);
    expect(y.map((s) => `${s.tick}:${s.sum}`)).toEqual(x.map((s) => `${s.tick}:${s.sum}`));
  });

  it('a loaded network save continues identically on every browser (and as the game would have gone on)', () => {
    const first = coreGame({ humans: 2, seed: 12, world: { size: 64, players: 3, ai: [3] }, conditions: { latency: 25 } });
    run(first, 30_000);
    first.peers[1].core.requestSave('to load');
    run(first, 1_000);
    const save = saves(first.peers[0])[0];
    // Three browsers load it in a new room; seat 3, the computer's, stays the computer's.
    const g = coreGame({
      humans: 2,
      seed: 0,
      world: {},
      data: save.data,
      control: [
        [1, 'human'],
        [2, 'human'],
      ],
      conditions: { latency: 35, jitter: 25, drop: 0.02 },
      code: 'LOAD22',
    });
    expect(g.peers.every((p) => p.world.tick === save.tick)).toBe(true);
    run(g, 60_000);
    expect(g.peers.every((p) => p.core.session.lockstep.desync === null)).toBe(true);
    const all = sums(g);
    expect(new Set(all).size).toBe(1);
    // Nobody gave an order: the same as the saved world simply played on, on one machine.
    const solo = World.load(save.data);
    const tick = g.peers[0].world.tick;
    while (solo.tick < tick) solo.step();
    expect(`${solo.tick}:${stateChecksum(solo)}`).toBe(all[0]);
  });

  it('loads in the lobby: the host sends the save to a player who lacks it, seats without a player go to the computer', async () => {
    // A network game of two humans and a computer is saved (both browsers write the same save).
    const first = coreGame({ humans: 3, seed: 5, world: { size: 64, players: 3 }, conditions: { latency: 20 } });
    run(first, 15_000);
    first.peers[0].core.requestSave('lobby load');
    run(first, 1_000);
    const s = saves(first.peers[0])[0];
    const hostStore = new MemoryStore();
    const hostSlots = new SaveSlots(hostStore);
    const setup: GameSetup = { ...defaultSetup(), mode: 'network', size: 64, seed: 5 };
    setup.slots[1].kind = 'remote';
    setup.slots[2].kind = 'remote';
    setup.slots[3].kind = 'closed';
    const meta = await hostSlots.write(s.data, s.name, 1, undefined, {
      net: { id: `CORE22-${s.tick}`, sum: s.sum, setup, local: 1, host: 1, turn: s.turn, speed: 1 },
    });
    expect(meta?.net?.id).toBe(`CORE22-${s.tick}`);
    // A new room: the host loads the save; one friend joins (without the save), seat 3 goes to the computer.
    const clock = new VirtualClock();
    const net = new LoopbackNetwork({ scheduler: clock, conditions: { latency: 15 } });
    const ht = net.openHost('LOBBY3');
    const host = new LobbyHost(ht, { ...defaultSetup(), mode: 'network' }, BUILD, () => clock.now(), hostSlots);
    expect(host.loadSave(hostSlots.netSaves()[0])).toBe(true);
    expect(host.setup.seed).toBe(5);
    const friendSlots = new SaveSlots(new MemoryStore());
    const friend = new LobbyClient(net.connect('LOBBY3', 'f1'), BUILD, () => clock.now(), { slots: friendSlots });
    const tick = (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        clock.advance(50);
        host.update();
        friend.update();
      }
    };
    tick(500);
    expect(friend.slot).toBe(1);
    expect(friend.load?.id).toBe(`CORE22-${s.tick}`);
    expect(host.problem()).toMatch(/заняты|готов|сохранен/);
    host.setSeat(2, 'ai');
    friend.setReady(true);
    tick(3_000);
    // The save came over in pieces and is the friend's network save now.
    expect(friendSlots.findNet(`CORE22-${s.tick}`, s.sum)).not.toBeNull();
    expect(host.memberList()[0].has).toBe(true);
    expect(host.problem()).toBeNull();
    const info = host.start(1)!;
    tick(300);
    expect(friend.started).toEqual(info);
    expect(info.load?.control).toEqual([
      [1, 'human'],
      [2, 'human'],
      [3, 'ai'],
    ]);
    // Every browser reads its own copy and plays on.
    const fromSlots = async (slots: SaveSlots, i: StartInfo) => slots.read(slots.findNet(i.load!.id, i.load!.sum)!.id);
    const dataHost = (await fromSlots(hostSlots, info))!;
    const dataFriend = (await fromSlots(friendSlots, friend.started!))!;
    expect(JSON.stringify(dataFriend)).toBe(JSON.stringify(dataHost));
    host.dispose();
    friend.dispose();
    const g: Game = { clock, net, peers: [], start: info, lobbies: [] };
    const worldOf = (d: SaveData) => {
      const w = World.load(d);
      applySeatControls(w, info.load!.control);
      return w;
    };
    g.peers = [makePeer(g, ht, 1, worldOf(dataHost)), makePeer(g, friend.transport, 2, worldOf(dataFriend))];
    expect(g.peers[0].world.aiLevel(3)).toBe('medium');
    run(g, 30_000);
    expect(new Set(sums(g)).size).toBe(1);
    expect(g.peers[1].world.commandLog.some((r) => r.ai && r.cmd.player === 3)).toBe(true);
  });
});

describe('reconnect (6.7)', () => {
  /** A browser that lost its game comes back with the code: lobby → seat → snapshot → its game. */
  function rejoin(g: Game, name: string, seat: number, accept = true): Peer {
    const t = g.net.connect('CORE22', name);
    const lc = new LobbyClient(t, BUILD, () => g.clock.now(), { seat });
    g.lobbies.push(lc);
    const host = g.peers[0];
    until(g, () => lc.ingame !== null);
    expect(lc.ingame!.vacant).toContain(seat);
    const asked = host.asked.length;
    lc.rejoin(seat);
    until(g, () => host.asked.length > asked && host.asked.at(-1) === seat);
    if (!accept) {
      host.core.refuseRejoin(seat);
      until(g, () => lc.refused !== null);
      g.lobbies = [];
      return null as unknown as Peer;
    }
    expect(host.core.acceptRejoin(seat)).toBe(true);
    until(g, () => lc.resumed !== null);
    const r = lc.resumed!;
    lc.dispose();
    g.lobbies = [];
    const world = World.load(r.data);
    return makePeer(g, t, seat, world, { start: r.start, resume: r.resume, chat: r.chat } as never);
  }

  it('a dropped player comes back: the computer gave the seat back at one turn, every machine identical', () => {
    const g = coreGame({ humans: 3, seed: 9, world: { size: 64, players: 3 }, conditions: { latency: 30, jitter: 30, drop: 0.03 } });
    run(g, 8_000);
    const [h, b, c] = g.peers;
    // Player 2 builds something, then his connection breaks.
    const at = spotFor(b.world, 'woodcutter', 4, 1, 2);
    b.world.issue({ kind: 'placeBuilding', player: 2, type: 'woodcutter', x: at.x, y: at.y });
    h.core.say('wait for him', 'all');
    run(g, 3_000);
    g.net.disconnect('p2');
    b.gone = true;
    run(g, 20_000);
    expect(h.world.aiLevel(2)).toBe('medium');
    expect(c.world.aiLevel(2)).toBe('medium');
    // The computer plays the seat meanwhile.
    expect(h.world.commandLog.some((r) => r.ai && r.cmd.player === 2)).toBe(true);
    // He comes back with the code (a reloaded tab is a new peer).
    const back = rejoin(g, 'p2-again', 2);
    g.peers[1] = back;
    expect(back.core.chat.lines.some((l) => l.text === 'wait for him')).toBe(true);
    run(g, 20_000);
    // Every machine — his included — gave the seat back at the same turn.
    for (const p of g.peers) expect(p.world.aiLevel(2)).toBeNull();
    const rejoinAt = (p: Peer) => p.events.find((e) => e.kind === 'rejoin');
    expect(rejoinAt(h)).toEqual(rejoinAt(c));
    expect(rejoinAt(back)).toEqual(rejoinAt(h));
    const release = (w: World) => w.commandLog.find((r) => r.cmd.kind === 'seatControl');
    expect(release(h.world)).toEqual(release(c.world));
    // From then on the computer gives no more orders for seat 2.
    const releasedAt = release(h.world)!.tick;
    expect(h.world.commandLog.some((r) => r.ai && r.cmd.player === 2 && r.tick > releasedAt)).toBe(false);
    expect(new Set(sums(g)).size).toBe(1);
    // He plays again: his order lands everywhere.
    const at2 = spotFor(back.world, 'forester', -4, 2, 2);
    expect(back.world.issue({ kind: 'placeBuilding', player: 2, type: 'forester', x: at2.x, y: at2.y })).toBe(true);
    run(g, 5_000);
    for (const p of g.peers) expect(p.world.buildingAt(at2.x, at2.y)?.owner).toBe(2);
    expect(new Set(sums(g)).size).toBe(1);
  });

  it('a reloaded tab (goodbye, then back at once) takes its seat back from the computer; the host may refuse', () => {
    const g = coreGame({ humans: 2, seed: 4, world: { size: 64, players: 2 }, conditions: { latency: 20, jitter: 10 } });
    run(g, 6_000);
    g.peers[1].transport.close();
    g.peers[1].gone = true;
    run(g, 2_000);
    expect(g.peers[0].world.aiLevel(2)).toBe('medium');
    // A stranger with another build is turned away at the door.
    const odd = new LobbyClient(g.net.connect('CORE22', 'odd'), 'other', () => g.clock.now());
    run(g, 500);
    expect(odd.refused?.why).toBe('version');
    // First the host says no: the seat stays with the computer.
    rejoin(g, 'p2-x', 2, false);
    run(g, 2_000);
    expect(g.peers[0].world.aiLevel(2)).toBe('medium');
    // Then yes.
    g.peers[1] = rejoin(g, 'p2-y', 2);
    run(g, 15_000);
    expect(g.peers.map((p) => p.world.aiLevel(2))).toEqual([null, null]);
    expect(new Set(sums(g)).size).toBe(1);
    // The game went on all the while (the host waited only while the snapshot travelled).
    expect(g.peers[0].world.tick).toBeGreaterThan(220);
  });

  it('a browser cut off for a moment catches up from the host\'s history without real time', () => {
    const g = coreGame({ humans: 2, seed: 6, world: { size: 64, players: 2 }, conditions: { latency: 20 } });
    run(g, 3_000);
    const [h, c] = g.peers;
    // The client's tab freezes for 15 s while the host keeps sealing nothing (it waits for it)…
    c.gone = true;
    run(g, 15_000);
    expect(h.core.match.waiting).toBe(true);
    c.gone = false;
    // …and every turn it missed sealed in the meantime would come again if asked.
    run(g, 3_000);
    expect(Math.abs(h.world.tick - c.world.tick)).toBeLessThanOrEqual(12);
    expect(new Set(sums(g)).size).toBe(1);
  });
});

describe('adaptive input delay (6.7)', () => {
  it('the host lengthens the delay when the link gets slow and shortens it when it gets fast; all stay identical', () => {
    const g = coreGame({ humans: 3, seed: 10, world: { size: 64, players: 3 }, conditions: { latency: 10 }, delay: 2, tuneDelay: true });
    run(g, 5_000);
    const [h] = g.peers;
    expect(h.core.session.lockstep.delay).toBe(2);
    // A slow link: about 600 ms round trips.
    g.net.setConditions({ latency: 300, jitter: 20 });
    let stalled = 0;
    run(g, 20_000, 20, () => {
      if (h.core.match.waiting) stalled++;
    });
    const up = h.core.session.lockstep.delay;
    expect(up).toBeGreaterThanOrEqual(delayFor(600));
    // Every machine runs on the same delay, changed at the same turn.
    const changes = (p: Peer) => p.events.filter((e) => e.kind === 'delay');
    for (const p of g.peers) {
      expect(p.core.session.lockstep.delay).toBe(up);
      expect(changes(p)).toEqual(changes(h));
    }
    // Once adapted it seldom stalls: in the last 10 s the game ran most of the time.
    stalled = 0;
    run(g, 10_000, 20, () => {
      if (h.core.match.waiting) stalled++;
    });
    expect(stalled).toBeLessThan(100);
    // Fast again: back down, one turn at a time.
    g.net.setConditions({ latency: 10, jitter: 0 });
    run(g, 60_000);
    expect(h.core.session.lockstep.delay).toBe(2);
    expect(changes(g.peers[2])).toEqual(changes(h));
    expect(changes(h).length).toBeGreaterThanOrEqual(3);
    expect(new Set(sums(g)).size).toBe(1);
    const logs = g.peers.map((p) => JSON.stringify(p.world.commandLog));
    expect(new Set(logs).size).toBe(1);
  });

  it('the tuner: up at once, down only after a quiet spell, one change at a time', () => {
    const t = new DelayTuner({ downAfter: 5_000 });
    expect(t.update(0, 50, 2, 1)).toBeNull();
    expect(t.update(1_000, 700, 2, 1)).toBe(4);
    // Not in force yet: nothing new.
    expect(t.update(2_000, 900, 2, 1)).toBeNull();
    expect(t.update(3_000, 900, 4, 1)).toBe(5);
    expect(t.update(4_000, 20, 5, 1)).toBeNull();
    expect(t.update(8_000, 20, 5, 1)).toBeNull();
    expect(t.update(9_100, 20, 5, 1)).toBe(4);
    // At ×2 a turn is half as long: the same round trip needs twice the turns.
    expect(delayFor(500, 2, 2)).toBe(2 * delayFor(500, 2, 1));
  });
});

describe('robustness (6.7)', () => {
  it('duplicate and late messages change nothing', () => {
    const g = coreGame({ humans: 3, seed: 11, world: { size: 64, players: 3 }, conditions: { latency: 25, jitter: 25 } });
    // Every message on every link goes twice.
    for (const p of g.peers) {
      const send = p.transport.send.bind(p.transport);
      p.transport.send = (to, msg) => {
        send(to, msg);
        send(to, msg);
      };
    }
    run(g, 15_000, 20, (t) => {
      if (t === 4_000) g.peers[1].world.issue({ kind: 'orderWorkers', player: 2, prof: 'builder', count: 7 });
    });
    for (const p of g.peers) expect(p.world.players[1].economy!.orders.builder).toBe(7);
    // The order came in once, not twice.
    expect(g.peers[0].world.commandLog.filter((r) => r.cmd.kind === 'orderWorkers')).toHaveLength(1);
    expect(new Set(sums(g)).size).toBe(1);
  });

  it('the lockstep ignores turns played already or twice, and resends what it sealed when asked', () => {
    const toClient: LockstepMsg[] = [];
    const toHost: LockstepMsg[] = [];
    const host = new Lockstep({ seats: [1, 2], local: 1, host: 1, delay: 1, send: (_to, m) => toClient.push(m) });
    const client = new Lockstep({ seats: [1, 2], local: 2, host: 1, delay: 1, send: (_to, m) => toHost.push(m) });
    for (let k = 0; k < 4; k++) {
      host.submit([`h${k}`]);
      host.receive(2, { k: 'in', turn: k + 1, cmds: [`c${k}`] });
      host.next();
    }
    const turns = toClient.filter((m) => m.k === 'turn');
    expect(turns.map((m) => m.turn)).toEqual([1, 2, 3, 4]);
    client.next();
    // Turn 2 is lost on the way; 3 arrives twice; 1 arrives after 2 was due.
    client.receive(1, turns[0]);
    client.receive(1, turns[2]);
    client.receive(1, { ...turns[2], inputs: [] });
    expect(client.next()?.turn).toBe(1);
    expect(client.next()).toBeNull();
    client.receive(1, turns[0]);
    // It asks; the host sends again from turn 2 on.
    client.want();
    expect(toHost.at(-1)).toEqual({ k: 'want', from: 2 });
    const before = toClient.length;
    host.receive(2, toHost.at(-1)!);
    for (const m of toClient.slice(before)) client.receive(1, m);
    expect(client.next()?.turn).toBe(2);
    const t3 = client.next()!;
    expect(t3.inputs.map((i) => i.cmds)).toEqual([['h2'], ['c2']]);
    expect(client.next()?.turn).toBe(4);
  });

  it('timeouts and «disconnect the player» still hand the seat to the computer', () => {
    const g = coreGame({ humans: 2, seed: 1, world: { size: 64, players: 2 } });
    run(g, 3_000);
    g.peers[1].gone = true; // a frozen tab
    run(g, 2_000);
    expect(g.peers[0].core.match.waiting).toBe(true);
    g.peers[0].core.kick(2);
    run(g, 3_000);
    expect(g.peers[0].world.aiLevel(2)).toBe('medium');
    expect(g.peers[0].core.match.waiting).toBe(false);
    // The kicked player may still come back if the host agrees.
    expect(g.peers[0].core.vacantSeats()).toEqual([2]);
  });
});
