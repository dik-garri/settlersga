import { describe, expect, it } from 'vitest';
import { animalCap, habitable } from '../src/sim/animals';
import { ANIMAL_KINDS, ANIMAL_SPAWN, ANIMAL_START_CLEARANCE, ANIMALS, TREE_MATURE } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { base } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

describe('wild animals', () => {
  it('every kind is spawned, away from the starts and off anyone\'s land, on habitable tiles', () => {
    for (const seed of [42, 7, 123]) {
      const w = new World(seed, { players: 2 });
      const kinds = new Set(w.animals.map((a) => a.kind));
      for (const k of ANIMAL_KINDS) expect(kinds.has(k)).toBe(true);
      for (const a of w.animals) {
        expect(habitable(w.map, ANIMALS[a.kind], a.x, a.y)).toBe(true);
        for (const c of w.players.map((p) => base(w, p.id))) {
          // Herd homes keep the clearance; members start at most 2 tiles from home.
          expect(Math.hypot(a.hx - c.x - 1, a.hy - c.y - 1)).toBeGreaterThanOrEqual(ANIMAL_START_CLEARANCE - 2);
        }
      }
    }
  });

  it('scale with the map area', () => {
    const small = new World(42, { size: 64 }).animals.length;
    const big = new World(42, { size: 128 }).animals.length;
    expect(big).toBeGreaterThan(small * 2.5);
  });

  it('wander, and stay on tiles their habitat allows', () => {
    const w = new World(42);
    const start = w.animals.map((a) => [a.x, a.y]);
    let bad = 0;
    for (let t = 0; t < 3000; t++) {
      w.step();
      if (t % 10 !== 0) continue;
      for (const a of w.animals) {
        const x = Math.round(a.x);
        const y = Math.round(a.y);
        // A sapling may sprout where an animal stands; it then walks out (see animals.ts).
        if (w.map.tree[w.map.idx(x, y)] > 0) continue;
        if (!habitable(w.map, ANIMALS[a.kind], x, y)) bad++;
      }
    }
    expect(bad).toBe(0);
    // Those of the map's start (newborn game is appended, `ANIMAL_SPAWN`).
    const first = w.animals.slice(0, start.length);
    const moved = first.filter((a, i) => Math.hypot(a.x - start[i][0], a.y - start[i][1]) > 0.5).length;
    expect(moved).toBeGreaterThan(first.length / 2);
    for (const a of w.animals) expect(Math.hypot(a.x - a.hx, a.y - a.hy)).toBeLessThanOrEqual(ANIMALS[a.kind].roam * 1.5 + 2);
  });

  it('are deterministic and do not change the economy', () => {
    const a = new World(7);
    const b = new World(7);
    run(a, 2000);
    run(b, 2000);
    expect(a.animals).toEqual(b.animals);
    // Animals draw from their own random stream: a world without them plays out exactly the same.
    const c = new World(7);
    c.animals.length = 0;
    run(c, 2000);
    expect(c.rng.state).toBe(a.rng.state);
    expect(saveWorld(c).settlers).toEqual(saveWorld(a).settlers);
  });

  it('survive save and load and continue identically', () => {
    const w = new World(42, { players: 2, ai: [2] });
    run(w, 1500);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1500);
    run(l, 1500);
    expect(saveWorld(l)).toEqual(saveWorld(w));
    expect(l.animals.length).toBeGreaterThan(0);
  });

  it('game is born as in Settlers 4: in wooded squares without animals, up to LAND_POP per 100 squares of land', () => {
    expect(ANIMAL_SPAWN.square).toBe(5);
    const w = new World(42);
    const cap = animalCap(w.map);
    // 12 × 12 squares of mostly land: 8 × land % × 144 / 10000.
    expect(cap).toBeGreaterThanOrEqual(8);
    expect(cap).toBeLessThanOrEqual(11);
    const big = new World(42, { size: 128 });
    expect(animalCap(big.map)).toBeGreaterThan(cap * 3.5);
    // Hunt every deer: the manager breeds new ones up to the cap, never more.
    const deer = () => w.animals.filter((a) => a.kind === 'deer');
    for (const a of deer()) w.animals.splice(w.animals.indexOf(a), 1);
    const S = ANIMAL_SPAWN.square;
    for (let t = 0; t < 3000; t++) {
      const before = new Set(w.animals.map((a) => a.id));
      w.step();
      for (const a of w.animals) {
        if (before.has(a.id)) continue;
        // A newborn: by a mature tree, alone in its square when born.
        const near = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => w.map.tree[w.map.idx(a.x + dx, a.y + dy)] === TREE_MATURE));
        expect(near).toBe(true);
        const qx = Math.floor(a.x / S);
        const qy = Math.floor(a.y / S);
        const others = w.animals.filter((o) => o !== a && before.has(o.id) && Math.floor(o.x / S) === qx && Math.floor(o.y / S) === qy);
        expect(others.length).toBe(0);
      }
      expect(deer().length).toBeLessThanOrEqual(cap);
    }
    expect(deer().length).toBe(cap);
  });
});
