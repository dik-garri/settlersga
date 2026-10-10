import { settlerIcon } from '../render/atlas';
import { SOLDIER_LEVELS } from '../sim/config';
import { isReadyWorker } from '../sim/buildings';
import { isFighter, maxHp } from '../sim/military';
import { packsOf } from '../sim/trade';
import type { Building, Settler, SettlerKind, Task } from '../sim/types';
import type { World } from '../sim/world';
import { button, el, rowsTable, type View } from './dom';
import { lower, t } from './i18n';
import { glyph } from './icons';
import { buildingName, profName, resLower, resName } from './names';
import type { GameState, Placeable } from './state';

/**
 * The selected settler's window in the side panel, as in Settlers 4: portrait, profession, owner and
 * what it is doing right now; fighters show rank and health, specialists their commands.
 */

const res = resLower;

/** Specialists the player sends with a click on the map (the side panel's settlers menu does the same). */
const SENDABLE: Partial<Record<SettlerKind, Placeable>> = { pioneer: 'pioneer', thief: 'thief', geologist: 'geologist' };

export class SettlerInfoView implements View {
  readonly el = el('div', 'view info-view');
  private key = '';

  constructor(
    private readonly world: World,
    private readonly state: GameState,
    private readonly actions: { place(p: Placeable): void; toast(text: string): void },
  ) {}

  update(): void {
    const s = this.state.selectedSettler !== null ? this.world.getSettler(this.state.selectedSettler) : undefined;
    if (!s) {
      this.key = '';
      return;
    }
    const rows = this.rows(s);
    const key = `${s.id}|${s.kind}|${rows.map((r) => r.join(':')).join('|')}`;
    if (key === this.key) return;
    const kindChanged = !this.key.startsWith(`${s.id}|${s.kind}|`);
    this.key = key;
    if (kindChanged) {
      this.el.replaceChildren(this.head(s), rowsTable(rows), this.commands(s));
    } else {
      this.el.children[1]?.replaceWith(rowsTable(rows));
    }
  }

  /** Portrait, name and a close button, like the building window. */
  private head(s: Settler): HTMLElement {
    const head = el('div', 'info-head');
    const pic = el('div', 'info-pic');
    pic.append(settlerIcon(s.kind, 64));
    const title = el('div', 'info-title');
    const mine = s.owner === this.state.localPlayer;
    title.append(el('h3', '', profName(s.kind)), el('span', 'muted', mine ? t('settler.yours') : t('settler.foreign')));
    const close = el('button', 'gem small', '');
    close.title = t('common.close');
    close.append(glyph('close', 14));
    close.onclick = () => {
      this.state.selectedSettler = null;
      close.blur();
    };
    head.append(pic, title, close);
    return head;
  }

  private rows(s: Settler): [string, string][] {
    const rows: [string, string][] = [];
    const ally = s.owner !== this.state.localPlayer && this.world.allied(s.owner, this.state.localPlayer);
    rows.push([t('info.owner'), s.owner === this.state.localPlayer ? t('settler.ownerYou') : t(ally ? 'info.ownerAlly' : 'info.ownerPlayer', { id: s.owner })]);
    rows.push([t('settler.doing'), this.doing(s)]);
    if (s.carrying) {
      // A pack donkey carries up to two packs; a carrier one unit.
      const packs = packsOf(s).map((p) => (s.load === undefined && !s.pack2 ? resName(p.res) : `${resName(p.res)} × ${p.n}`));
      rows.push([t('settler.carries'), packs.join(', ')]);
    }
    if (isFighter(s)) {
      rows.push([t('settler.level'), t('common.nOfM', { n: s.level + 1, m: SOLDIER_LEVELS.length })]);
      rows.push([t('units.health'), `${Math.max(0, Math.round(s.hp))} / ${Math.round(maxHp(s))}`]);
    }
    const home = s.home !== null ? this.world.buildings.get(s.home) : undefined;
    if (home) rows.push([t('settler.worksAt'), buildingName(home.type)]);
    // A pack donkey's trip between markets (it takes no orders, as in Settlers 4).
    const load = s.tasks.find((t) => t.t === 'load');
    const unload = s.tasks.find((t) => t.t === 'unload');
    if (load || unload) {
      const name = (id: number) => {
        const m = this.world.buildings.get(id);
        return m ? `${lower(buildingName(m.type))} (${m.door.x}, ${m.door.y})` : '—';
      };
      const from = load && 'b' in load ? name(load.b) : t('settler.onTheWay');
      const to = unload && 'b' in unload ? name(unload.b) : '—';
      rows.push([t('trade.route'), `${from} → ${to}`]);
      const loads = s.tasks.filter((t) => t.t === 'load');
      if (loads.length > 0) rows.push([t('settler.willTake'), loads.map((x) => (x.t === 'load' ? `${resName(x.res)} × ${x.n}` : '')).join(', ')]);
    }
    return rows;
  }

