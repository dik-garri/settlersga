import { saveWorld, type SaveData } from '../sim/save';
import { World } from '../sim/world';
import { BlobReceiver, sendBlob } from './blob';
import { NetChat, type ChatTo, type NetChatLine, type SayResult } from './chat';
import { DelayTuner } from './delay';
import type { DesyncReport, Seat } from './lockstep';
import { NetMatch, type DesyncFile, type MatchEvent, type MatchState, type Snapshot } from './match';
import { cleanName } from './names';
import { bindLockstep, type LockstepSession, type SessionOptions } from './session';
import { NetStatus } from './status';
import type { PeerId, Transport } from './transport';
import { NetVoice, type VoiceFrame } from './voice';

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
 *
 * **Restore after a desync** («Восстановить с хоста», docs/NETWORK.md section 17): the desync stops
 * the game everywhere and every browser keeps its report (`reports`). Then the host's player (or any
 * player, by asking the host: `ask`) starts the game over from the host's world — the host is the
 * source of truth, as the hub of the star, even when the others agree among themselves. The host
 * drops its stopped match and starts a new lockstep (`Lockstep` `restart`: from its next turn, the
 * turns it had sealed kept, the delay as it was) under a new epoch, which every lockstep envelope
 * carries so nothing of the old one is mistaken for the new; every playing browser gets `restore`
 * and the world in pieces, loads it as a new `World` and starts the same lockstep and match. The
 * first checksum, before the first turn, confirms that all hold the same; a desync after that is
 * found as any other and is restored again only when somebody asks.
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
  /** How many times the game had started over from the host's state (absent: never): the lockstep's epoch. */
  epoch?: number;
}

/** The rejoin messages on the lobby channel (the returning browser runs a `LobbyClient`). */
export type RejoinToHost = { ch: 'lobby'; k: 'hello'; build: string; seat?: Seat; name?: string } | { ch: 'lobby'; k: 'rejoin'; seat: Seat; name?: string };
export type RejoinToClient =
  | { ch: 'lobby'; k: 'ingame'; vacant: Seat[]; busy: Seat[]; names: [Seat, string][] }
  | { ch: 'lobby'; k: 'refuse'; why: 'version' | 'started' | 'denied'; build: string }
  | { ch: 'lobby'; k: 'resume'; start: NetStartBase; resume: ResumeInfo; chat: NetChatLine[] };

/** The name the snapshot's save travels under (`sendBlob`). */
export const SNAPSHOT_BLOB = 'snapshot';

/** The name the host's state travels under in a restore (`sendBlob`), by the restore's epoch. */
export const restoreBlob = (epoch: number): string => `restore:${epoch}`;

/**
 * The restore messages (channel `rs`, docs/NETWORK.md section 17): a player asks the host to start
 * the game over from its state (`ask`, with the epoch he plays in); the host tells every playing
 * browser where the new lockstep starts (`restore`), then sends its world in pieces.
 */
export type RestoreMsg =
  | { ch: 'rs'; k: 'ask'; epoch: number }
  | { ch: 'rs'; k: 'restore'; epoch: number; snap: Omit<Snapshot, 'data'>; active: Seat[] };

const isRestoreMsg = (x: unknown): x is RestoreMsg => {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m.ch !== 'rs' || !Number.isInteger(m.epoch)) return false;
  if (m.k === 'ask') return true;
  if (m.k !== 'restore' || !Array.isArray(m.active) || typeof m.snap !== 'object' || m.snap === null) return false;
  const snap = m.snap as Record<string, unknown>;
  return (
    Number.isInteger(snap.turn) &&
    Number.isInteger(snap.delay) &&
    (snap.delay as number) >= 1 &&
    Array.isArray(snap.sealed) &&
    typeof snap.match === 'object' &&
    snap.match !== null
  );
};

