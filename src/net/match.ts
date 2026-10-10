import { TICKS_PER_SECOND } from '../sim/config';
import { CHECKSUM_SECTIONS, sectionChecksums } from '../sim/checksum';
import { LOCAL_ONLY, type Command, type CommandRecord } from '../sim/commands';
import { replayOf, type ReplayFile } from '../sim/replay';
import { saveWorld, type SaveData } from '../sim/save';
import { World } from '../sim/world';
import type { DesyncReport, Lockstep, Seat, Turn } from './lockstep';

/**
 * A network game on one machine (roadmap 6.4, docs/NETWORK.md sections 2, 5 and 6): drives a `World`
 * by the sealed turns of a `Lockstep`. No DOM and no I/O — `main.ts` calls `advance` from its frame
 * loop (and from a timer while the tab is hidden), the transport feeds the lockstep.
 *
 * - **Turns.** Each turn is `turnTicks` ticks. Before the first tick of a turn the match hands in the
 *   local batch for turn + delay (`Lockstep.submit`, once per turn, possibly empty), takes the sealed
 *   turn (`Lockstep.next`; none → the game waits) and applies it between two ticks: first the seats
 *   that left (the computer takes them over, `aiTakeover`), then the seats whose player came back
 *   (`seatControl`, the computer lets go), then every seat's batch in seat order, each command with
 *   its `player` set to the seat that sent it (never what the sender wrote). Every machine plays the
 *   same turns in the same order, so the same commands land between the same ticks.
 * - **The local player's orders** reach the match through `World.sendAhead` (set by the caller to
 *   `queue`); the computer players think inside `World.step` on every machine and send nothing.
 * - **Pause and speed** are controls inside the batches, so they too take effect at one turn
 *   everywhere: any player may pause or resume (≈ S4, which has no pause in network games), only the
 *   host changes the speed. A paused turn still passes (so the order to resume can arrive) but steps
 *   no tick. The speed only sets how many turns a real second plays.
 * - **Checksums** (`sectionChecksums`, one sum per section joined) after every `checksumEvery`-th
 *   turn and once before turn 0 (turn −1: the generated map) go to `Lockstep.checksum`; the first
 *   mismatch stops the match (`onDesync`) and `report()` gives what is needed to find the cause.
 * - **Catching up:** a machine more than `delay` sealed turns behind plays them without waiting for
 *   real time (at most `maxTicks` a call), as the single-player loop does after a long frame.
 * - **Saving** (roadmap 6.6, Settlers 4's network event 4008): a player's `save` control is honoured
 *   at its turn on every machine, after the turn's commands, at most once per `saveEvery` ticks (S4's
 *   `CanSave`: 840 of its ticks, about a minute); every machine then takes the same `saveWorld` (the
 *   `save` event) — a request inside the minute is refused everywhere alike (`saveRefused`). The
 *   autosave (`autosaveEvery`) is the same event at a common turn, so it is a network save too.
 * - **Input delay** (6.7): the host's `delay` control sets `Lockstep.setDelay` at its turn everywhere.
 * - **A returning player** (6.7): the host asks for a `snapshot` — taken at the next turn boundary,
 *   before that turn's commands — for the returning browser, whose match starts with `resume`.
 */

/** Ticks per turn (`N` in docs/NETWORK.md): 200 ms at 1×. */
export const TURN_TICKS = 2;
/** Turns between two checksums (`C`): once a second at 1×. */
export const CHECKSUM_EVERY = 5;
/** Speeds the host may set (the single-player strip offers the same). */
export const NET_SPEEDS: readonly number[] = [1, 2, 4];
/** How many checksums the match keeps for the desync report. */
const KEEP_SUMS = 40;
/** Ticks between two network saves (Settlers 4's `CanSave`: 840 of its ticks, about a minute). */
export const SAVE_EVERY_TICKS = 60 * TICKS_PER_SECOND;
/** Longest save name (characters). */
export const SAVE_NAME_MAX = 40;
/** Command records a network save keeps (`NetSave.log`), for looking into a game later. */
const LOG_TAIL = 200;
/** The longest input delay the host may set (turns). */
export const MAX_NET_DELAY = 24;

const TICK_MS = 1000 / TICKS_PER_SECOND;

/**
 * A control in a batch: pause or resume and save (any player), a new speed or input delay (the host
 * only).
 */
