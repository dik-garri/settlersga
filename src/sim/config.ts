import { emptyStock, type BuildingType, type PlantKind, type Resource, type SettlerKind, type Stock } from './types';

export const TICKS_PER_SECOND = 10;

export const MAP_SIZE = 64;

/** Tiles per tick. */
export const SETTLER_SPEED = 0.2;

export const BUILD_TICKS_PER_UNIT = 30;
export const HANDLE_TICKS = 3;

/** Per-resource pile limits at a workplace door. */
export const OUTPUT_CAP = 4;
export const INPUT_CAP = 4;

export const DISPATCH_EVERY = 5;
export const IDLE_GO_HOME_TICKS = 30;
/** After a failed route search: how long the settler waits and how long the target building is skipped. */
export const PATH_FAIL_BACKOFF = 10;
export const UNREACHABLE_TICKS = 100;
/** A builder idle this long at a site without material moves to a site with work. */
export const BUILDER_STALL_TICKS = 40;

export const START_CARRIERS = 12;
/** Soldiers each player's castle starts with. */
export const START_SOLDIERS = 3;
/** Military buildings keep at least this many soldiers when sending others out (to attack or to man towers). */
export const GARRISON_KEEP = 1;
/** Combat: soldiers within this distance (tiles, building centers) of the target can join an attack. */
export const ATTACK_RANGE = 30;
/** Combat: one blow every FIGHT_EVERY ticks; damage per blow is uniform in [min, max]. */
export const FIGHT_EVERY = 6;
export const DAMAGE: [number, number] = [12, 24];
export const START_BUILDERS = 3;
export const START_PLANKS = 20;
export const START_STONE = 10;
/** Tools in the castle at the start, enough for the first workplaces. */
export const START_TOOLS: Partial<Stock> = { axe: 3, saw: 2, pickaxe: 4, shovel: 2, scythe: 2, rod: 2, hammer: 2 };
/** Display names and stock-panel groups, kept with the data so new resources are one entry. */
export type ResourceGroup = 'building' | 'food' | 'metal' | 'tools' | 'military';
export const RESOURCE_GROUPS: Record<ResourceGroup, string> = {
  building: 'Стройматериалы',
  food: 'Еда',
  metal: 'Руда и металл',
  tools: 'Инструменты',
  military: 'Оружие',
};
/**
 * `storeLimit`: surplus is hauled to warehouses only while fewer than this many units are stored;
 * beyond that goods wait at the producer, whose full pile pauses it, so carriers are not spent on
 * goods nobody needs (water is unlimited and only used next door). Unset = no limit.
 */
export const RESOURCE_INFO: Record<Resource, { name: string; group: ResourceGroup; storeLimit?: number }> = {
  log: { name: 'Брёвна', group: 'building' },
  plank: { name: 'Доски', group: 'building' },
  stone: { name: 'Камень', group: 'building' },
  water: { name: 'Вода', group: 'food', storeLimit: 16 },
  fish: { name: 'Рыба', group: 'food' },
  grain: { name: 'Зерно', group: 'food' },
  flour: { name: 'Мука', group: 'food' },
  bread: { name: 'Хлеб', group: 'food' },
  pig: { name: 'Свиньи', group: 'food' },
  meat: { name: 'Мясо', group: 'food' },
  coal: { name: 'Уголь', group: 'metal' },
  ironore: { name: 'Железная руда', group: 'metal' },
  goldore: { name: 'Золотая руда', group: 'metal' },
  iron: { name: 'Железо', group: 'metal' },
  gold: { name: 'Золото', group: 'metal' },
  axe: { name: 'Топоры', group: 'tools' },
  saw: { name: 'Пилы', group: 'tools' },
  pickaxe: { name: 'Кирки', group: 'tools' },
  shovel: { name: 'Лопаты', group: 'tools' },
  scythe: { name: 'Косы', group: 'tools' },
  rod: { name: 'Удочки', group: 'tools' },
  hammer: { name: 'Молотки', group: 'tools' },
  grapes: { name: 'Виноград', group: 'food' },
  wine: { name: 'Вино', group: 'food' },
  sword: { name: 'Мечи', group: 'military' },
};

/** Field plantings stored in `map.crop` (stage) with their kind in `map.cropKind` (index here). */
export const CROP_KINDS: readonly PlantKind[] = ['grain', 'vine'];

