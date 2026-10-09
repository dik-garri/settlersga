import { addBuilding, spawnSettler } from '../sim/buildings';
import { recomputeTerritory } from '../sim/territory';
import { BUILD_TICKS_PER_UNIT, BUILDINGS, costOf, hpOf, ORE_RESOURCES, totalCost } from '../sim/config';
import { clearStrokes } from '../sim/digging';
import { ENDLESS } from '../sim/economy';
import { formationSpots } from '../sim/field';
import { enterGarrison } from '../sim/military';
import { dropGoods } from '../sim/ground';
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

/** A finished building of `owner`'s on the free spot nearest (x, y), placed directly (dev aid). */
function placeFor(w: World, type: BuildingType, owner: number, x: number, y: number): Building | null {
  for (let r = 0; r <= 10; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !w.canPlace(type, x + dx, y + dy, owner)) continue;
        const b = addBuilding(w, type, x + dx, y + dy, owner, true);
        recomputeTerritory(w);
        return b;
      }
    }
  }
  return null;
}

/** An own tile next to neutral land, on the side away from the other player (where to send a pioneer). */
function borderTile(w: World, cx: number, cy: number): { x: number; y: number } | null {
  const m = w.map;
  const away = w.homeOf(2);
  let best: { x: number; y: number } | null = null;
  let bestD = -Infinity;
  for (let y = 1; y < m.h - 1; y++) {
    for (let x = 1; x < m.w - 1; x++) {
      if (m.owner[m.idx(x, y)] !== 0 || !m.isWalkable(x, y)) continue;
      if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => m.owner[m.idx(x + dx, y + dy)] === LOCAL_PLAYER)) continue;
      if (Math.hypot(x - cx, y - cy) > 40) continue;
      const d = Math.hypot(x - away.x, y - away.y);
      if (d > bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * A manned tower on neutral land well beyond the border, on the side away from the other player, whose
 * land touches none of ours: a piece of land cut off from every warehouse (dev aid, placed directly).
 */
function outpost(w: World, cx: number, cy: number): Building | null {
  const m = w.map;
  const def = BUILDINGS.tower;
  const reach = (def.territory ?? 0) + 2;
  const rival = w.homeOf(2);
  const base = Math.atan2(cy - rival.y, cx - rival.x);
  for (let r = 30; r <= 50; r++) {
    for (let k = 0; k < 32; k++) {
      const a = base + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * Math.PI) / 16;
      const x = Math.round(cx + Math.cos(a) * r);
      const y = Math.round(cy + Math.sin(a) * r);
      let ok = m.inBounds(x - reach, y - reach) && m.inBounds(x + reach, y + reach);
      for (let dy = 0; dy <= def.h && ok; dy++) {
        for (let dx = 0; dx < def.w && ok; dx++) ok = m.isBuildable(x + dx, y + dy, 'ground');
      }
      for (let dy = -reach; dy <= reach && ok; dy++) {
        for (let dx = -reach; dx <= reach && ok; dx++) ok = m.owner[m.idx(x + dx, y + dy)] === 0;
      }
      if (!ok) continue;
      const t = addBuilding(w, 'tower', x, y, LOCAL_PLAYER, true);
      enterGarrison(w, t, spawnSettler(w, 'soldier', t));
      recomputeTerritory(w);
      return t;
    }
  }
  showcaseMisses.push('outpost');
  return null;
}

/** The tile nearest (x, y) with walkable, unbuilt ground all round (5×5), so a squad stands close. */
function openGround(w: World, x: number, y: number): { x: number; y: number } {
  const m = w.map;
  const free = (tx: number, ty: number) =>
    m.inBounds(tx, ty) && m.isWalkable(tx, ty) && m.door[m.idx(tx, ty)] === 0 && m.building[m.idx(tx, ty)] === 0;
  for (let r = 0; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        let ok = true;
        for (let oy = -2; oy <= 2 && ok; oy++) for (let ox = -2; ox <= 2 && ok; ox++) ok = free(x + dx + ox, y + dy + oy);
        if (ok) return { x: x + dx, y: y + dy };
      }
    }
  }
  return { x, y };
}

function run(w: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.step();
}

