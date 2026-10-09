import { centerOf, doorOf } from '../sim/buildings';
import { BUILDINGS, ORE_RESOURCES, TERRAIN, TREE_MATURE } from '../sim/config';
import { needsLevelling } from '../sim/digging';
import { START_GUARANTEES } from '../sim/map';
import { RESOURCES, Terrain, type Building, type BuildingType, type PlayerId, type Point } from '../sim/types';
import { startPositions, type World } from '../sim/world';
import { defaultWorkCentre, workRadius } from '../sim/workArea';
import type { Anchor, AnchorKind, Prefer } from './types';

/**
 * Anchors (docs/TUTORIAL.md §2.1): places on the map found from public data — the start, the
 * guaranteed start features (`START_GUARANTEES`), the best spot for a building, the nearest water —
 * instead of coordinates written into a mission. One resolver per kind in `ANCHORS` (the mapped type
 * makes the compiler demand an entry for every kind). Fixed anchors are resolved once and kept with
 * the mission's progress; `building` and `pile` follow the world and are found again on every check.
 */

export interface AnchorCtx {
  world: World;
  player: PlayerId;
  /** The scenario's building names (`World.tags`, kept with the mission's progress: the world does not save them). */
  tags: Record<string, number>;
  resolve: (a: Anchor) => Point | null;
}

type Resolvers = { [K in AnchorKind]: (a: Extract<Anchor, { a: K }>, ctx: AnchorCtx) => Point | null };

/** The player's start position (the centre of the start tower), public like the map size. */
function startOf(w: World, player: PlayerId): Point {
  return startPositions(w.map.w, w.players.length)[player - 1] ?? w.homeOf(player);
}

/** The building's footprint centre. */
const centre = (b: Building): Point => centerOf(b);

/** The tile nearest `at` within `r` (ring after ring, row order within a ring) for which `test` holds. */
export function nearestTile(w: World, at: Point, r: number, test: (x: number, y: number) => boolean): Point | null {
  const cx = Math.round(at.x);
  const cy = Math.round(at.y);
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!w.map.inBounds(x, y)) continue;
      const d = Math.hypot(x - at.x, y - at.y);
      if (d > r || d >= bestD || !test(x, y)) continue;
      best = { x, y };
      bestD = d;
    }
  }
  return best;
}

/**
 * How much of what a building wants lies within `r` of its work centre (`spot` anchors: the door of a
 * hut, the middle of a mine).
 */
const PREFER: Record<Prefer, (w: World, door: Point, r: number, player: PlayerId, type: BuildingType) => number> = {
  forest: (w, door, r) => count(w, door, r, (i) => w.map.tree[i] >= TREE_MATURE),
  stone: (w, door, r) => 1.5 * count(w, door, r, (i) => w.map.stone[i] > 0),
  water: (w, door, r) => Math.min(10, 0.5 * count(w, door, r, (i) => TERRAIN[w.map.terrain[i] as Terrain].water)),
  meadow: (w, door, r) => 0.2 * count(w, door, r, (i) => TERRAIN[w.map.terrain[i] as Terrain].plantable && w.map.tree[i] === 0),
  border: (w, door, r, player) => 0.3 * count(w, door, r, (i) => w.map.owner[i] !== player),
  // A mine's own ore (`def.mine.res`) under its digging disc.
  ore: (w, at, r, _player, type) => {
    const res = BUILDINGS[type].mine?.res;
    const code = res ? ORE_RESOURCES.indexOf(res) + 1 : 0;
    return code ? 2 * count(w, at, r, (i) => w.map.ore[i] === code && w.map.oreAmount[i] > 0) : 0;
  },
};

function count(w: World, at: Point, r: number, test: (i: number) => boolean): number {
  let n = 0;
  for (let y = Math.ceil(at.y - r); y <= at.y + r; y++) {
    for (let x = Math.ceil(at.x - r); x <= at.x + r; x++) {
      if (w.map.inBounds(x, y) && Math.hypot(x - at.x, y - at.y) <= r && test(w.map.idx(x, y))) n++;
    }
  }
  return n;
}

