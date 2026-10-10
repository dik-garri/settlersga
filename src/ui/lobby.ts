import { CHECKSUM_EVERY, TURN_TICKS } from '../net/match';
import type { Seat } from '../net/lockstep';
import { PingMeter } from '../net/status';
import type { PeerId, Transport } from '../net/transport';
import { TICKS_PER_SECOND } from '../sim/config';
import { t } from './i18n';
import { activeSlots, MAX_SLOTS, parseSetup, setupProblem, type GameSetup } from './setup';

/**
 * The network lobby's logic (roadmap 6.5, docs/NETWORK.md section 4), without DOM: `LobbyHost` on the
 * browser that created the game, `LobbyClient` on every browser that joined it. They talk on the
 * transport's `lobby` channel; the lobby screen (`lobbyView.ts`) draws them and calls their methods.
 *
 * - A joining browser first says which build it runs (`hello`); another build is refused with a
 *   clear message — two builds would part ways from the first turn.
 * - The host seats it on the first free «player over the network» slot (or opens a closed one) and
 *   from then on sends the whole setup and the players' state (ready, ping) to everybody on every
 *   change. The host edits everything; a player only its own slot's team, and its ready flag.
 * - Chat lines go through the host, who passes them on to everybody.
 * - «Start» (host, once every seat over the network is taken and ready): the host fixes the seed,
 *   numbers the seats (player id = position among the slots that play, as `worldArgs`), picks the
 *   input delay from the pings and sends it all (`StartInfo`); every browser builds the same world.
 */

/** A seated player over the network, as everybody sees it. */
export interface LobbyMember {
  slot: number;
  ready: boolean;
  /** Round trip to the host (ms), null before the first answer. */
  ping: number | null;
}

/** A chat line; `slot` is the speaker's slot (0 = the host). */
export interface ChatLine {
  slot: number;
  text: string;
}

/** Why a browser was not let in. */
export type RefuseReason = 'version' | 'full' | 'started';

/** What the host sends at «Start»: everything a browser needs to build the game. */
export interface StartInfo {
  setup: GameSetup;
  seed: number;
  /** Every human seat (player id) and the peer that plays it, the host's included. */
  seats: [Seat, PeerId][];
  /** Input delay in turns, ticks per turn, turns between checksums. */
  delay: number;
  turnTicks: number;
  checksumEvery: number;
}

type ToHost =
  | { ch: 'lobby'; k: 'hello'; build: string }
  | { ch: 'lobby'; k: 'ready'; on: boolean }
  | { ch: 'lobby'; k: 'team'; team: number }
  | { ch: 'lobby'; k: 'chat'; text: string };

type ToClient =
  | { ch: 'lobby'; k: 'welcome'; slot: number }
  | { ch: 'lobby'; k: 'refuse'; why: RefuseReason; build: string }
  | { ch: 'lobby'; k: 'state'; setup: GameSetup; members: LobbyMember[] }
  | { ch: 'lobby'; k: 'chat'; slot: number; text: string }
  | ({ ch: 'lobby'; k: 'start' } & StartInfo);

const isLobby = (x: unknown): x is { ch: 'lobby'; k: string } & Record<string, unknown> =>
  typeof x === 'object' && x !== null && (x as { ch?: unknown }).ch === 'lobby' && typeof (x as { k?: unknown }).k === 'string';

/** Longest chat line (characters). */
export const CHAT_MAX = 200;
/** Chat lines kept. */
const CHAT_KEEP = 50;
/** Input delay bounds (turns), docs/NETWORK.md section 6. */
export const MIN_DELAY = 2;
export const MAX_DELAY = 6;

/** The input delay for the worst round trip: ⌈(RTT + 100 ms) / turn⌉, within 2…6 turns. */
export function delayFor(maxRtt: number, turnTicks = TURN_TICKS): number {
  const turnMs = (turnTicks * 1000) / TICKS_PER_SECOND;
  return Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.ceil((Math.max(0, maxRtt) + 100) / turnMs)));
}

