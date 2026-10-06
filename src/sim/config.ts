import type { BuildingType, SettlerKind } from './types';

export const TICKS_PER_SECOND = 10;

export const MAP_SIZE = 64;

/** Tiles per tick. */
export const SETTLER_SPEED = 0.2;

export const BUILD_TICKS_PER_UNIT = 30;
export const CHOP_TICKS = 40;
export const WOODCUTTER_REST_TICKS = 30;
export const WOODCUTTER_RADIUS = 8;
export const SAW_TICKS = 50;
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

export const TREE_MATURE = 4;

export interface BuildingDef {
  name: string;
  w: number;
  h: number;
  /** Planks needed to construct. */
  cost: number;
  worker: SettlerKind | null;
  playerBuildable: boolean;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  castle: { name: 'Замок', w: 3, h: 3, cost: 0, worker: null, playerBuildable: false },
  woodcutter: { name: 'Дом лесоруба', w: 2, h: 2, cost: 2, worker: 'woodcutter', playerBuildable: true },
  sawmill: { name: 'Лесопилка', w: 2, h: 2, cost: 3, worker: 'sawmiller', playerBuildable: true },
};

export const SETTLER_NAMES: Record<SettlerKind, string> = {
  carrier: 'Носильщик',
  builder: 'Строитель',
  woodcutter: 'Лесоруб',
  sawmiller: 'Пильщик',
};
