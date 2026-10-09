import { de } from '../i18n/de';
import { en } from '../i18n/en';
import { ru, type Key } from '../i18n/ru';

/**
 * The interface language. Every player-facing string lives in the dictionaries of `src/i18n` (`ru.ts`
 * is the source of truth and defines the keys; `en.ts` and `de.ts` must have exactly the same keys,
 * checked by the compiler and by `tests/i18n.test.ts`). The simulation keeps no language: it stores
 * ids (building types, professions, goods, message kinds) and the UI looks their names up here.
 *
 * Strings take `{name}` placeholders; a string with plural forms separated by `|` picks one by the
 * `n` parameter (Russian has three forms — 1 / 2–4 / 5+ —, English and German two). DOM-free, so the
 * pure UI modules and the tests can use it; the language starts as Russian and `main.ts` picks the
 * player's (`pickLang`) before anything is drawn.
 */
export type { Key } from '../i18n/ru';
export type Lang = 'ru' | 'en' | 'de';
export const LANGS: readonly Lang[] = ['ru', 'en', 'de'];
export const DICTS: Record<Lang, Record<Key, string>> = { ru, en, de };
/** Each language's name in itself, for the language choice. */
export const LANG_NAMES: Record<Lang, string> = { ru: 'Русский', en: 'English', de: 'Deutsch' };
/** Locales for numbers and dates. */
export const LOCALES: Record<Lang, string> = { ru: 'ru-RU', en: 'en-GB', de: 'de-DE' };
/** Plural forms per language (see `pluralIndex`). */
export const PLURAL_FORMS: Record<Lang, number> = { ru: 3, en: 2, de: 2 };
/** Fired on `window` after the language changed, so the views on screen can redraw. */
export const LANG_EVENT = 'langchange';

let current: Lang = 'ru';
let numbers: Intl.NumberFormat | null = null;

export const lang = (): Lang => current;
export const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

/** Switches the language (and tells the views on screen, in a browser). */
export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  numbers = null;
  if (typeof window !== 'undefined' && typeof Event !== 'undefined') window.dispatchEvent(new Event(LANG_EVENT));
}

/**
 * The language to start with: `?lang=` in the address, else the saved choice, else the browser's
 * language when it is English or German, else Russian.
 */
export function pickLang(param: string | null, saved: unknown, browser: readonly string[]): Lang {
  if (isLang(param)) return param;
  if (isLang(saved)) return saved;
  for (const b of browser) {
    const base = b.toLowerCase().split('-')[0];
    if (base === 'ru') return 'ru';
    if (base === 'en' || base === 'de') return base;
  }
  return 'ru';
}

/** The address's `?lang`, if any: kept in the game's own navigations (quit, load, new game) by `withLang`. */
let addressLang: Lang | null = null;
export function setAddressLang(l: Lang | null): void {
  addressLang = l;
}

/** `url` with the address's `lang` parameter carried along (when the page was opened with one). */
export function withLang(url: string): string {
  return addressLang ? `${url}${url.includes('?') ? '&' : '?'}lang=${addressLang}` : url;
}

/** Which plural form `n` takes: Russian 0 = one (1, 21…), 1 = few (2–4, 22–24…), 2 = many; else 0 = one, 1 = other. */
export function pluralIndex(l: Lang, n: number): number {
  const a = Math.abs(n);
  if (l === 'ru') {
    if (!Number.isInteger(a)) return 1;
    const ten = a % 10;
    const hundred = a % 100;
    if (ten === 1 && hundred !== 11) return 0;
    if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 1;
    return 2;
  }
  return a === 1 ? 0 : 1;
}

/** A number in the language's format (grouping only from five digits, so years and map sizes stay plain). */
export function num(n: number): string {
  if (!numbers) {
    try {
      numbers = new Intl.NumberFormat(LOCALES[current], { maximumFractionDigits: 1, useGrouping: 'min2' } as unknown as Intl.NumberFormatOptions);
    } catch {
      numbers = new Intl.NumberFormat(LOCALES[current], { maximumFractionDigits: 1 });
    }
  }
  return numbers.format(n);
}

export type Params = Record<string, string | number>;

/** The text of `key` in the current language, with `{name}` placeholders filled and the plural form picked by `n`. */
export function t(key: Key, params?: Params): string {
  let s: string = DICTS[current][key] ?? ru[key] ?? key;
  if (s.includes('|')) {
    const forms = s.split('|');
    const n = typeof params?.n === 'number' ? params.n : Number(params?.n ?? 0);
    s = forms[Math.min(forms.length - 1, pluralIndex(current, n))];
  }
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    return v === undefined ? m : typeof v === 'number' ? num(v) : v;
  });
}

/**
 * A name inside a sentence: lower-case in Russian and English («нет: доски», "no planks"), as it is in
 * German, whose nouns keep their capital.
 */
export function lower(s: string): string {
  return current === 'de' ? s : s.toLocaleLowerCase(LOCALES[current]);
}

/** A date and time in the language's format. */
export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString(LOCALES[current], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
