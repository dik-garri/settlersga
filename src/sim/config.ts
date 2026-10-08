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

/**
 * Tiles per tick on open ground. Settlers 4 (decompiled `ISettlerRole`): every settler takes 9 game
 * ticks per tile at 845 ticks a minute, i.e. 1.56 tiles/s; a settler is about as tall relative to a
 * tile there as here, so the same number of tiles per second (`docs/TIMINGS.md`).
 */
export const SETTLER_SPEED = 0.156;

/**
 * Work ticks one builder spends per material unit. Settlers 4 (`CBuildingSiteRole::AddWork`): every
 * unit is 200 work, a builder adds one per game tick — 14.2 s per unit and builder; several builders
 * on one site (`buildersOf`) add up.
 */
export const BUILD_TICKS_PER_UNIT = 142;
export const HANDLE_TICKS = 3;

/** Pile limits at a workplace door, per resource: every good a building uses or makes, up to this many units each. */
export const OUTPUT_CAP = 8;
export const INPUT_CAP = 8;

export const DISPATCH_EVERY = 5;
/** A free settler stands where its last job ended this long before it walks off to an idle crowd. */
export const IDLE_GO_HOME_TICKS = 30;

/**
 * Idle crowds (`idle.ts`): as in Settlers 4, free carriers (and builders and diggers without a site)
 * do not disappear into a warehouse but stand about outside in small groups — near warehouses, the
 * castle and houses — strolling a little and chatting in pairs, always ready for the dispatcher.
 */
export const IDLE = {
  /** How far from the gathering building's door (tiles) idle settlers stand. */
  radius: 3,
  /** At most this many idle settlers gather at one building before the next one is chosen. */
  groupSize: 5,
  /** Ticks between strolls: a random value in [min, max]. */
  strollEvery: [60, 180] as [number, number],
  /** Chance that a stroll goes to stand next to another idle settler of the group, to chat. */
  chatChance: 0.45,
  /** Random spots tried per stroll before giving up until the next one. */
  tries: 6,
  /** Building kinds idle settlers gather at (as BuildingDef flags). */
  gatherAt: ['storage', 'residence'] as ('storage' | 'residence')[],
};
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
 * Fighter levels, as in Settlers 4: chosen when the barracks trains a recruit and fixed for life.
 * Hit points and damage are relative to level 0; `cost` units of `LEVEL_RES` are paid at recruitment
 * on top of the weapon (level 1 is the weapon alone).
 */
export const SOLDIER_LEVELS: readonly { hp: number; damage: number; cost: number }[] = [
  { hp: 1, damage: 1, cost: 0 },
  { hp: 1.3, damage: 1.3, cost: 1 },
  { hp: 1.6, damage: 1.6, cost: 2 },
];
export const LEVEL_RES: Resource = 'gold';
/** A fighter below this share of his hit points, idle in a garrison, goes to an infirmary if one has a bed. */
export const WOUNDED_AT = 0.6;
/** Garrisons look for wounded to send to an infirmary this often (ticks). */
export const WOUNDED_CHECK_EVERY = 20;
/** Visual only: ticks an arrow is drawn in flight. */
export const SHOT_TICKS = 5;
/**
 * Default army make-up per player (weights, see `World.setShare`): the weaponsmith forges and the
 * barracks trains towards these proportions of fighters by weapon.
 */
export const OUTPUT_SHARES: Partial<Record<Resource, number>> = { sword: 60, bow: 40, armor: 8 };
/** A barracks only takes a recruit while the player keeps at least this many idle carriers. */
export const BARRACKS_MIN_IDLE = 2;
export const START_BUILDERS = 3;
/** Diggers at the start: every site is cleared by one before the builders start (as in Settlers 4). */
export const START_DIGGERS = 2;
/** Spade strokes (one per `DIG_EVERY` ticks) to clear one footprint tile, on top of any levelling. */
export const CLEAR_STROKES_PER_TILE = 6;
/**
 * Diggers one site takes at once, as in Settlers 4 (`CBuildingSiteRole::SetDiggingInfos`): one more
 * per `DIG_STROKES_PER_DIGGER` spade strokes still to do (levelling steps plus clearing), at most
 * `MAX_DIGGERS`.
 */
export const DIG_STROKES_PER_DIGGER = 32;
export const MAX_DIGGERS = 8;
export const START_PLANKS = 20;
export const START_STONE = 10;
/** Tools in the castle at the start, enough for the first workplaces. */
export const START_TOOLS: Partial<Stock> = { axe: 3, saw: 2, pickaxe: 4, shovel: 2, scythe: 2, rod: 2, hammer: 2 };

/**
 * Start conditions, chosen before a free game as in Settlers 4 (low, medium or high start goods).
 * `medium` is the classic start above. Amounts approximate the original's proportions: low leaves
 * the bare minimum to found an economy, high adds food and metal so mines and smiths run at once.
 */
