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
export const START_BUILDERS = 3;
export const START_PLANKS = 20;
export const START_STONE = 10;

export const TREE_MATURE = 4;
/** Stone units in a deposit tile at generation, inclusive range. */
export const DEPOSIT_STONE: [number, number] = [4, 8];
/** Grain field stages: 1 sown … CROP_RIPE harvestable. Fields grow every CROP_GROW_EVERY ticks with CROP_GROW_CHANCE. */
export const CROP_RIPE = 4;
export const CROP_GROW_EVERY = 10;
export const CROP_GROW_CHANCE = 0.035;
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
 * - garrison: stays inside so the building claims territory.
 */
export type Behavior = 'carrier' | 'builder' | 'gather' | 'plant' | 'farm' | 'workshop' | 'garrison';

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
  gather?: GatherDef;
  plant?: PlantDef;
}

export const PROFESSIONS: Record<SettlerKind, ProfessionDef> = {
  carrier: { name: 'Носильщик', behavior: 'carrier' },
  builder: { name: 'Строитель', behavior: 'builder' },
  woodcutter: { name: 'Лесоруб', behavior: 'gather', gather: { res: 'log', radius: 8, workTicks: 40, restTicks: 30 } },
  stonecutter: {
    name: 'Каменотёс',
    behavior: 'gather',
    gather: { res: 'stone', radius: 8, workTicks: 50, restTicks: 30 },
  },
  forester: {
    name: 'Лесничий',
    behavior: 'plant',
    plant: { what: 'tree', radius: 6, workTicks: 30, restTicks: 60 },
  },
  waterman: { name: 'Водонос', behavior: 'gather', gather: { res: 'water', radius: 7, workTicks: 20, restTicks: 20 } },
  fisher: { name: 'Рыбак', behavior: 'gather', gather: { res: 'fish', radius: 8, workTicks: 60, restTicks: 30 } },
  farmer: {
    name: 'Фермер',
    behavior: 'farm',
    gather: { res: 'grain', radius: 5, workTicks: 30, restTicks: 15 },
    plant: { what: 'grain', radius: 5, workTicks: 25, restTicks: 15, maxNearby: 10 },
  },
  sawmiller: { name: 'Пильщик', behavior: 'workshop' },
  miller: { name: 'Мельник', behavior: 'workshop' },
  baker: { name: 'Пекарь', behavior: 'workshop' },
  pigfarmer: { name: 'Свинопас', behavior: 'workshop' },
  butcher: { name: 'Мясник', behavior: 'workshop' },
  guard: { name: 'Стражник', behavior: 'garrison' },
};

// --------------------------------------------------------------- buildings

/** A workshop turns `inputs` into `outputs` every `ticks` while its worker is inside. */
export interface Recipe {
  inputs: Partial<Stock>;
  outputs: Partial<Stock>;
  ticks: number;
}

/** Build-menu tab. */
export type Category = 'housing' | 'resources' | 'food' | 'military';

export const CATEGORIES: Record<Category, string> = {
  housing: 'Жильё',
  resources: 'Сырьё',
  food: 'Еда',
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
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  castle: { name: 'Замок', w: 3, h: 3, cost: {}, worker: null, playerBuildable: false, storage: true, territory: 10 },

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

  tower: {
    name: 'Сторожевая башня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'guard',
    playerBuildable: true,
    category: 'military',
    territory: 8,
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