export type Control =
  | { ctl: 'pause'; on: boolean }
  | { ctl: 'speed'; v: number }
  | { ctl: 'save'; name: string }
  | { ctl: 'delay'; v: number };

const isControl = (x: unknown): x is Control => {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    (c.ctl === 'pause' && typeof c.on === 'boolean') ||
    (c.ctl === 'speed' && typeof c.v === 'number') ||
    (c.ctl === 'save' && typeof c.name === 'string') ||
    (c.ctl === 'delay' && typeof c.v === 'number')
  );
};

/** A save name as asked for: one line, trimmed, at most `SAVE_NAME_MAX` characters. */
export function cleanSaveName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, SAVE_NAME_MAX) : '';
}

/** Something that happened in a turn, for the interface (a toast, the status line, a save). */
export type MatchEvent =
  | { kind: 'takeover'; seat: Seat; turn: number }
  | { kind: 'rejoin'; seat: Seat; turn: number }
  | { kind: 'pause'; seat: Seat; on: boolean; turn: number }
  | { kind: 'speed'; seat: Seat; speed: number; turn: number }
  | { kind: 'delay'; delay: number; turn: number }
  | { kind: 'save'; save: NetSave }
  | { kind: 'saveRefused'; seat: Seat; turn: number; wait: number };

/** A network save, the same on every machine: what goes into the save slots. */
export interface NetSave {
  /** Who asked (the autosave: the host's seat). */
  seat: Seat;
  turn: number;
  tick: number;
  name: string;
  auto: boolean;
  /** `netChecksum` of the saved world: equal saves have equal sums. */
  sum: string;
  speed: number;
  data: SaveData;
  /** The last commands applied, for looking into the game later. */
  log: CommandRecord[];
}

/** What the match itself holds beyond the world: a returning browser gets it with the snapshot. */
export interface MatchState {
  paused: boolean;
  pausedBy: Seat | null;
  speed: number;
  /** The tick of the last network save (null: none yet). */
  lastSave: number | null;
  /** The tick of the next autosave (null: none). */
  nextAutosave: number | null;
}

/** The game at a turn boundary, for a returning browser (roadmap 6.7). */
export interface Snapshot {
  /** The next turn to play: the world is as it was at the start of that turn, before its commands. */
  turn: number;
  /** The input delay then. */
  delay: number;
  /** The turns from `turn` on that were sealed already. */
  sealed: Turn[];
  match: MatchState;
  data: SaveData;
}

export interface MatchOptions {
  world: World;
  lockstep: Lockstep;
  turnTicks?: number;
  checksumEvery?: number;
  /** Turn → state checksum (default: the sections of `sectionChecksums`, joined). */
  checksum?: (w: World) => string;
  /** The first desync, seen on the next `advance`: the game stands still from here. */
  onDesync?: (report: DesyncReport) => void;
  onEvent?: (e: MatchEvent) => void;
  /** Ticks between two network saves (default `SAVE_EVERY_TICKS`). */
  saveEvery?: number;
  /** Ticks between two autosaves (none when absent). */
  autosaveEvery?: number;
  /** A browser joining a game under way: the match's state from the snapshot (no turn −1 checksum). */
  resume?: MatchState;
}

/** One checksum the match handed in. */
export interface SumRecord {
  turn: number;
  tick: number;
  sum: string;
}

/** What a player downloads after a desync (docs/NETWORK.md section 5); the interface adds its part. */
export interface DesyncFile {
  kind: 'settlers-desync';
  version: 1;
  seat: Seat;
  host: Seat;
  turnTicks: number;
  delay: number;
  /** The mismatch as the host saw it (null: the file was asked for without one). */
  desync: DesyncReport | null;
  /** The sections' names, in the order of the checksums. */
  sections: readonly string[];
  /** The last checksums this machine handed in (turn, tick, sum). */
  sums: SumRecord[];
  /** The world's tick now and its sections now. */
  tick: number;
  now: Record<string, string>;
  /** Seed, setup and every applied command: `tools/replay.ts` plays it again. */
  replay: ReplayFile | null;
}

/** The default network checksum: every section's sum, joined (equal states give equal strings). */
export const netChecksum = (w: World): string => {
  const s = sectionChecksums(w);
  return CHECKSUM_SECTIONS.map((k) => s[k]).join('.');
};