export type StartLevel = 'low' | 'medium' | 'high';
export interface StartDef {
  name: string;
  goods: Partial<Stock>;
  carriers: number;
  builders: number;
  diggers: number;
  soldiers: number;
}
export const START_CONDITIONS: Record<StartLevel, StartDef> = {
  low: {
    name: 'Мало',
    goods: { plank: 12, stone: 6, axe: 2, saw: 1, pickaxe: 2, shovel: 1, scythe: 1, rod: 1, hammer: 1 },
    carriers: 8,
    builders: 2,
    diggers: 1,
    soldiers: 3,
  },
  medium: {
    name: 'Средне',
    goods: { plank: START_PLANKS, stone: START_STONE, ...START_TOOLS },
    carriers: START_CARRIERS,
    builders: START_BUILDERS,
    diggers: START_DIGGERS,
    soldiers: START_SOLDIERS,
  },
  high: {
    name: 'Много',
    goods: {
      plank: 45, stone: 30, log: 10,
      bread: 10, fish: 10, meat: 10, coal: 12, ironore: 8, iron: 6, gold: 2,
      axe: 5, saw: 3, pickaxe: 6, shovel: 4, scythe: 3, rod: 3, hammer: 4, sword: 4, bow: 2,
    },
    carriers: 24,
    builders: 5,
    diggers: 3,
    soldiers: 10,
  },
};

/**
 * Workers the player orders (as in Settlers 4 builders and diggers are made from free settlers, with
 * a tool, only as many as ordered); the defaults equal the start's, so nothing is recruited unasked.
 * `World.orderWorkers` changes them.
 */
export const ORDERABLE: readonly SettlerKind[] = ['builder', 'digger', 'pioneer', 'thief'];

/**
 * Specialists (Settlers 4), ordered like workers and sent on errands (`specialists.ts`):
 * - pioneer: claims neutral tiles next to his owner's land within `radius` of where he was sent, one
 *   every `claimTicks` ticks of work, up to `maxTiles` per errand; land a military building claims
 *   always wins over his (`recomputeTerritory`);
 * - thief: robs a foreign building's door pile or stock (`stealTicks` of work, one unit of its most
 *   plentiful good) and carries it home. How intruders are met is `INTRUDERS`.
 */
export const PIONEER = { radius: 4, claimTicks: 40, maxTiles: 24 };
export const THIEF = { stealTicks: 30 };

/** Work areas (`workArea.ts`): a moved centre may lie at most `maxShift` × the work radius from the door. */
export const WORK_AREA = { maxShift: 1.5 };

/**
 * Specialists on hostile land, as in Settlers 4 (Settlers United wiki, units/thief: «thieves attract
 * swordsmen upon entering enemy territory, like all specialists do»; «thieves are decloaked if a
 * military unit comes too close»; a thief has 20 HP). `intruders.ts`: every `scanEvery` ticks each
 * specialist (`SPECIALIST_KINDS`) standing on land of a player who is neither his own nor an ally is
 * an intruder for that player. A `cloaked` profession (the thief) is no target until an outdoor fighter
 * of that player — or a garrisoned building of his whose door — is within `decloakRadius`; then he stays
 * exposed for `exposedTicks`. For each exposed intruder that fewer than `responders` fighters are
 * already chasing, the nearest own military building whose door is within `respondRadius` sends a melee
 * fighter it can spare (above `keep`; field units nearby engage on their own, `FIELD.engageRadius`, and
 * field archers shoot). The responder runs the `chase` task: walks up; within `seizeRadius` the
 * intruder is caught and stands (`opponent` — a specialist cannot outrun a swordsman, and walking at the
 * same pace he otherwise never would be reached); adjacent, the fighter strikes every `FIGHT_EVERY`
 * ticks with ordinary blows — specialists do not fight back — until the intruder dies (his load is
 * lost) or is off that player's land; then the fighter looks for a garrison again. Radii and timings
 * are our approximations: the wiki gives no numbers.
 */
export const INTRUDERS = { scanEvery: 10, decloakRadius: 3, exposedTicks: 300, respondRadius: 12, responders: 1, seizeRadius: 3 };

/**
 * Fighting strength, after Settlers 4 (settlers-united wiki, «fighting strength calculation»): a
 * player's settlement value is the wood (planks, logs) and stone built into their finished buildings
 * at `points` each, gold at `goldPoints`, eyecatchers' materials `eyecatcher` times over. Attack
 * strength starts at `start` per cent (fewer players, more — `perPlayer` less per player beyond one,
 * never below `min`) and rises with value along `steps` (`[up to %, value points per 1 %]`, diminishing
 * returns) up to `max`. Fighters on their own (or an ally's) land always fight at 100 %; on foreign
 * land at the attack strength. Defence equals 100 % until attack strength passes it, then grows at
 * half its pace. Our buildings are much cheaper than S4's, hence `points` above one.
 */
