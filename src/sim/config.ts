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
 * Settlers 4 tiles in one of ours, by length: measured against the settler's height (an S4 settler
 * stands about two of its tiles tall, ours two thirds of a tile; `docs/PROPORTIONS.md`). Sourced S4
 * distances are divided by this.
 */
export const S4_TILES_PER_TILE = 3;

/**
 * Tiles per tick on open ground. Settlers 4 (decompiled `ISettlerRole`): every settler takes 9 game
 * ticks per S4 tile at 845 ticks a minute, i.e. 1.56 S4 tiles/s — 0.52 of our (three times longer)
 * tiles a second (0.052 a tick), so a settler covers the same distance relative to his body and the
 * buildings as in S4 (`docs/TIMINGS.md`, `docs/PROPORTIONS.md`).
 */
export const SETTLER_SPEED = 845 / 60 / 9 / S4_TILES_PER_TILE / TICKS_PER_SECOND;

/**
 * Work ticks one builder spends per material unit. Settlers 4 (`CBuildingSiteRole::AddWork`): every
 * unit is 200 work, a builder adds one per game tick — 14.2 s per unit and builder; several builders
 * on one site (`buildersOf`) add up.
 */
export const BUILD_TICKS_PER_UNIT = 142;
export const HANDLE_TICKS = 3;

/** Pile limits at a workplace door, per resource: every good a building uses or makes, up to this many units each. */
export const OUTPUT_CAP = 8;
/** Units on one warehouse pile (`StorageDef.perPile`): 8, as every pile in Settlers 4. */
export const STORE_PILE = 8;
export const INPUT_CAP = 8;

export const DISPATCH_EVERY = 5;
/** A free settler stands where its last job ended this long before it walks off to an idle crowd. */
export const IDLE_GO_HOME_TICKS = 30;

/**
 * Idle crowds (`idle.ts`): as in Settlers 4, free carriers (and builders and diggers without a site)
 * do not disappear into a warehouse but stand about outside in small groups — near warehouses and
 * houses, or by a military building while there are none (the start) — strolling a little and
 * chatting in pairs, always ready for the dispatcher.
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
  gatherAt: ['storage', 'residence'] as ('storage' | 'residence' | 'garrison')[],
  /** Where they gather only when none of `gatherAt` stands on their land (the start tower). */
  fallbackAt: ['garrison'] as ('storage' | 'residence' | 'garrison')[],
};
/** After a failed route search: how long the settler waits and how long the target building is skipped. */
export const PATH_FAIL_BACKOFF = 10;
export const UNREACHABLE_TICKS = 100;
/**
 * A builder idle this long at a site without material moves to a site with work (our own number, in
 * proportion to how long carriers take to bring the next unit at the S4 walking pace).
 */
export const BUILDER_STALL_TICKS = 120;

/** Military buildings keep at least this many soldiers when sending others out (to attack or to chase intruders). */
export const GARRISON_KEEP = 1;
/** Combat: soldiers within this distance (tiles, building centers) of the target can join an attack. */
export const ATTACK_RANGE = 30;
/**
 * Settlers 4 game ticks (845 a minute, `docs/TIMINGS.md`) in our ticks: combat cadences are given in
 * the original's ticks and converted here, so they may be fractional (a fighter's `reload` counts
 * down by one a tick and carries the remainder over, so the average pace is exact).
 */
export const s4Ticks = (n: number): number => (n * 60 * TICKS_PER_SECOND) / 845;
/**
 * Fighter levels, as in Settlers 4: chosen when the barracks trains a recruit and fixed for life.
 * `cost` units of `LEVEL_RES` are paid at recruitment on top of the weapon (level 1 is the weapon
 * alone). Hit points and damage per level are each profession's own (`CombatDef.levels`); a
 * profession with fewer levels (the squad leader has one) is trained at its highest and pays only
 * for that.
 */
export const SOLDIER_LEVELS: readonly { cost: number }[] = [{ cost: 0 }, { cost: 1 }, { cost: 2 }];
export const LEVEL_RES: Resource = 'gold';
/** A fighter below this share of his hit points, idle in a garrison, goes to an infirmary if one has a bed. */
export const WOUNDED_AT = 0.6;
/** Garrisons look for wounded to send to an infirmary this often (ticks). */
export const WOUNDED_CHECK_EVERY = 20;
/** Visual only: ticks an arrow is drawn in flight. */
export const SHOT_TICKS = 5;
/**
 * Default weapon make-up per player (weights, see `World.setShare`): what the weaponsmith forges when
 * nothing ordered is waiting (Settlers 4's weaponsmith «by shares» mode). Who is recruited is the
 * player's barracks orders alone (`economy.ts` `recruitOrders`).
 */
export const OUTPUT_SHARES: Partial<Record<Resource, number>> = { sword: 60, bow: 40, armor: 8 };
/**
 * Free-carrier reserve, as Settlers 4's settlers menu (`CEcoSector::ChangeMinMaxValues`, type 1;
 * `OrderWorker`, `CarrierForJobOrderAvailable`): a carrier becomes a worker, builder, digger,
 * specialist or recruit only while the player has more carriers than the reserve (carriers already
 * on their way to take up a job do not count). The player sets it between `min` and `max`
 * (`World.setCarrierReserve`, saved in `Player.economy.minCarriers`); S4's default and minimum is 5.
 */
export const CARRIER_RESERVE = { default: 5, min: 5, max: 999 };

/**
 * Default transport priority, Settlers 4's for the Romans (`CEcoSector::InitTransport`,
 * `CGoodTransportPriority`, `ROMAN_TP_*`; manual §5.2.3): the dispatcher serves goods in this order —
 * demands first, then surplus to warehouses —, which matters when carriers are short. The player
 * moves goods up and down (`World.moveTransport`, `Player.economy.transport`). Unlike S4 there is no
 * limit of one transport per good per pass (the «coalbug»): we keep the community's Transport+.
 * Our goods only (no ammunition, wine or sulfur); every resource must be listed.
 */
export const TRANSPORT_PRIORITY: readonly Resource[] = [
  'plank', 'stone', 'log', 'iron', 'ironore', 'coal', 'bread', 'fish', 'meat', 'flour', 'grain', 'pig', 'water',
  'sword', 'bow', 'armor', 'shovel', 'hammer', 'axe', 'pickaxe', 'saw', 'rod', 'scythe', 'gold', 'goldore',
];
/**
 * Construction sites as in Settlers 4 (`CBuildingSiteRole::OrderMaterial`, `LogicUpdate`,
 * `CheckActivateUrgent*`; Settlers United wiki «Buildsite priority»): a site asks for each material
 * only while what lies at it plus what is on the way stays under `pile` (S4: 8 — why big buildings
 * take long), and asks nothing before a digger is on his way or it is levelled. Priority is for sites
 * only and hard: while a prioritised site on a piece of land still needs a material, no other site or
 * workshop there gets any of it; at most `maxPriority` prioritised sites per piece (S4: per economy
 * sector), and the flag goes when the site is finished. (Workshops may be prioritised too — our
 * extension: they are only served first.)
 */
