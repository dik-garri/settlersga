import {
  ANIMAL_KINDS,
  ANIMAL_SPAWN,
  ANIMAL_START_CLEARANCE,
  ANIMALS,
  type AnimalDef,
  type AnimalKind,
  type ForestDensity,
  TERRAIN,
  TREE_MATURE,
} from './config';
import type { GameMap } from './map';
import { randInt, type Rng } from './rng';
import { Terrain } from './types';
import type { World } from './world';
import { dist2, hypot } from './fmath';

/**
 * A wild animal: owner-less plain data, wandering in straight legs between resting spells around its
 * herd's home. Animals never occupy tiles (nothing waits for them, they block no route); they only
 * walk where their habitat allows. All randomness comes from `World.animalRng`, a stream of its own,
 * so animals never shift the economy's random sequence.
 */
export interface Animal {
  id: number;
  kind: AnimalKind;
  x: number;
  y: number;
  /** Position at the previous tick (the renderer interpolates). */
  px: number;
  py: number;
  /** Where the current leg ends (equal to x, y while resting). */
  tx: number;
  ty: number;
  /** Ticks left resting before the next leg. */
  rest: number;
  /** Herd home: members roam within `roam` of it. */
  hx: number;
  hy: number;
  /** Game: the hunter (settler id) stalking it (see `hunting.ts`). */
  hunter?: number | null;
}

/** Tries per new leg before an animal just rests again. */
const LEG_TRIES = 6;
/** Tries to find a home spot per herd at generation. */
const HOME_TRIES = 60;

function isWater(map: GameMap, x: number, y: number): boolean {
  return map.inBounds(x, y) && TERRAIN[map.terrain[map.idx(x, y)] as Terrain].water;
}

function nearWater(map: GameMap, x: number, y: number): boolean {
  return isWater(map, x + 1, y) || isWater(map, x - 1, y) || isWater(map, x, y + 1) || isWater(map, x, y - 1);
}

function nearTree(map: GameMap, x: number, y: number, r = 2): boolean {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (map.inBounds(x + dx, y + dy) && map.tree[map.idx(x + dx, y + dy)] > 0) return true;
    }
  }
  return false;
}

/** Whether an animal of this habitat may stand on the tile. */
export function habitable(map: GameMap, def: AnimalDef, x: number, y: number): boolean {
  if (!map.inBounds(x, y)) return false;
  const t = map.terrain[map.idx(x, y)] as Terrain;
  if (def.habitat === 'shore') {
    // Ducks paddle in water next to land and waddle along the bank.
    if (TERRAIN[t].water || t === Terrain.Ford) {
      const land = (ax: number, ay: number) => map.inBounds(ax, ay) && map.isWalkable(ax, ay) && !isWater(map, ax, ay);
      return land(x + 1, y) || land(x - 1, y) || land(x, y + 1) || land(x, y - 1);
    }
    return map.isWalkable(x, y) && nearWater(map, x, y);
  }
  if (t !== Terrain.Grass || !map.isWalkable(x, y)) return false;
  return def.habitat === 'forest' ? nearTree(map, x, y) : true;
}

/** Every tile a straight leg crosses is habitable (sampled every half tile). */
function legClear(map: GameMap, def: AnimalDef, x0: number, y0: number, x1: number, y1: number): boolean {
  const n = Math.ceil(hypot(x1 - x0, y1 - y0) * 2);
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    if (!habitable(map, def, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t))) return false;
  }
  return true;
}

function restTicks(rng: Rng, def: AnimalDef): number {
  return def.rest[0] + randInt(rng, def.rest[1] - def.rest[0] + 1);
}

