import { addBuilding, doorOf, recomputeTerritory, spawnSettler, updateBuilding } from './buildings';
import {
  BUILD_DIG_SLOPE,
  type BuildGround,
  BUILD_TICKS_PER_UNIT,
  BUILDINGS,
  DISPATCH_EVERY,
  MAP_SIZE,
  OUTPUT_SHARES,
  SOLDIER_LEVELS,
  PROFESSIONS,
  PROSPECT_RADIUS,
  PROSPECT_TICKS,
  PROSPECT_TILES,
  START_CONDITIONS,
  type StartLevel,
  totalCost,
} from './config';
import { levelTarget, needsDigger, needsLevelling } from './digging';
import { dismissSpecialist, sendPioneer, sendThief } from './specialists';
import { attackStrength } from './strength';
import { createEconomy, ENDLESS, orderTool, orderWorkers, setAccepts, setDistribution, type EconomyState } from './economy';
import { rebuildWorn, updatePaths } from './paths';
import { dispatch } from './logistics';
import { createAi, updateAi, type AiState } from './ai';
import { spawnAnimals, updateAnimals, type Animal } from './animals';
import {
  assaultsByTarget,
  attack,
  attackerComposition,
  availableAttackers,
  enterGarrison,
  isFighter,
  isMilitary,
  killSettler,
  leaveGarrison,
  pruneShots,
  removeDead,
  updateBarracks,
  updateGarrison,
} from './military';
import { generateMap, type GameMap } from './map';
import { createFog, ensureVision, isExplored, isVisible, resetSightMasks, updateFog, type FogState } from './fog';
import { updateNature } from './nature';
import { findPath, staysConnected } from './pathfinding';
import { createRng, type Rng } from './rng';
import { mapFromSave, restoreWorld, type SaveData } from './save';
import { markWalkable } from './regions';
import { abort, updateSettler } from './settlers';
import {
  emptyStock,
  RESOURCES,
  Terrain,
  type Building,
  type BuildingType,
  type PlayerId,
  type Resource,
  type Settler,
  type SettlerKind,
  type Stock,
  type Task,
} from './types';

export { doorOf } from './buildings';

/**
 * Castle centers: the map center for one player, otherwise evenly spaced on a circle around it
 * (two players sit in opposite corners of the diagonal).
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
  castleId: number;
  /** The player's weights for share-controlled outputs (weapons); missing ones use `OUTPUT_SHARES`. */
  shares?: Partial<Record<Resource, number>>;
  /** Level (index into `SOLDIER_LEVELS`) its barracks train recruits at; default 0. */
  recruitLevel?: number;
  /** Alliance: players with the same team never fight and win together; none = on its own. */
  team?: number;
  /** Worker orders, toolsmith queue, goods distribution (`economy.ts`). */
  economy?: EconomyState;
}

