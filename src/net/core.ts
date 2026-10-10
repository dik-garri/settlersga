import type { SaveData } from '../sim/save';
import type { World } from '../sim/world';
import { sendBlob } from './blob';
import { NetChat, type ChatTo, type NetChatLine, type SayResult } from './chat';
import { DelayTuner } from './delay';
import type { DesyncReport, Seat } from './lockstep';
import { NetMatch, type MatchEvent, type Snapshot } from './match';
import { cleanName } from './names';
import { bindLockstep, type LockstepSession } from './session';
import { NetStatus } from './status';
import type { PeerId, Transport } from './transport';

/**
 * One browser's network game without DOM or timers (roadmap 6.4–6.7): the transport, the lockstep
 * session, the match over the world, the status (pings, «waiting for»), the chat, the adaptive input
 * delay and the host's desk for returning players. The browser wraps it in `ui/netGame.ts` (frame
 * loop, hidden-tab timer, save slots, words); tests drive it on a virtual clock.
 *
 * **A returning player** (6.7, docs/NETWORK.md section 6): Settlers 4 hands a departed player's seat
 * to its computer and has no way back; so do we at once (`aiTakeover` at the turn the host
 * announces), but for `REJOIN_GRACE_MS` the player may come back with the room code. His browser
 * opens the lobby, whose `hello` reaches the host's game here: the host answers with the seats
 * that are free to take (`ingame`, with the names their players had — `names`), the browser asks for
 * one (`rejoin`: the seat its tab remembers, else the one with its player's name) and says its name,
 * the host's player confirms (`rejoinAsked` with the name → `acceptRejoin`), and then:
 * 1. the lockstep makes the seat active again from the next turn it seals (`Lockstep.rejoin`, the
 *    returned turn; announced in that turn as `rejoined`, where every machine gives the seat back —
 *    `seatControl`, the computer lets go);
 * 2. the match takes a snapshot at its next turn boundary (`NetMatch.snapshot`: `saveWorld`, the
 *    sealed turns not played yet, the match's own state) and the host sends it (`resume` + the save
 *    in pieces, `sendBlob`);
 * 3. the returning browser loads it, starts its lockstep and match where the snapshot stands
 *    (`resume`), asks for any turn it missed (`want`), plays them without waiting for real time and
 *    hands in batches from the returned turn on. Until then the others wait for it, as for any slow
 *    player («Ожидание: Игрок N»).
 *
 * **Input delay** (6.7): the host feeds the worst recent round trip to a `DelayTuner` once a second
 * and announces its answer as a control at a common turn (`NetMatch.setDelay`).
 */

/** How long a departed player's seat can be taken back (ms). */
export const REJOIN_GRACE_MS = 10 * 60_000;
/** A client waiting this long for a turn asks the host to send the sealed turns again (ms). */
const WANT_AFTER_MS = 1000;
/** How often the host checks the input delay (ms). */
const TUNE_EVERY_MS = 1000;

/** What every browser of a network game knows from the start (the lobby's `StartInfo` adds the setup). */
export interface NetStartBase {
  /** Every human seat being played and its peer, the host's included. */
  seats: [Seat, PeerId][];
  delay: number;
  turnTicks: number;
  checksumEvery: number;
}

/** What a returning browser gets besides the save: where its lockstep and match start. */
export interface ResumeInfo {
  /** The snapshot without its save (that comes in pieces). */
  snap: Omit<Snapshot, 'data'>;
  /** The first turn this seat hands a batch in for. */
  input: number;
  /** The seats handing in batches. */
  active: Seat[];
}

/** The rejoin messages on the lobby channel (the returning browser runs a `LobbyClient`). */
export type RejoinToHost = { ch: 'lobby'; k: 'hello'; build: string; seat?: Seat; name?: string } | { ch: 'lobby'; k: 'rejoin'; seat: Seat; name?: string };
export type RejoinToClient =
  | { ch: 'lobby'; k: 'ingame'; vacant: Seat[]; busy: Seat[]; names: [Seat, string][] }
  | { ch: 'lobby'; k: 'refuse'; why: 'version' | 'started' | 'denied'; build: string }
  | { ch: 'lobby'; k: 'resume'; start: NetStartBase; resume: ResumeInfo; chat: NetChatLine[] };

