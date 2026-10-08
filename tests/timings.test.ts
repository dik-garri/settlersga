import { describe, expect, it } from 'vitest';
import { BUILD_TICKS_PER_UNIT, BUILDINGS, buildersOf, PATHS, SETTLER_SPEED, totalCost } from '../src/sim/config';
import { spawnSettler } from '../src/sim/buildings';
import { killSettler } from '../src/sim/military';
import { findPath } from '../src/sim/pathfinding';
import type { Building, BuildingType, SettlerKind } from '../src/sim/types';
import { World } from '../src/sim/world';

/**
 * Settlers 4's timings (docs/TIMINGS.md): several builders on one site add up, carriers walk faster
 * on roads, other settlers do not.
 */

/** A woodcutter site near the castle with all its material on site and the ground cleared. */
function readySite(w: World): Building {
  const c = w.castle;
  for (let r = 3; r < 12; r++) {
    for (let y = c.y - r; y <= c.y + r; y++) {
      for (let x = c.x - r; x <= c.x + r; x++) {
        if (!w.canPlace('woodcutter', x, y)) continue;
        const b = w.placeBuilding('woodcutter', x, y);
        if (!b) continue;
        b.levelled = true;
        for (const [res, n] of Object.entries(BUILDINGS.woodcutter.cost)) b.delivered[res as 'plank'] = n ?? 0;
        return b;
      }
    }
  }
  throw new Error('no spot');
}

/** Ticks from the first hammer blow until the site stands, with `builders` builders about. */
function buildTicks(builders: number): number {
  const w = new World(42);
  w.orderWorkers('builder', builders);
  for (const s of w.settlers.filter((s) => s.kind === 'builder').slice(builders)) killSettler(w, s);
  w.step();
  expect(w.settlers.filter((s) => s.kind === 'builder').length).toBe(builders);
  const b = readySite(w);
  let start = -1;
  for (let i = 0; i < 5000 && !b.done; i++) {
    w.step();
    if (start < 0 && b.progress > 0) start = w.tick;
  }
  expect(b.done).toBe(true);
  return w.tick - start;
}

describe('construction', () => {
  it('every building type takes at least one builder, huts three as in Settlers 4', () => {
    for (const type of Object.keys(BUILDINGS) as BuildingType[]) expect(buildersOf(type)).toBeGreaterThanOrEqual(1);
    expect(buildersOf('woodcutter')).toBe(3);
    expect(buildersOf('house_large')).toBe(5);
  });

  it('one builder needs a work shift per material unit; three on one site share the work', () => {
    const one = buildTicks(1);
    const shifts = totalCost('woodcutter') * BUILD_TICKS_PER_UNIT;
    expect(one).toBeGreaterThanOrEqual(shifts - 1);
    expect(one).toBeLessThan(shifts + 10);
    const three = buildTicks(3);
    // They arrive one after another, so a little more than a third.
    expect(three).toBeLessThan(one * 0.55);
  });
});

describe('walking', () => {
  /** Ticks for a settler of `kind` to walk a fixed route from the castle door, on worn road or not. */
  function walkTicks(kind: SettlerKind, road: boolean): { ticks: number; tiles: number } {
    const w = new World(42);
    const c = w.castle;
    const s = spawnSettler(w, kind, c);
    const goal = { x: c.door.x - 6, y: c.door.y + 6 };
    const path = findPath(w.map, c.door.x, c.door.y, goal.x, goal.y)!;
    expect(path).not.toBeNull();
    let tiles = 0;
    let prev = { x: c.door.x, y: c.door.y };
    for (const p of path) {
      tiles += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
      if (road) w.map.wear[w.map.idx(p.x, p.y)] = 255;
    }
    s.tasks = [{ t: 'goto', x: goal.x, y: goal.y }];
    let ticks = 0;
    while ((s.x !== goal.x || s.y !== goal.y) && ticks < 1000) {
      w.step();
      ticks++;
    }
    return { ticks, tiles };
  }

  it('settlers walk Settlers 4 pace on grass; only carriers go faster on a road', () => {
    const grass = walkTicks('carrier', false);
    expect(grass.ticks).toBeGreaterThanOrEqual(Math.floor(grass.tiles / SETTLER_SPEED));
    expect(grass.ticks).toBeLessThanOrEqual(Math.ceil(grass.tiles / SETTLER_SPEED) + 2);
    const road = walkTicks('carrier', true);
    const roadSpeed = PATHS.levels[PATHS.levels.length - 1].speed;
    expect(road.ticks).toBeLessThanOrEqual(Math.ceil(grass.ticks / roadSpeed) + 2);
    // A builder (not a carrier) gets nothing from the road, as in Settlers 4.
    expect(walkTicks('builder', true).ticks).toBe(grass.ticks);
  });
});
