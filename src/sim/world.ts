import { addBuilding, doorOf, recomputeTerritory, spawnSettler, updateBuilding } from './buildings';
import {
  BUILD_TICKS_PER_UNIT,
  BUILDINGS,
  DISPATCH_EVERY,
  MAP_SIZE,
  MAX_POPULATION,
  SPAWN_CARRIER_EVERY,
  START_BUILDERS,
  START_CARRIERS,
  START_PLANKS,
  START_STONE,
  totalCost,
} from './config';
import { dispatch } from './logistics';
import { generateMap, type GameMap } from './map';
import { updateTrees } from './nature';
import { findPath } from './pathfinding';
import { createRng, type Rng } from './rng';
import { updateSettler } from './settlers';
import { emptyStock, type Building, type BuildingType, type PlayerId, type Settler, type Stock } from './types';

export { doorOf } from './buildings';

/** The player sitting at this browser. */
export const LOCAL_PLAYER: PlayerId = 1;

export interface Player {
  id: PlayerId;
  castleId: number;
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
  readonly stats: { produced: Stock; treesPlanted: number } = { produced: emptyStock(), treesPlanted: 0 };
  tick = 0;
  /** Bumped whenever the territory changes, so views can redraw the border. */
  territoryVersion = 0;

  // Internal state shared by the sim modules.
  readonly rng: Rng;
  readonly settlerById = new Map<number, Settler>();
  /** Trees and stone deposits a gatherer is heading for. */
  readonly reservedTargets = new Set<number>();
  /** Tiles a forester is on the way to plant. */
  readonly reservedPlots = new Set<number>();
  nextId = 1;

  constructor(seed = 1) {
    const c = Math.floor(MAP_SIZE / 2);
    this.map = generateMap(seed, MAP_SIZE, c, c);
    this.rng = createRng(seed ^ 0x9e3779b9);
    this.addPlayer(c - 1, c - 1);
  }

  private addPlayer(x: number, y: number): Player {
    const id = this.players.length + 1;
    if (!this.canPlace('castle', x, y, id)) throw new Error('castle placement failed');
    const castle = addBuilding(this, 'castle', x, y, id, true);
    castle.output.plank = START_PLANKS;
    castle.output.stone = START_STONE;
    const player = { id, castleId: castle.id };
    this.players.push(player);
    recomputeTerritory(this);
    for (let i = 0; i < START_CARRIERS; i++) spawnSettler(this, 'carrier', castle);
    for (let i = 0; i < START_BUILDERS; i++) spawnSettler(this, 'builder', castle);
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
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        if (!this.map.isBuildable(x + dx, y + dy) || !owned(x + dx, y + dy)) return false;
      }
    }
    const door = doorOf(x, y, def.w, def.h);
    return (
      this.map.isWalkable(door.x, door.y) &&
      this.map.door[this.map.idx(door.x, door.y)] === 0 &&
      owned(door.x, door.y)
    );
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

  // --------------------------------------------------------------- commands

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
    updateTrees(this);
    for (const b of this.buildings.values()) updateBuilding(this, b);
    for (const s of this.settlers) updateSettler(this, s);
    if (this.tick % DISPATCH_EVERY === 0) dispatch(this);
    if (this.tick % SPAWN_CARRIER_EVERY === 0) {
      for (const p of this.players) {
        const population = this.settlers.filter((s) => s.owner === p.id).length;
        if (population < MAX_POPULATION) spawnSettler(this, 'carrier', this.castleOf(p.id));
      }
    }
  }
}
