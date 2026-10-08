import {
  BUILD_TICKS_PER_UNIT,
  BUILDINGS,
  costOf,
  hpOf,
  MINING,
  ORDERABLE,
  OUTPUT_CAP,
  oreOf,
  PROFESSIONS,
  residentsOf,
  type BuildingDef,
  type Recipe,
} from './config';
import { accepts, orderedOutput, toolMade, workerOrder, workersOf } from './economy';
import { fightersWith, mostBehindShare } from './military';
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
import { groundStock } from './ground';
import { landOf } from './land';
import { storageRoom } from './storage';
import { wantsDonkeys } from './trade';
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
    builderIds: [],
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
    diggerIds: [],
    levelTo: 0,
    dug: 0,
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
  w.buildingsVersion++;
  // Anyone standing on the new footprint would be walled in: step them out onto the door tile,
  // which is always walkable. Their current route is recomputed from there.
  for (const s of w.settlers) {
    if (s.inside !== null) continue;
    const sx = Math.round(s.x);
    const sy = Math.round(s.y);
    if (sx < x || sy < y || sx >= x + def.w || sy >= y + def.h) continue;
    s.x = s.px = b.door.x;
    s.y = s.py = b.door.y;
    s.path = [];
  }
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
    hp: hpOf(kind),
    opponent: null,
    level: 0,
    reload: 0,
    idleAt: null,
    stroll: null,
    strollIn: 0,
    chatWith: null,
  };
  w.settlers.push(s);
  w.settlerById.set(s.id, s);
  return s;
}

export function isReachable(w: World, b: Building): boolean {
  return b.unreachableUntil <= w.tick;
}

/** Relaxations of `nearestStorage`'s rules. */
export interface StoreRules {
  /** Also a warehouse that does not take the good in (player setting). */
  refused?: boolean;
  /** Also a warehouse with no room left for it (`storage.ts`). */
  full?: boolean;
}

/**
 * Nearest finished, reachable warehouse of the player (that takes `res` in and has room for one more
 * unit, when `res` is given — unless `rules` relax that; on that piece of the player's land, when
 * `piece` is given — see `land.ts`).
 */
