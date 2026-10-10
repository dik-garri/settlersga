import { describe, expect, it } from 'vitest';
import { applySeatControls, NetCore, type NetStartBase } from '../src/net/core';
import { LoopbackNetwork, VirtualClock, type LoopbackTransport } from '../src/net/loopback';
import { netChecksum } from '../src/net/match';
import { cleanName, NAME_MAX, sameName, uniqueName } from '../src/net/names';
import { stateChecksum } from '../src/sim/checksum';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { LobbyClient, LobbyHost, parseStart, type StartInfo } from '../src/ui/lobby';
import { namesOf } from '../src/ui/playerNames';
import { SaveSlots, type KeyValue } from '../src/ui/saves';
import { defaultSetup, parseSetup, worldArgs, type GameSetup } from '../src/ui/setup';

/**
 * Player names (docs/NETWORK.md section 15): cleaning what people type or what arrives over the
 * network, names in the lobby (said in `hello`, changed later, made unique by the host, written into
 * the setup at «Start»), a loaded network game seating its players by name, a returning player
 * recognised by name — and none of it touching the world or its checksums.
 */

const BUILD = 'names.1';

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

describe('cleaning names', () => {
  it('trims, keeps one line, drops control and bidi characters, cuts to 16 characters', () => {
    expect(cleanName('  Вася   Пупкин  ')).toBe('Вася Пупкин');
    expect(cleanName('a\nb\tc\r\nd')).toBe('a b c d');
    expect(cleanName('Eve\u0000\u0007\u001b[31m')).toBe('Eve[31m');
    // Right-to-left override, zero-width joiner, line separator: nothing hidden or reversed.
    expect(cleanName('\u202Eevil\u200D\u2028x')).toBe('evil x');
    expect(cleanName('a \u200B b')).toBe('a b');
    expect(cleanName('x'.repeat(40))).toBe('x'.repeat(NAME_MAX));
    // Counted in characters: an emoji is one, never cut in half.
    const emoji = '😀'.repeat(20);
    expect(Array.from(cleanName(emoji)!)).toHaveLength(NAME_MAX);
    expect(cleanName(`${'a'.repeat(15)} b`)).toBe('a'.repeat(15));
    // HTML stays plain text (it is shown with textContent).
    expect(cleanName('<b>bold</b>')).toBe('<b>bold</b>');
    for (const bad of ['', '   ', '\u200B', null, undefined, 42, {}, ['x']]) expect(cleanName(bad)).toBeNull();
  });

  it('compares names ignoring case and spacing; makes a taken name unique', () => {
    expect(sameName('Вася', ' вася ')).toBe(true);
    expect(sameName('Anna', 'Anne')).toBe(false);
    expect(sameName('', '')).toBe(false);
    expect(uniqueName('Anna', ['Boris'])).toBe('Anna');
    expect(uniqueName('Anna', ['anna'])).toBe('Anna 2');
    expect(uniqueName('Anna', ['Anna', 'Anna 2'])).toBe('Anna 3');
    const long = 'L'.repeat(NAME_MAX);
    expect(uniqueName(long, [long])).toBe(`${'L'.repeat(NAME_MAX - 2)} 2`);
  });

  it('a setup read back keeps cleaned names and drops bad ones', () => {
    const s = defaultSetup();
    const raw = JSON.parse(JSON.stringify(s)) as Record<string, unknown> & { slots: Record<string, unknown>[] };
    raw.slots[0].name = '  Ольга\u0000 ';
    raw.slots[1].name = 'y'.repeat(50);
    raw.slots[2].name = 7;
    const back = parseSetup(JSON.stringify(raw))!;
    expect(back.slots[0].name).toBe('Ольга');
    expect(back.slots[1].name).toBe('y'.repeat(NAME_MAX));
    expect('name' in back.slots[2]).toBe(false);
  });
});