export const STRENGTH = {
  points: 3,
  goldPoints: 6,
  eyecatcher: 3,
  start: 55,
  perPlayer: 5,
  min: 25,
  max: 150,
  steps: [
    [50, 10],
    [100, 20],
    [125, 40],
    [150, 80],
  ] as readonly (readonly [number, number])[],
};
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
  armor: { name: 'Доспехи', group: 'military' },
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
/**
 * A digger moves one corner by one pixel towards the site's level (or makes one clearing stroke)
 * every this many ticks: one stroke per loop of the spade animation (`ACTIONS.dig`, 0.82 s), as
 * Settlers 4 changes one height step per spade animation cycle (its length is in no source we
 * have, `docs/TIMINGS.md`).
 */
export const DIG_EVERY = 8;
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
    // Impassable, as in Settlers 4; generation keeps land connected across it (`connectAcrossSwamps`).
    walkable: false,
    build: null,
    plantable: false,
    speed: 1,
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
  | 'hunt'
  | 'digger'
  | 'pioneer'
  | 'thief'
  | 'donkey';

export interface GatherDef {
  res: Resource;
  radius: number;
  workTicks: number;
  restTicks: number;
}

/** A hunter: stalks game (`AnimalDef.game`) within `radius` of the lodge, shoots it from `range`. */
export interface HuntDef {
  radius: number;
  range: number;
  /** Ticks aiming once in range. */
  workTicks: number;
  restTicks: number;
  /** Times he closes in again on game that walked off before giving up. */
  chases: number;
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
  /** Can take an empty enemy building (in Settlers 4 only swordsmen do; archers support). */
  captures?: boolean;
  /**
   * Squad leader (Settlers 4): own fighters within `radius` tiles of him (himself included) fight with
   * `morale` × chance and damage, and soldiers ordered out with him follow him as a squad (`field.ts`).
   */
  leads?: { radius: number; morale: number };
}

export interface ProfessionDef {
  name: string;
  behavior: Behavior;
  /** Hit points at level 0 when taking up the profession (fighters; specialists, see `INTRUDERS`). */
  hp?: number;
  /** Disguised on hostile land until a fighter of that land comes close (the thief, `INTRUDERS`). */
  cloaked?: boolean;
  combat?: CombatDef;
  /** Walking speed relative to `SETTLER_SPEED` (Settlers 4: the squad leader rides, 9 ticks a tile against 7). */
  speed?: number;
  /** Walks faster on worn paths and roads (`PATHS`); in Settlers 4 only carriers and donkeys do. */
  roads?: boolean;
  /** Tool a carrier must fetch from storage to take up the profession (it is used up). */
  tool?: Resource;
  /** Further goods a barracks consumes to make this fighter, besides `tool` (the squad leader's sword). */
  kit?: Partial<Stock>;
  gather?: GatherDef;
  plant?: PlantDef;
  hunt?: HuntDef;
}

