import { button, el, type View } from './dom';
import type { GameState } from './state';

export const SPEEDS = [1, 2, 4];

/** What the game's menus can do (opened by `PauseMenu`). */
export interface GameActions {
  onSave(): void;
  onLoad(): void;
  onMenu(): void;
}

/**
 * The options menu: game speed, the game menu (save, load, settings, main menu — `PauseMenu`), sound
 * and the controls. The speed also has quick buttons in the top strip.
 */
export class OptionsView implements View {
  readonly el = el('div', 'view options-view');
  private readonly speedButtons = new Map<number | 'pause', HTMLButtonElement>();

  constructor(
    private readonly state: GameState,
    actions: GameActions,
    sound: HTMLElement | null,
  ) {
    this.el.append(el('h4', '', 'Скорость'));
    const speed = el('div', 'info-actions');
    const pause = button('Пауза', 'Пауза (пробел)', () => (state.paused = !state.paused));
    this.speedButtons.set('pause', pause);
    speed.append(pause);
    for (const s of SPEEDS) {
      const b = button(`${s}×`, `Скорость ${s}×`, () => {
        state.speed = s;
        state.paused = false;
      });
      this.speedButtons.set(s, b);
      speed.append(b);
    }
    this.el.append(speed, el('h4', '', 'Игра'));
    const game = el('div', 'info-actions');
    game.append(
      button('Сохранить', 'Сохранить игру', actions.onSave),
      button('Загрузить', 'Загрузить сохранение', actions.onLoad),
      button('Меню', 'Меню игры: настройки, выход в главное меню (Esc)', actions.onMenu),
    );
    this.el.append(game);
    if (sound) this.el.append(el('h4', '', 'Звук'), sound);
    this.el.append(el('h4', '', 'Управление'));
    const help = el('dl', 'help');
    for (const [k, v] of [
      ['Перетаскивание, WASD', 'камера'],
      ['Колесо', 'приближение'],
      ['ЛКМ по зданию', 'окно здания'],
      ['ЛКМ по поселенцу', 'окно поселенца (что делает, уровень и здоровье бойца)'],
      ['1–9, Tab', 'здание, категория'],
      ['Shift + ЛКМ', 'поставить несколько'],
      ['ПКМ / Esc', 'отмена'],
      ['Esc (ничего не выбрано)', 'меню игры'],
      ['Пробел', 'пауза'],
      ['M', 'звук'],
    ]) {
      help.append(el('dt', '', k), el('dd', '', v));
    }
    this.el.append(help);
  }

  update(): void {
    for (const [key, b] of this.speedButtons) {
      b.classList.toggle('active', key === 'pause' ? this.state.paused : !this.state.paused && this.state.speed === key);
    }
  }
}
