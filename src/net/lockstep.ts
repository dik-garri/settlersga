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
}

/** The lockstep messages on the wire (namespaced by `session.ts`). */
export type LockstepMsg =
  /** Client → host: my batch for `turn` (the sender is the seat; the transport says who sent it). */
  | { k: 'in'; turn: number; cmds: unknown[] }
  /** Host → clients: a sealed turn. */
  | { k: 'turn'; turn: number; inputs: SeatInput[]; dropped: Seat[] }
  /** Client → host: my state checksum after playing `turn`. */
  | { k: 'sum'; turn: number; sum: string | number }
  /** Host → clients: the checksums after `turn` differ. */
  | { k: 'desync'; turn: number; sums: [Seat, string | number][] };

export interface DesyncReport {
  /** The first turn whose checksums differ. */
  turn: number;
  /** Every checksum known for that turn, by seat. */
  sums: [Seat, string | number][];
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
}

export class Lockstep {
  readonly local: Seat;
  readonly host: Seat;
  readonly delay: number;
  readonly isHost: boolean;
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
  /** Host: checksums by turn, then seat. */
  private sums = new Map<number, Map<Seat, string | number>>();
  private desynced: DesyncReport | null = null;
  private opts: LockstepOptions;

  constructor(opts: LockstepOptions) {
    if (!Number.isInteger(opts.delay) || opts.delay < 1) throw new Error('lockstep delay must be a whole number ≥ 1');
    if (!opts.seats.includes(opts.local) || !opts.seats.includes(opts.host)) throw new Error('local and host seats must take part');
    this.opts = opts;
    this.local = opts.local;
    this.host = opts.host;
    this.delay = opts.delay;
    this.isHost = opts.local === opts.host;
    this.inputNo = opts.delay;
    this.active = new Set(opts.seats);
    // The first `delay` turns carry nothing from anyone: everybody knows them sealed and empty.
    const seats = [...opts.seats].sort((a, b) => a - b);
    for (let t = 0; t < opts.delay; t++) this.sealed.set(t, { turn: t, inputs: seats.map((seat) => ({ seat, cmds: [] })), dropped: [] });
    this.sealNo = opts.delay;
  }

  /** The next turn to play. */
  get turn(): number {
    return this.turnNo;
  }

  /** The turn the next local batch will be played in. */
  get inputTurn(): number {
    return this.inputNo;
  }

  /** The first desync seen, if any. */
  get desync(): DesyncReport | null {
    return this.desynced;
  }

  /** Whether the local seat may hand in its next batch (at most `delay` turns ahead of play). */
  canSubmit(): boolean {
    return this.inputNo <= this.turnNo + this.delay;
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
    this.leaving.push(seat);
    for (const m of this.inbox.values()) m.delete(seat);
    this.trySeal();
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
        if (!this.isHost && from === this.host && msg.turn >= this.turnNo)
          this.sealed.set(msg.turn, { turn: msg.turn, inputs: msg.inputs, dropped: msg.dropped });
        return;
      case 'sum':
        if (this.isHost) this.storeSum(from, msg.turn, msg.sum);
        return;
      case 'desync':
        if (!this.isHost && from === this.host) this.report({ turn: msg.turn, sums: msg.sums });
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
      const turn: Turn = { turn: this.sealNo, inputs, dropped: this.leaving.sort((a, b) => a - b) };
      this.leaving = [];
      this.inbox.delete(this.sealNo);
      this.sealed.set(turn.turn, turn);
      this.sealNo++;
      this.opts.send('all', { k: 'turn', turn: turn.turn, inputs: turn.inputs, dropped: turn.dropped });
    }
  }

  private storeSum(seat: Seat, turn: number, sum: string | number): void {
    if (this.desynced) return;
    let m = this.sums.get(turn);
    if (!m) this.sums.set(turn, (m = new Map()));
    m.set(seat, sum);
    const values = new Set(m.values());
    if (values.size > 1) {
      const report = { turn, sums: [...m.entries()].sort((a, b) => a[0] - b[0]) };
      this.opts.send('all', { k: 'desync', turn: report.turn, sums: report.sums });
      this.report(report);
      return;
    }
    // Forget turns everyone has agreed on, and anything too old to wait for.
    const keep = this.opts.keepSums ?? 64;
    if ([...this.active].every((s) => m!.has(s))) this.sums.delete(turn);
    for (const t of this.sums.keys()) if (t < turn - keep) this.sums.delete(t);
  }

  private report(r: DesyncReport): void {
    if (this.desynced) return;
    this.desynced = r;
    this.opts.onDesync?.(r);
  }
}
