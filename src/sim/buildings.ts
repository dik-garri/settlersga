import { BUILDINGS, OUTPUT_CAP, type Recipe } from './config';
import { emptyStock, RESOURCES, type Building, type BuildingType, type PlayerId, type Point, type SettlerKind, type Settler } from './types';
import type { World } from './world';

/** Door sits in front of the lower-left wall, next to the front corner. */
export function doorOf(x: number, y: number, w: number, h: number): Point {
  return { x: x + w - 1, y: y + h };
}

/** Footprint center in tile coordinates. */
export function centerOf(b: Building): Point {
  return { x: b.x + (b.w - 1) / 2, y: b.y + (b.h - 1) / 2 };
}

/** Creates the building and marks its footprint and door on the map. Placement must be checked first. */
export function addBuilding(w: World, type: BuildingType, x: number, y: number, owner: PlayerId, done: boolean): Building {
  const def = BUILDINGS[type];
  const b: Building = {
    id: w.nextId++,
    type,
    owner,
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
    unreachableUntil: 0,
  };
  for (let dy = 0; dy < def.h; dy++) {
    for (let dx = 0; dx < def.w; dx++) {
      w.map.building[w.map.idx(x + dx, y + dy)] = b.id;
    }
  }
  w.map.door[w.map.idx(b.door.x, b.door.y)] = b.id;
  w.buildings.set(b.id, b);
  return b;
}

export function spawnSettler(w: World, kind: SettlerKind, at: Building): Settler {
  const s: Settler = {
    id: w.nextId++,
    owner: at.owner,
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
  w.settlers.push(s);
  w.settlerById.set(s.id, s);
  return s;
}

export function isReachable(w: World, b: Building): boolean {
  return b.unreachableUntil <= w.tick;
}

/** Nearest finished, reachable warehouse of the player. */
export function nearestStorage(w: World, owner: PlayerId, near: Point): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of w.buildings.values()) {
    if (b.owner !== owner || !b.done || !BUILDINGS[b.type].storage || !isReachable(w, b)) continue;
    const d = Math.hypot(b.door.x - near.x, b.door.y - near.y);
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

function canRunRecipe(b: Building, recipe: Recipe): boolean {
  return RESOURCES.every(
    (r) => b.input[r] >= (recipe.inputs[r] ?? 0) && b.output[r] + (recipe.outputs[r] ?? 0) <= OUTPUT_CAP,
  );
}

/** Workshops run their recipe while the worker is inside and materials and pile space allow. */
export function updateBuilding(w: World, b: Building): void {
  const recipe = BUILDINGS[b.type].recipe;
  if (!recipe || !b.done) return;
  const worker = w.getSettler(b.workerId);
  if (!worker || worker.inside !== b.id || !canRunRecipe(b, recipe)) return;
  if (++b.timer < recipe.ticks) return;
  b.timer = 0;
  for (const r of RESOURCES) {
    const made = recipe.outputs[r] ?? 0;
    b.input[r] -= recipe.inputs[r] ?? 0;
    b.output[r] += made;
    w.stats.produced[r] += made;
  }
}

/** Whether the building currently projects territory. */
function claimsTerritory(b: Building): boolean {
  const def = BUILDINGS[b.type];
  return !!def.territory && b.done && (def.worker === null || b.workerId !== null);
}

/** Rebuilds per-tile ownership. Earlier buildings win where claims overlap. */
export function recomputeTerritory(w: World): void {
  const m = w.map;
  m.owner.fill(0);
  for (const b of w.buildings.values()) {
    if (!claimsTerritory(b)) continue;
    const r = BUILDINGS[b.type].territory!;
    const c = centerOf(b);
    for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
      for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
        if (!m.inBounds(x, y) || Math.hypot(x - c.x, y - c.y) > r) continue;
        const i = m.idx(x, y);
        if (m.owner[i] === 0) m.owner[i] = b.owner;
      }
    }
  }
  w.territoryVersion++;
}
