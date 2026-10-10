import { BlobReceiver, sendBlob } from '../net/blob';
import { cleanChat, type NetChatLine } from '../net/chat';
import { SNAPSHOT_BLOB, type NetStartBase, type SeatControlKind, type RejoinToClient, type ResumeInfo, type ResumeStart } from '../net/core';
import { delayFor, MIN_DELAY } from '../net/delay';
import { cleanName, sameName, uniqueName } from '../net/names';
import { CHECKSUM_EVERY, NET_SPEEDS, TURN_TICKS } from '../net/match';
import type { Seat } from '../net/lockstep';
import { PingMeter } from '../net/status';
import type { PeerId, Transport } from '../net/transport';
import type { SaveData } from '../sim/save';
import { t } from './i18n';
import type { NetSaveMeta, SaveSlots, SlotMeta } from './saves';
import { activeSlots, MAX_SLOTS, parseSetup, setupProblem, type GameSetup } from './setup';

/**
 * The network lobby's logic (roadmap 6.5–6.7, docs/NETWORK.md section 4), without DOM: `LobbyHost` on
 * the browser that created the game, `LobbyClient` on every browser that joined it. They talk on the
 * transport's `lobby` channel; the lobby screen (`lobbyView.ts`) draws them and calls their methods.
 *
 * - A joining browser first says which build it runs (`hello`); another build is refused with a
 *   clear message — two builds would part ways from the first turn.
 * - The host seats it on the first free «player over the network» slot (or opens a closed one) and
 *   from then on sends the whole setup and the players' state (ready, ping) to everybody on every
 *   change. The host edits everything; a player only its own slot's team, and its ready flag.
 * - Chat lines go through the host, who passes them on to everybody; they go on into the game.
 * - «Start» (host, once every seat over the network is taken and ready): the host fixes the seed,
 *   numbers the seats (player id = position among the slots that play, as `worldArgs`), picks the
 *   input delay from the pings and sends it all (`StartInfo`); every browser builds the same world.
 * - **Loading a network game** (6.6, S4's «load network game» lobby): the host picks a network save
 *   (`loadSave`); its setup replaces the lobby's and cannot be edited, the seats over the network take
 *   joining players in order, and for each the host decides who plays it if nobody joins: the
 *   computer or nobody (`setSeat`). Every joined browser says whether it has the save (`have`: the
 *   same id and checksum); a browser without it gets it from the host in pieces (`file` + the packed
 *   save, `sendBlob`) and stores it as a network save. «Start» sends `StartInfo.load`; every browser
 *   loads the same save and gives the seats without a player to the computer or to nobody.
 * - **A returning player** (6.7): while the game is under way the host's game answers the lobby's
 *   `hello` instead (`NetCore`): the seats free to take (`ingame`, with their players' names); the
 *   browser asks for one (`rejoin`: the seat this tab played, else the one with its player's name)
 *   and, once the host agreed, gets the snapshot (`resume` + the save in pieces).
 * - **Names** (docs/NETWORK.md section 15): every browser says its player's name in `hello` and
 *   again whenever it changes (`name`); the host makes it unique in the room, shows it to everybody
 *   with the players (`LobbyMember.name`, its own in `state.host`) and writes the names into the
 *   setup at «Start» (`SlotSetup.name`), so the game shows them and network saves keep them. A loaded
 *   game seats a newcomer on the seat its saved name matches (moving somebody who took it only by
 *   order), the host on its own seat if its name matches one; the rest by order, as before.
 */

/** A seated player over the network, as everybody sees it. */
export interface LobbyMember {
  slot: number;
  /** The player's name (`cleanName`, unique in the room); empty if none was given. */
  name: string;
  ready: boolean;
  /** Round trip to the host (ms), null before the first answer. */
  ping: number | null;
  /** Loading a network game: whether this player has the save. */
  has?: boolean;
}

/** A chat line; `slot` is the speaker's slot (0 = the host). */
export interface ChatLine {
  slot: number;
  text: string;
}

/** Why a browser was not let in. */
export type RefuseReason = 'version' | 'full' | 'started' | 'denied';

/** Who plays a seat of a loaded game: a person, the computer, or nobody (the seat stays passive). */
export type SeatControl = SeatControlKind;

/** A loaded network game at «Start»: which save, who plays each human seat, at what speed. */
export interface LoadInfo {
  id: string;
  sum: string;
  control: [Seat, SeatControl][];
  speed: number;
}

/** What the host sends at «Start»: everything a browser needs to build the game. */
export interface StartInfo extends NetStartBase {
  setup: GameSetup;
  seed: number;
  /** A loaded network game (absent: a new one from seed and setup). */
  load?: LoadInfo;
}

/** A seat over the network in a loaded game, as the host set it: a player, else the computer or nobody. */
export type LoadSeat = 'remote' | 'ai' | 'closed';

