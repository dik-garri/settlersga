import type { AudioEngine } from '../audio/audio';
import type { NetChatLine } from '../net/chat';
import type { ResumeStart } from '../net/core';
import { peerProvider } from '../net/peer';
import { normaliseCode, type Transport, type TransportProvider } from '../net/transport';
import { BUILD_ID } from '../net/version';
import { PLAYER_COLORS } from '../render/sprites';
import { TICKS_PER_SECOND } from '../sim/config';
import { el } from './dom';
import { dateTime, t, withLang } from './i18n';
import { LobbyClient, LobbyHost, type ChatLine, type LoadSeat, type LoadView, type LobbyMember, type StartInfo } from './lobby';
import { ownName } from './playerNames';
import { rejoinSeat } from './rejoinHint';
import { browserSlots, gameTime, type SaveSlots } from './saves';
import { activeSlots, defaultSetup, parseSetup, slotKindName, type GameSetup } from './setup';
import { nameField } from './settingsPanel';
import { setupForm } from './setupForm';

/**
 * The «Сетевая игра» screen (roadmap 6.5–6.7): create a game (this browser hosts it and gets a code
 * and a link) or join one by its code; then the lobby — the setup the host edits and everybody sees,
 * the players over the network with their ready flags and pings, a chat, and «Начать» for the host.
 * The host may load a network save instead of a new game (6.6): the save's setup, who plays each seat
 * without a player, and who has the save. A browser coming back to a game under way (6.7) is offered
 * the free seats, asks for its own, and starts where the others are once the host agreed. The own
 * player name can be changed here at any time (docs/NETWORK.md section 15): it is kept in the
 * preferences, and the host shows it to everybody with the players and in the chat.
 * Drawn into the main menu's panel; the logic is `lobby.ts`.
 */

/** What a network game starts with besides the transport and the host's decisions. */
export interface NetLaunchExtra {
  /** The lobby's chat, carried into the game. */
  chat: NetChatLine[];
  /** A returning browser: the snapshot it starts from. */
  resume?: ResumeStart;
}

export interface LobbyViewActions {
  /** The game starts: the transport and what the host decided go to the game. */
  start(transport: Transport, info: StartInfo, extra: NetLaunchExtra): void;
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
/** How often a returning browser asks again while its seat is still taken (ms). */
const ASK_AGAIN_MS = 2000;

export class LobbyView {
  readonly el = el('div', 'lobby');
  private phase: Phase = { k: 'choose' };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Parts redrawn on their own, so typing in the chat or a select is not interrupted. */
  private formBox = el('div', 'lobby-form');
  private loadBox = el('div', 'lobby-load');
  private playersBox = el('div', 'lobby-players');
  private chatLog = el('div', 'lobby-chat-log');
  private chatEl: HTMLElement | null = null;
  private statusEl = el('span', 'setup-problem');
  private actionBtn: HTMLButtonElement | null = null;
  private formKey = '';
  private loadKey = '';
  private chatSeen = 0;
  private closed = false;
  /** The host's list of network saves is open. */
  private picking = false;
  private lastAsk = 0;
  private readonly slots: SaveSlots = browserSlots();

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
    if (p.k === 'client') {
      this.returning(p.lobby);
      this.refreshClient(p.lobby);
    }
  }

  /** A browser coming back to a game under way: asks for its seat as soon as the host has it free. */
  private returning(lobby: LobbyClient): void {
    const g = lobby.ingame;
    if (!g || lobby.rejoinAsked !== null || lobby.refused) return;
    const hint = lobby.hint;
    if (hint !== null && g.vacant.includes(hint)) lobby.rejoin(hint);
    else if (hint !== null && g.busy.includes(hint) && performance.now() - this.lastAsk > ASK_AGAIN_MS) {
      // Not free yet: the host has not noticed the old connection is gone.
      this.lastAsk = performance.now();
      lobby.askAgain();
    }
  }

