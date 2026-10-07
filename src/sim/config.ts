import {
  emptyStock,
  Terrain,
  type BuildingType,
  type PlantKind,
  type Resource,
  type SettlerKind,
  type Stock,
} from './types';

export const TICKS_PER_SECOND = 10;

export const MAP_SIZE = 64;

/** Tiles per tick. */
export const SETTLER_SPEED = 0.2;

export const BUILD_TICKS_PER_UNIT = 30;
export const HANDLE_TICKS = 3;

/** Per-resource pile limits at a workplace door. */
export const OUTPUT_CAP = 4;
export const INPUT_CAP = 4;

export const DISPATCH_EVERY = 5;
export const IDLE_GO_HOME_TICKS = 30;
/** After a failed route search: how long the settler waits and how long the target building is skipped. */
export const PATH_FAIL_BACKOFF = 10;
export const UNREACHABLE_TICKS = 100;
/** A builder idle this long at a site without material moves to a site with work. */
export const BUILDER_STALL_TICKS = 40;

export const START_CARRIERS = 12;
/** Soldiers each player's castle starts with. */
export const START_SOLDIERS = 6;
/** Military buildings keep at least this many soldiers when sending others out (to attack or to man towers). */
export const GARRISON_KEEP = 1;
/** Combat: soldiers within this distance (tiles, building centers) of the target can join an attack. */
export const ATTACK_RANGE = 30;
/** Combat: one blow every FIGHT_EVERY ticks; damage per blow is uniform in [min, max]. */
export const FIGHT_EVERY = 6;
export const DAMAGE: [number, number] = [12, 24];
/**
 * Ranks soldiers and archers reach with gold: hit points and damage relative to level 0. Each step
 * costs `PROMOTE_COST` of `PROMOTE_RES`, delivered to a military building that `trains`.
 */
export const SOLDIER_LEVELS: readonly { hp: number; damage: number }[] = [
  { hp: 1, damage: 1 },
  { hp: 1.3, damage: 1.3 },
  { hp: 1.6, damage: 1.6 },
];
export const PROMOTE_RES: Resource = 'gold';
export const PROMOTE_COST = 1;
export const PROMOTE_TICKS = 100;
/** Garrisoned (inside) soldiers regain one hit point every HEAL_EVERY ticks. */
export const HEAL_EVERY = 10;
/** Visual only: ticks an arrow is drawn in flight. */
export const SHOT_TICKS = 5;
/**
 * Default army make-up per player (weights, see `World.setShare`): the weaponsmith forges and the
 * barracks trains towards these proportions of fighters by weapon.
 */
export const OUTPUT_SHARES: Partial<Record<Resource, number>> = { sword: 60, bow: 40 };
/** A barracks only takes a recruit while the player keeps at least this many idle carriers. */
export const BARRACKS_MIN_IDLE = 2;
export const START_BUILDERS = 3;
/** Diggers at the start: every site is cleared by one before the builders start (as in Settlers 4). */
export const START_DIGGERS = 2;
/** Spade strokes (one per `DIG_EVERY` ticks) to clear one footprint tile, on top of any levelling. */
export const CLEAR_STROKES_PER_TILE = 6;
export const START_PLANKS = 20;
export const START_STONE = 10;
/** Tools in the castle at the start, enough for the first workplaces. */
export const START_TOOLS: Partial<Stock> = { axe: 3, saw: 2, pickaxe: 4, shovel: 2, scythe: 2, rod: 2, hammer: 2 };
/** Display names and stock-panel groups, kept with the data so new resources are one entry. */
export type ResourceGroup = 'building' | 'food' | 'metal' | 'tools' | 'military';
export const RESOURCE_GROUPS: Record<ResourceGroup, string> = {
  building: 'Стройматериалы',
  food: 'Еда',
  metal: 'Руда и металл',
  tools: 'Инструменты',
  military: 'Оружие',
};
/**
 * `storeLimit`: surplus is hauled to warehouses only while fewer than this many units are stored;
 * beyond that goods wait at the producer, whose full pile pauses it, so carriers are not spent on
 * goods nobody needs (water is unlimited and only used next door). Unset = no limit.
 */
