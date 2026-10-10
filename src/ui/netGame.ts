import type { ChatTo, NetChatLine, SayResult } from '../net/chat';
import { applySeatControls, NetCore, type ResumeInfo } from '../net/core';
import type { DesyncReport, Seat } from '../net/lockstep';
import { sameName } from '../net/names';
import { netChecksum, type DesyncFile, type MatchEvent, type NetMatch, type NetSave } from '../net/match';
import type { LockstepSession } from '../net/session';
import type { NetStatus } from '../net/status';
import type { PeerId, Transport } from '../net/transport';
import { BUILD_ID } from '../net/version';
import { TICKS_PER_SECOND } from '../sim/config';
import { saveWorld } from '../sim/save';
import type { World } from '../sim/world';
import { t } from './i18n';
import { seatsOf, type StartInfo } from './lobby';
import { namesOf, seatName } from './playerNames';
import { forgetRejoin, keepRejoin } from './rejoinHint';
import { AUTO_ID, type NetSaveMeta, type SaveSlots } from './saves';

/**
 * A network game in the browser (roadmap 6.4–6.7): the DOM-free `NetCore` (lockstep, match, status,
 * chat, adaptive delay, the host's desk for returning players) kept going by the page. `main.ts`
 * calls `pump` once a frame; while the tab is hidden (no frames: `requestAnimationFrame` stops) a
 * timer and every message that arrives pump it instead, without drawing, so a player who switched
 * tabs does not hold up everybody else (browsers slow hidden tabs' timers to about once a second; a
 * message from the network wakes it at once, and a wake-up plays everything that is due, up to
 * `HIDDEN_MAX_TICKS`). A browser far behind (a returning player) plays as much a frame. Network
 * saves (a request of any player, the autosave) land in this browser's save slots, marked as such.
 */

/** Ticks one call may play in a visible tab (as the single-player loop) and in a hidden one. */
const VISIBLE_MAX_TICKS = 20;
const HIDDEN_MAX_TICKS = 400;
/** A hidden tab's timer (ms); browsers stretch it to about a second after a while. */
const HIDDEN_EVERY = 100;
/** The network autosave: every this many game minutes, at a common turn (as single-player's). */
const AUTOSAVE_MINUTES = 5;
/** How long a save request waits for its turn before the interface stops waiting (ms). */
const SAVE_WAIT_MS = 10_000;

export interface NetGameHooks {
  /** A line for the message ticker (a player left, the pause, the speed, a save). */
  toast(text: string): void;
  /** The game stopped for good on a desync. */
  desync(report: DesyncReport): void;
  /** The host is gone: the game cannot go on. */
  hostLost(): void;
  /** A chat line this browser may read. */
  chat(line: NetChatLine): void;
}

export interface NetGameOptions {
  /** Where network saves are written. */
  slots: SaveSlots;
  /** A returning browser: where its game starts. */
  resume?: ResumeInfo;
  /** The chat so far (the lobby's, or the host's for a returning player). */
  chat?: NetChatLine[];
}

export class NetGame {
  readonly core: NetCore;
  readonly local: Seat;
  readonly isHost: boolean;
  readonly hostSeat: Seat;
  /** The human players' names by seat, from the setup the host sent at «Start» (interface data only). */
  readonly names: ReadonlyMap<Seat, string>;
  hooks: NetGameHooks = { toast: () => {}, desync: () => {}, hostLost: () => {}, chat: () => {} };
  private last = performance.now();
  private timer: ReturnType<typeof setInterval>;
  private readonly offs: (() => void)[] = [];
  private wakeQueued = false;
  private closed = false;
  /** Save requests of this browser waiting for their turn. */
  private saveWaits: ((ok: boolean) => void)[] = [];

  constructor(
    readonly world: World,
    readonly transport: Transport,
    readonly info: StartInfo,
    private readonly opts: NetGameOptions,
  ) {
    // A loaded game: the seats nobody took go to the computer or to nobody, on every machine alike.
    if (info.load && !opts.resume) applySeatControls(world, info.load.control);
    this.names = namesOf(info.setup);
    this.core = new NetCore({
      world,
      transport,
      start: info,
      build: BUILD_ID,
      now: () => performance.now(),
      humanSeats: [...seatsOf(info.setup).keys()],
      resume: opts.resume,
      chat: opts.chat,
      names: this.names,
      autosaveEvery: AUTOSAVE_MINUTES * 60 * TICKS_PER_SECOND,
      hooks: {
        event: (e) => this.onEvent(e),
        desync: (r) => this.hooks.desync(r),
        hostLost: () => this.hooks.hostLost(),
        chat: (line) => this.hooks.chat(line),
        rejoinAsked: (seat, name) => this.hooks.toast(rejoinAskText(this.nameOf(seat), name)),
      },
    });
    if (info.load && !opts.resume) this.core.match.speed = info.load.speed;
    this.local = this.core.local;
    this.hostSeat = this.core.hostSeat;
    this.isHost = this.core.isHost;
    // A client may come back after a reload: the tab remembers the room and the seat.
    if (!this.isHost) keepRejoin(transport.code, this.local);
    // Hidden tab: a timer, and every message from the network, play what is due.
    this.timer = setInterval(() => {
      if (document.hidden) this.pump();
    }, HIDDEN_EVERY);
    this.offs.push(
      transport.on('message', () => {
        if (!document.hidden || this.wakeQueued) return;
        this.wakeQueued = true;
        queueMicrotask(() => {
          this.wakeQueued = false;
          this.pump();
        });
      }),
    );
  }

