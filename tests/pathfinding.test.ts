import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { findPath, staysConnected } from '../src/sim/pathfinding';
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

describe('staysConnected', () => {
  it('allows blocking a tile in open ground', () => {
    const map = new GameMap(12, 12);
    expect(staysConnected(map, 5, 5)).toBe(true);
  });

  it('refuses to close the only gap in a wall', () => {
    const map = new GameMap(12, 12);
    wall(map, 5, 0, 11);
    map.terrain[map.idx(5, 6)] = Terrain.Grass; // the gap
    expect(staysConnected(map, 5, 6)).toBe(false);
    expect(staysConnected(map, 2, 2)).toBe(true);
  });

  it('never approves a tile whose blocking disconnects two points', () => {
    const map = new GameMap(14, 14);
    wall(map, 6, 0, 13);
    map.terrain[map.idx(6, 3)] = Terrain.Grass;
    map.terrain[map.idx(6, 10)] = Terrain.Grass;
    // Scattered rocks, including diagonal pairs that rely on no-corner-cutting.
    for (const [x, y] of [[2, 2], [3, 3], [9, 4], [10, 5], [8, 9], [3, 9], [4, 11], [11, 11]]) {
      map.terrain[map.idx(x, y)] = Terrain.Rock;
    }
    const probes = [
      [0, 0],
      [13, 13],
      [0, 13],
      [13, 0],
    ];
    expect(probes.every(([x, y]) => findPath(map, 0, 0, x, y) !== null)).toBe(true);
    let approved = 0;
    for (let y = 0; y < 14; y++) {
      for (let x = 0; x < 14; x++) {
        if (probes.some(([px, py]) => px === x && py === y)) continue;
        if (!map.isWalkable(x, y) || !staysConnected(map, x, y)) continue;
        approved++;
        map.tree[map.idx(x, y)] = 1;
        for (const [px, py] of probes) {
          expect(findPath(map, 0, 0, px, py), `blocking ${x},${y}`).not.toBeNull();
        }
        map.tree[map.idx(x, y)] = 0;
      }
    }
    expect(approved).toBeGreaterThan(100);
  });
});
