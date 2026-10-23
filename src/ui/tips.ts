import {
  ANIMALS,
  BUILDINGS,
  INPUT_CAP,
  LEVEL_RES,
  MINING,
  NETWORK_ONLY,
  PROFESSIONS,
  RESOURCE_INFO,
  STRENGTH,
  TICKS_PER_SECOND,
  TRADE,
  buildersOf,
  costOf,
  residentsOf,
  type AnimalDef,
} from '../sim/config';
import { FIGHTERS, recruitNeeds } from '../sim/military';
import { RESOURCES, type BuildingType, type Resource, type SettlerKind } from '../sim/types';
import { lower, t } from './i18n';
import type { MenuId } from './locks';
import type { MinimapLayer } from './minimap';
import { buildingName, groupName, profName, resLower, resName } from './names';

/**
 * Contents of the side panel's hover help (`tooltip.ts` draws them), built from the game data so the
 * numbers never go stale: a building's purpose (one dictionary line per type, `help.building.<type>`)
 * plus its cost, worker and tool, recipe and time, mine food, residents, storage, garrison, land and
 * sight; a profession's purpose, workplaces, tool and fighting stats; a good's producers and users.
 * Pure (no DOM), so the tests can check every tip in every language.
 */

/** A piece of a tip line: text, or a good drawn as its icon (with a count before it, or its name after it). */
export type TipPart = string | { res: Resource; n?: number; named?: boolean };
export interface TipLine {
  /** Bold lead-in, e.g. «Стоимость». */
  label?: string;
  parts: TipPart[];
}
export interface Tip {
  title: string;
  /** A muted line under the title (size, group…). */
  sub?: string;
  lines: TipLine[];
  /** What clicking does, keys — at the foot of the card. */
  hint?: string;
}

/** What `tooltip.ts` accepts: a plain line of help, or a card. */
export type TipContent = string | Tip;

const text = (s: string, label?: string): TipLine => ({ label, parts: [s] });
const seconds = (ticks: number): number => Math.round((10 * ticks) / TICKS_PER_SECOND) / 10;
const pct = (p: number): number => Math.round(100 * p);
/** Names joined, at most `max` of them («…» for the rest). */
function list(names: string[], max = 5): string {
  const unique = [...new Set(names)];
  return unique.length > max ? `${unique.slice(0, max).join(', ')}, …` : unique.join(', ');
}
/** Goods with their counts, as icons. */
const goods = (stock: Partial<Record<Resource, number>>): TipPart[] =>
  RESOURCES.filter((r) => (stock[r] ?? 0) > 0).map((r) => ({ res: r, n: stock[r] }));

const ALL_TYPES = Object.keys(BUILDINGS) as BuildingType[];
/** What hunters bring home (`AnimalDef.game`). */
const GAME: Resource[] = [...new Set((Object.values(ANIMALS) as AnimalDef[]).flatMap((a) => (a.game ? [a.game] : [])))];

