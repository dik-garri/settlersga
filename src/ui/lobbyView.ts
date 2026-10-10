import type { AudioEngine } from '../audio/audio';
import { peerProvider } from '../net/peer';
import { normaliseCode, type Transport, type TransportProvider } from '../net/transport';
import { BUILD_ID } from '../net/version';
import { PLAYER_COLORS } from '../render/sprites';
import { el } from './dom';
import { t, withLang } from './i18n';
import { LobbyClient, LobbyHost, type ChatLine, type LobbyMember, type StartInfo } from './lobby';
import { activeSlots, defaultSetup, parseSetup, slotKindName, type GameSetup } from './setup';
import { setupForm } from './setupForm';

/**
 * The «Сетевая игра» screen (roadmap 6.5): create a game (this browser hosts it and gets a code and
 * a link) or join one by its code; then the lobby — the setup the host edits and everybody sees, the
 * players over the network with their ready flags and pings, a chat, and «Начать» for the host.
 * Drawn into the main menu's panel; the logic is `lobby.ts`.
 */

export interface LobbyViewActions {
  /** The game starts: the transport and what the host decided go to the game. */
  start(transport: Transport, info: StartInfo): void;
  /** Back to the main menu (the lobby is closed first). */
  back(): void;
}

type Phase =
  | { k: 'choose'; error?: string }
  | { k: 'busy'; text: string }
  | { k: 'host'; lobby: LobbyHost }
  | { k: 'client'; lobby: LobbyClient }
  | { k: 'gone'; text: string };

const randomSeed = () => Math.floor(Math.random() * 1e9);

export class LobbyView {
  readonly el = el('div', 'lobby');
  private phase: Phase = { k: 'choose' };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Parts redrawn on their own, so typing in the chat or a select is not interrupted. */
  private formBox = el('div', 'lobby-form');
  private playersBox = el('div', 'lobby-players');
  private chatLog = el('div', 'lobby-chat-log');
  private statusEl = el('span', 'setup-problem');
  private actionBtn: HTMLButtonElement | null = null;
  private formKey = '';
  private chatSeen = 0;
  private closed = false;

  constructor(
    private readonly actions: LobbyViewActions,
    private readonly audio: AudioEngine,
    private readonly provider: TransportProvider = peerProvider(),
  ) {
    this.render();
    this.timer = setInterval(() => this.tick(), 250);
  }

  /** Opens with a code to join at once (`?join=`). */
  join(code: string): void {
    void this.connect(code);
  }

