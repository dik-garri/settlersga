import { emptyStock, type BuildingType, type Resource, type SettlerKind, type Stock } from './types';

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
export const SPAWN_CARRIER_EVERY = 200;
export const MAX_POPULATION = 40;

export const START_CARRIERS = 12;
export const START_BUILDERS = 3;
export const START_PLANKS = 14;
export const START_STONE = 6;

export const TREE_MATURE = 4;
/** Stone units in a deposit tile at generation, inclusive range. */
export const DEPOSIT_STONE: [number, number] = [4, 8];

// ------------------------------------------------------------- professions

/**
 * How a settler of a profession behaves when idle:
 * - carrier: moves goods for the logistics dispatcher;
 * - builder: works on construction sites;
 * - gather: walks out to a map tile, works it and brings one unit home;
 * - plant: walks out and plants a sapling;
 * - workshop: stays inside and runs the building's recipe;
 * - garrison: stays inside so the building claims territory.
 */
export type Behavior = 'carrier' | 'builder' | 'gather' | 'plant' | 'workshop' | 'garrison';

export interface GatherDef {
  res: Resource;
  radius: number;
  workTicks: number;
  restTicks: number;
}

export interface PlantDef {
  radius: number;
  workTicks: number;
  restTicks: number;
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
  woodcutter: {
    name: 'Лесоруб',
    behavior: 'gather',
    gather: { res: 'log', radius: 8, workTicks: 40, restTicks: 30 },
  },
  stonecutter: {
    name: 'Каменотёс',
    behavior: 'gather',
    gather: { res: 'stone', radius: 8, workTicks: 50, restTicks: 30 },
  },
  forester: { name: 'Лесничий', behavior: 'plant', plant: { radius: 6, workTicks: 30, restTicks: 60 } },
  sawmiller: { name: 'Пильщик', behavior: 'workshop' },
  guard: { name: 'Стражник', behavior: 'garrison' },
};

// --------------------------------------------------------------- buildings

/** A workshop turns `inputs` into `outputs` every `ticks` while its worker is inside. */
export interface Recipe {
  inputs: Partial<Stock>;
  outputs: Partial<Stock>;
  ticks: number;
}

export interface BuildingDef {
  name: string;
  w: number;
  h: number;
  /** Materials needed to construct. */
  cost: Partial<Stock>;
  worker: SettlerKind | null;
  playerBuildable: boolean;
  /** Warehouse: accepts any goods and supplies them back. */
  storage?: boolean;
  recipe?: Recipe;
  /** Territory radius (tiles from the building center); claimed once staffed, or when done if no worker. */
  territory?: number;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  castle: { name: 'Замок', w: 3, h: 3, cost: {}, worker: null, playerBuildable: false, storage: true, territory: 10 },
  woodcutter: { name: 'Дом лесоруба', w: 2, h: 2, cost: { plank: 2 }, worker: 'woodcutter', playerBuildable: true },
  sawmill: {
    name: 'Лесопилка',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'sawmiller',
    playerBuildable: true,
    recipe: { inputs: { log: 1 }, outputs: { plank: 1 }, ticks: 50 },
  },
  forester: { name: 'Дом лесничего', w: 2, h: 2, cost: { plank: 2 }, worker: 'forester', playerBuildable: true },
  stonecutter: { name: 'Каменотёс', w: 2, h: 2, cost: { plank: 2 }, worker: 'stonecutter', playerBuildable: true },
  tower: {
    name: 'Сторожевая башня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'guard',
    playerBuildable: true,
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