export class NetMatch {
  readonly world: World;
  readonly lockstep: Lockstep;
  readonly turnTicks: number;
  readonly checksumEvery: number;
  /** Paused at a common turn (and by whom). */
  paused = false;
  pausedBy: Seat | null = null;
  /** Game speed (×1 as in Settlers 4; the host may change it). */
  speed = 1;
  /** Stopped for good: a desync, or the caller ended it (`stop`). */
  stopped = false;
  /** Real time spent waiting for a turn that is not sealed (ms; 0 while the game runs). */
  waitingMs = 0;
  /** The checksums handed in, the latest last (at most `KEEP_SUMS`). */
  readonly sums: SumRecord[] = [];
  private readonly opts: MatchOptions;
  private readonly sumOf: (w: World) => string;
  /** Game time owed to the simulation, in ms (scaled by the speed). */
  private acc = 0;
  /** Ticks left in the open turn, and whether it steps them (not when paused). */
  private slots = 0;
  private stepping = true;
  private openTurn = -1;
  /** Local orders and controls waiting for the next batch. */
  private outbox: unknown[] = [];
  private desyncSeen = false;
  private lastSave: number | null = null;
  private nextAutosave: number | null = null;
  /** Snapshots asked for, taken at the next turn boundary. */
  private snapshotsDue: ((s: Snapshot) => void)[] = [];

  constructor(opts: MatchOptions) {
    this.opts = opts;
    this.world = opts.world;
    this.lockstep = opts.lockstep;
    this.turnTicks = opts.turnTicks ?? TURN_TICKS;
    this.checksumEvery = opts.checksumEvery ?? CHECKSUM_EVERY;
    this.sumOf = opts.checksum ?? netChecksum;
    const r = opts.resume;
    if (r) {
      this.paused = r.paused;
      this.pausedBy = r.pausedBy;
      this.speed = r.speed;
      this.lastSave = r.lastSave;
      this.nextAutosave = r.nextAutosave;
      this.openTurn = opts.lockstep.turn - 1;
      return;
    }
    if (opts.autosaveEvery) this.nextAutosave = this.world.tick + opts.autosaveEvery;
    // The world as generated (or loaded): a different map shows up before the first command.
    this.handIn(-1);
  }

  /** The local player's order, played in a later turn on every machine (`World.sendAhead`). */
  queue(cmd: Command): void {
    if (!this.stopped) this.outbox.push(cmd);
  }

  /** Pause or resume for everybody (at a common turn). */
  setPaused(on: boolean): void {
    this.control({ ctl: 'pause', on });
  }

  /** Host: another speed for everybody (others' requests are ignored by every machine). */
  setSpeed(v: number): void {
    if (this.lockstep.isHost) this.control({ ctl: 'speed', v });
  }

  /** Asks every machine to save the game at a common turn (refused everywhere inside the minute). */
  requestSave(name: string): void {
    this.control({ ctl: 'save', name: cleanSaveName(name) });
  }

  /** Host: another input delay for everybody, from the turn the control lands in. */
  setDelay(v: number): void {
    if (this.lockstep.isHost && Number.isInteger(v) && v >= 1 && v <= MAX_NET_DELAY) this.control({ ctl: 'delay', v });
  }

  /**
   * Host: a snapshot of the game for a returning browser, taken at the next turn boundary (before
   * that turn's commands) and handed to `done`.
   */
  snapshot(done: (s: Snapshot) => void): void {
    if (!this.stopped) this.snapshotsDue.push(done);
  }

  /** The match's own state (for a snapshot). */
  state(): MatchState {
    return { paused: this.paused, pausedBy: this.pausedBy, speed: this.speed, lastSave: this.lastSave, nextAutosave: this.nextAutosave };
  }

  private control(c: Control): void {
    if (!this.stopped) this.outbox.push(c);
  }

  /** How far into the next tick the game is (0…1), for the renderer's interpolation. */
  get alpha(): number {
    return this.stepping && !this.paused ? Math.min(1, this.acc / TICK_MS) : 0;
  }

  /** Whether the game stands waiting for a turn (a slow or missing player). */
  get waiting(): boolean {
    return this.waitingMs > 0;
  }

  /** The turn being played (−1 before the first). */
  get turn(): number {
    return this.openTurn;
  }