/** The name the snapshot's save travels under (`sendBlob`). */
export const SNAPSHOT_BLOB = 'snapshot';

export interface NetCoreHooks {
  /** Something happened at a turn (a takeover, a return, the pause, a save…). */
  event?(e: MatchEvent): void;
  desync?(report: DesyncReport): void;
  /** Client: the host is gone. */
  hostLost?(): void;
  /** A chat line this browser may read. */
  chat?(line: NetChatLine): void;
  /**
   * Host: a player who left asks for his seat back — answer with `acceptRejoin`/`refuseRejoin`.
   * `name` is the name he gives now (null: none), to compare with the seat's (`nameOf`).
   */
  rejoinAsked?(seat: Seat, name: string | null): void;
  /** Host: a seat's player left. */
  seatLeft?(seat: Seat): void;
}

export interface NetCoreOptions {
  world: World;
  transport: Transport;
  /** What the lobby decided (sent on to a returning browser with the seats as they are then). */
  start: NetStartBase;
  build: string;
  now: () => number;
  /**
   * Host: every seat a person may play — the seats of `start` and, in a loaded game, the human seats
   * nobody took (the computer or nobody plays them; a player may join them later).
   */
  humanSeats?: Seat[];
  /** A returning browser: where its game starts. */
  resume?: ResumeInfo;
  /** Chat lines so far (the lobby's, or the host's for a returning player). */
  chat?: NetChatLine[];
  /**
   * The human players' names by seat (the setup's, docs/NETWORK.md section 15): the host tells a
   * returning browser whose seats are free. Interface data — never part of the world or its sums.
   */
  names?: ReadonlyMap<Seat, string>;
  /** Ticks between two autosaves (network saves at a common turn). */
  autosaveEvery?: number;
  /** Whether the host adapts the input delay (default true). */
  tuneDelay?: boolean;
  hooks?: NetCoreHooks;
}

export class NetCore {
  readonly local: Seat;
  readonly hostSeat: Seat;
  readonly isHost: boolean;
  /** Every human seat being played and its peer (live: a returning player's peer replaces the old one). */
  readonly seats: Map<Seat, PeerId>;
  readonly session: LockstepSession;
  readonly match: NetMatch;
  readonly status: NetStatus;
  readonly chat: NetChat;
  hooks: NetCoreHooks;
  /** The host is gone (client) or the game was left: nothing more is played. */
  ended = false;
  private readonly tuner = new DelayTuner();
  private lastTune = -Infinity;
  private lastWant = -Infinity;
  /** Host: when each seat's player left (vacant seats), and who asks for which seat. */
  private readonly leftAt = new Map<Seat, number>();
  private readonly asks = new Map<PeerId, Seat>();
  /** Host: the name each asking browser gave. */
  private readonly askNames = new Map<PeerId, string>();
  private readonly offs: (() => void)[] = [];

  constructor(private readonly o: NetCoreOptions) {
    const { transport, world } = o;
    this.hooks = o.hooks ?? {};
    this.seats = new Map(o.start.seats);
    const local = o.start.seats.find(([, p]) => p === transport.self)?.[0];
    const host = o.start.seats.find(([, p]) => p === transport.host)?.[0];
    if (local === undefined || host === undefined) throw new Error('network game: this browser and the host need a seat');
    this.local = local;
    this.hostSeat = host;
    this.isHost = transport.isHost;
    const r = o.resume;
    this.session = bindLockstep(transport, {
      seats: this.seats,
      delay: r ? r.snap.delay : o.start.delay,
      resume: r ? { turn: r.snap.turn, input: r.input, sealed: r.snap.sealed } : undefined,
      active: r?.active,
      onHostLost: () => this.endHostLost(),
      onSeatLeft: (seat) => {
        this.leftAt.set(seat, o.now());
        this.hooks.seatLeft?.(seat);
      },
    });
    this.match = new NetMatch({
      world,
      lockstep: this.session.lockstep,
      turnTicks: o.start.turnTicks,
      checksumEvery: o.start.checksumEvery,
      autosaveEvery: o.autosaveEvery,
      resume: r?.snap.match,
      onDesync: (rep) => this.hooks.desync?.(rep),
      onEvent: (e) => this.hooks.event?.(e),
    });
    world.sendAhead = (cmd) => this.match.queue(cmd);
    this.status = new NetStatus({
      transport,
      seats: this.seats,
      local,
      host,
      waitingFor: () => this.session.lockstep.waitingFor(),
      now: o.now,
    });
    this.chat = new NetChat({
      transport,
      seats: this.seats,
      local,
      now: o.now,
      allied: (a, b) => world.allied(a, b),
      history: o.chat,
      onLine: (line) => this.hooks.chat?.(line),
    });
    // Seats nobody plays from the start (a loaded game): free to take for the grace period.
    for (const seat of o.humanSeats ?? []) if (!this.seats.has(seat)) this.leftAt.set(seat, o.now());
    if (this.isHost) {
      this.offs.push(
        transport.on('message', (from, msg) => this.desk(from, msg)),
        transport.on('leave', (peer) => {
          this.asks.delete(peer);
          this.askNames.delete(peer);
        }),
      );
    }
    // Turns sealed between the snapshot and now: ask for them at once.
    if (r) this.session.lockstep.want();
  }

