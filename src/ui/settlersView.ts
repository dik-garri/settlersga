import { settlerIcon } from '../render/atlas';
import { PROFESSIONS } from '../sim/config';
import { LOCAL_PLAYER, type World } from '../sim/world';
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
 * The settlers menu: who lives in the settlement, the specialists' errands (geologist, pioneer,
 * thief — aimed at the map like a building) and the worker orders.
 */
export class SettlersView implements View {
  readonly el = el('div', 'view settlers-view');
  private readonly summary = el('div', 'settler-summary');
  private readonly commandButtons = new Map<string, HTMLButtonElement>();
  private readonly workers: WorkersView;
  private summaryKey = '';

  constructor(
    private readonly world: World,
    private readonly state: GameState,
    select: (type: Placeable | null) => void,
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
    for (const s of this.world.settlers) {
      if (s.owner !== LOCAL_PLAYER) continue;
      people++;
      if (s.kind === 'carrier') {
        carriers++;
        if (s.tasks.length > 0) busy++;
      } else kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
    }
    const key = `${people}|${carriers}|${busy}|${[...kinds].join()}`;
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
      for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
        grid.append(line(PROFESSIONS[kind as keyof typeof PROFESSIONS].name, String(n)));
      }
      this.summary.append(grid);
    }
    this.workers.update();
  }
}