  /** A human seat's player for the screens: his name, else «Игрок N» (also while the computer plays it). */
  nameOf(seat: Seat): string {
    return seatName(this.names, seat);
  }

  get match(): NetMatch {
    return this.core.match;
  }

  get session(): LockstepSession {
    return this.core.session;
  }

  get status(): NetStatus {
    return this.core.status;
  }

  /** Every human seat being played and its peer. */
  get seats(): Map<Seat, PeerId> {
    return this.core.seats;
  }

  /** Plays what real time asks for since the last call; returns the ticks stepped. */
  pump(): number {
    const now = performance.now();
    const dt = Math.min(now - this.last, 5000);
    this.last = now;
    if (this.closed) return 0;
    return this.core.pump(dt, document.hidden || this.core.catchingUp ? HIDDEN_MAX_TICKS : VISIBLE_MAX_TICKS);
  }

  /** Host: disconnect the player of a seat (the computer takes it over at the next sealed turn). */
  kick(seat: Seat): void {
    this.core.kick(seat);
  }

  /** Says something in the chat. */
  say(text: string, to: ChatTo): SayResult {
    return this.core.say(text, to);
  }

  /**
   * Saves the game on every machine at a common turn (the pause menu's «Save»); resolves once this
   * browser has written it (false: refused inside the minute, storage full, or no answer).
   */
  requestSave(name: string): Promise<boolean> {
    this.core.requestSave(name);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        this.saveWaits = this.saveWaits.filter((f) => f !== finish);
        resolve(ok);
      };
      this.saveWaits.push(finish);
      setTimeout(() => finish(false), SAVE_WAIT_MS);
    });
  }

  /**
   * Saves this browser's game as it stands now, as a network save (the host is gone: every browser
   * stopped at the last turn it played, the same for all as a rule).
   */
  async saveNow(name: string): Promise<boolean> {
    const w = this.world;
    const data = saveWorld(w);
    const net = this.netMeta({ seat: this.local, turn: this.match.turn, tick: w.tick, name, auto: false, sum: netChecksum(w), speed: this.match.speed, data, log: w.commandLog.slice(-100) });
    return !!(await this.opts.slots.write(data, name, Date.now(), undefined, { net }));
  }

  /** What a player downloads after a desync: the match's part plus the build, the browser and the setup. */
  report(): DesyncFile & Record<string, unknown> {
    return {
      ...this.match.report(),
      build: BUILD_ID,
      userAgent: navigator.userAgent,
      date: new Date().toISOString(),
      setup: this.info.setup,
      seats: [...this.seats],
      names: [...this.names],
    };
  }

  private netMeta(s: NetSave): NetSaveMeta {
    return {
      id: `${this.transport.code}-${s.tick}`,
      sum: s.sum,
      setup: this.info.setup,
      local: this.local,
      host: this.hostSeat,
      turn: s.turn,
      speed: s.speed,
      log: s.log,
    };
  }

  private onEvent(e: MatchEvent): void {
    if (e.kind === 'save') return void this.write(e.save);
    if (e.kind === 'saveRefused') {
      if (e.seat === this.local) {
        this.hooks.toast(t('net.saveWait', { n: Math.ceil(e.wait / TICKS_PER_SECOND) }));
        for (const f of this.saveWaits.slice()) f(false);
      }
      return;
    }
    const text = eventText(e, (seat) => this.nameOf(seat));
    if (text) this.hooks.toast(text);
  }

  /** A network save: written into this browser's slots (every browser writes the same one). */
  private async write(s: NetSave): Promise<void> {
    const name = s.auto ? t('saves.auto') : s.name || t('net.savedName', { min: Math.floor(s.tick / (60 * TICKS_PER_SECOND)) });
    const meta = await this.opts.slots.write(s.data, name, Date.now(), s.auto ? AUTO_ID : undefined, { net: this.netMeta(s) });
    if (!s.auto) this.hooks.toast(meta ? t('net.savedBy', { who: this.nameOf(s.seat) }) : t('saves.failed'));
    else if (meta) this.hooks.toast(t('saves.auto'));
    if (s.seat === this.local && !s.auto) for (const f of this.saveWaits.slice()) f(!!meta);
  }

  /** Leaves the game: no more pumping, the connections close (the others' computers take this seat). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const off of this.offs) off();
    this.core.dispose();
    forgetRejoin();
    this.transport.close();
  }
}

/**
 * The host's line for a returning player: «Вася просится обратно» when he gives the seat's name (or
 * none is known), «Петя просится на место Васи» when the names differ.
 */
export function rejoinAskText(seat: string, asker: string | null): string {
  return !asker || sameName(asker, seat) ? t('net.rejoinAsk', { who: seat }) : t('net.rejoinAskOther', { who: asker, seat });
}

/** A match event in words (none for the quiet ones); `nameOf` names a seat's player. */
function eventText(e: MatchEvent, nameOf: (seat: Seat) => string): string | null {
  switch (e.kind) {
    case 'takeover':
      return t('net.takeover', { who: nameOf(e.seat) });
    case 'rejoin':
      return t('net.rejoined', { who: nameOf(e.seat) });
    case 'pause':
      return t(e.on ? 'net.paused' : 'net.resumed', { who: nameOf(e.seat) });
    case 'speed':
      return t('net.speed', { n: e.speed });
    default:
      return null;
  }
}