/** A chat line as typed: trimmed, cut to `CHAT_MAX`; empty → null. */
export function cleanChat(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const s = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
  return s ? s : null;
}

/** The slot a newcomer gets: the first free «over the network» slot, else the first closed one; null if full. */
export function freeSlot(setup: GameSetup, taken: ReadonlySet<number>): number | null {
  for (let k = 1; k < setup.slots.length; k++) if (setup.slots[k].kind === 'remote' && !taken.has(k)) return k;
  for (let k = 1; k < setup.slots.length; k++) if (setup.slots[k].kind === 'closed') return k;
  return null;
}

/**
 * Why the lobby cannot start, or null: the setup's own problems, then a seat over the network nobody
 * took, a player not ready, or nobody over the network at all.
 */
export function lobbyProblem(setup: GameSetup, members: readonly LobbyMember[]): string | null {
  const p = setupProblem(setup);
  if (p) return p;
  const remote = setup.slots.map((s, k) => (s.kind === 'remote' ? k : -1)).filter((k) => k >= 0);
  if (remote.length === 0) return t('lobby.problem.alone');
  if (remote.some((k) => !members.some((m) => m.slot === k))) return t('lobby.problem.empty');
  if (members.some((m) => !m.ready)) return t('lobby.problem.notReady');
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
  return {
    setup: { ...setup, mode: 'network' },
    seed: m.seed as number,
    seats,
    delay: int(m.delay, 1, 20, MIN_DELAY),
    turnTicks: int(m.turnTicks, 1, 10, TURN_TICKS),
    checksumEvery: int(m.checksumEvery, 1, 100, CHECKSUM_EVERY),
  };
}

/** The host's side of the lobby. */
export class LobbyHost {
  readonly setup: GameSetup;
  /** Seated players over the network, by peer. */
  readonly members = new Map<PeerId, LobbyMember>();
  readonly chat: ChatLine[] = [];
  /** The game has started: nobody else gets in. */
  started: StartInfo | null = null;
  /** Called on every change the screen should show. */
  onChange: () => void = () => {};
  private readonly ping: PingMeter;
  private readonly offs: (() => void)[] = [];
  private lastState = -Infinity;

