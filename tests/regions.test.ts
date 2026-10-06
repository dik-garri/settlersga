import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { findPath, staysConnected } from '../src/sim/pathfinding';
import { markWalkable, sameRegion } from '../src/sim/regions';
import { createRng, randInt } from '../src/sim/rng';
import { Terrain } from '../src/sim/types';

/** Brute force: is b reachable from a by A* without the region shortcut? */
function reachable(map: GameMap, a: number, b: number): boolean {
  const ax = a % map.w;
  const ay = Math.floor(a / map.w);
  const bx = b % map.w;
  const by = Math.floor(b / map.w);
  return findPath(map, ax, ay, bx, by, false, false) !== null;
}

describe('regions', () => {
  it('agree with real reachability while tiles are blocked and opened', () => {
    for (const seed of [1, 2, 3]) {
      const rng = createRng(seed);
      const map = new GameMap(24, 24);
      for (let i = 0; i < map.terrain.length; i++) {
        if (rng() < 0.3) map.terrain[i] = Terrain.Rock;
      }
      const n = map.w * map.h;
      for (let step = 0; step < 300; step++) {
        const i = randInt(rng, n);
        const x = i % map.w;
        const y = Math.floor(i / map.w);
        if (map.isWalkable(x, y)) {
          // Block only when it cannot cut a route, as the game does.
          if (staysConnected(map, x, y)) map.tree[i] = 1;
        } else if (map.tree[i] || rng() < 0.3) {
          map.tree[i] = 0;
          map.terrain[i] = Terrain.Grass;
          markWalkable(map, x, y);
        }
        if (step % 30 !== 0) continue;
        for (let k = 0; k < 40; k++) {
          const a = randInt(rng, n);
          const b = randInt(rng, n);
          if (!map.isWalkable(a % map.w, Math.floor(a / map.w))) continue;
          if (!map.isWalkable(b % map.w, Math.floor(b / map.w))) continue;
          expect(sameRegion(map, a, b), `seed ${seed} step ${step}`).toBe(reachable(map, a, b));
        }
      }
    }
  });
});
