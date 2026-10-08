import type { BuildingType } from '../sim/types';

/** What the cursor is about to place: a building, or a command aimed at a tile. */
export type Placeable = BuildingType | 'geologist' | 'pioneer' | 'thief';

/** Placeables that are commands aimed at a tile or building, not buildings. */
export const isCommand = (p: Placeable | null): p is Exclude<Placeable, BuildingType> =>
  p === 'geologist' || p === 'pioneer' || p === 'thief';

/** UI state shared between input handling, HUD and the game loop. */
export interface GameState {
  speed: number;
  paused: boolean;
  placing: Placeable | null;
  selected: number | null;
  /** Settler whose window is shown (a click on a figure); exclusive with `selected`. */
  selectedSettler: number | null;
  /** Tile under the cursor, if any. */
  hover: { x: number; y: number } | null;
  /** Fog of war shown (`?fog=off` turns it off for debugging). */
  fog: boolean;
}

export const createState = (): GameState => ({
  speed: 1,
  paused: false,
  placing: null,
  selected: null,
  selectedSettler: null,
  hover: null,
  fog: true,
});