export function nearestStorage(
  w: World,
  owner: PlayerId,
  near: Point,
  res?: Resource,
  piece?: number,
  rules: StoreRules = {},
): Building | undefined {
  let best: Building | undefined;
  let bestD = Infinity;
  for (const b of w.buildings.values()) {
    if (b.owner !== owner || !b.done || !BUILDINGS[b.type].storage || !isReachable(w, b)) continue;
    if (res && !rules.refused && !accepts(b, res)) continue;
    const d = Math.hypot(b.door.x - near.x, b.door.y - near.y);
    if (d >= bestD) continue;
    if (piece !== undefined && landOf(w, b) !== piece) continue;
    if (res && !rules.full && storageRoom(b, res) <= 0) continue;
    best = b;
    bestD = d;
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

/**
 * Units of `res` the player has lying in piles, warehouses and on the ground of its land (`ground.ts`),
 * not yet promised to anyone.
 */
export function available(w: World, owner: PlayerId, res: Resource): number {
  let n = groundStock(w, owner, res);
  for (const b of w.buildings.values()) if (b.owner === owner) n += b.output[res] - b.outReserved[res];
  return n;
}

/** Workplaces, ordered workers not yet there (builders, diggers) and garrison slots waiting for this tool. */
export function waitingFor(w: World, owner: PlayerId, tool: Resource): number {
  let n = 0;
  for (const b of w.buildings.values()) {
    if (b.owner !== owner) continue;
    const worker = BUILDINGS[b.type].worker;
    if (worker && b.done && b.workerId === null && !b.workerRequested && PROFESSIONS[worker].tool === tool) n++;
    n += garrisonSlotsFor(w, b, tool);
  }
  for (const kind of ORDERABLE) {
    if (PROFESSIONS[kind].tool === tool) n += Math.max(0, workerOrder(w, owner, kind) - workersOf(w, owner, kind));
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
  const choices = recipe.outputChoice ?? [];
  // The player's orders go first (toolsmith queue, as in Settlers 4); then it works by need.
  if (recipe.orderable) {
    const ordered = orderedOutput(w, b, choices, (r) => b.output[r] < OUTPUT_CAP);
    if (ordered) return ordered;
  }
  const awaited = choices.filter(
    (r) => b.output[r] < OUTPUT_CAP && waitingFor(w, b.owner, r) + (recipe.keepInStock ?? 0) - available(w, b.owner, r) > 0,
  );
  if (awaited.length === 0) return null;
  // Share-controlled outputs (weapons): something is wanted, so make whichever the player's army is
  // furthest below its target share in (units in stock plus fighters carrying it).
  const room = choices.filter((r) => b.output[r] < OUTPUT_CAP);
  const byShare = mostBehindShare(w, b.owner, room, choices, (r) => available(w, b.owner, r) + fightersWith(w, b.owner, r));
  if (byShare) return byShare;
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

/** Ore tiles of the mine's kind within its radius, in scan order. */
function oreTiles(w: World, b: Building, def: BuildingDef): number[] {
  const { res, radius } = def.mine!;
  const c = centerOf(b);
  const out: number[] = [];
  for (let y = Math.floor(c.y - radius); y <= Math.ceil(c.y + radius); y++) {
    for (let x = Math.floor(c.x - radius); x <= Math.ceil(c.x + radius); x++) {
      if (!w.map.inBounds(x, y) || Math.hypot(x - c.x, y - c.y) > radius) continue;
      const i = w.map.idx(x, y);
      if (w.map.oreAmount[i] > 0 && oreOf(w.map.ore[i]) === res) out.push(i);
    }
  }
  return out;
}

/**
 * A mine as in Settlers 4: one food buys digging attempts (more for the mine's favourite food, see
 * `MINING`); each attempt, every `recipe.ticks`, picks an ore tile in range at random and yields one
 * unit — surely while the tile is rich, by chance once it runs low.
 */
function runMine(w: World, b: Building, def: BuildingDef, recipe: Recipe): void {
  const { res, favourite } = def.mine!;
  const foods = recipe.inputsAnyOf ?? [];
  if (b.output[res] >= OUTPUT_CAP) return;
  if (!b.attempts && !foods.some((r) => b.input[r] > 0)) return;
  if (++b.timer < recipe.ticks) return;
  b.timer = 0;
  const tiles = oreTiles(w, b, def);
  if (tiles.length === 0) return; // worked out
  if (!b.attempts) {
    // The favourite if there is any, else whichever food is most plentiful.
    const pick = b.input[favourite] > 0 ? favourite : foods.reduce((a, r) => (b.input[r] > b.input[a] ? r : a));
    b.input[pick]--;
    b.attempts = pick === favourite ? MINING.attempts.favourite : MINING.attempts.other;
  }
  b.attempts--;
  const i = tiles[Math.floor(w.rng() * tiles.length)];
  const amount = w.map.oreAmount[i];
  if (amount < MINING.sureAmount && w.rng() >= MINING.chancePerUnit * amount) return; // nothing this time
  if (--w.map.oreAmount[i] === 0) w.map.touch(i);
  b.output[res]++;
  w.stats.produced[res]++;
}

/** Residents a house of this type releases (`residentsOf`: Settlers 4's 10/20/50 on every map). */
export function residents(_w: World, b: Building): number {
  return residentsOf(BUILDINGS[b.type]);
}

/**
 * Residences release their settlers one by one; workshops run their recipe while the worker is inside
 * and materials and pile space allow.
 */
export function updateBuilding(w: World, b: Building): void {
  const home = BUILDINGS[b.type].residence;
  if (home && b.done && b.spawned < residents(w, b) && ++b.timer >= home.everyTicks) {
    b.timer = 0;
    b.spawned++;
    spawnSettler(w, 'carrier', b);
    return;
  }
  const def = BUILDINGS[b.type];
  const recipe = def.recipe;
  if (!recipe || !b.done) return;
  const worker = w.getSettler(b.workerId);
  if (!worker || worker.inside !== b.id) return;
  if (def.mine) return runMine(w, b, def, recipe);
  if (!canRunRecipe(b, recipe)) return;
  // A ranch breeds only while the player's markets want more donkeys (checked as a cycle starts).
  if (def.breeds && b.timer === 0 && !wantsDonkeys(w, b.owner)) return;
  if (recipe.outputChoice && !chooseOutput(w, b, recipe)) return; // nothing worth making
  if (++b.timer < recipe.ticks) return;
  b.timer = 0;
  if (recipe.inputsAnyOf) {
    // Eat whichever of the alternatives is most plentiful.
    const pick = recipe.inputsAnyOf.reduce((a, r) => (b.input[r] > b.input[a] ? r : a));
    b.input[pick]--;
  }
  for (const r of RESOURCES) {
    const made = recipe.outputs[r] ?? 0;
    b.input[r] -= recipe.inputs[r] ?? 0;
    b.output[r] += made;
    w.stats.produced[r] += made;
  }
  if (def.breeds) spawnSettler(w, def.breeds, b);
  const chosen = recipe.outputChoice ? chooseOutput(w, b, recipe) : null;
  if (chosen) {
    b.output[chosen]++;
    w.stats.produced[chosen]++;
    if (recipe.orderable) toolMade(w, b.owner, chosen);
  }
}

/**
 * What a building leaves on the ground when it is removed (Settlers 4's `ReturnBuildingMaterial` and
 * the piles at it turning loose): `share` of every material built into it, rounded down — a finished
 * building's whole cost, a site's units its builders used (materials in `RESOURCES` order, planks
 * before stone, as they are built in) — and, with `keepsGoods`, everything lying at it whole: its
 * input and output piles (a warehouse's stock) and a site's delivered materials not yet built in.
 */
export function ruinGoods(b: Building, share: number, keepsGoods: boolean): [Resource, number][] {
  const out = emptyStock();
  const cost = costOf(b.type);
  let used = b.done ? Infinity : Math.floor(b.progress / BUILD_TICKS_PER_UNIT);
  for (const r of RESOURCES) {
    const have = b.done ? cost[r] : b.delivered[r];
    const built = Math.min(have, used);
    used -= built;
    out[r] += Math.floor(built * share);
    if (keepsGoods) out[r] += have - built + Math.max(0, b.input[r]) + Math.max(0, b.output[r]);
  }
  return RESOURCES.filter((r) => out[r] > 0).map((r) => [r, out[r]]);
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
  // Pioneers' land (`specialists.ts`) where no military building claims the tile.
  if (w.pioneerLand > 0) {
    for (let i = 0; i < m.claimed.length; i++) {
      const p = m.claimed[i];
      if (p === 0 || m.owner[i] !== 0) continue;
      if (w.defeated.includes(p)) m.claimed[i] = 0;
      else m.owner[i] = p;
    }
  }
  w.territoryVersion++;
}
