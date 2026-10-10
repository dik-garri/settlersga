import type { Seat } from '../net/lockstep';
import type { NetMatch } from '../net/match';
import type { NetStatus } from '../net/status';
import { PLAYER_COLORS } from '../render/sprites';
import { TICKS_PER_SECOND } from '../sim/config';
import type { World } from '../sim/world';
import { button, el } from './dom';
import { t } from './i18n';
import { rejoinAskText } from './netGame';

/**
 * The network game's own interface (roadmap 6.4): a small status box under the speed strip — every
 * human seat with its round trip, who plays a departed seat now, the pause — and, while the game
 * stands waiting for somebody, «Ожидание: …» (the host can let the computer take a seat that keeps
 * everybody waiting, after `KICK_AFTER_MS`); the input delay in force (it adapts, roadmap 6.7); the
 * chat button (roadmap 6.6); on the host, a returning player's request for his seat with «Пустить» /
 * «Нет» (6.7); plus the windows that end a network game: a desync (with the report to download) and
 * the host gone.
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
  /** A human seat's player name (`NetGame.nameOf`). */
  nameOf: (seat: Seat) => string;
  /** Host: disconnect a seat (its player leaves; the computer takes over). */
  kick: ((seat: Seat) => void) | null;
  /** Opens or closes the chat box. */
  chat: () => void;
  /** Host: the seats returning players ask for, and the answers. */
  rejoin: { asked: () => Seat[]; askerName: (seat: Seat) => string | null; accept: (seat: Seat) => void; refuse: (seat: Seat) => void } | null;
}

export class NetPanel {
  readonly el = el('div', 'net-panel');
  private key = '';
  private last = -Infinity;

  constructor(private readonly o: NetPanelOptions) {}

  update(nowMs: number): void {
    if (nowMs - this.last < 250) return;
    this.last = nowMs;
    const { world, match, status, local, host, nameOf } = this.o;
    const waiting = match.waitingMs >= SHOW_WAIT_MS ? status.waiting(true) : [];
    const rows = this.o.seats.map((seat) => {
      const ai = world.aiLevel(seat) !== null;
      const ping = ai ? null : status.ping(seat);
      return { seat, name: nameOf(seat), ai, ping: ping === null ? null : Math.round(ping / 10) * 10 };
    });
    const canKick = !!this.o.kick && match.waitingMs >= KICK_AFTER_MS;
    const delay = match.lockstep.delay;
    const asked = (this.o.rejoin?.asked() ?? []).map((s) => ({ seat: s, text: rejoinAskText(nameOf(s), this.o.rejoin?.askerName(s) ?? null) }));
    const key = JSON.stringify([rows, waiting, canKick, match.paused, match.pausedBy, match.speed, match.stopped, delay, asked]);
    if (key === this.key) return;
    this.key = key;
    this.el.replaceChildren();
    for (const r of rows) {
      const line = el('div', 'np-row');
      const dot = el('span', 'np-dot');
      dot.style.background = PLAYER_COLORS[(r.seat - 1) % PLAYER_COLORS.length];
      const who = r.seat === local ? t('net.you') : r.ai ? t('net.computer') : r.seat === host ? t('net.hostMark') : '';
      line.append(dot, el('span', 'np-name', who ? `${r.name} · ${who}` : r.name));
      line.title = t('common.player', { id: r.seat });
      if (r.ping !== null) line.append(el('span', 'np-ping', t('lobby.ping', { n: r.ping })));
      this.el.append(line);
    }
    if (match.speed !== 1) this.el.append(el('div', 'np-note', t('net.speedNow', { n: match.speed })));
    const turnMs = (match.turnTicks * 1000) / TICKS_PER_SECOND / match.speed;
    const lag = el('div', 'np-note', t('net.delay', { n: delay, ms: Math.round(delay * turnMs) }));
    lag.title = t('net.delayTip');
    this.el.append(lag);
    if (match.paused && match.pausedBy !== null) this.el.append(el('div', 'np-note', t('net.pausedBy', { who: nameOf(match.pausedBy) })));
    if (waiting.length > 0) {
      const w = el('div', 'np-wait', t('net.waiting', { who: waiting.map((s) => nameOf(s)).join(', ') }));
      this.el.append(w);
      if (canKick) {
        for (const s of waiting) {
          if (s === local) continue;
          this.el.append(button(t('net.disconnect', { who: nameOf(s) }), t('net.disconnectTip'), () => this.o.kick?.(s), 'np-kick'));
        }
      }
    }
    for (const { seat: s, text } of asked) {
      const box = el('div', 'np-ask');
      box.append(el('div', 'np-wait', text));
      const row = el('div', 'np-buttons');
      row.append(
        button(t('net.rejoinAccept'), t('net.rejoinAcceptTip'), () => this.o.rejoin?.accept(s), 'np-kick active'),
        button(t('net.rejoinRefuse'), t('net.rejoinRefuseTip'), () => this.o.rejoin?.refuse(s), 'np-kick'),
      );
      box.append(row);
      this.el.append(box);
    }
    this.el.append(button(t('chat.open'), t('chat.openTip'), () => this.o.chat(), 'np-kick np-chat'));
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
