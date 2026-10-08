/**
 * Army parts of the building info panel (Settlers 4 style): garrison slots by kind, the barracks'
 * recruit level order, the lookout tower and the infirmary. Plain DOM helpers used by `Hud`.
 */
import { BUILDINGS, LEVEL_RES, OUTPUT_SHARES, PROFESSIONS, RESOURCE_INFO, SOLDIER_LEVELS } from '../sim/config';
import { isArcher, isFighter, slotsFree } from '../sim/military';
import { RESOURCES, type Building, type Resource, type Settler } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el, type View } from './dom';

/** Weapons whose shares the player sets (share-controlled outputs). */
const OUTPUT_WEAPONS = RESOURCES.filter((r) => OUTPUT_SHARES[r] !== undefined);

export type Rows = [string, string][];

/**
 * Shares of share-controlled outputs (swords, bows, squad leaders' armour): one line per good with
 * its percentage and −/+ buttons moving its weight by 10 (0–100). Weights are relative, so the
 * percentages always add up to 100.
 */
export function shareControls(w: World, choices: readonly Resource[], onChange: () => void): HTMLElement {
  const box = el('div', 'shares');
  const total = choices.reduce((n, r) => n + w.shareOf(r), 0) || 1;
  for (const r of choices) {
    const row = el('div', 'share-row');
    const pct = Math.round((100 * w.shareOf(r)) / total);
    row.append(el('span', 'share-name', `${RESOURCE_INFO[r].name} ${pct}%`));
    const step = (d: number) => () => {
      w.setShare(r, Math.max(0, Math.min(100, w.shareOf(r) + d)));
      onChange();
    };
    row.append(button('−', `Меньше: ${RESOURCE_INFO[r].name.toLowerCase()}`, step(-10)), button('+', `Больше: ${RESOURCE_INFO[r].name.toLowerCase()}`, step(10)));
    box.append(row);
  }
  return box;
}

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

/**
 * The army menu of the side panel (Settlers 4's military overview): fighting strength, the fighters
 * by kind and level, where they are, and the orders that apply to the whole army — the recruit level
 * and the shares of swords and bows.
 */
export class ArmyView implements View {
  readonly el = el('div', 'view army-view');
  private key = '';

  constructor(private readonly world: World) {}

  update(): void {
    const w = this.world;
    const fighters = w.settlers.filter((s) => s.owner === LOCAL_PLAYER && isFighter(s));
    const garrisoned = fighters.filter((s) => s.inside !== null && w.buildings.get(s.inside)?.garrison.includes(s.id)).length;
    const byKey = new Map<string, number>();
    for (const s of fighters) {
      const k = `${PROFESSIONS[s.kind].name}|${s.level + 1}`;
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    const shares = OUTPUT_WEAPONS.map((r) => w.shareOf(r));
    const key = JSON.stringify([Math.round(w.strengthOf()), fighters.length, garrisoned, [...byKey], shares, w.recruitLevel()]);
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    this.el.append(el('h4', '', 'Сила армии'));
    const meter = el('div', 'strength');
    const pct = Math.round(w.strengthOf());
    const bar = el('span', 'strength-bar');
    bar.style.setProperty('--p', `${Math.min(100, (pct / 150) * 100)}%`);
    meter.append(bar, el('b', '', `${pct}%`));
    meter.title = 'Сила атаки на чужой земле растёт с ценностью поселения (материалы в постройках, украшения — втройне). На своей земле бойцы сражаются в полную силу.';
    this.el.append(meter);
    this.el.append(el('h4', '', 'Бойцы'));
    const grid = el('div', 'stats-grid');
    const line = (label: string, value: string) => {
      const row = el('span', 'stock-row');
      row.append(el('span', 'stock-name', label), el('b', '', value));
      grid.append(row);
    };
    line('Всего', String(fighters.length));
    line('В гарнизонах', String(garrisoned));
    for (const [k, n] of [...byKey].sort()) {
      const [name, level] = k.split('|');
      line(`${name}, ур. ${level}`, String(n));
    }
    this.el.append(grid);
    this.el.append(el('h4', '', 'Уровень новобранцев'), recruitLevelControls(w, () => (this.key = '')));
    this.el.append(el('h4', '', 'Оружие'), shareControls(w, OUTPUT_WEAPONS, () => (this.key = '')));
  }
}