describe('names in the lobby', () => {
  const lobby = (setup: GameSetup, hostName: string, slots: SaveSlots | null = null) => {
    const clock = new VirtualClock();
    const net = new LoopbackNetwork({ scheduler: clock, conditions: { latency: 15 } });
    const ht = net.openHost('NAMES1');
    const host = new LobbyHost(ht, setup, BUILD, () => clock.now(), slots, hostName);
    const clients: LobbyClient[] = [];
    const tick = (ms: number) => {
      for (let t = 0; t < ms; t += 50) {
        clock.advance(50);
        host.update();
        for (const c of clients) c.update();
      }
    };
    const join = (name: string, opts: { slots?: SaveSlots } = {}) => {
      const c = new LobbyClient(net.connect('NAMES1', `peer-${clients.length + 1}`), BUILD, () => clock.now(), { name, ...opts });
      clients.push(c);
      return c;
    };
    return { clock, net, ht, host, join, tick };
  };

  it('names travel with hello and later changes; the host keeps them unique and puts them into the started setup', () => {
    const setup: GameSetup = { ...defaultSetup(), mode: 'network', size: 64 };
    setup.slots[1].kind = 'remote';
    setup.slots[2].kind = 'remote';
    setup.slots[3] = { ...setup.slots[3], kind: 'ai' };
    // A stored setup with names in it never leaks them into a new lobby.
    setup.slots[1].name = 'Old friend';
    const L = lobby(setup, 'Hostess');
    expect(L.host.setup.slots[1].name).toBeUndefined();
    const a = L.join('Anna\u202E');
    const b = L.join(' anna ');
    L.tick(300);
    expect(a.slot).toBe(1);
    expect(b.slot).toBe(2);
    // Everybody sees every name; the second «anna» became unique.
    expect(L.host.memberList().map((m) => m.name)).toEqual(['Anna', 'anna 2']);
    expect(b.members.map((m) => m.name)).toEqual(['Anna', 'anna 2']);
    expect(a.hostName).toBe('Hostess');
    expect(b.myName).toBe('anna 2');
    // Names change on the fly: a player's and the host's.
    b.setName('Boris\n\n');
    L.host.setName('  Host  ');
    L.tick(300);
    expect(a.members.find((m) => m.slot === 2)?.name).toBe('Boris');
    expect(a.hostName).toBe('Host');
    // An empty name falls back to none (the screens show «Игрок N»).
    a.setName('   ');
    L.tick(300);
    expect(L.host.memberList()[0].name).toBe('');
    a.setName('Anna');
    a.setReady(true);
    b.setReady(true);
    L.tick(2_500);
    expect(L.host.problem()).toBeNull();
    const info = L.host.start(31)!;
    L.tick(300);
    expect(a.started).toEqual(info);
    expect(info.setup.slots.map((s) => s.name)).toEqual(['Host', 'Anna', 'Boris', undefined]);
    // The game names its human seats; the computer has none (the screens name it by its level).
    expect([...namesOf(info.setup)]).toEqual([
      [1, 'Host'],
      [2, 'Anna'],
      [3, 'Boris'],
    ]);
    // The setup the host keeps for the next lobby carries no names.
    expect(L.host.setup.slots.every((s) => s.name === undefined)).toBe(true);
    // A start message with a forged name is cleaned on arrival.
    const forged = JSON.parse(JSON.stringify(info)) as StartInfo;
    forged.setup.slots[1].name = '\u0000'.repeat(3) + 'z'.repeat(99);
    expect(parseStart(forged)!.setup.slots[1].name).toBe('z'.repeat(NAME_MAX));
  });

  it('names are not part of the world: the same setup with other names gives the same world and checksums', () => {
    const setup: GameSetup = { ...defaultSetup(), mode: 'network', size: 64, seed: 9 };
    setup.slots[1].kind = 'remote';
    const named: GameSetup = { ...setup, slots: setup.slots.map((s, k) => ({ ...s, name: `P${k}` })) };
    const plain = worldArgs(setup, 1);
    const withNames = worldArgs(named, 1);
    expect(withNames).toEqual(plain);
    const w1 = new World(plain.seed, plain.opts);
    const w2 = new World(withNames.seed, withNames.opts);
    for (let k = 0; k < 50; k++) {
      w1.step();
      w2.step();
    }
    expect(stateChecksum(w2)).toBe(stateChecksum(w1));
    expect(netChecksum(w2)).toBe(netChecksum(w1));
    expect(JSON.stringify(saveWorld(w1))).not.toMatch(/P0|P1/);
  });

  it('a loaded network game seats returning players by name — the host too — and plays on', async () => {
    // A saved three-player network game: Anna hosted it (slot 0), Boris and Vera played slots 1 and 2.
    const source = new World(21, { size: 64, players: 3, ai: [] });
    for (let k = 0; k < 100; k++) source.step();
    const data = saveWorld(source);
    const saved: GameSetup = { ...defaultSetup(), mode: 'network', size: 64, seed: 21 };
    saved.slots = [
      { ...saved.slots[0], kind: 'human', name: 'Anna' },
      { ...saved.slots[1], kind: 'remote', name: 'Boris' },
      { ...saved.slots[2], kind: 'remote', name: 'Vera' },
      { ...saved.slots[3], kind: 'closed' },
    ];
    const hostSlots = new SaveSlots(new MemoryStore());
    await hostSlots.write(data, 'three', 1, undefined, {
      net: { id: 'OLD-100', sum: netChecksum(World.load(data)), setup: saved, local: 3, host: 1, turn: 50, speed: 1 },
    });
    // Now Vera hosts it: she plays her own seat (slot 2), not the former host's.
    const L = lobby({ ...defaultSetup(), mode: 'network' }, 'vera', hostSlots);
    expect(L.host.loadSave(hostSlots.netSaves()[0])).toBe(true);
    expect(L.host.hostSlot()).toBe(2);
    expect(L.host.loadView()!.seats).toEqual(['remote', 'remote', null, null]);
    // A stranger comes first and takes the first free seat by order (Anna's)…
    const gleb = L.join('Gleb', { slots: new SaveSlots(new MemoryStore()) });
    L.tick(300);
    expect(gleb.slot).toBe(0);
    // …then Boris gets his own seat by name.
    const boris = L.join('BORIS', { slots: new SaveSlots(new MemoryStore()) });
    L.tick(300);
    expect(boris.slot).toBe(1);
    // No seat left for Gleb once Anna is back: he is let go («full»), Anna sits in slot 0.
    const anna = L.join('Anna', { slots: new SaveSlots(new MemoryStore()) });
    L.tick(300);
    expect(anna.slot).toBe(0);
    expect(gleb.refused?.why).toBe('full');
    expect(L.host.memberList().map((m) => [m.slot, m.name])).toEqual([
      [0, 'Anna'],
      [1, 'BORIS'],
    ]);
    // The clients see where the host sits.
    expect(anna.load?.host).toBe(2);
    for (const c of [anna, boris]) c.setReady(true);
    L.tick(4_000);
    expect(L.host.problem()).toBeNull();
    const info = L.host.start(0)!;
    L.tick(300);
    expect(anna.started).toEqual(info);
    // Seat 3 (slot 2) is the host's browser, seats 1 and 2 Anna's and Boris's.
    expect(info.seats).toEqual([
      [1, anna.transport.self],
      [2, boris.transport.self],
      [3, L.ht.self],
    ]);
    expect(info.setup.slots.map((s) => s.name)).toEqual(['Anna', 'BORIS', 'vera', undefined]);
    // Every browser loads the save and plays it, the host on seat 3: identical.
    const clientsData = await Promise.all([anna, boris].map(async () => data));
    const browsers: [LoopbackTransport, World][] = [
      [L.ht, World.load(data)],
      [anna.transport as LoopbackTransport, World.load(clientsData[0])],
      [boris.transport as LoopbackTransport, World.load(clientsData[1])],
    ];
    for (const c of [anna, boris]) c.dispose();
    L.host.dispose();
    const cores = browsers.map(([transport, world]) => {
      applySeatControls(world, info.load!.control);
      return new NetCore({ world, transport, start: info as NetStartBase, build: BUILD, now: () => L.clock.now(), tuneDelay: false, names: namesOf(info.setup) });
    });
    expect(cores.map((c) => [c.local, c.hostSeat, c.isHost])).toEqual([
      [3, 3, true],
      [1, 3, false],
      [2, 3, false],
    ]);
    for (let t = 0; t < 8_000; t += 20) {
      L.clock.advance(20);
      for (const c of cores) c.pump(20);
    }
    L.clock.advance(1_000);
    const worlds = browsers.map(([, w]) => w);
    const tick = Math.max(...worlds.map((w) => w.tick));
    cores.forEach((c, k) => {
      for (let guard = 0; worlds[k].tick < tick && guard < 2_000; guard++) c.match.advance(100, 1);
    });
    expect(worlds[0].tick).toBeGreaterThan(100);
    expect(new Set(worlds.map((w) => `${w.tick}:${stateChecksum(w)}`)).size).toBe(1);
  });
});