/** The save the host picked, as everybody sees it. */
export interface LoadView {
  id: string;
  sum: string;
  name: string;
  tick: number;
  size: number;
  /** Per slot (index): a seat over the network and who plays it without a player; null elsewhere. */
  seats: (LoadSeat | null)[];
  /** The slot the host plays: the one its name matches in the save, else slot 0 (the former host's). */
  host: number;
}

type ToHost =
  | { ch: 'lobby'; k: 'hello'; build: string; seat?: Seat; name?: string }
  | { ch: 'lobby'; k: 'name'; name: string }
  | { ch: 'lobby'; k: 'ready'; on: boolean }
  | { ch: 'lobby'; k: 'team'; team: number }
  | { ch: 'lobby'; k: 'chat'; text: string }
  | { ch: 'lobby'; k: 'have'; id: string; ok: boolean }
  | { ch: 'lobby'; k: 'rejoin'; seat: Seat; name?: string };

type ToClient =
  | { ch: 'lobby'; k: 'welcome'; slot: number }
  | { ch: 'lobby'; k: 'refuse'; why: RefuseReason; build: string }
  | { ch: 'lobby'; k: 'state'; setup: GameSetup; members: LobbyMember[]; load?: LoadView | null; host?: string }
  | { ch: 'lobby'; k: 'chat'; slot: number; text: string }
  | { ch: 'lobby'; k: 'file'; meta: Omit<SlotMeta, 'id' | 'auto'> }
  | ({ ch: 'lobby'; k: 'start' } & StartInfo)
  | RejoinToClient;

const isLobby = (x: unknown): x is { ch: 'lobby'; k: string } & Record<string, unknown> =>
  typeof x === 'object' && x !== null && (x as { ch?: unknown }).ch === 'lobby' && typeof (x as { k?: unknown }).k === 'string';

export { delayFor, MAX_DELAY, MIN_DELAY } from '../net/delay';
export { CHAT_MAX, cleanChat } from '../net/chat';
/** Chat lines kept. */
const CHAT_KEEP = 50;
/** The name a network save travels under (`sendBlob`). */
const saveBlob = (id: string) => `save:${id}`;

/** The slot a newcomer gets: the first free «over the network» slot, else the first closed one; null if full. */
export function freeSlot(setup: GameSetup, taken: ReadonlySet<number>): number | null {
  for (let k = 1; k < setup.slots.length; k++) if (setup.slots[k].kind === 'remote' && !taken.has(k)) return k;
  for (let k = 1; k < setup.slots.length; k++) if (setup.slots[k].kind === 'closed') return k;
  return null;
}

/**
 * Why the lobby cannot start, or null: the setup's own problems, then a seat over the network nobody
 * took, a player not ready, or nobody over the network at all; loading a game, also a player
 * without the save (only the seats set to «player» count).
 */
export function lobbyProblem(setup: GameSetup, members: readonly LobbyMember[], load?: Pick<LoadView, 'seats'> | null): string | null {
  const p = setupProblem(setup);
  if (p) return p;
  const remote = load
    ? load.seats.map((s, k) => (s === 'remote' ? k : -1)).filter((k) => k >= 0)
    : setup.slots.map((s, k) => (s.kind === 'remote' ? k : -1)).filter((k) => k >= 0);
  if (remote.length === 0) return t('lobby.problem.alone');
  if (remote.some((k) => !members.some((m) => m.slot === k))) return t('lobby.problem.empty');
  if (members.some((m) => !m.ready)) return t('lobby.problem.notReady');
  if (load && members.some((m) => !m.has)) return t('lobby.problem.noSave');
  return null;
}

/** The human seats of a setup: player id (position among the slots that play) → slot. */
export function seatsOf(setup: GameSetup): Map<Seat, number> {
  const out = new Map<Seat, number>();
  const active = activeSlots(setup);
  active.forEach((s, k) => {
    if (s.kind === 'human' || s.kind === 'remote') out.set(k + 1, setup.slots.indexOf(s));
  });
  return out;
}

const SEAT_CONTROLS: readonly SeatControl[] = ['human', 'ai', 'none'];