  /**
   * Lets `dtMs` of real time pass: plays the turns due (at most `maxTicks` ticks). Returns the ticks
   * the world stepped (a paused turn steps none but passes its time).
   */
  advance(dtMs: number, maxTicks = 20): number {
    this.checkDesync();
    if (this.stopped) return 0;
    this.acc += dtMs * this.speed;
    let n = 0;
    let stepped = 0;
    while (n < maxTicks && !this.stopped) {
      const behind = this.lockstep.buffered() > this.lockstep.delay;
      if (this.acc < TICK_MS && !behind) break;
      if (this.slots === 0 && !this.open()) {
        // Nothing sealed: wait, and do not save up game time meanwhile.
        this.waitingMs += dtMs;
        this.acc = Math.min(this.acc, TICK_MS);
        return stepped;
      }
      this.waitingMs = 0;
      if (this.stepping) {
        this.world.step();
        stepped++;
      }
      this.acc = Math.max(0, this.acc - TICK_MS);
      this.slots--;
      n++;
      if (this.slots === 0) this.close();
      this.checkDesync();
    }
    if (n === maxTicks) this.acc = Math.min(this.acc, TICK_MS);
    return stepped;
  }

  /** Ends the match on this machine (host gone, game left): nothing more is played or sent. */
  stop(): void {
    this.stopped = true;
    this.outbox = [];
    this.snapshotsDue = [];
  }

  /** The desync the lockstep found, once: the match stops and tells `onDesync`. */
  private checkDesync(): void {
    const d = this.lockstep.desync;
    if (!d || this.desyncSeen) return;
    this.desyncSeen = true;
    this.stop();
    this.opts.onDesync?.(d);
  }

  /** The desync report of this machine (docs/NETWORK.md section 5). */
  report(): DesyncFile {
    return {
      kind: 'settlers-desync',
      version: 1,
      seat: this.lockstep.local,
      host: this.lockstep.host,
      turnTicks: this.turnTicks,
      delay: this.lockstep.delay,
      desync: this.lockstep.desync,
      sections: CHECKSUM_SECTIONS,
      sums: this.sums.slice(),
      tick: this.world.tick,
      now: sectionChecksums(this.world),
      replay: replayOf(this.world),
    };
  }

  /**
   * Hands in the local batch (once a turn; after the delay grew, empty ones fill the gap) and opens
   * the next sealed turn, if there is one. Snapshots asked for are taken first: the world stands
   * between two turns here.
   */
  private open(): boolean {
    const ls = this.lockstep;
    if (this.snapshotsDue.length > 0) this.takeSnapshots();
    for (let first = true; ls.canSubmit(); first = false) ls.submit(first ? this.outbox.splice(0) : []);
    const turn = ls.next();
    if (!turn) return false;
    this.play(turn);
    this.openTurn = turn.turn;
    this.slots = this.turnTicks;
    this.stepping = !this.paused;
    return true;
  }

  private takeSnapshots(): void {
    const ls = this.lockstep;
    const snap: Snapshot = { turn: ls.turn, delay: ls.delay, sealed: ls.sealedFrom(ls.turn), match: this.state(), data: saveWorld(this.world) };
    for (const done of this.snapshotsDue.splice(0)) done(snap);
  }