/** The whole text of a tip, goods by name (tests, screen readers). */
export function tipText(tip: TipContent): string {
  if (typeof tip === 'string') return tip;
  const part = (p: TipPart) => (typeof p === 'string' ? p : `${p.n !== undefined ? `${p.n} ` : ''}${resLower(p.res)}`);
  const lines = tip.lines.map((l) => `${l.label ? `${l.label}: ` : ''}${l.parts.map(part).join('')}`);
  return [tip.title, tip.sub ?? '', ...lines, tip.hint ?? ''].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------------------------- buildings

export interface BuildingTipOptions {
  /** The build menu's digit key for it. */
  key?: number;
  /** The tutorial keeps it shut. */
  locked?: boolean;
  /** Leave out the build menu's hint (the building window). */
  noHint?: boolean;
}

/** A building: purpose, key numbers from `BUILDINGS`, its cost; in the build menu what a click does. */
export function buildingTip(type: BuildingType, opts: BuildingTipOptions = {}): Tip {
  const def = BUILDINGS[type];
  const lines: TipLine[] = [text(t(`help.building.${type}`))];
  const worker = def.worker ? PROFESSIONS[def.worker] : undefined;

  const residents = residentsOf(def);
  if (residents > 0) lines.push(text(t('tip.houseValue', { n: residents }), t('tip.house')));
  if (def.storage) {
    const s = def.storage;
    const value =
      s.piles && s.perPile
        ? t('tip.storagePiles', { n: s.piles, per: s.perPile, total: s.piles * s.perPile })
        : s.units
          ? t('tip.storageUnits', { n: s.units })
          : t('eco.unlimited');
    lines.push(text(value, t('tip.storage')));
  }
  if (def.worker) {
    const parts: TipPart[] = [profName(def.worker)];
    if (worker?.tool) parts.push(` · ${t('tip.toolWord')} `, { res: worker.tool, named: true });
    lines.push({ label: t('tip.worker'), parts });
  }

  const recipe = def.recipe;
  if (def.mine && recipe) {
    lines.push({ label: t('tip.mines'), parts: [{ res: def.mine.res, named: true }, ` · ${t('tip.radius', { n: def.mine.radius })}`] });
    const food: TipPart[] = [];
    for (const r of recipe.inputsAnyOf ?? []) food.push({ res: r }, ' ');
    food.push(`· ${t('tip.favourite')} `, { res: def.mine.favourite, named: true });
    lines.push({ label: t('tip.food'), parts: food });
    lines.push(text(t('tip.mineAttempts', { fav: MINING.attempts.favourite, other: MINING.attempts.other, sec: seconds(recipe.ticks) })));
  } else if (recipe) {
    const parts: TipPart[] = [...goods(recipe.inputs), ' → '];
    if (recipe.outputChoice) for (const r of recipe.outputChoice) parts.push({ res: r });
    else if (def.breeds) parts.push(profName(def.breeds));
    else parts.push(...goods(recipe.outputs));
    parts.push(` · ${t('tip.seconds', { n: seconds(recipe.ticks) })}`);
    if (recipe.outputChance !== undefined && recipe.outputChance < 1) parts.push(` · ${t('tip.chance', { n: pct(recipe.outputChance) })}`);
    lines.push({ label: recipe.outputChoice ? t('tip.forges') : t('tip.recipe'), parts });
  }
  if (worker?.gather) {
    const g = worker.gather;
    const parts: TipPart[] = [{ res: g.res, named: true }, ` · ${t('tip.radius', { n: g.radius })}`];
    if (g.missChance) parts.push(` · ${t('tip.miss', { n: pct(g.missChance) })}`);
    lines.push({ label: t('tip.gathers'), parts });
  }
  if (worker?.plant) lines.push(text(`${t(`tip.plant.${worker.plant.what}`)} · ${t('tip.radius', { n: worker.plant.radius })}`, t('tip.plants')));
  if (worker?.hunt) {
    lines.push({ label: t('tip.hunts'), parts: [...GAME.map((r): TipPart => ({ res: r, named: true })), ` · ${t('tip.radius', { n: worker.hunt.radius })}`] });
  }

  if (def.garrison) {
    const ranged = def.garrison.archers ?? 0;
    lines.push(text(t('tip.garrisonValue', { melee: def.garrison.capacity - ranged, ranged }), t('army.garrison')));
  }
  if (def.territory) lines.push(text(t('tip.radius', { n: def.territory }), t('tip.land')));
  const sight = def.sight ?? def.vision;
  if (sight) lines.push(text(t('common.tiles', { n: sight }), t('army.sight')));
  if (def.alarm) lines.push(text(t('tip.radius', { n: Math.round(def.alarm.radius) }), t('tip.alarm')));
  if (def.barracks) {
    const weapons = [...new Set(FIGHTERS.map((k) => PROFESSIONS[k].tool!))];
    lines.push({ label: t('tip.needs'), parts: [...weapons.map((r): TipPart => ({ res: r })), ' + ', { res: LEVEL_RES }, ` ${t('tip.perLevel')}`] });
  }
  if (def.infirmary) {
    lines.push(text(t('tip.healValue', { hp: def.infirmary.heal, sec: seconds(def.infirmary.every) }), t('tip.heals')));
    lines.push(text(t('tip.radius', { n: def.infirmary.radius }), t('army.searchArea')));
  }
  if (def.market) lines.push(text(t('tip.packs', { n: TRADE.packs, load: TRADE.donkeyLoad }), t('tip.donkey')));
  if (def.breeds) lines.push(text(t('tip.ranch', { n: TRADE.donkeysPerMarket })));
  if (def.eyecatcher) lines.push(text(t('tip.eyecatcher', { n: STRENGTH.eyecatcher })));
  lines.push({ label: t('tip.cost'), parts: goods(costOf(type)) });

  const sub = [t('tip.size', { w: def.w, h: def.h })];
  if (def.terrain === 'mountain') sub.push(t('tip.onMountain'));
  sub.push(t('tip.builders', { n: buildersOf(type) }));
  let hint: string | undefined;
  if (opts.locked) hint = t('tut.ui.locked');
  else if (!opts.noHint) hint = opts.key !== undefined ? t('tip.buildHint', { n: opts.key }) : t('tip.buildHintNoKey');
  return { title: buildingName(type), sub: sub.join(' · '), lines, hint };
}

// ----------------------------------------------------------------------------------- professions

/** Fighting stats per level: «100 / 150 / 210». */
const perLevel = (kind: SettlerKind, pick: (l: { hp: number; damage: number }) => number) =>
  PROFESSIONS[kind].combat!.levels.map(pick).join(' / ');

/** A profession: purpose, where he works, his tool, hit points (fighters: per level, with their blows). */
export function profTip(kind: SettlerKind, hint?: string): Tip {
  const prof = PROFESSIONS[kind];
  const lines: TipLine[] = [text(t(`help.prof.${kind}`))];
  const places = ALL_TYPES.filter((b) => BUILDINGS[b].worker === kind);
  if (places.length > 0) lines.push(text(list(places.map(buildingName)), t('tip.worksAt')));
  if (prof.tool) lines.push({ label: t('tip.tool'), parts: [{ res: prof.tool, named: true }] });
  if (prof.combat) {
    lines.push(text(perLevel(kind, (l) => l.hp), t('tip.health')));
    lines.push(text(`${perLevel(kind, (l) => l.damage)} · ${t('tip.every', { n: seconds(prof.combat.every) })}`, t('tip.damage')));
  } else if (prof.hp) lines.push(text(String(prof.hp), t('tip.health')));
  if (prof.cloaked) lines.push(text(t('tip.cloaked')));
  if (prof.sight) lines.push(text(t('common.tiles', { n: prof.sight }), t('army.sight')));
  if (NETWORK_ONLY.includes(kind)) lines.push(text(t('tip.networkOnly')));
  return { title: profName(kind), lines, hint };
}

/** A specialist of the settlers menu: his tip, and how he is sent. */
export function specialistTip(kind: 'geologist' | 'pioneer' | 'thief' | 'saboteur', locked = false): Tip {
  const how = t(`settlers.cmd.${kind}How`);
  return profTip(kind, locked ? t('tut.ui.locked') : t('tip.specialistHint', { how }));
}

/** A worker order row (builders, diggers, specialists): the profession, and what the buttons do. */
export function workerOrderTip(kind: SettlerKind): Tip {
  return profTip(kind, t('tip.orderHint'));
}

/** A recruit order of the army menu: a fighter at a level — hit points, blows, what the barracks takes. */
export function recruitTip(kind: SettlerKind, level: number): Tip {
  const prof = PROFESSIONS[kind];
  const c = prof.combat!;
  const stats = c.levels[Math.min(level, c.levels.length - 1)];
  const lines: TipLine[] = [text(t(`help.prof.${kind}`))];
  lines.push(text(String(stats.hp), t('tip.health')));
  lines.push(text(t('tip.damageValue', { n: stats.damage, sec: seconds(c.every) }), t('tip.damage')));
  if (c.ranged) lines.push(text(t('tip.rangeValue', { n: c.ranged.range, tower: Math.round(10 * c.ranged.towerRange) / 10 }), t('tip.range')));
  if (c.armor) lines.push(text(String(c.armor), t('tip.armor')));
  if (c.leads) lines.push(text(t('tip.leads', { r: c.leads.radius, n: pct(c.leads.morale - 1) })));
  if (c.captures) lines.push(text(t('tip.captures')));
  if (c.fieldOnly) lines.push(text(t('tip.fieldOnly')));
  lines.push({ label: t('tip.needs'), parts: goods(recruitNeeds(kind, level)) });
  const title = c.levels.length > 1 ? t('units.kindLevel', { name: profName(kind), level: level + 1 }) : profName(kind);
  return { title, lines, hint: t('tip.recruitHint') };
}

// ----------------------------------------------------------------------------------------- goods

/** Buildings that make `res`: recipes, gatherers, hunters, mines. */
export function producersOf(res: Resource): BuildingType[] {
  return ALL_TYPES.filter((type) => {
    const def = BUILDINGS[type];
    const r = def.recipe;
    if (def.mine?.res === res) return true;
    if (r && ((r.outputs[res] ?? 0) > 0 || r.outputChoice?.includes(res))) return true;
    const w = def.worker ? PROFESSIONS[def.worker] : undefined;
    if (w?.gather?.res === res) return true;
    return !!w?.hunt && GAME.includes(res);
  });
}

/** Buildings that use `res` up: recipe inputs, and the barracks for what recruits take. */
export function usersOf(res: Resource): BuildingType[] {
  return ALL_TYPES.filter((type) => {
    const def = BUILDINGS[type];
    const r = def.recipe;
    if (r && ((r.inputs[res] ?? 0) > 0 || r.inputsAnyOf?.includes(res))) return true;
    if (def.barracks) return FIGHTERS.some((k) => PROFESSIONS[k].combat!.levels.some((_, l) => (recruitNeeds(k, l)[res] ?? 0) > 0));
    return false;
  });
}

/** Professions that need `res` to take up the job (their tool, a fighter's weapon or kit). */
export function toolOf(res: Resource): SettlerKind[] {
  return (Object.keys(PROFESSIONS) as SettlerKind[]).filter((k) => PROFESSIONS[k].tool === res || (PROFESSIONS[k].kit?.[res] ?? 0) > 0);
}

/** A good: what it is, who makes it, who uses it (recipes, construction, tools and weapons). */
export function goodsTip(res: Resource, hint?: string): Tip {
  const lines: TipLine[] = [text(t(`help.res.${res}`))];
  const made = producersOf(res);
  if (made.length > 0) lines.push(text(list(made.map(buildingName)), t('tip.madeBy')));
  const used = usersOf(res).map(buildingName);
  if (ALL_TYPES.some((type) => (BUILDINGS[type].cost[res] ?? 0) > 0)) used.unshift(t('tip.construction'));
  if (used.length > 0) lines.push(text(list(used), t('tip.usedBy')));
  const holders = toolOf(res);
  if (holders.length > 0) lines.push(text(list(holders.map((k) => lower(profName(k)))), t('tip.toolFor')));
  const limit = RESOURCE_INFO[res].storeLimit;
  if (limit !== undefined) lines.push(text(t('tip.storeLimit', { n: limit })));
  return { title: resName(res), sub: groupName(RESOURCE_INFO[res].group), lines, hint };
}

/** A weapon share of the army menu: who carries it, what the share does. */
export function shareTip(res: Resource): Tip {
  const lines: TipLine[] = [text(t('tip.share'))];
  const holders = toolOf(res);
  if (holders.length > 0) lines.push(text(list(holders.map((k) => lower(profName(k)))), t('tip.toolFor')));
  return { title: resName(res), lines, hint: t('tip.shareHint') };
}

/** A consumer type's slider in the distribution of a good. */
export function distributionTip(res: Resource, type: BuildingType): Tip {
  return {
    title: buildingName(type),
    lines: [text(t('tip.distribution', { res: resName(res) })), text(t('tip.inputCap', { n: INPUT_CAP }))],
    hint: t('tip.sliderHint'),
  };
}

// ---------------------------------------------------------------------------------- panel parts

/** A main menu's gem. */
export function menuTip(id: MenuId, locked = false): Tip {
  return { title: t(`hud.menu.${id}`), lines: [text(t(`help.menu.${id}`))], hint: locked ? t('tut.ui.locked') : undefined };
}

/** A minimap layer switch. */
export function minimapTip(id: MinimapLayer, name: string): Tip {
  return { title: name, lines: [text(t(`help.minimap.${id}`))], hint: t('minimap.layerTip', { name }) };
}

/** The carrier reserve row of the settlers menu. */
export function reserveTip(min: number): Tip {
  return { title: t('eco.reserve'), lines: [text(t('eco.reserveNote', { min })), text(t('tip.reserveWhy'))], hint: t('tip.reserveHint') };
}