  private commands(s: Settler): HTMLElement {
    const box = el('div', 'info-actions');
    if (s.owner !== this.state.localPlayer) return box;
    const place = SENDABLE[s.kind];
    if (place) {
      box.append(button(t('settler.send'), t('settler.sendTip'), () => this.actions.place(place)));
    }
    if (SENDABLE[s.kind]) {
      box.append(
        button(t('units.dismiss'), t('settler.dismissTip'), () => {
          const ok = this.world.issue({ kind: 'dismissSpecialist', player: this.state.localPlayer, prof: s.kind });
          this.actions.toast(ok ? t('settler.dismissed') : t('settler.noFreeSpecialist'));
        }),
      );
    }
    return box;
  }

  /** What the settler is doing, in words, from its current task. */
  private doing(s: Settler): string {
    const b = (id: number): Building | undefined => this.world.buildings.get(id);
    const at = (id: number) => {
      const x = b(id);
      return x ? lower(buildingName(x.type)) : t('settler.aBuilding');
    };
    if (s.opponent !== null) return t('doing.fighting');
    const task: Task | undefined = s.tasks[0];
    const next = s.tasks.find((x) => x.t !== 'goto');
    if (!task) {
      if (s.inside !== null) return t('doing.inside', { b: at(s.inside) });
      if (s.fled !== undefined) return t('doing.homeless');
      if (s.errand) return t(s.kind === 'pioneer' ? 'doing.toBorder' : s.kind === 'geologist' ? 'doing.toMountain' : 'doing.onErrand');
      // Settlers 4: a carrier without a bed strikes; a worker whose workplace went waits for a new one.
      if (s.strike) return t('doing.strike');
      if (isReadyWorker(s)) return t('doing.jobless');
      if (isFighter(s) && !s.post && s.home === null) return t('doing.free');
      if (isFighter(s) && s.post) return t('doing.atPost');
      const idle = t(s.stroll ? 'doing.strolling' : s.chatWith !== null ? 'doing.chatting' : 'doing.idle');
      return SENDABLE[s.kind] ? t('doing.awaitingOrders', { idle }) : idle;
    }
    switch (task.t) {
      case 'goto':
        if (next?.t === 'pickup' || next?.t === 'lift') {
          return t(s.tasks.some((x) => x.t === 'retool') ? 'doing.fetchTool' : 'doing.fetchGood', { res: res(next.res) });
        }
        if (next?.t === 'drop') return t('doing.carrying', { res: res(next.res), b: at(next.b) });
        if (next?.t === 'build') return t('doing.toSite', { b: at(next.b) });
        if (next?.t === 'dig') return t('doing.toDig', { b: at(next.b) });
        if (next?.t === 'join') return t('doing.toGarrison', { b: at(next.b) });
        if (next?.t === 'recruit') return t('doing.toBarracks', { b: at(next.b) });
        if (next?.t === 'assault') return t('doing.toAttack', { b: at(next.b) });
        if (next?.t === 'heal') return t('doing.toHealer', { b: at(next.b) });
        if (next?.t === 'become') return t('doing.toWork', { b: at(next.b) });
        if (next?.t === 'gather') return t('doing.toGather', { res: res(next.res) });
        if (next?.t === 'prospect') return t('doing.toMountain');
        if (s.fled !== undefined) return t('doing.homeless');
        if (next?.t === 'steal') return t('doing.sneaking');
        if (next?.t === 'claim') return t('doing.toBorder');
        if (next?.t === 'load') return t('doing.toLoad', { b: at(next.b) });
        if (next?.t === 'unload') {
          return s.carrying ? t('doing.hauling', { res: res(s.carrying), b: at(next.b) }) : t('doing.goingTo', { b: at(next.b) });
        }
        return t('doing.walking');
      case 'pickup':
      case 'lift':
        return t('doing.pickup', { res: res(task.res) });
      case 'drop':
        return t('doing.drop', { res: res(task.res), b: at(task.b) });
      case 'store':
        return t('doing.store', { res: res(task.res) });
      case 'gather':
        return t('doing.gather', { res: res(task.res) });
      case 'plant':
        return t(task.what === 'tree' ? 'doing.plantTree' : 'doing.sow');
      case 'build':
        return t('doing.build', { b: at(task.b) });
      case 'dig':
        return t('doing.dig', { b: at(task.b) });
      case 'prospect':
        return t('doing.prospect');
      case 'become':
        return t('doing.become', { b: at(task.b) });
      case 'retool':
        return t('doing.retool');
      case 'join':
        return t('doing.join', { b: at(task.b) });
      case 'recruit':
        return t('doing.recruit');
      case 'assault':
        return t('doing.assault', { b: at(task.b) });
      case 'hunt':
        return t('doing.hunt');
      case 'heal':
        return t('doing.heal', { b: at(task.b) });
      case 'claim':
        return t('doing.claim');
      case 'steal':
        return t('doing.steal');
      case 'enter':
        return t('doing.enter', { b: at(task.b) });
      case 'wait':
        return t(s.fled !== undefined ? 'doing.homeless' : 'doing.wait');
      case 'load':
        return t('doing.load', { res: res(task.res) });
      case 'unload':
        return t('doing.unload', { b: at(task.b) });
    }
    return t('doing.busy');
  }
}