export const SITE = { pile: 8, maxPriority: 10 };
/**
 * Garrisons as in Settlers 4 (`CMilitaryBuildingRole`): every `every` ticks (S4: 15 of its ticks) a
 * military building orders a free fighter while it holds fewer than it wishes (`Building.wish`; an
 * empty one with no wish asks for one — a swordsman if there is one, else an archer), the highest
 * level first, looking `rings` tiles round its door one ring after the other (S4: 20, 40 and 80 of its
 * tiles); and it puts one fighter beyond its wish out of the door, only while no enemy fighter is
 * within `enemyNear` tiles (S4: 10). `warnEvery`: the same warning («no free fighter», «no carrier
 * for a recruit») reaches the player at most this often per building (ticks; our choice).
 */
export const GARRISON_ORDERS = {
  every: Math.round(s4Ticks(15)),
  rings: [20 / 3, 40 / 3, 80 / 3] as readonly number[],
  enemyNear: 10 / 3,
  warnEvery: 60 * TICKS_PER_SECOND,
};
/**
 * The barracks looks at its owner's recruit orders this often (S4: every 13–15 of its ticks); a
 * recruit is the nearest free carrier, his walk is the training (S4 has no training time).
 */
export const BARRACKS_EVERY = Math.round(s4Ticks(14));
/** Spade strokes (one per `DIG_EVERY` ticks) to clear one footprint tile, on top of any levelling. */
export const CLEAR_STROKES_PER_TILE = 6;
/**
 * Diggers one site takes at once, as in Settlers 4 (`CBuildingSiteRole::SetDiggingInfos`): one more
 * per `DIG_STROKES_PER_DIGGER` spade strokes still to do (levelling steps plus clearing), at most
 * `MAX_DIGGERS`.
 */
export const DIG_STROKES_PER_DIGGER = 32;
export const MAX_DIGGERS = 8;
/**
 * Settlers 4's medium start for the Romans (`StartResources.txt`, `docs/PROPORTIONS.md`): 27 planks
 * and 27 stone in eight piles.
 */
export const START_PLANKS = 27;
export const START_STONE = 27;

/**
 * Start conditions, chosen before a free game as in Settlers 4 (low, medium or high start goods). As
 * in Settlers 4 there is no headquarters: every player starts with one small tower (`building`,
 * finished and manned by the start fighters as far as its slots go; the others stand by it) and the
 * goods lying on the ground round it in piles of up to `GROUND.perStack` — the Roman piles of
 * `Script/Internal/StartResources.txt` (`Goods.AddPileEx`, 11 / 22 / 35 piles), `piles` in that order.
 * The people are the Roman ones of the same script (`Settlers.AddSettlers`): carriers, builders,
 * diggers, `soldiers` swordsmen and `archers` bowmen (all level 1, S4's `SWORDSMAN_01`/`BOWMAN_01`),
 * `geologists` waiting for orders, `donkeys`, and `workers`: S4's ready-made smiths, miners and hunter,
 * who wait (idle, with their tool) for a workplace of their profession and take it up before any
 * carrier would (`dispatchFor`; S4's smith works either smithy, so ours takes up any profession of
 * his `trade`).
 */
export type StartLevel = 'low' | 'medium' | 'high';
export interface StartDef {
  name: string;
  building: BuildingType;
  piles: readonly (readonly [Resource, number])[];
  carriers: number;
  builders: number;
  diggers: number;
  soldiers: number;
  archers: number;
  geologists: number;
  donkeys: number;
  workers: Partial<Record<SettlerKind, number>>;
}

export const START_CONDITIONS: Record<StartLevel, StartDef> = {
  low: {
    name: 'Мало',
    building: 'tower',
    piles: [
      ['plank', 5], ['plank', 5], ['plank', 5],
      ['stone', 6], ['stone', 5], ['stone', 5],
      ['shovel', 3], ['hammer', 3], ['axe', 2], ['pickaxe', 1], ['saw', 1],
    ],
    carriers: 16,
    builders: 3,
    diggers: 3,
    soldiers: 6,
    archers: 2,
    geologists: 2,
    donkeys: 0,
    workers: { toolsmith: 1, miner: 2 },
  },
  medium: {
    name: 'Средне',
    building: 'tower',
    piles: [
      ['plank', 8], ['plank', 7], ['plank', 6], ['plank', 6],
      ['stone', 8], ['stone', 8], ['stone', 6], ['stone', 5],
      ['shovel', 7], ['hammer', 8], ['axe', 5], ['pickaxe', 4], ['saw', 2], ['rod', 1], ['scythe', 1],
      ['fish', 4], ['bread', 5], ['bread', 5], ['meat', 6],
      ['coal', 4], ['coal', 6], ['ironore', 5],
    ],
    carriers: 32,
    builders: 5,
    diggers: 5,
    soldiers: 10,
    archers: 4,
    geologists: 3,
    donkeys: 0,
    workers: { toolsmith: 2, miner: 4 },
  },
  high: {
    name: 'Много',
    building: 'tower',
    piles: [
      ['plank', 8], ['plank', 8], ['plank', 8], ['plank', 8], ['plank', 8], ['plank', 6],
      ['stone', 8], ['stone', 8], ['stone', 8], ['stone', 8], ['stone', 7],
      ['shovel', 8], ['shovel', 8], ['shovel', 4], ['hammer', 8], ['hammer', 8], ['hammer', 6],
      ['axe', 8], ['pickaxe', 5], ['saw', 3], ['rod', 2], ['scythe', 3],
      ['fish', 4], ['fish', 4], ['bread', 8], ['bread', 8], ['meat', 5], ['meat', 3],
      ['coal', 8], ['coal', 8], ['coal', 6], ['coal', 4], ['ironore', 8], ['ironore', 4], ['goldore', 2],
    ],
    // S4's "many" start really has fewer builders and diggers than "medium" (and tools to make more).
    carriers: 50,
    builders: 2,
    diggers: 2,
    soldiers: 12,
    archers: 6,
    geologists: 5,
    donkeys: 3,
    workers: { toolsmith: 3, miner: 6, hunter: 1 },
  },
};

/** A start level's goods in all (its piles added up). */
export function startGoods(def: StartDef): Partial<Stock> {
  const out: Partial<Stock> = {};
  for (const [res, n] of def.piles) out[res] = (out[res] ?? 0) + n;
  return out;
}

/**
 * Goods lying on the ground (`ground.ts`), as Settlers 4's piles (`CPile::MAX_PILE_AMOUNT` 8): at
 * most `perStack` units of one good per tile, put down within `searchRadius` tiles of where they
 * fall, nearest first, topping up a pile of the same good (`CPileMgr::SearchSpaceForGoods`).
 *
 * Ruins (`World.removeBuilding`, Settlers 4's `IBuildingRole::ReturnBuildingMaterial`): a building the
 * player demolishes gives back `demolishShare` of every material built into it, rounded down (S4:
 * half of the cost; of a site, half of the units its builders built in); one that burns — on land a
 * conquest took, or of a defeated player — gives back `burnShare` (S4: nothing). Either way the goods
 * lying at it (its piles, a warehouse's stock, a site's materials not yet built in) stay on the ground
 * whole (`keepsGoods`; S4 turns those piles into loose ones). They lie on and around the footprint and
 * belong to whoever owns that land. Sources in `docs/S4-PARITY.md`.
 *
 * A stack never blocks walking but makes a route through its tile dearer: S4's
 * `CWorldManager::SetPileId` sets the tile's move-cost bits to 7, and its A* charges 4 × bits + 8 a
 * step (`CAStar64::WorldMoveCosts`): 36 against open grass's 16 (bits 2). Our A* charges `pathCost`
 * (that ratio) instead of the terrain's `TERRAIN_COST` to enter a tile with goods on it, if more.
 */
