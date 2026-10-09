import { buildingIcon } from '../render/atlas';
import {
  BUILDINGS,
  buildersOf,
  costOf,
  gatheredBy,
  INPUT_CAP,
  OUTPUT_CAP,
  OUTPUT_SHARES,
  PROFESSIONS,
  RESOURCE_INFO,
} from '../sim/config';
import { available, chooseOutput, oreLeft, residents } from '../sim/buildings';
import { diggersWanted } from '../sim/digging';
import { keepOf, recruitNeeds, FIGHTERS } from '../sim/military';
import { hasGatherTargetNear } from '../sim/nature';
import { RESOURCES, type Building, type BuildingType, type Resource, type Settler, type SettlerKind } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { barracksRows, garrisonControls, garrisonRows, recruitKey, recruitOrderControls, shareControls, supportRows } from './armyPanel';
import { el, rowsTable, type View } from './dom';
import { economyKey, economyRows, refreshStockCounts, stockText, toolOrderControls, warehouseControls } from './economyPanel';
import { movableWorkArea, workRadius } from '../sim/workArea';
import { glyph } from './icons';
import { refreshTradeCounts, tradeControls, tradeKey, tradeRows } from './tradeView';
import type { GameState } from './state';

/**
 * The selected building's window, shown in the side panel's content area as in Settlers 4: its
 * picture and name on top, then what it holds and does, and its commands (priority, demolish,
 * attack, garrison, recruit orders, weapon shares, toolsmith orders, accepted goods).
 */

const nameOf = (r: Resource) => RESOURCE_INFO[r].name;

const GATHER_PLACE: Partial<Record<BuildingType, string>> = {
  woodcutter: 'в лесу',
  stonecutter: 'в каменоломне',
  waterworks: 'у воды',
  fisher: 'на берегу',
  farm: 'в поле',
};

export /** "мечник ×2 (★1 ×1), лучник ×1": fighters by profession, with how many hold each rank above 0. */
function composition(fighters: Settler[]): string {
  const byKind = new Map<SettlerKind, Settler[]>();
  for (const s of fighters) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s]);
  return [...byKind]
    .map(([kind, list]) => {
      const ranks = new Map<number, number>();
      for (const s of list) if (s.level > 0) ranks.set(s.level, (ranks.get(s.level) ?? 0) + 1);
      const r = [...ranks].sort((a, b) => b[0] - a[0]).map(([l, n]) => `★${l} ×${n}`);
      return `${PROFESSIONS[kind].name.toLowerCase()} ×${list.length}${r.length ? ` (${r.join(', ')})` : ''}`;
    })
    .join(', ');
}


export class InfoView implements View {
  readonly el = el('div', 'view info-view');
  /** Building whose demolition awaits a second click. */
  private confirmDemolish: number | null = null;
  /** Soldiers to send with the next attack (clamped to what is available). */
  private attackCount = 1;
  /** Re-render only when the content changes, so buttons in it stay clickable. */
  private infoKey = '';
  constructor(
    private readonly world: World,
    private readonly state: GameState,
    private readonly toast: (text: string) => void,
  ) {}

  update(): void {
    this.renderInfo();
    const b = this.state.selected !== null ? this.world.buildings.get(this.state.selected) : undefined;
    if (b && BUILDINGS[b.type].storage) refreshStockCounts(this.el, b);
    if (b && BUILDINGS[b.type].market) refreshTradeCounts(this.el, b);
  }

