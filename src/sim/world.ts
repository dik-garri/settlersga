import { addBuilding, centerOf, doorOf, ruinGoods, spawnSettler, updateBuilding } from './buildings';
import { claimChanged, clearLand, recomputeTerritory } from './territory';
import {
  AI_LEVELS,
  type AiLevel,
  BUILD_DIG_SLOPE,
  type BuildGround,
  BUILD_TICKS_PER_UNIT,
  BUILDINGS,
  DEFEAT,
  DISPATCH_EVERY,
  GROUND,
  MAP_SIZE,
  RUIN,
  ORDERABLE,
  OUTPUT_SHARES,
  PROFESSIONS,
  SITE,
  START_CONDITIONS,
  type StartLevel,
  totalCost,
} from './config';
import { dropGoods, rebuildStacks } from './ground';
import { applyScenario, type ScenarioDef } from './scenario';
import { bedsFor, carriersFor, startBeds, updateStrikes } from './beds';
import { setStopped } from './stop';
import { landOf } from './land';
import { levelTarget, needsDigger, needsLevelling } from './digging';
import {
  dismissSpecialist,
  dismissUnits,
  sendGeologist,
  holdSpecialists,
  orderSpecialists,
  sendPioneer,
  sendThief,
} from './specialists';
import { formationSpots, orderAttack, orderGarrison, orderHold, orderMove, releaseFighters } from './field';
import { updateIntruders } from './intruders';
import { updateInfirmary } from './infirmary';
import { updateLookout } from './lookout';
import { attackStrength } from './strength';
import {
  createEconomy,
  ENDLESS,
  moveTransport,
  orderRecruits,
  orderTool,
  orderWorkers,
  recruitOrder,
  reduceRecruits,
  setAccepts,
  setCarrierReserve,
  setDistribution,
  workerOrder,
  type EconomyState,
  type TransportMove,
} from './economy';
import { rebuildWorn, updatePaths } from './paths';
import { setWorkArea } from './workArea';
import { dispatch } from './logistics';
import { createAi, updateAi, type AiState } from './ai';
import { spawnAnimals, updateAnimals, type Animal } from './animals';
import {
  assaultsByTarget,
  attack,
  attackerComposition,
  availableAttackers,
  changeGarrison,
  enterGarrison,
  fillGarrison,
  isFighter,
  isMilitary,
  leaveGarrison,
  pruneShots,
  removeDead,
  updateBarracks,
  updateGarrison,
  withdrawGarrison,
} from './military';
import type { GameMessage } from './messages';

/** A player's war record (`World.stats.war`). */
/** A burnt building's remains (`World.ruins`, visual only): its footprint, type and owner, when it burnt. */
export interface Ruin {
  x: number;
  y: number;
  w: number;
  h: number;
  type: BuildingType;
  owner: PlayerId;
  tick: number;
  /** Tick it is gone (`RUIN.ticks` after it burnt). */
  until: number;
}

export interface WarStats {
  killed: Partial<Record<SettlerKind, number>>;
  fallen: Partial<Record<SettlerKind, number>>;
  captured: number;
  lostBuildings: number;
}
import { generateMap, type GameMap } from './map';
import { createFog, ensureVision, isExplored, isVisible, resetSightMasks, updateFog, type FogState } from './fog';
import { rebuildGrowing, updateNature } from './nature';
import { findPath, staysConnected } from './pathfinding';
import { createRng, type Rng } from './rng';
import { mapFromSave, restoreWorld, type SaveData } from './save';
import { markWalkable } from './regions';
import { abort, updateSettler } from './settlers';
import {
  emptyStock,
  RESOURCES,
  type Building,
  type BuildingType,
  type PlayerId,
  type Point,
  type Resource,
  type Settler,
  type SettlerKind,
  type Stock,
} from './types';

export { doorOf } from './buildings';

/**
 * Start positions (where each player's start tower stands): the map center for one player, otherwise
 * evenly spaced on a circle around it (two players sit in opposite corners of the diagonal).
 */
export function startPositions(size: number, players: number): { x: number; y: number }[] {
  const c = Math.floor(size / 2);
  if (players <= 1) return [{ x: c, y: c }];
  const r = size * 0.3;
  return Array.from({ length: players }, (_, k) => {
    const a = Math.PI / 4 + (2 * Math.PI * k) / players;
    return { x: Math.round(c + r * Math.cos(a)), y: Math.round(c + r * Math.sin(a)) };
  });
}

/** The player sitting at this browser. */
export const LOCAL_PLAYER: PlayerId = 1;

export interface Player {
  id: PlayerId;
  /**
   * Where the player started: the door of its start tower (Settlers 4 has no headquarters). Stays
   * put when that tower is lost; the camera, path checks and the AI's sense of home use it.
   */
  home: Point;
  /** The player's weights for share-controlled outputs (weapons); missing ones use `OUTPUT_SHARES`. */
  shares?: Partial<Record<Resource, number>>;
  /** Alliance: players with the same team never fight and win together; none = on its own. */
  team?: number;
  /** Worker orders, toolsmith queue, goods distribution (`economy.ts`). */
  economy?: EconomyState;
  /** Beds the player started with, besides its houses' (`beds.ts`, Settlers 4's initial free beds). */
  startBeds?: number;
}