export const GROUND = {
  perStack: 8,
  searchRadius: 8,
  demolishShare: 0.5,
  burnShare: 0,
  keepsGoods: true,
  pathCost: 36 / 16,
};

/**
 * Defeat in a free game: a player is out once he has no occupied military building left (Settlers 4's
 * `Game.DefaultPlayerLostCheck`: «keine besetzten Türme mehr») and — with `fighters`, the project's
 * rule — no fighter either (outdoors, homeless, in the field, in an infirmary; a recruit still in
 * training does not count). S4's own check counts only the buildings: set `fighters` to false for it.
 * Checked every `checkEvery` ticks once `afterTick` has passed (S4: every 8 of its ticks after 140).
 */
export const DEFEAT = { checkEvery: Math.round(s4Ticks(8)), afterTick: Math.round(s4Ticks(140)), fighters: true };

/**
 * Who owns the land (`territory.ts`), Settlers 4's `CWorldManager::SetOwner`: a claiming building
 * gives each tile of its disc `influence - perTile * distance` (S4: 50 - distance in its tiles, and
 * one of ours is `S4_TILES_PER_TILE` of them), a player's influences add up to at most `cap` (S4: 254);
 * a tile changes hands only when it is nobody's or its owner has no influence on it left, and then
 * goes to the greatest influence.
 */
export const TERRITORY = { influence: 50, perTile: S4_TILES_PER_TILE, cap: 254 };

/**
 * Settlers stranded on land that is not their owner's (or an ally's), as Settlers 4's `CFleeRole`: a
 * free carrier, builder or digger (`behaviors`; fighters are exempt) walks towards the nearest land
 * of his own within `seek` tiles, or else to a random spot within `wander`, pausing `pause` ticks
 * between legs (a random value in the range); back on own land he is an ordinary settler again, and
 * after `legs` legs without reaching it he dies (S4: deleted after four). Every settler of a defeated
 * player flees the same way, fighters too — he has no land left.
 */
export const FLEE = {
  behaviors: ['carrier', 'builder', 'digger'] as Behavior[],
  legs: 4,
  seek: 24,
  wander: 8,
  pause: [20, 90] as [number, number],
};

/**
 * Workers the player orders (as in Settlers 4 builders and diggers are made from free settlers, with
 * a tool, only as many as ordered); the defaults equal the start's, so nothing is recruited unasked.
 * `World.orderWorkers` changes them.
 */
export const ORDERABLE: readonly SettlerKind[] = ['builder', 'digger', 'geologist', 'pioneer', 'thief'];

/**
 * Specialists (Settlers 4), ordered like workers and sent on errands (`specialists.ts`). The pioneer
 * and the geologist search as S4's `CPioneerRole`/`CGeologistRole::SearchPosition` do: out from where
 * they stand, the nearest `window` tiles of a distance-sorted spiral first (S4: 32 and 64 of its
 * tiles, out to ≈ 3 and 4.2 S4 tiles = 1 and 1.4 of ours: himself and his 4 or 8 neighbours), the next
 * window only when one holds nothing; within a window the tile with the least d²(to the spot ordered)
 * + 3·d²(to himself). With nothing within `reach` (S4: 28 and 56 empty windows, ≈ 16 and 32 S4 tiles)
 * the errand is over and he stays where he stands.
 * - pioneer: claims neutral passable tiles (S4 `CheckLand`: they need not touch his owner's land — a
 *   new island of land is fine), one every `claimTicks` ticks of work, until none is left in reach;
 *   his land has no influence, so a tower that covers it takes it (`territory.ts`). S4 moves a border
 *   stone every 4 s (siedlercommunity) plus a 0.64 s step, ≈ 4.6 s per S4 tile; our tile ≈ nine of
 *   them, so ≈ 42 s per our tile keeps the same pace per area: 40 s of work plus our ≈ 2 s step;
 * - geologist: puts a sign on every unexamined walkable mountain tile — on any land, his owner's,
 *   neutral or foreign (S4 `CheckPosition` has no owner test) — `ticks` each, until none is left in
 *   reach, so he follows the whole ridge. S4: a sign every 4 s (siedlercommunity), the step to the
 *   next tile included: ≈ 2 s of work plus our ≈ 2 s step;
 * - thief: robs a foreign building's door pile or stock (`stealTicks` of work, one unit of its most
 *   plentiful good) and carries it home. How intruders are met is `INTRUDERS`.
 */
export const PIONEER = { reach: 5.3, window: 5, claimTicks: 400 };
export const GEOLOGIST = { reach: 10.6, window: 9, ticks: 21 };
/**
 * The geologist's signs (`map.signAt`/`signBy`). Settlers 2 and 3 take them down after a while (S2:
 * the-settlers wiki; S3: the jsettlers remake, `RessourceSignMapObject`, 4 min plus up to 5 random);
 * Settlers 4 is assumed to do the same, its time unverified (docs/TIMINGS.md). A sign stands
 * `lifetime` plus up to `spread` ticks (per tile, by a hash, so a field of signs thins out instead of
 * vanishing at once); what the player learnt stays (`map.prospected`), and his geologists may put a
 * new sign where his old one came down. The board shows one, two or three symbols for an ore amount
 * below `levels[0]`, below `levels[1]`, or more — S4's 1/2/3 signs for fill levels 1–5, 6–10 and
 * 11–15 (Settlers United wiki, mining mechanics); our natural ore holds 12–28 units a tile, the
 * guaranteed start lobes 64–96.
 */
export const GEOLOGIST_SIGN = {
  lifetime: 4 * 60 * TICKS_PER_SECOND,
  spread: 5 * 60 * TICKS_PER_SECOND,
  levels: [20, 40] as const,
};
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
 * same pace he otherwise never would be reached); adjacent, the fighter strikes at his own pace
 * (`combat.every`) with ordinary blows (`combat.ts`) — specialists do not fight back — until the intruder dies (his load is
 * lost) or is off that player's land; then the fighter stands free until a building calls him. Radii and timings
 * are our approximations: the wiki gives no numbers (`exposedTicks` leaves a responder from
 * `respondRadius` time to arrive at the S4 walking pace).
 */
export const INTRUDERS = { scanEvery: 10, decloakRadius: 3, exposedTicks: 900, respondRadius: 12, responders: 1, seizeRadius: 3 };

/**
 * Fighting strength, after Settlers 4 (settlers-united wiki, «fighting strength calculation»): a
 * player's settlement value is the wood (planks, logs) and stone built into their finished buildings
 * at `points` each, gold at `goldPoints`, eyecatchers' materials `eyecatcher` times over. Attack
 * strength starts at `start` per cent (fewer players, more — `perPlayer` less per player beyond one,
 * never below `min`) and rises with value along `steps` (`[up to %, value points per 1 %]`, diminishing
 * returns) up to `max`. Fighters on their own (or an ally's) land always fight at 100 %; on foreign
 * land at the attack strength. Defence equals 100 % until attack strength passes it, then grows at
 * half its pace. Our buildings cost what Roman S4 ones do (but the warehouse and the market);
 * `points` (and `goldPoints` with it) stay a little above one so the strength curve keeps the pace it
 * was tuned for (`docs/PROPORTIONS.md`).
 */