/** A start message read back from the network, checked; null if unusable. */
export function parseStart(x: unknown): StartInfo | null {
  if (typeof x !== 'object' || x === null) return null;
  const m = x as Record<string, unknown>;
  const setup = parseSetup(JSON.stringify(m.setup ?? null));
  if (!setup || !Number.isSafeInteger(m.seed) || !Array.isArray(m.seats)) return null;
  const seats = (m.seats as unknown[]).filter(
    (s): s is [Seat, PeerId] => Array.isArray(s) && Number.isInteger(s[0]) && typeof s[1] === 'string',
  );
  const int = (v: unknown, lo: number, hi: number, def: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : def);
  if (seats.length === 0) return null;
  const info: StartInfo = {
    setup: { ...setup, mode: 'network' },
    seed: m.seed as number,
    seats,
    delay: int(m.delay, 1, 30, MIN_DELAY),
    turnTicks: int(m.turnTicks, 1, 10, TURN_TICKS),
    checksumEvery: int(m.checksumEvery, 1, 100, CHECKSUM_EVERY),
  };
  const l = m.load as Record<string, unknown> | undefined;
  if (l && typeof l === 'object') {
    if (typeof l.id !== 'string' || typeof l.sum !== 'string' || !Array.isArray(l.control)) return null;
    info.load = {
      id: l.id,
      sum: l.sum,
      control: (l.control as unknown[]).filter(
        (c): c is [Seat, SeatControl] => Array.isArray(c) && Number.isInteger(c[0]) && SEAT_CONTROLS.includes(c[1] as SeatControl),
      ),
      speed: NET_SPEEDS.includes(l.speed as number) ? (l.speed as number) : 1,
    };
  }
  return info;
}

/** A save's description as sent with the file, checked; null if unusable. */
function parseFileMeta(x: unknown): Omit<SlotMeta, 'id' | 'auto'> | null {
  if (typeof x !== 'object' || x === null) return null;
  const m = x as Record<string, unknown>;
  const net = m.net as Record<string, unknown> | undefined;
  if (typeof m.name !== 'string' || !Number.isFinite(m.savedAt) || !Number.isInteger(m.tick) || !Number.isInteger(m.size) || !Number.isInteger(m.players)) return null;
  if (!net || typeof net.id !== 'string' || typeof net.sum !== 'string') return null;
  const setup = parseSetup(JSON.stringify(net.setup ?? null));
  if (!setup) return null;
  const meta: NetSaveMeta = {
    id: net.id,
    sum: net.sum,
    setup: { ...setup, mode: 'network' },
    local: Number.isInteger(net.local) ? (net.local as number) : 1,
    host: Number.isInteger(net.host) ? (net.host as number) : 1,
    turn: Number.isInteger(net.turn) ? (net.turn as number) : 0,
    speed: NET_SPEEDS.includes(net.speed as number) ? (net.speed as number) : 1,
  };
  return { name: m.name.slice(0, 80), savedAt: m.savedAt as number, tick: m.tick as number, size: m.size as number, players: m.players as number, net: meta };
}

/** The host's side of the lobby. */
export class LobbyHost {
  readonly setup: GameSetup;
  /** Seated players over the network, by peer. */
  readonly members = new Map<PeerId, LobbyMember>();
  readonly chat: ChatLine[] = [];
  /** The game has started: nobody else gets in. */
  started: StartInfo | null = null;
  /** The network save being loaded (null: a new game); `host` is the slot the host plays. */
  loaded: { meta: SlotMeta & { net: NetSaveMeta }; packed: string; seats: (LoadSeat | null)[]; host: number } | null = null;
  /** The host's own player name (`setName`; empty = none given). */
  name = '';
  /** Called on every change the screen should show. */
  onChange: () => void = () => {};
  private readonly ping: PingMeter;
  private readonly offs: (() => void)[] = [];
  private lastState = -Infinity;
  /** The new game's setup while a save is loaded (back to it with `unload`). */
  private fresh: GameSetup | null = null;

  constructor(
    readonly transport: Transport,
    setup: GameSetup,
    private readonly build: string,
    private readonly now: () => number,
    private readonly slots: SaveSlots | null = null,
    name: string | null = null,
  ) {
    this.setup = { ...setup, mode: 'network', slots: setup.slots.map(({ name: _n, ...s }) => ({ ...s })) };
    this.name = cleanName(name) ?? '';
    this.ping = new PingMeter(transport, now, 1000);
    this.offs.push(
      transport.on('message', (from, msg) => {
        if (isLobby(msg)) this.receive(from, msg as unknown as ToHost);
      }),
      transport.on('leave', (peer) => {
        this.ping.forget(peer);
        if (this.members.delete(peer)) this.changed();
      }),
    );
  }

  private send(to: PeerId, m: ToClient): void {
    this.transport.send(to, m);
  }

  /** Whether a slot takes a player over the network now. */
  private takesPlayer(k: number): boolean {
    return this.loaded ? this.loaded.seats[k] === 'remote' : this.setup.slots[k]?.kind === 'remote';
  }

  /** The slot the host plays (slot 0, or in a loaded game the one its saved name matches). */
  hostSlot(): number {
    return this.loaded?.host ?? 0;
  }

