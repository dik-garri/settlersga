import { CHAT_MAX, type ChatTo, type NetChatLine, type SayResult } from '../net/chat';
import type { Seat } from '../net/lockstep';
import { PLAYER_COLORS } from '../render/sprites';
import { el } from './dom';
import { t } from './i18n';

/**
 * The in-game chat box of a network game (roadmap 6.6): over the message ticker, opened with Enter or
 * the network panel's button. It shows the last lines (the lobby's first) and a field with the
 * recipients — everybody or the allies, as Settlers 4's chat offers (per player and «enemies only»
 * are not ours). Enter sends and closes, Esc closes. New lines also go to the ticker while it is
 * closed (`NetGameHooks.chat` in `main.ts`).
 */

/** Lines shown in the open box. */
const SHOWN = 12;

export interface ChatBoxOptions {
  local: Seat;
  /** A seat's player name (`NetGame.nameOf`). */
  nameOf: (seat: Seat) => string;
  /** The lines so far. */
  lines: () => readonly NetChatLine[];
  say: (text: string, to: ChatTo) => SayResult;
  /** A note for the ticker (too fast). */
  toast: (text: string) => void;
}

/** A chat line in words: «Вася (союзникам): …». */
export function chatLineText(line: NetChatLine, nameOf: (seat: Seat) => string): string {
  const who = nameOf(line.seat);
  return line.to === 'allies' ? t('chat.lineAllies', { who, text: line.text }) : t('chat.line', { who, text: line.text });
}

export class ChatBox {
  readonly el = el('div', 'chat-box');
  private readonly log = el('div', 'chat-log');
  private readonly input = el('input');
  private readonly to = el('select');
  private shown = -1;

  constructor(private readonly o: ChatBoxOptions) {
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', t('chat.title'));
    this.log.setAttribute('aria-live', 'polite');
    this.input.type = 'text';
    this.input.maxLength = CHAT_MAX;
    this.input.placeholder = t('chat.placeholder');
    this.input.setAttribute('aria-label', t('chat.placeholder'));
    for (const [v, label] of [
      ['all', t('chat.toAll')],
      ['allies', t('chat.toAllies')],
    ] as const) {
      const opt = el('option', '', label);
      opt.value = v;
      this.to.append(opt);
    }
    this.to.setAttribute('aria-label', t('chat.to'));
    const send = el('button', 'chat-send', t('chat.send'));
    send.onclick = () => this.send();
    this.input.onkeydown = (e) => {
      // The game's keys stay out of the field.
      e.stopPropagation();
      if (e.key === 'Enter') this.send();
      else if (e.key === 'Escape') this.close();
    };
    this.to.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    };
    const row = el('div', 'chat-row');
    row.append(this.to, this.input, send);
    this.el.append(this.log, row);
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.el.hidden = false;
    this.refresh();
    this.input.focus();
  }

  close(): void {
    this.el.hidden = true;
    this.input.blur();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Redraws the lines when there are new ones. */
  refresh(): void {
    const lines = this.o.lines();
    if (lines.length === this.shown && this.log.childElementCount > 0) return;
    this.shown = lines.length;
    this.log.replaceChildren(
      ...lines.slice(-SHOWN).map((line) => {
        const p = el('p', line.lobby ? 'lobby' : '');
        const who = el('b', '', `${this.o.nameOf(line.seat)}${line.to === 'allies' ? ` ${t('chat.alliesMark')}` : ''}: `);
        who.style.color = PLAYER_COLORS[(line.seat - 1) % PLAYER_COLORS.length];
        p.append(who, document.createTextNode(line.text));
        return p;
      }),
    );
    this.log.scrollTop = this.log.scrollHeight;
  }

  private send(): void {
    const text = this.input.value;
    if (!text.trim()) return this.close();
    const r = this.o.say(text, this.to.value === 'allies' ? 'allies' : 'all');
    if (r === 'tooFast') {
      this.o.toast(t('chat.tooFast'));
      return;
    }
    this.input.value = '';
    this.close();
  }
}
