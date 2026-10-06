import { addBuilding, doorOf, recomputeTerritory, spawnSettler, updateBuilding } from './buildings';
import {
  BUILD_MAX_SLOPE,
  BUILD_TICKS_PER_UNIT,
  BUILDINGS,
  DISPATCH_EVERY,
  MAP_SIZE,
  PROSPECT_RADIUS,
  PROSPECT_TICKS,
  PROSPECT_TILES,
  START_BUILDERS,
  START_CARRIERS,
  START_SOLDIERS,
  START_PLANKS,
  START_STONE,
  START_TOOLS,
  totalCost,
} from './config';
import { dispatch } from './logistics';
import { attack, availableAttackers, enterGarrison, leaveGarrison, removeDead } from './military';
import { generateMap, type GameMap } from './map';
import { updateNature } from './nature';
import { findPath, staysConnected } from './pathfinding';
import { createRng, type Rng } from './rng';
import { mapFromSave, restoreWorld, type SaveData } from './save';
import { markWalkable } from './regions';
import { abort, updateSettler } from './settlers';
import { emptyStock, Terrain, type Building, type BuildingType, type PlayerId, type Settler, type Stock, type Task } from './types';

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
}

export interface WorldOptions {
  /** Map edge length in tiles. */
  size?: number;
  /** Number of players, each with a castle (default 1). Player 1 is `LOCAL_PLAYER`. */
  players?: number;
  /** Restore this snapshot instead of generating a new world (see `World.load`). */
  from?: SaveData;
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
  readonly stats: { produced: Stock; lost: Stock; treesPlanted: number; prospected: number } = {
    produced: emptyStock(),
    lost: emptyStock(),
    treesPlanted: 0,
    prospected: 0,
  };
  tick = 0;
  /** Bumped whenever the territory changes, so views can redraw the border. */
  territoryVersion = 0;

  // Internal state shared by the sim modules.
  readonly rng: Rng;
  readonly settlerById = new Map<number, Settler>();
  /** Trees and stone deposits a gatherer is heading for. */
  readonly reservedTargets = new Set<number>();
  /** Tiles a planter is on the way to plant. */
  readonly reservedPlots = new Set<number>();
  /** Tiles with a grain field; derived from `map.crop`, so not saved. */
  readonly fields = new Set<number>();
  /** Settlers killed this tick; dropped from `settlers` at its end (see `killSettler`). */
  readonly dying = new Set<number>();
  nextId = 1;

  constructor(seed = 1, opts: WorldOptions = {}) {
    this.rng = createRng(seed ^ 0x9e3779b9);
    if (opts.from) {
      this.map = mapFromSave(opts.from);
      restoreWorld(this, opts.from);
      for (let i = 0; i < this.map.crop.length; i++) if (this.map.crop[i] > 0) this.fields.add(i);
      return;
    }
    const size = opts.size ?? MAP_SIZE;
    const starts = startPositions(size, opts.players ?? 1);
    this.map = generateMap(seed, size, starts);
    for (const st of starts) this.addPlayer(st.x - 1, st.y - 1);
  }

  static load(save: SaveData): World {
    return new World(0, { from: save });
  }

  private addPlayer(x: number, y: number): Player {
    const id = this.players.length + 1;
    if (!this.canPlace('castle', x, y, id)) throw new Error('castle placement failed');
    const castle = addBuilding(this, 'castle', x, y, id, true);
    castle.output.plank = START_PLANKS;
    castle.output.stone = START_STONE;
    for (const [res, n] of Object.entries(START_TOOLS)) castle.output[res as keyof Stock] += n ?? 0;
    const player = { id, castleId: castle.id };
    this.players.push(player);
    recomputeTerritory(this);
    for (let i = 0; i < START_CARRIERS; i++) spawnSettler(this, 'carrier', castle);
    for (let i = 0; i < START_BUILDERS; i++) spawnSettler(this, 'builder', castle);
    for (let i = 0; i < START_SOLDIERS; i++) enterGarrison(this, castle, spawnSettler(this, 'soldier', castle));
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
    const ground = def.terrain === 'mountain' ? Terrain.Mountain : Terrain.Grass;
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        if (!this.map.isBuildable(x + dx, y + dy, ground) || !owned(x + dx, y + dy)) return false;
      }
    }
    const door = doorOf(x, y, def.w, def.h);
    // Mines sit on slopes; everything else needs level ground under the footprint and door.
    if (def.terrain !== 'mountain' && this.map.heightRange(x, y, x + def.w - 1, y + def.h) > BUILD_MAX_SLOPE) return false;
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

  isProspected(x: number, y: number, player: PlayerId = LOCAL_PLAYER): boolean {
    return this.map.inBounds(x, y) && (this.map.prospected[this.map.idx(x, y)] & (1 << (player - 1))) !== 0;
  }

  // --------------------------------------------------------------- commands

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
        if (s.kind === 'soldier') leaveGarrison(this, b, s);
        else s.kind = 'carrier';
        s.home = null;
      }
      if (s.inside === id) s.inside = null;
    }
    // Jobs aborted above may have re-targeted this building on their way back; drop those too.
    for (const s of this.settlers) if (s.tasks.some((t) => 'b' in t && t.b === id)) abort(this, s);
    this.buildings.delete(id);
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
    let best: Settler | undefined;
    for (const s of this.settlers) {
      if (s.owner !== player || s.kind !== 'carrier' || s.tasks.length > 0) continue;
      if (!best || Math.hypot(s.x - x, s.y - y) < Math.hypot(best.x - x, best.y - y)) best = s;
    }
    if (!best) return false;
    best.kind = 'geologist';
    best.tasks = tiles
      .sort((a, b) => a.d - b.d)
      .slice(0, PROSPECT_TILES)
      .flatMap((t): Task[] => [
        { t: 'goto', x: t.x, y: t.y },
        { t: 'prospect', x: t.x, y: t.y, n: PROSPECT_TICKS },
      ]);
    return true;
  }

  /** Player command: lay out a construction site. */
  placeBuilding(type: BuildingType, x: number, y: number, player: PlayerId = LOCAL_PLAYER): Building | null {
    if (!BUILDINGS[type].playerBuildable || !this.canPlace(type, x, y, player)) return null;
    const def = BUILDINGS[type];
    const door = doorOf(x, y, def.w, def.h);
    const { door: from } = this.castleOf(player);
    if (!findPath(this.map, from.x, from.y, door.x, door.y)) return null;
    return addBuilding(this, type, x, y, player, false);
  }

  // ------------------------------------------------------------- simulation

  step(): void {
    this.tick++;
    for (const s of this.settlers) {
      s.px = s.x;
      s.py = s.y;
    }
    updateNature(this);
    for (const b of this.buildings.values()) updateBuilding(this, b);
    for (const s of this.settlers) if (!this.dying.has(s.id)) updateSettler(this, s);
    removeDead(this);
    if (this.tick % DISPATCH_EVERY === 0) dispatch(this);
  }
}