export const PROFESSIONS: Record<SettlerKind, ProfessionDef> = {
  carrier: { name: 'Носильщик', behavior: 'carrier', roads: true },
  builder: { name: 'Строитель', behavior: 'builder', tool: 'hammer' },
  digger: { name: 'Землекоп', behavior: 'digger', tool: 'shovel' },
  woodcutter: { name: 'Лесоруб', behavior: 'gather', tool: 'axe', gather: { res: 'log', radius: 8, workTicks: 250, restTicks: 300 } },
  stonecutter: {
    name: 'Каменотёс',
    behavior: 'gather',
    tool: 'pickaxe',
    gather: { res: 'stone', radius: 8, workTicks: 200, restTicks: 150 },
  },
  forester: {
    name: 'Лесничий',
    behavior: 'plant',
    plant: { what: 'tree', radius: 6, workTicks: 120, restTicks: 130 },
  },
  waterman: { name: 'Водонос', behavior: 'gather', gather: { res: 'water', radius: 7, workTicks: 40, restTicks: 40 } },
  fisher: { name: 'Рыбак', behavior: 'gather', tool: 'rod', gather: { res: 'fish', radius: 8, workTicks: 150, restTicks: 100 } },
  farmer: {
    name: 'Фермер',
    behavior: 'farm',
    tool: 'scythe',
    gather: { res: 'grain', radius: 5, workTicks: 80, restTicks: 70 },
    plant: { what: 'grain', radius: 5, workTicks: 60, restTicks: 70, maxNearby: 10 },
  },
  /** As in Settlers 4 the hunter uses a bow (forged by the weaponsmith). */
  hunter: {
    name: 'Охотник',
    behavior: 'hunt',
    tool: 'bow',
    hunt: { radius: 12, range: 3.5, workTicks: 40, restTicks: 500, chases: 4 },
  },
  sawmiller: { name: 'Пильщик', behavior: 'workshop', tool: 'saw' },
  miller: { name: 'Мельник', behavior: 'workshop' },
  baker: { name: 'Пекарь', behavior: 'workshop' },
  pigfarmer: { name: 'Свинопас', behavior: 'workshop' },
  butcher: { name: 'Мясник', behavior: 'workshop', tool: 'axe' },
  miner: { name: 'Шахтёр', behavior: 'workshop', tool: 'pickaxe' },
  smelter: { name: 'Плавильщик', behavior: 'workshop' },
  toolsmith: { name: 'Инструментальщик', behavior: 'workshop' },
  /**
   * Carries a hammer on his errand and brings it back (see `World.sendGeologist`). Specialists' `hp`
   * is on the soldiers' scale (a swordsman 100): the thief's 20 is Settlers 4's; the geologist's and
   * pioneer's are our approximation (no source gives them).
   */
  geologist: { name: 'Геолог', behavior: 'prospect', tool: 'hammer', hp: 20 },
  weaponsmith: { name: 'Оружейник', behavior: 'workshop' },
  /** Specialists (`ORDERABLE`, `specialists.ts`). */
  pioneer: { name: 'Первопроходец', behavior: 'pioneer', tool: 'shovel', hp: 20 },
  /** Disguised: no target on hostile land until a fighter of that land comes close (`INTRUDERS`). */
  thief: { name: 'Вор', behavior: 'thief', hp: 20, cloaked: true },
  donkeyrancher: { name: 'Погонщик', behavior: 'workshop' },
  donkey: { name: 'Осёл', behavior: 'donkey', roads: true },
  recruit: { name: 'Новобранец', behavior: 'workshop' },
  soldier: { name: 'Мечник', behavior: 'soldier', tool: 'sword', hp: 100, combat: { melee: 1, captures: true } },
  archer: {
    name: 'Лучник',
    behavior: 'soldier',
    tool: 'bow',
    hp: 80,
    combat: { melee: 0.6, ranged: { range: 5, every: 14, damage: [8, 14] } },
  },
  /**
   * Squad leader, as in Settlers 4: made in the barracks from armour and a sword (plus the gold of his
   * level), a strong swordsman whose presence lifts the fighters around him (`combat.leads`).
   */
  leader: {
    name: 'Командир',
    behavior: 'soldier',
    tool: 'armor',
    kit: { sword: 1 },
    hp: 130,
    speed: 9 / 7,
    combat: { melee: 1.25, captures: true, leads: { radius: 6, morale: 1.15 } },
  },
};

/**
 * Field units (direct army control, `field.ts`): a fighter on a field post engages enemy fighters
 * within `engageRadius` tiles (archers shoot within their range instead), looks around every
 * `scanEvery` ticks, gives up a chase beyond `chaseLimit` tiles from his post, and walks back to the
 * post once more than `slack` tiles from it. `formation`: tiles between neighbours of a formation.
 */
export const FIELD = { engageRadius: 4, scanEvery: 5, chaseLimit: 7, slack: 1.5, formation: 1 };

// --------------------------------------------------------------- buildings

/**
 * A workshop turns `inputs` (all of them) plus one unit of any of `inputsAnyOf` into `outputs`
 * every `ticks` while its worker is inside. Each input, `inputsAnyOf` alternatives included, has its own pile limit.
 */
export interface Recipe {
  inputs: Partial<Stock>;
  inputsAnyOf?: readonly Resource[];
  outputs: Partial<Stock>;
  /** Instead of fixed outputs: one unit of whichever of these the owner needs most (see `chooseOutput`). */
  outputChoice?: readonly Resource[];
  /** With `outputChoice`: keep at least this many of each in stock; beyond that, only make what is awaited. */
  keepInStock?: number;
  /** With `outputChoice`: the player can queue outputs (`World.orderTool`); orders go first. */
  orderable?: boolean;
  ticks: number;
}

/** Build-menu tab. */
export type Category = 'housing' | 'resources' | 'food' | 'mining' | 'metal' | 'military' | 'trade' | 'decor';