  /**
   * The slot a newcomer called `name` gets (null: full). A loaded game: the free seat its saved name
   * matches, else the first free one.
   */
  private slotFor(taken: ReadonlySet<number>, name: string): number | null {
    if (!this.loaded) return freeSlot(this.setup, taken);
    const free = this.loaded.seats.flatMap((s, i) => (s === 'remote' && !taken.has(i) ? [i] : []));
    return free.find((i) => sameName(this.setup.slots[i].name, name)) ?? free[0] ?? null;
  }

  /**
   * A loaded game: the seat whose saved name is the newcomer's, if somebody took it only by order —
   * that player moves to another free seat (told by a new `welcome`), or, with none left, is let go
   * («full»), and the newcomer gets his own. Null if there is no such seat.
   */
  private reclaim(name: string): number | null {
    if (!this.loaded || !name) return null;
    const own = this.loaded.seats.findIndex((s, i) => s === 'remote' && sameName(this.setup.slots[i].name, name));
    if (own < 0) return null;
    const occupant = [...this.members].find(([, m]) => m.slot === own);
    if (!occupant || sameName(this.setup.slots[own].name, occupant[1].name)) return null;
    const taken = new Set([...this.members.values()].map((m) => m.slot));
    const elsewhere = this.slotFor(taken, occupant[1].name);
    if (elsewhere === null) {
      this.members.delete(occupant[0]);
      this.send(occupant[0], { ch: 'lobby', k: 'refuse', why: 'full', build: this.build });
      this.transport.kick(occupant[0]);
      return own;
    }
    occupant[1].slot = elsewhere;
    this.send(occupant[0], { ch: 'lobby', k: 'welcome', slot: elsewhere });
    return own;
  }

  /** Names everybody else in the room has (the host's included), for `uniqueName`. */
  private namesBut(peer: PeerId | null): string[] {
    const out = this.name ? [this.name] : [];
    for (const [p, m] of this.members) if (p !== peer && m.name) out.push(m.name);
    return out;
  }

  /** The host's own name changed (the settings or the lobby screen): everybody sees it. */
  setName(raw: string): void {
    const name = cleanName(raw) ?? '';
    const taken: string[] = [];
    for (const m of this.members.values()) if (m.name) taken.push(m.name);
    this.name = name ? uniqueName(name, taken) : '';
    this.changed();
  }

  private receive(from: PeerId, m: ToHost): void {
    if (m.k === 'hello') {
      if (this.members.has(from)) return;
      const why: RefuseReason | null = m.build !== this.build ? 'version' : this.started ? 'started' : null;
      const given = cleanName(m.name);
      const name = given ? uniqueName(given, this.namesBut(from)) : '';
      const slot = why ? null : (this.reclaim(name) ?? this.slotFor(new Set([...this.members.values()].map((x) => x.slot)), name));
      if (slot === null) {
        this.send(from, { ch: 'lobby', k: 'refuse', why: why ?? 'full', build: this.build });
        this.transport.kick(from);
        return;
      }
      if (!this.loaded) this.setup.slots[slot].kind = 'remote';
      this.members.set(from, { slot, name, ready: false, ping: null, ...(this.loaded ? { has: false } : {}) });
      this.send(from, { ch: 'lobby', k: 'welcome', slot });
      this.changed();
      return;
    }
    const me = this.members.get(from);
    if (!me) return;
    if (m.k === 'ready' && typeof m.on === 'boolean') {
      me.ready = m.on;
      this.changed();
    } else if (m.k === 'name') {
      const given = cleanName(m.name);
      me.name = given ? uniqueName(given, this.namesBut(from)) : '';
      this.changed();
    } else if (m.k === 'team' && Number.isInteger(m.team) && m.team >= 1 && m.team <= MAX_SLOTS && !this.loaded) {
      this.setup.slots[me.slot].team = m.team;
      this.changed();
    } else if (m.k === 'chat') {
      const text = cleanChat(m.text);
      if (text) this.say(me.slot, text);
    } else if (m.k === 'have' && this.loaded && m.id === this.loaded.meta.net.id) {
      if (m.ok) {
        me.has = true;
        this.changed();
        return;
      }
      // The player lacks the save: the host sends it over (its description first, then the pieces).
      const { id: _id, auto: _auto, ...meta } = this.loaded.meta;
      this.send(from, { ch: 'lobby', k: 'file', meta });
      sendBlob(this.transport, from, saveBlob(this.loaded.meta.net.id), this.loaded.packed);
    }
  }