  /** Leaves the lobby (closes the connections unless the game took them over). */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const p = this.phase;
    if (p.k === 'host' || p.k === 'client') {
      p.lobby.dispose();
      if (!p.lobby.started) p.lobby.transport.close();
    }
  }

  private tick(): void {
    const p = this.phase;
    if (p.k === 'host' || p.k === 'client') p.lobby.update();
    if (p.k === 'client') this.refreshClient(p.lobby);
  }

  private async create(): Promise<void> {
    this.phase = { k: 'busy', text: t('lobby.creating') };
    this.render();
    try {
      const transport = await this.provider.host();
      if (this.closed) return transport.close();
      const lobby = new LobbyHost(transport, lastNetworkSetup(), BUILD_ID, () => performance.now());
      lobby.onChange = () => this.refreshHost(lobby);
      this.phase = { k: 'host', lobby };
      this.render();
    } catch (e) {
      console.error(e);
      this.phase = { k: 'choose', error: t('lobby.failedHost') };
      this.render();
    }
  }

  private async connect(code: string): Promise<void> {
    this.phase = { k: 'busy', text: t('lobby.joining', { code }) };
    this.render();
    try {
      const transport = await this.provider.join(code);
      if (this.closed) return transport.close();
      const lobby = new LobbyClient(transport, BUILD_ID, () => performance.now());
      lobby.onChange = () => this.refreshClient(lobby);
      this.phase = { k: 'client', lobby };
      this.render();
    } catch (e) {
      console.error(e);
      this.phase = { k: 'choose', error: t('lobby.failedJoin', { code }) };
      this.render();
    }
  }

  private click(fn: () => void): () => void {
    return () => {
      this.audio.ui('click');
      fn();
    };
  }

  private render(): void {
    this.el.innerHTML = '';
    this.formKey = '';
    this.chatSeen = 0;
    this.chatLog.innerHTML = '';
    this.actionBtn = null;
    const p = this.phase;
    const row = el('div', 'menu-row');
    const back = el('button', 'menu-small', t('common.back'));
    back.onclick = this.click(() => this.leave());
    row.append(back);
    switch (p.k) {
      case 'choose':
        this.el.append(el('p', 'menu-soon', t('lobby.intro')), this.chooser(p.error));
        break;
      case 'busy':
        this.el.append(el('p', 'menu-text', p.text));
        break;
      case 'gone':
        this.el.append(el('p', 'menu-soon', p.text));
        break;
      case 'host': {
        this.el.append(this.shareBox(p.lobby.transport.code), this.formBox, this.playersBox, this.chatBox((text) => p.lobby.sayOwn(text)));
        const start = el('button', 'menu-small active', t('menu.start'));
        start.onclick = this.click(() => {
          const info = p.lobby.start(randomSeed());
          if (!info) return;
          keepNetworkSetup(p.lobby.setup);
          this.launch(p.lobby, info);
        });
        this.actionBtn = start;
        row.append(this.statusEl, start);
        this.refreshHost(p.lobby);
        break;
      }
      case 'client': {
        this.el.append(el('p', 'lobby-share', t('lobby.joined', { code: p.lobby.transport.code })), this.formBox, this.playersBox, this.chatBox((text) => p.lobby.say(text)));
        const ready = el('button', 'menu-small active', t('lobby.readyBtn'));
        ready.onclick = this.click(() => p.lobby.setReady(!p.lobby.ready));
        this.actionBtn = ready;
        row.append(this.statusEl, ready);
        this.refreshClient(p.lobby);
        break;
      }
    }
    this.el.append(row);
  }

  /** «Create» and «Join by code». */
  private chooser(error?: string): HTMLElement {
    const box = el('div', 'lobby-choose');
    const create = el('button', 'menu-btn');
    create.append(el('span', 'mb-text', t('lobby.create')), el('span', 'mb-note', t('lobby.createNote')));
    create.onclick = this.click(() => void this.create());
    const joinRow = el('div', 'lobby-join');
    const code = el('input');
    code.type = 'text';
    code.maxLength = 9;
    code.placeholder = t('lobby.codePlaceholder');
    code.setAttribute('aria-label', t('lobby.code'));
    const join = el('button', 'menu-small active', t('lobby.join'));
    const msg = el('p', 'setup-problem', error ?? '');
    const go = () => {
      const c = normaliseCode(code.value);
      if (!c) {
        msg.textContent = t('lobby.badCode');
        return;
      }
      void this.connect(c);
    };
    join.onclick = this.click(go);
    code.onkeydown = (e) => {
      if (e.key === 'Enter') go();
    };
    joinRow.append(el('span', 'set-name', t('lobby.code')), code, join);
    box.append(create, joinRow, msg);
    queueMicrotask(() => create.focus());
    return box;
  }

  /** The host's code and link, with a copy button. */
  private shareBox(code: string): HTMLElement {
    const box = el('div', 'lobby-share');
    const link = new URL(withLang(`${location.pathname}?join=${code}`), location.href).href;
    const input = el('input');
    input.type = 'text';
    input.readOnly = true;
    input.value = link;
    input.setAttribute('aria-label', t('lobby.link'));
    input.onfocus = () => input.select();
    const copy = el('button', 'menu-small', t('lobby.copy'));
    copy.onclick = this.click(() => {
      const done = () => (copy.textContent = t('lobby.copied'));
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, () => input.select());
      else {
        input.select();
        document.execCommand?.('copy');
        done();
      }
    });
    const head = el('div', 'lobby-code');
    head.append(el('span', '', t('lobby.code')), el('b', 'code', code));
    const linkRow = el('div', 'lobby-link');
    linkRow.append(input, copy);
    box.append(head, linkRow, el('p', 'muted', t('lobby.shareNote')));
    return box;
  }

  /** The chat: the lines so far and a field to say something. */
  private chatBox(say: (text: string) => void): HTMLElement {
    const box = el('div', 'lobby-chat');
    box.append(el('h4', '', t('lobby.chat')));
    const input = el('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = t('lobby.chatPlaceholder');
    const send = el('button', 'menu-small', t('lobby.say'));
    const go = () => {
      if (input.value.trim()) say(input.value);
      input.value = '';
      input.focus();
    };
    send.onclick = this.click(go);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') go();
      e.stopPropagation();
    };
    const line = el('div', 'lobby-chat-row');
    line.append(input, send);
    box.append(this.chatLog, line);
    return box;
  }

  private showChat(chat: readonly ChatLine[], setup: GameSetup | null): void {
    // Lines drop off the front of a long chat: redraw then.
    if (chat.length < this.chatSeen) {
      this.chatLog.innerHTML = '';
      this.chatSeen = 0;
    }
    for (const c of chat.slice(this.chatSeen)) {
      const who = el('b', '', `${seatName(setup, c.slot)}: `);
      who.style.color = colourOf(setup, c.slot);
      const p = el('p');
      p.append(who, document.createTextNode(c.text));
      this.chatLog.append(p);
    }
    this.chatSeen = chat.length;
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  /** The players: the host and every slot over the network, ready or not, with the ping. */
  private showPlayers(setup: GameSetup, members: readonly LobbyMember[], self: number, host: boolean, kick?: (slot: number) => void): void {
    const box = this.playersBox;
    box.innerHTML = '';
    box.append(el('h4', '', t('lobby.players')));
    const list = el('div', 'lobby-list');
    setup.slots.forEach((s, k) => {
      if (k !== 0 && s.kind !== 'remote') return;
      const m = members.find((x) => x.slot === k);
      const row = el('div', 'lobby-player');
      const dot = el('span', 'slot-color', String(seatOf(setup, k)));
      dot.style.background = colourOf(setup, k);
      const name = k === 0 ? (host ? t('lobby.hostYou') : t('lobby.host')) : k === self ? t('common.you') : slotKindName('remote');
      const state = k === 0 ? '' : !m ? t('lobby.empty') : m.ready ? t('lobby.ready') : t('lobby.notReady');
      row.append(dot, el('span', 'lp-name', name), el('span', `lp-state${m?.ready ? ' ready' : ''}`, state));
      row.append(el('span', 'lp-ping', m && m.ping !== null ? t('lobby.ping', { n: Math.round(m.ping) }) : ''));
      if (kick && m) {
        const b = el('button', 'menu-small danger', t('lobby.kick'));
        b.onclick = this.click(() => kick(k));
        row.append(b);
      }
      list.append(row);
    });
    box.append(list);
  }

  private refreshHost(lobby: LobbyHost): void {
    if (this.phase.k !== 'host') return;
    const key = JSON.stringify(lobby.memberList().map((m) => [m.slot]));
    // The form is redrawn when a player came or went (their slots lock); it edits the setup itself.
    if (key !== this.formKey) {
      this.formKey = key;
      const taken = new Set(lobby.memberList().map((m) => m.slot));
      this.formBox.replaceChildren(
        setupForm(lobby.setup, () => lobby.changed(), {
          who: (k) => (k === 0 ? t('lobby.hostYou') : taken.has(k) ? slotKindName('remote') : null),
        }),
      );
    }
    this.showPlayers(lobby.setup, lobby.memberList(), 0, true, (slot) => lobby.kick(slot));
    this.showChat(lobby.chat, lobby.setup);
    const problem = lobby.problem();
    this.statusEl.textContent = problem ?? '';
    if (this.actionBtn) this.actionBtn.disabled = problem !== null;
  }

  private refreshClient(lobby: LobbyClient): void {
    if (this.phase.k !== 'client') return;
    if (lobby.refused) {
      const r = lobby.refused;
      return this.gone(r.why === 'version' ? t('lobby.refused.version', { host: r.build, mine: BUILD_ID }) : r.why === 'started' ? t('lobby.refused.started') : t('lobby.refused.full'));
    }
    if (lobby.started) return this.launch(lobby, lobby.started);
    if (lobby.hostLost) return this.gone(t('lobby.hostLeft'));
    const setup = lobby.setup;
    if (!setup || lobby.slot === null) {
      this.statusEl.textContent = t('lobby.connecting');
      if (this.actionBtn) this.actionBtn.disabled = true;
      return;
    }
    const key = JSON.stringify(setup);
    if (key !== this.formKey) {
      this.formKey = key;
      const own = lobby.slot;
      this.formBox.replaceChildren(
        setupForm({ ...setup, slots: setup.slots.map((s) => ({ ...s })) }, () => {}, {
          readOnly: true,
          ownSlot: own,
          who: (k) => (k === 0 ? t('lobby.host') : k === own ? t('common.you') : slotKindName(setup.slots[k].kind)),
          onTeam: (team) => lobby.setTeam(team),
        }),
      );
    }
    this.showPlayers(setup, lobby.members, lobby.slot, false);
    this.showChat(lobby.chat, setup);
    const rtt = lobby.rtt();
    const parts = [lobby.ready ? t('lobby.waitHost') : '', rtt !== null ? t('lobby.ping', { n: Math.round(rtt) }) : ''];
    this.statusEl.textContent = parts.filter((p) => p).join(' · ');
    if (this.actionBtn) {
      this.actionBtn.disabled = false;
      this.actionBtn.textContent = lobby.ready ? t('lobby.notReadyBtn') : t('lobby.readyBtn');
      this.actionBtn.classList.toggle('active', !lobby.ready);
    }
  }

  private gone(text: string): void {
    const p = this.phase;
    if (p.k === 'host' || p.k === 'client') {
      p.lobby.dispose();
      p.lobby.transport.close();
    }
    this.phase = { k: 'gone', text };
    this.render();
  }

  /** The game starts: the lobby lets go of the transport, which the game keeps. */
  private launch(lobby: LobbyHost | LobbyClient, info: StartInfo): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    lobby.dispose();
    this.el.replaceChildren(el('p', 'menu-text', t('lobby.starting')));
    this.actions.start(lobby.transport, info);
  }

  private leave(): void {
    this.dispose();
    this.actions.back();
  }
}

