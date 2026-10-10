import type { AudioEngine } from '../audio/audio';
import { el } from './dom';
import { LANG_EVENT, t, type Key } from './i18n';
import { browserSlots, type SlotMeta } from './saves';
import { savesPanel } from './savesPanel';
import { defaultSetup, parseSetup, type GameSetup } from './setup';
import { setupForm } from './setupForm';
import { settingsPanel } from './settingsPanel';

/**
 * The main menu, laid out like Settlers 4's (a column of choices over a live scene; every look and
 * word ours): «Обучение» first (the tutorial missions, `src/tutorial`), «Новая игра» (the setup screen), «Загрузить» (save slots), «Сетевая игра» (the same
 * setup screen as a lobby, inactive until phase 6), «Настройки», «Об игре» and «Выход» (back to the
 * intro — a browser page has nothing to quit to). Plain DOM over the title scene; arrow keys move
 * between the choices, Esc goes back.
 */
export type MenuScreen = 'main' | 'tutorial' | 'new' | 'network' | 'load' | 'settings' | 'about';

/** A tutorial mission as the menu lists it (`src/tutorial` supplies them through `MenuActions`). */
export interface TutorialEntry {
  id: string;
  title: Key;
  summary: Key;
  minutes: number;
  done: boolean;
  /** Not playable yet: shown as coming. */
  soon: boolean;
}

export interface MenuActions {
  start(setup: GameSetup): void;
  /** The tutorial missions with their completion marks, and starting one. */
  tutorials(): TutorialEntry[];
  tutorial(id: string): void;
  load(meta: SlotMeta): void;
  /** Plays the intro again (from «Выход» and the settings). */
  intro(): void;
  /** The art changed in the settings: start over with it. */
  artChanged(): void;
}

const SETUP_KEY = 'settlers.setup';

/** The last setup started, so the screen opens as the player left it (guarded storage). */
function lastSetup(): GameSetup {
  try {
    return parseSetup(localStorage.getItem(SETUP_KEY)) ?? defaultSetup();
  } catch {
    return defaultSetup();
  }
}

function keepSetup(s: GameSetup): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s));
  } catch {
    // Not kept.
  }
}

export class MainMenu {
  readonly el = el('div', 'menu');
  private readonly panel = el('div', 'menu-panel');
  private readonly notice = el('p', 'menu-notice');
  private readonly mark = el('h1', 'wordmark');
  private readonly foot = el('footer', 'menu-foot');
  private screen: MenuScreen = 'main';
  private readonly slots = browserSlots();

  constructor(
    private readonly actions: MenuActions,
    private readonly audio: AudioEngine,
  ) {
    this.notice.hidden = true;
    this.el.append(this.mark, this.panel, this.notice, this.foot);
    this.label();
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    // A language chosen in the settings: everything is drawn again in it, the screen stays.
    window.addEventListener(LANG_EVENT, () => {
      this.label();
      this.show(this.screen);
    });
  }

  /** The wordmark and the footer in the current language. */
  private label(): void {
    this.mark.replaceChildren(el('span', 'wm-title', t('app.title')), el('span', 'wm-sub', t('app.subtitle')));
    this.foot.textContent = t('menu.foot');
  }

  /** A one-line message under the panel (e.g. a save that could not be read). */
  say(text: string): void {
    this.notice.textContent = text;
    this.notice.hidden = !text;
  }

  show(screen: MenuScreen): void {
    this.screen = screen;
    this.panel.innerHTML = '';
    this.panel.className = `menu-panel screen-${screen}`;
    this.el.classList.toggle('wide', screen === 'new' || screen === 'network' || screen === 'load' || screen === 'tutorial');
    switch (screen) {
      case 'main':
        return this.main();
      case 'tutorial':
        return this.tutorialScreen();
      case 'new':
      case 'network':
        return this.setupScreen(screen === 'network');
      case 'load':
        return this.loadScreen();
      case 'settings':
        return this.settingsScreen();
      case 'about':
        return this.aboutScreen();
    }
  }

  private choice(text: string, note: string, onclick: () => void, disabled = false): HTMLButtonElement {
    const b = el('button', 'menu-btn');
    b.append(el('span', 'mb-text', text));
    if (note) b.append(el('span', 'mb-note', note));
    b.onclick = () => {
      this.audio.ui('click');
      onclick();
    };
    if (disabled) b.classList.add('soon');
    return b;
  }

  private heading(text: string): void {
    this.panel.append(el('h2', 'menu-title', text));
  }

  private back(row: HTMLElement): void {
    const b = el('button', 'menu-small', t('common.back'));
    b.onclick = () => this.show('main');
    row.prepend(b);
  }