  private renderInfo(): void {
    const b = this.state.selected !== null ? this.world.buildings.get(this.state.selected) : undefined;
    if (!b) {
      this.confirmDemolish = null;
      this.infoKey = '';
      return;
    }
    if (this.confirmDemolish !== null && this.confirmDemolish !== b.id) this.confirmDemolish = null;
    const def = BUILDINGS[b.type];
    const rows: [string, string][] = [];
    const enemy = b.owner !== LOCAL_PLAYER;
    const canSend = enemy && def.garrison && b.done ? this.world.availableAttackers(b.id) : 0;
    // Out of sight (fog of war) other players' buildings show only what is known from afar.
    const sighted = !this.state.fog || this.world.isVisible(b.door.x, b.door.y);
    if (enemy) {
      rows.push(['Владелец', `игрок ${b.owner}${this.world.allied(b.owner, LOCAL_PLAYER) ? ' (союзник)' : ''}`]);
      if (!sighted) rows.push(['Обзор', 'нет — подойдите ближе']);
      if (def.garrison && b.done) {
        rows.push(['Защитников', sighted ? String(b.garrison.length) : '?']);
        rows.push(['Можно послать', String(canSend)]);
        this.attackCount = Math.max(1, Math.min(this.attackCount, canSend));
        rows.push(['Отправить', String(this.attackCount)]);
        if (canSend > 0) rows.push(['Пойдут', composition(this.world.attackerComposition(b.id, this.attackCount))]);
      }
    } else if (!b.done) {
      rows.push(['Стройка', `${Math.floor(this.world.buildProgress(b) * 100)}%`]);
      const cost = costOf(b.type);
      for (const r of RESOURCES) {
        if (cost[r] > 0) rows.push([nameOf(r), `${b.delivered[r]} / ${cost[r]} (в пути ${b.inbound[r]})`]);
      }
      if (!b.levelled) rows.push(['Землекопы', b.diggerIds.length > 0 ? `${b.diggerIds.length} из ${diggersWanted(this.world.map, b)}` : 'ждёт землекопа']);
      rows.push(['Строители', b.builderIds.length > 0 ? `${b.builderIds.length} из ${buildersOf(b.type)}` : `ожидаются (до ${buildersOf(b.type)})`]);
    } else if (def.residence) {
      rows.push(['Жители', `${b.spawned} / ${residents(this.world, b)}`]);
      rows.push(['Статус', b.spawned < residents(this.world, b) ? 'заселяется' : 'заселён']);
    } else if (def.barracks) {
      rows.push(['Статус', this.barracksStatus(b)]);
      rows.push(...barracksRows(this.world, b));
    } else if (def.garrison || def.storage) {
      if (def.garrison) {
        rows.push(['Гарнизон', `${b.garrison.length} / ${def.garrison.capacity}`]);
        const members = b.garrison.map((id) => this.world.getSettler(id)).filter((s): s is Settler => !!s);
        if (members.length > 0) rows.push(['Состав', composition(members)]);
        if (members.length === 0 && b.garrisonInbound === 0) rows.push(['Статус', 'пусто: нет свободных бойцов рядом']);
        rows.push(...garrisonRows(this.world, b));
        rows.push(['В атаку не уходят', String(keepOf(b))]);
      }
      if (def.territory) rows.push(['Радиус земли', `${def.territory} клеток`]);
      for (const r of RESOURCES) if (def.storage && b.output[r] > 0) rows.push([nameOf(r), stockText(b, r)]);
    } else if (!def.worker) {
      rows.push(...(supportRows(this.world, b) ?? []));
    } else {
      const worker = this.world.getSettler(b.workerId);
      const tool = PROFESSIONS[def.worker!].tool;
      const workerName = worker
        ? PROFESSIONS[worker.kind].name
        : b.workerRequested
          ? 'идёт'
          : tool && available(this.world, b.owner, tool) === 0
            ? `нет инструмента: ${nameOf(tool).toLowerCase()}`
            : 'нет свободных носильщиков';
      rows.push(['Работник', workerName]);
      rows.push(['Статус', this.status(b)]);
      const gather = gatheredBy(b.type);
      const shared = this.sharedChoices(b);
      if (shared) {
        const total = shared.reduce((n, r) => n + this.world.shareOf(r), 0) || 1;
        rows.push(['Состав армии', shared.map((r) => `${nameOf(r).toLowerCase()} ${Math.round((100 * this.world.shareOf(r)) / total)}%`).join(' · ')]);
      }
      if (def.recipe) {
        for (const r of RESOURCES) {
          if (def.recipe.inputs[r]) rows.push([`${nameOf(r)} (вход)`, `${b.input[r]} / ${INPUT_CAP}`]);
        }
        const anyOf = def.recipe.inputsAnyOf;
        if (anyOf) {
          const held = anyOf.map((r) => `${nameOf(r).toLowerCase()} ${b.input[r]}`).join(', ');
          rows.push(['Еда (вход)', `${held} / ${INPUT_CAP}`]);
        }
        if (def.mine) rows.push(['Руды в радиусе', String(oreLeft(this.world, b))]);
        for (const r of RESOURCES) {
          if (def.recipe.outputs[r]) rows.push([nameOf(r), `${b.output[r]} / ${OUTPUT_CAP}`]);
        }
        for (const r of def.recipe.outputChoice ?? []) {
          if (b.output[r] > 0) rows.push([nameOf(r), `${b.output[r]} / ${OUTPUT_CAP}`]);
        }
      } else if (gather) {
        rows.push([nameOf(gather.res), `${b.output[gather.res]} / ${OUTPUT_CAP}`]);
      } else if (b.type === 'forester') {
        rows.push(['Посажено всего', String(this.world.stats.treesPlanted)]);
      }
      if (def.territory) rows.push(['Радиус земли', `${def.territory} клеток`]);
    }
    if (!enemy && b.done) rows.push(...economyRows(b));
    const radius = workRadius(b.type);
    if (!enemy && radius !== null) {
      rows.push(['Зона работы', `${radius} клеток${b.workAt ? ', перенесена' : ''}`]);
    }
    rows.push(...tradeRows(this.world, b));
    if (b.priority) rows.push(['Приоритет', 'да']);
    const key = JSON.stringify([
      b.id,
      rows,
      this.confirmDemolish === b.id,
      this.state.movingWorkArea === b.id,
      economyKey(this.world, b),
      tradeKey(this.world, b),
      def.barracks ? recruitKey(this.world) : '',
      def.garrison ? JSON.stringify(b.wish ?? null) : '',
    ]);
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.el.innerHTML = '';
    this.el.append(this.header(b), rowsTable(rows));
    if (enemy) {
      if (def.garrison && b.done) this.el.append(this.attackControls(b, canSend));
      return;
    }
    if (def.garrison && b.done) this.el.append(garrisonControls(this.world, b, () => (this.infoKey = '')));
    if (def.barracks && b.done) this.el.append(recruitOrderControls(this.world, () => (this.infoKey = '')));
    if (movableWorkArea(b.type)) {
      // Settlers 4: the work area can be moved — choose a new centre with a click on the map.
      const area = el('div', 'info-actions');
      const move = el('button', this.state.movingWorkArea === b.id ? 'active' : '', '🎯 Перенести зону работы');
      move.title = 'Затем щёлкните по карте — там будет центр зоны (Esc — отмена)';
      move.onclick = () => {
        this.state.movingWorkArea = b.id;
        this.toast('Щёлкните по карте — новый центр зоны работы (Esc — отмена)');
        move.blur();
      };
      area.append(move);
      if (b.workAt) {
        const back = el('button', '', '↺ К дому');
        back.title = 'Вернуть зону работы к дому';
        back.onclick = () => {
          this.world.setWorkArea(b.id, null);
          back.blur();
        };
        area.append(back);
      }
      this.el.append(area);
    }
    const warehouse = warehouseControls(this.world, b);
    if (warehouse) this.el.append(warehouse);
    const trade = tradeControls(this.world, b);
    if (trade) this.el.append(trade);
    if (!def.playerBuildable) return;
    const orders = b.done ? toolOrderControls(this.world, b) : null;
    if (orders) this.el.append(orders);
    const shared = this.sharedChoices(b);
    if (shared && shared.length >= 2) this.el.append(shareControls(this.world, shared, () => (this.infoKey = '')));
    const actions = el('div', 'info-actions');
    if (!b.done || def.recipe || def.residence) {
      const prio = el('button', b.priority ? 'active' : '', b.priority ? '⬆ Приоритет: да' : '⬆ Приоритет');
      prio.title = 'Обслуживать в первую очередь: материалы, сырьё, строители';
      prio.onclick = () => this.world.setPriority(b.id, !b.priority);
      actions.append(prio);
    }
    const confirming = this.confirmDemolish === b.id;
    // Warn before the last occupied military building goes: its fighters come out homeless, and once
    // they are gone too the player is out (`DEFEAT`). The land stays (Settlers 4).
    const last =
      b.garrison.length > 0 &&
      ![...this.world.buildings.values()].some((o) => o !== b && o.owner === b.owner && o.done && o.garrison.length > 0);
    const demolish = el(
      'button',
      confirming ? 'danger' : '',
      confirming ? (last ? 'Последняя занятая башня. Снести?' : 'Точно снести?') : '🔨 Снести',
    );
    demolish.title = last
      ? 'Бойцы выйдут и останутся без башни; земля останется вашей. Не останется ни башен, ни бойцов — поражение'
      : 'Половина материалов и всё, что лежит у здания, останутся на земле; земля останется вашей';
    demolish.onclick = () => {
      if (!confirming) {
        this.confirmDemolish = b.id;
        return;
      }
      this.confirmDemolish = null;
      if (this.world.demolish(b.id)) this.state.selected = null;
    };
    actions.append(demolish);
    this.el.append(actions);
  }

