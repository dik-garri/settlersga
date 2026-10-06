export interface Point {
  x: number;
  y: number;
}

export type Resource = 'log' | 'plank' | 'stone';
export const RESOURCES: readonly Resource[] = ['log', 'plank', 'stone'];
export type Stock = Record<Resource, number>;
export const emptyStock = (): Stock => ({ log: 0, plank: 0, stone: 0 });

export enum Terrain {
  Water = 0,
  Sand = 1,
  Grass = 2,
  Rock = 3,
}

export type BuildingType = 'castle' | 'woodcutter' | 'sawmill' | 'forester' | 'stonecutter' | 'tower';
export type SettlerKind = 'carrier' | 'builder' | 'woodcutter' | 'sawmiller' | 'forester' | 'stonecutter' | 'guard';

/** Player ids start at 1; 0 means "nobody" in per-tile ownership. */
export type PlayerId = number;

export interface Building {
  id: number;
  type: BuildingType;
  owner: PlayerId;
  /** Top tile of the footprint; footprint spans [x, x+w) × [y, y+h). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Walkable tile in front of the building where goods are picked up and dropped. */
  door: Point;
  done: boolean;
  /** Construction: materials delivered to the site and work ticks spent. */
  delivered: Stock;
  progress: number;
  builderId: number | null;
  /** Goods on the way to this building (reserved by carriers). */
  inbound: Stock;
  input: Stock;
  /** Output pile at the door. For the castle this is the warehouse stock. */
  output: Stock;
  /** Output units already promised to a carrier. */
  outReserved: Stock;
  workerId: number | null;
  workerRequested: boolean;
  /** Workshop: ticks spent on the current recipe cycle. */
  timer: number;
  /** Tick until which no route to the door is known; logistics and builders skip it until then. */
  unreachableUntil: number;
}

export type Task =
  | { t: 'goto'; x: number; y: number; adj?: boolean }
  | { t: 'enter'; b: number }
  | { t: 'wait'; n: number }
  | { t: 'pickup'; b: number; res: Resource }
  /** `back`: returning goods to a warehouse after a failed job. */
  | { t: 'drop'; b: number; res: Resource; back?: boolean }
  /** Worker puts its own product on the building's output pile. */
  | { t: 'store'; b: number; res: Resource }
  /** Fell a tree or break stone off a deposit; the settler then carries `res`. */
  | { t: 'gather'; x: number; y: number; n: number; res: Resource }
  | { t: 'plant'; x: number; y: number; n: number }
  /** `stall`: consecutive ticks without material to work with. */
  | { t: 'build'; b: number; stall: number }
  | { t: 'become'; b: number; kind: SettlerKind };

export interface Settler {
  id: number;
  owner: PlayerId;
  kind: SettlerKind;
  /** Position in tile coordinates (tile centers are integers). */
  x: number;
  y: number;
  /** Position at the previous tick, for render interpolation. */
  px: number;
  py: number;
  /** Remaining tile centers to walk through. */
  path: Point[];
  tasks: Task[];
  carrying: Resource | null;
  /** Building the settler is hidden inside, or null when outside. */
  inside: number | null;
  home: number | null;
  idleTicks: number;
  /** True while doing manual work (chopping, building) — used for animation. */
  working: boolean;
}
