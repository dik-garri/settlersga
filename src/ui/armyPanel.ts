/**
 * Army parts of the building info panel and the army menu (Settlers 4 style): a military building's
 * garrison — who is inside, how many it calls in («Заполнить», «Вывести», −/+ per kind) —, the
 * barracks' recruit orders by kind and level, weapon shares, the lookout tower and the infirmary.
 * Plain DOM helpers used by `Hud`.
 */
import { settlerIcon } from '../render/atlas';
import { BUILDINGS, LEVEL_RES, OUTPUT_SHARES, PROFESSIONS, RESOURCE_INFO } from '../sim/config';
import { ENDLESS } from '../sim/economy';
import { FIGHTERS, doorHp, garrisonCounts, isFighter, isFreeFighter, maxHp, recruitNeeds, slotsOf } from '../sim/military';
import { RESOURCES, type Building, type Resource, type SettlerKind } from '../sim/types';
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

/** «1 / 3 (идёт 1)»: fighters of a kind inside a military building out of its wish, and those on the way. */
function kindText(inside: number, wish: number, coming: number): string {
  return `${inside} / ${wish}${coming > 0 ? ` (идёт ${coming})` : ''}`;
}

/** Rows of a military building's garrison: by kind, inside / wished; the door while damaged. */
export function garrisonRows(w: World, b: Building): Rows {
  const g = BUILDINGS[b.type].garrison;
  if (!g || !b.done) return [];
  const c = garrisonCounts(w, b);
  const wish = b.wish ?? { melee: 0, ranged: 0 };
  const rows: Rows = [['Мечники', kindText(c.melee, wish.melee, c.inMelee) + ` · мест ${slotsOf(b, false)}`]];
  if (slotsOf(b, true) > 0) rows.push(['Лучники', kindText(c.ranged, wish.ranged, c.inRanged) + ` · мест ${slotsOf(b, true)}`]);
  if (g.door && b.doorHp !== undefined) rows.push(['Ворота', b.doorHp > 0 ? `${doorHp(b)} / ${g.door.hp}` : 'выбиты']);
  return rows;
}

/**
 * The garrison commands of an own military building (Settlers 4): −/+ per kind (how many it calls
 * in; never below one fighter in all), «Заполнить» (every slot) and «Вывести» (back to one; the rest
 * step out and stand free by it).
 */
export function garrisonControls(w: World, b: Building, onChange: () => void): HTMLElement {
  const box = el('div', 'eco-orders');
  box.append(el('h4', '', 'Гарнизон'));
  box.append(el('p', 'muted', 'Башня зовёт свободных бойцов поблизости, сколько задано; лишние выходят и стоят у неё.'));
  const wish = b.wish ?? { melee: 0, ranged: 0 };
  const kinds: [SettlerKind, boolean, number][] = [['soldier', false, wish.melee]];
  if (slotsOf(b, true) > 0) kinds.push(['archer', true, wish.ranged]);
  for (const [kind, archer, n] of kinds) {
    const row = el('div', 'eco-row');
    const name = archer ? 'Лучники' : 'Мечники';
    row.append(settlerIcon(kind, 18), el('span', 'eco-name', name), el('b', '', `${n} / ${slotsOf(b, archer)}`));
    row.append(
      button('−', `${name}: на одного меньше (не меньше одного бойца в башне)`, () => {
        w.changeGarrison(b.id, archer, -1);
        onChange();
      }),
      button('+', `${name}: на одного больше`, () => {
        w.changeGarrison(b.id, archer, 1);
        onChange();
      }),
    );
    box.append(row);
  }
  const actions = el('div', 'info-actions');
  actions.append(
    button('⬆ Заполнить', 'Позвать бойцов на все места', () => {
      w.fillGarrison(b.id);
      onChange();
    }),
    button('⬇ Вывести', 'Оставить одного бойца, остальные выйдут и встанут у башни', () => {
      w.withdrawGarrison(b.id);
      onChange();
    }),
  );
  box.append(actions);
  return box;
}

/** «меч, 2 золота»: what one recruit of `kind` at `level` takes from the barracks pile. */
function needText(kind: SettlerKind, level: number): string {
  return (Object.entries(recruitNeeds(kind, level)) as [Resource, number][])
    .map(([r, n]) => (n > 1 ? `${n} ${RESOURCE_INFO[r].name.toLowerCase()}` : RESOURCE_INFO[r].name.toLowerCase()))
    .join(', ');
}

/** «∞», «3» or «—»: a recruit order as shown. */
export function orderText(n: number): string {
  return n === ENDLESS ? '∞' : n > 0 ? String(n) : '—';
}

/** The barracks' pile and recruits on their way. */
export function barracksRows(w: World, b: Building): Rows {
  const rows: Rows = [];
  for (const r of [...new Set(FIGHTERS.map((k) => PROFESSIONS[k].tool!)), LEVEL_RES]) {
    rows.push([`${RESOURCE_INFO[r].name} (запас)`, String(b.input[r])]);
  }
  const coming = w.settlers.filter((s) => s.tasks.some((t) => t.t === 'recruit' && t.b === b.id)).length;
  rows.push(['Идут в казарму', String(coming)]);
  return rows;
}

/**
 * The player's recruit orders (Settlers 4's barracks menu): one line per fighting profession and
 * level with the order (∞ = no end) and −1 / +1 / +5 / ∞ / ✕. The barracks recruits nobody else;
 * the highest level its pile pays for goes first.
 */