describe('a returning player is recognised by name', () => {
  it('a browser without a remembered seat asks for the seat with its name; the host hears who asks', () => {
    const clock = new VirtualClock();
    const net = new LoopbackNetwork({ scheduler: clock, seed: 3, conditions: { latency: 20 } });
    const ht = net.openHost('NAMES2');
    const pt = net.connect('NAMES2', 'p2');
    const qt = net.connect('NAMES2', 'p3');
    const setup: GameSetup = { ...defaultSetup(), mode: 'network', size: 64, seed: 4 };
    setup.slots = [
      { ...setup.slots[0], kind: 'human', name: 'Host' },
      { ...setup.slots[1], kind: 'remote', name: 'Petra' },
      { ...setup.slots[2], kind: 'remote', name: 'Quinn' },
      { ...setup.slots[3], kind: 'closed' },
    ];
    const start: StartInfo = { setup, seed: 4, seats: [ht, pt, qt].map((t, k) => [k + 1, t.self]), delay: 2, turnTicks: 2, checksumEvery: 5 };
    const asked: [number, string | null][] = [];
    const cores = [ht, pt, qt].map(
      (transport) =>
        new NetCore({
          world: new World(4, worldArgs(setup, 4).opts),
          transport,
          start,
          build: BUILD,
          now: () => clock.now(),
          tuneDelay: false,
          names: namesOf(setup),
          hooks: { rejoinAsked: (seat, name) => asked.push([seat, name]) },
        }),
    );
    const live = new Set(cores);
    const lobbies: LobbyClient[] = [];
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        clock.advance(20);
        for (const c of live) c.pump(20);
        for (const l of lobbies) l.update();
      }
    };
    run(4_000);
    // Both clients drop; Quinn comes back in a new tab (no remembered seat), under his name.
    net.disconnect('p2');
    net.disconnect('p3');
    live.delete(cores[1]);
    live.delete(cores[2]);
    run(15_000);
    expect(cores[0].vacantSeats()).toEqual([2, 3]);
    const back = new LobbyClient(net.connect('NAMES2', 'q-again'), BUILD, () => clock.now(), { name: 'quinn' });
    lobbies.push(back);
    for (let t = 0; t < 5_000 && !back.ingame; t += 20) run(20);
    expect(back.ingame?.names.get(2)).toBe('Petra');
    expect(back.hint).toBe(3);
    back.rejoin(back.hint!);
    run(500);
    expect(asked).toEqual([[3, 'quinn']]);
    expect(cores[0].askedSeats()).toEqual([3]);
    expect(cores[0].askerName(3)).toBe('quinn');
    expect(cores[0].nameOf(3)).toBe('Quinn');
    // Someone else asking for Petra's seat is told apart by his name.
    const other = new LobbyClient(net.connect('NAMES2', 'x'), BUILD, () => clock.now(), { name: 'Mallory', seat: 2 });
    lobbies.push(other);
    for (let t = 0; t < 5_000 && !other.ingame; t += 20) run(20);
    other.rejoin(2);
    run(500);
    expect(asked.at(-1)).toEqual([2, 'Mallory']);
    expect(cores[0].askerName(2)).toBe('Mallory');
    cores[0].refuseRejoin(2);
    run(300);
    expect(other.refused?.why).toBe('denied');
    expect(cores[0].askerName(2)).toBeNull();
  });
});
