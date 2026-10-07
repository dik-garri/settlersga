/**
 * Army parts of the building info panel (Settlers 4 style): garrison slots by kind, the barracks'
 * recruit level order, the lookout tower and the infirmary. Plain DOM helpers used by `Hud`.
 */
import { BUILDINGS, LEVEL_RES, RESOURCE_INFO, SOLDIER_LEVELS } from '../sim/config';
import { isArcher, slotsFree } from '../sim/military';
import type { Building, Settler } from '../sim/types';
import type { World } from '../sim/world';

export type Rows = [string, string][];

/** «мечники 1/1 · лучники 0/2»: who sits in a military building, by slot kind. */
export function garrisonSlotRows(w: World, b: Building): Rows {
  const g = BUILDINGS[b.type].garrison;
  if (!g || !b.done) return [];
  const members = b.garrison.map((id) => w.getSettler(id)).filter((s): s is Settler => !!s);
  const archers = Math.min(g.capacity, g.archers ?? 0);
  const inA = members.filter(isArcher).length;
  const kinds = [`мечники ${members.length - inA} / ${g.capacity - archers}`];
  if (archers > 0) kinds.push(`лучники ${inA} / ${archers}`);
  const free = slotsFree(w, b, true) + slotsFree(w, b, false);
  return [['Места', kinds.join(' · ') + (free > 0 ? '' : ' (полон)')]];
}

/** The barracks: the level recruits are trained at and the gold it takes. */
export function barracksRows(w: World, b: Building): Rows {
  const level = w.recruitLevel(b.owner);
  const cost = SOLDIER_LEVELS[level].cost;
  const gold = RESOURCE_INFO[LEVEL_RES].name.toLowerCase();
  return [
    ['Уровень новобранцев', `${level + 1}${cost > 0 ? ` (+${cost} ${gold})` : ''}`],
    [`${RESOURCE_INFO[LEVEL_RES].name} (запас)`, String(b.input[LEVEL_RES])],
  ];
}

/** «Уровень 1 · 2 · 3» buttons: the level every barracks of the player trains recruits at. */
export function recruitLevelControls(w: World, onChange: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'info-actions';
  const current = w.recruitLevel();
  SOLDIER_LEVELS.forEach((lv, k) => {
    const b = document.createElement('button');
    b.className = k === current ? 'active' : '';
    b.textContent = `Ур. ${k + 1}`;
    b.title = lv.cost > 0 ? `Новобранцы уровня ${k + 1}: оружие + ${lv.cost} золота` : 'Новобранцы уровня 1: только оружие';
    b.onclick = () => {
      w.setRecruitLevel(k);
      onChange();
    };
    row.append(b);
  });
  return row;
}

/** Worker-less army buildings without a garrison: the lookout tower and the infirmary. */
export function supportRows(w: World, b: Building): Rows | null {
  const def = BUILDINGS[b.type];
  if (def.vision) return [['Обзор', `${def.vision} клеток`]];
  if (def.infirmary) {
    const inBed = w.settlers.filter((s) => s.inside === b.id && s.tasks.some((t) => t.t === 'heal' && t.b === b.id));
    const coming = w.settlers.filter((s) => s.inside !== b.id && s.tasks.some((t) => t.t === 'heal' && t.b === b.id));
    return [
      ['Койки', `${inBed.length} / ${def.infirmary.beds}`],
      ['Идут лечиться', String(coming.length)],
      ['Радиус', `${def.infirmary.range} клеток`],
    ];
  }
  return null;
}