export const RESOURCE_INFO: Record<Resource, { name: string; group: ResourceGroup; storeLimit?: number }> = {
  log: { name: 'Брёвна', group: 'building' },
  plank: { name: 'Доски', group: 'building' },
  stone: { name: 'Камень', group: 'building' },
  water: { name: 'Вода', group: 'food', storeLimit: 16 },
  fish: { name: 'Рыба', group: 'food' },
  grain: { name: 'Зерно', group: 'food' },
  flour: { name: 'Мука', group: 'food' },
  bread: { name: 'Хлеб', group: 'food' },
  pig: { name: 'Свиньи', group: 'food' },
  meat: { name: 'Мясо', group: 'food' },
  coal: { name: 'Уголь', group: 'metal' },
  ironore: { name: 'Железная руда', group: 'metal' },
  goldore: { name: 'Золотая руда', group: 'metal' },
  iron: { name: 'Железо', group: 'metal' },
  gold: { name: 'Золото', group: 'metal' },
  axe: { name: 'Топоры', group: 'tools' },
  saw: { name: 'Пилы', group: 'tools' },
  pickaxe: { name: 'Кирки', group: 'tools' },
  shovel: { name: 'Лопаты', group: 'tools' },
  scythe: { name: 'Косы', group: 'tools' },
  rod: { name: 'Удочки', group: 'tools' },
  hammer: { name: 'Молотки', group: 'tools' },
  sword: { name: 'Мечи', group: 'military' },
  bow: { name: 'Луки', group: 'military' },
};

/** Field plantings stored in `map.crop` (stage) with their kind in `map.cropKind` (index here). */
export const CROP_KINDS: readonly PlantKind[] = ['grain'];

/** What the toolsmith can forge. */
export const TOOLS: readonly Resource[] = ['axe', 'saw', 'pickaxe', 'shovel', 'scythe', 'rod', 'hammer'];

export const TREE_MATURE = 4;
/** Ordinary buildings need ground whose corners (footprint and door) differ by at most this many pixels. */
export const BUILD_MAX_SLOPE = 12;
/** Up to this slope a site is still allowed, but a digger must level it before builders start. */
export const BUILD_DIG_SLOPE = 30;
/** A digger moves one corner by one pixel towards the site's level every this many ticks. */
export const DIG_EVERY = 3;
/** Rivers per 64×64 of map, carved from high ground down to the sea or into a lake. */
export const RIVERS_PER_64 = 1.5;
/** A river gets a walkable ford about this often (tiles), so rivers never cut the land apart. */
export const FORD_EVERY = 10;

// ----------------------------------------------------------------- terrain

/** What kind of footprint a terrain accepts: ordinary buildings, mines, or none. */
export type BuildGround = 'ground' | 'mountain';

/**
 * Rules per terrain type. Adding a terrain = a `Terrain` code, an entry here and a ground sprite
 * (`GROUND_COLORS`/`GROUND_PRIORITY` in sprites.ts); sim code only reads this table.
 */
export interface TerrainDef {
  name: string;
  walkable: boolean;
  /** Footprints it accepts, or null. */
  build: BuildGround | null;
  /** Trees and fields grow here (foresters, farmers, natural spread). */
  plantable: boolean;
  /** Walking speed factor, ≤ 1 (A* costs scale by its inverse, so the octile heuristic stays admissible). */
  speed: number;
  /** Open water: wells draw from it, fish live in it. */
  water: boolean;
  /** Minimap colour. */
  rgb: [number, number, number];
}