/** Places the herds of every kind on a new map, away from the start positions and anyone's land. */
export function spawnAnimals(w: World, starts: { x: number; y: number }[]): void {
  const { map } = w;
  const rng = w.animalRng;
  const area = (map.w * map.h) / (64 * 64);
  for (const kind of ANIMAL_KINDS) {
    const def: AnimalDef = ANIMALS[kind];
    const herds = Math.round(def.herds * area);
    for (let h = 0; h < herds; h++) {
      let home: { x: number; y: number } | null = null;
      for (let k = 0; k < HOME_TRIES && !home; k++) {
        const x = randInt(rng, map.w);
        const y = randInt(rng, map.h);
        if (!habitable(map, def, x, y) || map.owner[map.idx(x, y)] !== 0) continue;
        if (starts.some((s) => dist2(x - s.x, y - s.y) < ANIMAL_START_CLEARANCE * ANIMAL_START_CLEARANCE)) continue;
        home = { x, y };
      }
      if (!home) continue;
      const size = def.herd[0] + randInt(rng, def.herd[1] - def.herd[0] + 1);
      for (let m = 0; m < size; m++) {
        // Members start around the home spot, on habitable tiles.
        let x = home.x;
        let y = home.y;
        for (let k = 0; k < 8; k++) {
          const cx = home.x + randInt(rng, 5) - 2;
          const cy = home.y + randInt(rng, 5) - 2;
          if (habitable(map, def, cx, cy)) {
            x = cx;
            y = cy;
            break;
          }
        }
        w.animals.push({
          id: w.nextAnimalId++,
          kind,
          x,
          y,
          px: x,
          py: y,
          tx: x,
          ty: y,
          rest: restTicks(rng, def),
          hx: home.x,
          hy: home.y,
        });
      }
    }
  }
}

/** Spawn squares across and down the map (`ANIMAL_SPAWN.square`; S4's `XYToVW`). */
function squaresOf(map: GameMap): [number, number] {
  return [Math.floor(map.w / ANIMAL_SPAWN.square), Math.floor(map.h / ANIMAL_SPAWN.square)];
}

const caps = new WeakMap<GameMap, number>();

/**
 * How many counted animals (`AnimalDef.spawn`) the map holds at most: S4's `CAnimalMgr::Init`,
 * LAND_POP × land % (at least 1) × squares / 10000, never above `ANIMAL_SPAWN.max`. Terrain never
 * changes at runtime, so it is worked out once per map (derived).
 */
export function animalCap(map: GameMap): number {
  let cap = caps.get(map);
  if (cap === undefined) {
    let land = 0;
    for (let i = 0; i < map.terrain.length; i++) if (!TERRAIN[map.terrain[i] as Terrain].water) land++;
    const percent = Math.max(1, Math.floor((100 * land) / (map.w * map.h)));
    const [sx, sy] = squaresOf(map);
    cap = Math.min(ANIMAL_SPAWN.max, Math.floor((ANIMAL_SPAWN.landPop * percent * sx * sy) / 10000));
    caps.set(map, cap);
  }
  return cap;
}

/** Spawn attempts this tick: one per S4 tick, spread evenly over ours (no randomness). */
function attemptsAt(tick: number): number {
  const r = ANIMAL_SPAWN.attemptsPerTick;
  return Math.floor((tick + 1) * r + 1e-9) - Math.floor(tick * r + 1e-9);
}

/** The density class of a square by its mature trees, or null for open land or one with a building. */
function densityOf(map: GameMap, x0: number, y0: number): ForestDensity | null {
  const S = ANIMAL_SPAWN.square;
  let trees = 0;
  for (let y = y0; y < y0 + S; y++) {
    for (let x = x0; x < x0 + S; x++) {
      const i = map.idx(x, y);
      // S4 breeds no game in a square of the town (`SpawnAnimalInTown` has no Roman kinds).
      if (map.building[i] !== 0) return null;
      if (map.tree[i] === TREE_MATURE) trees++;
    }
  }
  const t = ANIMAL_SPAWN.trees;
  return trees >= t.deep ? 'deep' : trees >= t.light ? 'light' : trees >= t.plain ? 'plain' : null;
}

/**
 * Settlers 4's animal manager (`ANIMAL_SPAWN`): while the map holds fewer counted animals than its cap,
 * each attempt picks a random square; one with no animal in it and a fitting kind gets a newborn on a
 * habitable tile by a tree (the square scanned from a random tile, as `SpawnAnimalBehindTree` does),
 * which makes that spot its home.
 */
