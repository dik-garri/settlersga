import { BUILDINGS, OUTPUT_CAP, oreOf, PROFESSIONS, type BuildingDef, type Recipe } from './config';
import {
  emptyStock,
  RESOURCES,
  type Building,
  type BuildingType,
  type PlayerId,
  type Point,
  type Resource,
  type SettlerKind,
  type Settler,
} from './types';
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
    spawned: 0,
    levelled: true,
    diggerId: null,
    levelTo: 0,
    priority: false,
    garrison: [],
    garrisonInbound: 0,
    garrisonArchersInbound: 0,
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
    hp: PROFESSIONS[kind].hp ?? 0,
    opponent: null,
    level: 0,
    reload: 0,
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
  const all = RESOURCES.every(
    (r) => b.input[r] >= (recipe.inputs[r] ?? 0) && b.output[r] + (recipe.outputs[r] ?? 0) <= OUTPUT_CAP,
  );
  if (!all) return false;
  if (recipe.inputsAnyOf && !recipe.inputsAnyOf.some((r) => b.input[r] > 0)) return false;
  return !recipe.outputChoice || recipe.outputChoice.some((r) => b.output[r] < OUTPUT_CAP);
}

/** Units of `res` the player has lying in piles and warehouses, not yet promised to anyone. */
export function available(w: World, owner: PlayerId, res: Resource): number {
  let n = 0;
  for (const b of w.buildings.values()) if (b.owner === owner) n += b.output[res] - b.outReserved[res];
  return n;
}

/** Workplaces (and, for hammers, construction sites) currently waiting for someone with this tool. */
export function waitingFor(w: World, owner: PlayerId, tool: Resource): number {
  let n = 0;
  for (const b of w.buildings.values()) {
    if (b.owner !== owner) continue;
    const worker = BUILDINGS[b.type].worker;
    if (worker && b.done && b.workerId === null && !b.workerRequested && PROFESSIONS[worker].tool === tool) n++;
    if (tool === PROFESSIONS.builder.tool && !b.done && b.builderId === null) n++;
    n += garrisonSlotsFor(w, b, tool);
  }
  return n;
}

/** Empty garrison slots that would take a fighter whose weapon is `tool` (archer slots want bows). */
function garrisonSlotsFor(w: World, b: Building, tool: Resource): number {
  const g = BUILDINGS[b.type].garrison;
  if (!g || !b.done) return 0;
  const space = g.capacity - b.garrison.length - b.garrisonInbound;
  if (space <= 0) return 0;
  const fighter = (Object.keys(PROFESSIONS) as SettlerKind[]).find((k) => PROFESSIONS[k].combat && PROFESSIONS[k].tool === tool);
  if (!fighter) return 0;
  const archersIn = b.garrison.filter((id) => {
    const kind = w.getSettler(id)?.kind;
    return kind !== undefined && !!PROFESSIONS[kind].combat?.ranged;
  }).length;
  const archerSlots = Math.min(space, Math.max(0, (g.archers ?? 0) - archersIn - b.garrisonArchersInbound));
  return PROFESSIONS[fighter].combat!.ranged ? archerSlots : space - archerSlots;
}

/**
 * The choice the owner is shortest of (awaited plus reserve, minus available; ties: least available),
 * or null when every choice is covered and nothing needs making.
 */
export function chooseOutput(w: World, b: Building, recipe: Recipe): Resource | null {
  let best: Resource | null = null;
  let bestNeed = 0;
  let bestHave = Infinity;
  for (const r of recipe.outputChoice ?? []) {
    if (b.output[r] >= OUTPUT_CAP) continue;
    const have = available(w, b.owner, r);
    const need = waitingFor(w, b.owner, r) + (recipe.keepInStock ?? 0) - have;
    if (need <= 0) continue;
    if (need > bestNeed || (need === bestNeed && have < bestHave)) {
      best = r;
      bestNeed = need;
      bestHave = have;
    }
  }
  return best;
}