export const STRENGTH = {
  points: 1.75,
  goldPoints: 3.5,
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
  /**
   * Settlers see this far (tiles), unless their profession has its own `sight`: Settlers 4 gives
   * fighters and specialists 15 of its tiles (≈ 5 of ours; the thief 25 ≈ 8).
   */
  settlerRadius: 5,
  /**
   * Settlers stamp their surroundings every this many ticks; a tile stays visible that long after. At
   * the S4 walking pace a settler moves under a tile between two stamps.
   */
  settlerEvery: 15,
  /** Building vision is rebuilt at most this often, and only when buildings or territory changed. */
  buildingEvery: 10,
};
/**
 * Stone units in a deposit tile at generation, inclusive range. Our own numbers (no S4 source), doubled
 * with the S4 building costs, which ask about twice the stone ours did (`docs/PROPORTIONS.md`).
 */
export const DEPOSIT_STONE: [number, number] = [8, 16];
/** Grain field stages: 1 sown … CROP_RIPE harvestable. Fields grow every CROP_GROW_EVERY ticks with CROP_GROW_CHANCE. */
export const CROP_RIPE = 4;
export const CROP_GROW_EVERY = 10;
export const CROP_GROW_CHANCE = 0.035;
/** Ore kinds stored in `map.ore` (index + 1; 0 = none) and the resource a mine extracts. */
export const ORE_RESOURCES: readonly Resource[] = ['coal', 'ironore', 'goldore', 'stone'];
export function oreOf(code: number): Resource | null {
  return code > 0 ? ORE_RESOURCES[code - 1] : null;
}
/**
 * Ore units per mountain tile at generation, inclusive range. A mine reaches a radius of 2 (13 tiles;
 * Settlers 4: 4 of its tiles) and one of our tiles holds about nine of S4's (1–15 units each), so a
 * mine's reserve stays about what it was with radius 3 and 6–14 a tile.
 */
export const ORE_AMOUNT: [number, number] = [12, 28];
/** Food a miner eats per unit of ore. */
export const MINER_FOOD: readonly Resource[] = ['bread', 'fish', 'meat'];

/**
 * Fish per open-water tile at generation. As in Settlers 4 fish runs out: nothing restocks it (only a
 * spell does, and magic is out of scope), so `FISH_RESTOCK` (restock attempts per tick per 64×64 of
 * map) is 0. An S4 tile holds 1–15 fish (`CSearchRoutines::SearchFish`) and one of ours covers about
 * nine of them, but not every S4 water tile has fish: 8 is our own estimate.
 */
export const FISH_MAX = 8;
export const FISH_RESTOCK = 0;
/**
 * Natural tree spread: seeding attempts per tick per 64×64 of map (a mature tree sows a sapling within
 * two tiles). Settlers 4's trees only grow (`CTree::LogicUpdate`); new ones come from foresters
 * alone, so 0 (the old 0.1 regrew forests for free).
 */
export const TREE_SPREAD = 0;

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
 * - prospect: the geologist: examines mountain tiles on an errand, then waits with the idle crowd for
 *   the next one — or turns back into a carrier if there are more geologists than the player ordered;
 * - soldier: lives in a military building's garrison, or stands free where he is (a military building
 *   with room calls free fighters in, `military.ts`), or keeps a field post (`field.ts`);
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
  /**
   * Chance that a finished attempt yields nothing (world RNG): the gatherer walks home empty-handed
   * and the tile keeps its unit (Settlers 4's fisher: 33 %, `CSearchRoutines::SearchFish`).
   */
  missChance?: number;
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

/** Hit points and damage per attack of a fighter at one level (Settlers 4 unit stats). */
export interface FighterLevel {
  hp: number;
  damage: number;
}

/**
 * Fighting abilities of a military profession, as in Settlers 4 (Settlers United wiki, «Unit stats»;
 * decompiled `CSoldierRole::LogicUpdateJob`): every attack lands — no misses — for the level's
 * `damage` × the owner's fighting strength where the fighter stands (`fieldFactor`), rounded, at
 * least 1; a squad leader's bonus (`leads.morale`) adds its share on top; the target's `armor` is
 * subtracted (never below 1 damage). Each fighter attacks on his own timer, every `every` ticks.
 */
export interface CombatDef {
  /** Hit points and damage per attack by level (index = `Settler.level`, clamped to the last). */
  levels: readonly FighterLevel[];
  /** Ticks between two attacks (`s4Ticks` of the original's cadence). */
  every: number;
  /** Subtracted from every hit this fighter takes, never below 1 damage (the squad leader's 2). */
  armor?: number;
  /**
   * Shoots from up to `range` tiles (point-blank too: an archer called out to a duel shoots). In a
   * garrison he shoots from up to `towerRange` tiles, only at enemies standing on his side's land or
   * nobody's, and his shots deal `tower` more damage, `towerDoor` more at enemies standing at its door
   * (Settlers 4: `CTowerSoldier::SearchBowmanTarget`, 20 of its tiles; the tower bowman's +1, the
   * stone dropper's +2, not scaled by fighting strength).
   */
  ranged?: { range: number; towerRange: number; tower: number; towerDoor: number };
  /**
   * Can take an empty enemy building: in Settlers 4 a swordsman or a bowman (warrior types 2 and 3,
   * `CMilitaryBuildingRole::InsertTowerGuard`), never the squad leader.
   */
  captures?: boolean;
  /** Never goes into a garrison (the squad leader: Settlers 4's tower slots take only types 2 and 3). */
  fieldOnly?: boolean;
  /**
   * Barracks order (Settlers 4 `CBarrackRole::LogicUpdate`): the satisfiable order of the highest
   * `rank` goes first (default: level + 1; S4's squad leader 4), and between kinds of equal rank the
   * `alternate` classes take turns (S4: swordsman 0, bowman 1, special fighter 2; none = no turn).
   */
  rank?: number;
  alternate?: number;
  /**
   * Squad leader (Settlers 4): own fighters within `radius` tiles of him (not himself) deal
   * `morale` × damage, and soldiers ordered out with him follow him as a squad (`field.ts`). In S4 the
   * bonus belongs to the members of his control group; the radius is our stand-in for that group.
   */
  leads?: { radius: number; morale: number };
}

