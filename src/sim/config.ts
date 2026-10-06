import { emptyStock, type BuildingType, type Resource, type SettlerKind, type Stock } from './types';

export const TICKS_PER_SECOND = 10;

export const MAP_SIZE = 64;

/** Tiles per tick. */
export const SETTLER_SPEED = 0.2;

export const BUILD_TICKS_PER_UNIT = 30;
export const SAW_TICKS = 50;
export const PLANT_TICKS = 30;
export const FORESTER_REST_TICKS = 60;
export const FORESTER_RADIUS = 6;
export const HANDLE_TICKS = 3;

export const OUTPUT_CAP = 4;
export const INPUT_CAP = 4;

export const DISPATCH_EVERY = 5;
export const IDLE_GO_HOME_TICKS = 30;
export const SPAWN_CARRIER_EVERY = 200;
export const MAX_POPULATION = 40;

export const START_CARRIERS = 12;
export const START_BUILDERS = 3;
export const START_PLANKS = 14;
export const START_STONE = 6;

export const TREE_MATURE = 4;
/** Stone units in a deposit tile at generation, inclusive range. */
export const DEPOSIT_STONE: [number, number] = [4, 8];

/** Workers who walk out to a map tile, work on it and bring one unit of `res` home. */
export interface GatherDef {
  res: Resource;
  radius: number;
  workTicks: number;
  restTicks: number;
}

export const GATHERERS: Partial<Record<SettlerKind, GatherDef>> = {
  woodcutter: { res: 'log', radius: 8, workTicks: 40, restTicks: 30 },
  stonecutter: { res: 'stone', radius: 8, workTicks: 50, restTicks: 30 },
};

export interface BuildingDef {
  name: string;
  w: number;
  h: number;
  /** Materials needed to construct. */
  cost: Partial<Stock>;
  worker: SettlerKind | null;
  playerBuildable: boolean;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  castle: { name: 'Замок', w: 3, h: 3, cost: {}, worker: null, playerBuildable: false },
  woodcutter: { name: 'Дом лесоруба', w: 2, h: 2, cost: { plank: 2 }, worker: 'woodcutter', playerBuildable: true },
  sawmill: { name: 'Лесопилка', w: 2, h: 2, cost: { plank: 2, stone: 2 }, worker: 'sawmiller', playerBuildable: true },
  forester: { name: 'Дом лесничего', w: 2, h: 2, cost: { plank: 2 }, worker: 'forester', playerBuildable: true },
  stonecutter: { name: 'Каменотёс', w: 2, h: 2, cost: { plank: 2 }, worker: 'stonecutter', playerBuildable: true },
};

export function costOf(type: BuildingType): Stock {
  return { ...emptyStock(), ...BUILDINGS[type].cost };
}

/** Total material units, i.e. how many work shifts the building takes. */
export function totalCost(type: BuildingType): number {
  return Object.values(BUILDINGS[type].cost).reduce((sum, n) => sum + (n ?? 0), 0);
}

export const SETTLER_NAMES: Record<SettlerKind, string> = {
  carrier: 'Носильщик',
  builder: 'Строитель',
  woodcutter: 'Лесоруб',
  sawmiller: 'Пильщик',
  forester: 'Лесничий',
  stonecutter: 'Каменотёс',
};
