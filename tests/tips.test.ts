import { afterEach, describe, expect, it } from 'vitest';
// The world first: it sets the sim modules' import order.
import '../src/sim/world';
import { BUILDINGS, PROFESSIONS } from '../src/sim/config';
import { MENU_IDS } from '../src/ui/locks';
import { RESOURCES, type BuildingType, type SettlerKind } from '../src/sim/types';
import { LANGS, lower, setLang } from '../src/ui/i18n';
import { buildingName, profName, resLower, resName } from '../src/ui/names';
import {
  buildingTip,
  distributionTip,
  goodsTip,
  menuTip,
  minimapTip,
  producersOf,
  profTip,
  recruitTip,
  reserveTip,
  shareTip,
  specialistTip,
  tipText,
  usersOf,
  workerOrderTip,
  type TipContent,
} from '../src/ui/tips';

afterEach(() => setLang('ru'));

/** No unfilled `{placeholder}`, no raw dictionary key, nothing empty. */
function wellFormed(tip: TipContent, what: string): string {
  const text = tipText(tip);
  expect(text.trim().length, what).toBeGreaterThan(0);
  expect(text, what).not.toMatch(/\{\w+\}/);
  expect(text, what).not.toMatch(/\b(tip|help|res|prof|building)\.[a-z]/i);
  expect(text, what).not.toMatch(/undefined|NaN/);
  return text;
}

describe('hover help built from the game data', () => {
  it('a house: what it is for, residents, cost', () => {
    for (const l of LANGS) {
      setLang(l);
      const text = wellFormed(buildingTip('house_medium', { key: 2 }), `${l} house`);
      expect(text).toContain(buildingName('house_medium'));
      expect(text).toContain(String(BUILDINGS.house_medium.residence!.capacity));
      // Cost from `costOf`: planks and stone with their counts.
      expect(text).toContain(`${BUILDINGS.house_medium.cost.plank} ${resLower('plank')}`);
      expect(text).toContain(`${BUILDINGS.house_medium.cost.stone} ${resLower('stone')}`);
    }
  });

  it('a coal mine: its ore, the foods, the favourite and the miner’s pickaxe', () => {
    for (const l of LANGS) {
      setLang(l);
      const tip = buildingTip('coalmine', { key: 1 });
      const text = wellFormed(tip, `${l} coalmine`);
      for (const food of ['bread', 'fish', 'meat'] as const) expect(text).toContain(resLower(food));
      expect(text).toContain(resLower('coal'));
      expect(text).toContain(resLower('pickaxe'));
      expect(text).toContain(profName('miner'));
      const food = tip.lines.find((line) => line.parts.some((p) => typeof p !== 'string' && p.named && p.res === 'bread'));
      expect(food, 'favourite named').toBeTruthy();
    }
  });

  it('the geologist: purpose, hammer, hit points, how to send him', () => {
    for (const l of LANGS) {
      setLang(l);
      const text = wellFormed(specialistTip('geologist'), `${l} geologist`);
      expect(text).toContain(profName('geologist'));
      expect(text).toContain(resLower('hammer'));
      expect(text).toContain(String(PROFESSIONS.geologist.hp));
    }
    setLang('ru');
    expect(tipText(specialistTip('thief'))).toContain('Переодет');
    expect(tipText(specialistTip('saboteur'))).toContain('сетевой');
  });

  it('a good: who makes it and who uses it, derived from recipes', () => {
    expect(producersOf('coal')).toEqual(['coalmine']);
    expect(usersOf('coal')).toEqual(expect.arrayContaining(['ironsmelter', 'goldsmelter', 'toolsmith', 'weaponsmith']));
    expect(producersOf('meat')).toEqual(expect.arrayContaining(['hunter', 'slaughterhouse']));
    expect(usersOf('gold')).toContain('barracks');
    for (const l of LANGS) {
      setLang(l);
      const text = wellFormed(goodsTip('coal'), `${l} coal`);
      expect(text).toContain(resName('coal'));
      expect(text).toContain(buildingName('coalmine'));
      expect(text).toContain(buildingName('ironsmelter'));
      // A tool names who needs it.
      expect(tipText(goodsTip('pickaxe'))).toContain(lower(profName('miner')));
    }
  });

  it('a recruit order: hit points and damage of that level, what the barracks takes', () => {
    for (const l of LANGS) {
      setLang(l);
      const tip = recruitTip('soldier', 1);
      const text = wellFormed(tip, `${l} soldier 2`);
      const lv = PROFESSIONS.soldier.combat!.levels[1];
      expect(text).toContain(String(lv.hp));
      expect(text).toContain(String(lv.damage));
      expect(text).toContain(resLower('sword'));
      expect(text).toContain(`1 ${resLower('gold')}`);
      wellFormed(recruitTip('archer', 2), `${l} archer 3`);
      wellFormed(recruitTip('leader', 0), `${l} leader`);
    }
  });

  it('every building, profession, good and panel part has a well-formed tip in every language', () => {
    for (const l of LANGS) {
      setLang(l);
      for (const type of Object.keys(BUILDINGS) as BuildingType[]) wellFormed(buildingTip(type, { key: 1 }), `${l} ${type}`);
      for (const kind of Object.keys(PROFESSIONS) as SettlerKind[]) {
        wellFormed(profTip(kind), `${l} ${kind}`);
        wellFormed(workerOrderTip(kind), `${l} order ${kind}`);
      }
      for (const r of RESOURCES) {
        wellFormed(goodsTip(r), `${l} ${r}`);
        wellFormed(shareTip(r), `${l} share ${r}`);
      }
      wellFormed(distributionTip('bread', 'coalmine'), `${l} distribution`);
      wellFormed(reserveTip(5), `${l} reserve`);
      for (const id of MENU_IDS) wellFormed(menuTip(id), `${l} menu ${id}`);
      for (const id of ['buildings', 'fighters', 'settlers', 'land'] as const) wellFormed(minimapTip(id, id), `${l} minimap ${id}`);
    }
  });

  it('a locked building says it opens later instead of what a click does', () => {
    setLang('ru');
    expect(buildingTip('sawmill', { key: 3, locked: true }).hint).toBe('Откроется позже');
    expect(buildingTip('sawmill', { noHint: true }).hint).toBeUndefined();
  });
});