export interface ProfessionDef {
  name: string;
  behavior: Behavior;
  /** Hit points of a specialist (see `INTRUDERS`); fighters' come from `combat.levels` (`hpOf`). */
  hp?: number;
  /** How far (tiles) a settler of this profession sees outdoors, instead of `FOG.settlerRadius`. */
  sight?: number;
  /** Disguised on hostile land until a fighter of that land comes close (the thief, `INTRUDERS`). */
  cloaked?: boolean;
  combat?: CombatDef;
  /** Walking speed relative to `SETTLER_SPEED` (Settlers 4: the squad leader rides, 9 ticks a tile against 7). */
  speed?: number;
  /** Walks faster on worn paths and roads (`PATHS`); in Settlers 4 only carriers and donkeys do. */
  roads?: boolean;
  /** Tool a carrier must fetch from storage to take up the profession (it is used up). */
  tool?: Resource;
  /**
   * Professions of one trade are one to a ready-made worker (S4's start smiths, `START_CONDITIONS`):
   * he takes up any workplace whose profession shares his trade.
   */
  trade?: string;
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
  woodcutter: { name: 'Лесоруб', behavior: 'gather', tool: 'axe', gather: { res: 'log', radius: 7, workTicks: 200, restTicks: 230 } },
  stonecutter: {
    name: 'Каменотёс',
    behavior: 'gather',
    tool: 'pickaxe',
    gather: { res: 'stone', radius: 7, workTicks: 170, restTicks: 140 },
  },
  forester: {
    name: 'Лесничий',
    behavior: 'plant',
    plant: { what: 'tree', radius: 4, workTicks: 60, restTicks: 40 },
  },
  waterman: { name: 'Водонос', behavior: 'gather', gather: { res: 'water', radius: 7, workTicks: 30, restTicks: 30 } },
  fisher: {
    name: 'Рыбак',
    behavior: 'gather',
    tool: 'rod',
    gather: { res: 'fish', radius: 7, workTicks: 90, restTicks: 70, missChance: 0.33 },
  },
  farmer: {
    name: 'Фермер',
    behavior: 'farm',
    tool: 'scythe',
    gather: { res: 'grain', radius: 4, workTicks: 50, restTicks: 10 },
    plant: { what: 'grain', radius: 4, workTicks: 40, restTicks: 10, maxNearby: 10 },
  },
  /** As in Settlers 4 the hunter uses a bow (forged by the weaponsmith). */
  hunter: {
    name: 'Охотник',
    behavior: 'hunt',
    tool: 'bow',
    hunt: { radius: 7, range: 3.5, workTicks: 40, restTicks: 500, chases: 4 },
  },
  sawmiller: { name: 'Пильщик', behavior: 'workshop', tool: 'saw' },
  miller: { name: 'Мельник', behavior: 'workshop' },
  baker: { name: 'Пекарь', behavior: 'workshop' },
  pigfarmer: { name: 'Свинопас', behavior: 'workshop' },
  butcher: { name: 'Мясник', behavior: 'workshop', tool: 'axe' },
  miner: { name: 'Шахтёр', behavior: 'workshop', tool: 'pickaxe' },
  smelter: { name: 'Плавильщик', behavior: 'workshop' },
  toolsmith: { name: 'Инструментальщик', behavior: 'workshop', trade: 'smith' },
  /**
   * Ordered like the pioneer and the thief (`ORDERABLE`): a carrier takes up a hammer (used up, given
   * back on dismissal) and waits for errands (`World.sendGeologist`). Specialists' `hp` is Settlers
   * 4's, on the soldiers' scale (a swordsman 100): geologist and pioneer 25, thief 20 (Settlers United
   * wiki, units/geologist, units/pioneer, units/thief).
   */
  geologist: { name: 'Геолог', behavior: 'prospect', tool: 'hammer', hp: 25 },
  weaponsmith: { name: 'Оружейник', behavior: 'workshop', trade: 'smith' },
  /** Specialists (`ORDERABLE`, `specialists.ts`). */
  pioneer: { name: 'Первопроходец', behavior: 'pioneer', tool: 'shovel', hp: 25 },
  /**
   * Disguised: no target on hostile land until a fighter of that land comes close (`INTRUDERS`).
   * Sees 25 S4 tiles (Settlers United changelog), ≈ 8 of ours.
   */
  thief: { name: 'Вор', behavior: 'thief', hp: 20, cloaked: true, sight: 8 },
  donkeyrancher: { name: 'Погонщик', behavior: 'workshop' },
  donkey: { name: 'Осёл', behavior: 'donkey', roads: true },
  recruit: { name: 'Новобранец', behavior: 'workshop' },
  /** Settlers 4: 100 / 150 / 210 hit points, 10 / 14 / 20 a blow, a blow every 13 of its ticks. */
  soldier: {
    name: 'Мечник',
    behavior: 'soldier',
    tool: 'sword',
    combat: {
      levels: [
        { hp: 100, damage: 10 },
        { hp: 150, damage: 14 },
        { hp: 210, damage: 20 },
      ],
      every: s4Ticks(13),
      captures: true,
      alternate: 0,
    },
  },
  /**
   * Settlers 4: 75 / 120 / 160 hit points, 4 / 6 / 8 a shot every 20 of its ticks; on a tower +1 a
   * shot, +2 at enemies at its door. Range: 10 S4 tiles in the field, a third of ours in length
   * (`S4_TILES_PER_TILE`): ≈ 3.3 of ours, 3; from a tower 20 S4 tiles ≈ 6.7 of ours. Takes an empty
   * enemy building like a swordsman (S4).
   */
  archer: {
    name: 'Лучник',
    behavior: 'soldier',
    tool: 'bow',
    combat: {
      levels: [
        { hp: 75, damage: 4 },
        { hp: 120, damage: 6 },
        { hp: 160, damage: 8 },
      ],
      every: s4Ticks(20),
      ranged: { range: 3, towerRange: 20 / 3, tower: 1, towerDoor: 2 },
      captures: true,
      alternate: 1,
    },
  },
  /**
   * Squad leader, as in Settlers 4: made in the barracks from armour, a sword and 3 gold (S4
   * community: the leader costs 3 gold), a strong swordsman (215 hit points, 21 a blow every 13 ticks,
   * armour 2; one level only) whose presence lifts the fighters around him (`combat.leads`: +10 %
   * damage). He neither takes buildings nor goes into one (S4's tower slots take only swordsmen and
   * bowmen); the barracks makes him first when it can (S4's priority level 4).
   */
  leader: {
    name: 'Командир',
    behavior: 'soldier',
    tool: 'armor',
    kit: { sword: 1, gold: 3 },
    speed: 9 / 7,
    combat: {
      levels: [{ hp: 215, damage: 21 }],
      every: s4Ticks(13),
      armor: 2,
      fieldOnly: true,
      rank: 4,
      leads: { radius: 6, morale: 1.1 },
    },
  },
};

/** A fighter's stats at `level` (clamped to the profession's levels), or undefined for non-fighters. */
export function fighterLevel(kind: SettlerKind, level: number): FighterLevel | undefined {
  const levels = PROFESSIONS[kind].combat?.levels;
  return levels ? levels[Math.max(0, Math.min(level, levels.length - 1))] : undefined;
}

/** Full hit points of a settler of `kind` at `level`: a fighter's from his level, a specialist's `hp`, else 0. */
export function hpOf(kind: SettlerKind, level = 0): number {
  return fighterLevel(kind, level)?.hp ?? PROFESSIONS[kind].hp ?? 0;
}

/**
 * Field units (direct army control, `field.ts`): a fighter on a field post engages enemy fighters
 * within `engageRadius` tiles (archers shoot within their range instead), looks around every
 * `scanEvery` ticks, gives up a chase beyond `chaseLimit` tiles from his post, and walks back to the
 * post once more than `slack` tiles from it. `formation`: tiles between neighbours of a formation.
 * A swordsman whose enemy is busy with a comrade waits beside him `waitBeside` ticks, then gives up.
 */
export const FIELD = { engageRadius: 4, scanEvery: 5, chaseLimit: 7, slack: 1.5, formation: 1, waitBeside: 36 };

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
  /**
   * Chance (world RNG) that a finished cycle, which always uses up its inputs, yields its outputs (or
   * bred settler) — Settlers 4's animal ranches: a feeding adds a pig with 77 %, a donkey with 25 %
   * (`CAnimalRanchRole::LogicUpdate`). Default 1.
   */
  outputChance?: number;
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

/**
 * A warehouse's capacity (`storage.ts`): `piles` piles of up to `perPile` units of one good each (a
 * good may fill several), and/or at most `units` units in all; neither = no limit.
 */
export interface StorageDef {
  piles?: number;
  perPile?: number;
  units?: number;
}

