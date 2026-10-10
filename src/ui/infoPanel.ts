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
} from '../sim/config';
import { available, chooseOutput, oreLeft, residents } from '../sim/buildings';
import { diggersWanted } from '../sim/digging';
import { keepOf, recruitNeeds, FIGHTERS } from '../sim/military';
import { hasGatherTargetNear } from '../sim/nature';
import { RESOURCES, type Building, type BuildingType, type PlayerId, type Resource, type Settler, type SettlerKind } from '../sim/types';
import type { World } from '../sim/world';
import { barracksRows, garrisonControls, garrisonRows, recruitKey, recruitOrderControls, shareControls, supportRows } from './armyPanel';
import { nextBuildingOfType } from './find';
import { el, rowsTable, type View } from './dom';
import { economyKey, economyRows, mineRows, refreshStockCounts, stockText, toolOrderControls, warehouseControls } from './economyPanel';
import { movableWorkArea, workRadius } from '../sim/workArea';
import { canStop } from '../sim/stop';
import { lower, t, type Key } from './i18n';
import { glyph } from './icons';
import { buildingName, profName, resLower, resName } from './names';
import { refreshTradeCounts, tradeControls, tradeKey, tradeRows } from './tradeView';
import type { GameState } from './state';
import { tag } from './uiTarget';

/**
 * The selected building's window, shown in the side panel's content area as in Settlers 4: its
 * picture and name on top, then what it holds and does, and its commands (priority, demolish,
 * attack, garrison, recruit orders, weapon shares, toolsmith orders, accepted goods).
 */

const nameOf = (r: Resource) => resName(r);