/** Ore units of the mine's kind still within its radius. */
export function oreLeft(w: World, b: Building): number {
  const { res, radius } = BUILDINGS[b.type].mine!;
  const c = centerOf(b);
  let n = 0;
  for (let y = Math.floor(c.y - radius); y <= Math.ceil(c.y + radius); y++) {
    for (let x = Math.floor(c.x - radius); x <= Math.ceil(c.x + radius); x++) {
      if (!w.map.inBounds(x, y) || Math.hypot(x - c.x, y - c.y) > radius) continue;
      const i = w.map.idx(x, y);
      if (oreOf(w.map.ore[i]) === res) n += w.map.oreAmount[i];
    }
  }
  return n;
}

/** Tile with ore of the mine's kind within its radius, nearest first; -1 if worked out. */
export function findOreTile(w: World, b: Building, def: BuildingDef): number {
  const { res, radius } = def.mine!;
  const c = centerOf(b);
  let best = -1;
  let bestD = Infinity;
  for (let y = Math.floor(c.y - radius); y <= Math.ceil(c.y + radius); y++) {
    for (let x = Math.floor(c.x - radius); x <= Math.ceil(c.x + radius); x++) {
      if (!w.map.inBounds(x, y)) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      const i = w.map.idx(x, y);
      if (d > radius || d >= bestD || w.map.oreAmount[i] === 0 || oreOf(w.map.ore[i]) !== res) continue;
      best = i;
      bestD = d;
    }
  }
  return best;
}

/**
 * Residences release their settlers one by one; workshops run their recipe while the worker is inside
 * and materials and pile space allow.
 */
export function updateBuilding(w: World, b: Building): void {
  const home = BUILDINGS[b.type].residence;
  if (home && b.done && b.spawned < home.capacity && ++b.timer >= home.everyTicks) {
    b.timer = 0;
    b.spawned++;
    spawnSettler(w, 'carrier', b);
    return;
  }
  const def = BUILDINGS[b.type];
  const recipe = def.recipe;
  if (!recipe || !b.done) return;
  const worker = w.getSettler(b.workerId);
  if (!worker || worker.inside !== b.id || !canRunRecipe(b, recipe)) return;
  const oreTile = def.mine ? findOreTile(w, b, def) : -1;
  if (def.mine && oreTile < 0) return; // worked out
  if (recipe.outputChoice && !chooseOutput(w, b, recipe)) return; // nothing worth making
  if (++b.timer < recipe.ticks) return;
  b.timer = 0;
  if (recipe.inputsAnyOf) {
    // Eat whichever of the alternatives is most plentiful.
    const pick = recipe.inputsAnyOf.reduce((a, r) => (b.input[r] > b.input[a] ? r : a));
    b.input[pick]--;
  }
  if (oreTile >= 0 && --w.map.oreAmount[oreTile] === 0) w.map.touch(oreTile);
  for (const r of RESOURCES) {
    const made = recipe.outputs[r] ?? 0;
    b.input[r] -= recipe.inputs[r] ?? 0;
    b.output[r] += made;
    w.stats.produced[r] += made;
  }
  const chosen = recipe.outputChoice ? chooseOutput(w, b, recipe) : null;
  if (chosen) {
    b.output[chosen]++;
    w.stats.produced[chosen]++;
  }
}

/** Whether the building currently projects territory. */
export function claimsTerritory(b: Building): boolean {
  const def = BUILDINGS[b.type];
  if (!def.territory || !b.done) return false;
  if (def.garrison) return def.garrison.claimsWhenEmpty === true || b.garrison.length > 0;
  return def.worker === null || b.workerId !== null;
}

/**
 * Rebuilds per-tile ownership. Where claims overlap the nearest claiming building wins (ties: the
 * earlier one), so borders run between rival strongholds and a building always holds its own ground.
 */
export function recomputeTerritory(w: World): void {
  const m = w.map;
  m.owner.fill(0);
  const best = new Float32Array(m.w * m.h).fill(Infinity);
  for (const b of w.buildings.values()) {
    if (!claimsTerritory(b)) continue;
    const r = BUILDINGS[b.type].territory!;
    const c = centerOf(b);
    for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
      for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (!m.inBounds(x, y) || d > r) continue;
        const i = m.idx(x, y);
        if (d < best[i]) {
          best[i] = d;
          m.owner[i] = b.owner;
        }
      }
    }
  }
  w.territoryVersion++;
}
