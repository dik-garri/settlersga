import { addBuilding, recomputeTerritory, spawnSettler } from '../sim/buildings';
import { BUILD_TICKS_PER_UNIT, BUILDINGS, costOf, totalCost } from '../sim/config';
import { clearStrokes } from '../sim/digging';
import { enterGarrison } from '../sim/military';
import { RESOURCES, Terrain, type Building, type BuildingType, type Resource } from '../sim/types';
import { LOCAL_PLAYER, World } from '../sim/world';

/**
 * Development showcase (`?demo`): a live game that builds itself up so that everything the game can
 * draw is on screen at once — every building finished and staffed, workers at work, construction
 * sites frozen at each stage, and goods piles of every resource (some beyond one pile). Purely a dev
 * aid: it reaches into sim internals (direct spawns, frozen sites) that real play never uses.
 */
export const SHOWCASE_SEED = 7;
const SIZE = 128;
/** Frozen display objects are marked unreachable for ever, so logistics, builders and diggers leave them alone. */
const FROZEN = Number.MAX_SAFE_INTEGER;
/** Construction stages to freeze sites at: uncleared, then build progress per stage. */
const STAGE_PROGRESS = [-1, 0.1, 0.42, 0.75];

/** Places a building of `type` on the free spot nearest to (x, y); returns null if none fits. */
export let showcaseMisses: string[] = [];
function placeNear(w: World, type: BuildingType, x: number, y: number, done = false): Building | null {
  for (let r = 0; r <= 14; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = Math.round(x) + dx;
        const ty = Math.round(y) + dy;
        if (!w.canPlace(type, tx, ty)) continue;
        if (done) {
          const b = addBuilding(w, type, tx, ty, LOCAL_PLAYER, true);
          recomputeTerritory(w);
          return b;
        }
        const b = w.placeBuilding(type, tx, ty);
        if (b) return b;
      }
    }
  }
  showcaseMisses.push(`${type}@${Math.round(x)},${Math.round(y)}`);
  return null;
}

function run(w: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.step();
}

export function buildShowcase(): World {
  const w = new World(SHOWCASE_SEED, { size: SIZE, players: 1 });
  const c = w.castle;
  const cx = c.x + 1;
  const cy = c.y + 1;
  // Plenty of everything, so every building gets built and staffed.
  for (const r of RESOURCES) c.output[r] += 40;
  c.output.plank += 400;
  c.output.stone += 400;
  for (let i = 0; i < 48; i++) enterGarrison(w, c, spawnSettler(w, 'soldier', c));
  for (let i = 0; i < 40; i++) spawnSettler(w, 'carrier', c);
  for (let i = 0; i < 4; i++) spawnSettler(w, 'digger', c);
  // Builders and diggers come only as ordered (as in Settlers 4): order plenty.
  w.orderWorkers('builder', 16);
  w.orderWorkers('digger', 8);

  // Towers widen the land first.
  for (const [dx, dy] of [
    [11, 0],
    [-11, 0],
    [0, 11],
    [0, -11],
    [9, 9],
    [-9, -9],
  ]) {
    placeNear(w, 'tower', cx + dx, cy + dy);
  }
  run(w, 4000);
  // A second ring of big towers for room to show everything.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    placeNear(w, 'bigtower', cx + Math.cos(a) * 19, cy + Math.sin(a) * 19);
  }
  run(w, 5000);

  // Every building type, finished and staffed, in a ring around the castle.
  const types = (Object.keys(BUILDINGS) as BuildingType[]).filter((t) => BUILDINGS[t].playerBuildable && t !== 'tower');
  types.forEach((type, k) => {
    const a = (k / types.length) * Math.PI * 2;
    const r = BUILDINGS[type].terrain === 'mountain' ? 14 : 7 + (k % 2) * 3;
    placeNear(w, type, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  });
  run(w, 9000);

  // A row of construction sites frozen at each stage, for every building type.
  let row = 0;
  for (const type of types) {
    if (BUILDINGS[type].terrain === 'mountain') continue;
    for (let k = 0; k < STAGE_PROGRESS.length; k++) {
      const b = placeNear(w, type, cx - 22 + k * 5, cy + 6 + row * 5);
      if (!b) continue;
      b.unreachableUntil = FROZEN;
      const p = STAGE_PROGRESS[k];
      if (p < 0) continue;
      b.levelled = true;
      b.dug = clearStrokes(b);
      b.progress = Math.floor(p * totalCost(type) * BUILD_TICKS_PER_UNIT);
      // Materials already built in, so no site pile hides the stage.
      const used = Math.floor(b.progress / BUILD_TICKS_PER_UNIT);
      const cost = costOf(type);
      b.delivered.plank = Math.min(cost.plank ?? 0, used);
      b.delivered.stone = Math.min(cost.stone ?? 0, used - b.delivered.plank);
    }
    row++;
    if (row >= 3) break;
  }

  // Goods piles of every resource: frozen finished huts with four kinds each at their doors,
  // counts from 1 to 12 so piles split past eight.
  const kinds = [...RESOURCES];
  for (let k = 0; k * 4 < kinds.length; k++) {
    const hut = placeNear(w, 'forester', cx + 14 + (k % 2) * 6, cy - 16 + Math.floor(k / 2) * 5, true);
    if (!hut) continue;
    hut.unreachableUntil = FROZEN;
    kinds.slice(k * 4, k * 4 + 4).forEach((res: Resource, j) => {
      hut.output[res] = 1 + ((k * 4 + j) * 5) % 12;
    });
  }
  // Deer grazing by the hunter's lodge, so he has game to stalk.
  const lodge = [...w.buildings.values()].find((b) => b.type === 'hunter' && b.done);
  if (lodge) {
    for (let k = 0; k < 4; k++) {
      const x = lodge.door.x + 3 + (k % 2) * 2;
      const y = lodge.door.y + 2 + Math.floor(k / 2) * 2;
      if (!w.map.inBounds(x, y) || !w.map.isWalkable(x, y)) continue;
      w.animals.push({ id: w.nextAnimalId++, kind: 'deer', x, y, px: x, py: y, tx: x, ty: y, rest: 200 + k * 150, hx: x, hy: y });
    }
  }
  // A geologist prospecting the nearest mountain of ours.
  const m = w.map;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < m.terrain.length; i++) {
    if (m.terrain[i] !== Terrain.Mountain || m.owner[i] !== LOCAL_PLAYER) continue;
    const d = Math.hypot((i % m.w) - cx, Math.floor(i / m.w) - cy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  run(w, 600);
  // Sent last, so he is still out prospecting when the demo opens.
  if (best >= 0) {
    spawnSettler(w, 'carrier', c); // an idle carrier to become the geologist
    w.sendGeologist(best % m.w, Math.floor(best / m.w));
  }
  run(w, 30);
  return w;
}