const GATHER_PLACE: Partial<Record<BuildingType, Key>> = {
  woodcutter: 'status.inForest',
  stonecutter: 'status.inQuarry',
  waterworks: 'status.atWater',
  fisher: 'status.onShore',
  farm: 'status.inField',
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
      return `${lower(profName(kind))} ×${list.length}${r.length ? ` (${r.join(', ')})` : ''}`;
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
    private readonly focus: (b: Building) => void = () => {},
  ) {}

  /** The player this browser plays. */
  private get me(): PlayerId {
    return this.state.localPlayer;
  }

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
    const enemy = b.owner !== this.me;
    const canSend = enemy && def.garrison && b.done ? this.world.availableAttackers(b.id, this.me) : 0;
    // Out of sight (fog of war) other players' buildings show only what is known from afar.
    const sighted = !this.state.fog || this.world.isVisible(b.door.x, b.door.y, this.me);
    if (enemy) {
      rows.push([t('info.owner'), t(this.world.allied(b.owner, this.me) ? 'info.ownerAlly' : 'info.ownerPlayer', { id: b.owner })]);
      if (!sighted) rows.push([t('army.sight'), t('info.noSight')]);
      if (def.garrison && b.done) {
        rows.push([t('info.defenders'), sighted ? String(b.garrison.length) : '?']);
        rows.push([t('info.canSend'), String(canSend)]);
        this.attackCount = Math.max(1, Math.min(this.attackCount, canSend));
        rows.push([t('info.send'), String(this.attackCount)]);
        if (canSend > 0) rows.push([t('info.willGo'), composition(this.world.attackerComposition(b.id, this.attackCount, this.me))]);
      }
    } else if (!b.done) {
      rows.push([t('info.site'), `${Math.floor(this.world.buildProgress(b) * 100)}%`]);
      const cost = costOf(b.type);
      for (const r of RESOURCES) {
        if (cost[r] > 0) rows.push([nameOf(r), t('info.delivered', { n: b.delivered[r], m: cost[r], inbound: b.inbound[r] })]);
      }
      if (!b.levelled) {
        const wanted = diggersWanted(this.world.map, b);
        rows.push([t('info.diggers'), b.diggerIds.length > 0 ? t('common.nOfM', { n: b.diggerIds.length, m: wanted }) : t('info.awaitingDigger')]);
      }
      const builders = buildersOf(b.type);
      rows.push([t('info.builders'), b.builderIds.length > 0 ? t('common.nOfM', { n: b.builderIds.length, m: builders }) : t('info.buildersExpected', { n: builders })]);
    } else if (def.residence) {
      rows.push([t('info.residents'), `${b.spawned} / ${residents(this.world, b)}`]);
      rows.push([t('info.status'), b.spawned < residents(this.world, b) ? t('info.movingIn') : t('info.full')]);
    } else if (def.barracks) {
      rows.push([t('info.status'), this.barracksStatus(b)]);
      rows.push(...barracksRows(this.world, b));
    } else if (def.garrison || def.storage) {
      if (def.garrison) {
        rows.push([t('army.garrison'), `${b.garrison.length} / ${def.garrison.capacity}`]);
        const members = b.garrison.map((id) => this.world.getSettler(id)).filter((s): s is Settler => !!s);
        if (members.length > 0) rows.push([t('info.members'), composition(members)]);
        if (members.length === 0 && b.garrisonInbound === 0) rows.push([t('info.status'), t('info.emptyGarrison')]);
        rows.push(...garrisonRows(this.world, b));
        rows.push([t('info.keep'), String(keepOf(b))]);
      }
      if (def.territory) rows.push([t('info.landRadius'), t('common.tiles', { n: def.territory })]);
      for (const r of RESOURCES) if (def.storage && b.output[r] > 0) rows.push([nameOf(r), stockText(b, r)]);
    } else if (!def.worker) {
      rows.push(...(supportRows(this.world, b) ?? []));
    } else {
      const worker = this.world.getSettler(b.workerId);
      const tool = PROFESSIONS[def.worker!].tool;
      const workerName = worker
        ? profName(worker.kind)
        : b.workerRequested
          ? t('info.workerComing')
          : tool && available(this.world, b.owner, tool) === 0
            ? t('info.noTool', { res: resLower(tool) })
            : t('info.noCarriers');
      rows.push([t('info.worker'), workerName]);
      rows.push([t('info.status'), this.status(b)]);
      // Army support buildings with a worker (the infirmary's healer, the lookout's watchman): their own rows.
      rows.push(...(supportRows(this.world, b) ?? []));
      const gather = gatheredBy(b.type);
      const shared = this.sharedChoices(b);
      if (shared) {
        const total = shared.reduce((n, r) => n + this.world.shareOf(r, this.me), 0) || 1;
        rows.push([t('info.armyMix'), shared.map((r) => `${resLower(r)} ${Math.round((100 * this.world.shareOf(r, this.me)) / total)}%`).join(' · ')]);
      }
      if (def.recipe) {
        for (const r of RESOURCES) {
          if (def.recipe.inputs[r]) rows.push([t('info.input', { name: nameOf(r) }), `${b.input[r]} / ${INPUT_CAP}`]);
        }
        const anyOf = def.recipe.inputsAnyOf;
        // A mine's food has a table of its own (`mineRows`, below).
        if (anyOf && !def.mine) {
          const held = anyOf.map((r) => `${resLower(r)} ${b.input[r]}`).join(', ');
          rows.push([t('info.foodInput'), `${held} / ${INPUT_CAP}`]);
        }
        if (def.mine) rows.push([t('info.oreLeft'), String(oreLeft(this.world, b))]);
        for (const r of RESOURCES) {
          if (def.recipe.outputs[r]) rows.push([nameOf(r), `${b.output[r]} / ${OUTPUT_CAP}`]);
        }
        for (const r of def.recipe.outputChoice ?? []) {
          if (b.output[r] > 0) rows.push([nameOf(r), `${b.output[r]} / ${OUTPUT_CAP}`]);
        }
      } else if (gather) {
        rows.push([nameOf(gather.res), `${b.output[gather.res]} / ${OUTPUT_CAP}`]);
      } else if (b.type === 'forester') {
        rows.push([t('info.planted'), String(this.world.stats.treesPlanted)]);
      }
      if (def.territory) rows.push([t('info.landRadius'), t('common.tiles', { n: def.territory })]);
    }
    if (!enemy && b.done) rows.push(...economyRows(b));
    const radius = workRadius(b.type);
    // The infirmary shows its work area as «Зона поиска» (`supportRows`).
    if (!enemy && radius !== null && !def.infirmary) {
      rows.push([t('info.workArea'), `${t('common.tiles', { n: radius })}${b.workAt ? t('info.moved') : ''}`]);
    }
    rows.push(...tradeRows(this.world, b, this.me));
    if (b.priority) rows.push([t('info.priority'), t('info.yes')]);
    if (!enemy && b.stopped) {
      rows.push([t('info.stopped'), b.done ? t('info.stoppedDone') : t('info.stoppedSite')]);
    }
    const food = enemy ? [] : mineRows(b);
    const key = JSON.stringify([
      b.id,
      rows,
      food,
      this.confirmDemolish === b.id,
      this.state.movingWorkArea === b.id,
      economyKey(this.world, b),
      tradeKey(this.world, b),
      def.barracks ? recruitKey(this.world, this.state.localPlayer) : '',
      def.garrison ? JSON.stringify(b.wish ?? null) : '',
    ]);
    if (key === this.infoKey) return;
    this.infoKey = key;
    this.el.innerHTML = '';
    this.el.append(this.header(b), rowsTable(rows));
    if (food.length > 0) this.el.append(tag(rowsTable(food), 'info.mineFood'));
    if (enemy) {
      if (def.garrison && b.done) this.el.append(this.attackControls(b, canSend));
      return;
    }
    if (def.garrison && b.done) this.el.append(garrisonControls(this.world, this.state.localPlayer, b, () => (this.infoKey = '')));
    if (def.barracks && b.done) this.el.append(recruitOrderControls(this.world, this.state.localPlayer, () => (this.infoKey = '')));
    if (movableWorkArea(b.type)) {
      // Settlers 4: the work area can be moved — choose a new centre with a click on the map.
      const area = el('div', 'info-actions');
      const move = tag(el('button', this.state.movingWorkArea === b.id ? 'active' : '', t('info.moveArea')), 'info.workArea');
      move.title = t('info.moveAreaTip');
      move.onclick = () => {
        this.state.movingWorkArea = b.id;
        this.toast(t('info.moveAreaToast'));
        move.blur();
      };
      area.append(move);
      if (b.workAt) {
        const back = el('button', '', t('info.areaBack'));
        back.title = t('info.areaBackTip');
        back.onclick = () => {
          this.world.issue({ kind: 'setWorkArea', player: this.me, id: b.id, at: null });
          back.blur();
        };
        area.append(back);
      }
      this.el.append(area);
    }
    const warehouse = warehouseControls(this.world, b, this.state.localPlayer);
    if (warehouse) this.el.append(tag(warehouse, 'info.accept'));
    const trade = tradeControls(this.world, b, this.me);
    if (trade) this.el.append(trade);
    if (!def.playerBuildable) return;
    const orders = b.done ? toolOrderControls(this.world, b, this.state.localPlayer) : null;
    if (orders) this.el.append(orders);
    const shared = this.sharedChoices(b);
    if (shared && shared.length >= 2) this.el.append(shareControls(this.world, this.state.localPlayer, shared, () => (this.infoKey = '')));
    const actions = el('div', 'info-actions');
    if (!b.done || def.recipe || def.residence) {
      const prio = tag(el('button', b.priority ? 'active' : '', b.priority ? t('info.priorityOn') : t('info.priorityBtn')), 'info.priority');
      prio.title = t('info.priorityTip');
      prio.onclick = () => this.world.issue({ kind: 'setPriority', player: this.me, id: b.id, on: !b.priority });
      actions.append(prio);
    }
    if (canStop(b)) {
      // Settlers 4's stop switch: no new work, nothing delivered, the goods at it go to others.
      const stop = tag(el('button', b.stopped ? 'active' : '', b.stopped ? t('info.start') : t('info.stop')), 'info.stop');
      stop.title = b.stopped ? t('info.startTip') : b.done ? t('info.stopTip') : t('info.stopSiteTip');
      stop.onclick = () => {
        this.world.issue({ kind: 'setStopped', player: this.me, id: b.id, on: !b.stopped });
        stop.blur();
      };
      actions.append(stop);
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
      confirming ? (last ? t('info.demolishLast') : t('info.demolishSure')) : t('info.demolish'),
    );
    demolish.title = last ? t('info.demolishLastTip') : t('info.demolishTip');
    tag(demolish, 'info.demolish');
    demolish.onclick = () => {
      if (!confirming) {
        this.confirmDemolish = b.id;
        return;
      }
      this.confirmDemolish = null;
      if (this.world.issue({ kind: 'demolish', player: this.me, id: b.id })) this.state.selected = null;
    };
    actions.append(demolish);
    // Settlers 4: the next building (or site) of this type, the camera follows.
    const next = el('button', '', t('info.next'));
    next.title = t('info.nextTip');
    next.onclick = () => {
      const n = nextBuildingOfType(this.world, this.me, b.type, b.id);
      if (n && n.id !== b.id) this.focus(n);
      else this.toast(t('info.noOther'));
      next.blur();
    };
    actions.append(next);
    this.el.append(actions);
  }

  /** Picture, name and a close button, like the selected-object window of Settlers 4. */
  private header(b: Building): HTMLElement {
    const head = el('div', 'info-head');
    const pic = el('div', 'info-pic');
    pic.append(buildingIcon(b.type, 64));
    const title = el('div', 'info-title');
    title.append(el('h3', '', buildingName(b.type)), el('span', 'muted', b.owner === this.me ? (b.done ? t('info.yours') : t('info.yourSite')) : t('info.foreign')));
    const close = el('button', 'gem small', '');
    close.title = t('common.close');
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
    if (!ordered) return t('status.noOrders');
    if (w.settlers.some((s) => s.tasks.some((x) => x.t === 'recruit' && x.b === b.id))) return t('status.recruiting');
    if (!payable) return t('status.awaitingWeapons');
    return t('status.awaitingCarrier');
  }

  private attackControls(b: Building, available: number): HTMLElement {
    const actions = el('div', 'info-actions');
    const less = el('button', '', '−');
    less.onclick = () => (this.attackCount = Math.max(1, this.attackCount - 1));
    const more = el('button', '', '+');
    more.onclick = () => (this.attackCount = Math.min(available, this.attackCount + 1));
    const go = el('button', available > 0 ? 'danger' : '', t('info.attack', { n: Math.min(this.attackCount, available) }));
    go.disabled = available === 0;
    go.title = available > 0 ? t('info.attackTip') : t('info.noAttackers');
    go.onclick = () => {
      const sent = this.world.issue({ kind: 'attack', player: this.me, target: b.id, count: this.attackCount });
      this.toast(sent > 0 ? t('input.order.attack', { n: sent }) : t('info.nobodyToSend'));
    };
    actions.append(less, more, go);
    return actions;
  }

  private status(b: Building): string {
    const def = BUILDINGS[b.type];
    if (b.stopped) return b.timer > 0 ? t('status.stopping') : t('status.stopped');
    if (b.workerId === null) return t('status.awaitingWorker');
    const behavior = PROFESSIONS[def.worker!].behavior;
    const w = this.world.getSettler(b.workerId);
    const outside = w !== undefined && w.inside === null;
    switch (behavior) {
      case 'workshop': {
        const recipe = def.recipe;
        // Workplaces without a recipe: the infirmary's healer, the lookout's watchman.
        if (!recipe) {
          if (outside) return t('status.goingIn');
          if (def.infirmary) return b.patient !== undefined ? t('status.healing') : t('status.awaitingWounded');
          if (def.alarm) return b.alarm ? t('army.alarm') : t('army.onWatch');
          return t('status.working');
        }
        if (def.mine && oreLeft(this.world, b) === 0) return t('status.workedOut');
        if (recipe.outputChoice && !chooseOutput(this.world, b, recipe)) return t('status.stockFull');
        if (RESOURCES.some((r) => b.output[r] + (recipe.outputs[r] ?? 0) > OUTPUT_CAP)) return t('status.pileFull');
        const missing = RESOURCES.filter((r) => b.input[r] < (recipe.inputs[r] ?? 0)).map((r) => resLower(r));
        if (recipe.inputsAnyOf && !recipe.inputsAnyOf.some((r) => b.input[r] > 0)) missing.push(t('status.food'));
        if (missing.length > 0) return t('status.missing', { list: missing.join(', ') });
        return t('status.working');
      }
      case 'plant':
        return outside ? t('status.planting') : t('status.resting');
      case 'garrison':
        return t('status.guarding');
      case 'hunt':
        return outside ? t('status.hunting') : b.output.meat >= OUTPUT_CAP ? t('status.pileFull') : t('status.resting');
      case 'gather':
      case 'farm': {
        const gather = gatheredBy(b.type)!;
        if (b.output[gather.res] >= OUTPUT_CAP) return t('status.pileFull');
        if (outside) {
          const place = GATHER_PLACE[b.type];
          return place ? t(place) : t('status.working');
        }
        if (behavior === 'gather' && !hasGatherTargetNear(this.world, b, gather)) {
          return t('status.noneNear', { res: resLower(gather.res) });
        }
        return t('status.resting');
      }
      default:
        return t('status.working');
    }
  }
}
