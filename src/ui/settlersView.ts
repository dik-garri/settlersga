import { settlerIcon } from '../render/atlas';
import { isReadyWorker } from '../sim/buildings';
import { NETWORK_ONLY } from '../sim/config';
import type { Settler, SettlerKind } from '../sim/types';
import type { World } from '../sim/world';
import { nextSettlerOfKind } from './find';
import { el, type View } from './dom';
import { WorkersView } from './economyPanel';
import { lower, t, type Key } from './i18n';
import { commandOpen } from './locks';
import { profName } from './names';
import { tag } from './uiTarget';
import type { GameState, Placeable } from './state';

/** Errands sent from the settlers menu at a tile or a building, as in Settlers 4's specialists page. */
export const COMMANDS: { type: 'geologist' | 'pioneer' | 'thief' | 'saboteur'; what: Key; how: Key }[] = [
  { type: 'geologist', what: 'settlers.cmd.geologist', how: 'settlers.cmd.geologistHow' },
  { type: 'pioneer', what: 'settlers.cmd.pioneer', how: 'settlers.cmd.pioneerHow' },
  { type: 'thief', what: 'settlers.cmd.thief', how: 'settlers.cmd.thiefHow' },
  { type: 'saboteur', what: 'settlers.cmd.saboteur', how: 'settlers.cmd.saboteurHow' },
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
    this.workers = new WorkersView(world, state.localPlayer);
    this.el.append(el('h4', '', t('settlers.settlement')), this.summary, el('h4', '', t('settlers.specialists')));
    const grid = el('div', 'build-grid commands');
    for (const c of COMMANDS) {
      // The saboteur only in a game that has him (Settlers 4: network games).
      if (NETWORK_ONLY.includes(c.type) && !world.rules?.saboteurs) continue;
      const b = tag(el('button', 'build-btn'), `settlers.cmd.${c.type}`);
      b.title = `${t(c.what)}: ${t(c.how)}`;
      const pic = el('span', 'build-pic');
      pic.append(settlerIcon(c.type, 52));
      b.append(pic, el('span', 'name', profName(c.type)), el('span', 'cost', t(c.what)));
      b.onclick = () => {
        // An errand the tutorial has not opened yet stays shut.
        if (commandOpen(this.state.locks, c.type)) select(this.state.placing === c.type ? null : c.type);
        b.blur();
      };
      grid.append(b);
      this.commandButtons.set(c.type, b);
    }
    this.el.append(grid, this.workers.el);
  }

  update(): void {
    for (const [type, b] of this.commandButtons) {
      b.classList.toggle('active', this.state.placing === type);
      b.classList.toggle('locked', !commandOpen(this.state.locks, type as 'geologist'));
      // The tutorial's mark counts as used while one of them is out on an errand.
      const out = this.world.settlers.some((s) => s.owner === this.state.localPlayer && s.kind === type && !!s.errand);
      if (out !== (b.dataset.uiOn === '1')) tag(b, `settlers.cmd.${type as 'geologist'}`, out);
    }
    let people = 0;
    let carriers = 0;
    let busy = 0;
    const kinds = new Map<string, number>();
    const jobless = new Map<string, number>();
    for (const s of this.world.settlers) {
      if (s.owner !== this.state.localPlayer) continue;
      people++;
      if (s.kind === 'carrier') {
        carriers++;
        if (s.tasks.length > 0) busy++;
      } else kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
      if (isReadyWorker(s) && s.tasks.length === 0) jobless.set(s.kind, (jobless.get(s.kind) ?? 0) + 1);
    }
    const { beds, striking } = this.world.bedsOf(this.state.localPlayer);
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
      grid.append(line(t('settlers.total'), String(people)), line(t('settlers.carriersBusy'), `${busy} / ${carriers}`));
      // Only carriers need a bed (Settlers 4): the start's beds plus every finished house's.
      const bedRow = tag(line(t('settlers.beds'), `${carriers} / ${beds}`), 'settlers.beds');
      bedRow.title = t('settlers.bedsTip');
      grid.append(bedRow);
      if (striking > 0) {
        const strike = line(t('settlers.striking'), String(striking));
        strike.classList.add('warn');
        strike.title = t('settlers.strikingTip');
        grid.append(strike);
      }
      if (jobless.size > 0) {
        const list = [...jobless].map(([k, n]) => `${lower(profName(k as SettlerKind))} ${n}`).join(', ');
        const row = line(t('settlers.jobless'), String([...jobless.values()].reduce((a, b) => a + b, 0)));
        row.title = t('settlers.joblessTip', { list });
        grid.append(row);
      }
      // Settlers 4's «find settler»: a click on a profession shows the next one of it on the map.
      const findable = (row: HTMLElement, kind: SettlerKind) => {
        row.classList.add('find');
        row.title = t('settlers.findTip');
        row.onclick = () => {
          const next = nextSettlerOfKind(this.world, this.state.localPlayer, kind, this.lastFound);
          if (!next) return;
          this.lastFound = next.id;
          this.focus(next);
        };
        return row;
      };
      findable(grid.children[1] as HTMLElement, 'carrier');
      for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
        grid.append(findable(line(profName(kind as SettlerKind), String(n)), kind as SettlerKind));
      }
      this.summary.append(grid);
      if (striking > 0) this.summary.append(el('p', 'warn-note', t('settlers.strikeNote')));
    }
    this.workers.update();
  }
}