  private main(): void {
    const list = el('div', 'menu-list');
    // Settlers 4: the tutorial is the first choice; softly lit while nothing was played or saved.
    const tutorial = this.choice(t('tut.menu.title'), t('tut.menu.note'), () => this.show('tutorial'));
    if (!this.actions.tutorials().some((m) => m.done) && this.slots.list().length === 0) tutorial.classList.add('suggest');
    list.append(
      tutorial,
      this.choice(t('menu.new'), t('menu.newNote'), () => this.show('new')),
      this.choice(t('menu.load'), t('menu.loadNote'), () => this.show('load')),
      this.choice(t('menu.network'), t('menu.networkNote'), () => this.show('network'), true),
      this.choice(t('menu.settings'), t('menu.settingsNote'), () => this.show('settings')),
      this.choice(t('menu.about'), '', () => this.show('about')),
      this.choice(t('menu.exit'), t('menu.exitNote'), () => this.actions.intro()),
    );
    this.panel.append(list);
    this.focusFirst();
  }

  /** The tutorial: the missions in order, what each teaches, its length and whether it was completed. */
  private tutorialScreen(): void {
    this.heading(t('tut.menu.title'));
    this.panel.append(el('p', 'menu-soon', t('tut.menu.intro')));
    const list = el('div', 'tut-missions');
    this.actions.tutorials().forEach((m, k) => {
      const b = el('button', `tut-mission${m.done ? ' done' : ''}`);
      const head = el('span', 'tm-head');
      head.append(el('span', 'tm-number', t('tut.menu.number', { n: k + 1 })), el('span', 'tm-title', t(m.title)));
      const foot = el('span', 'tm-foot');
      foot.append(el('span', '', t('tut.menu.minutes', { n: m.minutes })));
      if (m.soon) foot.append(el('span', 'tm-soon', t('tut.menu.soon')));
      else if (m.done) foot.append(el('span', 'tm-done', t('tut.menu.done')));
      b.append(head, el('span', 'tm-summary', t(m.summary)), foot);
      b.disabled = m.soon;
      b.onclick = () => {
        this.audio.ui('click');
        this.actions.tutorial(m.id);
      };
      list.append(b);
    });
    this.panel.append(list);
    const row = el('div', 'menu-row');
    this.back(row);
    this.panel.append(row);
    this.focusFirst();
  }

  private setupScreen(network: boolean): void {
    const setup = lastSetup();
    setup.mode = network ? 'network' : 'single';
    this.heading(network ? t('menu.network') : t('menu.new'));
    if (network) {
      this.panel.append(
        el(
          'p',
          'menu-soon',
          t('menu.networkSoon'),
        ),
      );
    }
    const start = el('button', 'menu-small active', t('menu.start'));
    const problem = el('span', 'setup-problem');
    this.panel.append(
      setupForm(setup, (p) => {
        problem.textContent = p ?? '';
        start.disabled = p !== null;
      }),
    );
    start.onclick = () => {
      keepSetup({ ...setup, mode: 'single' });
      this.actions.start(setup);
    };
    const row = el('div', 'menu-row');
    row.append(problem, start);
    this.back(row);
    this.panel.append(row);
    start.focus();
  }

  private loadScreen(): void {
    this.heading(t('menu.loadGame'));
    this.panel.append(savesPanel({ mode: 'load', slots: this.slots, onLoad: (m) => this.actions.load(m) }));
    const row = el('div', 'menu-row');
    this.back(row);
    this.panel.append(row);
    this.focusFirst();
  }

  private settingsScreen(): void {
    this.heading(t('menu.settings'));
    this.panel.append(settingsPanel(this.audio, { onArt: () => this.actions.artChanged(), onShowIntro: () => this.actions.intro() }));
    const row = el('div', 'menu-row');
    this.back(row);
    this.panel.append(row);
    this.focusFirst();
  }

  private aboutScreen(): void {
    this.heading(t('menu.about'));
    const text = el('div', 'about');
    for (const p of [t('menu.about1'), t('menu.about2'), t('menu.about3')]) {
      text.append(el('p', '', p));
    }
    this.panel.append(text);
    const row = el('div', 'menu-row');
    this.back(row);
    this.panel.append(row);
    this.focusFirst();
  }

  private focusFirst(): void {
    queueMicrotask(() => this.panel.querySelector<HTMLElement>('button, select, input')?.focus());
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.screen !== 'main') {
      e.preventDefault();
      this.show('main');
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
    const items = [...this.panel.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    if (items.length === 0) return;
    e.preventDefault();
    const k = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? (k + 1) % items.length : (k - 1 + items.length) % items.length;
    items[next].focus();
  }
}
