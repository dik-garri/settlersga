import type { Seat } from '../net/lockstep';
import type { NetMatch } from '../net/match';
import type { NetStatus } from '../net/status';
import { PLAYER_COLORS } from '../render/sprites';
import type { World } from '../sim/world';
import { button, el } from './dom';
import { t } from './i18n';

/**
 * The network game's own interface (roadmap 6.4): a small status box under the speed strip — every
 * human seat with its round trip, who plays a departed seat now, the pause — and, while the game
 * stands waiting for somebody, «Ожидание: …» (the host can let the computer take a seat that keeps
 * everybody waiting, after `KICK_AFTER_MS`); plus the windows that end a network game: a desync (with
 * the report to download) and the host gone.
 */

/** Waiting shorter than this is not shown (a late packet). */
const SHOW_WAIT_MS = 1000;
/** After this long the host may disconnect the player everybody waits for (docs/NETWORK.md section 6). */
export const KICK_AFTER_MS = 30_000;

export interface NetPanelOptions {
  world: World;
  match: NetMatch;
  status: NetStatus;
  /** Human seats at the start. */
  seats: readonly Seat[];
  local: Seat;
  host: Seat;
  /** Host: disconnect a seat (its player leaves; the computer takes over). */
  kick: ((seat: Seat) => void) | null;
}

export class NetPanel {
  readonly el = el('div', 'net-panel');
  private key = '';
  private last = -Infinity;

  constructor(private readonly o: NetPanelOptions) {}

  update(nowMs: number): void {
    if (nowMs - this.last < 250) return;
    this.last = nowMs;
    const { world, match, status, local, host } = this.o;
    const waiting = match.waitingMs >= SHOW_WAIT_MS ? status.waiting(true) : [];
    const rows = this.o.seats.map((seat) => {
      const ai = world.aiLevel(seat) !== null;
      const ping = ai ? null : status.ping(seat);
      return { seat, ai, ping: ping === null ? null : Math.round(ping / 10) * 10 };
    });
    const canKick = !!this.o.kick && match.waitingMs >= KICK_AFTER_MS;
    const key = JSON.stringify([rows, waiting, canKick, match.paused, match.pausedBy, match.speed, match.stopped]);
    if (key === this.key) return;
    this.key = key;
    this.el.replaceChildren();
    for (const r of rows) {
      const line = el('div', 'np-row');
      const dot = el('span', 'np-dot');
      dot.style.background = PLAYER_COLORS[(r.seat - 1) % PLAYER_COLORS.length];
      const who = r.seat === local ? t('net.you') : r.ai ? t('net.computer') : r.seat === host ? t('lobby.host') : t('common.player', { id: r.seat });
      line.append(dot, el('span', 'np-name', `${t('common.player', { id: r.seat })} · ${who}`));
      if (r.ping !== null) line.append(el('span', 'np-ping', t('lobby.ping', { n: r.ping })));
      this.el.append(line);
    }
    if (match.speed !== 1) this.el.append(el('div', 'np-note', t('net.speedNow', { n: match.speed })));
    if (match.paused && match.pausedBy !== null) this.el.append(el('div', 'np-note', t('net.pausedBy', { id: match.pausedBy })));
    if (waiting.length > 0) {
      const w = el('div', 'np-wait', t('net.waiting', { who: waiting.map((s) => t('common.player', { id: s })).join(', ') }));
      this.el.append(w);
      if (canKick) {
        for (const s of waiting) {
          if (s === local) continue;
          this.el.append(button(t('net.disconnect', { id: s }), t('net.disconnectTip'), () => this.o.kick?.(s), 'np-kick'));
        }
      }
    }
  }
}

/** A window over the game that ends it (desync, host gone): a title, a text and buttons. */
export function netWindow(title: string, text: string, actions: [string, () => void, boolean?][]): HTMLElement {
  const box = el('div', 'panel end-screen net-window');
  box.setAttribute('role', 'alertdialog');
  box.append(el('h2', 'lost', title), el('p', '', text));
  const row = el('div', 'info-actions');
  for (const [label, fn, main] of actions) row.append(button(label, '', fn, main ? 'active' : ''));
  box.append(row);
  return box;
}

/** Offers a JSON value as a file to download. */
export function downloadJson(name: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