export const TERRAIN: Record<Terrain, TerrainDef> = {
  [Terrain.Water]: {
    name: 'Вода',
    walkable: false,
    build: null,
    plantable: false,
    speed: 1,
    water: true,
    rgb: [47, 111, 158],
  },
  [Terrain.Sand]: {
    name: 'Песок',
    walkable: true,
    build: null,
    plantable: false,
    speed: 1,
    water: false,
    rgb: [216, 196, 138],
  },
  [Terrain.Grass]: {
    name: 'Трава',
    walkable: true,
    build: 'ground',
    plantable: true,
    speed: 1,
    water: false,
    rgb: [106, 154, 60],
  },
  [Terrain.Rock]: {
    name: 'Скалы',
    walkable: false,
    build: null,
    plantable: false,
    speed: 1,
    water: false,
    rgb: [110, 104, 96],
  },
  [Terrain.Mountain]: {
    name: 'Горы',
    walkable: true,
    build: 'mountain',
    plantable: false,
    speed: 1,
    water: false,
    rgb: [150, 141, 124],
  },
  [Terrain.Ford]: { name: 'Брод', walkable: true, build: null, plantable: false, speed: 1, water: false, rgb: [95, 151, 180] },
  [Terrain.Desert]: {
    name: 'Пустыня',
    walkable: true,
    build: 'ground',
    plantable: false,
    speed: 1,
    water: false,
    rgb: [222, 190, 120],
  },
  [Terrain.Swamp]: {
    name: 'Болото',
    walkable: true,
    build: null,
    plantable: false,
    speed: 0.45,
    water: false,
    rgb: [74, 92, 58],
  },
};

/** A* step cost multiplier per terrain code (1 / speed), as a typed array for the inner loop. */
export const TERRAIN_COST: Float32Array = (() => {
  const codes = Object.keys(TERRAIN).map(Number);
  const out = new Float32Array(Math.max(...codes) + 1).fill(1);
  for (const c of codes) out[c] = 1 / TERRAIN[c as Terrain].speed;
  return out;
})();

/** Deserts and swamps: per 64×64 tuning; generation keeps them this far from every start. */
export const BIOMES = {
  /** Moisture below this, far enough from water, turns grass into desert. */
  desertDryness: 0.36,
  desertWaterDistance: 6,
  /** Moisture above this on low ground close to water turns grass/sand into swamp. */
  swampWetness: 0.56,
  swampWaterDistance: 3,
  swampMaxHeight: 0.44,
  startClearance: 14,
};

// ------------------------------------------------------------------- fog

/** Fog of war: how far buildings and settlers see, and how often visibility is refreshed. */
export const FOG = {
  /** Buildings see their territory radius plus this, or `buildingRadius` without territory. */
  territoryMargin: 3,
  buildingRadius: 5,
  settlerRadius: 3,
  /** Settlers stamp their surroundings every this many ticks; a tile stays visible that long after. */
  settlerEvery: 5,
  /** Building vision is rebuilt at most this often, and only when buildings or territory changed. */
  buildingEvery: 10,
};
/** Stone units in a deposit tile at generation, inclusive range. */
export const DEPOSIT_STONE: [number, number] = [4, 8];
/** Grain field stages: 1 sown … CROP_RIPE harvestable. Fields grow every CROP_GROW_EVERY ticks with CROP_GROW_CHANCE. */
export const CROP_RIPE = 4;
export const CROP_GROW_EVERY = 10;
export const CROP_GROW_CHANCE = 0.035;
/** Ore kinds stored in `map.ore` (index + 1; 0 = none) and the resource a mine extracts. */
export const ORE_RESOURCES: readonly Resource[] = ['coal', 'ironore', 'goldore', 'stone'];
export function oreOf(code: number): Resource | null {
  return code > 0 ? ORE_RESOURCES[code - 1] : null;
}
/** Ore units per mountain tile at generation, inclusive range. */
export const ORE_AMOUNT: [number, number] = [6, 14];
/** Geologist: how far around the target he looks and how long each tile takes. */
export const PROSPECT_RADIUS = 3;
export const PROSPECT_TILES = 8;
export const PROSPECT_TICKS = 15;
/** Food a miner eats per unit of ore. */
export const MINER_FOOD: readonly Resource[] = ['bread', 'fish', 'meat'];

/** Fish per water tile and how fast the water restocks (expected restock attempts per tick per 64×64 of map). */
export const FISH_MAX = 3;
export const FISH_RESTOCK = 2;