export const CATEGORIES: Record<Category, string> = {
  housing: 'Поселение',
  resources: 'Сырьё',
  food: 'Еда',
  mining: 'Горное дело',
  metal: 'Металл',
  military: 'Военное',
  trade: 'Торговля',
  decor: 'Украшения',
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
  /**
   * Residence: releases `capacity` residents as carriers, one every `everyTicks`, once built — the
   * same on every map size, as in Settlers 4 (small/medium/large house: 10/20/50).
   */
  residence?: { capacity: number; everyTicks: number };
  /** Military building (see `GarrisonDef`). */
  garrison?: GarrisonDef;
  /** Footprint terrain: ordinary buildings need grass, mines need mountain. */
  terrain?: 'mountain';
  /** Mine: each recipe cycle also takes one unit of ore of this resource from a tile within `radius`. */
  mine?: { res: Resource; radius: number; favourite: Resource };
  /**
   * Barracks: its worker is a recruit who, given a weapon from the building's pile, trains for
   * `ticks` and leaves as the fighter whose tool that weapon is, at the level the player ordered
   * (`SOLDIER_LEVELS[k].cost` gold from the pile). The only way to raise new fighters.
   */
  barracks?: { ticks: number };
  /** Sees this far (tiles from the center) once built, instead of its territory (lookout tower). */
  vision?: number;
  /**
   * Infirmary: wounded fighters (below `WOUNDED_AT` of their hit points) walk here from garrisons
   * within `range`, take one of `beds`, regain a hit point every `healEvery` ticks and go back.
   */
  infirmary?: { beds: number; healEvery: number; range: number };
  /** Eyecatcher (decoration): no worker, no territory; its materials count extra in the owner's settlement value (`STRENGTH`). */
  eyecatcher?: boolean;
  /** Marketplace: starting point of donkey caravans to another marketplace (`trade.ts`). */
  market?: boolean;
  /** Each completed recipe cycle releases one settler of this kind (the donkey ranch breeds donkeys). */
  breeds?: SettlerKind;
}

/**
 * Military building: holds up to `capacity` soldiers and claims `territory` while at least one is
 * inside, or always if `claimsWhenEmpty` (the castle). Slots have a kind, as in Settlers 4:
 * `archers` of them are for ranged fighters, the rest for melee ones.
 */
export interface GarrisonDef {
  capacity: number;
  claimsWhenEmpty?: boolean;
  /** Soldiers it never gives away to man other buildings or to attack (default `GARRISON_KEEP`). */
  keep?: number;
  /** Slots for archers; the other `capacity − archers` slots are for swordsmen. */
  archers?: number;
  /** Defenders fighting at its door are this much stronger. */
  defense?: number;
}

/**
 * Mining as in Settlers 4: a food unit buys digging attempts — `favourite` of the mine `attempts.favourite`,
 * any other `attempts.other`. Each attempt picks an ore tile in range; it yields one unit for sure
 * while the tile holds at least `sureAmount`, else with `chancePerUnit` × units left.
 */
export const MINING = { attempts: { favourite: 10, other: 2 }, sureAmount: 4, chancePerUnit: 0.25 };

/**
 * Trade over land, after Settlers 4: a donkey carries up to `donkeyLoad` units of one good per trip
 * from a marketplace to the market its route names; a donkey ranch breeds donkeys while the player
 * has fewer than `donkeysPerMarket` per finished marketplace. An endless order keeps `stock` units of
 * the good waiting at the market.
 */
export const TRADE = { donkeyLoad: 4, donkeysPerMarket: 3, stock: 8 };

function mine(name: string, res: Resource, favourite: Resource): BuildingDef {
  return {
    name,
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 1 },
    worker: 'miner',
    playerBuildable: true,
    category: 'mining',
    terrain: 'mountain',
    mine: { res, radius: 3, favourite },
    recipe: { inputs: {}, inputsAnyOf: MINER_FOOD, outputs: { [res]: 1 }, ticks: 80 },
  };
}

