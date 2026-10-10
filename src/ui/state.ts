import type { BuildingType, PlayerId } from '../sim/types';
import { LOCAL_PLAYER } from '../sim/world';
import type { Locks } from './locks';

/** What the cursor is about to place: a building, or a command aimed at a tile. */
export type Placeable = BuildingType | 'geologist' | 'pioneer' | 'thief' | 'saboteur';

/** Placeables that are commands aimed at a tile or building, not buildings. */
export const isCommand = (p: Placeable | null): p is Exclude<Placeable, BuildingType> =>
  p === 'geologist' || p === 'pioneer' || p === 'thief' || p === 'saboteur';

/** UI state shared between input handling, HUD and the game loop. */
export interface GameState {
  /**
   * The player this browser plays: every view, window, the fog, the minimap, messages and the
   * orders the interface gives are this player's. `LOCAL_PLAYER` (1) in a game on one machine; in a
   * network game the seat the lobby gave this browser.
   */
  readonly localPlayer: PlayerId;
  /**
   * The human players' names by player id (`playerNames.ts`): in a network game from the setup the
   * host sent at «Start», on one machine the own name. Interface data only, never the world's.
   */
  names: ReadonlyMap<PlayerId, string>;
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
  /** The game menu (`PauseMenu`) is open: the game is paused and the map takes no input. */
  menu: boolean;
  /**
   * What a tutorial mission leaves open in the interface (`locks.ts`); null = everything (a normal
   * game). The interface only: the simulation forbids nothing.
   */
  locks: Locks | null;
  /**
   * A network game (`net/match.ts`): pause and speed are orders for every machine, played at a common
   * turn, so the interface asks for them here instead of setting `paused`/`speed` (which then mirror
   * the match). `speed` is null on a machine that is not the host. Null in a game on one machine.
   */
  net: { pause(on: boolean): void; speed: ((s: number) => void) | null } | null;
}

/** Pause or resume: at once on one machine, for everybody at a common turn in a network game. */
export function setPaused(state: GameState, on: boolean): void {
  if (state.net) state.net.pause(on);
  else state.paused = on;
}

/** Whether this machine may change the game speed (in a network game only the host may). */
export const canChangeSpeed = (state: GameState): boolean => !state.net || state.net.speed !== null;

/** Another game speed (and no pause): on one machine at once; in a network game the host's order. */
export function chooseSpeed(state: GameState, s: number): void {
  if (!state.net) {
    state.speed = s;
    state.paused = false;
    return;
  }
  if (!state.net.speed) return;
  state.net.speed(s);
  if (state.paused) state.net.pause(false);
}

export const createState = (localPlayer: PlayerId = LOCAL_PLAYER): GameState => ({
  localPlayer,
  names: new Map(),
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
  menu: false,
  locks: null,
  net: null,
});