// ------------------------------------------------------------- professions

/**
 * How a settler of a profession behaves when idle:
 * - carrier: moves goods for the logistics dispatcher;
 * - builder: works on construction sites;
 * - gather: walks out to a map tile, works it and brings one unit home;
 * - plant: walks out and plants (a tree, a field…);
 * - farm: harvests ripe plantings like a gatherer, otherwise plants new ones;
 * - workshop: stays inside and runs the building's recipe;
 * - garrison: stays inside so the building claims territory;
 * - prospect: a carrier on a geologist errand; turns back into a carrier once the errand is done;
 * - soldier: lives in a military building's garrison; looks for a free one when homeless;
 * - digger: levels sloped construction sites before the builders start.
 */
export type Behavior =
  | 'carrier'
  | 'builder'
  | 'gather'
  | 'plant'
  | 'farm'
  | 'workshop'
  | 'garrison'
  | 'prospect'
  | 'soldier'
  | 'digger';

export interface GatherDef {
  res: Resource;
  radius: number;
  workTicks: number;
  restTicks: number;
}

export interface PlantDef {
  what: PlantKind;
  radius: number;
  workTicks: number;
  restTicks: number;
  /** Stop planting once this many plantings of the kind exist within the radius. */
  maxNearby?: number;
}

/** Fighting abilities of a military profession. */
export interface CombatDef {
  /** Multiplier on melee strength and damage (archers are poor swordsmen). */
  melee: number;
  /** Ranged attack: shoots enemies within `range` tiles every `every` ticks for `damage` (× level). */
  ranged?: { range: number; every: number; damage: [number, number] };
}

export interface ProfessionDef {
  name: string;
  behavior: Behavior;
  /** Hit points at level 0 when taking up the profession (soldiers, archers). */
  hp?: number;
  combat?: CombatDef;
  /** Tool a carrier must fetch from storage to take up the profession (it is used up). */
  tool?: Resource;
  gather?: GatherDef;
  plant?: PlantDef;
}

export const PROFESSIONS: Record<SettlerKind, ProfessionDef> = {
  carrier: { name: 'Носильщик', behavior: 'carrier' },
  builder: { name: 'Строитель', behavior: 'builder', tool: 'hammer' },
  digger: { name: 'Землекоп', behavior: 'digger', tool: 'shovel' },
  woodcutter: { name: 'Лесоруб', behavior: 'gather', tool: 'axe', gather: { res: 'log', radius: 8, workTicks: 40, restTicks: 30 } },
  stonecutter: {
    name: 'Каменотёс',
    behavior: 'gather',
    tool: 'pickaxe',
    gather: { res: 'stone', radius: 8, workTicks: 50, restTicks: 30 },
  },
  forester: {
    name: 'Лесничий',
    behavior: 'plant',
    tool: 'shovel',
    plant: { what: 'tree', radius: 6, workTicks: 30, restTicks: 60 },
  },
  waterman: { name: 'Водонос', behavior: 'gather', gather: { res: 'water', radius: 7, workTicks: 20, restTicks: 20 } },
  fisher: { name: 'Рыбак', behavior: 'gather', tool: 'rod', gather: { res: 'fish', radius: 8, workTicks: 60, restTicks: 30 } },
  farmer: {
    name: 'Фермер',
    behavior: 'farm',
    tool: 'scythe',
    gather: { res: 'grain', radius: 5, workTicks: 30, restTicks: 15 },
    plant: { what: 'grain', radius: 5, workTicks: 25, restTicks: 15, maxNearby: 10 },
  },
  sawmiller: { name: 'Пильщик', behavior: 'workshop', tool: 'saw' },
  miller: { name: 'Мельник', behavior: 'workshop' },
  baker: { name: 'Пекарь', behavior: 'workshop' },
  pigfarmer: { name: 'Свинопас', behavior: 'workshop' },
  butcher: { name: 'Мясник', behavior: 'workshop' },
  miner: { name: 'Шахтёр', behavior: 'workshop', tool: 'pickaxe' },
  smelter: { name: 'Плавильщик', behavior: 'workshop' },
  toolsmith: { name: 'Инструментальщик', behavior: 'workshop' },
  geologist: { name: 'Геолог', behavior: 'prospect' },
  weaponsmith: { name: 'Оружейник', behavior: 'workshop' },
  recruit: { name: 'Новобранец', behavior: 'workshop' },
  soldier: { name: 'Мечник', behavior: 'soldier', tool: 'sword', hp: 100, combat: { melee: 1 } },
  archer: {
    name: 'Лучник',
    behavior: 'soldier',
    tool: 'bow',
    hp: 80,
    combat: { melee: 0.6, ranged: { range: 5, every: 14, damage: [8, 14] } },
  },
};