  /** Plays `dtMs` of real time (at most `maxTicks` ticks); the status, the delay and resends too. */
  pump(dtMs: number, maxTicks = 20): number {
    this.status.update();
    if (this.ended) return 0;
    const now = this.o.now();
    const ls = this.session.lockstep;
    if (this.isHost && this.o.tuneDelay !== false && now - this.lastTune >= TUNE_EVERY_MS && !this.match.stopped) {
      this.lastTune = now;
      const v = this.tuner.update(now, this.status.worstRtt(), ls.delay, this.match.speed);
      if (v !== null) this.match.setDelay(v);
    }
    if (!this.isHost && this.match.waitingMs >= WANT_AFTER_MS && now - this.lastWant >= WANT_AFTER_MS) {
      this.lastWant = now;
      ls.want();
    }
    return this.match.advance(dtMs, maxTicks);
  }

  /** Whether the game is far behind the sealed turns (a returning browser): play it without drawing. */
  get catchingUp(): boolean {
    const ls = this.session.lockstep;
    return ls.buffered() > 2 * ls.delay + 4;
  }

  /** Says something in the chat. */
  say(text: string, to: ChatTo): SayResult {
    return this.chat.say(text, to);
  }

  /** Asks every machine to save at a common turn. */
  requestSave(name: string): void {
    this.match.requestSave(name);
  }

  /** Host: disconnect the player of a seat (the computer takes it over at the next sealed turn). */
  kick(seat: Seat): void {
    const peer = this.seats.get(seat);
    if (this.isHost && peer && seat !== this.local) this.o.transport.kick(peer);
  }

  /** Host: the seats a departed player may take back now. */
  vacantSeats(): Seat[] {
    const now = this.o.now();
    const active = new Set(this.session.lockstep.activeSeats());
    const out: Seat[] = [];
    for (const [seat, at] of this.leftAt) {
      if (active.has(seat) || seat === this.hostSeat || now - at > REJOIN_GRACE_MS || this.o.world.isDefeated(seat)) continue;
      out.push(seat);
    }
    return out.sort((a, b) => a - b);
  }

  /** Host: the seats someone is asking to take back, waiting for the host's answer. */
  askedSeats(): Seat[] {
    return [...new Set(this.asks.values())].sort((a, b) => a - b);
  }

  /** Host: the name the latest browser asking for a seat gave (null: none). */
  askerName(seat: Seat): string | null {
    let name: string | null = null;
    for (const [peer, s] of this.asks) if (s === seat) name = this.askNames.get(peer) ?? null;
    return name;
  }

  /** A seat's player name as the game started (null: none known). */
  nameOf(seat: Seat): string | null {
    return this.o.names?.get(seat) ?? null;
  }

