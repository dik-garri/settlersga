/**
 * The lockstep scheduler of phase 6 (docs/NETWORK.md), pure and independent of `World`: it only
 * moves opaque command batches. Game time is cut into turns of a few ticks. Each human seat hands
 * in exactly one batch per turn (possibly empty), `delay` turns ahead of the turn being played:
 * what a player orders while turn t runs is played in turn t + delay on every browser.
 *
 * Host-authoritative order (a star, as the transport): clients send their batch to the host; the
 * host, once it holds every active seat's batch for the next turn, seals the turn — batches sorted
 * by seat, each in the order it was issued, plus the seats that left from this turn on — and sends
 * it to everyone. Every peer plays exactly the sealed turns, in turn order, so the order is the
 * same everywhere by construction, and the host alone decides when a departed player's seat goes
 * over to the computer (`dropped`). A turn that is not sealed yet (a slow or missing seat) stalls
 * every peer: `next()` returns null and `waitingFor()` says who is late.
 *
 * Desync check: after playing a turn a peer may hand its state checksum to `checksum`; clients send
 * theirs to the host, which compares them with its own and with each other and, on the first
 * mismatch, tells everyone (`desync` message, `onDesync`).
 *
 * Changes on the way (roadmap 6.7): the delay may change at a turn every machine plays (`setDelay`,
 * from the host's control in a batch): a longer one makes a seat hand in empty batches to fill the
 * gap, a shorter one makes it skip handing in until play catches up — a batch already on its way is
 * never dropped. A returning player's seat becomes active again from the next turn the host seals
 * (`rejoin`, announced as `rejoined`); its browser starts from a snapshot with `resume`. The host
 * keeps the turns it sealed for a while (`history`) and sends them again to a browser that asks
 * (`want`): one that was cut off for a moment, or that loaded a snapshot, catches up from there.
 * Duplicate and late messages are ignored.
 *
 * The module does no I/O: `send` is a callback (bound to a transport by `session.ts`) and incoming
 * messages are fed to `receive`. Seats are player ids (1-based, as the simulation's `PlayerId`).
 */

export type Seat = number;

/** One seat's batch for a turn: the commands it issued, in order. Opaque JSON for this module. */
export interface SeatInput {
  seat: Seat;
  cmds: unknown[];
}

/** A sealed turn: what every peer plays, in this order. */
export interface Turn {
  turn: number;
  /** Batches of every seat that was active for this turn, sorted by seat. */
  inputs: SeatInput[];
  /** Seats that left the game: from this turn on the computer plays them (sorted). */
  dropped: Seat[];
  /** Seats whose player came back: from this turn on they play again (sorted). */
  rejoined: Seat[];
}

/** The lockstep messages on the wire (namespaced by `session.ts`). */
export type LockstepMsg =
  /** Client → host: my batch for `turn` (the sender is the seat; the transport says who sent it). */
  | { k: 'in'; turn: number; cmds: unknown[] }
  /** Host → clients: a sealed turn. */
  | { k: 'turn'; turn: number; inputs: SeatInput[]; dropped: Seat[]; rejoined?: Seat[] }
  /** Client → host: send me again every sealed turn from `from` on (I missed some, or I just loaded). */
  | { k: 'want'; from: number }
  /** Client → host: my state checksum after playing `turn`. */
  | { k: 'sum'; turn: number; sum: string | number }
  /** Host → clients: the checksums after `turn` differ (`agreed`: the last turn everyone agreed on). */
  | { k: 'desync'; turn: number; sums: [Seat, string | number][]; agreed?: number | null };

export interface DesyncReport {
  /** The first turn whose checksums differ. */
  turn: number;
  /** Every checksum known for that turn, by seat. */
  sums: [Seat, string | number][];
  /** The last turn whose checksums every active seat handed in and agreed on (null: none yet). */
  agreed: number | null;
}