/**
 * Recipe and gathering times follow Settlers 4 in real seconds at normal speed (10 ticks here = 1 s;
 * the original runs 845 ticks a minute): the Roman buildings' ticks per product, measured by the
 * Settlers United wiki, and the professions' cycles from siedlercommunity.de — table and sources
 * in `docs/TIMINGS.md`.
 */
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
    // The headquarters: the army's reserve (S4 has no such building; 7 swordsmen + 5 archers).
    garrison: { capacity: 12, claimsWhenEmpty: true, keep: 4, archers: 5, defense: 1.5 },
  },

  house_small: {
    name: 'Малый дом',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 1 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 10, everyTicks: 150 },
  },
  house_medium: {
    name: 'Средний дом',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 20, everyTicks: 120 },
  },
  house_large: {
    name: 'Большой дом',
    w: 3,
    h: 3,
    cost: { plank: 5, stone: 4 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 50, everyTicks: 100 },
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
    recipe: { inputs: { log: 1 }, outputs: { plank: 1 }, ticks: 192 },
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
  hunter: { name: 'Охотник', w: 2, h: 2, cost: { plank: 2 }, worker: 'hunter', playerBuildable: true, category: 'food' },
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
    recipe: { inputs: { grain: 1 }, outputs: { flour: 1 }, ticks: 133 },
  },
  bakery: {
    name: 'Пекарня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'baker',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { flour: 1, water: 1 }, outputs: { bread: 1 }, ticks: 347 },
  },
  pigfarm: {
    name: 'Свиноферма',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 1 },
    worker: 'pigfarmer',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { grain: 1, water: 1 }, outputs: { pig: 1 }, ticks: 399 },
  },
  // Settlers 4 town buildings: carriers stay on their own land, donkeys carry goods between markets.
  market: {
    name: 'Рынок',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 4 },
    worker: null,
    playerBuildable: true,
    category: 'trade',
    market: true,
  },
  donkeyranch: {
    name: 'Ослиная ферма',
    w: 2,
    h: 2,
    cost: { plank: 4, stone: 5 },
    worker: 'donkeyrancher',
    playerBuildable: true,
    category: 'trade',
    recipe: { inputs: { grain: 1, water: 1 }, outputs: {}, ticks: 192 },
    breeds: 'donkey',
  },
  slaughterhouse: {
    name: 'Бойня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'butcher',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { pig: 1 }, outputs: { meat: 2 }, ticks: 252 },
  },

  // Favourite foods as in Settlers 4: coal and stone bread, iron (and sulfur) meat, gold fish.
  coalmine: mine('Угольная шахта', 'coal', 'bread'),
  ironmine: mine('Железный рудник', 'ironore', 'meat'),
  goldmine: mine('Золотой рудник', 'goldore', 'fish'),
  stonemine: mine('Каменоломня в горе', 'stone', 'bread'),

  ironsmelter: {
    name: 'Плавильня железа',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { ironore: 1, coal: 1 }, outputs: { iron: 1 }, ticks: 201 },
  },
  goldsmelter: {
    name: 'Плавильня золота',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { goldore: 1, coal: 1 }, outputs: { gold: 1 }, ticks: 214 },
  },
  toolsmith: {
    name: 'Инструментальщик',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'toolsmith',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { iron: 1, coal: 1 }, outputs: {}, outputChoice: TOOLS, keepInStock: 2, orderable: true, ticks: 219 },
  },

  weaponsmith: {
    name: 'Оружейник',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: 'weaponsmith',
    playerBuildable: true,
    category: 'military',
    // Swords, bows and armour (squad leaders), whichever garrisons are waiting for (`waitingFor`), keeping a small stock.
    recipe: { inputs: { iron: 1, coal: 1 }, outputs: {}, outputChoice: ['sword', 'bow', 'armor'], keepInStock: 3, ticks: 277 },
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
    // As in Settlers 4: 1 swordsman + 2 archers.
    garrison: { capacity: 3, keep: 1, archers: 2, defense: 1.2 },
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
    // 3 swordsmen + 3 archers.
    garrison: { capacity: 6, keep: 2, archers: 3, defense: 1.35 },
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
    // The Settlers 4 castle: 4 swordsmen + 5 archers.
    garrison: { capacity: 9, keep: 3, archers: 5, defense: 1.5 },
  },
  lookout: {
    name: 'Смотровая башня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 1 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    vision: 16,
  },
  infirmary: {
    name: 'Лазарет',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    infirmary: { beds: 4, healEvery: 3, range: 30 },
  },

  // Eyecatchers, as in Settlers 4: built for show, they raise the settlement value and so the army's
  // strength on foreign land (STRENGTH). Our own small set of designs.
  flowerbed: { name: 'Клумба', w: 1, h: 1, cost: { plank: 1, stone: 1 }, worker: null, playerBuildable: true, category: 'decor', eyecatcher: true },
  column: { name: 'Колонна', w: 1, h: 1, cost: { stone: 3 }, worker: null, playerBuildable: true, category: 'decor', eyecatcher: true },
  statue: { name: 'Статуя', w: 1, h: 1, cost: { stone: 4, gold: 1 }, worker: null, playerBuildable: true, category: 'decor', eyecatcher: true },
  fountain: { name: 'Фонтан', w: 2, h: 2, cost: { stone: 5, plank: 1 }, worker: null, playerBuildable: true, category: 'decor', eyecatcher: true },
  obelisk: { name: 'Обелиск', w: 1, h: 1, cost: { stone: 6, gold: 2 }, worker: null, playerBuildable: true, category: 'decor', eyecatcher: true },
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

/**
 * Builders that work on one site at once, from Settlers 4's building data (`m_iBuilderNumber`, the
 * Roman buildings: each has that many builder spots around it). Types not listed: by footprint.
 */
export const SITE_BUILDERS: Partial<Record<BuildingType, number>> = {
  castle: 5,
  house_small: 3,
  house_medium: 4,
  house_large: 5,
  warehouse: 4,
  woodcutter: 3,
  forester: 3,
  sawmill: 3,
  stonecutter: 3,
  waterworks: 2,
  fisher: 4,
  hunter: 2,
  farm: 4,
  mill: 4,
  bakery: 3,
  pigfarm: 4,
  market: 2,
  donkeyranch: 4,
  slaughterhouse: 2,
  coalmine: 2,
  ironmine: 3,
  goldmine: 2,
  stonemine: 2,
  ironsmelter: 3,
  goldsmelter: 4,
  toolsmith: 3,
  weaponsmith: 3,
  tower: 3,
  bigtower: 3,
  barracks: 4,
  fortress: 5,
  lookout: 2,
  infirmary: 3,
  flowerbed: 1,
  column: 1,
  statue: 1,
  fountain: 2,
  obelisk: 1,
};

