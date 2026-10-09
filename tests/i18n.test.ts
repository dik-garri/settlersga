import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// The world first: it sets the sim modules' import order (specialists.ts on its own would start a cycle).
import '../src/sim/world';
import { AI_LEVELS, BUILDINGS, CATEGORIES, MESSAGES, PROFESSIONS, RESOURCE_GROUPS, RESOURCE_INFO, START_CONDITIONS } from '../src/sim/config';
import { SPECIALIST_ORDERS } from '../src/sim/specialists';
import { RESOURCES } from '../src/sim/types';
import { ru } from '../src/i18n/ru';
import { DICTS, LANGS, lower, num, pickLang, PLURAL_FORMS, pluralIndex, setLang, t, type Key } from '../src/ui/i18n';
import { buildingName, orderLabel, profName, resName } from '../src/ui/names';
import { RACES } from '../src/ui/setup';

const CYRILLIC = /[Ѐ-ӿ]/;
const placeholders = (s: string) => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort();

afterEach(() => setLang('ru'));

describe('dictionaries', () => {
  const keys = Object.keys(ru).sort();

  it('every language has exactly the Russian keys', () => {
    for (const l of LANGS) expect(Object.keys(DICTS[l]).sort(), l).toEqual(keys);
  });

  it('placeholders and plural forms match the Russian text', () => {
    for (const l of LANGS) {
      for (const k of keys as Key[]) {
        const s = DICTS[l][k];
        const base = ru[k];
        expect(s.trim().length, `${l} ${k} is empty`).toBeGreaterThan(0);
        expect(placeholders(s), `${l} ${k}`).toEqual(placeholders(base));
        const plural = base.includes('|');
        const forms = s.split('|');
        expect(forms.length, `${l} ${k}: plural forms`).toBe(plural ? PLURAL_FORMS[l] : 1);
        // Every plural form names the same things (the count among them).
        if (plural) for (const f of forms) expect(placeholders(f), `${l} ${k}: ${f}`).toEqual(placeholders(base.split('|')[0]));
      }
    }
  });

  it('English and German contain no Russian', () => {
    for (const l of ['en', 'de'] as const) {
      for (const [k, s] of Object.entries(DICTS[l])) expect(CYRILLIC.test(s), `${l} ${k}: ${s}`).toBe(false);
    }
  });

  it('names every building, profession, good, group, category, start level, difficulty, race, message and order', () => {
    for (const l of LANGS) {
      const d = DICTS[l] as Record<string, string>;
      const ids = [
        ...Object.keys(BUILDINGS).map((x) => `building.${x}`),
        ...Object.keys(PROFESSIONS).map((x) => `prof.${x}`),
        ...RESOURCES.map((x) => `res.${x}`),
        ...RESOURCE_GROUPS.map((x) => `group.${x}`),
        ...CATEGORIES.map((x) => `category.${x}`),
        ...Object.keys(START_CONDITIONS).map((x) => `start.${x}`),
        ...Object.keys(AI_LEVELS).map((x) => `ai.${x}`),
        ...RACES.map((r) => `race.${r.id}`),
        ...Object.keys(MESSAGES).map((x) => `msg.${x}`),
      ];
      for (const id of ids) expect(d[id], `${l} ${id}`).toBeTruthy();
    }
    for (const kind of Object.keys(SPECIALIST_ORDERS) as (keyof typeof SPECIALIST_ORDERS)[]) expect(orderLabel(kind)).not.toBe('');
  });
});

describe('the simulation keeps no language', () => {
  it('config data has ids only: no display names', () => {
    for (const table of [BUILDINGS, PROFESSIONS, RESOURCE_INFO, START_CONDITIONS, AI_LEVELS, MESSAGES, SPECIALIST_ORDERS]) {
      for (const [id, def] of Object.entries(table)) {
        expect('name' in (def as object) || 'text' in (def as object) || 'label' in (def as object), id).toBe(false);
      }
    }
  });

  it('no Russian text in sim code outside comments', () => {
    const dir = join(__dirname, '../src/sim');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const line = code.split('\n').find((x) => CYRILLIC.test(x));
      expect(line, file).toBeUndefined();
    }
  });
});

describe('t()', () => {
  it('picks the Russian plural forms 1 / 2–4 / 5+', () => {
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map((n) => pluralIndex('ru', n))).toEqual([0, 1, 1, 2, 2, 2, 2, 0, 1, 2, 0, 2]);
    expect(t('common.tiles', { n: 1 })).toBe('1 клетка');
    expect(t('common.tiles', { n: 3 })).toBe('3 клетки');
    expect(t('common.tiles', { n: 11 })).toBe('11 клеток');
    expect(t('common.tiles', { n: 21 })).toBe('21 клетка');
  });

  it('picks the English and German forms and fills placeholders', () => {
    setLang('en');
    expect(t('common.tiles', { n: 1 })).toBe('1 tile');
    expect(t('common.tiles', { n: 0 })).toBe('0 tiles');
    expect(t('info.ownerAlly', { id: 3 })).toBe('player 3 (ally)');
    expect(buildingName('sawmill')).toBe('Sawmill');
    expect(profName('digger')).toBe('Digger');
    setLang('de');
    expect(t('common.tiles', { n: 2 })).toBe('2 Felder');
    expect(buildingName('warehouse')).toBe('Lagerhaus');
    expect(profName('carrier')).toBe('Träger');
    // German nouns keep their capital inside a sentence; Russian and English names go lower-case.
    expect(lower(resName('plank'))).toBe('Bretter');
    setLang('en');
    expect(lower(resName('plank'))).toBe('planks');
  });

  it('formats numbers in the language, grouping only long ones', () => {
    setLang('en');
    expect(num(1024)).toBe('1024');
    expect(num(12345)).toBe('12,345');
    setLang('de');
    expect(num(12345)).toBe('12.345');
  });
});

describe('pickLang', () => {
  it('takes the address, then the saved choice, then the browser, then Russian', () => {
    expect(pickLang('de', 'en', ['en-US'])).toBe('de');
    expect(pickLang('xx', 'en', ['de-DE'])).toBe('en');
    expect(pickLang(null, undefined, ['de-AT', 'en'])).toBe('de');
    expect(pickLang(null, undefined, ['fr-FR', 'en-GB'])).toBe('en');
    expect(pickLang(null, undefined, ['ru-RU', 'en'])).toBe('ru');
    expect(pickLang(null, undefined, ['fr-FR', 'es'])).toBe('ru');
  });
});