  /**
   * Loads a network save into the lobby (roadmap 6.6): its setup replaces the lobby's, every seat over
   * the network waits for a player, and every player must have the save. False if the slot cannot be
   * read.
   */
  loadSave(meta: SlotMeta & { net: NetSaveMeta }): boolean {
    const packed = this.slots?.readPacked(meta.id);
    if (!packed || this.started) return false;
    if (!this.loaded) this.fresh = { ...this.setup, slots: this.setup.slots.map((s) => ({ ...s })) };
    const saved = meta.net.setup;
    Object.assign(this.setup, { ...saved, mode: 'network', slots: saved.slots.map((s) => ({ ...s })) });
    // The setup's human seats: the host plays the one its saved name matches, else the first (the
    // former host's); the others wait for players over the network.
    const human = (k: number) => this.setup.slots[k].kind === 'remote' || this.setup.slots[k].kind === 'human';
    const named = this.setup.slots.findIndex((s, k) => human(k) && sameName(s.name, this.name));
    const host = named >= 0 ? named : 0;
    const seats: (LoadSeat | null)[] = this.setup.slots.map((_, k) => (k !== host && human(k) ? 'remote' : null));
    this.loaded = { meta, packed, seats, host };
    // Everybody already here is seated again: by name where it matches, the rest by order.
    const order = [...this.members.values()].sort((a, b) => a.slot - b.slot);
    const taken = new Set<number>();
    for (const m of order) m.slot = -1;
    for (const byName of [true, false]) {
      for (const m of order) {
        if (m.slot >= 0) continue;
        const k = seats.findIndex((s, i) => s === 'remote' && !taken.has(i) && (!byName || sameName(this.setup.slots[i].name, m.name)));
        if (k < 0) continue;
        m.slot = k;
        taken.add(k);
      }
    }
    for (const [peer, m] of this.members) {
      m.ready = false;
      m.has = false;
      if (m.slot >= 0) this.send(peer, { ch: 'lobby', k: 'welcome', slot: m.slot });
    }
    this.changed();
    return true;
  }

  /** Back to a new game (the setup as it was before the save was picked). */
  unload(): void {
    if (!this.loaded || this.started) return;
    this.loaded = null;
    if (this.fresh) Object.assign(this.setup, this.fresh);
    this.fresh = null;
    const taken = new Set<number>();
    for (const [peer, m] of this.members) {
      m.ready = false;
      delete m.has;
      // Back in a new game, a player's slot is «over the network» again (slot 0 is the host's).
      if (m.slot <= 0 || taken.has(m.slot)) {
        const k = freeSlot(this.setup, taken);
        if (k === null) continue;
        m.slot = k;
        this.send(peer, { ch: 'lobby', k: 'welcome', slot: k });
      }
      taken.add(m.slot);
      this.setup.slots[m.slot].kind = 'remote';
    }
    this.changed();
  }

  /** Loading a game: who plays a seat over the network when nobody joins it (the computer or nobody). */
  setSeat(slot: number, s: LoadSeat): void {
    if (!this.loaded || !this.loaded.seats[slot]) return;
    this.loaded.seats[slot] = s;
    this.changed();
  }

  /** The save being loaded, as everybody sees it. */
  loadView(): LoadView | null {
    const l = this.loaded;
    return l ? { id: l.meta.net.id, sum: l.meta.net.sum, name: l.meta.name, tick: l.meta.tick, size: l.meta.size, seats: l.seats.slice(), host: l.host } : null;
  }

  /** The host edited the setup (in place): seats follow, everybody sees it. */
  changed(): void {
    // A seat whose slot no longer takes a player moves to a free one, or its player goes.
    for (const [peer, m] of this.members) {
      if (this.takesPlayer(m.slot)) continue;
      const taken = new Set([...this.members.values()].filter((x) => x !== m).map((x) => x.slot));
      const k = this.setup.slots.findIndex((_, i) => i !== this.hostSlot() && this.takesPlayer(i) && !taken.has(i));
      if (k >= 0) {
        m.slot = k;
        this.send(peer, { ch: 'lobby', k: 'welcome', slot: k });
      } else {
        this.members.delete(peer);
        this.send(peer, { ch: 'lobby', k: 'refuse', why: 'full', build: this.build });
        this.transport.kick(peer);
      }
    }
    this.broadcastState();
    this.onChange();
  }

  private broadcastState(): void {
    this.lastState = this.now();
    for (const [peer, m] of this.members) m.ping = this.ping.rtt(peer);
    this.transport.broadcast({ ch: 'lobby', k: 'state', setup: this.setup, members: this.memberList(), load: this.loadView(), host: this.name } satisfies ToClient);
  }

  /** The members in slot order. */
  memberList(): LobbyMember[] {
    return [...this.members.values()].map((m) => ({ ...m })).sort((a, b) => a.slot - b.slot);
  }

  /** The peer seated on a slot. */
  peerOf(slot: number): PeerId | null {
    for (const [peer, m] of this.members) if (m.slot === slot) return peer;
    return null;
  }

  /** Sends the host's own chat line. */
  sayOwn(text: string): void {
    const s = cleanChat(text);
    if (s) this.say(this.hostSlot(), s);
  }

