/**
 * Player preferences kept in this browser (`localStorage['settlers.prefs']`, every access guarded):
 * the art (3D or the procedural classic look), whether the intro plays at every start, and whether it
 * was ever seen (it plays once on the first visit either way). Sound settings live with the audio
 * engine (`settlers.audio`).
 */
export interface Prefs {
  art: '3d' | 'classic';
  /** Play the intro at every start (otherwise only on the first visit). */
  intro: boolean;
  introSeen: boolean;
}

const KEY = 'settlers.prefs';
const DEFAULTS: Prefs = { art: '3d', intro: false, introSeen: false };

export function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      art: raw.art === 'classic' ? 'classic' : '3d',
      intro: raw.intro === true,
      introSeen: raw.introSeen === true,
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
