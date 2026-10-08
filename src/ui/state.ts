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
  /** Own fighters selected for direct orders (box or click, as in Settlers 4); right-click orders them. */
  selectedUnits: number[];
  /**
   * Control groups (Ctrl+1…9 stores the selection, 1…9 recalls it), index 1–9: settler ids. UI state
   * only, not saved; dead or lost units drop out when a group is recalled.
   */
  groups: number[][];
  /** Building whose work-area centre the next left click on the map sets (S4's «move work area»). */
  movingWorkArea: number | null;
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
  selectedUnits: [],
  groups: Array.from({ length: 10 }, () => []),
  movingWorkArea: null,
  hover: null,
  fog: true,
});
