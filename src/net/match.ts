import { TICKS_PER_SECOND } from '../sim/config';
import { CHECKSUM_SECTIONS, sectionChecksums } from '../sim/checksum';
import { LOCAL_ONLY, type Command } from '../sim/commands';
import { replayOf, type ReplayFile } from '../sim/replay';
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
 *   that left (the computer takes them over, `aiTakeover`), then every seat's batch in seat order,
 *   each command with its `player` set to the seat that sent it (never what the sender wrote). Every
 *   machine plays the same turns in the same order, so the same commands land between the same ticks.
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
 */

/** Ticks per turn (`N` in docs/NETWORK.md): 200 ms at 1×. */
export const TURN_TICKS = 2;
/** Turns between two checksums (`C`): once a second at 1×. */
export const CHECKSUM_EVERY = 5;
/** Speeds the host may set (the single-player strip offers the same). */
export const NET_SPEEDS: readonly number[] = [1, 2, 4];
/** How many checksums the match keeps for the desync report. */
const KEEP_SUMS = 40;

const TICK_MS = 1000 / TICKS_PER_SECOND;

/** A control in a batch: pause or resume (any player), a new speed (the host only). */
export type Control = { ctl: 'pause'; on: boolean } | { ctl: 'speed'; v: number };

const isControl = (x: unknown): x is Control => {
  if (typeof x !== 'object' || x === null) return false;
  const c = x as Record<string, unknown>;
  return (c.ctl === 'pause' && typeof c.on === 'boolean') || (c.ctl === 'speed' && typeof c.v === 'number');
};

/** Something that happened in a turn, for the interface (a toast, the status line). */
export type MatchEvent =
  | { kind: 'takeover'; seat: Seat; turn: number }
  | { kind: 'pause'; seat: Seat; on: boolean; turn: number }
  | { kind: 'speed'; seat: Seat; speed: number; turn: number };

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

  constructor(opts: MatchOptions) {
    this.opts = opts;
    this.world = opts.world;
    this.lockstep = opts.lockstep;
    this.turnTicks = opts.turnTicks ?? TURN_TICKS;
    this.checksumEvery = opts.checksumEvery ?? CHECKSUM_EVERY;
    this.sumOf = opts.checksum ?? netChecksum;
    // The world as generated: a different map shows up before the first command.
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

  /** Hands in the local batch (once a turn) and opens the next sealed turn, if there is one. */
  private open(): boolean {
    const ls = this.lockstep;
    if (ls.canSubmit()) ls.submit(this.outbox.splice(0));
    const turn = ls.next();
    if (!turn) return false;
    this.play(turn);
    this.openTurn = turn.turn;
    this.slots = this.turnTicks;
    this.stepping = !this.paused;
    return true;
  }

  /** Applies a sealed turn between two ticks, in its order. */
  private play(turn: Turn): void {
    const w = this.world;
    for (const seat of turn.dropped) {
      if (w.apply({ kind: 'aiTakeover', player: seat })) this.opts.onEvent?.({ kind: 'takeover', seat, turn: turn.turn });
    }
    for (const input of turn.inputs) {
      for (const item of input.cmds) {
        if (isControl(item)) this.controlFrom(input.seat, item, turn.turn);
        else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          const c: Record<string, unknown> = { ...(item as Record<string, unknown>), player: input.seat };
          delete c.tick;
          delete c.seq;
          // A batch may not grant goods or hand a seat to the computer; the rest is checked by `apply`.
          if (typeof c.kind === 'string' && LOCAL_ONLY.has(c.kind as Command['kind'])) continue;
          w.apply(c as unknown as Command);
        }
      }
    }
  }

  private controlFrom(seat: Seat, c: Control, turn: number): void {
    if (c.ctl === 'pause') {
      if (this.paused === c.on) return;
      this.paused = c.on;
      this.pausedBy = c.on ? seat : null;
      this.opts.onEvent?.({ kind: 'pause', seat, on: c.on, turn });
    } else if (seat === this.lockstep.host && NET_SPEEDS.includes(c.v) && c.v !== this.speed) {
      this.speed = c.v;
      this.opts.onEvent?.({ kind: 'speed', seat, speed: c.v, turn });
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
