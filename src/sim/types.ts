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
  'sword',
  'bow',
] as const;
export type Resource = (typeof RESOURCES)[number];
export type Stock = Record<Resource, number>;
export const emptyStock = (): Stock => Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Stock;

/** What a planting profession puts into the ground. */
export type PlantKind = 'tree' | 'grain';

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
  | 'hunter'
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
  | 'weaponsmith'
  | 'tower'
  | 'bigtower'
  | 'fortress'
  | 'barracks'
  | 'lookout'
  | 'infirmary'
  | 'flowerbed'
  | 'column'
  | 'statue'
  | 'fountain'
  | 'obelisk';

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
  | 'weaponsmith'
  | 'soldier'
  | 'archer'
  | 'recruit'
  | 'hunter'
  | 'digger'
  | 'pioneer'
  | 'thief';

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
  /**
   * Construction site: false until a digger has cleared it (and flattened it, on sloped ground);
   * builders wait, carriers already bring materials. Mines need no digger.
   */
  levelled: boolean;
  diggerId: number | null;
  /** Height the digger flattens the site's corners to (set when the site is laid out); −1: flat already. */
  levelTo: number;
  /** Spade strokes spent clearing the site; it is cleared at `clearStrokes(b)`. */
  dug: number;
  /** Mine: digging attempts left from the food eaten (see `runMine`). */
  attempts?: number;
  /** Warehouse: goods it does not take in (player setting, `World.setAccepts`). */
  refuse?: Resource[];
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
  | { t: 'assault'; b: number; n: number }
  /**
   * Hunter shoots a wild animal (`World.animals` id `a`, reserved via `Animal.hunter`): closes in
   * (`chase` approaches so far), aims for `n` ticks once in range, then carries `res`.
   */
  | { t: 'hunt'; a: number; n: number; chase: number; res: Resource }
  /** Wounded fighter lies in an infirmary until healed (`n` counts ticks to the next hit point). */
  | { t: 'heal'; b: number; n: number }
  /** Pioneer moves the border stone onto a neutral tile: after `n` ticks it is the owner's land. */
  | { t: 'claim'; x: number; y: number; n: number }
  /** Thief at a foreign building's door: after `n` ticks he takes one good and carries it home. */
  | { t: 'steal'; b: number; n: number };

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
  /**
   * Idle crowd (`idle.ts`): the building a free settler hangs about, where it is strolling to (its
   * `path` belongs to the stroll while this is set), ticks until the next stroll, and the settler it
   * stands chatting with (an id; check it still exists and is idle before use).
   */
  idleAt: number | null;
  stroll: Point | null;
  strollIn: number;
  chatWith: number | null;
  /**
   * Specialist errand (`specialists.ts`): where a pioneer was sent to push the border (`n`: tiles he
   * may still claim), or the building `b` a thief was sent to rob. Absent on everyone else (and on saves made before specialists).
   */
  errand?: { x: number; y: number; b?: number; n?: number } | null;
}