export function buildShowcase(): World {
  // A second, passive player far away: someone for the thief to rob.
  const w = new World(SHOWCASE_SEED, { size: SIZE, players: 2 });
  // No headquarters (Settlers 4): the start tower, its goods on the ground round it.
  const home = w.homeOf(LOCAL_PLAYER);
  const c = w.buildingAt(home.x, home.y)!;
  // The start position (the tower's footprint centre, rounded).
  const cx = Math.round(c.x + (c.w - 1) / 2);
  const cy = Math.round(c.y + (c.h - 1) / 2);
  // Plenty of everything in a warehouse that takes every good, so every building gets built and staffed.
  const depot = placeNear(w, 'warehouse', cx + 4, cy + 5, true);
  if (depot) {
    for (const r of RESOURCES) {
      w.setAccepts(depot.id, r, true);
      depot.output[r] += 40;
    }
    depot.output.plank += 400;
    depot.output.stone += 400;
  }
  // Free fighters standing by (Settlers 4): each finished tower calls one in, the filled ones more.
  for (let i = 0; i < 36; i++) spawnSettler(w, 'soldier', c).inside = null;
  for (let i = 0; i < 24; i++) spawnSettler(w, 'archer', c).inside = null;
  for (let i = 0; i < 64; i++) spawnSettler(w, 'carrier', c);
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
  // The towers are filled by order («Заполнить»): the free fighters walk in.
  for (const b of w.buildings.values()) if (b.owner === LOCAL_PLAYER && b.done && BUILDINGS[b.type].garrison) w.fillGarrison(b.id);

  // Every building type, finished and staffed, in a ring around the start.
  const types = (Object.keys(BUILDINGS) as BuildingType[]).filter((t) => BUILDINGS[t].playerBuildable && t !== 'tower');
  types.forEach((type, k) => {
    const a = (k / types.length) * Math.PI * 2;
    const r = BUILDINGS[type].terrain === 'mountain' ? 14 : 7 + (k % 2) * 3;
    placeNear(w, type, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  });
  run(w, 9000);
  // Recruits ordered at the barracks (Settlers 4: nobody unasked); they come out and stand by it.
  w.orderRecruits('soldier', 0, 2);
  w.orderRecruits('archer', 2, 1);
  // A site on a slope takes its diggers a while at Settlers 4's walking pace: give stragglers time.
  for (let k = 0; k < 12 && [...w.buildings.values()].some((b) => !b.done && b.owner === LOCAL_PLAYER); k++) run(w, 1000);

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

  // A full storage yard (Settlers 4: 8 piles of 8; the 3D yard shows its piles on the platform),
  // coal on two of them; frozen so the stock is not hauled away.
  const yard = [...w.buildings.values()].find((b) => b.type === 'warehouse' && b.done);
  if (yard) {
    yard.unreachableUntil = FROZEN;
    for (const r of RESOURCES) yard.output[r] = 0;
    (['log', 'plank', 'stone', 'grain', 'flour', 'bread'] as Resource[]).forEach((r, k) => {
      yard.output[r] = 3 + k;
    });
    yard.output.coal = 16;
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
  // A field of geologist's signs on that mountain: every ore with one, two and three symbols (the
  // nearest tiles get those, the ore under them set to match), then the mountain's own ore, and bare
  // boards where there is none. The geologist below goes on round it.
  if (best >= 0) {
    const bx = best % m.w;
    const by = Math.floor(best / m.w);
    const field: number[] = [];
    for (let y = by - 4; y <= by + 4; y++) {
      for (let x = bx - 4; x <= bx + 4; x++) {
        if (!m.inBounds(x, y) || Math.hypot(x - bx, y - by) > 3.6) continue;
        const i = m.idx(x, y);
        if (m.terrain[i] === Terrain.Mountain && m.isWalkable(x, y) && m.building[i] === 0) field.push(i);
      }
    }
    field.sort((a, b) => Math.hypot((a % m.w) - bx, Math.floor(a / m.w) - by) - Math.hypot((b % m.w) - bx, Math.floor(b / m.w) - by) || a - b);
    const samples = ORE_RESOURCES.flatMap((_, k) => [1, 2, 3].map((level) => ({ code: k + 1, amount: [8, 28, 60][level - 1] })));
    field.forEach((i, k) => {
      if (k < samples.length) {
        m.ore[i] = samples[k].code;
        m.oreAmount[i] = samples[k].amount;
      }
      m.prospected[i] |= 1 << (LOCAL_PLAYER - 1);
      m.signAt[i] = w.tick + 1;
      m.signBy[i] = LOCAL_PLAYER;
      m.touch(i);
    });
  }
  // Sent last, so he is still out prospecting when the demo opens.
  if (best >= 0) {
    spawnSettler(w, 'carrier', c); // an idle carrier to become the geologist
    w.sendGeologist(best % m.w, Math.floor(best / m.w));
  }
  // Specialists at work: a pioneer pushing the border out past the ring of towers, and a thief at a
  // warehouse of the other player's (both start close to their goal, so they are busy as it opens).
  w.orderSpecialist('pioneer', 1);
  w.orderSpecialist('thief', 1);
  // Recruits first fetch their tool (a shovel for the pioneer) from wherever it lies.
  for (let i = 0; i < 30 && !(['pioneer', 'thief'] as const).every((k) => w.settlers.some((s) => s.kind === k)); i++) run(w, 40);
  const pioneer = w.settlers.find((s) => s.kind === 'pioneer');
  const edge = borderTile(w, cx, cy);
  if (pioneer && edge) {
    pioneer.x = pioneer.px = edge.x;
    pioneer.y = pioneer.py = edge.y;
    pioneer.inside = null;
    w.sendPioneer(edge.x, edge.y);
  }
  const other = w.homeOf(2);
  const store = placeFor(w, 'warehouse', 2, other.x + 8, other.y + 6);
  const thief = w.settlers.find((s) => s.kind === 'thief');
  if (store && thief) {
    store.unreachableUntil = FROZEN;
    (['plank', 'stone', 'fish', 'iron'] as Resource[]).forEach((r, k) => (store.output[r] += 4 + k));
    // Player 1 has scouted it.
    for (let y = store.y - 3; y <= store.door.y + 3; y++) {
      for (let x = store.x - 3; x <= store.door.x + 3; x++) if (m.inBounds(x, y)) m.explored[m.idx(x, y)] |= 1;
    }
    thief.x = thief.px = store.door.x - 4;
    thief.y = thief.py = store.door.y + 3;
    thief.inside = null;
    w.sendThief(store.id);
  }
  // Trade (Settlers 4 logistics): a manned tower out on its own beyond the border — land cut off from
  // every warehouse, marked as such — with a market of its own; donkeys carry planks and stone there
  // from the market by the start, and a site on that land is built with what they bring.
  const market = [...w.buildings.values()].find((b) => b.type === 'market' && b.done);
  const post = market ? outpost(w, cx, cy) : null;
  const away = post ? placeFor(w, 'market', LOCAL_PLAYER, post.x + 3, post.y + 2) : null;
  if (market && away) {
    w.setTradeRoute(market.id, away.id);
    w.orderTrade(market.id, 'plank', ENDLESS);
    w.orderTrade(market.id, 'stone', ENDLESS);
    // The first loads already waiting: at the walking pace carriers would take minutes to bring them.
    market.input.plank += 8;
    market.input.stone += 8;
    for (let k = 0; k < 3; k++) spawnSettler(w, 'donkey', market);
    const site = placeNear(w, 'woodcutter', away.x + 2, away.y - 3);
    if (site) {
      site.levelled = true;
      site.dug = clearStrokes(site);
    }
  }
  // Goods on the ground (Settlers 4's piles: the start goods, ruins): a burnt hut's goods on that
  // cut-off land — no warehouse there takes them and no site wants them, so they stay to be seen.
  if (post) {
    const at = { x: post.door.x - 3, y: post.door.y + 2 };
    (['fish', 'coal', 'iron', 'sword', 'axe', 'bread', 'gold', 'ironore'] as Resource[]).forEach((r, k) => dropGoods(w, at, r, 1 + ((k * 3) % 8)));
  }
  // A field squad round its leader (direct army control): it marches out and stands in formation.
  const squad = (['leader', 'soldier', 'soldier', 'soldier', 'soldier', 'archer', 'archer'] as const).map((kind) => {
    const s = spawnSettler(w, kind, c);
    s.hp = hpOf(kind);
    s.inside = null;
    s.home = null;
    return s.id;
  });
  const open = openGround(w, c.door.x - 5, c.door.y + 5);
  const field = formationSpots(w, open.x, open.y, 1)[0];
  if (field) w.orderMove(squad, field.x, field.y);
  // A few wounded in the start tower and the first towers: they walk to the infirmary and lie there
  // while the demo opens.
  const garrisons = [...w.buildings.values()].filter((b) => b.owner === LOCAL_PLAYER && b.garrison.length > 1);
  for (const id of garrisons.slice(0, 3).map((b) => b.garrison[b.garrison.length - 1])) {
    const s = w.getSettler(id);
    if (s) s.hp = 8;
  }
  // Long enough for the squad to reach its formation at Settlers 4's walking pace.
  run(w, 450);
  return w;
}
