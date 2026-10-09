import { settlerIcon } from '../render/atlas';
import { isReadyWorker } from '../sim/buildings';
import { PROFESSIONS } from '../sim/config';
import type { Settler, SettlerKind } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { nextSettlerOfKind } from './find';
import { el, type View } from './dom';
import { WorkersView } from './economyPanel';
import type { GameState, Placeable } from './state';

/** Errands sent from the settlers menu at a tile or a building, as in Settlers 4's specialists page. */
export const COMMANDS: { type: 'geologist' | 'pioneer' | 'thief'; name: string; hint: string }[] = [
  { type: 'geologist', name: 'Геолог', hint: 'Разведать хребет: ЛКМ по горе' },
  { type: 'pioneer', name: 'Первопроходец', hint: 'Занять землю: ЛКМ по ничейной земле' },
  { type: 'thief', name: 'Вор', hint: 'Украсть товар: ЛКМ по чужому зданию' },
];

/**
 * The settlers menu: who lives in the settlement — beds and strikers (Settlers 4: carriers beyond the
 * beds strike), workers waiting for a workplace —, the specialists' errands (geologist, pioneer,
 * thief — aimed at the map like a building) and the worker orders. A click on a profession finds
 * the next settler of it on the map (Settlers 4).
 */
export class SettlersView implements View {
  readonly el = el('div', 'view settlers-view');
  private readonly summary = el('div', 'settler-summary');
  private readonly commandButtons = new Map<string, HTMLButtonElement>();
  private readonly workers: WorkersView;
  private summaryKey = '';
  /** The settler the last «find» click showed (the next one comes after him). */
  private lastFound: number | null = null;

  constructor(
    private readonly world: World,
    private readonly state: GameState,
    select: (type: Placeable | null) => void,
    private readonly focus: (s: Settler) => void = () => {},
  ) {
    this.workers = new WorkersView(world);
    this.el.append(el('h4', '', 'Поселение'), this.summary, el('h4', '', 'Специалисты'));
    const grid = el('div', 'build-grid commands');
    for (const c of COMMANDS) {
      const b = el('button', 'build-btn');
      b.title = c.hint;
      const pic = el('span', 'build-pic');
      pic.append(settlerIcon(c.type, 52));
      b.append(pic, el('span', 'name', c.name), el('span', 'cost', c.hint.split(':')[0]));
      b.onclick = () => {
        select(this.state.placing === c.type ? null : c.type);
        b.blur();
      };
      grid.append(b);
      this.commandButtons.set(c.type, b);
    }
    this.el.append(grid, this.workers.el);
  }

  update(): void {
    for (const [type, b] of this.commandButtons) b.classList.toggle('active', this.state.placing === type);
    let people = 0;
    let carriers = 0;
    let busy = 0;
    const kinds = new Map<string, number>();
    const jobless = new Map<string, number>();
    for (const s of this.world.settlers) {
      if (s.owner !== LOCAL_PLAYER) continue;
      people++;
      if (s.kind === 'carrier') {
        carriers++;
        if (s.tasks.length > 0) busy++;
      } else kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
      if (isReadyWorker(s) && s.tasks.length === 0) jobless.set(s.kind, (jobless.get(s.kind) ?? 0) + 1);
    }
    const { beds, striking } = this.world.bedsOf();
    const key = `${people}|${carriers}|${busy}|${[...kinds].join()}|${beds}|${striking}|${[...jobless].join()}`;
    if (key !== this.summaryKey) {
      this.summaryKey = key;
      this.summary.innerHTML = '';
      const line = (label: string, value: string) => {
        const row = el('span', 'stock-row');
        row.append(el('span', 'stock-name', label), el('b', '', value));
        return row;
      };
      const grid = el('div', 'stats-grid');
      grid.append(line('Всего поселенцев', String(people)), line('Носильщики заняты', `${busy} / ${carriers}`));
      // Only carriers need a bed (Settlers 4): the start's beds plus every finished house's.
      const bedRow = line('Кровати (носильщики)', `${carriers} / ${beds}`);
      bedRow.title = 'Кровати дают дома и начальный запас; носильщики сверх кроватей бастуют';
      grid.append(bedRow);
      if (striking > 0) {
        const strike = line('Бастуют', String(striking));
        strike.classList.add('warn');
        strike.title = 'Носильщикам не хватает кроватей: они не работают, пока не будет нового дома';
        grid.append(strike);
      }
      if (jobless.size > 0) {
        const list = [...jobless].map(([k, n]) => `${PROFESSIONS[k as keyof typeof PROFESSIONS].name.toLowerCase()} ${n}`).join(', ');
        const row = line('Без работы', String([...jobless.values()].reduce((a, b) => a + b, 0)));
        row.title = `Ждут новое здание своего дела: ${list}`;
        grid.append(row);
      }
      // Settlers 4's «find settler»: a click on a profession shows the next one of it on the map.
      const findable = (row: HTMLElement, kind: SettlerKind) => {
        row.classList.add('find');
        row.title = 'Щелчок — показать следующего на карте';
        row.onclick = () => {
          const next = nextSettlerOfKind(this.world, kind, this.lastFound);
          if (!next) return;
          this.lastFound = next.id;
          this.focus(next);
        };
        return row;
      };
      findable(grid.children[1] as HTMLElement, 'carrier');
      for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
        grid.append(findable(line(PROFESSIONS[kind as SettlerKind].name, String(n)), kind as SettlerKind));
      }
      this.summary.append(grid);
      if (striking > 0) this.summary.append(el('p', 'warn-note', 'Забастовка: носильщикам не хватает кроватей — постройте дом.'));
    }
    this.workers.update();
  }
}
