import type { BuildingType } from '../sim/types';

/** What the cursor is about to place: a building, or a command aimed at a tile. */
export type Placeable = BuildingType | 'geologist';

/** UI state shared between input handling, HUD and the game loop. */
export interface GameState {
  speed: number;
  paused: boolean;
  placing: Placeable | null;
  selected: number | null;
  /** Tile under the cursor, if any. */
  hover: { x: number; y: number } | null;
}

export const createState = (): GameState => ({
  speed: 1,
  paused: false,
  placing: null,
  selected: null,
  hover: null,
});