export interface LockstepOptions {
  /** The human seats taking part (computer seats hand in nothing). */
  seats: Seat[];
  /** This browser's seat. */
  local: Seat;
  /** The host's seat. */
  host: Seat;
  /** Input delay in turns (≥ 1): a batch handed in while turn t is next is played in turn t + delay. */
  delay: number;
  /** Sends a message: to a seat, or (host only) `'all'` = every client. */
  send: (to: Seat | 'all', msg: LockstepMsg) => void;
  /** Called once, on every peer, when the first checksum mismatch is known. */
  onDesync?: (report: DesyncReport) => void;
  /** How many turns of checksums the host keeps waiting for late ones (default 64). */
  keepSums?: number;
  /** How many sealed turns the host keeps to send again (default `HISTORY`). */
  history?: number;
  /**
   * A browser joining a game under way (a reconnect): `turn` is the next turn to play (its world is
   * the snapshot taken at the start of that turn), `input` the first turn it hands a batch in for,
   * `sealed` the turns from `turn` on the host had sealed already.
   */
  resume?: { turn: number; input: number; sealed: Turn[] };
}

/** Sealed turns the host keeps for resending: two minutes at 1×. */
export const HISTORY = 600;
/** Most turns one resend carries. */
const RESEND_MAX = 200;

const seatList = (x: unknown): Seat[] => (Array.isArray(x) ? x.filter((s): s is Seat => Number.isInteger(s)) : []);

export class Lockstep {
  readonly local: Seat;
  readonly host: Seat;
  readonly isHost: boolean;
  /** The input delay now (turns). */
  private delayNo: number;
  /** The next turn to play. */
  private turnNo = 0;
  /** The turn the next local batch is for. */
  private inputNo: number;
  /** Sealed turns not played yet, by turn. */
  private sealed = new Map<number, Turn>();
  /** Host: seats still handing in batches. */
  private active: Set<Seat>;
  /** Host: batches received, by turn, then seat. */
  private inbox = new Map<number, Map<Seat, unknown[]>>();
  /** Host: the next turn to seal. */
  private sealNo = 0;
  /** Host: seats that left and are announced in the next sealed turn. */
  private leaving: Seat[] = [];
  /** Host: seats that came back and are announced in the next sealed turn. */
  private rejoining: Seat[] = [];
  /** Host: the turns sealed lately, for resending (`want`). */
  private history = new Map<number, Turn>();
  /** Host: checksums by turn, then seat. */
  private sums = new Map<number, Map<Seat, string | number>>();
  private desynced: DesyncReport | null = null;
  /** Host: the last turn every active seat's checksum agreed on. */
  private agreedNo: number | null = null;
  private opts: LockstepOptions;

  constructor(opts: LockstepOptions) {
    if (!Number.isInteger(opts.delay) || opts.delay < 1) throw new Error('lockstep delay must be a whole number ≥ 1');
    if (!opts.seats.includes(opts.local) || !opts.seats.includes(opts.host)) throw new Error('local and host seats must take part');
    this.opts = opts;
    this.local = opts.local;
    this.host = opts.host;
    this.delayNo = opts.delay;
    this.isHost = opts.local === opts.host;
    this.active = new Set(opts.seats);
    const r = opts.resume;
    if (r) {
      this.turnNo = r.turn;
      this.inputNo = r.input;
      for (const t of r.sealed) if (t.turn >= r.turn) this.sealed.set(t.turn, t);
      this.sealNo = r.input;
      return;
    }
    this.inputNo = opts.delay;
    // The first `delay` turns carry nothing from anyone: everybody knows them sealed and empty.
    const seats = [...opts.seats].sort((a, b) => a - b);
    for (let t = 0; t < opts.delay; t++) this.keep({ turn: t, inputs: seats.map((seat) => ({ seat, cmds: [] })), dropped: [], rejoined: [] });
    this.sealNo = opts.delay;
  }

  /** The input delay now (turns). */
  get delay(): number {
    return this.delayNo;
  }

  /**
   * Another input delay, from the turn being played on (every machine calls it at the same turn: the
   * host's control in a batch). Longer: the next hand-ins fill the gap with empty batches; shorter:
   * hand-ins wait until play catches up. Batches already handed in stay where they are.
   */
  setDelay(v: number): void {
    if (Number.isInteger(v) && v >= 1) this.delayNo = v;
  }

  /** The next turn to play. */
  get turn(): number {
    return this.turnNo;
  }

  /** The turn the next local batch will be played in. */
  get inputTurn(): number {
    return this.inputNo;
  }

  /** Host: the last turn every active seat's checksum agreed on (null: none yet). */
  get agreed(): number | null {
    return this.agreedNo;
  }