  private async create(): Promise<void> {
    this.phase = { k: 'busy', text: t('lobby.creating') };
    this.render();
    try {
      const transport = await this.provider.host();
      if (this.closed) return transport.close();
      const lobby = new LobbyHost(transport, lastNetworkSetup(), BUILD_ID, () => performance.now(), this.slots, ownName());
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
      const lobby = new LobbyClient(transport, BUILD_ID, () => performance.now(), { seat: rejoinSeat(code) ?? undefined, slots: this.slots, name: ownName() });
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
    this.loadKey = '';
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
        this.el.append(el('p', 'menu-soon', t('lobby.intro')), nameField(), this.chooser(p.error));
        break;
      case 'busy':
        this.el.append(el('p', 'menu-text', p.text));
        break;
      case 'gone':
        this.el.append(el('p', 'menu-soon', p.text));
        break;
      case 'host': {
        this.chatEl = this.chatBox((text) => p.lobby.sayOwn(text));
        this.el.append(this.shareBox(p.lobby.transport.code), nameField((name) => p.lobby.setName(name)), this.loadBox, this.formBox, this.playersBox, this.chatEl);
        const start = el('button', 'menu-small active', t('menu.start'));
        start.onclick = this.click(() => {
          const info = p.lobby.start(randomSeed());
          if (!info) return;
          if (!info.load) keepNetworkSetup(p.lobby.setup);
          this.launch(p.lobby, info, { chat: p.lobby.chatLines() });
        });
        this.actionBtn = start;
        row.append(this.statusEl, start);
        this.refreshHost(p.lobby);
        break;
      }
      case 'client': {
        this.chatEl = this.chatBox((text) => p.lobby.say(text));
        this.el.append(
          el('p', 'lobby-share', t('lobby.joined', { code: p.lobby.transport.code })),
          nameField((name) => p.lobby.setName(name)),
          this.loadBox,
          this.formBox,
          this.playersBox,
          this.chatEl,
        );
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

  private showChat(chat: readonly ChatLine[], setup: GameSetup | null, names: SlotNames): void {
    // Lines drop off the front of a long chat: redraw then.
    if (chat.length < this.chatSeen) {
      this.chatLog.innerHTML = '';
      this.chatSeen = 0;
    }
    for (const c of chat.slice(this.chatSeen)) {
      const who = el('b', '', `${slotLabel(setup, c.slot, names)}: `);
      who.style.color = colourOf(setup, c.slot);
      const p = el('p');
      p.append(who, document.createTextNode(c.text));
      this.chatLog.append(p);
    }
    this.chatSeen = chat.length;
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  /** The players: the host and every slot over the network, ready or not, with the ping. */
  private showPlayers(setup: GameSetup, members: readonly LobbyMember[], self: number, host: boolean, load: LoadView | null, names: SlotNames, kick?: (slot: number) => void): void {
    const box = this.playersBox;
    box.innerHTML = '';
    box.append(el('h4', '', t('lobby.players')));
    const list = el('div', 'lobby-list');
    setup.slots.forEach((s, k) => {
      const seat = load ? load.seats[k] : s.kind === 'remote' ? 'remote' : null;
      if (k !== names.hostSlot && seat !== 'remote') return;
      const m = members.find((x) => x.slot === k);
      const row = el('div', 'lobby-player');
      const dot = el('span', 'slot-color', String(seatOf(setup, k)));
      dot.style.background = colourOf(setup, k);
      const isHost = k === names.hostSlot;
      const marks = [isHost ? t('net.hostMark') : '', (isHost && host) || (!isHost && k === self) ? t('net.you') : ''].filter((x) => x);
      const label = isHost || m ? slotLabel(setup, k, names) : slotKindName('remote');
      const name = marks.length > 0 ? `${label} (${marks.join(', ')})` : label;
      let state = isHost ? '' : !m ? t('lobby.empty') : m.ready ? t('lobby.ready') : t('lobby.notReady');
      if (load && m && !m.has) state += ` · ${t('lobby.noSave')}`;
      // A loaded game: whose seat it was (players are seated by this name).
      const saved = load ? setup.slots[k].name : undefined;
      if (saved && saved !== (isHost ? names.host : m?.name)) state += ` · ${t('lobby.load.savedAs', { name: saved })}`;
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

  /** The host: «Load a network game», the list of network saves, or the save being loaded and its seats. */
  private showHostLoad(lobby: LobbyHost): void {
    const l = lobby.loadView();
    const key = JSON.stringify([l, this.picking, lobby.memberList().map((m) => m.slot)]);
    if (key === this.loadKey) return;
    this.loadKey = key;
    const box = this.loadBox;
    box.replaceChildren();
    if (!l) {
      const saves = this.slots.netSaves();
      const open = el('button', 'menu-small', this.picking ? t('lobby.load.hide') : t('lobby.load.button'));
      open.onclick = this.click(() => {
        this.picking = !this.picking;
        this.loadKey = '';
        this.refreshHost(lobby);
      });
      open.disabled = saves.length === 0;
      open.title = saves.length === 0 ? t('lobby.load.none') : t('lobby.load.tip');
      box.append(open);
      if (this.picking) {
        const list = el('div', 'save-list');
        for (const m of saves) {
          const row = el('div', 'save-row');
          const info = el('div', 'save-info');
          info.append(el('b', '', m.auto ? t('saves.auto') : m.name), el('span', '', saveLine(m.savedAt, m.size, m.players, m.tick)));
          const pick = el('button', 'menu-small active', t('saves.load'));
          pick.onclick = this.click(() => {
            this.picking = false;
            if (!lobby.loadSave(m)) this.statusEl.textContent = t('menu.saveNotFound');
          });
          row.append(info, pick);
          list.append(row);
        }
        box.append(list);
      }
      return;
    }
    const head = el('div', 'lobby-load-head');
    head.append(el('b', '', t('lobby.load.title', { name: l.name })), el('span', 'muted', saveLine(0, l.size, 0, l.tick)));
    const fresh = el('button', 'menu-small', t('lobby.load.fresh'));
    fresh.onclick = this.click(() => lobby.unload());
    head.append(fresh);
    box.append(head, el('p', 'muted', t('lobby.load.note')));
    // Who plays each seat over the network when nobody joins it.
    const taken = new Set(lobby.memberList().map((m) => m.slot));
    l.seats.forEach((s, k) => {
      if (s === null) return;
      const row = el('label', 'set-row');
      const sel = el('select');
      for (const [v, label] of [
        ['remote', slotKindName('remote')],
        ['ai', t('lobby.load.ai')],
        ['closed', t('lobby.load.nobody')],
      ] as [LoadSeat, string][]) {
        const o = el('option', '', label);
        o.value = v;
        sel.append(o);
      }
      sel.value = s;
      sel.onchange = () => lobby.setSeat(k, sel.value as LoadSeat);
      const saved = lobby.setup.slots[k].name;
      const label = `${t('common.player', { id: seatOf(lobby.setup, k) })}${saved ? ` · ${saved}` : ''}${taken.has(k) ? ` · ${t('lobby.load.taken')}` : ''}`;
      const name = el('span', 'set-name', label);
      row.append(name, sel);
      box.append(row);
    });
  }

  /** A joined player: the save the host is loading, and whether this browser has it. */
  private showClientLoad(lobby: LobbyClient): void {
    const l = lobby.load;
    const me = lobby.members.find((m) => m.slot === lobby.slot);
    const state = !l ? '' : me?.has ? t('lobby.load.have') : lobby.fileProgress !== null ? t('lobby.load.receiving', { n: Math.round(lobby.fileProgress * 100) }) : t('lobby.load.checking');
    const key = JSON.stringify([l, state]);
    if (key === this.loadKey) return;
    this.loadKey = key;
    this.loadBox.replaceChildren();
    if (!l) return;
    this.loadBox.append(el('b', '', t('lobby.load.title', { name: l.name })), el('span', 'muted', ` ${saveLine(0, l.size, 0, l.tick)} · ${state}`));
  }

  private refreshHost(lobby: LobbyHost): void {
    if (this.phase.k !== 'host') return;
    const load = lobby.loadView();
    const names = hostNames(lobby);
    const key = JSON.stringify([lobby.memberList().map((m) => [m.slot, m.name]), lobby.name, load?.id ?? null, load?.host ?? 0]);
    // The form is redrawn when a player came or went (their slots lock); it edits the setup itself.
    // A loaded game's setup is the save's and cannot be changed.
    if (key !== this.formKey) {
      this.formKey = key;
      const taken = new Set(lobby.memberList().map((m) => m.slot));
      this.formBox.replaceChildren(
        load
          ? setupForm({ ...lobby.setup, slots: lobby.setup.slots.map((s) => ({ ...s })) }, () => {}, {
              readOnly: true,
              who: (k) => (k === load.host ? youLabel(slotLabel(lobby.setup, k, names)) : load.seats[k] ? (taken.has(k) ? slotLabel(lobby.setup, k, names) : slotKindName('remote')) : null),
            })
          : setupForm(lobby.setup, () => lobby.changed(), {
              who: (k) => (k === 0 ? youLabel(slotLabel(lobby.setup, k, names)) : taken.has(k) ? slotLabel(lobby.setup, k, names) : null),
            }),
      );
    }
    this.showHostLoad(lobby);
    this.showPlayers(lobby.setup, lobby.memberList(), -1, true, load, names, (slot) => lobby.kick(slot));
    this.showChat(lobby.chat, lobby.setup, names);
    const problem = lobby.problem();
    this.statusEl.textContent = problem ?? '';
    if (this.actionBtn) this.actionBtn.disabled = problem !== null;
  }

  private refreshClient(lobby: LobbyClient): void {
    if (this.phase.k !== 'client') return;
    if (lobby.refused) {
      const r = lobby.refused;
      return this.gone(
        r.why === 'version'
          ? t('lobby.refused.version', { host: r.build, mine: BUILD_ID })
          : r.why === 'started'
            ? t('lobby.refused.started')
            : r.why === 'denied'
              ? t('lobby.refused.denied')
              : t('lobby.refused.full'),
      );
    }
    if (lobby.resumed) return this.launch(lobby, lobby.resumed.start as StartInfo, { chat: lobby.resumed.chat, resume: lobby.resumed });
    if (lobby.started) return this.launch(lobby, lobby.started, { chat: lobby.chatLines() });
    if (lobby.hostLost) return this.gone(t('lobby.hostLeft'));
    if (lobby.ingame) return this.showRejoin(lobby);
    const setup = lobby.setup;
    if (!setup || lobby.slot === null) {
      this.statusEl.textContent = t('lobby.connecting');
      if (this.actionBtn) this.actionBtn.disabled = true;
      return;
    }
    const names = clientNames(lobby);
    const key = JSON.stringify([setup, lobby.load?.id ?? null, lobby.members.map((m) => [m.slot, m.name]), lobby.hostName, lobby.slot]);
    if (key !== this.formKey) {
      this.formKey = key;
      const own = lobby.slot;
      const seated = (k: number) => lobby.members.some((m) => m.slot === k);
      this.formBox.replaceChildren(
        setupForm({ ...setup, slots: setup.slots.map((s) => ({ ...s })) }, () => {}, {
          readOnly: true,
          ownSlot: lobby.load ? undefined : own,
          who: (k) =>
            k === names.hostSlot
              ? `${slotLabel(setup, k, names)} (${t('net.hostMark')})`
              : k === own
                ? youLabel(slotLabel(setup, k, names))
                : seated(k)
                  ? slotLabel(setup, k, names)
                  : slotKindName(setup.slots[k].kind),
          onTeam: (team) => lobby.setTeam(team),
        }),
      );
    }
    this.showClientLoad(lobby);
    this.showPlayers(setup, lobby.members, lobby.slot, false, lobby.load, names);
    this.showChat(lobby.chat, setup, names);
    const rtt = lobby.rtt();
    const parts = [lobby.ready ? t('lobby.waitHost') : '', rtt !== null ? t('lobby.ping', { n: Math.round(rtt) }) : ''];
    this.statusEl.textContent = parts.filter((p) => p).join(' · ');
    if (this.actionBtn) {
      this.actionBtn.disabled = false;
      this.actionBtn.textContent = lobby.ready ? t('lobby.notReadyBtn') : t('lobby.readyBtn');
      this.actionBtn.classList.toggle('active', !lobby.ready);
    }
  }

  /** The game is under way: the seats this browser may take back, or how far its return has come. */
  private showRejoin(lobby: LobbyClient): void {
    const g = lobby.ingame!;
    const asked = lobby.rejoinAsked;
    const progress = lobby.snapshotProgress;
    const key = JSON.stringify(['rejoin', g, asked, progress === null ? null : Math.round(progress * 20)]);
    if (key === this.formKey) return;
    this.formKey = key;
    this.loadBox.replaceChildren();
    this.playersBox.replaceChildren();
    if (this.chatEl) this.chatEl.hidden = true;
    if (this.actionBtn) this.actionBtn.hidden = true;
    this.statusEl.textContent = '';
    const box = el('div', 'lobby-rejoin');
    box.append(el('p', 'menu-text', t('lobby.rejoin.underway')));
    if (asked !== null) {
      box.append(
        el(
          'p',
          'menu-text',
          progress !== null ? t('lobby.rejoin.loading', { n: Math.round(progress * 100) }) : t('lobby.rejoin.asked', { id: asked }),
        ),
      );
    } else if (g.vacant.length === 0) {
      const hint = lobby.hint;
      box.append(el('p', 'menu-soon', hint !== null && g.busy.includes(hint) ? t('lobby.rejoin.stillTaken', { id: hint }) : t('lobby.rejoin.none')));
    } else {
      const list = el('div', 'lobby-list');
      for (const seat of g.vacant) {
        const name = g.names.get(seat);
        const b = el('button', 'menu-small active', `${t('lobby.rejoin.take', { id: seat })}${name ? ` · ${name}` : ''}`);
        b.style.borderLeft = `6px solid ${PLAYER_COLORS[(seat - 1) % PLAYER_COLORS.length]}`;
        b.onclick = this.click(() => lobby.rejoin(seat));
        list.append(b);
      }
      box.append(el('p', 'muted', t('lobby.rejoin.pick')), list);
    }
    this.formBox.replaceChildren(box);
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
  private launch(lobby: LobbyHost | LobbyClient, info: StartInfo, extra: NetLaunchExtra): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    lobby.dispose();
    this.el.replaceChildren(el('p', 'menu-text', t(extra.resume ? 'lobby.rejoin.starting' : 'lobby.starting')));
    this.actions.start(lobby.transport, info, extra);
  }

  private leave(): void {
    this.dispose();
    this.actions.back();
  }
}

/** A save's line: when, map, players and game time (parts left out when 0). */
function saveLine(savedAt: number, size: number, players: number, tick: number): string {
  const parts = [savedAt > 0 ? dateTime(savedAt) : '', size > 0 ? `${size}×${size}` : '', players > 0 ? t('lobby.load.players', { n: players }) : '', gameTime(tick, TICKS_PER_SECOND)];
  return parts.filter((p) => p).join(' · ');
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

/** Who sits where in the lobby, for names: the host's slot and name, every seated player's name. */
interface SlotNames {
  hostSlot: number;
  host: string;
  members: readonly LobbyMember[];
}

const hostNames = (lobby: LobbyHost): SlotNames => ({ hostSlot: lobby.hostSlot(), host: lobby.name, members: lobby.memberList() });
const clientNames = (lobby: LobbyClient): SlotNames => ({ hostSlot: lobby.load?.host ?? 0, host: lobby.hostName, members: lobby.members });

/** A slot's player in the lobby: his name, else «Хост» or «Игрок N». */
function slotLabel(setup: GameSetup | null, slot: number, names: SlotNames): string {
  const name = slot === names.hostSlot ? names.host : names.members.find((m) => m.slot === slot)?.name;
  if (name) return name;
  return slot === names.hostSlot ? t('lobby.host') : t('common.player', { id: seatOf(setup, slot) });
}

/** A label with «(вы)». */
const youLabel = (label: string): string => t('name.you', { name: label });

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