export interface WorldOptions {
  /** Map edge length in tiles. */
  size?: number;
  /** Number of players, each with a start tower (default 1). Player 1 is `LOCAL_PLAYER`. */
  players?: number;
  /** Players controlled by the computer (see `ai.ts`). */
  ai?: PlayerId[];
  /** Team of each player, by player index (e.g. [1, 1, 2, 2]): allies never fight and win together. */
  teams?: number[];
  /** Restore this snapshot instead of generating a new world (see `World.load`). */
  from?: SaveData;
  /** Start goods and workers, as in Settlers 4 (default `medium`). */
  start?: StartLevel;
  /**
   * Difficulty of each computer player, by player index like `teams` (default `medium`); a level's
   * `bonus` goods lie by that player's start tower.
   */
  difficulty?: AiLevel[];
  /**
   * A scenario's ready-made start (`scenario.ts`: finished buildings, goods, people, beds), applied
   * after the players' own starts and before the computer players' start help.
   */
  scenario?: ScenarioDef;
}

/**
 * The whole simulation state plus its public API. The per-topic logic lives in sibling modules
 * (buildings, settlers, logistics, nature) that operate on this object.
 */
export class World {
  readonly map: GameMap;
  readonly buildings = new Map<number, Building>();
  readonly settlers: Settler[] = [];
  readonly players: Player[] = [];
  readonly stats: {
    produced: Stock;
    lost: Stock;
    treesPlanted: number;
    prospected: number;
    trained: number;
    /** Intruding specialists killed on hostile land (`intruders.ts`). */
    intrudersKilled: number;
    /** Per player (Settlers 4's fighters statistics): enemies killed and own settlers fallen by kind, buildings taken and lost (`military.ts`). */
    war: Record<number, WarStats>;
  } = {
    produced: emptyStock(),
    lost: emptyStock(),
    treesPlanted: 0,
    prospected: 0,
    trained: 0,
    intrudersKilled: 0,
    war: {},
  };
  tick = 0;
  /** Bumped whenever the territory changes, so views can redraw the border. */
  territoryVersion = 0;
  /** Bumped whenever a building is added or removed (derived, not saved; drives fog vision). */
  buildingsVersion = 0;
  /** Piece of land of every owned tile (`land.ts`; derived from `map.owner`, rebuilt with the territory). */
  land = new Int32Array(0);
  landPieces = 0;
  /** `territoryVersion` that `land` was built for. */
  landVersion = -1;
  /** Cache of `land.ts`: pieces holding a warehouse, valid while `buildingsVersion` is `storedPiecesAt`. */
  storedPieces: Set<number> | null = null;
  storedPiecesAt = -1;

  // Internal state shared by the sim modules.
  readonly rng: Rng;
  readonly settlerById = new Map<number, Settler>();
  /** Trees and stone deposits a gatherer is heading for. */
  readonly reservedTargets = new Set<number>();
  /** Tiles a planter is on the way to plant. */
  readonly reservedPlots = new Set<number>();
  /** Saplings, unripe fields and stubble whose growth timer runs (`nature.ts`); derived, rebuilt on load. */
  readonly growing = new Set<number>();
  /** Tiles with path wear (`paths.ts`); derived from `map.wear`, so not saved. */
  readonly worn = new Set<number>();
  /** Settlers killed this tick; dropped from `settlers` at its end (see `killSettler`). */
  readonly dying = new Set<number>();
  /** Arrows in flight, for drawing only: damage is applied when shot. Derived, not saved. */
  shots: { x0: number; y0: number; x1: number; y1: number; tick: number; owner: PlayerId }[] = [];
  /**
   * Burnt buildings' remains, for drawing only (`RUIN`): they block nothing, nothing in the simulation
   * reads them, so they are not saved (a loaded game shows none). Dropped once `until` has passed.
   */
  ruins: Ruin[] = [];
  /**
   * Messages for players with a place on the map (`messages.ts`, Settlers 4's warnings), oldest first,
   * the last `MESSAGE_KEEP`. Nothing in the simulation reads them, so they are not saved.
   */
  readonly messages: GameMessage[] = [];
  /** The messages under their old name (an empty military building, a barracks with no carrier…). */
  get warnings(): readonly GameMessage[] {
    return this.messages;
  }
  /** Computer players' state (saved). */
  readonly ai: AiState[] = [];
  /** Players with no occupied military building left (`DEFEAT`), in order of defeat (saved). */
  readonly defeated: PlayerId[] = [];
  /** Current sight per player (derived; what was ever seen is `map.explored`). See fog.ts. */
  readonly fog: FogState = createFog();
  nextId = 1;
  /** Wild animals (`animals.ts`, saved), with their own id counter and random stream. */
  readonly animals: Animal[] = [];
  nextAnimalId = 1;
  readonly animalRng: Rng;
  /** Random stream of the idle crowds (`idle.ts`), so they never shift the economy's own RNG. */
  readonly idleRng: Rng;
  /** Tiles with goods on the ground (`ground.ts`; derived from `map.goods`, rebuilt on load). */
  readonly stacks = new Set<number>();
  /** `stacks` in index order, rebuilt when a stack appears or goes (derived). */
  stackOrder: number[] | null = null;
  /**
   * Buildings a scenario named (`ScenarioBuilding.tag` → id), for whoever started it (the tutorial
   * resolves its anchors from them at once). Not saved; nothing in the simulation reads it.
   */
  readonly tags = new Map<string, number>();

