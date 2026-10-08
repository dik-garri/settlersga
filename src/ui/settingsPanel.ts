import type { AudioEngine } from '../audio/audio';
import { el } from './dom';
import { readPrefs, writePrefs } from './prefs';

/**
 * «Настройки», shared by the main menu and the in-game pause menu: sound (on/off, volume, music),
 * graphics (3D or classic art), the intro, and the language (Russian only for now). The art is
 * chosen when the game starts: in the menu `onArt` reloads at once, in a game it applies next time.
 */
export function settingsPanel(audio: AudioEngine, opts: { onArt?: () => void; onShowIntro?: () => void }): HTMLElement {
  const box = el('div', 'settings');
  const row = (label: string, ...control: HTMLElement[]) => {
    const r = el('label', 'set-row');
    r.append(el('span', 'set-name', label), ...control);
    box.append(r);
    return r;
  };
  const check = (on: boolean, change: (on: boolean) => void) => {
    const c = el('input');
    c.type = 'checkbox';
    c.checked = on;
    c.onchange = () => change(c.checked);
    return c;
  };

  box.append(el('h4', '', 'Звук'));
  row('Звук включён', check(!audio.settings.muted, (on) => audio.setMuted(!on)));
  const volume = el('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.value = String(Math.round(audio.settings.volume * 100));
  volume.oninput = () => audio.setVolume(Number(volume.value) / 100);
  row('Громкость', volume);
  row('Музыка', check(audio.settings.music, (on) => audio.setMusic(on)));

  box.append(el('h4', '', 'Графика'));
  const art = el('select');
  for (const [v, text] of [
    ['3d', 'Объёмная (3D)'],
    ['classic', 'Классическая (рисованная)'],
  ]) {
    const o = el('option', '', text);
    o.value = v;
    art.append(o);
  }
  art.value = readPrefs().art;
  art.onchange = () => {
    writePrefs({ art: art.value === 'classic' ? 'classic' : '3d' });
    opts.onArt?.();
  };
  row('Оформление', art);
  if (!opts.onArt) box.append(el('p', 'muted', 'Оформление меняется со следующей партии.'));

  box.append(el('h4', '', 'Заставка'));
  row('Показывать при каждом запуске', check(readPrefs().intro, (on) => writePrefs({ intro: on })));
  if (opts.onShowIntro) {
    const show = el('button', 'menu-small', 'Показать заставку');
    show.onclick = opts.onShowIntro;
    box.append(show);
  }

  box.append(el('h4', '', 'Язык'));
  const lang = el('select');
  lang.append(el('option', '', 'Русский'));
  lang.disabled = true;
  row('Язык игры', lang);
  return box;
}