  /** Applies a sealed turn between two ticks, in its order. */
  private play(turn: Turn): void {
    const w = this.world;
    for (const seat of turn.dropped) {
      if (w.apply({ kind: 'aiTakeover', player: seat })) this.opts.onEvent?.({ kind: 'takeover', seat, turn: turn.turn });
    }
    // A returning player plays again: the computer lets the seat go (if it had taken it).
    for (const seat of turn.rejoined ?? []) {
      w.apply({ kind: 'seatControl', player: seat, ai: false });
      this.opts.onEvent?.({ kind: 'rejoin', seat, turn: turn.turn });
    }
    const saves: { seat: Seat; name: string }[] = [];
    for (const input of turn.inputs) {
      for (const item of input.cmds) {
        if (isControl(item)) {
          if (item.ctl === 'save') saves.push({ seat: input.seat, name: cleanSaveName(item.name) });
          else this.controlFrom(input.seat, item, turn.turn);
        } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const c: Record<string, unknown> = { ...(item as Record<string, unknown>), player: input.seat };
          delete c.tick;
          delete c.seq;
          // A batch may not grant goods or hand a seat to the computer; the rest is checked by `apply`.
          if (typeof c.kind === 'string' && LOCAL_ONLY.has(c.kind as Command['kind'])) continue;
          w.apply(c as unknown as Command);
        }
      }
    }
    // Saves after the turn's commands, so the orders of this turn are in them.
    for (const s of saves) this.saveFor(s.seat, s.name, turn.turn);
    if (this.nextAutosave !== null && w.tick >= this.nextAutosave) {
      this.nextAutosave = w.tick + (this.opts.autosaveEvery ?? 0);
      this.emitSave(this.lockstep.host, '', turn.turn, true);
    }
  }

  /** A player's save request at a turn: honoured once a minute, the same on every machine. */
  private saveFor(seat: Seat, name: string, turn: number): void {
    const every = this.opts.saveEvery ?? SAVE_EVERY_TICKS;
    const tick = this.world.tick;
    if (this.lastSave !== null && tick - this.lastSave < every) {
      this.opts.onEvent?.({ kind: 'saveRefused', seat, turn, wait: every - (tick - this.lastSave) });
      return;
    }
    this.lastSave = tick;
    this.emitSave(seat, name, turn, false);
  }

  private emitSave(seat: Seat, name: string, turn: number, auto: boolean): void {
    const w = this.world;
    const save: NetSave = {
      seat,
      turn,
      tick: w.tick,
      name,
      auto,
      sum: netChecksum(w),
      speed: this.speed,
      data: saveWorld(w),
      log: w.commandLog.slice(-LOG_TAIL),
    };
    this.opts.onEvent?.({ kind: 'save', save });
  }

  private controlFrom(seat: Seat, c: Control, turn: number): void {
    if (c.ctl === 'pause') {
      if (this.paused === c.on) return;
      this.paused = c.on;
      this.pausedBy = c.on ? seat : null;
      this.opts.onEvent?.({ kind: 'pause', seat, on: c.on, turn });
    } else if (c.ctl === 'speed') {
      if (seat !== this.lockstep.host || !NET_SPEEDS.includes(c.v) || c.v === this.speed) return;
      this.speed = c.v;
      this.opts.onEvent?.({ kind: 'speed', seat, speed: c.v, turn });
    } else if (c.ctl === 'delay') {
      if (seat !== this.lockstep.host || !Number.isInteger(c.v) || c.v < 1 || c.v > MAX_NET_DELAY || c.v === this.lockstep.delay) return;
      this.lockstep.setDelay(c.v);
      this.opts.onEvent?.({ kind: 'delay', delay: c.v, turn });
    }
  }

  /** After a turn's last tick: its checksum when due. */
  private close(): void {
    if (this.openTurn % this.checksumEvery === this.checksumEvery - 1) this.handIn(this.openTurn);
  }

  private handIn(turn: number): void {
    const sum = this.sumOf(this.world);
    this.sums.push({ turn, tick: this.world.tick, sum });
    if (this.sums.length > KEEP_SUMS) this.sums.shift();
    this.lockstep.checksum(turn, sum);
  }
}

/** One checksum of a report, played again: does the replay reach the same sum at that tick? */
export interface SumCheck {
  turn: number;
  tick: number;
  ok: boolean;
  /** The sections that differ (`CHECKSUM_SECTIONS` names). */
  differ: string[];
}

/**
 * Plays a desync report's replay (`tools/replay.ts`) and checks every checksum its browser handed in.
 * The replay holds only commands, so where the browser's own state went astray (a bug that is not
 * deterministic, a corrupted value) the first failing check shows the tick and the sections.
 */
export function replaySums(file: DesyncFile, onTick?: (w: World) => void): SumCheck[] {
  const r = file.replay;
  if (!r) return [];
  const want = new Map(file.sums.map((s) => [s.tick, s]));
  const out: SumCheck[] = [];
  const w = new World(r.seed, { ...r.options, replay: r.log });
  const check = () => {
    const s = want.get(w.tick);
    if (!s) return;
    const got = netChecksum(w).split('.');
    const exp = s.sum.split('.');
    const differ = CHECKSUM_SECTIONS.filter((_, k) => got[k] !== exp[k]);
    out.push({ turn: s.turn, tick: w.tick, ok: differ.length === 0, differ });
  };
  check();
  while (w.tick < r.ticks) {
    w.step();
    check();
    onTick?.(w);
  }
  return out;
}