export interface BuildingDef {
  name: string;
  w: number;
  h: number;
  /** Materials needed to construct. */
  cost: Partial<Stock>;
  worker: SettlerKind | null;
  playerBuildable: boolean;
  category?: Category;
  /** Warehouse: accepts goods (as the player allows, up to its capacity) and supplies them back. */
  storage?: StorageDef;
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
   * Barracks (Settlers 4): works only by its owner's recruit orders (`economy.ts` `recruitOrders`, by
   * kind and level). For an order its pile pays for (the weapon, the fighter's `kit`, the level's gold)
   * it calls the nearest free carrier, who walks in, stays `ticks` inside (our short stand-in for
   * going in and out) and comes out as that fighter, standing free by it. The only way to raise new
   * fighters.
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
 * inside, or always if `claimsWhenEmpty`. Slots have a kind, as in Settlers 4:
 * `archers` of them are for ranged fighters, the rest for melee ones. How many it calls in is its
 * owner's wish (`Building.wish`, see `GARRISON_ORDERS`): one by default, all with «fill».
 */
export interface GarrisonDef {
  capacity: number;
  claimsWhenEmpty?: boolean;
  /** Soldiers it never gives away to attack or to chase intruders (default `GARRISON_KEEP`). */
  keep?: number;
  /** Slots for archers; the other `capacity − archers` slots are for swordsmen. */
  archers?: number;
  /**
   * Settlers 4's door (`CDoorRole`, `MaxTowerDoorHealth`): while the building is held, attackers must
   * break its door (`hp` hit points, one back every `regenEvery` ticks while it stands) before they can
   * call a defender out; broken, it is back only once the building is taken or manned again from empty.
   */
  door?: { hp: number; regenEvery: number };
}

/**
 * Mining as in Settlers 4 (`CMineRole::TakeNextFood`, `SearchResource`): a food unit buys digging
 * attempts — `favourite` of the mine `attempts.favourite`, any other `attempts.other`. Each attempt
 * picks a random tile within the mine's radius, ore or not: a tile without its ore (or worked out) is
 * a miss, the attempt spent; an ore tile yields one unit for sure while it holds at least
 * `sureAmount`, else with `chancePerUnit` × units left. A worked-out mine keeps eating.
 */
export const MINING = { attempts: { favourite: 10, other: 2 }, sureAmount: 4, chancePerUnit: 0.25 };

/**
 * Trade over land, as in Settlers 4 (`CDonkeyRole`, `CTradingBuildingRole`): a donkey carries `packs`
 * packs of up to `donkeyLoad` units of one good each (two goods, or 16 of one) per trip from a
 * marketplace to the market its route names; a donkey ranch breeds donkeys while the player has fewer
 * than `donkeysPerMarket` per finished marketplace (our convenience: S4 has no limit). An order keeps
 * up to `stock` units of the good waiting at the market (S4: three piles of 8).
 */
export const TRADE = { donkeyLoad: 8, packs: 2, donkeysPerMarket: 3, stock: 24 };

/** Settlers 4's tower door: `MaxTowerDoorHealth` 50, one hit point back every 15 of its ticks. */
const TOWER_DOOR = { hp: 50, regenEvery: s4Ticks(15) };

function mine(name: string, res: Resource, favourite: Resource, cost: Partial<Stock> = { plank: 4, stone: 1 }): BuildingDef {
  return {
    name,
    w: 2,
    h: 2,
    cost,
    worker: 'miner',
    playerBuildable: true,
    category: 'mining',
    terrain: 'mountain',
    // Settlers 4: the mine's point plus 4 S4 tiles (61–64 of them) ≈ 1.3 of ours; 2 (13 tiles) is the
    // smallest disc that still covers a guaranteed ore lobe (`ORE_AMOUNT` is richer to match).
    mine: { res, radius: 2, favourite },
    recipe: { inputs: {}, inputsAnyOf: MINER_FOOD, outputs: { [res]: 1 }, ticks: 80 },
  };
}

/**
 * Recipe and gathering times follow Settlers 4 in real seconds at normal speed (10 ticks here = 1 s;
 * the original runs 845 ticks a minute): the Roman buildings' ticks per product, measured by the
 * Settlers United wiki, and the professions' cycles from siedlercommunity.de — table and sources
 * in `docs/TIMINGS.md`. Costs are the Roman buildings' (the-settlers fandom wiki), except the warehouse
 * and the market, which stay dearer by choice; territory radii are S4's in our tiles
 * (`docs/PROPORTIONS.md`). Footprints follow the original's on-screen widths
 * (barracks, pig farm and donkey ranch 3×3, the castle — our `fortress` — 4×4). There is no
 * headquarters: players start with a small tower (`START_CONDITIONS`).
 */
