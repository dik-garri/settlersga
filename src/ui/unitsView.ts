import { isFighter, maxHp } from '../sim/military';
import { isSpecialist } from '../sim/specialists';
import type { Settler } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el, rowsTable, type View } from './dom';
import { t } from './i18n';
import { profName } from './names';
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
      const k = t('units.kindLevel', { name: profName(s.kind), level: s.level + 1 });
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
      hp += Math.max(0, s.hp);
      max += maxHp(s);
      if (s.post) field++;
    }
    for (const s of specialists) {
      const k = profName(s.kind);
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    // Pack donkeys: selectable to look at, they take no orders.
    const donkeys = units.filter((s) => !isFighter(s) && !isSpecialist(s));
    for (const s of donkeys) {
      const k = profName(s.kind);
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const rows: [string, string][] = [[t('units.selected'), String(units.length)]];
    // Control groups the selected units belong to (Ctrl+1…9 stores, 1…9 recalls).
    const ids = new Set(units.map((s) => s.id));
    const groups = this.state.groups.map((g, n) => (n > 0 && g.some((id) => ids.has(id)) ? n : 0)).filter((n) => n > 0);
    rows.push([t('units.groups'), groups.length > 0 ? groups.join(', ') : t('units.noGroup')]);
    for (const [k, n] of [...byKind].sort()) rows.push([k, String(n)]);
    if (fighters.length > 0) {
      rows.push([t('units.health'), max > 0 ? `${Math.round((100 * hp) / max)}%` : '—']);
      rows.push([t('units.inField'), String(field)]);
    }
    if (specialists.length > 0) {
      const busy = specialists.filter((s) => s.errand || s.tasks.some((t) => t.t === 'prospect')).length;
      rows.push([t('units.specialistsBusy'), t('common.nOfM', { n: busy, m: specialists.length })]);
    }
    if (donkeys.length > 0) {
      rows.push([t('units.donkeysLoaded'), t('common.nOfM', { n: donkeys.filter((s) => s.carrying !== null).length, m: donkeys.length })]);
    }
    const key = JSON.stringify(rows);
    if (key === this.key) return;
    this.key = key;
    this.el.innerHTML = '';
    this.el.append(rowsTable(rows));
    const hints: string[] = [];
    if (fighters.length > 0) {
      hints.push(t('units.hint.fighters'));
    }
    if (specialists.length > 0) {
      hints.push(t('units.hint.specialists'));
    }
    if (donkeys.length > 0) hints.push(t('units.hint.donkeys'));
    if (hints.length > 0) this.el.append(el('p', 'hint-text', t('units.hint', { list: hints.join('; ') })));
    const fighterIds = () => this.units().filter(isFighter).map((s) => s.id);
    const specialistIds = () => this.units().filter(isSpecialist).map((s) => s.id);
    const actions = el('div', 'info-actions');
    actions.append(
      button(t('units.hold'), t('units.holdTip'), () =>
        this.toast(t('units.holding', { n: this.world.issue({ kind: 'orderHold', player: LOCAL_PLAYER, ids: fighterIds() }) + this.world.issue({ kind: 'holdSpecialists', player: LOCAL_PLAYER, ids: specialistIds() }) })),
      ),
    );
    if (fighters.length > 0) {
      actions.append(
        button(t('units.garrison'), t('units.garrisonTip'), () =>
          this.toast(t('units.returning', { n: this.world.issue({ kind: 'orderGarrison', player: LOCAL_PLAYER, ids: fighterIds(), target: null }) })),
        ),
      );
    }
    if (specialists.length > 0) {
      actions.append(
        button(t('units.dismiss'), t('units.dismissTip'), () => {
          const n = this.world.issue({ kind: 'dismissUnits', player: LOCAL_PLAYER, ids: specialistIds() });
          this.toast(n > 0 ? t('units.dismissed', { n }) : t('units.dismissOwnLand'));
        }),
      );
    }
    actions.append(
      button(t('units.deselect'), 'Esc', () => {
        this.state.selectedUnits = [];
      }),
    );
    this.el.append(actions);
  }
}