// --------------------------------------------------------------- buildings

/**
 * A workshop turns `inputs` (all of them) plus one unit of any of `inputsAnyOf` into `outputs`
 * every `ticks` while its worker is inside. `inputsAnyOf` share one input pile limit.
 */
export interface Recipe {
  inputs: Partial<Stock>;
  inputsAnyOf?: readonly Resource[];
  outputs: Partial<Stock>;
  /** Instead of fixed outputs: one unit of whichever of these the owner needs most (see `chooseOutput`). */
  outputChoice?: readonly Resource[];
  /** With `outputChoice`: keep at least this many of each in stock; beyond that, only make what is awaited. */
  keepInStock?: number;
  ticks: number;
}

/** Build-menu tab. */
export type Category = 'housing' | 'resources' | 'food' | 'mining' | 'metal' | 'military';

export const CATEGORIES: Record<Category, string> = {
  housing: 'Поселение',
  resources: 'Сырьё',
  food: 'Еда',
  mining: 'Горное дело',
  metal: 'Металл',
  military: 'Военное',
};

export interface BuildingDef {
  name: string;
  w: number;
  h: number;
  /** Materials needed to construct. */
  cost: Partial<Stock>;
  worker: SettlerKind | null;
  playerBuildable: boolean;
  category?: Category;
  /** Warehouse: accepts any goods and supplies them back. */
  storage?: boolean;
  recipe?: Recipe;
  /** Territory radius (tiles from the building center); claimed once staffed, or when done if no worker. */
  territory?: number;
  /** Residence: releases `capacity` new carriers, one every `everyTicks`, once built. */
  residence?: { capacity: number; everyTicks: number };
  /** Military building (see `GarrisonDef`). */
  garrison?: GarrisonDef;
  /** Footprint terrain: ordinary buildings need grass, mines need mountain. */
  terrain?: 'mountain';
  /** Mine: each recipe cycle also takes one unit of ore of this resource from a tile within `radius`. */
  mine?: { res: Resource; radius: number };
  /**
   * Barracks: its worker is a recruit who, given a weapon from the building's pile, trains for
   * `ticks` and leaves as the fighter whose tool that weapon is. The only way to raise new fighters.
   */
  barracks?: { ticks: number };
}

/**
 * Military building: holds up to `capacity` soldiers and claims `territory` while at least one is
 * inside, or always if `claimsWhenEmpty` (the castle).
 */
export interface GarrisonDef {
  capacity: number;
  claimsWhenEmpty?: boolean;
  /** Soldiers it never gives away to man other buildings or to attack (default `GARRISON_KEEP`). */
  keep?: number;
  /** Slots meant for archers; recruiting and transfers fill them with archers first. */
  archers?: number;
  /** Defenders fighting at its door are this much stronger. */
  defense?: number;
  /** Gold delivered here promotes the soldiers inside. */
  trains?: boolean;
}

