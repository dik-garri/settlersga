import { de } from '../src/i18n/de';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';

/**
 * Link previews in other languages (roadmap 4.7). Search engines and messengers read the page's
 * meta tags without running scripts, so one page cannot describe itself in three languages. The
 * build (`vite.config.ts`) therefore writes `en/index.html` and `de/index.html` next to the Russian
 * `index.html`: the same page with the title, description and Open Graph tags in that language
 * (taken from the dictionaries: `index.html` holds the Russian values of the keys below), `<html
 * lang>`, `data-lang` (the page's language, which `pickLang` uses after `?lang` and the saved
 * choice) and `<base href="../">`, so the scripts and the art load from the site's root.
 */

export type PageLang = 'en' | 'de';

/** The keys whose Russian text `index.html` carries. */
const KEYS = ['app.pageTitle', 'app.metaDescription', 'app.ogTitle', 'app.ogDescription', 'app.twitterDescription', 'app.ogImageAlt', 'app.title'] as const;
const DICTS = { en, de } as const;
const LOCALE = { ru: 'ru_RU', en: 'en_US', de: 'de_DE' } as const;

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The Russian page as the page in `lang`; throws if a text to replace is not where it should be. */
export function localisedPage(html: string, lang: PageLang): string {
  let out = html;
  const dict = DICTS[lang];
  // Longest first: the page title is the start of the preview title, the game's name of both.
  for (const key of [...KEYS].sort((a, b) => ru[b].length - ru[a].length)) {
    const from = attr(ru[key]);
    if (!out.includes(from)) throw new Error(`index.html lacks the Russian text of ${key}`);
    out = out.split(from).join(attr(dict[key]));
  }
  const swap = (a: string, b: string): void => {
    if (!out.includes(a)) throw new Error(`index.html lacks ${a}`);
    out = out.replace(a, b);
  };
  swap('<html lang="ru">', `<html lang="${lang}" data-lang="${lang}">`);
  swap('<meta property="og:locale" content="ru_RU" />', `<meta property="og:locale" content="${LOCALE[lang]}" />`);
  out = out.replace(`<meta property="og:locale:alternate" content="${LOCALE[lang]}" />`, '<meta property="og:locale:alternate" content="ru_RU" />');
  // The page's own address for previews; everything relative resolves against the site's root.
  out = out.replace(/(<meta property="og:url" content="[^"]*\/)(" \/>)/, `$1${lang}/$2`);
  swap('<head>', '<head>\n    <base href="../" />');
  return out;
}
