import type { AudioEngine } from '../audio/audio';
import { el } from './dom';
import { browserSlots, type SlotMeta } from './saves';
import { savesPanel } from './savesPanel';
import { defaultSetup, parseSetup, type GameSetup } from './setup';
import { setupForm } from './setupForm';
import { settingsPanel } from './settingsPanel';

/**
 * The main menu, laid out like Settlers 4's (a column of choices over a live scene; every look and
 * word ours): «Новая игра» (the setup screen), «Загрузить» (save slots), «Сетевая игра» (the same
 * setup screen as a lobby, inactive until phase 7), «Настройки», «Об игре» and «Выход» (back to the
 * intro — a browser page has nothing to quit to). Plain DOM over the title scene; arrow keys move
 * between the choices, Esc goes back.
 */
export type MenuScreen = 'main' | 'new' | 'network' | 'load' | 'settings' | 'about';

export interface MenuActions {
  start(setup: GameSetup): void;
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
  private screen: MenuScreen = 'main';
  private readonly slots = browserSlots();

  constructor(
    private readonly actions: MenuActions,
    private readonly audio: AudioEngine,
  ) {
    const mark = el('h1', 'wordmark');
    mark.append(el('span', 'wm-title', 'Поселенцы'), el('span', 'wm-sub', 'экономическая стратегия'));
    const foot = el('footer', 'menu-foot', 'Прототип в духе The Settlers 3/4. Графика, музыка и тексты — свои.');
    this.notice.hidden = true;
    this.el.append(mark, this.panel, this.notice, foot);
    this.el.addEventListener('keydown', (e) => this.onKey(e));
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
    this.el.classList.toggle('wide', screen === 'new' || screen === 'network' || screen === 'load');
    switch (screen) {
      case 'main':
        return this.main();
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
    const b = el('button', 'menu-small', 'Назад');
    b.onclick = () => this.show('main');
    row.prepend(b);
  }

  private main(): void {
    const list = el('div', 'menu-list');
    list.append(
      this.choice('Новая игра', 'свободная игра против компьютера', () => this.show('new')),
      this.choice('Загрузить', 'продолжить сохранённую игру', () => this.show('load')),
      this.choice('Сетевая игра', 'скоро появится', () => this.show('network'), true),
      this.choice('Настройки', 'звук, графика, заставка', () => this.show('settings')),
      this.choice('Об игре', '', () => this.show('about')),
      this.choice('Выход', 'к заставке', () => this.actions.intro()),
    );
    this.panel.append(list);
    this.focusFirst();
  }

  private setupScreen(network: boolean): void {
    const setup = lastSetup();
    setup.mode = network ? 'network' : 'single';
    this.heading(network ? 'Сетевая игра' : 'Новая игра');
    if (network) {
      this.panel.append(
        el(
          'p',
          'menu-soon',
          'Сетевая игра скоро появится: здесь будет лобби — игроки по сети занимают места, и все видят одни и те же настройки партии.',
        ),
      );
    }
    const start = el('button', 'menu-small active', 'Начать');
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
    this.heading('Загрузить игру');
    this.panel.append(savesPanel({ mode: 'load', slots: this.slots, onLoad: (m) => this.actions.load(m) }));
    const row = el('div', 'menu-row');
    this.back(row);
    this.panel.append(row);
    this.focusFirst();
  }

  private settingsScreen(): void {
    this.heading('Настройки');
    this.panel.append(settingsPanel(this.audio, { onArt: () => this.actions.artChanged(), onShowIntro: () => this.actions.intro() }));
    const row = el('div', 'menu-row');
    this.back(row);
    this.panel.append(row);
    this.focusFirst();
  }

  private aboutScreen(): void {
    this.heading('Об игре');
    const text = el('div', 'about');
    for (const p of [
      'Экономическая стратегия в духе The Settlers 3 и 4: поселенцы рубят лес, добывают камень и руду, пекут хлеб и куют оружие, носильщики сами разносят товары, а солдаты защищают и раздвигают границы.',
      'Это любительский прототип. Вся графика (3D-модели из Blender), музыка, звуки и тексты сделаны для него заново; ролики, музыка, логотипы и картинки оригинальных игр не используются.',
      'Управление: ЛКМ — выбрать и строить, ПКМ — отмена или приказ отряду, колесо — приближение, пробел — пауза, Esc — меню игры.',
    ]) {
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