function mine(name: string, res: Resource): BuildingDef {
  return {
    name,
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 1 },
    worker: 'miner',
    playerBuildable: true,
    category: 'mining',
    terrain: 'mountain',
    mine: { res, radius: 3 },
    recipe: { inputs: {}, inputsAnyOf: MINER_FOOD, outputs: { [res]: 1 }, ticks: 80 },
  };
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  castle: {
    name: 'Замок',
    w: 3,
    h: 3,
    cost: {},
    worker: null,
    playerBuildable: false,
    storage: true,
    territory: 10,
    garrison: { capacity: 12, claimsWhenEmpty: true, keep: 4, archers: 4, defense: 1.5, trains: true },
  },

  house_small: {
    name: 'Малый дом',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 1 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 4, everyTicks: 150 },
  },
  house_medium: {
    name: 'Средний дом',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 8, everyTicks: 120 },
  },
  house_large: {
    name: 'Большой дом',
    w: 3,
    h: 3,
    cost: { plank: 5, stone: 4 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 14, everyTicks: 100 },
  },

  warehouse: {
    name: 'Склад',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    storage: true,
  },

  woodcutter: {
    name: 'Дом лесоруба',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'woodcutter',
    playerBuildable: true,
    category: 'resources',
  },
  forester: {
    name: 'Дом лесничего',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'forester',
    playerBuildable: true,
    category: 'resources',
  },
  sawmill: {
    name: 'Лесопилка',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'sawmiller',
    playerBuildable: true,
    category: 'resources',
    recipe: { inputs: { log: 1 }, outputs: { plank: 1 }, ticks: 50 },
  },
  stonecutter: {
    name: 'Каменотёс',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'stonecutter',
    playerBuildable: true,
    category: 'resources',
  },

  waterworks: {
    name: 'Водокачка',
    w: 2,
    h: 2,
    cost: { plank: 2 },
    worker: 'waterman',
    playerBuildable: true,
    category: 'food',
  },
  fisher: { name: 'Рыбак', w: 2, h: 2, cost: { plank: 2 }, worker: 'fisher', playerBuildable: true, category: 'food' },
  farm: {
    name: 'Ферма',
    w: 3,
    h: 3,
    cost: { plank: 3, stone: 1 },
    worker: 'farmer',
    playerBuildable: true,
    category: 'food',
  },
  mill: {
    name: 'Мельница',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'miller',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { grain: 1 }, outputs: { flour: 1 }, ticks: 60 },
  },
  bakery: {
    name: 'Пекарня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'baker',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { flour: 1, water: 1 }, outputs: { bread: 1 }, ticks: 60 },
  },
  pigfarm: {
    name: 'Свиноферма',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 1 },
    worker: 'pigfarmer',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { grain: 1, water: 1 }, outputs: { pig: 1 }, ticks: 120 },
  },
  slaughterhouse: {
    name: 'Бойня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'butcher',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { pig: 1 }, outputs: { meat: 2 }, ticks: 60 },
  },

  coalmine: mine('Угольная шахта', 'coal'),
  ironmine: mine('Железный рудник', 'ironore'),
  goldmine: mine('Золотой рудник', 'goldore'),
  stonemine: mine('Каменоломня в горе', 'stone'),

  ironsmelter: {
    name: 'Плавильня железа',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { ironore: 1, coal: 1 }, outputs: { iron: 1 }, ticks: 70 },
  },
  goldsmelter: {
    name: 'Плавильня золота',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { goldore: 1, coal: 1 }, outputs: { gold: 1 }, ticks: 70 },
  },
  toolsmith: {
    name: 'Инструментальщик',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'toolsmith',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { iron: 1, coal: 1 }, outputs: {}, outputChoice: TOOLS, keepInStock: 2, ticks: 80 },
  },

  weaponsmith: {
    name: 'Оружейник',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'weaponsmith',
    playerBuildable: true,
    category: 'military',
    // Swords and bows, whichever garrisons are waiting for (`waitingFor`), keeping a small stock.
    recipe: { inputs: { iron: 1, coal: 1 }, outputs: {}, outputChoice: ['sword', 'bow'], keepInStock: 3, ticks: 80 },
  },
  tower: {
    name: 'Сторожевая башня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    territory: 8,
    garrison: { capacity: 3, keep: 1, archers: 1, defense: 1.2 },
  },
  bigtower: {
    name: 'Большая башня',
    w: 2,
    h: 2,
    cost: { plank: 4, stone: 6 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    territory: 11,
    garrison: { capacity: 6, keep: 2, archers: 2, defense: 1.35, trains: true },
  },
  barracks: {
    name: 'Казарма',
    w: 2,
    h: 2,
    cost: { plank: 4, stone: 3 },
    worker: 'recruit',
    playerBuildable: true,
    category: 'military',
    barracks: { ticks: 60 },
  },
  fortress: {
    name: 'Крепость',
    w: 3,
    h: 3,
    cost: { plank: 6, stone: 10, iron: 2 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    territory: 14,
    garrison: { capacity: 12, keep: 3, archers: 4, defense: 1.5, trains: true },
  },
};

/** Fills the missing resources of a partial stock with zeros. */
export function fullStock(partial: Partial<Stock>): Stock {
  return { ...emptyStock(), ...partial };
}

export function costOf(type: BuildingType): Stock {
  return fullStock(BUILDINGS[type].cost);
}

/** Total material units, i.e. how many work shifts the building takes. */
export function totalCost(type: BuildingType): number {
  return Object.values(BUILDINGS[type].cost).reduce((sum, n) => sum + (n ?? 0), 0);
}

/** What the building's own worker gathers, if it is a gatherer's hut. */
export function gatheredBy(type: BuildingType): GatherDef | undefined {
  const worker = BUILDINGS[type].worker;
  return worker ? PROFESSIONS[worker].gather : undefined;
}

// ------------------------------------------------------------ computer players

/**
 * Computer player build order. Each think the AI walks this list top to bottom and places the first
 * entry whose `count` (sites included) is not reached yet and that it can afford, staff and site.
 * Entries it cannot satisfy right now are skipped, so the plan adapts to the map. `after`: only once
 * a building of that type stands (keeps scarce tools and food for what unlocks the chain).
 */
export const AI_PLAN: readonly { type: BuildingType; count: number; after?: BuildingType }[] = [
  { type: 'woodcutter', count: 1 },
  { type: 'stonecutter', count: 1 },
  { type: 'sawmill', count: 1 },
  { type: 'forester', count: 1 },
  { type: 'house_small', count: 1 },
  { type: 'woodcutter', count: 2 },
  { type: 'tower', count: 1 },
  { type: 'sawmill', count: 2 },
  { type: 'farm', count: 1 },
  { type: 'waterworks', count: 1 },
  { type: 'tower', count: 2 },
  { type: 'mill', count: 1 },
  { type: 'bakery', count: 1 },
  { type: 'fisher', count: 1 },
  { type: 'house_medium', count: 1 },
  { type: 'tower', count: 3 },
  { type: 'coalmine', count: 1 },
  { type: 'ironmine', count: 1, after: 'coalmine' },
  { type: 'ironsmelter', count: 1, after: 'ironmine' },
  { type: 'toolsmith', count: 1, after: 'ironsmelter' },
  { type: 'weaponsmith', count: 1, after: 'ironsmelter' },
  { type: 'barracks', count: 1, after: 'weaponsmith' },
  { type: 'goldmine', count: 1, after: 'toolsmith' },
  { type: 'goldsmelter', count: 1, after: 'goldmine' },
  { type: 'pigfarm', count: 1 },
  { type: 'slaughterhouse', count: 1, after: 'pigfarm' },
  { type: 'farm', count: 2 },
  { type: 'house_medium', count: 2 },
  { type: 'coalmine', count: 2, after: 'toolsmith' },
  { type: 'stonemine', count: 1, after: 'toolsmith' },
  { type: 'tower', count: 4 },
  { type: 'forester', count: 2 },
  { type: 'woodcutter', count: 3 },
  { type: 'stonecutter', count: 2, after: 'toolsmith' },
  { type: 'house_large', count: 1 },
  { type: 'ironmine', count: 2, after: 'toolsmith' },
  { type: 'weaponsmith', count: 2, after: 'ironsmelter' },
  { type: 'bigtower', count: 1, after: 'weaponsmith' },
  { type: 'tower', count: 7 },
  { type: 'house_large', count: 2 },
  { type: 'bigtower', count: 3, after: 'weaponsmith' },
  { type: 'fortress', count: 1, after: 'goldsmelter' },
  { type: 'tower', count: 12 },
];

/** Computer player tuning; `thinkEvery` and `attackRatio` are the difficulty knobs. */
export const AI = {
  /** Ticks between decisions (lower = faster, harder). */
  thinkEvery: 40,
  /** At most this many own construction sites at once. */
  maxOpenSites: 3,
  /** Build a house when fewer carriers than this are idle. */
  minIdleCarriers: 3,
  /** Attack when spare attackers ≥ attackRatio × defenders + 1, and at least `minAttackers`. */
  attackRatio: 1.2,
  minAttackers: 3,
  /** Fighters kept home beyond the castle's own `keep`: new military buildings are only placed if they can be manned without going below. */
  homeGuard: 0,
  /** No attacks before this tick (25 game minutes): the opening is for building up. */
  peaceTicks: 25 * 60 * TICKS_PER_SECOND,
  /** Ticks between attacks. */
  attackCooldown: 600,
  /** With at least this many soldiers and no enemy in reach, build military buildings towards the enemy… */
  frontierSoldiers: 8,
  /** …up to this many military buildings in total. */
  maxMilitary: 30,
  /** While it knows no enemy, how strongly towers lean towards the map center (per tile). */
  scoutCenter: 1,
  /** Defenders it assumes in an enemy building out of its buildings' sight, as a share of the capacity. */
  unseenGarrison: 0.5,
  /** Gathered resources that do not grow back: their gatherers are moved once nothing is left in range. */
  exhaustible: ['stone'] as readonly Resource[],
  /** Best-scored spots tried with `canPlace` per placement. */
  placeTries: 40,
  /** The last this-many units of a tool are kept for the first building of a type that needs it. */
  keepTools: 1,
  /** Its army make-up (weights for `World.setShare`): mostly swordsmen, archers for the towers. */
  weaponShares: { sword: 65, bow: 35 } as Partial<Record<Resource, number>>,
};

// ---------------------------------------------------------------- wild animals

/** Where an animal lives: open grass, grass at a forest's edge, or water edges (shallow water too). */
export type Habitat = 'meadow' | 'forest' | 'shore';

/**
 * Wild animals (see `animals.ts`): owner-less, wandering in herds around a home spot. Data only, so a
 * new animal is an entry here plus its sprites. `herds` is per 64×64 of map, scaled by area.
 */
export interface AnimalDef {
  name: string;
  habitat: Habitat;
  /** Tiles per tick while moving. */
  speed: number;
  /** Members per herd, inclusive range. */
  herd: [number, number];
  herds: number;
  /** How far (tiles) members roam from the herd's home. */
  roam: number;
  /** Ticks resting (grazing) between legs, inclusive range. */
  rest: [number, number];
}

export const ANIMALS = {
  deer: { name: 'Олень', habitat: 'forest', speed: 0.055, herd: [2, 4], herds: 2, roam: 6, rest: [30, 120] },
  donkey: { name: 'Осёл', habitat: 'meadow', speed: 0.03, herd: [1, 3], herds: 1, roam: 5, rest: [60, 200] },
  duck: { name: 'Утка', habitat: 'shore', speed: 0.025, herd: [2, 5], herds: 2, roam: 4, rest: [20, 90] },
  chicken: { name: 'Курица', habitat: 'meadow', speed: 0.03, herd: [3, 6], herds: 1, roam: 3, rest: [10, 60] },
} satisfies Record<string, AnimalDef>;

export type AnimalKind = keyof typeof ANIMALS;
export const ANIMAL_KINDS = Object.keys(ANIMALS) as AnimalKind[];
/** Herds keep at least this far (tiles) from every start position. */
export const ANIMAL_START_CLEARANCE = 16;
