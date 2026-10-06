export interface Point {
  x: number;
  y: number;
}

export const RESOURCES = [
  'log',
  'plank',
  'stone',
  'water',
  'fish',
  'grain',
  'flour',
  'bread',
  'pig',
  'meat',
  'coal',
  'ironore',
  'goldore',
  'iron',
  'gold',
  'axe',
  'saw',
  'pickaxe',
  'shovel',
  'scythe',
  'rod',
  'hammer',
  'grapes',
  'wine',
  'sword',
  'bow',
] as const;
export type Resource = (typeof RESOURCES)[number];
export type Stock = Record<Resource, number>;
export const emptyStock = (): Stock => Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Stock;

/** What a planting profession puts into the ground. */
export type PlantKind = 'tree' | 'grain' | 'vine';

export enum Terrain {
  Water = 0,
  Sand = 1,
  Grass = 2,
  /** Impassable cliffs and peaks. */
  Rock = 3,
  /** Walkable mountain slopes; only mines can be built here, ore lies underneath. */
  Mountain = 4,
  /** Shallow river crossing: walkable water, nothing can be built or fished there. */
  Ford = 5,
  /** Dry land: walkable and buildable, but nothing grows. */
  Desert = 6,
  /** Wet lowland: walkable but slow; nothing can be built or planted. */
  Swamp = 7,
}

export type BuildingType =
  | 'castle'
  | 'house_small'
  | 'house_medium'
  | 'house_large'
  | 'woodcutter'
  | 'sawmill'
  | 'forester'
  | 'stonecutter'
  | 'waterworks'
  | 'fisher'
  | 'farm'
  | 'mill'
  | 'bakery'
  | 'pigfarm'
  | 'slaughterhouse'
  | 'coalmine'
  | 'ironmine'
  | 'goldmine'
  | 'stonemine'
  | 'ironsmelter'
  | 'goldsmelter'
  | 'toolsmith'
  | 'warehouse'
  | 'vineyard'
  | 'winery'
  | 'weaponsmith'
  | 'tower'
  | 'bigtower'
  | 'fortress';

export type SettlerKind =
  | 'carrier'
  | 'builder'
  | 'woodcutter'
  | 'sawmiller'
  | 'forester'
  | 'stonecutter'
  | 'waterman'
  | 'fisher'
  | 'farmer'
  | 'miller'
  | 'baker'
  | 'pigfarmer'
  | 'butcher'
  | 'miner'
  | 'geologist'
  | 'smelter'
  | 'toolsmith'
  | 'vinegrower'
  | 'winemaker'
  | 'weaponsmith'
  | 'soldier'
  | 'archer'
  | 'digger';

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
  /** Residence: settlers released so far. */
  spawned: number;
  /** Player flag: served first by logistics and builders. */
  priority: boolean;
  /** Military building: soldiers stationed here (settler ids) and soldiers on their way in. */
  garrison: number[];
  garrisonInbound: number;
  /** Of `garrisonInbound`, how many are archers (so recruiting fills archer slots only once). */
  garrisonArchersInbound: number;
  /** Construction site on sloped ground: false until a digger has flattened it; builders wait. */
  levelled: boolean;
  diggerId: number | null;
  /** Height the digger flattens the site's corners to (set when the site is laid out). */
  levelTo: number;
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
  | { t: 'plant'; x: number; y: number; n: number; what: PlantKind }
  /** `stall`: consecutive ticks without material to work with. */
  | { t: 'build'; b: number; stall: number }
  /** Digger flattens the site's corners towards their mean height; `n` counts ticks to the next step. */
  | { t: 'dig'; b: number; n: number }
  /** Geologist examines a mountain tile and leaves a sign. */
  | { t: 'prospect'; x: number; y: number; n: number }
  | { t: 'become'; b: number; kind: SettlerKind }
  /** Take up a profession that has no workplace (e.g. builder), using the tool in hand. */
  | { t: 'retool'; kind: SettlerKind }
  /** Soldier moves into a military building's garrison (reserved via `garrisonInbound`). */
  /** `archer`: which garrison role the slot was reserved for (see `garrisonArchersInbound`). */
  | { t: 'join'; b: number; archer?: boolean }
  /** Soldier attacks an enemy military building: duel its defenders at the door, take it when empty. */
  | { t: 'assault'; b: number; n: number };

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
  /** Hit points; only soldiers have them (0 for everyone else). */
  hp: number;
  /** Settler this soldier is fighting right now, or null. */
  opponent: number | null;
  /** Military rank, 0-based index into `SOLDIER_LEVELS`; raised with gold. */
  level: number;
  /** Archers: ticks until the next shot. */
  reload: number;
}