  private say(slot: number, text: string): void {
    this.chat.push({ slot, text });
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    this.transport.broadcast({ ch: 'lobby', k: 'chat', slot, text } satisfies ToClient);
    this.onChange();
  }

  /** Removes a player (S4's host may). */
  kick(slot: number): void {
    const peer = this.peerOf(slot);
    if (!peer) return;
    this.members.delete(peer);
    this.transport.kick(peer);
    this.changed();
  }

  /** Why it cannot start yet, or null. */
  problem(): string | null {
    return lobbyProblem(this.setup, this.memberList(), this.loadView());
  }

  /** Pings, and the players' state every two seconds (their pings change). */
  update(): void {
    this.ping.update();
    if (this.now() - this.lastState >= 2000 && this.members.size > 0) {
      this.broadcastState();
      this.onChange();
    }
  }

  /** Starts the game for everybody (null if it cannot start). `randomSeed` serves a setup without a seed. */
  start(randomSeed: number): StartInfo | null {
    if (this.started || this.problem()) return null;
    const seats: [Seat, PeerId][] = [];
    const control: [Seat, SeatControl][] = [];
    const hostSlot = this.hostSlot();
    for (const [seat, slot] of seatsOf(this.setup)) {
      const kind = this.loaded && slot !== hostSlot ? this.loaded.seats[slot] : 'remote';
      if (kind !== 'remote') {
        control.push([seat, kind === 'ai' ? 'ai' : 'none']);
        continue;
      }
      const peer = slot === hostSlot ? this.transport.self : this.peerOf(slot);
      if (!peer) return null;
      seats.push([seat, peer]);
      control.push([seat, 'human']);
    }
    let worst = 0;
    for (const peer of this.members.keys()) worst = Math.max(worst, this.ping.rtt(peer) ?? 0);
    // The players' names go into the setup the game starts from (and network saves keep): the host's
    // and every seated player's; a loaded game keeps the saved names of the seats nobody took.
    const slots = this.setup.slots.map((s, k) => {
      const { name: saved, ...rest } = s;
      const peer = this.peerOf(k);
      const name = k === hostSlot ? this.name : peer ? this.members.get(peer)!.name : this.loaded ? saved : '';
      return name ? { ...rest, name } : rest;
    });
    const info: StartInfo = {
      setup: { ...this.setup, slots },
      seed: this.setup.seed ?? randomSeed,
      seats,
      delay: delayFor(worst),
      turnTicks: TURN_TICKS,
      checksumEvery: CHECKSUM_EVERY,
    };
    if (this.loaded) info.load = { id: this.loaded.meta.net.id, sum: this.loaded.meta.net.sum, control, speed: this.loaded.meta.net.speed };
    info.setup.seed = info.seed;
    this.started = info;
    this.transport.broadcast({ ch: 'lobby', k: 'start', ...info } satisfies ToClient);
    return info;
  }

  /** The lobby's chat as the game's first lines (speakers by seat). */
  chatLines(): NetChatLine[] {
    return lobbyChatLines(this.setup, this.chat);
  }

  /** Stops listening (the game takes the transport over, or the lobby is left). */
  dispose(): void {
    for (const off of this.offs) off();
    this.ping.dispose();
  }
}

/** Lobby chat lines (by slot) as game chat lines (by seat). */
export function lobbyChatLines(setup: GameSetup, chat: readonly ChatLine[]): NetChatLine[] {
  const active = activeSlots(setup);
  return chat
    .map((c) => ({ seat: active.indexOf(setup.slots[c.slot]) + 1, text: c.text, to: 'all' as const, lobby: true }))
    .filter((c) => c.seat > 0);
}

export interface LobbyClientOptions {
  /** The seat this browser played in the game it is returning to (a reload during the game). */
  seat?: Seat;
  /** Where network saves are looked up and stored. */
  slots?: SaveSlots | null;
  /** This browser's player name (`cleanName`), said in `hello`. */
  name?: string;
}

