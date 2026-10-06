import {
  BUILD_TICKS_PER_UNIT,
  BUILDINGS,
  costOf,
  DISPATCH_EVERY,
  GATHERERS,
  FORESTER_RADIUS,
  FORESTER_REST_TICKS,
  HANDLE_TICKS,
  IDLE_GO_HOME_TICKS,
  INPUT_CAP,
  MAP_SIZE,
  MAX_POPULATION,
  OUTPUT_CAP,
  PLANT_TICKS,
  SAW_TICKS,
  SETTLER_SPEED,
  SPAWN_CARRIER_EVERY,
  START_BUILDERS,
  START_CARRIERS,
  START_PLANKS,
  START_STONE,
  TERRITORY_RADIUS,
  totalCost,
  TREE_MATURE,
  type GatherDef,
} from './config';
import { generateMap, type GameMap } from './map';
import { findPath, staysConnected } from './pathfinding';
import { createRng, randInt, type Rng } from './rng';
import {
  emptyStock,
  RESOURCES,
  type Building,
  type BuildingType,
  type Point,
  type Resource,
  type Settler,
  type SettlerKind,
  type Stock,
  type Task,
} from './types';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export class World {
  readonly map: GameMap;
  readonly castle: Building;
  readonly buildings = new Map<number, Building>();
  readonly settlers: Settler[] = [];
  readonly stats: { produced: Stock; treesPlanted: number } = { produced: emptyStock(), treesPlanted: 0 };
  tick = 0;
  /** Bumped whenever the territory changes, so views can redraw the border. */
  territoryVersion = 0;

  private readonly rng: Rng;
  private readonly settlerById = new Map<number, Settler>();
  /** Trees and stone deposits a gatherer is heading for. */
  private readonly reservedTargets = new Set<number>();
  /** Tiles a forester is on the way to plant. */
  private readonly reservedPlots = new Set<number>();
  private nextId = 1;

  constructor(seed = 1) {
    const c = Math.floor(MAP_SIZE / 2);
    this.map = generateMap(seed, MAP_SIZE, c, c);
    this.rng = createRng(seed ^ 0x9e3779b9);
    const castle = this.addBuilding('castle', c - 1, c - 1, true);
    if (!castle) throw new Error('castle placement failed');
    this.castle = castle;
    castle.output.plank = START_PLANKS;
    castle.output.stone = START_STONE;
    this.recomputeTerritory();
    for (let i = 0; i < START_CARRIERS; i++) this.spawnSettler('carrier', castle);
    for (let i = 0; i < START_BUILDERS; i++) this.spawnSettler('builder', castle);
  }

  // ---------------------------------------------------------------- queries

  canPlace(type: BuildingType, x: number, y: number): boolean {
    const def = BUILDINGS[type];
    // The castle founds the territory, everything else must stay inside it.
    const owned = (tx: number, ty: number) => type === 'castle' || this.owns(tx, ty);
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

  owns(x: number, y: number): boolean {
    return this.map.inBounds(x, y) && this.map.owner[this.map.idx(x, y)] === 1;
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
  placeBuilding(type: BuildingType, x: number, y: number): Building | null {
    if (!BUILDINGS[type].playerBuildable || !this.canPlace(type, x, y)) return null;
    const def = BUILDINGS[type];
    const door = doorOf(x, y, def.w, def.h);
    const { door: from } = this.castle;
    if (!findPath(this.map, from.x, from.y, door.x, door.y)) return null;
    return this.addBuilding(type, x, y, false);
  }

  // ------------------------------------------------------------- simulation

  step(): void {
    this.tick++;
    for (const s of this.settlers) {
      s.px = s.x;
      s.py = s.y;
    }
    this.updateTrees();
    for (const b of this.buildings.values()) this.updateBuilding(b);
    for (const s of this.settlers) this.updateSettler(s);
    if (this.tick % DISPATCH_EVERY === 0) this.dispatch();
    if (this.tick % SPAWN_CARRIER_EVERY === 0 && this.settlers.length < MAX_POPULATION) {
      this.spawnSettler('carrier', this.castle);
    }
  }

  private addBuilding(type: BuildingType, x: number, y: number, done: boolean): Building | null {
    if (!this.canPlace(type, x, y)) return null;
    const def = BUILDINGS[type];
    const b: Building = {
      id: this.nextId++,
      type,
      x,
      y,
      w: def.w,
      h: def.h,
      door: doorOf(x, y, def.w, def.h),
      done,
      delivered: emptyStock(),
      progress: 0,
      builderId: null,
      inbound: emptyStock(),
      input: emptyStock(),
      output: emptyStock(),
      outReserved: emptyStock(),
      workerId: null,
      workerRequested: false,
      timer: 0,
    };
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        this.map.building[this.map.idx(x + dx, y + dy)] = b.id;
      }
    }
    this.map.door[this.map.idx(b.door.x, b.door.y)] = b.id;
    this.buildings.set(b.id, b);
    return b;
  }

  /** Rebuilds the territory from the castle and every garrisoned tower. */
  private recomputeTerritory(): void {
    const m = this.map;
    m.owner.fill(0);
    for (const b of this.buildings.values()) {
      const r = TERRITORY_RADIUS[b.type];
      if (!r || !b.done || (b.type !== 'castle' && b.workerId === null)) continue;
      const cx = b.x + (b.w - 1) / 2;
      const cy = b.y + (b.h - 1) / 2;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if (m.inBounds(x, y) && Math.hypot(x - cx, y - cy) <= r) m.owner[m.idx(x, y)] = 1;
        }
      }
    }
    this.territoryVersion++;
  }

  private spawnSettler(kind: SettlerKind, at: Building): Settler {
    const s: Settler = {
      id: this.nextId++,
      kind,
      x: at.door.x,
      y: at.door.y,
      px: at.door.x,
      py: at.door.y,
      path: [],
      tasks: [],
      carrying: null,
      inside: at.id,
      home: null,
      idleTicks: 0,
      working: false,
    };
    this.settlers.push(s);
    this.settlerById.set(s.id, s);
    return s;
  }

  private updateTrees(): void {
    const m = this.map;
    const n = m.w * m.h;
    for (let k = 0; k < 20; k++) {
      const i = randInt(this.rng, n);
      if (m.tree[i] > 0 && m.tree[i] < TREE_MATURE && this.rng() < 0.3) m.tree[i]++;
    }
    if (this.rng() < 0.1) {
      const i = randInt(this.rng, n);
      if (m.tree[i] !== TREE_MATURE) return;
      const x = (i % m.w) + randInt(this.rng, 5) - 2;
      const y = Math.floor(i / m.w) + randInt(this.rng, 5) - 2;
      if (!m.isBuildable(x, y) || m.hasDoorNear(x, y) || this.settlerNear(x, y)) return;
      if (this.treesAround(x, y) >= 5 || !staysConnected(m, x, y)) return;
      m.tree[m.idx(x, y)] = 1;
    }
  }

  private treesAround(x: number, y: number): number {
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.map.inBounds(x + dx, y + dy) && this.map.tree[this.map.idx(x + dx, y + dy)]) count++;
      }
    }
    return count;
  }

  private settlerNear(x: number, y: number): boolean {
    return this.settlers.some(
      (s) =>
        (Math.round(s.x) === x && Math.round(s.y) === y) ||
        (s.path.length > 0 && s.path[0].x === x && s.path[0].y === y),
    );
  }

  private updateBuilding(b: Building): void {
    if (b.type !== 'sawmill' || !b.done) return;
    const worker = this.getSettler(b.workerId);
    if (!worker || worker.inside !== b.id) return;
    if (b.input.log > 0 && b.output.plank < OUTPUT_CAP) {
      if (++b.timer >= SAW_TICKS) {
        b.timer = 0;
        b.input.log--;
        b.output.plank++;
        this.stats.produced.plank++;
      }
    }
  }

  // --------------------------------------------------------------- settlers

  private updateSettler(s: Settler): void {
    s.working = false;
    const task = s.tasks[0];
    if (!task) {
      this.idle(s);
      return;
    }
    s.idleTicks = 0;

    switch (task.t) {
      case 'goto': {
        s.inside = null;
        if (s.path.length === 0) {
          if (this.atGoal(s, task)) {
            s.tasks.shift();
            return;
          }
          const p = findPath(this.map, Math.round(s.x), Math.round(s.y), task.x, task.y, task.adj);
          if (!p) return this.abort(s);
          if (p.length === 0) {
            s.tasks.shift();
            return;
          }
          s.path = p;
        }
        this.move(s, task);
        return;
      }
      case 'enter':
        s.inside = task.b;
        s.tasks.shift();
        return;
      case 'wait':
        if (--task.n <= 0) s.tasks.shift();
        return;
      case 'pickup': {
        const b = this.buildings.get(task.b);
        if (!b || b.output[task.res] <= 0) return this.abort(s);
        b.output[task.res]--;
        b.outReserved[task.res]--;
        s.carrying = task.res;
        s.tasks.shift();
        s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
        return;
      }
      case 'drop': {
        const b = this.buildings.get(task.b);
        if (!b) return this.abort(s);
        if (!b.done) b.delivered[task.res]++;
        else if (b.type === 'castle') b.output[task.res]++;
        else b.input[task.res]++;
        b.inbound[task.res]--;
        s.carrying = null;
        s.tasks.shift();
        s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
        return;
      }
      case 'store': {
        const b = this.buildings.get(task.b);
        if (!b) return this.abort(s);
        b.output[task.res]++;
        this.stats.produced[task.res]++;
        s.carrying = null;
        s.tasks.shift();
        return;
      }
      case 'gather': {
        const i = this.map.idx(task.x, task.y);
        if (!this.isGatherTarget(task.res, i)) return this.abort(s);
        s.working = true;
        if (--task.n > 0) return;
        if (task.res === 'stone') this.map.stone[i]--;
        else this.map.tree[i] = 0;
        this.reservedTargets.delete(i);
        s.carrying = task.res;
        s.tasks.shift();
        return;
      }
      case 'plant': {
        const i = this.map.idx(task.x, task.y);
        if (!this.canPlant(task.x, task.y, true)) return this.abort(s);
        s.working = true;
        if (--task.n > 0) return;
        this.map.tree[i] = 1;
        this.reservedPlots.delete(i);
        this.stats.treesPlanted++;
        s.tasks.shift();
        return;
      }
      case 'build': {
        const b = this.buildings.get(task.b);
        if (!b || b.done) {
          s.tasks.shift();
          return;
        }
        const delivered = b.delivered.log + b.delivered.plank + b.delivered.stone;
        if (b.progress < delivered * BUILD_TICKS_PER_UNIT) {
          b.progress++;
          s.working = true;
        }
        if (b.progress >= totalCost(b.type) * BUILD_TICKS_PER_UNIT) {
          b.done = true;
          b.builderId = null;
          s.tasks.shift();
        }
        return;
      }
      case 'become': {
        const b = this.buildings.get(task.b);
        if (!b) return this.abort(s);
        s.kind = task.kind;
        s.home = b.id;
        s.inside = b.id;
        b.workerId = s.id;
        b.workerRequested = false;
        s.tasks.shift();
        if (TERRITORY_RADIUS[b.type]) this.recomputeTerritory();
        return;
      }
    }
  }

  private atGoal(s: Settler, task: { x: number; y: number; adj?: boolean }): boolean {
    const dx = Math.abs(s.x - task.x);
    const dy = Math.abs(s.y - task.y);
    return task.adj ? Math.max(dx, dy) === 1 : dx === 0 && dy === 0;
  }

  private move(s: Settler, task: { x: number; y: number; adj?: boolean }): void {
    let left = SETTLER_SPEED;
    while (left > 0 && s.path.length > 0) {
      const t = s.path[0];
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d > left) {
        s.x += (dx / d) * left;
        s.y += (dy / d) * left;
        return;
      }
      s.x = t.x;
      s.y = t.y;
      left -= d;
      s.path.shift();
      const next = s.path[0];
      if (next && !this.map.isWalkable(next.x, next.y)) {
        // Something grew or was built in the way — find a new route.
        const p = findPath(this.map, s.x, s.y, task.x, task.y, task.adj);
        if (!p) return this.abort(s);
        s.path = p;
      }
    }
  }

  /** Cancels the settler's job and releases every reservation it still holds. */
  private abort(s: Settler): void {
    for (const task of s.tasks) {
      const b = 'b' in task ? this.buildings.get(task.b) : undefined;
      switch (task.t) {
        case 'pickup':
          if (b) b.outReserved[task.res]--;
          break;
        case 'drop':
          if (b) b.inbound[task.res]--;
          break;
        case 'gather':
          this.reservedTargets.delete(this.map.idx(task.x, task.y));
          break;
        case 'plant':
          this.reservedPlots.delete(this.map.idx(task.x, task.y));
          break;
        case 'build':
          if (b && b.builderId === s.id) b.builderId = null;
          break;
        case 'become':
          if (b) b.workerRequested = false;
          break;
      }
    }
    s.tasks = [];
    s.path = [];
    s.carrying = null;
  }

  private goHome(s: Settler, b: Building): void {
    s.tasks = [
      { t: 'goto', x: b.door.x, y: b.door.y },
      { t: 'enter', b: b.id },
    ];
  }

  private idle(s: Settler): void {
    s.idleTicks++;
    const home = s.home !== null ? this.buildings.get(s.home) : undefined;

    switch (s.kind) {
      case 'carrier':
        if (s.inside === null && s.idleTicks > IDLE_GO_HOME_TICKS) this.goHome(s, this.castle);
        return;

      case 'builder': {
        let best: Building | undefined;
        for (const b of this.buildings.values()) {
          if (b.done || b.builderId !== null) continue;
          if (!best || dist(s, b.door) < dist(s, best.door)) best = b;
        }
        if (best) {
          best.builderId = s.id;
          s.tasks = [
            { t: 'goto', x: best.door.x, y: best.door.y },
            { t: 'build', b: best.id },
          ];
        } else if (s.inside === null && s.idleTicks > IDLE_GO_HOME_TICKS) {
          this.goHome(s, this.castle);
        }
        return;
      }

      case 'woodcutter':
      case 'stonecutter': {
        const def = GATHERERS[s.kind]!;
        if (!home) return;
        if (s.inside !== home.id) return this.goHome(s, home);
        if (home.output[def.res] >= OUTPUT_CAP) return;
        const target = this.findGatherTarget(s, home, def);
        if (!target) {
          s.tasks = [{ t: 'wait', n: 20 }];
          return;
        }
        this.reservedTargets.add(this.map.idx(target.x, target.y));
        s.path = target.path;
        s.tasks = [
          { t: 'goto', x: target.x, y: target.y, adj: true },
          { t: 'gather', x: target.x, y: target.y, n: def.workTicks, res: def.res },
          { t: 'goto', x: home.door.x, y: home.door.y },
          { t: 'store', b: home.id, res: def.res },
          { t: 'enter', b: home.id },
          { t: 'wait', n: def.restTicks },
        ];
        return;
      }

      case 'forester': {
        if (!home) return;
        if (s.inside !== home.id) return this.goHome(s, home);
        const plot = this.findPlotFor(s, home);
        if (!plot) {
          s.tasks = [{ t: 'wait', n: 40 }];
          return;
        }
        this.reservedPlots.add(this.map.idx(plot.x, plot.y));
        s.path = plot.path;
        s.tasks = [
          { t: 'goto', x: plot.x, y: plot.y, adj: true },
          { t: 'plant', x: plot.x, y: plot.y, n: PLANT_TICKS },
          { t: 'goto', x: home.door.x, y: home.door.y },
          { t: 'enter', b: home.id },
          { t: 'wait', n: FORESTER_REST_TICKS },
        ];
        return;
      }

      case 'sawmiller':
      case 'guard':
        if (home && s.inside !== home.id) this.goHome(s, home);
        return;
    }
  }

  /**
   * Whether a sapling may go on this tile: free grass, not next to a door, nobody standing there,
   * and blocking it does not cut any walking route.
   * `planting` skips the reservation check for the forester who holds it.
   */
  private canPlant(x: number, y: number, planting = false): boolean {
    const m = this.map;
    if (!this.owns(x, y) || !m.isBuildable(x, y) || m.hasDoorNear(x, y) || this.settlerNear(x, y)) return false;
    if (!planting && this.reservedPlots.has(m.idx(x, y))) return false;
    return staysConnected(m, x, y);
  }

  /** A random reachable free plot around the forester's hut, spreading the new forest out. */
  private findPlotFor(s: Settler, home: Building): (Point & { path: Point[] }) | null {
    const candidates: Point[] = [];
    const r = FORESTER_RADIUS;
    for (let y = home.door.y - r; y <= home.door.y + r; y++) {
      for (let x = home.door.x - r; x <= home.door.x + r; x++) {
        const d = dist({ x, y }, home.door);
        if (d < 2 || d > r || !this.canPlant(x, y)) continue;
        if (this.treesAround(x, y) >= 4) continue;
        candidates.push({ x, y });
      }
    }
    for (let attempt = 0; attempt < 6 && candidates.length > 0; attempt++) {
      const [c] = candidates.splice(randInt(this.rng, candidates.length), 1);
      const path = findPath(this.map, Math.round(s.x), Math.round(s.y), c.x, c.y, true);
      if (path) return { ...c, path };
    }
    return null;
  }

  private isGatherTarget(res: Resource, i: number): boolean {
    if (this.map.owner[i] !== 1) return false;
    return res === 'stone' ? this.map.stone[i] > 0 : this.map.tree[i] === TREE_MATURE;
  }

  /** Nearest reachable, unreserved tree or deposit within the gatherer's radius. */
  private findGatherTarget(s: Settler, home: Building, def: GatherDef): (Point & { path: Point[] }) | null {
    const m = this.map;
    const candidates: Point[] = [];
    const r = def.radius;
    for (let y = home.door.y - r; y <= home.door.y + r; y++) {
      for (let x = home.door.x - r; x <= home.door.x + r; x++) {
        if (!m.inBounds(x, y)) continue;
        const i = m.idx(x, y);
        if (!this.isGatherTarget(def.res, i) || this.reservedTargets.has(i)) continue;
        if (dist({ x, y }, home.door) > r) continue;
        candidates.push({ x, y });
      }
    }
    candidates.sort((a, b) => dist(a, home.door) - dist(b, home.door));
    for (const c of candidates.slice(0, 6)) {
      const path = findPath(m, Math.round(s.x), Math.round(s.y), c.x, c.y, true);
      if (path) return { ...c, path };
    }
    return null;
  }

  // -------------------------------------------------------------- logistics

  private dispatch(): void {
    const idle = this.settlers.filter((s) => s.kind === 'carrier' && s.tasks.length === 0);
    const take = (near: Point): Settler | undefined => {
      let bestIdx = -1;
      for (let i = 0; i < idle.length; i++) {
        if (bestIdx < 0 || dist(idle[i], near) < dist(idle[bestIdx], near)) bestIdx = i;
      }
      return bestIdx < 0 ? undefined : idle.splice(bestIdx, 1)[0];
    };

    // 1. Finished buildings that still lack a worker.
    for (const b of this.buildings.values()) {
      const kind = BUILDINGS[b.type].worker;
      if (!kind || !b.done || b.workerId !== null || b.workerRequested) continue;
      const s = take(b.door);
      if (!s) return;
      b.workerRequested = true;
      s.tasks = [
        { t: 'goto', x: b.door.x, y: b.door.y },
        { t: 'become', b: b.id, kind },
      ];
    }

    // 2. Demands: construction sites and production inputs.
    for (const b of this.buildings.values()) {
      for (const res of RESOURCES) {
        let need = this.demand(b, res);
        while (need-- > 0) {
          const from = this.nearestSupply(res, b);
          if (!from) break;
          const s = take(from.door);
          if (!s) return;
          this.assignDelivery(s, from, b, res);
        }
      }
    }

    // 3. Surplus from producers goes to the castle warehouse.
    for (const b of this.buildings.values()) {
      if (b === this.castle || !b.done) continue;
      for (const res of RESOURCES) {
        while (b.output[res] - b.outReserved[res] > 0) {
          const s = take(b.door);
          if (!s) return;
          this.assignDelivery(s, b, this.castle, res);
        }
      }
    }
  }

  private demand(b: Building, res: Resource): number {
    if (!b.done) {
      return costOf(b.type)[res] - b.delivered[res] - b.inbound[res];
    }
    if (b.type === 'sawmill' && res === 'log') return INPUT_CAP - b.input.log - b.inbound.log;
    return 0;
  }

  private nearestSupply(res: Resource, target: Building): Building | undefined {
    let best: Building | undefined;
    for (const b of this.buildings.values()) {
      if (b === target || !b.done || b.output[res] - b.outReserved[res] <= 0) continue;
      if (!best || dist(b.door, target.door) < dist(best.door, target.door)) best = b;
    }
    return best;
  }

  private assignDelivery(s: Settler, from: Building, to: Building, res: Resource): void {
    from.outReserved[res]++;
    to.inbound[res]++;
    const tasks: Task[] = [
      { t: 'goto', x: from.door.x, y: from.door.y },
      { t: 'pickup', b: from.id, res },
      { t: 'goto', x: to.door.x, y: to.door.y },
      { t: 'drop', b: to.id, res },
    ];
    s.tasks = tasks;
  }
}

/** Door sits in front of the lower-left wall, next to the front corner. */
export function doorOf(x: number, y: number, w: number, h: number): Point {
  return { x: x + w - 1, y: y + h };
}
