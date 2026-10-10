import type { AudioEngine } from '../audio/audio';
import { el } from './dom';
import { lang, LANG_NAMES, LANGS, setLang, t, type Lang } from './i18n';
import { NAME_MAX } from '../net/names';
import { chosenName, defaultName, setOwnName } from './playerNames';
import { readPrefs, writePrefs } from './prefs';

/**
 * The player's name (docs/NETWORK.md section 15): a field over `Prefs.name` — the default name as a
 * hint while none is chosen; cleaned and kept when it changes (Enter or leaving the field), then
 * `onChange` gets the name in force (the network lobby tells the host). Typing stays in the field.
 */
/** Fired on `window` when the player's own name changed (a game on one machine shows it at once). */
export const NAME_EVENT = 'namechange';

export function nameField(onChange?: (name: string) => void): HTMLElement {
  const r = el('label', 'set-row name-row');
  const input = el('input');
  input.type = 'text';
  input.maxLength = NAME_MAX;
  input.placeholder = defaultName();
  input.value = chosenName() ?? '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.title = t('settings.nameTip');
  const apply = () => {
    const name = setOwnName(input.value);
    input.value = chosenName() ?? '';
    window.dispatchEvent(new Event(NAME_EVENT));
    onChange?.(name);
  };
  input.onchange = apply;
  input.onkeydown = (e) => {
    // The game's and the menu's keys stay out of the field.
    e.stopPropagation();
    if (e.key === 'Enter') input.blur();
  };
  r.append(el('span', 'set-name', t('settings.name')), input);
  return r;
}

/**
 * «Настройки», shared by the main menu and the in-game pause menu: the player's name, sound (on/off, volume, music),
 * graphics (3D or classic art), the intro, and the language (Russian, English, German). The art is
 * chosen when the game starts: in the menu `onArt` reloads at once, in a game it applies next time.
 * The language applies at once (`setLang` tells the menus and the HUD to draw themselves again) and is
 * kept in the preferences.
 */
export function settingsPanel(audio: AudioEngine, opts: { onArt?: () => void; onShowIntro?: () => void; netGame?: boolean }): HTMLElement {
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

  box.append(el('h4', '', t('settings.player')), nameField());
  if (opts.netGame) box.append(el('p', 'muted', t('settings.nameNextGame')));

  box.append(el('h4', '', `🌐 ${t('settings.language')}`));
  const language = el('select');
  for (const l of LANGS) {
    const o = el('option', '', LANG_NAMES[l]);
    o.value = l;
    language.append(o);
  }
  language.value = lang();
  language.onchange = () => {
    const l = language.value as Lang;
    writePrefs({ lang: l });
    setLang(l);
  };
  row(t('settings.languageLabel'), language);

  box.append(el('h4', '', t('settings.sound')));
  row(t('settings.soundOn'), check(!audio.settings.muted, (on) => audio.setMuted(!on)));
  const volume = el('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.value = String(Math.round(audio.settings.volume * 100));
  volume.oninput = () => audio.setVolume(Number(volume.value) / 100);
  row(t('settings.volume'), volume);
  row(t('settings.music'), check(audio.settings.music, (on) => audio.setMusic(on)));

  box.append(el('h4', '', t('settings.graphics')));
  const art = el('select');
  for (const [v, text] of [
    ['3d', t('settings.art3d')],
    ['classic', t('settings.artClassic')],
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
  row(t('settings.art'), art);
  if (!opts.onArt) box.append(el('p', 'muted', t('settings.artNextGame')));

  box.append(el('h4', '', t('settings.intro')));
  row(t('settings.introOnStart'), check(readPrefs().showIntro, (on) => writePrefs({ showIntro: on })));
  if (opts.onShowIntro) {
    const show = el('button', 'menu-small', t('settings.introShow'));
    show.onclick = opts.onShowIntro;
    box.append(show);
  }

  return box;
}