/** A joined browser's side of the lobby. */
export class LobbyClient {
  /** The setup as the host last sent it (null before the first). */
  setup: GameSetup | null = null;
  members: LobbyMember[] = [];
  readonly chat: ChatLine[] = [];
  /** This browser's slot (null until welcomed). */
  slot: number | null = null;
  refused: { why: RefuseReason; build: string } | null = null;
  /** The host is gone (closed the lobby or lost). */
  hostLost = false;
  started: StartInfo | null = null;
  /** The network save the host is loading (null: a new game). */
  load: LoadView | null = null;
  /** How far the save the host sends has come (0…1), null if none is on its way. */
  fileProgress: number | null = null;
  /** The game is under way: the seats this browser may ask to take back, the taken ones, and their players' names. */
  ingame: { vacant: Seat[]; busy: Seat[]; names: Map<Seat, string> } | null = null;
  /** The host's player name (empty if none given). */
  hostName = '';
  /** The seat asked for (waiting for the host's answer and the snapshot). */
  rejoinAsked: Seat | null = null;
  /** How far the snapshot has come (0…1). */
  snapshotProgress: number | null = null;
  /** The snapshot is here: the game can start where the others are. */
  resumed: ResumeStart | null = null;
  onChange: () => void = () => {};
  private readonly ping: PingMeter;
  private readonly offs: (() => void)[] = [];
  private readonly blobs: BlobReceiver;
  private readonly slots: SaveSlots | null;
  private haveSent: string | null = null;
  private file: Omit<SlotMeta, 'id' | 'auto'> | null = null;
  private pendingResume: Omit<ResumeStart, 'data'> | null = null;
  private name: string;

  constructor(
    readonly transport: Transport,
    private readonly build: string,
    now: () => number,
    private readonly opts: LobbyClientOptions = {},
  ) {
    this.slots = opts.slots ?? null;
    this.name = cleanName(opts.name) ?? '';
    this.ping = new PingMeter(transport, now, 1000);
    this.blobs = new BlobReceiver(
      transport,
      transport.host,
      (id, text) => this.blobDone(id, text),
      (id, got, of) => {
        if (id === SNAPSHOT_BLOB) this.snapshotProgress = got / of;
        else this.fileProgress = got / of;
        this.onChange();
      },
    );
    this.offs.push(
      transport.on('message', (from, msg) => {
        if (from === transport.host && isLobby(msg)) this.receive(msg as unknown as ToClient);
      }),
      transport.on('leave', (peer) => {
        if (peer !== transport.host) return;
        this.hostLost = true;
        this.onChange();
      }),
    );
    this.hello();
  }

  private hello(): void {
    this.transport.send(this.transport.host, {
      ch: 'lobby',
      k: 'hello',
      build: this.build,
      ...(this.opts.seat ? { seat: this.opts.seat } : {}),
      ...(this.name ? { name: this.name } : {}),
    } satisfies ToHost);
  }

  private receive(m: ToClient): void {
    switch (m.k) {
      case 'welcome':
        if (Number.isInteger(m.slot)) this.slot = m.slot;
        break;
      case 'refuse':
        this.refused = { why: m.why === 'version' || m.why === 'started' || m.why === 'denied' ? m.why : 'full', build: String(m.build ?? '') };
        break;
      case 'state': {
        const setup = parseSetup(JSON.stringify(m.setup ?? null));
        if (!setup || !Array.isArray(m.members)) return;
        this.setup = { ...setup, mode: 'network' };
        this.members = m.members
          .filter((x) => x && Number.isInteger(x.slot))
          .map((x) => ({
            slot: x.slot,
            name: cleanName(x.name) ?? '',
            ready: x.ready === true,
            ping: typeof x.ping === 'number' ? x.ping : null,
            ...(typeof x.has === 'boolean' ? { has: x.has } : {}),
          }));
        this.hostName = cleanName(m.host) ?? '';
        this.load = parseLoadView(m.load);
        this.checkSave();
        break;
      }
      case 'chat': {
        const text = cleanChat(m.text);
        if (!text || !Number.isInteger(m.slot)) return;
        this.chat.push({ slot: m.slot, text });
        if (this.chat.length > CHAT_KEEP) this.chat.shift();
        break;
      }
      case 'file':
        this.file = parseFileMeta(m.meta);
        this.fileProgress = 0;
        break;
      case 'start': {
        const info = parseStart(m);
        if (!info || !info.seats.some(([, p]) => p === this.transport.self)) return;
        this.started = info;
        break;
      }
      case 'ingame': {
        const names = new Map<Seat, string>();
        if (Array.isArray(m.names)) {
          for (const x of m.names as unknown[]) {
            const name = Array.isArray(x) && Number.isInteger(x[0]) ? cleanName(x[1]) : null;
            if (name) names.set((x as [Seat, string])[0], name);
          }
        }
        this.ingame = { vacant: seatList(m.vacant), busy: seatList(m.busy), names };
        break;
      }
      case 'resume': {
        const start = parseStart(m.start);
        const r = m.resume as ResumeInfo | undefined;
        if (!start || !r || typeof r !== 'object' || !r.snap || !Number.isInteger(r.input) || !Array.isArray(r.active)) return;
        const chat = Array.isArray(m.chat) ? m.chat.filter((c) => c && Number.isInteger(c.seat) && typeof c.text === 'string') : [];
        this.pendingResume = { start, resume: r, chat };
        this.snapshotProgress = 0;
        break;
      }
      default:
        return;
    }
    this.onChange();
  }