/** What the toolsmith can forge. */
export const TOOLS: readonly Resource[] = ['axe', 'saw', 'pickaxe', 'shovel', 'scythe', 'rod', 'hammer'];

export const TREE_MATURE = 4;
/** Ordinary buildings need ground whose corners (footprint and door) differ by at most this many pixels. */
export const BUILD_MAX_SLOPE = 12;
/** Stone units in a deposit tile at generation, inclusive range. */
export const DEPOSIT_STONE: [number, number] = [4, 8];
/** Grain field stages: 1 sown … CROP_RIPE harvestable. Fields grow every CROP_GROW_EVERY ticks with CROP_GROW_CHANCE. */
export const CROP_RIPE = 4;
export const CROP_GROW_EVERY = 10;
export const CROP_GROW_CHANCE = 0.035;
/** Ore kinds stored in `map.ore` (index + 1; 0 = none) and the resource a mine extracts. */
export const ORE_RESOURCES: readonly Resource[] = ['coal', 'ironore', 'goldore', 'stone'];
export function oreOf(code: number): Resource | null {
  return code > 0 ? ORE_RESOURCES[code - 1] : null;
}
/** Ore units per mountain tile at generation, inclusive range. */
export const ORE_AMOUNT: [number, number] = [6, 14];
/** Geologist: how far around the target he looks and how long each tile takes. */
export const PROSPECT_RADIUS = 3;
export const PROSPECT_TILES = 8;
export const PROSPECT_TICKS = 15;
/** Food a miner eats per unit of ore. */
export const MINER_FOOD: readonly Resource[] = ['bread', 'fish', 'meat'];

/** Fish per water tile and how fast the water restocks (expected restock attempts per tick per 64×64 of map). */
export const FISH_MAX = 3;
export const FISH_RESTOCK = 2;

// ------------------------------------------------------------- professions

/**
 * How a settler of a profession behaves when idle:
 * - carrier: moves goods for the logistics dispatcher;
 * - builder: works on construction sites;
 * - gather: walks out to a map tile, works it and brings one unit home;
 * - plant: walks out and plants (a tree, a field…);
 * - farm: harvests ripe plantings like a gatherer, otherwise plants new ones;
 * - workshop: stays inside and runs the building's recipe;
 * - garrison: stays inside so the building claims territory;
 * - prospect: a carrier on a geologist errand; turns back into a carrier once the errand is done;
 * - soldier: lives in a military building's garrison; looks for a free one when homeless.
 */
export type Behavior =
  | 'carrier'
  | 'builder'
  | 'gather'
  | 'plant'
  | 'farm'
  | 'workshop'
  | 'garrison'
  | 'prospect'
  | 'soldier';

export interface GatherDef {
  res: Resource;
  radius: number;
  workTicks: number;
  restTicks: number;
}

export interface PlantDef {
  what: PlantKind;
  radius: number;
  workTicks: number;
  restTicks: number;
  /** Stop planting once this many plantings of the kind exist within the radius. */
  maxNearby?: number;
}

export interface ProfessionDef {
  name: string;
  behavior: Behavior;
  /** Hit points when taking up the profession (soldiers). */
  hp?: number;
  /** Tool a carrier must fetch from storage to take up the profession (it is used up). */
  tool?: Resource;
  gather?: GatherDef;
  plant?: PlantDef;
}