  /** Picture, name and a close button, like the selected-object window of Settlers 4. */
  private header(b: Building): HTMLElement {
    const head = el('div', 'info-head');
    const pic = el('div', 'info-pic');
    pic.append(buildingIcon(b.type, 64));
    const title = el('div', 'info-title');
    title.append(el('h3', '', BUILDINGS[b.type].name), el('span', 'muted', b.owner === LOCAL_PLAYER ? (b.done ? 'ваше здание' : 'стройка') : 'чужое здание'));
    const close = el('button', 'gem small', '');
    close.title = 'Закрыть (Esc)';
    close.append(glyph('close', 14));
    close.onclick = () => {
      this.state.selected = null;
      close.blur();
    };
    head.append(pic, title, close);
    return head;
  }

  /** Weapons whose proportions this building follows (share-controlled outputs), if any. */
  private sharedChoices(b: Building): readonly Resource[] | null {
    const choices = BUILDINGS[b.type].recipe?.outputChoice ?? [];
    return choices.length > 0 && choices.every((r) => OUTPUT_SHARES[r] !== undefined) ? choices : null;
  }

  /** What a barracks is doing: no orders, goods missing for every order, or recruiting. */
  private barracksStatus(b: Building): string {
    const w = this.world;
    let ordered = false;
    let payable = false;
    for (const kind of FIGHTERS) {
      PROFESSIONS[kind].combat!.levels.forEach((_, level) => {
        if (w.recruitOrder(kind, level, b.owner) === 0) return;
        ordered = true;
        const need = recruitNeeds(kind, level);
        if ((Object.entries(need) as [Resource, number][]).every(([r, n]) => b.input[r] >= n)) payable = true;
      });
    }
    if (!ordered) return 'нет заказов';
    if (w.settlers.some((s) => s.tasks.some((t) => t.t === 'recruit' && t.b === b.id))) return 'набирает';
    if (!payable) return 'ждёт оружия или золота';
    return 'ждёт свободного носильщика';
  }