export interface NetCoreHooks {
  /** Something happened at a turn (a takeover, a return, the pause, a save…). */
  event?(e: MatchEvent): void;
  desync?(report: DesyncReport): void;
  /** Client: the host is gone. */
  hostLost?(): void;
  /** A chat line this browser may read. */
  chat?(line: NetChatLine): void;
  /** A voice frame for this browser to play (the radio, `voice.ts`). */
  voice?(frame: VoiceFrame): void;
  /**
   * Host: a player who left asks for his seat back — answer with `acceptRejoin`/`refuseRejoin`.
   * `name` is the name he gives now (null: none), to compare with the seat's (`nameOf`).
   */
  rejoinAsked?(seat: Seat, name: string | null): void;
  /** Host: a seat's player left. */
  seatLeft?(seat: Seat): void;
  /**
   * Client: the game is being restored from the host's state (docs/NETWORK.md section 17) — asked,
   * nothing came yet (`progress` null), or the state is coming in (0…1). Also null once more if the
   * state that came could not be loaded (`restoring` is false then).
   */
  restoring?(progress: number | null): void;
  /** Host: a player asks to restore the game from the host's state (the host starts at once). */
  restoreAsked?(seat: Seat): void;
  /**
   * The game started over from the host's state at `turn` (`epoch`: how many times so far): a
   * client plays a new `World` from here on (the old one is dropped), the host its own.
   */
  restored?(world: World, epoch: number, turn: number): void;
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
  readonly status: NetStatus;
  readonly chat: NetChat;
  /** The radio: voice frames straight through the relay (or through the host), outside the lockstep. */
  readonly voice: NetVoice;
  hooks: NetCoreHooks;
  /** The host is gone (client) or the game was left: nothing more is played. */
  ended = false;
  /**
   * The desync reports of this game, one per desync, taken when it was found (before any restore):
   * what a player downloads to look for the cause, also after the game went on.
   */
  readonly reports: DesyncFile[] = [];
  /** Client: asked the host to restore, or its state is on the way (the game stands meanwhile). */
  restoring = false;
  /** The world played now (a client's is a new one after each restore). */
  private worldNow: World;
  private sessionNow: LockstepSession;
  private matchNow: NetMatch;
  /** How many times the game started over from the host's state. */
  private epochNo = 0;
  /** The epoch whose desync report is taken already (−1: none). */
  private reportedEpoch = -1;
  /** Client: the restore the host announced, waiting for its state. */
  private pendingRestore: Extract<RestoreMsg, { k: 'restore' }> | null = null;
  private readonly blobs: BlobReceiver | null = null;
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
    this.worldNow = world;
    const r = o.resume;
    this.epochNo = r?.epoch ?? 0;
    this.sessionNow = this.bind({
      delay: r ? r.snap.delay : o.start.delay,
      resume: r ? { turn: r.snap.turn, input: r.input, sealed: r.snap.sealed } : undefined,
      active: r?.active,
    });
    this.matchNow = this.makeMatch({ resume: r?.snap.match });
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
      allied: (a, b) => this.world.allied(a, b),
      history: o.chat,
      onLine: (line) => this.hooks.chat?.(line),
    });
    this.voice = new NetVoice({
      transport,
      seats: this.seats,
      local,
      now: o.now,
      hostNow: () => {
        if (transport.isHost) return o.now();
        const off = this.status.meter.offset(transport.host);
        return off === null ? null : o.now() + off;
      },
      allied: (a, b) => this.world.allied(a, b),
      present: (seat) => this.world.aiLevel(seat) === null,
      onFrame: (frame) => this.hooks.voice?.(frame),
    });
    // Seats nobody plays from the start (a loaded game): free to take for the grace period.
    for (const seat of o.humanSeats ?? []) if (!this.seats.has(seat)) this.leftAt.set(seat, o.now());
    if (this.isHost) {
      this.offs.push(
        transport.on('message', (from, msg) => {
          if (isRestoreMsg(msg)) this.restoreAsk(from, msg);
          else this.desk(from, msg);
        }),
        transport.on('leave', (peer) => {
          this.asks.delete(peer);
          this.askNames.delete(peer);
        }),
      );
    } else {
      // The host's state in a restore: announced on the `rs` channel, then sent in pieces.
      this.offs.push(
        transport.on('message', (from, msg) => {
          if (from === transport.host && isRestoreMsg(msg) && msg.k === 'restore') this.restoreAnnounced(msg);
        }),
      );
      this.blobs = new BlobReceiver(
        transport,
        transport.host,
        (id, text) => this.restoreArrived(id, text),
        (id, got, of) => {
          if (this.pendingRestore && id === restoreBlob(this.pendingRestore.epoch)) this.hooks.restoring?.(got / of);
        },
      );
    }
    // Turns sealed between the snapshot and now: ask for them at once.
    if (r) this.session.lockstep.want();
  }

  /** The world played now (a client's is a new one after each restore). */
  get world(): World {
    return this.worldNow;
  }

  /** The lockstep session now (a new one after each restore). */
  get session(): LockstepSession {
    return this.sessionNow;
  }

  /** The match now (a new one after each restore). */
  get match(): NetMatch {
    return this.matchNow;
  }

  /** How many times the game started over from the host's state. */
  get epoch(): number {
    return this.epochNo;
  }

  /** Whether the lockstep found a desync (the game stands until it is restored or left). */
  get desynced(): boolean {
    return this.session.lockstep.desync !== null;
  }

  private bind(o: Pick<SessionOptions, 'delay' | 'resume' | 'active' | 'restart'>): LockstepSession {
    return bindLockstep(this.o.transport, {
      ...o,
      seats: this.seats,
      epoch: this.epochNo,
      onHostLost: () => this.endHostLost(),
      onSeatLeft: (seat) => {
        this.leftAt.set(seat, this.o.now());
        this.hooks.seatLeft?.(seat);
      },
    });
  }

  private makeMatch(o: { resume?: MatchState; verify?: boolean; base?: SaveData }): NetMatch {
    return new NetMatch({
      world: this.world,
      lockstep: this.session.lockstep,
      turnTicks: this.o.start.turnTicks,
      checksumEvery: this.o.start.checksumEvery,
      autosaveEvery: this.o.autosaveEvery,
      epoch: this.epochNo,
      ...o,
      onDesync: (rep) => {
        this.keepReport();
        this.hooks.desync?.(rep);
      },
      onEvent: (e) => this.hooks.event?.(e),
    });
  }

  /** Takes this epoch's desync report, once (the world as it stood when the desync was found). */
  private keepReport(): void {
    if (this.reportedEpoch === this.epochNo || !this.desynced) return;
    this.reportedEpoch = this.epochNo;
    this.reports.push(this.match.report());
  }

  /**
   * «Восстановить с хоста» after a desync (docs/NETWORK.md section 17): the host starts the game over
   * from its state at once; a client asks the host to (it starts at once too). False when there is
   * no desync to restore from, or the game is over.
   */
  requestRestore(): boolean {
    if (this.ended || !this.desynced) return false;
    if (this.isHost) return this.restoreAll();
    this.o.transport.send(this.o.transport.host, { ch: 'rs', k: 'ask', epoch: this.epochNo } satisfies RestoreMsg);
    if (!this.restoring) {
      this.restoring = true;
      this.hooks.restoring?.(null);
    }
    return true;
  }

  /**
   * Host: every browser starts over from the host's world as it stands (the host is the source of
   * truth, whoever agreed with whom): a new lockstep from the next turn — the turns sealed already
   * kept, the delay as it is —, every playing browser gets the world and plays a new one from it.
   */
  private restoreAll(): boolean {
    if (!this.isHost || this.ended || !this.desynced) return false;
    this.keepReport();
    const old = this.match;
    const ls = old.lockstep;
    old.stop();
    const snap: Omit<Snapshot, 'data'> = { turn: ls.turn, delay: ls.delay, sealed: ls.sealedFrom(ls.turn), match: old.state() };
    const active = ls.activeSeats();
    const data = JSON.stringify(saveWorld(this.world));
    this.epochNo++;
    const t = this.o.transport;
    for (const seat of active) {
      const peer = this.seats.get(seat);
      if (seat === this.local || peer === undefined || !t.peers().includes(peer)) continue;
      t.send(peer, { ch: 'rs', k: 'restore', epoch: this.epochNo, snap, active } satisfies RestoreMsg);
      sendBlob(t, peer, restoreBlob(this.epochNo), data);
    }
    this.startOver(this.world, snap, active);
    return true;
  }

  /** Host: a playing browser asks for a restore of the epoch it plays in (a stale ask is ignored). */
  private restoreAsk(from: PeerId, m: RestoreMsg): void {
    const seat = [...this.seats].find(([, p]) => p === from)?.[0];
    if (m.k !== 'ask' || seat === undefined || m.epoch !== this.epochNo || !this.desynced) return;
    this.hooks.restoreAsked?.(seat);
    this.restoreAll();
  }

  /** Client: the host restores: the game stands until its state is here. */
  private restoreAnnounced(m: Extract<RestoreMsg, { k: 'restore' }>): void {
    if (this.ended || m.epoch <= this.epochNo || !m.active.includes(this.local)) return;
    this.keepReport();
    this.match.stop();
    this.pendingRestore = m;
    this.restoring = true;
    this.hooks.restoring?.(0);
  }

  /** Client: the host's state is here: a new world, lockstep and match from it. */
  private restoreArrived(id: string, text: string): void {
    const m = this.pendingRestore;
    if (!m || id !== restoreBlob(m.epoch) || this.ended) return;
    this.pendingRestore = null;
    let world: World;
    let data: SaveData;
    try {
      data = JSON.parse(text) as SaveData;
      world = World.load(data);
    } catch (e) {
      // A broken state: the game stays stopped (the desync window stays up).
      console.error(e);
      this.restoring = false;
      this.hooks.restoring?.(null);
      return;
    }
    this.epochNo = m.epoch;
    this.startOver(world, m.snap, m.active, data);
  }

  /** Every machine: the new lockstep and match over `world` (a client's new one, the host's own). */
  private startOver(world: World, snap: Omit<Snapshot, 'data'>, active: Seat[], base?: SaveData): void {
    this.session.dispose();
    this.world.sendAhead = null;
    this.worldNow = world;
    this.sessionNow = this.bind({ delay: snap.delay, restart: { turn: snap.turn, sealed: snap.sealed }, active });
    this.matchNow = this.makeMatch({ resume: snap.match, verify: true, base });
    world.sendAhead = (cmd) => this.match.queue(cmd);
    this.restoring = false;
    this.hooks.restored?.(world, this.epochNo, snap.turn);
  }

  /** Plays `dtMs` of real time (at most `maxTicks` ticks); the status, the delay and resends too. */
  pump(dtMs: number, maxTicks = 20): number {
    this.status.update();
    this.voice.update();
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
      if (active.has(seat) || seat === this.hostSeat || now - at > REJOIN_GRACE_MS || this.world.isDefeated(seat)) continue;
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
    // Not while the game stands after a desync: its snapshot would never be taken.
    if (!this.isHost || !peer || this.match.stopped || !this.vacantSeats().includes(seat)) return false;
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
      const resume: ResumeInfo = { snap: rest, input, active: this.session.lockstep.activeSeats(), ...(this.epochNo ? { epoch: this.epochNo } : {}) };
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
    this.blobs?.dispose();
    this.status.dispose();
    this.chat.dispose();
    this.voice.dispose();
    this.session.dispose();
    this.world.sendAhead = null;
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
