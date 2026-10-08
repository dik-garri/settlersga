import { settlerIcon } from '../render/atlas';
import { BUILDINGS, PROFESSIONS, RESOURCE_INFO, SOLDIER_LEVELS } from '../sim/config';
import { isFighter, maxHp } from '../sim/military';
import type { Building, Settler, SettlerKind, Task } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { button, el, rowsTable, type View } from './dom';
import { glyph } from './icons';
import type { GameState, Placeable } from './state';

/**
 * The selected settler's window in the side panel, as in Settlers 4: portrait, profession, owner and
 * what it is doing right now; fighters show rank and health, specialists their commands.
 */

const res = (r: keyof typeof RESOURCE_INFO) => RESOURCE_INFO[r].name.toLowerCase();

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
    const mine = s.owner === LOCAL_PLAYER;
    title.append(el('h3', '', PROFESSIONS[s.kind].name), el('span', 'muted', mine ? 'ваш поселенец' : 'чужой поселенец'));
    const close = el('button', 'gem small', '');
    close.title = 'Закрыть (Esc)';
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
    const ally = s.owner !== LOCAL_PLAYER && this.world.allied(s.owner, LOCAL_PLAYER);
    rows.push(['Владелец', s.owner === LOCAL_PLAYER ? 'вы' : `игрок ${s.owner}${ally ? ' (союзник)' : ''}`]);
    rows.push(['Занят', this.doing(s)]);
    if (s.carrying) rows.push(['Несёт', RESOURCE_INFO[s.carrying].name]);
    if (isFighter(s)) {
      rows.push(['Уровень', `${s.level + 1} из ${SOLDIER_LEVELS.length}`]);
      rows.push(['Здоровье', `${Math.max(0, Math.round(s.hp))} / ${Math.round(maxHp(s))}`]);
    }
    const home = s.home !== null ? this.world.buildings.get(s.home) : undefined;
    if (home) rows.push(['Работает в', BUILDINGS[home.type].name]);
    // A pack donkey's trip between markets (it takes no orders, as in Settlers 4).
    const load = s.tasks.find((t) => t.t === 'load');
    const unload = s.tasks.find((t) => t.t === 'unload');
    if (load || unload) {
      const name = (id: number) => {
        const m = this.world.buildings.get(id);
        return m ? `${BUILDINGS[m.type].name.toLowerCase()} (${m.door.x}, ${m.door.y})` : '—';
      };
      const from = load && 'b' in load ? name(load.b) : 'в пути';
      const to = unload && 'b' in unload ? name(unload.b) : '—';
      rows.push(['Маршрут', `${from} → ${to}`]);
      if (load && load.t === 'load') rows.push(['Заберёт', `${RESOURCE_INFO[load.res].name} × ${load.n}`]);
    }
    return rows;
  }

  private commands(s: Settler): HTMLElement {
    const box = el('div', 'info-actions');
    if (s.owner !== LOCAL_PLAYER) return box;
    const place = SENDABLE[s.kind];
    if (place) {
      box.append(button('Послать…', 'Указать цель щелчком по карте', () => this.actions.place(place)));
    }
    if (s.kind === 'pioneer' || s.kind === 'thief') {
      box.append(
        button('↩ Отпустить', 'Снова сделать носильщиком (на своей земле, без дела)', () => {
          const ok = this.world.dismissSpecialist(s.kind);
          this.actions.toast(ok ? 'Специалист снова носильщик' : 'Свободного специалиста на своей земле нет');
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
      return x ? BUILDINGS[x.type].name.toLowerCase() : 'здание';
    };
    if (s.opponent !== null) return 'сражается';
    const t: Task | undefined = s.tasks[0];
    const next = s.tasks.find((x) => x.t !== 'goto');
    if (!t) {
      if (s.inside !== null) return `внутри: ${at(s.inside)}`;
      if (s.errand) return s.kind === 'pioneer' ? 'идёт к границе' : 'идёт на дело';
      return s.stroll ? 'прогуливается' : s.chatWith !== null ? 'беседует' : 'без дела';
    }
    switch (t.t) {
      case 'goto':
        if (next?.t === 'pickup') return `идёт за товаром: ${res(next.res)}`;
        if (next?.t === 'drop') return `несёт груз (${res(next.res).toLowerCase()}) → ${at(next.b)}`;
        if (next?.t === 'build') return `идёт на стройку: ${at(next.b)}`;
        if (next?.t === 'dig') return `идёт расчищать: ${at(next.b)}`;
        if (next?.t === 'join') return `идёт в гарнизон: ${at(next.b)}`;
        if (next?.t === 'assault') return `идёт в атаку: ${at(next.b)}`;
        if (next?.t === 'heal') return 'идёт в лазарет';
        if (next?.t === 'become') return `идёт работать: ${at(next.b)}`;
        if (next?.t === 'gather') return `идёт за сырьём: ${res(next.res)}`;
        if (next?.t === 'prospect') return 'идёт к горе';
        if (next?.t === 'steal') return `крадётся к: ${at(next.b)}`;
        if (next?.t === 'claim') return 'идёт к границе';
        if (next?.t === 'load') return `идёт за грузом: ${at(next.b)}`;
        if (next?.t === 'unload') return s.carrying ? `везёт ${res(s.carrying).toLowerCase()} → ${at(next.b)}` : `идёт к: ${at(next.b)}`;
        return 'в пути';
      case 'pickup':
        return `берёт ${res(t.res)}`;
      case 'drop':
        return t.back ? `возвращает ${res(t.res)} на склад` : `кладёт ${res(t.res)}: ${at(t.b)}`;
      case 'store':
        return `складывает ${res(t.res)}`;
      case 'gather':
        return `добывает: ${res(t.res)}`;
      case 'plant':
        return t.what === 'tree' ? 'сажает дерево' : 'сеет';
      case 'build':
        return `строит: ${at(t.b)}`;
      case 'dig':
        return `расчищает площадку: ${at(t.b)}`;
      case 'prospect':
        return 'ищет руду';
      case 'become':
        return `приступает к работе: ${at(t.b)}`;
      case 'retool':
        return 'берёт инструмент';
      case 'join':
        return `входит в гарнизон: ${at(t.b)}`;
      case 'assault':
        return `штурмует: ${at(t.b)}`;
      case 'hunt':
        return 'охотится';
      case 'heal':
        return 'лечится';
      case 'claim':
        return 'переносит пограничный камень';
      case 'steal':
        return `крадёт: ${at(t.b)}`;
      case 'enter':
        return `входит: ${at(t.b)}`;
      case 'wait':
        return 'ждёт';
      case 'load':
        return `навьючивает: ${res(t.res).toLowerCase()}`;
      case 'unload':
        return `разгружается: ${at(t.b)}`;
    }
    return 'занят';
  }
}
