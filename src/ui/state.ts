import type { BuildingType } from '../sim/types';

/** UI state shared between input handling, HUD and the game loop. */
export interface GameState {
  speed: number;
  paused: boolean;
  placing: BuildingType | null;
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
