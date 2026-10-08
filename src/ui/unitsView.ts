import { PROFESSIONS } from '../sim/config';
import { maxHp } from '../sim/military';
import type { Settler } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el, rowsTable, type View } from './dom';
import type { GameState } from './state';

/**
 * The selected army units, as in Settlers 4's selection panel: how many of each kind and level, their
 * health, and the orders that need no target (hold, back into a garrison, deselect). Orders with a
 * target are given on the map with a right click (move / attack / go in).
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
    const byKind = new Map<string, number>();
    let hp = 0;
    let max = 0;
    let field = 0;
    for (const s of units) {
      const k = `${PROFESSIONS[s.kind].name}, ур. ${s.level + 1}`;
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
      hp += Math.max(0, s.hp);
      max += maxHp(s);
      if (s.post) field++;
    }
    const rows: [string, string][] = [['Выбрано', String(units.length)]];
    for (const [k, n] of [...byKind].sort()) rows.push([k, String(n)]);
    rows.push(['Здоровье', max > 0 ? `${Math.round((100 * hp) / max)}%` : '—']);
    rows.push(['В поле', String(field)]);
    const key = JSON.stringify(rows);
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    this.el.append(rowsTable(rows));
    this.el.append(
      el(
        'p',
        'hint-text',
        'Правый щелчок: по земле — идти туда, по вражескому военному зданию — атаковать, по своему — войти в него.',
      ),
    );
    const ids = () => this.units().map((s) => s.id);
    const actions = el('div', 'info-actions');
    actions.append(
      button('✋ Стоять', 'Остаться на месте', () => this.toast(`Стоят: ${this.world.orderHold(ids())}`)),
      button('🏰 В гарнизон', 'Каждый в ближайшее своё военное здание со свободным местом', () =>
        this.toast(`Возвращаются: ${this.world.orderGarrison(ids(), null)}`),
      ),
      button('✕ Снять выбор', 'Esc', () => {
        this.state.selectedUnits = [];
      }),
    );
    this.el.append(actions);
  }
}