  /** The first desync seen, if any. */
  get desync(): DesyncReport | null {
    return this.desynced;
  }

  /** Whether the local seat may hand in its next batch (at most `delay` turns ahead of play). */
  canSubmit(): boolean {
    return this.inputNo <= this.turnNo + this.delayNo;
  }

  /**
   * Hands in the local batch for `inputTurn` (call once per played turn, also with nothing to say).
   * Returns the turn it will be played in.
   */
  submit(cmds: unknown[]): number {
    if (!this.canSubmit()) throw new Error(`lockstep: batch for turn ${this.inputNo} is too far ahead of turn ${this.turnNo}`);
    const turn = this.inputNo++;
    if (this.isHost) this.store(this.local, turn, cmds);
    else this.opts.send(this.host, { k: 'in', turn, cmds });
    return turn;
  }

  /** The next turn to play if it is sealed (and moves past it), else null: the game must wait. */
  next(): Turn | null {
    const t = this.sealed.get(this.turnNo);
    if (!t) return null;
    this.sealed.delete(this.turnNo);
    this.turnNo++;
    return t;
  }

  /** Whether the next turn is sealed (without taking it). */
  ready(): boolean {
    return this.sealed.has(this.turnNo);
  }

  /** Turns sealed ahead of play (how far the network is ahead of the game). */
  buffered(): number {
    let n = 0;
    while (this.sealed.has(this.turnNo + n)) n++;
    return n;
  }

  /**
   * Who the next turn waits for: on the host, the active seats whose batch for the next turn to seal
   * is missing; on a client, the host while the next turn is not sealed (it knows no more).
   */
  waitingFor(): Seat[] {
    if (!this.isHost) return this.ready() ? [] : [this.host];
    if (this.sealNo > this.turnNo) return [];
    const got = this.inbox.get(this.sealNo);
    return [...this.active].filter((s) => !got?.has(s)).sort((a, b) => a - b);
  }

  /** Host: a seat left (its connection broke or it quit). The computer plays it from the next sealed turn on. */
  drop(seat: Seat): void {
    if (!this.isHost || !this.active.has(seat) || seat === this.host) return;
    this.active.delete(seat);
    // Back and gone again before the return was announced: the computer simply keeps the seat.
    const k = this.rejoining.indexOf(seat);
    if (k >= 0) this.rejoining.splice(k, 1);
    else this.leaving.push(seat);
    for (const m of this.inbox.values()) m.delete(seat);
    this.trySeal();
  }

  /**
   * Host: a departed seat's player is back (roadmap 6.7). The seat hands in batches again from the
   * returned turn on — the next turn to seal, announced in it as `rejoined` — so its browser starts
   * from a snapshot with `resume: { input: <that turn> }`. Null if the seat is playing already.
   */
  rejoin(seat: Seat): number | null {
    if (!this.isHost || this.active.has(seat) || seat === this.host) return null;
    // Gone and back before the departure was announced: nothing to announce at all.
    const k = this.leaving.indexOf(seat);
    if (k >= 0) this.leaving.splice(k, 1);
    else this.rejoining.push(seat);
    this.active.add(seat);
    return this.sealNo;
  }

  /** The sealed turns not played yet, from `turn` on, in order (a snapshot for a returning player). */
  sealedFrom(turn: number): Turn[] {
    const out: Turn[] = [];
    for (let t = Math.max(turn, this.turnNo); this.sealed.has(t); t++) out.push(this.sealed.get(t)!);
    return out;
  }

  /** Client: asks the host for every sealed turn from the next one to play on (a gap, a fresh snapshot). */
  want(): void {
    if (!this.isHost) this.opts.send(this.host, { k: 'want', from: this.turnNo });
  }

  /** The seats still handing in batches (host's view). */
  activeSeats(): Seat[] {
    return [...this.active].sort((a, b) => a - b);
  }

  /** The local state checksum after playing `turn` (any string or number; equal states must give equal sums). */
  checksum(turn: number, sum: string | number): void {
    if (this.isHost) this.storeSum(this.local, turn, sum);
    else this.opts.send(this.host, { k: 'sum', turn, sum });
  }