/** How far from its anchor a `spot` is looked for, by default. */
const SPOT_WITHIN = 12;

export const ANCHORS: Resolvers = {
  home: (_a, { world, player }) => {
    const h = world.homeOf(player);
    const tower = world.buildingAt(h.x, h.y);
    return tower ? centre(tower) : { ...h };
  },
  enemyHome: (a, { world, player }) => {
    const foe = a.player ?? world.players.find((p) => !world.allied(p.id, player))?.id;
    return foe ? startOf(world, foe) : null;
  },
  guarantee: (a, { world, player }) => {
    const st = startOf(world, player);
    if (a.mountain !== undefined) {
      const m = START_GUARANTEES.mountains[a.mountain];
      if (!m) return null;
      const lobe = a.lobe !== undefined ? m.lobes[a.lobe] : undefined;
      if (a.lobe !== undefined && !lobe) return null;
      return { x: st.x + m.dx + (lobe?.dx ?? 0), y: st.y + m.dy + (lobe?.dy ?? 0) };
    }
    if (a.quarry !== undefined) {
      const q = START_GUARANTEES.quarries[a.quarry];
      if (!q) return null;
      // A guaranteed quarry may come out thin: its stone nearest the planned centre, if any.
      return nearestTile(world, { x: st.x + q.dx, y: st.y + q.dy }, Math.ceil(q.r) + 2, (x, y) => world.map.stone[world.map.idx(x, y)] > 0);
    }
    if (a.grove) {
      const g = START_GUARANTEES.grove;
      return { x: st.x + g.dx, y: st.y + g.dy };
    }
    if (a.pond) {
      const p = START_GUARANTEES.pond;
      return { x: st.x + p.dx, y: st.y + p.dy };
    }
    return null;
  },
  spot: (a, { world, player, resolve }) => {
    const near = resolve(a.near);
    if (!near) return null;
    const def = BUILDINGS[a.type];
    const r = a.within ?? SPOT_WITHIN;
    const work = workRadius(a.type) ?? 6;
    let best: Point | null = null;
    let bestScore = -Infinity;
    for (let y = Math.floor(near.y - r); y <= near.y + r; y++) {
      for (let x = Math.floor(near.x - r); x <= near.x + r; x++) {
        if (!world.canPlace(a.type, x, y, player)) continue;
        const c = { x: x + (def.w - 1) / 2, y: y + (def.h - 1) / 2 };
        const d = Math.hypot(c.x - near.x, c.y - near.y);
        if (d > r) continue;
        const door = doorOf(x, y, def.w, def.h);
        let score = -d;
        // Behind what stands at the anchor (seen from the camera) the arrow would point at its roof.
        if (c.x + c.y < near.x + near.y - 1) score -= 3;
        if (def.terrain !== 'mountain' && needsLevelling(world.map, a.type, x, y)) score -= 4;
        if (a.prefer) score += PREFER[a.prefer](world, defaultWorkCentre(a.type, door, c), work, player, a.type);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    return best;
  },
  nearest: (a, { world, player, resolve }) => {
    const from = resolve(a.from);
    if (!from) return null;
    const m = world.map;
    const ownAt = (x: number, y: number) => m.inBounds(x, y) && m.owner[m.idx(x, y)] === player;
    const test: Record<typeof a.terrain, (i: number) => boolean> = {
      water: (i) => TERRAIN[m.terrain[i] as Terrain].water,
      meadow: (i) => TERRAIN[m.terrain[i] as Terrain].plantable && m.tree[i] === 0 && m.building[i] === 0,
      forest: (i) => m.tree[i] >= TREE_MATURE,
      // Open land a pioneer can claim: nobody's, walkable, unbuilt, beside the player's own.
      border: (i) => {
        const x = i % m.w;
        const y = (i - x) / m.w;
        return m.owner[i] === 0 && m.isWalkable(x, y) && m.building[i] === 0 &&
          (ownAt(x + 1, y) || ownAt(x - 1, y) || ownAt(x, y + 1) || ownAt(x, y - 1));
      },
    };
    return nearestTile(world, from, 24, (x, y) => test[a.terrain](m.idx(x, y)));
  },
  building: (a, { world, player, tags, resolve }) => {
    if (a.owner === 'scenario') {
      const id = a.tag !== undefined ? (tags[a.tag] ?? world.tags.get(a.tag)) : undefined;
      const b = id !== undefined ? world.buildings.get(id) : undefined;
      return b && b.type === a.type ? centre(b) : null;
    }
    // Own buildings: the newest of the type, or the nearest to `near`. Enemy ones: the nearest explored
    // one (fog rule, as the AI's).
    let best: Building | null = null;
    const home = world.homeOf(player);
    const to = a.near ? resolve(a.near) : null;
    if (a.near && !to) return null;
    const dist = (b: Building) => (to ? Math.hypot(b.door.x - to.x, b.door.y - to.y) : -b.id);
    for (const b of world.buildings.values()) {
      if (b.type !== a.type) continue;
      if (a.owner === 'me') {
        if (b.owner === player && (!best || dist(b) < dist(best))) best = b;
      } else if (!world.allied(b.owner, player) && world.isExplored(b.door.x, b.door.y, player)) {
        if (!best || Math.hypot(b.door.x - home.x, b.door.y - home.y) < Math.hypot(best.door.x - home.x, best.door.y - home.y)) best = b;
      }
    }
    return best ? centre(best) : null;
  },
  pile: (a, { world, player, resolve }) => {
    const near = resolve(a.near);
    if (!near) return null;
    const k = RESOURCES.indexOf(a.res) + 1;
    const m = world.map;
    return nearestTile(world, near, 12, (x, y) => {
      const i = m.idx(x, y);
      return m.goods[i] === k && m.owner[i] === player;
    });
  },
  between: (a, { resolve }) => {
    const p = resolve(a.from);
    const q = resolve(a.to);
    return p && q ? { x: p.x + (q.x - p.x) * a.t, y: p.y + (q.y - p.y) * a.t } : null;
  },
  offset: (a, { resolve }) => {
    const p = resolve(a.from);
    return p ? { x: p.x + a.dx, y: p.y + a.dy } : null;
  },
};

/** Whether an anchor follows the world (found again on every check) rather than being fixed at first use. */
const LIVE: { [K in AnchorKind]: (a: Extract<Anchor, { a: K }>) => boolean } = {
  home: () => false,
  enemyHome: () => false,
  guarantee: () => false,
  building: () => true,
  pile: () => true,
  spot: (a) => isLive(a.near),
  nearest: (a) => isLive(a.from),
  between: (a) => isLive(a.from) || isLive(a.to),
  offset: (a) => isLive(a.from),
};

export const isLive = (a: Anchor): boolean => (LIVE[a.a] as (a: Anchor) => boolean)(a);

export const anchorKey = (a: Anchor): string => JSON.stringify(a);

/**
 * A resolver with a cache: fixed anchors are resolved once (the cache is part of the mission's saved
 * progress), live ones every time.
 */
export function anchorResolver(
  world: World,
  player: PlayerId,
  cache: Record<string, Point | null>,
  tags: Record<string, number> = {},
): (a: Anchor) => Point | null {
  const resolve = (a: Anchor): Point | null => {
    const live = isLive(a);
    const key = live ? '' : anchorKey(a);
    if (!live && key in cache) return cache[key];
    const run = ANCHORS[a.a] as (a: Anchor, ctx: AnchorCtx) => Point | null;
    const p = run(a, { world, player, tags, resolve });
    if (!live) cache[key] = p;
    return p;
  };
  return resolve;
}
