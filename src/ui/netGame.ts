import type { DesyncReport, Seat } from '../net/lockstep';
import { NetMatch, type DesyncFile, type MatchEvent } from '../net/match';
import { bindLockstep, type LockstepSession } from '../net/session';
import { NetStatus } from '../net/status';
import type { PeerId, Transport } from '../net/transport';
import { BUILD_ID } from '../net/version';
import type { World } from '../sim/world';
import { t } from './i18n';
import type { StartInfo } from './lobby';

/**
 * A network game in the browser (roadmap 6.4): binds the lobby's transport to a lockstep and a
 * `NetMatch` over the world, and keeps it going. `main.ts` calls `pump` once a frame; while the tab
 * is hidden (no frames: `requestAnimationFrame` stops) a timer and every message that arrives pump
 * it instead, without drawing, so a player who switched tabs does not hold up everybody else
 * (browsers slow hidden tabs' timers to about once a second; a message from the network wakes it
 * at once, and a wake-up plays everything that is due, up to `HIDDEN_MAX_TICKS`).
 */

/** Ticks one call may play in a visible tab (as the single-player loop) and in a hidden one. */
const VISIBLE_MAX_TICKS = 20;
const HIDDEN_MAX_TICKS = 400;
/** A hidden tab's timer (ms); browsers stretch it to about a second after a while. */
const HIDDEN_EVERY = 100;

export interface NetGameHooks {
  /** A line for the message ticker (a player left, the pause, the speed). */
  toast(text: string): void;
  /** The game stopped for good on a desync. */
  desync(report: DesyncReport): void;
  /** The host is gone: the game cannot go on. */
  hostLost(): void;
}

export class NetGame {
  readonly local: Seat;
  readonly isHost: boolean;
  readonly hostSeat: Seat;
  readonly seats: Map<Seat, PeerId>;
  readonly session: LockstepSession;
  readonly match: NetMatch;
  readonly status: NetStatus;
  hooks: NetGameHooks = { toast: () => {}, desync: () => {}, hostLost: () => {} };
  private last = performance.now();
  private timer: ReturnType<typeof setInterval>;
  private readonly offs: (() => void)[] = [];
  private wakeQueued = false;
  private ended = false;

  constructor(
    readonly world: World,
    readonly transport: Transport,
    readonly info: StartInfo,
  ) {
    this.seats = new Map(info.seats);
    const local = info.seats.find(([, p]) => p === transport.self)?.[0];
    const host = info.seats.find(([, p]) => p === transport.host)?.[0];
    if (local === undefined || host === undefined) throw new Error('network game: this browser and the host need a seat');
    this.local = local;
    this.hostSeat = host;
    this.isHost = transport.isHost;
    this.session = bindLockstep(transport, {
      seats: this.seats,
      delay: info.delay,
      onHostLost: () => this.endHostLost(),
    });
    this.match = new NetMatch({
      world,
      lockstep: this.session.lockstep,
      turnTicks: info.turnTicks,
      checksumEvery: info.checksumEvery,
      onDesync: (r) => this.hooks.desync(r),
      onEvent: (e) => this.hooks.toast(eventText(e)),
    });
    world.sendAhead = (cmd) => this.match.queue(cmd);
    this.status = new NetStatus({
      transport,
      seats: this.seats,
      local,
      host,
      waitingFor: () => this.session.lockstep.waitingFor(),
      now: () => performance.now(),
    });
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

  /** Plays what real time asks for since the last call; returns the ticks stepped. */
  pump(): number {
    const now = performance.now();
    const dt = Math.min(now - this.last, 5000);
    this.last = now;
    this.status.update();
    if (this.ended) return 0;
    return this.match.advance(dt, document.hidden ? HIDDEN_MAX_TICKS : VISIBLE_MAX_TICKS);
  }

  /** Host: disconnect the player of a seat (the computer takes it over at the next sealed turn). */
  kick(seat: Seat): void {
    const peer = this.seats.get(seat);
    if (this.isHost && peer && seat !== this.local) this.transport.kick(peer);
  }

  /** What a player downloads after a desync: the match's part plus the build, the browser and the setup. */
  report(): DesyncFile & Record<string, unknown> {
    return {
      ...this.match.report(),
      build: BUILD_ID,
      userAgent: navigator.userAgent,
      date: new Date().toISOString(),
      setup: this.info.setup,
      seats: this.info.seats,
    };
  }

  private endHostLost(): void {
    if (this.ended) return;
    this.ended = true;
    this.match.stop();
    this.hooks.hostLost();
  }

  /** Leaves the game: no more pumping, the connections close (the others' computers take this seat). */
  close(): void {
    this.ended = true;
    clearInterval(this.timer);
    for (const off of this.offs) off();
    this.status.dispose();
    this.session.dispose();
    this.world.sendAhead = null;
    this.transport.close();
  }
}

/** A match event in words. */
function eventText(e: MatchEvent): string {
  switch (e.kind) {
    case 'takeover':
      return t('net.takeover', { id: e.seat });
    case 'pause':
      return t(e.on ? 'net.paused' : 'net.resumed', { id: e.seat });
    case 'speed':
      return t('net.speed', { n: e.speed });
  }
}