export const PROFESSIONS: Record<SettlerKind, ProfessionDef> = {
  carrier: { name: 'Носильщик', behavior: 'carrier' },
  builder: { name: 'Строитель', behavior: 'builder', tool: 'hammer' },
  woodcutter: { name: 'Лесоруб', behavior: 'gather', tool: 'axe', gather: { res: 'log', radius: 8, workTicks: 40, restTicks: 30 } },
  stonecutter: {
    name: 'Каменотёс',
    behavior: 'gather',
    tool: 'pickaxe',
    gather: { res: 'stone', radius: 8, workTicks: 50, restTicks: 30 },
  },
  forester: {
    name: 'Лесничий',
    behavior: 'plant',
    tool: 'shovel',
    plant: { what: 'tree', radius: 6, workTicks: 30, restTicks: 60 },
  },
  waterman: { name: 'Водонос', behavior: 'gather', gather: { res: 'water', radius: 7, workTicks: 20, restTicks: 20 } },
  fisher: { name: 'Рыбак', behavior: 'gather', tool: 'rod', gather: { res: 'fish', radius: 8, workTicks: 60, restTicks: 30 } },
  farmer: {
    name: 'Фермер',
    behavior: 'farm',
    tool: 'scythe',
    gather: { res: 'grain', radius: 5, workTicks: 30, restTicks: 15 },
    plant: { what: 'grain', radius: 5, workTicks: 25, restTicks: 15, maxNearby: 10 },
  },
  sawmiller: { name: 'Пильщик', behavior: 'workshop', tool: 'saw' },
  miller: { name: 'Мельник', behavior: 'workshop' },
  baker: { name: 'Пекарь', behavior: 'workshop' },
  pigfarmer: { name: 'Свинопас', behavior: 'workshop' },
  butcher: { name: 'Мясник', behavior: 'workshop' },
  miner: { name: 'Шахтёр', behavior: 'workshop', tool: 'pickaxe' },
  smelter: { name: 'Плавильщик', behavior: 'workshop' },
  toolsmith: { name: 'Инструментальщик', behavior: 'workshop' },
  vinegrower: {
    name: 'Виноградарь',
    behavior: 'farm',
    tool: 'shovel',
    gather: { res: 'grapes', radius: 5, workTicks: 30, restTicks: 20 },
    plant: { what: 'vine', radius: 5, workTicks: 40, restTicks: 20, maxNearby: 8 },
  },
  winemaker: { name: 'Винодел', behavior: 'workshop' },
  geologist: { name: 'Геолог', behavior: 'prospect' },
  weaponsmith: { name: 'Оружейник', behavior: 'workshop' },
  soldier: { name: 'Солдат', behavior: 'soldier', tool: 'sword', hp: 100 },
};

// --------------------------------------------------------------- buildings

/**
 * A workshop turns `inputs` (all of them) plus one unit of any of `inputsAnyOf` into `outputs`
 * every `ticks` while its worker is inside. `inputsAnyOf` share one input pile limit.
 */
export interface Recipe {
  inputs: Partial<Stock>;
  inputsAnyOf?: readonly Resource[];
  outputs: Partial<Stock>;
  /** Instead of fixed outputs: one unit of whichever of these the owner needs most (see `chooseOutput`). */
  outputChoice?: readonly Resource[];
  /** With `outputChoice`: keep at least this many of each in stock; beyond that, only make what is awaited. */
  keepInStock?: number;
  ticks: number;
}

/** Build-menu tab. */
export type Category = 'housing' | 'resources' | 'food' | 'mining' | 'metal' | 'military';

export const CATEGORIES: Record<Category, string> = {
  housing: 'Поселение',
  resources: 'Сырьё',
  food: 'Еда',
  mining: 'Горное дело',
  metal: 'Металл',
  military: 'Военное',
};

export interface BuildingDef {
  name: string;
  w: number;
  h: number;
  /** Materials needed to construct. */
  cost: Partial<Stock>;
  worker: SettlerKind | null;
  playerBuildable: boolean;
  category?: Category;
  /** Warehouse: accepts any goods and supplies them back. */
  storage?: boolean;
  recipe?: Recipe;
  /** Territory radius (tiles from the building center); claimed once staffed, or when done if no worker. */
  territory?: number;
  /** Residence: releases `capacity` new carriers, one every `everyTicks`, once built. */
  residence?: { capacity: number; everyTicks: number };
  /**
   * Military building: holds up to `capacity` soldiers. It claims `territory` while at least one
   * soldier is inside, or always if `claimsWhenEmpty` (the castle).
   */
  garrison?: { capacity: number; claimsWhenEmpty?: boolean };
  /** Footprint terrain: ordinary buildings need grass, mines need mountain. */
  terrain?: 'mountain';
  /** Mine: each recipe cycle also takes one unit of ore of this resource from a tile within `radius`. */
  mine?: { res: Resource; radius: number };
}