  constructor(seed = 1, opts: WorldOptions = {}) {
    this.rng = createRng(seed ^ 0x9e3779b9);
    this.animalRng = createRng(seed ^ 0x2545f491);
    this.idleRng = createRng(seed ^ 0x6a09e667);
    if (opts.from) {
      this.map = mapFromSave(opts.from);
      restoreWorld(this, opts.from);
      rebuildGrowing(this);
      rebuildWorn(this);
      rebuildStacks(this);
      return;
    }
    const size = opts.size ?? MAP_SIZE;
    const starts = startPositions(size, opts.players ?? 1);
    this.map = generateMap(seed, size, starts);
    rebuildGrowing(this);
    for (const st of starts) this.addPlayer(st, opts.start ?? 'medium');
    opts.teams?.forEach((team, k) => {
      if (this.players[k] && Number.isFinite(team)) this.players[k].team = team;
    });
    resetSightMasks(this);
    if (opts.scenario) applyScenario(this, opts.scenario);
    for (const p of opts.ai ?? []) {
      if (!this.players.some((pl) => pl.id === p)) continue;
      const level = opts.difficulty?.[p - 1] ?? 'medium';
      this.ai.push(createAi(p, level));
      this.aiStart(p, level);
    }
    spawnAnimals(this, starts);
  }

  /**
   * Settlers 4's start help for a computer player (`StartResources.txt`, `AI_LEVELS[level]`): its
   * `bonus` goods on the ground by the start tower and its `people` — pioneers waiting for orders (the
   * order grows with them), swordsmen of level 1 standing free in front of the tower.
   */
  private aiStart(p: PlayerId, level: AiLevel): void {
    const def = AI_LEVELS[level];
    const home = this.homeOf(p);
    const tower = [...this.buildings.values()].find((b) => b.owner === p);
    if (!tower) return;
    const c = centerOf(tower);
    for (const [res, n] of Object.entries(def.bonus) as [Resource, number][]) dropGoods(this, { x: Math.round(c.x), y: Math.round(c.y) }, res, n);
    const free: Settler[] = [];
    for (const [kind, n] of Object.entries(def.people) as [SettlerKind, number][]) {
      for (let i = 0; i < n; i++) {
        const s = spawnSettler(this, kind, tower);
        if (isFighter(s)) free.push(s);
      }
      if (ORDERABLE.includes(kind)) orderWorkers(this, p, kind, workerOrder(this, p, kind) + n);
    }
    const spots = formationSpots(this, home.x, home.y + 3, free.length);
    free.forEach((s, k) => {
      const at = spots[Math.min(k, spots.length - 1)] ?? home;
      s.inside = null;
      s.x = s.px = at.x;
      s.y = s.py = at.y;
    });
  }

  /** The computer player's difficulty, or null for a human player. */
  aiLevel(player: PlayerId): AiLevel | null {
    const ai = this.ai.find((a) => a.player === player);
    return ai ? (ai.level ?? 'medium') : null;
  }

  static load(save: SaveData): World {
    return new World(0, { from: save });
  }

  /**
   * A new player at start position `st`, as in Settlers 4 (`StartResources.txt`): the start level's
   * building (a small tower), finished and centred on the start, held by one swordsman (what its
   * first call for a fighter brings, `GARRISON_ORDERS`; the others stand free by it); its people; and
   * its goods on the ground round it, pile by pile (`ground.ts`).
   */
  private addPlayer(st: Point, start: StartLevel): Player {
    const id = this.players.length + 1;
    const def = START_CONDITIONS[start];
    const { w: bw, h: bh } = BUILDINGS[def.building];
    const x = st.x - Math.floor(bw / 2);
    const y = st.y - Math.floor(bh / 2);
    if (!this.canPlace(def.building, x, y, id, true)) throw new Error('start building placement failed');
    const tower = addBuilding(this, def.building, x, y, id, true);
    const player: Player = { id, home: { ...tower.door }, economy: createEconomy(start), startBeds: startBeds(def.carriers) };
    this.players.push(player);
    const fighters: [SettlerKind, number][] = [
      ['soldier', def.soldiers],
      ['archer', def.archers],
    ];
    const free: Settler[] = [];
    for (const [kind, n] of fighters) {
      for (let i = 0; i < n; i++) {
        const s = spawnSettler(this, kind, tower);
        if (tower.garrison.length === 0 && kind === 'soldier') enterGarrison(this, tower, s);
        else free.push(s);
      }
    }
    // The rest stand free in front of the tower, spread out.
    const spots = formationSpots(this, tower.door.x, tower.door.y + 2, free.length);
    free.forEach((s, k) => {
      const at = spots[Math.min(k, spots.length - 1)] ?? tower.door;
      s.inside = null;
      s.x = s.px = at.x;
      s.y = s.py = at.y;
    });
    claimChanged(this, tower);
    const people: [SettlerKind, number][] = [
      ['carrier', def.carriers],
      ['builder', def.builders],
      ['digger', def.diggers],
      ['geologist', def.geologists],
      ['donkey', def.donkeys],
      ...(Object.entries(def.workers) as [SettlerKind, number][]),
    ];
    for (const [kind, n] of people) for (let i = 0; i < n; i++) spawnSettler(this, kind, tower);
    const c = centerOf(tower);
    for (const [res, n] of def.piles) dropGoods(this, { x: Math.round(c.x), y: Math.round(c.y) }, res, n);
    return player;
  }