  constructor(
    readonly transport: Transport,
    setup: GameSetup,
    private readonly build: string,
    private readonly now: () => number,
  ) {
    this.setup = { ...setup, mode: 'network', slots: setup.slots.map((s) => ({ ...s })) };
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

  private receive(from: PeerId, m: ToHost): void {
    if (m.k === 'hello') {
      if (this.members.has(from)) return;
      const why: RefuseReason | null =
        m.build !== this.build ? 'version' : this.started ? 'started' : null;
      const slot = why ? null : freeSlot(this.setup, new Set([...this.members.values()].map((x) => x.slot)));
      if (slot === null) {
        this.send(from, { ch: 'lobby', k: 'refuse', why: why ?? 'full', build: this.build });
        this.transport.kick(from);
        return;
      }
      this.setup.slots[slot].kind = 'remote';
      this.members.set(from, { slot, ready: false, ping: null });
      this.send(from, { ch: 'lobby', k: 'welcome', slot });
      this.changed();
      return;
    }
    const me = this.members.get(from);
    if (!me) return;
    if (m.k === 'ready' && typeof m.on === 'boolean') {
      me.ready = m.on;
      this.changed();
    } else if (m.k === 'team' && Number.isInteger(m.team) && m.team >= 1 && m.team <= MAX_SLOTS) {
      this.setup.slots[me.slot].team = m.team;
      this.changed();
    } else if (m.k === 'chat') {
      const text = cleanChat(m.text);
      if (text) this.say(me.slot, text);
    }
  }

  /** The host edited the setup (in place): seats follow, everybody sees it. */
  changed(): void {
    // A seat whose slot is no longer «over the network» moves to a free one, or its player goes.
    for (const [peer, m] of this.members) {
      if (this.setup.slots[m.slot]?.kind === 'remote') continue;
      const taken = new Set([...this.members.values()].filter((x) => x !== m).map((x) => x.slot));
      const k = this.setup.slots.findIndex((s, i) => i > 0 && s.kind === 'remote' && !taken.has(i));
      if (k > 0) m.slot = k;
      else {
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
    this.transport.broadcast({ ch: 'lobby', k: 'state', setup: this.setup, members: this.memberList() } satisfies ToClient);
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
    if (s) this.say(0, s);
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
    return lobbyProblem(this.setup, this.memberList());
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
    for (const [seat, slot] of seatsOf(this.setup)) {
      const peer = slot === 0 ? this.transport.self : this.peerOf(slot);
      if (!peer) return null;
      seats.push([seat, peer]);
    }
    let worst = 0;
    for (const peer of this.members.keys()) worst = Math.max(worst, this.ping.rtt(peer) ?? 0);
    const info: StartInfo = {
      setup: { ...this.setup, slots: this.setup.slots.map((s) => ({ ...s })) },
      seed: this.setup.seed ?? randomSeed,
      seats,
      delay: delayFor(worst),
      turnTicks: TURN_TICKS,
      checksumEvery: CHECKSUM_EVERY,
    };
    info.setup.seed = info.seed;
    this.started = info;
    this.transport.broadcast({ ch: 'lobby', k: 'start', ...info } satisfies ToClient);
    return info;
  }

  /** Stops listening (the game takes the transport over, or the lobby is left). */
  dispose(): void {
    for (const off of this.offs) off();
    this.ping.dispose();
  }
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
  onChange: () => void = () => {};
  private readonly ping: PingMeter;
  private readonly offs: (() => void)[] = [];

  constructor(
    readonly transport: Transport,
    build: string,
    now: () => number,
  ) {
    this.ping = new PingMeter(transport, now, 1000);
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
    transport.send(transport.host, { ch: 'lobby', k: 'hello', build } satisfies ToHost);
  }

  private receive(m: ToClient): void {
    switch (m.k) {
      case 'welcome':
        if (Number.isInteger(m.slot)) this.slot = m.slot;
        break;
      case 'refuse':
        this.refused = { why: m.why === 'version' || m.why === 'started' ? m.why : 'full', build: String(m.build ?? '') };
        break;
      case 'state': {
        const setup = parseSetup(JSON.stringify(m.setup ?? null));
        if (!setup || !Array.isArray(m.members)) return;
        this.setup = { ...setup, mode: 'network' };
        this.members = m.members
          .filter((x) => x && Number.isInteger(x.slot))
          .map((x) => ({ slot: x.slot, ready: x.ready === true, ping: typeof x.ping === 'number' ? x.ping : null }));
        break;
      }
      case 'chat': {
        const text = cleanChat(m.text);
        if (!text || !Number.isInteger(m.slot)) return;
        this.chat.push({ slot: m.slot, text });
        if (this.chat.length > CHAT_KEEP) this.chat.shift();
        break;
      }
      case 'start': {
        const info = parseStart(m);
        if (!info || !info.seats.some(([, p]) => p === this.transport.self)) return;
        this.started = info;
        break;
      }
      default:
        return;
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

  setTeam(team: number): void {
    this.transport.send(this.transport.host, { ch: 'lobby', k: 'team', team } satisfies ToHost);
  }

  say(text: string): void {
    const s = cleanChat(text);
    if (s) this.transport.send(this.transport.host, { ch: 'lobby', k: 'chat', text: s } satisfies ToHost);
  }

  /** Pings the host (the round trip shows on the screen; the host measures its own). */
  update(): void {
    this.ping.update();
  }

  /** My round trip to the host (ms). */
  rtt(): number | null {
    return this.ping.rtt(this.transport.host);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.ping.dispose();
  }
}
