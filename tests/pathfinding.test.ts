import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { findPath } from '../src/sim/pathfinding';
import { Terrain } from '../src/sim/types';

function wall(map: GameMap, x: number, y0: number, y1: number) {
  for (let y = y0; y <= y1; y++) map.terrain[map.idx(x, y)] = Terrain.Rock;
}

describe('findPath', () => {
  it('walks a straight line on open ground', () => {
    const map = new GameMap(10, 10);
    const path = findPath(map, 0, 0, 4, 0)!;
    expect(path).toEqual([1, 2, 3, 4].map((x) => ({ x, y: 0 })));
  });

  it('goes around obstacles without cutting corners', () => {
    const map = new GameMap(10, 10);
    wall(map, 3, 0, 7);
    const path = findPath(map, 1, 1, 5, 1)!;
    expect(path.at(-1)).toEqual({ x: 5, y: 1 });
    expect(path.every((p) => map.isWalkable(p.x, p.y))).toBe(true);
    // Passing the wall requires going below its end at y = 7.
    expect(Math.max(...path.map((p) => p.y))).toBeGreaterThanOrEqual(8);
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      if (a.x !== b.x && a.y !== b.y) {
        expect(map.isWalkable(b.x, a.y) && map.isWalkable(a.x, b.y)).toBe(true);
      }
    }
  });

  it('returns null when the target is unreachable', () => {
    const map = new GameMap(10, 10);
    wall(map, 5, 0, 9);
    expect(findPath(map, 0, 0, 8, 8)).toBeNull();
  });

  it('stops next to a blocked target in adjacent mode', () => {
    const map = new GameMap(10, 10);
    map.tree[map.idx(6, 6)] = 4;
    const path = findPath(map, 0, 0, 6, 6, true)!;
    const end = path.at(-1)!;
    expect(Math.max(Math.abs(end.x - 6), Math.abs(end.y - 6))).toBe(1);
    expect(findPath(map, 0, 0, 6, 6)).toBeNull();
  });
});