/** How many builders one site of this type takes at once (`SITE_BUILDERS`, else by footprint). */
export function buildersOf(type: BuildingType): number {
  const def = BUILDINGS[type];
  return SITE_BUILDERS[type] ?? (def.w * def.h >= 9 ? 4 : def.w * def.h >= 4 ? 3 : 1);
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
  // Settlers 4's rates: a woodcutter fells a tree a minute, a sawmill cuts three logs a minute.
  { type: 'woodcutter', count: 3 },
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
  { type: 'infirmary', count: 1, after: 'barracks' },
  { type: 'goldmine', count: 1, after: 'toolsmith' },
  { type: 'goldsmelter', count: 1, after: 'goldmine' },
  { type: 'pigfarm', count: 1 },
  { type: 'slaughterhouse', count: 1, after: 'pigfarm' },
  { type: 'farm', count: 2 },
  { type: 'house_medium', count: 2 },
  { type: 'coalmine', count: 2, after: 'toolsmith' },
  { type: 'stonemine', count: 1, after: 'toolsmith' },
  { type: 'tower', count: 4 },
  // After the metal chain: without a tool to wait for, a second forester would otherwise grab the
  // space the smelters need early on.
  { type: 'forester', count: 2, after: 'toolsmith' },
  { type: 'woodcutter', count: 4 },
  { type: 'sawmill', count: 2 },
  { type: 'woodcutter', count: 5 },
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
  attackCooldown: 1200,
  /**
   * After an attack that took its target, the next one comes this soon: it presses on while the
   * enemy is still reeling, instead of giving it the same two minutes to retake what it lost.
   */
  followUpCooldown: 300,
  /**
   * Siege: once it knows an enemy castle (the building that ends the game), it stages this many own
   * military buildings within `ATTACK_RANGE − siegeMargin` of it — even with enemies in reach — so a
   * strike force large enough for the castle can gather there (towers further back cannot join it).
   */
  siegeBuildings: 3,
  siegeMargin: 3,
  /** Out of striking range, a siege building's land must reach at least this much closer to the castle than its land does. */
  siegeStep: 4,
  /** A siege lookout this close (tiles) beyond its land's nearest point to the goal already watches that edge: no second one there. */
  siegeLookoutSlack: 6,
  /** Siege buildings may take it this far beyond `maxMilitary`, no further. */
  siegeExtra: 8,
  /** A party is this many times what the target takes (power against defence); the rest stay home. The castle gets everything. */
  overkill: 2.5,
  /** Target choice: per tile closer to that enemy's castle (progress towards ending the game). */
  depthWeight: 0.6,
  /** Target choice: per other known enemy military building within `ATTACK_RANGE` (it will be retaken from there). */
  reinforceWeight: 1.5,
  /** With at least this many soldiers and no enemy in reach, build military buildings towards the enemy… */
  frontierSoldiers: 8,
  /**
   * While it knows no enemy building but sees foreign land, it puts up to this many lookout towers
   * (`def.vision`) at the border facing it: towers stop at the other's border, too far to see a castle.
   */
  maxLookouts: 2,
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
  /**
   * Its army make-up (weights for `World.setShare`). S4 garrisons have more archer slots than before,
   * and archers in a tower let its swordsman go on an attack (a tower keeps one fighter), so more bows
   * than it used to make; swordsmen still lead, as only they capture.
   */
  weaponShares: { sword: 55, bow: 45 } as Partial<Record<Resource, number>>,
  /** The level it orders recruits at (the barracks falls back to what the gold on hand pays for). */
  recruitLevel: 2,
  /**
   * Materials it keeps back while nothing of its own still produces them (its stone deposits are
   * worked out): only producers of that material may use the reserve; border-pushing military
   * buildings may use it down to `reserveFloor`, so it can still reach new deposits and always keeps
   * enough to open a mine of it.
   */
  reserve: { stone: 4 } as Partial<Record<Resource, number>>,
  reserveFloor: { stone: 1 } as Partial<Record<Resource, number>>,
  /** At most one eyecatcher per this many own buildings, built only while it holds `decorSpare`. */
  decorEvery: 8,
  decorSpare: { stone: 12, plank: 10 } as Partial<Record<Resource, number>>,
  /**
   * While it knows no enemy, at most this many military buildings: scouting goes towards the other
   * start positions (public, like the map size) instead of spreading outposts everywhere.
   */
  maxScoutOutposts: 8,
  /** …plus one more every this many ticks (10 game minutes). */
  scoutOutpostEvery: 10 * 60 * TICKS_PER_SECOND,
  /**
   * Own tiles this close (steps) to the border are kept for military buildings, mines and gatherers:
   * workshops and houses stay in the core, so there is always room to push the border.
   */
  borderReserve: 2,
  /**
   * A building it wanted found no room: for this many ticks it is «cramped» and pushes its border with
   * whatever fighter it can spare, without waiting for `frontierSoldiers`.
   */
  crampedTicks: 1200,
  /**
   * Buildings it cannot do without: with no room anywhere for one, it demolishes a less valuable
   * building to make room (an eyecatcher, a second workshop of a type). The barracks: without it no
   * new fighters, so no growth — the trap a full small territory otherwise locks it in.
   */
  makeRoomFor: ['barracks', 'ironsmelter', 'goldsmelter', 'weaponsmith', 'toolsmith'] as readonly BuildingType[],
  /** Think ticks between specialist decisions (pioneers, thieves). */
  specialistEvery: 600,
  /** Sends a pioneer only while it holds this many shovels (diggers and foresters need them too). */
  pioneerShovels: 2,
  /** Sends a thief only with at least this many idle carriers and a known enemy store this close (tiles). */
  thiefIdle: 8,
  thiefRange: 40,
  /**
   * Field orders (`aiField.ts`). A strike group is released from its garrisons and gathered in the
   * field on its own land (else `stageDistance` tiles short of the target's door: beyond the garrison
   * archers' range) on the line back towards its buildings, then
   * attacks together once `stageArrived` of it stands there or after `stageTimeout` ticks. Parties
   * that start closer than `stageDistance + stageMinWalk` attack straight from their buildings
   * (`World.attack`, also the fallback when `stageStrike` is off). Off by default: measured on
   * 128×128 with 4 AIs (seeds 42, 7, 123, 60 min) staging cut eliminations from 8 to 5–7 in every
   * tuning tried — the group gathered away from the target and arrived too late — while 64×64 and
   * 96×96 games are decided either way.
   */
  stageStrike: false,
  stageDistance: 7,
  stageMinWalk: 4,
  stageArrived: 0.8,
  stageTimeout: 600,
  /**
   * Defence: hostile field units on its land (or within `defendMargin` tiles of it), in its buildings'
   * sight, are met by a field squad `defendRatio` times their number, released from its military
   * buildings within `defendRange` of them; when none are left the squad goes back into garrisons.
   */
  fieldDefense: true,
  defendMargin: 0,
  defendRatio: 1.5,
  defendRange: 16,
  /**
   * Trade (`AiState.trade`): every `tradeEvery` ticks it checks for own workplaces on land cut off
   * from its warehouses; for the first such piece it builds a market there and one at home, a donkey
   * ranch, and sends by donkey what the piece's sites and workplaces lack. Cut-off sites nothing was
   * delivered to yet are demolished instead (a stuck site holds one of `maxOpenSites`).
   */
  tradeEvery: 300,
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
  /** Game: what a hunter gets from it. */
  game?: Resource;
  /** Game comes back: one animal every this many ticks per 64×64 while below the map's initial count. */
  respawnEvery?: number;
}