export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  house_small: {
    name: 'Малый дом',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 3 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 10, everyTicks: 150 },
  },
  house_medium: {
    name: 'Средний дом',
    w: 2,
    h: 2,
    cost: { plank: 5, stone: 6 },
    worker: null,
    playerBuildable: true,
    category: 'housing',
    residence: { capacity: 20, everyTicks: 120 },
  },
  house_large: {
    name: 'Большой дом',
    w: 3,
    h: 3,
    cost: { plank: 10, stone: 12 },
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
    // Settlers 4's storage area: 8 piles of 8 units, a good may fill several (siedlercommunity.de,
    // S4Forge.RE `CStorageBuildingRole`).
    storage: { piles: 8, perPile: STORE_PILE },
  },

  woodcutter: {
    name: 'Дом лесоруба',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: 'woodcutter',
    playerBuildable: true,
    category: 'resources',
  },
  forester: {
    name: 'Дом лесничего',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 1 },
    worker: 'forester',
    playerBuildable: true,
    category: 'resources',
  },
  sawmill: {
    name: 'Лесопилка',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 4 },
    worker: 'sawmiller',
    playerBuildable: true,
    category: 'resources',
    recipe: { inputs: { log: 1 }, outputs: { plank: 1 }, ticks: 192 },
  },
  stonecutter: {
    name: 'Каменотёс',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 3 },
    worker: 'stonecutter',
    playerBuildable: true,
    category: 'resources',
  },

  waterworks: {
    name: 'Водокачка',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 3 },
    worker: 'waterman',
    playerBuildable: true,
    category: 'food',
  },
  fisher: { name: 'Рыбак', w: 2, h: 2, cost: { plank: 3, stone: 2 }, worker: 'fisher', playerBuildable: true, category: 'food' },
  hunter: { name: 'Охотник', w: 2, h: 2, cost: { plank: 3, stone: 3 }, worker: 'hunter', playerBuildable: true, category: 'food' },
  farm: {
    name: 'Ферма',
    w: 3,
    h: 3,
    cost: { plank: 6, stone: 6 },
    worker: 'farmer',
    playerBuildable: true,
    category: 'food',
  },
  mill: {
    name: 'Мельница',
    w: 2,
    h: 2,
    cost: { plank: 6, stone: 3 },
    worker: 'miller',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { grain: 1 }, outputs: { flour: 1 }, ticks: 133 },
  },
  bakery: {
    name: 'Пекарня',
    w: 2,
    h: 2,
    cost: { plank: 4, stone: 5 },
    worker: 'baker',
    playerBuildable: true,
    category: 'food',
    recipe: { inputs: { flour: 1, water: 1 }, outputs: { bread: 1 }, ticks: 347 },
  },
  pigfarm: {
    name: 'Свиноферма',
    w: 3,
    h: 3,
    cost: { plank: 6, stone: 6 },
    worker: 'pigfarmer',
    playerBuildable: true,
    category: 'food',
    // Settlers 4: a feeding every 421 of its ticks, a pig with 77 % — a pig every 39 s on average.
    recipe: { inputs: { grain: 1, water: 1 }, outputs: { pig: 1 }, ticks: 299, outputChance: 0.77 },
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
    w: 3,
    h: 3,
    cost: { plank: 6, stone: 6 },
    worker: 'donkeyrancher',
    playerBuildable: true,
    category: 'trade',
    // Settlers 4: a feeding adds a donkey with 25 % — about four feedings per donkey.
    recipe: { inputs: { grain: 1, water: 1 }, outputs: {}, ticks: 192, outputChance: 0.25 },
    breeds: 'donkey',
  },
  slaughterhouse: {
    name: 'Бойня',
    w: 2,
    h: 2,
    cost: { plank: 4, stone: 4 },
    worker: 'butcher',
    playerBuildable: true,
    category: 'food',
    // Settlers 4: one animal, one meat, 178 of its ticks.
    recipe: { inputs: { pig: 1 }, outputs: { meat: 1 }, ticks: 126 },
  },

  // Favourite foods as in Settlers 4: coal and stone bread, iron (and sulfur) meat, gold fish.
  coalmine: mine('Угольная шахта', 'coal', 'bread'),
  ironmine: mine('Железный рудник', 'ironore', 'meat'),
  goldmine: mine('Золотой рудник', 'goldore', 'fish', { plank: 5, stone: 1 }),
  stonemine: mine('Каменоломня в горе', 'stone', 'bread'),

  ironsmelter: {
    name: 'Плавильня железа',
    w: 2,
    h: 2,
    cost: { plank: 4, stone: 6 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { ironore: 1, coal: 1 }, outputs: { iron: 1 }, ticks: 201 },
  },
  goldsmelter: {
    name: 'Плавильня золота',
    w: 2,
    h: 2,
    cost: { plank: 4, stone: 6 },
    worker: 'smelter',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { goldore: 1, coal: 1 }, outputs: { gold: 1 }, ticks: 214 },
  },
  toolsmith: {
    name: 'Инструментальщик',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 5 },
    worker: 'toolsmith',
    playerBuildable: true,
    category: 'metal',
    recipe: { inputs: { iron: 1, coal: 1 }, outputs: {}, outputChoice: TOOLS, keepInStock: 2, orderable: true, ticks: 219 },
  },

  weaponsmith: {
    name: 'Оружейник',
    w: 2,
    h: 2,
    cost: { plank: 5, stone: 7 },
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
    cost: { plank: 3, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    // Settlers 4: the first 3500 S4 tiles of a spiral round the tower, a circle of 31 S4 tiles ≈ 10.4 of ours.
    territory: 10,
    // As in Settlers 4: 1 swordsman + 2 archers.
    garrison: { capacity: 3, keep: 1, archers: 2, door: TOWER_DOOR },
  },
  bigtower: {
    name: 'Большая башня',
    w: 2,
    h: 2,
    cost: { plank: 7, stone: 7 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    // Settlers 4: 4000 S4 tiles, a circle of 33 ≈ 11.1 of ours.
    territory: 11,
    // 3 swordsmen + 3 archers.
    garrison: { capacity: 6, keep: 2, archers: 3, door: TOWER_DOOR },
  },
  barracks: {
    name: 'Казарма',
    w: 3,
    h: 3,
    cost: { plank: 4, stone: 5 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    barracks: { ticks: 10 },
  },
  fortress: {
    // Settlers 4's castle («Burg»), «Замок» to Russian players; with no headquarters the name is free.
    name: 'Замок',
    w: 4,
    h: 4,
    cost: { plank: 8, stone: 12 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    // Settlers 4's castle: 5000 S4 tiles, a circle of 37 ≈ 12.4 of ours.
    territory: 12,
    // The Settlers 4 castle: 4 swordsmen + 5 archers.
    garrison: { capacity: 9, keep: 3, archers: 5, door: TOWER_DOOR },
  },
  lookout: {
    name: 'Смотровая башня',
    w: 2,
    h: 2,
    cost: { plank: 2, stone: 2 },
    worker: null,
    playerBuildable: true,
    category: 'military',
    vision: 16,
  },
  infirmary: {
    name: 'Лазарет',
    w: 2,
    h: 2,
    cost: { plank: 3, stone: 3 },
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
  { type: 'woodcutter', count: 2 },
  { type: 'house_small', count: 1 },
  // Settlers 4's rates: a woodcutter fells a tree a minute, a sawmill cuts three logs a minute; at
  // S4's building costs planks are what an economy waits for, so wood comes first.
  { type: 'woodcutter', count: 3 },
  // The start tower counts: this is the first one built.
  { type: 'tower', count: 2 },
  // No headquarters: the first warehouse takes the start goods off the ground and surplus later on.
  { type: 'warehouse', count: 1 },
  { type: 'woodcutter', count: 4 },
  { type: 'farm', count: 1 },
  { type: 'waterworks', count: 1 },
  { type: 'sawmill', count: 2 },
  { type: 'tower', count: 3 },
  { type: 'mill', count: 1 },
  { type: 'bakery', count: 1 },
  { type: 'fisher', count: 1 },
  { type: 'house_medium', count: 1 },
  { type: 'tower', count: 4 },
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
  { type: 'tower', count: 5 },
  // After the metal chain: without a tool to wait for, a second forester would otherwise grab the
  // space the smelters need early on.
  { type: 'forester', count: 2, after: 'toolsmith' },
  { type: 'woodcutter', count: 4 },
  { type: 'sawmill', count: 2 },
  { type: 'woodcutter', count: 5 },
  { type: 'stonecutter', count: 2, after: 'toolsmith' },
  { type: 'house_large', count: 1 },
  { type: 'ironmine', count: 2, after: 'toolsmith' },
  // A pig is one meat now (Settlers 4): a second pig farm for the slaughterhouse (it keeps up with three).
  { type: 'pigfarm', count: 2, after: 'slaughterhouse' },
  { type: 'weaponsmith', count: 2, after: 'ironsmelter' },
  { type: 'bigtower', count: 1, after: 'weaponsmith' },
  { type: 'tower', count: 8 },
  { type: 'house_large', count: 2 },
  { type: 'bigtower', count: 3, after: 'weaponsmith' },
  { type: 'fortress', count: 1, after: 'goldsmelter' },
  { type: 'tower', count: 13 },
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
  /**
   * Scouting on foot: once its siege towards a castle it has not seen has found no spot for this many
   * ticks (forest, water or swamp in the way), a spare fighter walks to the presumed castle — one at a
   * time, at most every `scoutEvery` ticks, back into a garrison after `scoutTimeout`.
   */
  scoutAfter: 5 * 60 * TICKS_PER_SECOND,
  scoutEvery: 5 * 60 * TICKS_PER_SECOND,
  scoutTimeout: 5 * 60 * TICKS_PER_SECOND,
  /** A siege lookout this close (tiles) beyond its land's nearest point to the goal already watches that edge: no second one there. */
  siegeLookoutSlack: 6,
  /**
   * A siege lookout goes only where the presumed castle lies this much inside its sight (the castle's
   * door is ~2 tiles off the start): one further out sees no castle and takes the edge spot a tower
   * needs to push on.
   */
  siegeLookoutSight: 3,
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
   * …but not while a step of `AI_PLAN` waits only for materials (none of them short for good) and it
   * is not cramped: the economy first, or a large start army (Settlers 4's) turns every plank into a
   * tower.
   */
  economyFirst: true,
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
  /** Gathered resources that do not grow back (stone; fish as in Settlers 4): their gatherers are moved once nothing is left in range. */
  exhaustible: ['stone', 'fish'] as readonly Resource[],
  /**
   * Score taken off a military building's or lookout's spot that a digger must level first (up to
   * `BUILD_DIG_SLOPE`; all else keeps to level ground): level ground first, but a slope facing the
   * enemy beats no push at all.
   */
  slopePenalty: 5,
  /** Best-scored spots tried with `canPlace` per placement. */
  placeTries: 40,
  /** The last this-many units of a tool are kept for the first building of a type that needs it. */
  keepTools: 1,
  /**
   * Its army make-up (weights for `World.setShare`). S4 garrisons have more archer slots than before,
   * and archers in a tower let its swordsman go on an attack (a tower keeps one fighter), so more bows
   * than it used to make; swordsmen still lead, as only they capture.
   */
  weaponShares: { sword: 55, bow: 45, armor: 0 } as Partial<Record<Resource, number>>,
  /**
   * The fighters it orders at its barracks, endlessly, at levels 1 to its difficulty's
   * `recruitLevels` (`AI_LEVELS`; Settlers 4's AI: level 1, on «normal» and «hard» 2 and 3 as well).
   */
  recruitKinds: ['soldier', 'archer'] as readonly SettlerKind[],
  /**
   * Garrisons (`muster`): its military buildings within `fillRange` tiles of a known enemy military
   * building, or at its border (land not its own at any of `borderSamples` points just beyond their
   * reach), are filled; those deep inside keep the one fighter a building calls by itself. The rest of
   * its fighters gather `rallyBack` tiles behind the door of its manned military building nearest the
   * enemy, regrouped only when the point moves more than `rallySlack` tiles.
   */
  fillRange: 24,
  borderSamples: 16,
  rallyBack: 3,
  rallySlack: 6,
  /** Enemy fighters it sees standing outdoors this close (tiles) to a target's door count as its defenders. */
  guardRadius: 8,
  /**
   * Materials it keeps back while nothing of its own still produces them (its stone deposits are
   * worked out): only producers of that material may use the reserve; border-pushing military
   * buildings may use it down to `reserveFloor`, so it can still reach new deposits and always keeps
   * enough to open a quarry of it (a stonecutter's 3 stone).
   */
  reserve: { stone: 9 } as Partial<Record<Resource, number>>,
  reserveFloor: { stone: 3 } as Partial<Record<Resource, number>>,
  /**
   * Warehouses hold only so much (`StorageDef`, `storage.ts`): with fewer than `storeFreePiles` free
   * piles left in its finished ones it builds another, up to `maxStores` in all (the castle counts),
   * once it has a `storeAfter` and room to spare — before that a full castle only pauses producers.
   */
  storeFreePiles: 6,
  maxStores: 3,
  storeAfter: 'barracks' as BuildingType,
  /** At most one eyecatcher per this many own buildings, built only while it holds `decorSpare`. */
  decorEvery: 8,
  decorSpare: { stone: 26, plank: 14 } as Partial<Record<Resource, number>>,
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
  borderReserve: 3,
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
  /** Best pioneer spots offered per decision: one he cannot walk to is refused, the next is tried. */
  pioneerTries: 6,
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
  stageTimeout: 1800,
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
   * The hunt (`DEFEAT.fighters`: a player is out only once his last fighter is): fighters of an enemy
   * it knows no military building of — stragglers left standing when his towers fell — seen outdoors by
   * its buildings are hunted by a field squad `huntRatio` times their number (at least `huntMin`), from
   * the spares of its military buildings nearest them; back into garrisons when none are left in sight.
   */
  huntRatio: 1.5,
  huntMin: 2,
  /**
   * Trade (`AiState.trade`): every `tradeEvery` ticks it checks for own workplaces on land cut off
   * from its warehouses; for the first such piece it builds a market there and one at home, a donkey
   * ranch, and sends by donkey what the piece's sites and workplaces lack. Cut-off sites nothing was
   * delivered to yet are demolished instead (a stuck site holds one of `maxOpenSites`).
   */
  tradeEvery: 300,
};

/**
 * Computer player difficulty, chosen per opponent in the game setup (`WorldOptions.difficulty`,
 * kept in the saved `AiState.level`). A level scales the `AI` tuning, so `medium` is exactly the `AI`
 * table (what `sim:ai` measures): `think` multiplies `AI.thinkEvery` (how often it decides), `attack`
 * the `AI.attackRatio` it wants over the defenders, `peace` `AI.peaceTicks` (no attacks before),
 * `cooldown` `AI.attackCooldown`; `sites` is added to `AI.maxOpenSites`; `bonus` goods lie by its
 * start tower on top of the start level's (S4's script adds goods for computer players too).
 */
export type AiLevel = 'easy' | 'medium' | 'hard';
export interface AiLevelDef {
  name: string;
  /** Recruit levels it orders (1–3, `AI.recruitKinds`). */
  recruitLevels: number;
  think: number;
  attack: number;
  peace: number;
  cooldown: number;
  sites: number;
  bonus: Partial<Stock>;
}
export const AI_LEVELS: Record<AiLevel, AiLevelDef> = {
  easy: { name: 'Лёгкий', recruitLevels: 1, think: 2, attack: 1.6, peace: 1.6, cooldown: 2, sites: -1, bonus: {} },
  medium: { name: 'Средний', recruitLevels: 3, think: 1, attack: 1, peace: 1, cooldown: 1, sites: 0, bonus: {} },
  hard: { name: 'Тяжёлый', recruitLevels: 3, think: 0.6, attack: 0.85, peace: 0.7, cooldown: 0.75, sites: 1, bonus: { plank: 12, stone: 8, fish: 6, bread: 6 } },
};
export const AI_LEVEL_IDS = Object.keys(AI_LEVELS) as AiLevel[];

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
  /** Tiles per tick while moving (they amble: a share of the settlers' `SETTLER_SPEED`; no S4 source). */
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
    speed: 0.35 * SETTLER_SPEED,
    herd: [2, 4],
    herds: 2,
    roam: 6,
    rest: [30, 120],
    game: 'meat',
    respawnEvery: 1200,
  },
  donkey: { name: 'Осёл', habitat: 'meadow', speed: 0.2 * SETTLER_SPEED, herd: [1, 3], herds: 1, roam: 5, rest: [60, 200] },
  duck: { name: 'Утка', habitat: 'shore', speed: 0.16 * SETTLER_SPEED, herd: [2, 5], herds: 2, roam: 4, rest: [20, 90] },
  chicken: { name: 'Курица', habitat: 'meadow', speed: 0.2 * SETTLER_SPEED, herd: [3, 6], herds: 1, roam: 3, rest: [10, 60] },
} satisfies Record<string, AnimalDef>;

export type AnimalKind = keyof typeof ANIMALS;
export const ANIMAL_KINDS = Object.keys(ANIMALS) as AnimalKind[];
/** Herds keep at least this far (tiles) from every start position. */
export const ANIMAL_START_CLEARANCE = 12;

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
