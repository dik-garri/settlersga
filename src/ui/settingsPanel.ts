import type { AudioEngine } from '../audio/audio';
import { el } from './dom';
import { lang, LANG_NAMES, LANGS, setLang, t, type Lang } from './i18n';
import { readPrefs, writePrefs } from './prefs';

/**
 * «Настройки», shared by the main menu and the in-game pause menu: sound (on/off, volume, music),
 * graphics (3D or classic art), the intro, and the language (Russian, English, German). The art is
 * chosen when the game starts: in the menu `onArt` reloads at once, in a game it applies next time.
 * The language applies at once (`setLang` tells the menus and the HUD to draw themselves again) and is
 * kept in the preferences.
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
