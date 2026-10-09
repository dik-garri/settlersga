import { isLang, type Lang } from './i18n';

/**
 * Player preferences kept in this browser (`localStorage['settlers.prefs']`, every access guarded):
 * the art (3D or the procedural classic look), whether the intro plays before the main menu and the
 * interface language (unset = `?lang`, else the browser's: `pickLang`).
 * Sound settings live with the audio engine (`settlers.audio`).
 */
export interface Prefs {
  art: '3d' | 'classic';
  /**
   * Play the intro at every normal start (on by default; the settings can turn it off). Stored as
   * `showIntro`: the old fields `intro` (false unless asked) and `introSeen`, which kept the intro to
   * the first visit, are ignored, so a browser that saw it once plays it again.
   */
  showIntro: boolean;
  /** The interface language chosen in the settings. */
  lang?: Lang;
}

const KEY = 'settlers.prefs';
const DEFAULTS: Prefs = { art: '3d', showIntro: true };

export function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs> | null;
    return {
      art: raw?.art === 'classic' ? 'classic' : '3d',
      showIntro: raw?.showIntro !== false,
      ...(isLang(raw?.lang) ? { lang: raw.lang } : {}),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not kept; this session still uses it.
  }
  return next;
}
