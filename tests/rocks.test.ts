import { describe, expect, it } from 'vitest';
import { CHUNK, GameMap } from '../src/sim/map';
import { Terrain } from '../src/sim/types';
import { ROCK_CELL, rockKey, rockLayout } from '../src/render/rocks';

const VARIANTS = { small: 4, medium: 3, large: 4 };

function mountainMap(): GameMap {
  const m = new GameMap(CHUNK * 2, CHUNK * 2);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) m.terrain[m.idx(x, y)] = x < CHUNK ? Terrain.Rock : Terrain.Mountain;
  return m;
}

describe('mountain rocks', () => {
  it('chunks lay out on cell boundaries', () => {
    expect(CHUNK % ROCK_CELL).toBe(0);
  });

  it('puts outcrops on peaks and only small stones on slopes, the same every time', () => {
    const m = mountainMap();
    const peak = rockLayout(m, 0, 0, CHUNK, CHUNK, VARIANTS);
    const slope = rockLayout(m, CHUNK, 0, CHUNK * 2, CHUNK, VARIANTS);
    expect(peak.filter((r) => r.size === 'large').length).toBeGreaterThan(5);
    expect(peak.some((r) => r.size === 'medium')).toBe(true);
    expect(slope.length).toBeGreaterThan(0);
    expect(slope.every((r) => r.size === 'small')).toBe(true);
    // Few enough that a slope stays a slope.
    expect(slope.length).toBeLessThan(CHUNK * CHUNK * 0.3);
    expect(rockKey(rockLayout(m, 0, 0, CHUNK, CHUNK, VARIANTS))).toBe(rockKey(peak));
    for (const r of [...peak, ...slope]) {
      expect(r.variant).toBeLessThan(VARIANTS[r.size]);
      expect(r.scale).toBeGreaterThan(0.7);
    }
  });

  it('outcrops cover four rock tiles nothing else takes', () => {
    const m = mountainMap();
    const spots = rockLayout(m, 0, 0, CHUNK, CHUNK, VARIANTS);
    const covered = new Set<number>();
    for (const r of spots.filter((s) => s.size === 'large')) {
      const ax = r.x + 0.5;
      const ay = r.y + 0.5;
      for (const [x, y] of [[ax, ay], [ax - 1, ay], [ax, ay - 1], [ax - 1, ay - 1]]) {
        const i = m.idx(x, y);
        expect(covered.has(i)).toBe(false);
        expect(m.terrain[i]).toBe(Terrain.Rock);
        covered.add(i);
      }
    }
    for (const r of spots.filter((s) => s.size !== 'large')) expect(covered.has(r.tile)).toBe(false);
  });

  it('keeps off tiles with buildings, doors, trees, deposits and goods', () => {
    const m = mountainMap();
    const before = rockLayout(m, CHUNK, 0, CHUNK * 2, CHUNK, VARIANTS);
    const [a, b, c, d, e] = before.map((r) => r.tile);
    m.building[a] = 1;
    m.door[b] = 1;
    m.tree[c] = 1;
    m.stone[d] = 5;
    m.goods[e] = 1;
    const after = rockLayout(m, CHUNK, 0, CHUNK * 2, CHUNK, VARIANTS);
    expect(after.length).toBe(before.length - 5);
    expect(after.some((r) => [a, b, c, d, e].includes(r.tile))).toBe(false);
    expect(rockKey(after)).not.toBe(rockKey(before));
    // An outcrop gives way to anything on any of its tiles.
    const peak = rockLayout(m, 0, 0, CHUNK, CHUNK, VARIANTS);
    const big = peak.find((r) => r.size === 'large')!;
    m.building[m.idx(big.x - 0.5, big.y - 0.5)] = 1;
    expect(rockLayout(m, 0, 0, CHUNK, CHUNK, VARIANTS).some((r) => r.size === 'large' && r.tile === big.tile)).toBe(false);
  });

  it('nothing on grass', () => {
    const m = new GameMap(CHUNK, CHUNK);
    for (let i = 0; i < m.terrain.length; i++) m.terrain[i] = Terrain.Grass;
    expect(rockLayout(m, 0, 0, CHUNK, CHUNK, VARIANTS)).toEqual([]);
  });
});
