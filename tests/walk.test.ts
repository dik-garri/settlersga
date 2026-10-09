import { describe, expect, it } from 'vitest';
import { spawnSettler } from '../src/sim/buildings';
import { OWN_LAND_WALK } from '../src/sim/config';
import { findPath, pathStats } from '../src/sim/pathfinding';
import { route } from '../src/sim/walk';
import { World } from '../src/sim/world';
import { startTower } from './helpers';

/** A block of `w`×`h` walkable tiles of player 1 (top-left corner), searched from the start outwards. */
function openBlock(world: World, w: number, h: number): { x: number; y: number } {
  const m = world.map;
  const t = startTower(world);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y + h <= m.h; y++) {
    for (let x = 0; x + w <= m.w; x++) {
      let ok = true;
      for (let dy = 0; dy < h && ok; dy++) {
        for (let dx = 0; dx < w && ok; dx++) {
          const i = m.idx(x + dx, y + dy);
          ok = m.owner[i] === 1 && m.isWalkable(x + dx, y + dy) && m.door[i] === 0;
        }
      }
      const d = Math.hypot(x - t.x, y - t.y);
      if (ok && d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  expect(best).not.toBeNull();
  return best!;
}

describe("workers' routes stay on their land (Settlers 4's CWalkingWorker)", () => {
  // A foreign enclave in the middle of an open block of player 1's land: the straight line between
  // the block's left and right edge runs through it, the land goes round it.
  function setup() {
    const w = new World(42, { players: 2 });
    const m = w.map;
    const b = openBlock(w, 9, 5);
    for (let dy = 1; dy <= 3; dy++) for (let dx = 3; dx <= 5; dx++) m.owner[m.idx(b.x + dx, b.y + dy)] = 2;
    w.territoryVersion++;
    const from = { x: b.x, y: b.y + 2 };
    const to = { x: b.x + 8, y: b.y + 2 };
    return { w, m, from, to };
  }

  it('a carrier goes round foreign land inside his piece instead of cutting across it', () => {
    const { w, m, from, to } = setup();
    const plain = findPath(m, from.x, from.y, to.x, to.y)!;
    expect(plain.some((p) => m.owner[m.idx(p.x, p.y)] === 2)).toBe(true);
    const carrier = spawnSettler(w, 'carrier', startTower(w));
    const p = route(w, carrier, from.x, from.y, to.x, to.y)!;
    expect(p).not.toBeNull();
    expect(p[p.length - 1]).toEqual(to);
    expect(p.every((q) => m.owner[m.idx(q.x, q.y)] === 1)).toBe(true);
  });

  it('builders and workers too; fighters, specialists and donkeys walk anywhere', () => {
    const { w, m, from, to } = setup();
    const at = startTower(w);
    for (const kind of ['builder', 'digger', 'woodcutter'] as const) {
      const p = route(w, spawnSettler(w, kind, at), from.x, from.y, to.x, to.y)!;
      expect(p.every((q) => m.owner[m.idx(q.x, q.y)] === 1)).toBe(true);
    }
    for (const kind of ['soldier', 'pioneer', 'donkey'] as const) {
      const p = route(w, spawnSettler(w, kind, at), from.x, from.y, to.x, to.y)!;
      expect(p).toEqual(findPath(m, from.x, from.y, to.x, to.y));
    }
  });

  it('takes the plain route where his land holds none (another piece, or off his land)', () => {
    const { w, m, from, to } = setup();
    const carrier = spawnSettler(w, 'carrier', startTower(w));
    // Into the enclave: the goal is not on his land.
    const inside = { x: from.x + 4, y: from.y };
    expect(route(w, carrier, from.x, from.y, inside.x, inside.y)).toEqual(findPath(m, from.x, from.y, inside.x, inside.y));
    // A pocket of his own land walled off by foreign land is a piece of its own: plain route.
    const before = pathStats.landFallbacks;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) m.owner[m.idx(to.x - 1 + dx, to.y + dy)] = 2;
    w.territoryVersion++;
    const pocket = { x: to.x - 1, y: to.y };
    // The pocket is its own piece now (8-connected land), so it is another piece: plain route.
    expect(route(w, carrier, from.x, from.y, pocket.x, pocket.y)).toEqual(findPath(m, from.x, from.y, pocket.x, pocket.y));
    expect(pathStats.landFallbacks).toBe(before);
  });

  it('falls back to the plain route when the search on his land runs out of budget (counted)', () => {
    const { w, m, from, to } = setup();
    const carrier = spawnSettler(w, 'carrier', startTower(w));
    const saved = { ...OWN_LAND_WALK };
    OWN_LAND_WALK.budget = 1;
    OWN_LAND_WALK.perTile = 0;
    try {
      const before = pathStats.landFallbacks;
      expect(route(w, carrier, from.x, from.y, to.x, to.y)).toEqual(findPath(m, from.x, from.y, to.x, to.y));
      expect(pathStats.landFallbacks).toBe(before + 1);
    } finally {
      Object.assign(OWN_LAND_WALK, saved);
    }
  });
});
