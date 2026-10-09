import type { AudioEngine } from '../audio/audio';
import { TICKS_PER_SECOND } from '../sim/config';
import type { World } from '../sim/world';
import { el } from './dom';
import { LANG_EVENT, t } from './i18n';
import { browserSlots, gameTime, type SlotMeta } from './saves';
import { savesPanel } from './savesPanel';
import { settingsPanel } from './settingsPanel';
import type { GameState } from './state';

/**
 * The in-game menu (Esc with nothing selected, or the options page): continue, save, load, settings,
 * back to the main menu. The game pauses while it is open (`GameState.menu` also keeps the map's
 * keys and clicks away) and resumes as it was.
 */
export type PauseScreen = 'main' | 'save' | 'load' | 'settings' | 'quit';

export interface PauseActions {
  /** Saves the game under `name` (into slot `id` to overwrite). */
  save(name: string, id?: string): Promise<boolean>;
  load(meta: SlotMeta): void;
  /** Leaves the game for the main menu. */
  quit(): void;
}

export class PauseMenu {
  readonly el = el('div', 'pause-menu');
  private readonly panel = el('div', 'menu-panel');
  private wasPaused = false;
  private readonly slots = browserSlots();

  constructor(
    private readonly world: World,
    private readonly state: GameState,
    private readonly actions: PauseActions,
    private readonly audio: AudioEngine,
  ) {
    this.el.hidden = true;
    this.el.append(this.panel);
    // A click beside the panel closes it, as Esc does.
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    // A language chosen in the settings: the open screen is drawn again in it.
    window.addEventListener(LANG_EVENT, () => {
      if (this.state.menu && this.el.dataset.screen) this.show(this.el.dataset.screen as PauseScreen);
    });
    window.addEventListener('keydown', (e) => {
      if (!this.state.menu) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (this.el.dataset.screen === 'main') this.close();
        else this.show('main');
      }
    }, true);
  }

  get isOpen(): boolean {
    return this.state.menu;
  }

  open(screen: PauseScreen = 'main'): void {
    if (!this.state.menu) {
      this.wasPaused = this.state.paused;
      this.state.paused = true;
      this.state.menu = true;
      this.el.hidden = false;
    }
    this.show(screen);
  }

  close(): void {
    if (!this.state.menu) return;
    this.state.menu = false;
    this.state.paused = this.wasPaused;
    this.el.hidden = true;
  }

  private show(screen: PauseScreen): void {
    this.el.dataset.screen = screen;
    this.panel.innerHTML = '';
    this.panel.className = `menu-panel screen-${screen}`;
    this.el.classList.toggle('wide', screen === 'save' || screen === 'load');
    const title = (t: string) => this.panel.append(el('h2', 'menu-title', t));
    const back = () => {
      const row = el('div', 'menu-row');
      const b = el('button', 'menu-small', t('common.back'));
      b.onclick = () => this.show('main');
      row.append(b);
      this.panel.append(row);
    };
    const item = (text: string, onclick: () => void) => {
      const b = el('button', 'menu-btn');
      b.append(el('span', 'mb-text', text));
      b.onclick = () => {
        this.audio.ui('click');
        onclick();
      };
      return b;
    };
    switch (screen) {
      case 'main': {
        title(t('pause.title'));
        const list = el('div', 'menu-list');
        list.append(
          item(t('pause.continue'), () => this.close()),
          item(t('saves.save'), () => this.show('save')),
          item(t('saves.load'), () => this.show('load')),
          item(t('menu.settings'), () => this.show('settings')),
          item(t('pause.quit'), () => this.show('quit')),
        );
        this.panel.append(list);
        break;
      }
      case 'save': {
        title(t('pause.saveGame'));
        const w = this.world;
        const suggest = `${w.map.w}×${w.map.h}, ${gameTime(w.tick, TICKS_PER_SECOND)}`;
        this.panel.append(savesPanel({ mode: 'save', slots: this.slots, onSave: (n, id) => this.actions.save(n, id), suggest }));
        back();
        break;
      }
      case 'load': {
        title(t('menu.loadGame'));
        this.panel.append(el('p', 'muted', t('pause.loadNote')));
        this.panel.append(savesPanel({ mode: 'load', slots: this.slots, onLoad: (m) => this.actions.load(m) }));
        back();
        break;
      }
      case 'settings':
        title(t('menu.settings'));
        this.panel.append(settingsPanel(this.audio, {}));
        back();
        break;
      case 'quit': {
        title(t('pause.quitTitle'));
        this.panel.append(el('p', 'menu-text', t('pause.quitNote')));
        const row = el('div', 'menu-row');
        const no = el('button', 'menu-small', t('pause.stay'));
        no.onclick = () => this.show('main');
        const yes = el('button', 'menu-small danger', t('pause.leave'));
        yes.onclick = () => this.actions.quit();
        row.append(no, yes);
        this.panel.append(row);
        break;
      }
    }
    queueMicrotask(() => this.panel.querySelector<HTMLElement>('input, button')?.focus());
  }
}
