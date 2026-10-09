import { button, el, type View } from './dom';
import { t, type Key } from './i18n';
import type { GameState } from './state';

export const SPEEDS = [1, 2, 4];
/** The controls help: keys and what they do. */
const HELP: [Key, Key][] = [
  ['help.camera', 'help.cameraDo'],
  ['help.zoom', 'help.zoomDo'],
  ['help.building', 'help.buildingDo'],
  ['help.settler', 'help.settlerDo'],
  ['help.digits', 'help.digitsDo'],
  ['help.shift', 'help.shiftDo'],
  ['help.alt', 'help.altDo'],
  ['help.ctrl', 'help.ctrlDo'],
  ['help.backspace', 'help.backspaceDo'],
  ['help.altRight', 'help.altRightDo'],
  ['help.cancel', 'help.cancelDo'],
  ['help.esc', 'help.escDo'],
  ['help.pause', 'help.pauseDo'],
  ['help.space', 'help.spaceDo'],
  ['help.mute', 'help.muteDo'],
];

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
    this.el.append(el('h4', '', t('options.speed')));
    const speed = el('div', 'info-actions');
    const pause = button(t('options.pause'), t('options.pauseTip'), () => (state.paused = !state.paused));
    this.speedButtons.set('pause', pause);
    speed.append(pause);
    for (const s of SPEEDS) {
      const b = button(`${s}×`, t('options.speedTip', { n: s }), () => {
        state.speed = s;
        state.paused = false;
      });
      this.speedButtons.set(s, b);
      speed.append(b);
    }
    this.el.append(speed, el('h4', '', t('options.game')));
    const game = el('div', 'info-actions');
    game.append(
      button(t('saves.save'), t('pause.saveGame'), actions.onSave),
      button(t('saves.load'), t('options.loadTip'), actions.onLoad),
      button(t('options.menu'), t('options.menuTip'), actions.onMenu),
    );
    this.el.append(game);
    if (sound) this.el.append(el('h4', '', t('settings.sound')), sound);
    this.el.append(el('h4', '', t('options.controls')));
    const help = el('dl', 'help');
    for (const [k, v] of HELP) help.append(el('dt', '', t(k)), el('dd', '', t(v)));
    this.el.append(help);
  }

  update(): void {
    for (const [key, b] of this.speedButtons) {
      b.classList.toggle('active', key === 'pause' ? this.state.paused : !this.state.paused && this.state.speed === key);
    }
  }
}
