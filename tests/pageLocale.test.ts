import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { de } from '../src/i18n/de';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { localisedPage } from '../tools/pageLocale';

/** The build's en/ and de/ copies of index.html: link previews in that language (tools/pageLocale.ts). */
describe('page locales', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('index.html carries the Russian texts the copies replace', () => {
    for (const key of ['app.pageTitle', 'app.metaDescription', 'app.ogTitle', 'app.ogDescription', 'app.twitterDescription', 'app.ogImageAlt'] as const) {
      expect(html).toContain(ru[key]);
    }
  });

  for (const [lang, dict] of [['en', en], ['de', de]] as const) {
    it(`makes the ${lang} page`, () => {
      const page = localisedPage(html, lang);
      expect(page).toContain(`<html lang="${lang}" data-lang="${lang}">`);
      expect(page).toContain(`<title>${dict['app.pageTitle']}</title>`);
      expect(page).toContain(dict['app.ogDescription']);
      expect(page).toContain(`content="https://dik-garri.github.io/settlersga/${lang}/"`);
      expect(page).toContain('<base href="../" />');
      // No Russian left in the head.
      expect(page.slice(0, page.indexOf('</head>'))).not.toMatch(/[А-Яа-яЁё]/);
    });
  }
});