export function recruitOrderControls(w: World, onChange: () => void): HTMLElement {
  const box = el('div', 'eco-orders');
  box.append(el('h4', '', 'Заказ бойцов'));
  box.append(el('p', 'muted', 'Казарма набирает только заказанных: старший уровень первым, если хватает оружия и золота.'));
  for (const kind of FIGHTERS) {
    const levels = PROFESSIONS[kind].combat!.levels.length;
    for (let level = 0; level < levels; level++) {
      const n = w.recruitOrder(kind, level);
      const name = levels > 1 ? `${PROFESSIONS[kind].name}, ур. ${level + 1}` : PROFESSIONS[kind].name;
      const row = el('div', 'eco-row');
      row.title = `Нужно: ${needText(kind, level)}`;
      row.append(settlerIcon(kind, 18), el('span', 'eco-name', name), el('b', '', orderText(n)));
      const order = (count: number) => () => {
        w.orderRecruits(kind, level, count);
        onChange();
      };
      row.append(
        button('−', 'На одного меньше', () => {
          w.reduceRecruits(kind, level, 1);
          onChange();
        }),
        button('+1', 'Ещё один', order(1)),
        button('+5', 'Ещё пять', order(5)),
        button('∞', 'Набирать без остановки', order(ENDLESS)),
        button('✕', 'Отменить заказ', order(0)),
      );
      box.append(row);
    }
  }
  return box;
}

/** Recruit orders of the local player as a key (re-render when they change). */
export function recruitKey(w: World): string {
  return FIGHTERS.map((k) => PROFESSIONS[k].combat!.levels.map((_, l) => w.recruitOrder(k, l)).join(',')).join('|');
}

/** Army buildings without a garrison: the lookout tower and the infirmary (Settlers 4's healer's hut). */
export function supportRows(w: World, b: Building): Rows | null {
  const def = BUILDINGS[b.type];
  const keeper = w.getSettler(b.workerId);
  const inside = !!keeper && keeper.inside === b.id;
  if (def.vision) {
    return [
      ['Обзор', `${def.vision} клеток`],
      ['Дозорный', inside ? (b.alarm ? 'тревога: враг рядом!' : 'на посту') : 'нет — тревоги не будет'],
    ];
  }
  if (def.infirmary) {
    const p = b.patient !== undefined ? w.getSettler(b.patient) : undefined;
    const t = p?.tasks.find((k) => k.t === 'heal' && k.b === b.id);
    const atDoor = !!p && p.tasks[0] === t;
    return [
      ['Лекарь', inside ? 'на месте' : 'нет — никого не лечат'],
      [
        'Пациент',
        p ? `${PROFESSIONS[p.kind].name}: ${Math.round(p.hp)} / ${maxHp(p)}${atDoor ? '' : ' (идёт)'}` : 'нет',
      ],
      ['Зона поиска', `${def.infirmary.radius} клеток`],
    ];
  }
  return null;
}

/**
 * The army menu of the side panel (Settlers 4's military overview): fighting strength, the fighters
 * by kind and level, where they are, and the orders that apply to the whole army — recruit orders and
 * the weapon shares.
 */
export class ArmyView implements View {
  readonly el = el('div', 'view army-view');
  private key = '';

  constructor(private readonly world: World) {}

  update(): void {
    const w = this.world;
    const fighters = w.settlers.filter((s) => s.owner === LOCAL_PLAYER && isFighter(s) && !w.dying.has(s.id));
    const garrisoned = fighters.filter((s) => s.home !== null).length;
    const free = fighters.filter((s) => isFreeFighter(w, s)).length;
    const field = fighters.filter((s) => s.post && s.inside === null).length;
    const coming = w.settlers.filter((s) => s.owner === LOCAL_PLAYER && s.tasks.some((t) => t.t === 'recruit')).length;
    const byKey = new Map<string, number>();
    for (const s of fighters) {
      const levels = PROFESSIONS[s.kind].combat!.levels.length;
      const k = levels > 1 ? `${PROFESSIONS[s.kind].name}, ур. ${s.level + 1}` : PROFESSIONS[s.kind].name;
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    const shares = OUTPUT_WEAPONS.map((r) => w.shareOf(r));
    const key = JSON.stringify([Math.round(w.strengthOf()), fighters.length, garrisoned, free, field, coming, [...byKey], shares, recruitKey(w)]);
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
    const line = (label: string, value: string, title = '') => {
      const row = el('span', 'stock-row');
      if (title) row.title = title;
      row.append(el('span', 'stock-name', label), el('b', '', value));
      grid.append(row);
    };
    line('Всего', String(fighters.length));
    line('В гарнизонах', String(garrisoned));
    line('Свободны', String(free), 'Стоят без дела; башни с местом зовут их сами');
    line('В поле', String(field), 'Стоят на позиции по вашему приказу');
    if (coming > 0) line('Идут в казарму', String(coming));
    for (const [k, n] of [...byKey].sort()) line(k, String(n));
    this.el.append(grid);
    this.el.append(recruitOrderControls(w, () => (this.key = '')));
    this.el.append(el('h4', '', 'Оружие'));
    const smith = el('p', 'muted', 'Оружейник куёт заказанное казармой первым, остальное — по долям.');
    this.el.append(smith, shareControls(w, OUTPUT_WEAPONS, () => (this.key = '')));
  }
}