function mine(name: string, res: Resource): BuildingDef {
  return {
    name,
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 1 },
    worker: 'miner',
    playerBuildable: true,
    category: 'mining',
    terrain: 'mountain',
    mine: { res, radius: 3 },
    recipe: { inputs: {}, inputsAnyOf: MINER_FOOD, outputs: { [res]: 1 }, ticks: 80 },
  };
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  castle: {
    name: 'Замок',
    w: 3,
    h: 3,
    cost: {},
    worker: null,
    playerBuildable: false,
    storage: true,
    territory: 10,
    garrison: { capacity: 12, claimsWhenEmpty: true },
  },

  house_small: {
    name: 'Малый дом',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 1 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 4, everyTicks: 150 },
  },
  house_medium: {
    name: 'Средний дом',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 8, everyTicks: 120 },
  },
  house_large: {
    name: 'Большой дом',
    w: 3,
    h: 3,
    cost: { plank: 5, stone: 4 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 14, everyTicks: 100 },
  },

  warehouse: {
    name: 'Склад',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    storage: true,
  },

  woodcutter: {
    name: 'Дом лесоруба',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'woodcutter',
    playerBuildable: true,
    category: 'resources',
  },
  forester: {
    name: 'Дом лесничего',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'forester',
    playerBuildable: true,
    category: 'resources',
  },
  sawmill: {
    name: 'Лесопилка',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'sawmiller',
    playerBuildable: true,
    category: 'resources',
    recipe: { inputs: { log: 1 }, outputs: { plank: 1 }, ticks: 50 },
  },
  stonecutter: {
    name: 'Каменотёс',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'stonecutter',
    playerBuildable: true,
    category: 'resources',
  },

  waterworks: {
    name: 'Водокачка',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'waterman',
    playerBuildable: true,
    category: 'food',
  },
  fisher: { name: 'Рыбак', w: 2, h: 2, cost: { plank: 2 }, worker: 'fisher', playerBuildable: true, category: 'food' },
  farm: {
    name: 'Ферма',
    w: 3,
    h: 3,
    cost: { plank: 3, stone: 1 },
    worker: 'farmer',
    playerBuildable: true,
    category: 'food',
  },
  mill: {
    name: 'Мельница',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'miller',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { grain: 1 }, outputs: { flour: 1 }, ticks: 60 },
  },
  bakery: {
    name: 'Пекарня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'baker',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { flour: 1, water: 1 }, outputs: { bread: 1 }, ticks: 60 },
  },
  pigfarm: {
    name: 'Свиноферма',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 1 },
    worker: 'pigfarmer',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { grain: 1, water: 1 }, outputs: { pig: 1 }, ticks: 120 },
  },
  slaughterhouse: {
    name: 'Бойня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'butcher',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { pig: 1 }, outputs: { meat: 2 }, ticks: 60 },
  },

  coalmine: mine('Угольная шахта', 'coal'),
  ironmine: mine('Железный рудник', 'ironore'),
  goldmine: mine('Золотой рудник', 'goldore'),
  stonemine: mine('Каменоломня в горе', 'stone'),

  ironsmelter: {
    name: 'Плавильня железа',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { ironore: 1, coal: 1 }, outputs: { iron: 1 }, ticks: 70 },
  },
  goldsmelter: {
    name: 'Плавильня золота',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { goldore: 1, coal: 1 }, outputs: { gold: 1 }, ticks: 70 },
  },
  toolsmith: {
    name: 'Инструментальщик',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'toolsmith',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { iron: 1, coal: 1 }, outputs: {}, outputChoice: TOOLS, keepInStock: 2, ticks: 80 },
  },

  vineyard: {
    name: 'Виноградник',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 1 },
    worker: 'vinegrower',
    playerBuildable: true,
    category: 'food',
  },
  winery: {
    name: 'Винодельня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'winemaker',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { grapes: 2 }, outputs: { wine: 1 }, ticks: 80 },
  },

  weaponsmith: {
    name: 'Оружейник',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'weaponsmith',
    playerBuildable: true,
    category: 'military',
    recipe: { inputs: { iron: 1, coal: 1 }, outputs: { sword: 1 }, ticks: 80 },
  },
  tower: {
    name: 'Сторожевая башня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    territory: 8,
    garrison: { capacity: 3 },
  },
};

/** Fills the missing resources of a partial stock with zeros. */
export function fullStock(partial: Partial<Stock>): Stock {
  return { ...emptyStock(), ...partial };
}

export function costOf(type: BuildingType): Stock {
  return fullStock(BUILDINGS[type].cost);
}

/** Total material units, i.e. how many work shifts the building takes. */
export function totalCost(type: BuildingType): number {
  return Object.values(BUILDINGS[type].cost).reduce((sum, n) => sum + (n ?? 0), 0);
}

/** What the building's own worker gathers, if it is a gatherer's hut. */
export function gatheredBy(type: BuildingType): GatherDef | undefined {
  const worker = BUILDINGS[type].worker;
  return worker ? PROFESSIONS[worker].gather : undefined;
}