  // ---------------------------------------------------------------- queries

  /** Where the player started: its start tower's door (see `Player.home`). */
  homeOf(player: PlayerId = LOCAL_PLAYER): Point {
    return this.players[player - 1].home;
  }

  /**
   * Whether the building fits there: buildable ground of its terrain (no goods lying on it either),
   * the footprint and door on the player's land — or, `founding` a player's start, on nobody's.
   */
  canPlace(type: BuildingType, x: number, y: number, player: PlayerId = LOCAL_PLAYER, founding = false): boolean {
    const def = BUILDINGS[type];
    const owned = (tx: number, ty: number) =>
      founding ? this.map.inBounds(tx, ty) && this.map.owner[this.map.idx(tx, ty)] === 0 : this.owns(tx, ty, player);
    const ground: BuildGround = def.terrain === 'mountain' ? 'mountain' : 'ground';
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        if (!this.map.isBuildable(x + dx, y + dy, ground) || !owned(x + dx, y + dy)) return false;
      }
    }
    const door = doorOf(x, y, def.w, def.h);
    // Mines sit on slopes; everything else needs fairly level ground under the footprint and door
    // (steeper than BUILD_MAX_SLOPE is allowed, but a digger levels it first).
    if (def.terrain !== 'mountain' && this.map.heightRange(x, y, x + def.w - 1, y + def.h) > BUILD_DIG_SLOPE) return false;
    const di = this.map.idx(door.x, door.y);
    return (
      this.map.isWalkable(door.x, door.y) &&
      this.map.door[di] === 0 &&
      this.map.goods[di] === 0 &&
      owned(door.x, door.y) &&
      this.footprintKeepsConnected(x, y, def.w, def.h)
    );
  }

  /** Blocking the footprint tile by tile must never cut a walking route (see `staysConnected`). */
  private footprintKeepsConnected(x: number, y: number, w: number, h: number): boolean {
    const m = this.map;
    const blocked: number[] = [];
    let ok = true;
    for (let dy = 0; dy < h && ok; dy++) {
      for (let dx = 0; dx < w && ok; dx++) {
        if (!staysConnected(m, x + dx, y + dy)) ok = false;
        else {
          const i = m.idx(x + dx, y + dy);
          m.building[i] = -1; // temporary marker, restored below
          blocked.push(i);
        }
      }
    }
    for (const i of blocked) m.building[i] = 0;
    return ok;
  }

  owns(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return this.map.inBounds(x, y) && this.map.owner[this.map.idx(x, y)] === player;
  }

  buildingAt(x: number, y: number): Building | undefined {
    if (!this.map.inBounds(x, y)) return undefined;
    const i = this.map.idx(x, y);
    const id = this.map.building[i] || this.map.door[i];
    return id ? this.buildings.get(id) : undefined;
  }

  getSettler(id: number | null): Settler | undefined {
    return id === null ? undefined : this.settlerById.get(id);
  }

  /** Construction progress in [0, 1]. */
  buildProgress(b: Building): number {
    if (b.done) return 1;
    return b.progress / (totalCost(b.type) * BUILD_TICKS_PER_UNIT);
  }

  isDefeated(player: PlayerId): boolean {
    return this.defeated.includes(player);
  }

  /** Same player, or players on the same team: they never fight each other and win together. */
  allied(a: PlayerId, b: PlayerId): boolean {
    if (a === b) return true;
    const ta = this.players[a - 1]?.team;
    return ta !== undefined && ta === this.players[b - 1]?.team;
  }

  /**
   * 'won' once every player not allied with this one is defeated (allies win together), 'lost' once
   * this one is, else 'playing'.
   */
  outcome(player: PlayerId = LOCAL_PLAYER): 'playing' | 'won' | 'lost' {
    if (this.isDefeated(player)) return 'lost';
    const foes = this.players.filter((p) => !this.allied(p.id, player));
    return foes.length > 0 && foes.every((p) => this.isDefeated(p.id)) ? 'won' : 'playing';
  }

  /**
   * A player with nothing left to fight with is out (`DEFEAT`, `checkDefeats`): its buildings burn —
   * the goods lying at them stay on the ground (`GROUND`) —, its land goes back to nobody (and to
   * whoever's towers cover it, `territory.ts`), and its settlers drop what they were doing and wander
   * off until they die (`flee.ts`).
   */
  defeatPlayer(player: PlayerId): void {
    if (this.isDefeated(player)) return;
    this.defeated.push(player);
    for (const b of [...this.buildings.values()]) {
      if (b.owner === player && this.buildings.has(b.id)) this.removeBuilding(b, 'burn');
    }
    clearLand(this, player);
    recomputeTerritory(this);
    for (const s of this.settlers) {
      if (s.owner !== player || this.dying.has(s.id)) continue;
      abort(this, s);
      s.home = null;
      s.inside = null;
      s.post = null;
      s.errand = null;
    }
  }

  /** Whether the player still has something to fight with: an occupied military building, or (`DEFEAT.fighters`) a fighter. */
  holdsOn(player: PlayerId): boolean {
    for (const b of this.buildings.values()) if (b.owner === player && b.done && isMilitary(b) && b.garrison.length > 0) return true;
    if (!DEFEAT.fighters) return false;
    return this.settlers.some((s) => s.owner === player && isFighter(s) && !this.dying.has(s.id));
  }

  /**
   * Every `DEFEAT.checkEvery` ticks: players with no occupied military building — and no fighter
   * left, with `DEFEAT.fighters` — are defeated.
   */
  private checkDefeats(): void {
    if (this.tick < DEFEAT.afterTick || this.tick % DEFEAT.checkEvery !== 0) return;
    const holding = new Set<PlayerId>();
    for (const b of this.buildings.values()) if (b.done && isMilitary(b) && b.garrison.length > 0) holding.add(b.owner);
    if (DEFEAT.fighters) for (const s of this.settlers) if (isFighter(s) && !this.dying.has(s.id)) holding.add(s.owner);
    for (const p of this.players) if (!holding.has(p.id) && !this.isDefeated(p.id)) this.defeatPlayer(p.id);
  }

  /** Fog of war: has the player ever seen the tile? */
  isExplored(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return this.map.inBounds(x, y) && isExplored(this, this.map.idx(x, y), player);
  }

  /** Fog of war: does the player see the tile right now (own buildings or settlers nearby)? */
  isVisible(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return this.map.inBounds(x, y) && isVisible(this, this.map.idx(x, y), player);
  }

  isProspected(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return this.map.inBounds(x, y) && (this.map.prospected[this.map.idx(x, y)] & (1 << (player - 1))) !== 0;
  }

  // --------------------------------------------------------------- commands

  /**
   * Player command: the weight (0–100) of a share-controlled output (`OUTPUT_SHARES`: swords, bows,
   * armour) in what the weaponsmith forges. False for other resources.
   */
  setShare(res: Resource, weight: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const p = this.players.find((q) => q.id === player);
    if (!p || OUTPUT_SHARES[res] === undefined || !Number.isFinite(weight)) return false;
    p.shares = { ...p.shares, [res]: Math.max(0, Math.min(100, Math.round(weight))) };
    return true;
  }

  /** The player's current weight for a share-controlled output. */
  shareOf(res: Resource, player: PlayerId = LOCAL_PLAYER): number {
    const p = this.players.find((q) => q.id === player);
    return p?.shares?.[res] ?? OUTPUT_SHARES[res] ?? 0;
  }

  /**
   * Player command (Settlers 4's barracks orders): `count` more recruits of a fighting profession at a
   * level (index into its `combat.levels`), `ENDLESS` for no end, 0 to clear. The player's barracks
   * recruit nobody else (`military.ts`).
   */
  orderRecruits(kind: SettlerKind, level: number, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return orderRecruits(this, player, kind, level, count);
  }

  /** Player command: `count` fewer recruits of `kind` at `level` ordered (an endless order counts as 100). */
  reduceRecruits(kind: SettlerKind, level: number, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return reduceRecruits(this, player, kind, level, count);
  }

  /** Recruits of `kind` at `level` the player still orders (`ENDLESS`, or a count; 0 = none). */
  recruitOrder(kind: SettlerKind, level: number, player: PlayerId = LOCAL_PLAYER): number {
    return recruitOrder(this, player, kind, level);
  }

  /** Player command (Settlers 4 «fill»): the military building calls fighters in for every slot. */
  fillGarrison(id: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return fillGarrison(this, id, player);
  }

  /**
   * Player command: one swordsman (`archer` false) or archer more (`delta` 1) or fewer (−1) wished in
   * the military building — never below one fighter in all (Settlers 4).
   */
  changeGarrison(id: number, archer: boolean, delta: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return changeGarrison(this, id, archer, delta, player);
  }

  /** Player command (Settlers 4 «withdraw»): the military building keeps one fighter, the rest step out. */
  withdrawGarrison(id: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return withdrawGarrison(this, id, player);
  }

  /** Player command: how many of an orderable profession (builders, diggers) to have in all. */
  orderWorkers(kind: SettlerKind, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return orderWorkers(this, player, kind, count);
  }

  /** Player command: carriers kept free — none takes up a job below this (Settlers 4's reserve, `CARRIER_RESERVE`). */
  setCarrierReserve(count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return setCarrierReserve(this, player, count);
  }

  /** Player command: move a good up or down the transport priority (or to its top or bottom). */
  moveTransport(res: Resource, how: TransportMove, player: PlayerId = LOCAL_PLAYER): boolean {
    return moveTransport(this, player, res, how);
  }

  /** Player command: queue `count` more of a tool at the toolsmiths (`ENDLESS` = keep making, 0 = clear). */
  orderTool(res: Resource, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return orderTool(this, player, res, count);
  }

  /** Player command: weight (0–100) of a consumer type in the distribution of a good. */
  setDistribution(res: Resource, type: BuildingType, weight: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return setDistribution(this, player, res, type, weight);
  }

  /** Player command: whether a warehouse takes in a good. */
  setAccepts(id: number, res: Resource, on: boolean, player: PlayerId = LOCAL_PLAYER): boolean {
    return setAccepts(this, player, id, res, on);
  }

  /**
   * Player command (Settlers 4): centre a gatherer's, planter's or hunter's work area on (x, y) — at
   * most `WORK_AREA.maxShift` × its radius from the door — or back at the door with null.
   */
  setWorkArea(id: number, at: Point | null, player: PlayerId = LOCAL_PLAYER): boolean {
    return setWorkArea(this, id, at, player);
  }

  /**
   * Player command: a marketplace's donkeys carry its ordered goods to market `to` (another
   * market of the player, also a site), or nowhere (`null`). See `trade.ts`.
   */
  setTradeRoute(id: number, to: number | null, player: PlayerId = LOCAL_PLAYER): boolean {
    const m = this.buildings.get(id);
    if (!m || m.owner !== player || !BUILDINGS[m.type].market) return false;
    if (to !== null) {
      const t = this.buildings.get(to);
      if (!t || t.id === id || t.owner !== player || !BUILDINGS[t.type].market) return false;
    }
    m.trade ??= { to: null, orders: {}, loading: {} };
    m.trade.to = to;
    return true;
  }

  /**
   * Player command: send `count` more units of `res` from this market along its route — or `ENDLESS`
   * to keep sending, or 0 to cancel the order.
   */
  orderTrade(id: number, res: Resource, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const m = this.buildings.get(id);
    if (!m || m.owner !== player || !BUILDINGS[m.type].market || !RESOURCES.includes(res)) return false;
    m.trade ??= { to: null, orders: {}, loading: {} };
    const now = m.trade.orders[res] ?? 0;
    if (count === ENDLESS || count === 0) {
      if (count === 0) {
        delete m.trade.orders[res];
        // Carriers already bringing the good turn back (their load returns to a warehouse) —
        // otherwise it would keep arriving and sit on the market with nothing to take it away.
        for (const s of this.settlers) {
          if (s.owner === player && s.tasks.some((t) => t.t === 'drop' && t.b === id && t.res === res)) abort(this, s);
        }
        // What waits for a donkey goes on the output pile, so carriers take it back to a warehouse.
        const spare = m.input[res] - (m.trade.loading[res] ?? 0);
        if (spare > 0) {
          m.input[res] -= spare;
          m.output[res] += spare;
        }
      } else m.trade.orders[res] = ENDLESS;
    } else if (count > 0 && now !== ENDLESS) {
      m.trade.orders[res] = now + count;
    }
    return true;
  }

  /**
   * Player command: serve this building first (materials, inputs, builders and diggers). For a site it
   * is Settlers 4's hard priority (`SITE`): while it needs a material nobody else on its piece of land
   * gets any; at most `SITE.maxPriority` prioritised sites per piece, the flag goes once it is built.
   */
  setPriority(id: number, on: boolean, player: PlayerId = LOCAL_PLAYER): boolean {
    const b = this.buildings.get(id);
    if (!b || b.owner !== player) return false;
    if (on && !b.priority && !b.done) {
      const piece = landOf(this, b);
      let n = 0;
      for (const o of this.buildings.values()) if (o.owner === player && o.priority && !o.done && landOf(this, o) === piece) n++;
      if (n >= SITE.maxPriority) return false;
    }
    b.priority = on;
    return true;
  }

  /**
   * Player command (Settlers 4's `Switch`): stop a workplace, warehouse, market or site, or let it run
   * again (`stop.ts`).
   */
  setStopped(id: number, on: boolean, player: PlayerId = LOCAL_PLAYER): boolean {
    return setStopped(this, id, on, player);
  }

  /** The player's beds, carriers and striking carriers (`beds.ts`, Settlers 4's strike). */
  bedsOf(player: PlayerId = LOCAL_PLAYER): { beds: number; carriers: number; striking: number } {
    return { beds: bedsFor(this, player), ...carriersFor(this, player) };
  }

  /**
   * Player command: tear down a building. As in Settlers 4 half of its materials (of a site, half of
   * what was built in) and every good lying at it stay on the ground (`GROUND`); every job involving
   * it is cancelled (goods in hands are put down), its worker keeps his profession and waits for the
   * next workplace of it (`isReadyWorker`) and the tiles become free.
   */
  demolish(id: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const b = this.buildings.get(id);
    if (!b || b.owner !== player || !BUILDINGS[b.type].playerBuildable) return false;
    this.removeBuilding(b, 'demolish');
    return true;
  }

  /** Player command: send up to `count` spare soldiers in range against an enemy military building. */
  attack(targetId: number, count: number, player: PlayerId = LOCAL_PLAYER): number {
    return attack(this, targetId, count, player);
  }

  /** The fighters `attack` would send (up to `count`), for showing the composition before attacking. */
  attackerComposition(targetId: number, count: number, player: PlayerId = LOCAL_PLAYER): Settler[] {
    return attackerComposition(this, targetId, count, player);
  }

  /**
   * Direct army control (`field.ts`): move fighters to a point as field units (in formation; with a
   * squad leader among them the others follow him), let them hold where they stand, attack an enemy
   * military building from wherever they are, or go into a garrison (`buildingId` null: the nearest
   * with room). Each returns how many fighters obeyed.
   */
  orderMove(ids: readonly number[], x: number, y: number, player: PlayerId = LOCAL_PLAYER): number {
    return orderMove(this, ids, x, y, player);
  }

  orderHold(ids: readonly number[], player: PlayerId = LOCAL_PLAYER): number {
    return orderHold(this, ids, player);
  }

  orderAttack(ids: readonly number[], targetId: number, player: PlayerId = LOCAL_PLAYER): number {
    return orderAttack(this, ids, targetId, player);
  }

  orderGarrison(ids: readonly number[], buildingId: number | null, player: PlayerId = LOCAL_PLAYER): number {
    return orderGarrison(this, ids, buildingId, player);
  }

  /** Player command: up to `count` spare fighters of a military building step out as field units. */
  releaseFighters(buildingId: number, count: number, player: PlayerId = LOCAL_PLAYER): number {
    return releaseFighters(this, buildingId, count, player);
  }

  /** How many soldiers `attack` could send against the target right now. */
  availableAttackers(targetId: number, player: PlayerId = LOCAL_PLAYER): number {
    return availableAttackers(this, targetId, player);
  }

  /**
   * Removes a building with no ownership checks (demolition, burning after a conquest): aborts every
   * job involving it, leaves its worker jobless — he keeps his profession and his tool and takes the
   * next workplace of it first, as in Settlers 4 — and sends its soldiers out to stand free,
   * frees the tiles and leaves its ruin's goods on and around the footprint (`ruinGoods`: `demolish`
   * gives back `GROUND.demolishShare` of its materials, `burn` `GROUND.burnShare`; `none` nothing).
   */
  removeBuilding(b: Building, ruin: 'demolish' | 'burn' | 'none' = 'burn'): void {
    const id = b.id;
    for (const s of this.settlers) {
      if (s.tasks.some((t) => 'b' in t && t.b === id)) abort(this, s);
      if (s.home === id) {
        abort(this, s);
        if (isFighter(s)) leaveGarrison(this, b, s);
        else if (PROFESSIONS[s.kind].transient) s.kind = 'carrier';
        s.home = null;
      }
      if (s.inside === id) s.inside = null;
    }
    // Jobs aborted above may have re-targeted this building on their way back; drop those too.
    for (const s of this.settlers) if (s.tasks.some((t) => 'b' in t && t.b === id)) abort(this, s);
    this.buildings.delete(id);
    this.buildingsVersion++;
    b.garrison = [];
    const m = this.map;
    m.door[m.idx(b.door.x, b.door.y)] = 0;
    for (let dy = 0; dy < b.h; dy++) {
      for (let dx = 0; dx < b.w; dx++) {
        m.building[m.idx(b.x + dx, b.y + dy)] = 0;
        markWalkable(m, b.x + dx, b.y + dy);
      }
    }
    if (ruin === 'burn') {
      this.ruins.push({ x: b.x, y: b.y, w: b.w, h: b.h, type: b.type, owner: b.owner, tick: this.tick, until: this.tick + RUIN.ticks });
    }
    if (ruin !== 'none') {
      const c = centerOf(b);
      const at = { x: Math.round(c.x), y: Math.round(c.y) };
      const share = ruin === 'demolish' ? GROUND.demolishShare : GROUND.burnShare;
      for (const [res, n] of ruinGoods(b, share, GROUND.keepsGoods)) dropGoods(this, at, res, n);
    }
    // Its land stays its owner's; only what another player's towers now cover changes hands.
    if (BUILDINGS[b.type].territory) claimChanged(this, b);
  }

  /** Player command: order `count` specialists (geologists, pioneers, thieves) — the same orders as workers. */
  orderSpecialist(kind: SettlerKind, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return orderWorkers(this, player, kind, count);
  }

  /**
   * Player command: the nearest free pioneer claims neutral land around (x, y), tile after tile, until
   * none is left within his reach, and then stays there (`specialists.ts`).
   */
  sendPioneer(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return sendPioneer(this, x, y, player);
  }

  /** Player command: send an idle thief to rob a foreign building (`specialists.ts`). */
  sendThief(targetId: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return sendThief(this, targetId, player);
  }

  /** Player command: an idle specialist on own land becomes a carrier again; the order drops by one. */
  dismissSpecialist(kind: SettlerKind, player: PlayerId = LOCAL_PLAYER): boolean {
    return dismissSpecialist(this, kind, player);
  }

  /** The player's attack strength on foreign land, in per cent (`strength.ts`). */
  strengthOf(player: PlayerId = LOCAL_PLAYER): number {
    return attackStrength(this, player);
  }

  /**
   * Player command: the nearest free (ordered) geologist examines the mountain around (x, y) — any
   * land — tile after tile until no unexamined mountain tile is left within his reach (the whole
   * ridge), and then stays there; with none waiting, a free carrier takes up a hammer and goes, the
   * order growing by one (`specialists.ts`). False if impossible.
   */
  sendGeologist(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return sendGeologist(this, x, y, player);
  }

  /**
   * Player command: right click with specialists selected (geologists, pioneers, thieves) at (x, y),
   * on building `targetId` if any: each does his action there if possible, else walks there and waits;
   * with `walkOnly` (Alt + right click) all just walk there.
   */
  orderSpecialists(
    ids: readonly number[],
    x: number,
    y: number,
    targetId: number | null = null,
    player: PlayerId = LOCAL_PLAYER,
    walkOnly = false,
  ): number {
    return orderSpecialists(this, ids, x, y, targetId, player, walkOnly);
  }

  /** Player command: the selected specialists stop and wait where they stand. */
  holdSpecialists(ids: readonly number[], player: PlayerId = LOCAL_PLAYER): number {
    return holdSpecialists(this, ids, player);
  }

  /** Player command: the selected specialists on own land turn back into carriers. */
  dismissUnits(ids: readonly number[], player: PlayerId = LOCAL_PLAYER): number {
    return dismissUnits(this, ids, player);
  }

  /**
   * Scenario command (missions, Settlers 4's `Goods.AddPileEx`): `n` units of `res` laid on the ground
   * by the player's home, as the start goods lie. Deterministic, like any other command.
   */
  grant(res: Resource, n: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const p = this.players[player - 1];
    if (!p || n <= 0 || !RESOURCES.includes(res)) return false;
    dropGoods(this, p.home, res, Math.floor(n));
    return true;
  }

  /** Player command: lay out a construction site. */
  placeBuilding(type: BuildingType, x: number, y: number, player: PlayerId = LOCAL_PLAYER): Building | null {
    if (!BUILDINGS[type].playerBuildable || !this.canPlace(type, x, y, player)) return null;
    const def = BUILDINGS[type];
    const door = doorOf(x, y, def.w, def.h);
    // Reachable from where the player started (unless something now stands there).
    const from = this.homeOf(player);
    if (this.map.isWalkable(from.x, from.y) && !findPath(this.map, from.x, from.y, door.x, door.y)) return null;
    const b = addBuilding(this, type, x, y, player, false);
    if (needsDigger(type)) {
      // Diggers clear every site first (and flatten a sloped one); carriers bring materials once one is on his way.
      b.levelled = false;
      b.levelTo = needsLevelling(this.map, type, x, y) ? levelTarget(this.map, b) : -1;
    }
    return b;
  }

  // ------------------------------------------------------------- simulation

  step(): void {
    // After a load the derived building vision is missing; rebuild it from the state the previous
    // tick ended with, exactly as the uninterrupted game had it (the AI reads it).
    ensureVision(this);
    this.tick++;
    for (const s of this.settlers) {
      s.px = s.x;
      s.py = s.y;
    }
    updateNature(this);
    updateAnimals(this);
    updatePaths(this);
    const assaults = assaultsByTarget(this);
    for (const b of this.buildings.values()) {
      updateBuilding(this, b);
      if (b.done && isMilitary(b)) updateGarrison(this, b, assaults);
      // A stopped barracks trains no one (`stop.ts`).
      if (b.done && BUILDINGS[b.type].barracks && !b.stopped) updateBarracks(this, b);
      if (b.done && BUILDINGS[b.type].infirmary) updateInfirmary(this, b);
      if (b.done && BUILDINGS[b.type].alarm) updateLookout(this, b);
    }
    // Intruding specialists unmasked and met (`intruders.ts`) before the settlers move this tick.
    updateIntruders(this);
    for (const s of this.settlers) if (!this.dying.has(s.id)) updateSettler(this, s);
    removeDead(this);
    this.checkDefeats();
    pruneShots(this);
    if (this.ruins.some((r) => r.until <= this.tick)) this.ruins = this.ruins.filter((r) => r.until > this.tick);
    updateStrikes(this);
    if (this.tick % DISPATCH_EVERY === 0) dispatch(this);
    if (this.ai.length > 0) updateAi(this);
    updateFog(this);
  }
}