function spawnGame(w: World): void {
  let n = attemptsAt(w.tick);
  if (n === 0) return;
  const { map } = w;
  const rng = w.animalRng;
  const [sx, sy] = squaresOf(map);
  if (sx === 0 || sy === 0) return;
  const cap = animalCap(map);
  let counted = 0;
  let other = 0;
  for (const a of w.animals) {
    const def: AnimalDef = ANIMALS[a.kind];
    if (!def.spawn) continue;
    counted++;
    if (!def.game) other++;
  }
  if (counted >= cap) return;
  const S = ANIMAL_SPAWN.square;
  const occupied = new Set<number>();
  for (const a of w.animals) {
    const qx = Math.floor(a.x / S);
    const qy = Math.floor(a.y / S);
    if (qx < sx && qy < sy) occupied.add(qy * sx + qx);
  }
  for (; n > 0 && counted < cap; n--) {
    const qx = randInt(rng, sx);
    const qy = randInt(rng, sy);
    if (occupied.has(qy * sx + qx)) continue;
    const density = densityOf(map, qx * S, qy * S);
    if (!density) continue;
    const kinds = ANIMAL_KINDS.filter((k) => (ANIMALS[k] as AnimalDef).spawn?.includes(density));
    if (kinds.length === 0) continue;
    const kind = kinds[randInt(rng, kinds.length)];
    const def: AnimalDef = ANIMALS[kind];
    if (!def.game && other >= cap * ANIMAL_SPAWN.otherShare) continue;
    const start = randInt(rng, S * S);
    for (let k = 0; k < S * S; k++) {
      const j = (start + k) % (S * S);
      const x = qx * S + (j % S);
      const y = qy * S + Math.floor(j / S);
      if (!habitable(map, def, x, y) || !nearTree(map, x, y, 1)) continue;
      w.animals.push({ id: w.nextAnimalId++, kind, x, y, px: x, py: y, tx: x, ty: y, rest: restTicks(rng, def), hx: x, hy: y });
      occupied.add(qy * sx + qx);
      counted++;
      if (!def.game) other++;
      break;
    }
  }
}

/** One tick for every animal: O(1) each, plus a few habitat checks when a new leg is chosen. */
export function updateAnimals(w: World): void {
  const { map } = w;
  const rng = w.animalRng;
  spawnGame(w);
  for (const a of w.animals) {
    a.px = a.x;
    a.py = a.y;
    const def: AnimalDef = ANIMALS[a.kind];
    if (a.rest > 0) {
      a.rest--;
      continue;
    }
    const dx = a.tx - a.x;
    const dy = a.ty - a.y;
    const d = hypot(dx, dy);
    if (d > 1e-6) {
      if (d <= def.speed) {
        a.x = a.tx;
        a.y = a.ty;
        a.rest = restTicks(rng, def);
        continue;
      }
      const nx = a.x + (dx / d) * def.speed;
      const ny = a.y + (dy / d) * def.speed;
      // The world changes under its feet (a site, a sapling): stop and rest instead of walking in.
      // Checked only when it enters another tile, and not when it walks out of an unfit one.
      const nextTile = Math.round(nx) !== Math.round(a.x) || Math.round(ny) !== Math.round(a.y);
      if (
        nextTile &&
        !habitable(map, def, Math.round(nx), Math.round(ny)) &&
        habitable(map, def, Math.round(a.x), Math.round(a.y))
      ) {
        a.tx = a.x;
        a.ty = a.y;
        a.rest = restTicks(rng, def);
        continue;
      }
      a.x = nx;
      a.y = ny;
      continue;
    }
    // Choose the next leg: a habitable spot near home, reachable in a straight line. Something built
    // or planted where it stands: it walks out, ignoring its habitat on the way.
    const stuck = !habitable(map, def, Math.round(a.x), Math.round(a.y));
    let found = false;
    for (let k = 0; k < LEG_TRIES && !found; k++) {
      const tx = a.hx + rng() * def.roam * 2 - def.roam;
      const ty = a.hy + rng() * def.roam * 2 - def.roam;
      if (!habitable(map, def, Math.round(tx), Math.round(ty))) continue;
      if (!stuck && !legClear(map, def, a.x, a.y, tx, ty)) continue;
      a.tx = tx;
      a.ty = ty;
      found = true;
    }
    if (!found) a.rest = restTicks(rng, def);
  }
}