  /** Feeds a message received from `from` (the transport's sender, mapped to a seat). */
  receive(from: Seat, msg: LockstepMsg): void {
    switch (msg.k) {
      case 'in':
        if (this.isHost && Number.isInteger(msg.turn) && Array.isArray(msg.cmds)) this.store(from, msg.turn, msg.cmds);
        return;
      case 'turn':
        // Late (played already) or twice: ignored.
        if (this.isHost || from !== this.host || !Number.isInteger(msg.turn) || msg.turn < this.turnNo || this.sealed.has(msg.turn)) return;
        if (!Array.isArray(msg.inputs)) return;
        this.sealed.set(msg.turn, { turn: msg.turn, inputs: msg.inputs, dropped: seatList(msg.dropped), rejoined: seatList(msg.rejoined) });
        return;
      case 'want':
        if (this.isHost && Number.isInteger(msg.from)) this.resend(from, msg.from);
        return;
      case 'sum':
        if (this.isHost) this.storeSum(from, msg.turn, msg.sum);
        return;
      case 'desync':
        if (!this.isHost && from === this.host) this.report({ turn: msg.turn, sums: msg.sums, agreed: msg.agreed ?? null });
        return;
    }
  }

  private store(seat: Seat, turn: number, cmds: unknown[]): void {
    // Late batches (for a sealed turn, or from a seat already dropped) are ignored: the host's word stands.
    if (!this.active.has(seat) || turn < this.sealNo) return;
    let m = this.inbox.get(turn);
    if (!m) this.inbox.set(turn, (m = new Map()));
    if (m.has(seat)) return;
    m.set(seat, cmds);
    this.trySeal();
  }

  private trySeal(): void {
    for (;;) {
      const m = this.inbox.get(this.sealNo);
      if ([...this.active].some((s) => !m?.has(s))) return;
      const inputs = [...this.active].sort((a, b) => a - b).map((seat) => ({ seat, cmds: m!.get(seat)! }));
      const turn: Turn = { turn: this.sealNo, inputs, dropped: this.leaving.sort((a, b) => a - b), rejoined: this.rejoining.sort((a, b) => a - b) };
      this.leaving = [];
      this.rejoining = [];
      this.inbox.delete(this.sealNo);
      this.keep(turn);
      this.sealNo++;
      this.opts.send('all', { k: 'turn', turn: turn.turn, inputs: turn.inputs, dropped: turn.dropped, rejoined: turn.rejoined });
    }
  }

  /** A sealed turn: to be played, and (host) kept for resending. */
  private keep(turn: Turn): void {
    this.sealed.set(turn.turn, turn);
    if (!this.isHost) return;
    this.history.set(turn.turn, turn);
    const keep = this.opts.history ?? HISTORY;
    this.history.delete(turn.turn - keep);
  }

  /** Host: the sealed turns from `from` on that it still keeps, to a browser that asked. */
  private resend(to: Seat, from: number): void {
    for (let t = from; t < this.sealNo && t < from + RESEND_MAX; t++) {
      const turn = this.history.get(t);
      if (turn) this.opts.send(to, { k: 'turn', turn: t, inputs: turn.inputs, dropped: turn.dropped, rejoined: turn.rejoined });
    }
  }

  private storeSum(seat: Seat, turn: number, sum: string | number): void {
    if (this.desynced) return;
    let m = this.sums.get(turn);
    if (!m) this.sums.set(turn, (m = new Map()));
    m.set(seat, sum);
    const values = new Set(m.values());
    if (values.size > 1) {
      const report = { turn, sums: [...m.entries()].sort((a, b) => a[0] - b[0]), agreed: this.agreedNo };
      this.opts.send('all', { k: 'desync', turn: report.turn, sums: report.sums, agreed: report.agreed });
      this.report(report);
      return;
    }
    // Forget turns everyone has agreed on, and anything too old to wait for.
    const keep = this.opts.keepSums ?? 64;
    if ([...this.active].every((s) => m!.has(s))) {
      this.sums.delete(turn);
      if (this.agreedNo === null || turn > this.agreedNo) this.agreedNo = turn;
    }
    for (const t of this.sums.keys()) if (t < turn - keep) this.sums.delete(t);
  }

  private report(r: DesyncReport): void {
    if (this.desynced) return;
    this.desynced = r;
    this.opts.onDesync?.(r);
  }
}