  /**
   * Host: the returning player gets his seat back (roadmap 6.7). The lockstep takes his batches
   * again from the next turn it seals, where every machine gives the seat back; his browser gets a
   * snapshot taken at the next turn boundary. False if nobody asks for it or it is taken.
   */
  acceptRejoin(seat: Seat): boolean {
    const peer = [...this.asks].find(([, s]) => s === seat)?.[0];
    if (!this.isHost || !peer || !this.vacantSeats().includes(seat)) return false;
    for (const [p, s] of [...this.asks]) {
      if (s !== seat) continue;
      this.asks.delete(p);
      this.askNames.delete(p);
    }
    const input = this.session.lockstep.rejoin(seat);
    if (input === null) return false;
    this.seats.set(seat, peer);
    this.leftAt.delete(seat);
    const t = this.o.transport;
    this.match.snapshot((snap) => {
      // Gone again meanwhile: its leave dropped the seat once more.
      if (!t.peers().includes(peer) || this.seats.get(seat) !== peer) return;
      const { data, ...rest } = snap;
      const resume: ResumeInfo = { snap: rest, input, active: this.session.lockstep.activeSeats() };
      t.send(peer, {
        ch: 'lobby',
        k: 'resume',
        start: { ...this.o.start, seats: [...this.seats], delay: snap.delay },
        resume,
        chat: this.chat.linesFor(seat),
      } satisfies RejoinToClient);
      sendBlob(t, peer, SNAPSHOT_BLOB, JSON.stringify(data));
    });
    return true;
  }

  /** Host: the seat stays with the computer; the asking browser is told and let go. */
  refuseRejoin(seat: Seat): void {
    for (const [peer, s] of [...this.asks]) {
      if (s !== seat) continue;
      this.asks.delete(peer);
      this.askNames.delete(peer);
      this.o.transport.send(peer, { ch: 'lobby', k: 'refuse', why: 'denied', build: this.o.build } satisfies RejoinToClient);
      this.o.transport.kick(peer);
    }
  }

  /** Host: the lobby messages of a browser that is not playing — a returning player. */
  private desk(from: PeerId, msg: unknown): void {
    if (typeof msg !== 'object' || msg === null || (msg as { ch?: unknown }).ch !== 'lobby') return;
    if ([...this.seats.values()].includes(from)) return;
    const m = msg as RejoinToHost;
    const t = this.o.transport;
    if (m.k === 'hello') {
      if (m.build !== this.o.build) {
        t.send(from, { ch: 'lobby', k: 'refuse', why: 'version', build: this.o.build } satisfies RejoinToClient);
        t.kick(from);
        return;
      }
      const vacant = this.vacantSeats();
      const busy = [...this.seats.keys()].filter((s) => s !== this.local).sort((a, b) => a - b);
      if (vacant.length === 0 && busy.length === 0) {
        t.send(from, { ch: 'lobby', k: 'refuse', why: 'started', build: this.o.build } satisfies RejoinToClient);
        t.kick(from);
        return;
      }
      const names: [Seat, string][] = [];
      for (const s of [...vacant, ...busy]) {
        const name = this.nameOf(s);
        if (name) names.push([s, name]);
      }
      t.send(from, { ch: 'lobby', k: 'ingame', vacant, busy, names } satisfies RejoinToClient);
    } else if (m.k === 'rejoin' && Number.isInteger(m.seat) && this.vacantSeats().includes(m.seat)) {
      if (this.asks.get(from) === m.seat) return;
      const name = cleanName(m.name);
      this.asks.set(from, m.seat);
      if (name) this.askNames.set(from, name);
      else this.askNames.delete(from);
      this.hooks.rejoinAsked?.(m.seat, name);
    }
  }

  private endHostLost(): void {
    if (this.ended) return;
    this.ended = true;
    this.match.stop();
    this.hooks.hostLost?.();
  }

  /** Leaves the game: nothing more is played or sent; the caller closes the transport. */
  dispose(): void {
    this.ended = true;
    this.match.stop();
    for (const off of this.offs) off();
    this.status.dispose();
    this.chat.dispose();
    this.session.dispose();
    this.o.world.sendAhead = null;
  }
}

/** A returning browser's game: what the host sent, put together (`LobbyClient` builds it). */
export interface ResumeStart {
  start: NetStartBase;
  resume: ResumeInfo;
  chat: NetChatLine[];
  data: SaveData;
}

/** Who plays a seat of a loaded network game: a person, the computer, or nobody (passive). */
export type SeatControlKind = 'human' | 'ai' | 'none';

/**
 * A loaded network game's seats (roadmap 6.6), given by every browser before the first turn: the
 * computer takes the seats the host gave it, and lets go of those a person (or nobody) plays now —
 * it may have taken them before the save, when their player left.
 */
export function applySeatControls(world: World, control: readonly [Seat, SeatControlKind][]): void {
  for (const [seat, c] of control) world.apply({ kind: 'seatControl', player: seat, ai: c === 'ai' });
}