export interface WorldOptions {
  /** Map edge length in tiles. */
  size?: number;
  /** Number of players, each with a castle (default 1). Player 1 is `LOCAL_PLAYER`. */
  players?: number;
  /** Players controlled by the computer (see `ai.ts`). */
  ai?: PlayerId[];
  /** Team of each player, by player index (e.g. [1, 1, 2, 2]): allies never fight and win together. */
  teams?: number[];
  /** Restore this snapshot instead of generating a new world (see `World.load`). */
  from?: SaveData;
  /** Start goods and workers, as in Settlers 4 (default `medium`). */
  start?: StartLevel;
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
    thievesCaught: number;
  } = {
    produced: emptyStock(),
    lost: emptyStock(),
    treesPlanted: 0,
    prospected: 0,
    trained: 0,
    thievesCaught: 0,
  };
  tick = 0;
  /** Bumped whenever the territory changes, so views can redraw the border. */
  territoryVersion = 0;
  /** Bumped whenever a building is added or removed (derived, not saved; drives fog vision). */
  buildingsVersion = 0;
  /** Tiles pioneers ever claimed (`map.claimed`; derived, recounted on load) — lets territory skip the pass when 0. */
  pioneerLand = 0;
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
  /** Tiles with a grain field; derived from `map.crop`, so not saved. */
  readonly fields = new Set<number>();
  /** Tiles with path wear (`paths.ts`); derived from `map.wear`, so not saved. */
  readonly worn = new Set<number>();
  /** Settlers killed this tick; dropped from `settlers` at its end (see `killSettler`). */
  readonly dying = new Set<number>();
  /** Arrows in flight, for drawing only: damage is applied when shot. Derived, not saved. */
  shots: { x0: number; y0: number; x1: number; y1: number; tick: number; owner: PlayerId }[] = [];
  /** Computer players' state (saved). */
  readonly ai: AiState[] = [];
  /** Players whose castle has been taken, in order of defeat (saved). */
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

  constructor(seed = 1, opts: WorldOptions = {}) {
    this.rng = createRng(seed ^ 0x9e3779b9);
    this.animalRng = createRng(seed ^ 0x2545f491);
    this.idleRng = createRng(seed ^ 0x6a09e667);
    if (opts.from) {
      this.map = mapFromSave(opts.from);
      restoreWorld(this, opts.from);
      for (let i = 0; i < this.map.crop.length; i++) if (this.map.crop[i] > 0) this.fields.add(i);
      rebuildWorn(this);
      for (const p of this.map.claimed) if (p !== 0) this.pioneerLand++;
      return;
    }
    const size = opts.size ?? MAP_SIZE;
    const starts = startPositions(size, opts.players ?? 1);
    this.map = generateMap(seed, size, starts);
    for (const st of starts) this.addPlayer(st.x - 1, st.y - 1, opts.start ?? 'medium');
    opts.teams?.forEach((team, k) => {
      if (this.players[k] && Number.isFinite(team)) this.players[k].team = team;
    });
    resetSightMasks(this);
    for (const p of opts.ai ?? []) if (this.players.some((pl) => pl.id === p)) this.ai.push(createAi(p));
    spawnAnimals(this, starts);
  }

  static load(save: SaveData): World {
    return new World(0, { from: save });
  }

  private addPlayer(x: number, y: number, start: StartLevel): Player {
    const id = this.players.length + 1;
    if (!this.canPlace('castle', x, y, id)) throw new Error('castle placement failed');
    const castle = addBuilding(this, 'castle', x, y, id, true);
    const def = START_CONDITIONS[start];
    for (const [res, n] of Object.entries(def.goods)) castle.output[res as keyof Stock] += n ?? 0;
    const player: Player = { id, castleId: castle.id, economy: createEconomy(start) };
    this.players.push(player);
    recomputeTerritory(this);
    for (let i = 0; i < def.carriers; i++) spawnSettler(this, 'carrier', castle);
    for (let i = 0; i < def.builders; i++) spawnSettler(this, 'builder', castle);
    for (let i = 0; i < def.diggers; i++) spawnSettler(this, 'digger', castle);
    for (let i = 0; i < def.soldiers; i++) enterGarrison(this, castle, spawnSettler(this, 'soldier', castle));
    return player;
  }

  // ---------------------------------------------------------------- queries

  /** The local player's castle. */
  get castle(): Building {
    return this.castleOf(LOCAL_PLAYER);
  }

  castleOf(player: PlayerId): Building {
    return this.buildings.get(this.players[player - 1].castleId)!;
  }

  canPlace(type: BuildingType, x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const def = BUILDINGS[type];
    // A castle founds a territory, everything else must stay inside its owner's.
    const owned = (tx: number, ty: number) =>
      type === 'castle' ? this.map.inBounds(tx, ty) && this.map.owner[this.map.idx(tx, ty)] === 0 : this.owns(tx, ty, player);
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
    return (
      this.map.isWalkable(door.x, door.y) &&
      this.map.door[this.map.idx(door.x, door.y)] === 0 &&
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
   * A player whose castle was taken is out: its settlers die and its remaining buildings burn, so
   * the land is free for the others. Called by the conquest (`military.ts`).
   */
  defeatPlayer(player: PlayerId): void {
    if (this.isDefeated(player)) return;
    this.defeated.push(player);
    for (const s of this.settlers) if (s.owner === player) killSettler(this, s);
    for (const b of [...this.buildings.values()]) if (b.owner === player) this.removeBuilding(b);
    recomputeTerritory(this);
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
   * Player command: the weight (0–100) of a share-controlled output (`OUTPUT_SHARES`: swords, bows)
   * in what the weaponsmith forges and the barracks trains. False for other resources.
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
   * Player command: the level (index into `SOLDIER_LEVELS`) its barracks train recruits at. A level
   * costs `SOLDIER_LEVELS[k].cost` gold per recruit; short of gold, a barracks trains at the highest
   * level the gold on its pile pays for.
   */
  setRecruitLevel(level: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const p = this.players.find((q) => q.id === player);
    if (!p || !Number.isInteger(level) || level < 0 || level >= SOLDIER_LEVELS.length) return false;
    p.recruitLevel = level;
    return true;
  }

  recruitLevel(player: PlayerId = LOCAL_PLAYER): number {
    return this.players.find((q) => q.id === player)?.recruitLevel ?? 0;
  }

  /** Player command: how many of an orderable profession (builders, diggers) to have in all. */
  orderWorkers(kind: SettlerKind, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return orderWorkers(this, player, kind, count);
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
   * Player command: a marketplace's donkeys carry its ordered goods to market `to` (another finished
   * market of the player), or nowhere (`null`). See `trade.ts`.
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
      if (count === 0) delete m.trade.orders[res];
      else m.trade.orders[res] = ENDLESS;
    } else if (count > 0 && now !== ENDLESS) {
      m.trade.orders[res] = now + count;
    }
    return true;
  }

  /** Player command: serve this building first (materials, inputs, builders). */
  setPriority(id: number, on: boolean, player: PlayerId = LOCAL_PLAYER): boolean {
    const b = this.buildings.get(id);
    if (!b || b.owner !== player) return false;
    b.priority = on;
    return true;
  }

  /**
   * Player command: tear down a building. Goods lying there are lost; every job involving it is
   * cancelled (goods in hands go back to a warehouse), its worker becomes a carrier again and the
   * tiles become free. The castle cannot be demolished.
   */
  demolish(id: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const b = this.buildings.get(id);
    if (!b || b.owner !== player || !BUILDINGS[b.type].playerBuildable) return false;
    this.removeBuilding(b);
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

  /** How many soldiers `attack` could send against the target right now. */
  availableAttackers(targetId: number, player: PlayerId = LOCAL_PLAYER): number {
    return availableAttackers(this, targetId, player);
  }

  /**
   * Removes a building with no ownership checks (demolition, burning after a conquest): aborts every
   * job involving it, sends its worker back to carrying and its soldiers to find another garrison,
   * and frees the tiles.
   */
  removeBuilding(b: Building): void {
    const id = b.id;
    for (const s of this.settlers) {
      if (s.tasks.some((t) => 'b' in t && t.b === id)) abort(this, s);
      if (s.home === id) {
        abort(this, s);
        if (isFighter(s)) leaveGarrison(this, b, s);
        else s.kind = 'carrier';
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
    if (BUILDINGS[b.type].territory) recomputeTerritory(this);
  }

  /**
   * Player command: the nearest idle carrier becomes a geologist, examines up to `PROSPECT_TILES`
   * unexplored mountain tiles around (x, y) and turns back into a carrier. False if impossible.
   */
  /** Player command: order `count` specialists (pioneers, thieves) — the same orders as workers. */
  orderSpecialist(kind: SettlerKind, count: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return orderWorkers(this, player, kind, count);
  }

  /** Player command: send an idle pioneer to push the border around (x, y) (`specialists.ts`). */
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

  sendGeologist(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    const m = this.map;
    if (!this.owns(x, y, player) || m.terrain[m.idx(x, y)] !== Terrain.Mountain) return false;
    const tiles: { x: number; y: number; d: number }[] = [];
    for (let ty = y - PROSPECT_RADIUS; ty <= y + PROSPECT_RADIUS; ty++) {
      for (let tx = x - PROSPECT_RADIUS; tx <= x + PROSPECT_RADIUS; tx++) {
        const d = Math.hypot(tx - x, ty - y);
        if (d > PROSPECT_RADIUS || !this.owns(tx, ty, player) || !m.isWalkable(tx, ty)) continue;
        if (m.terrain[m.idx(tx, ty)] !== Terrain.Mountain || this.isProspected(tx, ty, player)) continue;
        tiles.push({ x: tx, y: ty, d });
      }
    }
    if (tiles.length === 0) return false;
    // As in Settlers 4 he needs a hammer: fetched from the pile nearest the site, brought back after.
    const tool = PROFESSIONS.geologist.tool;
    let from: Building | undefined;
    for (const b of this.buildings.values()) {
      if (!tool || b.owner !== player || !b.done || b.output[tool] - b.outReserved[tool] <= 0) continue;
      if (!from || Math.hypot(b.door.x - x, b.door.y - y) < Math.hypot(from.door.x - x, from.door.y - y)) from = b;
    }
    if (tool && !from) return false;
    const near = from ? from.door : { x, y };
    let best: Settler | undefined;
    for (const s of this.settlers) {
      if (s.owner !== player || s.kind !== 'carrier' || s.tasks.length > 0) continue;
      if (!best || Math.hypot(s.x - near.x, s.y - near.y) < Math.hypot(best.x - near.x, best.y - near.y)) best = s;
    }
    if (!best) return false;
    best.kind = 'geologist';
    best.tasks = [];
    if (from && tool) {
      from.outReserved[tool]++;
      best.tasks.push({ t: 'goto', x: from.door.x, y: from.door.y }, { t: 'pickup', b: from.id, res: tool });
    }
    best.tasks.push(
      ...tiles
        .sort((a, b) => a.d - b.d)
        .slice(0, PROSPECT_TILES)
        .flatMap((t): Task[] => [
          { t: 'goto', x: t.x, y: t.y },
          { t: 'prospect', x: t.x, y: t.y, n: PROSPECT_TICKS },
        ]),
    );
    return true;
  }

  /** Player command: lay out a construction site. */
  placeBuilding(type: BuildingType, x: number, y: number, player: PlayerId = LOCAL_PLAYER): Building | null {
    if (!BUILDINGS[type].playerBuildable || !this.canPlace(type, x, y, player)) return null;
    const def = BUILDINGS[type];
    const door = doorOf(x, y, def.w, def.h);
    const { door: from } = this.castleOf(player);
    if (!findPath(this.map, from.x, from.y, door.x, door.y)) return null;
    const b = addBuilding(this, type, x, y, player, false);
    if (needsDigger(type)) {
      // Diggers clear every site first (and flatten a sloped one); carriers bring materials meanwhile.
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
      if (b.done && BUILDINGS[b.type].barracks) updateBarracks(this, b);
    }
    for (const s of this.settlers) if (!this.dying.has(s.id)) updateSettler(this, s);
    removeDead(this);
    pruneShots(this);
    if (this.tick % DISPATCH_EVERY === 0) dispatch(this);
    if (this.ai.length > 0) updateAi(this);
    updateFog(this);
  }
}