  private attackControls(b: Building, available: number): HTMLElement {
    const actions = el('div', 'info-actions');
    const less = el('button', '', '−');
    less.onclick = () => (this.attackCount = Math.max(1, this.attackCount - 1));
    const more = el('button', '', '+');
    more.onclick = () => (this.attackCount = Math.min(available, this.attackCount + 1));
    const go = el('button', available > 0 ? 'danger' : '', `⚔ Атаковать (${Math.min(this.attackCount, available)})`);
    go.disabled = available === 0;
    go.title = available > 0 ? 'Свободные бойцы поблизости и лишние бойцы ваших военных зданий рядом' : 'Рядом нет свободных солдат';
    go.onclick = () => {
      const sent = this.world.attack(b.id, this.attackCount);
      this.toast(sent > 0 ? `В атаку: ${sent}` : 'Некого отправить');
    };
    actions.append(less, more, go);
    return actions;
  }

  private status(b: Building): string {
    const def = BUILDINGS[b.type];
    if (b.workerId === null) return 'ждёт работника';
    const behavior = PROFESSIONS[def.worker!].behavior;
    const w = this.world.getSettler(b.workerId);
    const outside = w !== undefined && w.inside === null;
    switch (behavior) {
      case 'workshop': {
        const recipe = def.recipe!;
        if (def.mine && oreLeft(this.world, b) === 0) return 'выработана';
        if (recipe.outputChoice && !chooseOutput(this.world, b, recipe)) return 'запас полон, заказов нет';
        if (RESOURCES.some((r) => b.output[r] + (recipe.outputs[r] ?? 0) > OUTPUT_CAP)) return 'склад полон';
        const missing = RESOURCES.filter((r) => b.input[r] < (recipe.inputs[r] ?? 0)).map((r) =>
          nameOf(r).toLowerCase(),
        );
        if (recipe.inputsAnyOf && !recipe.inputsAnyOf.some((r) => b.input[r] > 0)) missing.push('еды');
        if (missing.length > 0) return `нет: ${missing.join(', ')}`;
        return 'работает';
      }
      case 'plant':
        return outside ? 'сажает деревья' : 'отдыхает';
      case 'garrison':
        return 'охраняет границу';
      case 'hunt':
        return outside ? 'на охоте' : b.output.meat >= OUTPUT_CAP ? 'склад полон' : 'отдыхает';
      case 'gather':
      case 'farm': {
        const gather = gatheredBy(b.type)!;
        if (b.output[gather.res] >= OUTPUT_CAP) return 'склад полон';
        if (outside) return GATHER_PLACE[b.type] ?? 'работает';
        if (behavior === 'gather' && !hasGatherTargetNear(this.world, b, gather)) {
          return `нет поблизости: ${nameOf(gather.res).toLowerCase()}`;
        }
        return 'отдыхает';
      }
      default:
        return 'работает';
    }
  }
}
