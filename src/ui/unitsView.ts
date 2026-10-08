import { PROFESSIONS } from '../sim/config';
import { isFighter, maxHp } from '../sim/military';
import { isSpecialist } from '../sim/specialists';
import type { Settler } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el, rowsTable, type View } from './dom';
import type { GameState } from './state';

/**
 * The selected units, as in Settlers 4's selection panel: how many of each kind (fighters by level),
 * the fighters' health, and the orders that need no target (hold, back into a garrison, dismiss the
 * specialists, deselect). Orders with a target are given on the map with a right click.
 */
export class UnitsView implements View {
  readonly el = el('div', 'view units-view');
  private key = '';

  constructor(
    private readonly world: World,
    private readonly state: GameState,
    private readonly toast: (text: string) => void,
  ) {}

  /** The selection's units still alive and ours (the selection forgets the rest). */
  units(): Settler[] {
    const alive = this.state.selectedUnits
      .map((id) => this.world.getSettler(id))
      .filter((s): s is Settler => !!s && !this.world.dying.has(s.id) && s.owner === LOCAL_PLAYER);
    if (alive.length !== this.state.selectedUnits.length) this.state.selectedUnits = alive.map((s) => s.id);
    return alive;
  }

  update(): void {
    const units = this.units();
    const fighters = units.filter(isFighter);
    const specialists = units.filter(isSpecialist);
    const byKind = new Map<string, number>();
    let hp = 0;
    let max = 0;
    let field = 0;
    for (const s of fighters) {
      const k = `${PROFESSIONS[s.kind].name}, ур. ${s.level + 1}`;
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
      hp += Math.max(0, s.hp);
      max += maxHp(s);
      if (s.post) field++;
    }
    for (const s of specialists) {
      const k = PROFESSIONS[s.kind].name;
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    // Pack donkeys: selectable to look at, they take no orders.
    const donkeys = units.filter((s) => !isFighter(s) && !isSpecialist(s));
    for (const s of donkeys) {
      const k = PROFESSIONS[s.kind].name;
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const rows: [string, string][] = [['Выбрано', String(units.length)]];
    // Control groups the selected units belong to (Ctrl+1…9 stores, 1…9 recalls).
    const ids = new Set(units.map((s) => s.id));
    const groups = this.state.groups.map((g, n) => (n > 0 && g.some((id) => ids.has(id)) ? n : 0)).filter((n) => n > 0);
    rows.push(['Группы', groups.length > 0 ? groups.join(', ') : '— (Ctrl+цифра — запомнить)']);
    for (const [k, n] of [...byKind].sort()) rows.push([k, String(n)]);
    if (fighters.length > 0) {
      rows.push(['Здоровье', max > 0 ? `${Math.round((100 * hp) / max)}%` : '—']);
      rows.push(['В поле', String(field)]);
    }
    if (specialists.length > 0) {
      const busy = specialists.filter((s) => s.errand || s.tasks.some((t) => t.t === 'prospect')).length;
      rows.push(['Специалистов за работой', `${busy} из ${specialists.length}`]);
    }
    if (donkeys.length > 0) {
      rows.push(['Ослов с грузом', `${donkeys.filter((s) => s.carrying !== null).length} из ${donkeys.length}`]);
    }
    const key = JSON.stringify(rows);
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    this.el.append(rowsTable(rows));
    const hints: string[] = [];
    if (fighters.length > 0) {
      hints.push('бойцы: по земле — идти туда, по вражескому военному зданию — атаковать, по своему — войти в него');
    }
    if (specialists.length > 0) {
      hints.push(
        'геолог: по горе — разведать хребет; первопроходец: по ничейной земле — занять её; ' +
          'вор: по разведанному вражескому складу — украсть; иначе — идти туда и ждать',
      );
    }
    if (donkeys.length > 0) hints.push('ослы приказов не слушают: они ходят по маршрутам рынков');
    if (hints.length > 0) this.el.append(el('p', 'hint-text', `Правый щелчок: ${hints.join('; ')}.`));
    const fighterIds = () => this.units().filter(isFighter).map((s) => s.id);
    const specialistIds = () => this.units().filter(isSpecialist).map((s) => s.id);
    const actions = el('div', 'info-actions');
    actions.append(
      button('✋ Стоять', 'Остаться на месте', () =>
        this.toast(`Стоят: ${this.world.orderHold(fighterIds()) + this.world.holdSpecialists(specialistIds())}`),
      ),
    );
    if (fighters.length > 0) {
      actions.append(
        button('🏰 В гарнизон', 'Каждый в ближайшее своё военное здание со свободным местом', () =>
          this.toast(`Возвращаются: ${this.world.orderGarrison(fighterIds(), null)}`),
        ),
      );
    }
    if (specialists.length > 0) {
      actions.append(
        button('↩ Отпустить', 'Специалисты на своей земле снова становятся носильщиками и несут инструмент на склад', () => {
          const n = this.world.dismissUnits(specialistIds());
          this.toast(n > 0 ? `Отпущено: ${n}` : 'Отпустить можно только на своей земле');
        }),
      );
    }
    actions.append(
      button('✕ Снять выбор', 'Esc', () => {
        this.state.selectedUnits = [];
      }),
    );
    this.el.append(actions);
  }
}