export const ANIMALS = {
  deer: {
    name: 'Олень',
    habitat: 'forest',
    speed: 0.055,
    herd: [2, 4],
    herds: 2,
    roam: 6,
    rest: [30, 120],
    game: 'meat',
    respawnEvery: 1200,
  },
  donkey: { name: 'Осёл', habitat: 'meadow', speed: 0.03, herd: [1, 3], herds: 1, roam: 5, rest: [60, 200] },
  duck: { name: 'Утка', habitat: 'shore', speed: 0.025, herd: [2, 5], herds: 2, roam: 4, rest: [20, 90] },
  chicken: { name: 'Курица', habitat: 'meadow', speed: 0.03, herd: [3, 6], herds: 1, roam: 3, rest: [10, 60] },
} satisfies Record<string, AnimalDef>;

export type AnimalKind = keyof typeof ANIMALS;
export const ANIMAL_KINDS = Object.keys(ANIMALS) as AnimalKind[];
/** Herds keep at least this far (tiles) from every start position. */
export const ANIMAL_START_CLEARANCE = 16;

/** Residents a house releases: its `capacity`, the same on every map size (Settlers 4's 10/20/50). */
export function residentsOf(def: BuildingDef): number {
  return def.residence?.capacity ?? 0;
}

// ------------------------------------------------------------------- paths

/**
 * Paths as in Settlers 4: every step onto a tile of a `terrains` kind adds `perStep` wear (max 255);
 * from `levels[k].wear` it shows as a dusty path, then a road, and carriers and donkeys
 * (`ProfessionDef.roads`) walk it `levels[k].speed` times faster — Settlers 4's 9 ticks a tile on
 * grass, 8 on a dusty path, 7 on a paved road. Unused tiles lose `decay` wear every `decayEvery` ticks.
 */
export const PATHS = {
  terrains: [Terrain.Grass, Terrain.Desert, Terrain.Sand] as readonly Terrain[],
  perStep: 4,
  decay: 1,
  decayEvery: 300,
  levels: [
    { wear: 60, speed: 9 / 8, name: 'тропа' },
    { wear: 170, speed: 9 / 7, name: 'дорога' },
  ],
};