/** A slot's player number (position among the slots that play), as the game numbers players. */
function seatOf(setup: GameSetup | null, slot: number): number {
  if (!setup) return slot + 1;
  return activeSlots(setup).indexOf(setup.slots[slot]) + 1;
}

function colourOf(setup: GameSetup | null, slot: number): string {
  const n = seatOf(setup, slot);
  return n > 0 ? PLAYER_COLORS[(n - 1) % PLAYER_COLORS.length] : '#888';
}

function seatName(setup: GameSetup | null, slot: number): string {
  return slot === 0 ? t('lobby.host') : t('common.player', { id: seatOf(setup, slot) });
}

const NET_SETUP_KEY = 'settlers.netSetup';

/** The host's last network setup (guarded storage), so the lobby opens as it was left. */
function lastNetworkSetup(): GameSetup {
  let s: GameSetup | null = null;
  try {
    s = parseSetup(localStorage.getItem(NET_SETUP_KEY));
  } catch {
    s = null;
  }
  if (s) return { ...s, mode: 'network' };
  // The first time: the host and one player over the network, each on its own.
  const d = defaultSetup();
  d.mode = 'network';
  d.slots[1].kind = 'remote';
  return d;
}

function keepNetworkSetup(s: GameSetup): void {
  try {
    localStorage.setItem(NET_SETUP_KEY, JSON.stringify(s));
  } catch {
    // Not kept.
  }
}