  /** Loading a game: tell the host whether this browser has the save (once per save). */
  private checkSave(): void {
    const l = this.load;
    if (!l || this.haveSent === `${l.id}.${l.sum}` || this.slot === null) return;
    this.haveSent = `${l.id}.${l.sum}`;
    const ok = !!this.slots?.findNet(l.id, l.sum);
    this.transport.send(this.transport.host, { ch: 'lobby', k: 'have', id: l.id, ok } satisfies ToHost);
  }

  private blobDone(id: string, text: string): void {
    if (id === SNAPSHOT_BLOB && this.pendingResume) {
      try {
        this.resumed = { ...this.pendingResume, data: JSON.parse(text) as SaveData };
      } catch {
        this.refused = { why: 'denied', build: '' };
      }
      this.snapshotProgress = null;
    } else if (this.load && id === saveBlob(this.load.id) && this.file && this.file.net?.id === this.load.id) {
      // The host's save, stored as this browser's network save.
      const stored = this.slots?.importPacked(text, { ...this.file, savedAt: Date.now() });
      this.fileProgress = null;
      this.transport.send(this.transport.host, { ch: 'lobby', k: 'have', id: this.load.id, ok: !!stored } satisfies ToHost);
    }
    this.onChange();
  }

  /** My ready flag as the host knows it. */
  get ready(): boolean {
    return this.members.find((m) => m.slot === this.slot)?.ready ?? false;
  }

  setReady(on: boolean): void {
    this.transport.send(this.transport.host, { ch: 'lobby', k: 'ready', on } satisfies ToHost);
  }

  /** My player name changed (the lobby screen): the host shows it to everybody. */
  setName(raw: string): void {
    this.name = cleanName(raw) ?? '';
    this.transport.send(this.transport.host, { ch: 'lobby', k: 'name', name: this.name } satisfies ToHost);
  }

  /** My name as the host made it (unique in the room), else as I gave it. */
  get myName(): string {
    return this.members.find((m) => m.slot === this.slot)?.name || this.name;
  }

  setTeam(team: number): void {
    this.transport.send(this.transport.host, { ch: 'lobby', k: 'team', team } satisfies ToHost);
  }

  say(text: string): void {
    const s = cleanChat(text);
    if (s) this.transport.send(this.transport.host, { ch: 'lobby', k: 'chat', text: s } satisfies ToHost);
  }

  /** The game is under way: asks for a seat back (the host's player confirms). */
  rejoin(seat: Seat): void {
    this.rejoinAsked = seat;
    this.transport.send(this.transport.host, { ch: 'lobby', k: 'rejoin', seat, ...(this.name ? { name: this.name } : {}) } satisfies ToHost);
    this.onChange();
  }

  /** Asks the host again which seats are free (the own one is not, until the host notices the drop). */
  askAgain(): void {
    this.hello();
  }

  /**
   * The seat this browser should ask for in a game under way: the one this tab played before a
   * reload (`sessionStorage`), else the one whose player has this browser's name.
   */
  get hint(): Seat | null {
    if (this.opts.seat) return this.opts.seat;
    for (const [seat, name] of this.ingame?.names ?? []) if (sameName(name, this.name)) return seat;
    return null;
  }

  /** Pings the host (the round trip shows on the screen; the host measures its own). */
  update(): void {
    this.ping.update();
  }

  /** My round trip to the host (ms). */
  rtt(): number | null {
    return this.ping.rtt(this.transport.host);
  }

  /** The lobby's chat as the game's first lines. */
  chatLines(): NetChatLine[] {
    return this.setup ? lobbyChatLines(this.setup, this.chat) : [];
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.blobs.dispose();
    this.ping.dispose();
  }
}

const seatList = (x: unknown): Seat[] => (Array.isArray(x) ? x.filter((s): s is Seat => Number.isInteger(s)) : []);

const LOAD_SEATS: readonly (LoadSeat | null)[] = ['remote', 'ai', 'closed', null];

function parseLoadView(x: unknown): LoadView | null {
  if (typeof x !== 'object' || x === null) return null;
  const l = x as Record<string, unknown>;
  if (typeof l.id !== 'string' || typeof l.sum !== 'string' || !Array.isArray(l.seats)) return null;
  return {
    id: l.id,
    sum: l.sum,
    name: typeof l.name === 'string' ? l.name.slice(0, 80) : '',
    tick: Number.isInteger(l.tick) ? (l.tick as number) : 0,
    size: Number.isInteger(l.size) ? (l.size as number) : 0,
    seats: (l.seats as unknown[]).map((s) => (LOAD_SEATS.includes(s as LoadSeat) ? (s as LoadSeat | null) : null)),
    host: Number.isInteger(l.host) && (l.host as number) >= 0 && (l.host as number) < MAX_SLOTS ? (l.host as number) : 0,
  };
}
