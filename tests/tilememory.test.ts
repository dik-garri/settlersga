import { describe, expect, it } from 'vitest';
import { TileMemory } from '../src/render/tileMemory';
import { PATHS } from '../src/sim/config';
import { World } from '../src/sim/world';

/** A two-player world one tick old, player 1's tile memory made at tick 0 (a new game). */
function setup(): { w: World; m: TileMemory } {
  const w = new World(42, { players: 2 });
  const m = new TileMemory(w, 1, true);
  w.step();
  return { w, m };
}

/** A tile in player 2's land, out of player 1's sight, and its chunk. */
function shade(w: World): { i: number; c: number } {
  const h = w.homeOf(2);
  const x = h.x + 3;
  const y = h.y + 2;
  const i = w.map.idx(x, y);
  expect(w.isVisible(x, y, 1)).toBe(false);
  return { i, c: w.map.chunkOf(x, y) };
}

/** Puts tile i in or out of player 1's sight (as a passing settler would), explored either way. */
function sight(w: World, i: number, on: boolean): void {
  w.fog.seenUntil[0][i] = on ? 0xffffffff : 0;
  w.map.explored[i] |= 1;
}

describe('memory of tiles under the fog (render side)', () => {
  it('starts as a copy of the map', () => {
    const { w, m } = setup();
    for (const layer of ['owner', 'tree', 'stone', 'crop', 'goods', 'goodsAmount', 'wear'] as const) {
      expect(m[layer]).not.toBe(w.map[layer]);
    }
    // One tick of play changes nothing the player has not seen, and nothing it has not been told of.
    m.update(0, true);
    const { i } = shade(w);
    expect(m.owner[i]).toBe(w.map.owner[i]);
    expect(m.owner[i]).toBe(2);
  });

  it('a change out of sight is not seen; once in sight it is taken in silently', () => {
    const { w, m } = setup();
    m.update(0, true);
    const { i, c } = shade(w);
    const before = m.chunkVersion[c];
    // A forester plants there in the dark, and stone and goods appear.
    w.map.tree[i] = 3;
    w.map.goods[i] = 1;
    w.map.goodsAmount[i] = 5;
    w.map.touch(i);
    m.update(100, true);
    expect(m.tree[i]).toBe(0);
    expect(m.goods[i]).toBe(0);
    expect(m.chunkVersion[c]).toBe(before);
    expect(m.staleCount).toBe(1);
    // Still out of sight a while later: nothing.
    m.update(400, true);
    expect(m.tree[i]).toBe(0);
    // The player looks: as it is now, and learnt only now (no felling or growing shown).
    sight(w, i, true);
    m.update(600, true);
    expect(m.tree[i]).toBe(3);
    expect(m.goods[i]).toBe(1);
    expect(m.goodsAmount[i]).toBe(5);
    expect(m.chunkVersion[c]).toBe(before + 1);
    expect(m.silent(i)).toBe(true);
    expect(m.staleCount).toBe(0);
  });

  it('a change in sight is taken in at once (no throttle) and not silently; no change, no bump', () => {
    const { w, m } = setup();
    m.update(0, true);
    const { i, c } = shade(w);
    sight(w, i, true);
    m.update(10);
    const before = m.chunkVersion[c];
    // Touched without a change: nothing to redraw.
    w.map.touch(i);
    m.update(20);
    expect(m.chunkVersion[c]).toBe(before);
    w.map.crop[i] = 2;
    w.map.cropKind[i] = 0;
    w.map.touch(i);
    m.update(30);
    expect(m.crop[i]).toBe(2);
    expect(m.chunkVersion[c]).toBe(before + 1);
    expect(m.silent(i)).toBe(false);
    // A felled tree in sight is seen falling.
    w.map.tree[i] = 4;
    w.map.touch(i);
    m.update(40);
    w.map.tree[i] = 0;
    w.map.touch(i);
    m.update(50);
    expect(m.tree[i]).toBe(0);
    expect(m.silent(i)).toBe(false);
  });

  it('stone deposits and path levels: only what is drawn counts', () => {
    const { w, m } = setup();
    m.update(0, true);
    const { i, c } = shade(w);
    sight(w, i, true);
    const before = m.chunkVersion[c];
    // Wear that stays below the first path level changes nothing drawn.
    w.map.wear[i] = PATHS.levels[0].wear - 1;
    w.map.touch(i);
    m.update(10);
    expect(m.chunkVersion[c]).toBe(before);
    w.map.wear[i] = PATHS.levels[0].wear;
    w.map.stone[i] = 7;
    w.map.touch(i);
    m.update(20);
    expect(m.wear[i]).toBe(PATHS.levels[0].wear);
    expect(m.stone[i]).toBe(7);
    expect(m.chunkVersion[c]).toBe(before + 1);
    // Quarried out of sight: the deposit stays as seen.
    sight(w, i, false);
    w.map.stone[i] = 2;
    w.map.touch(i);
    m.update(30, true);
    expect(m.stone[i]).toBe(7);
  });

  it('land changing hands out of sight does not move the border; seen, it does', () => {
    const { w, m } = setup();
    m.update(0, true);
    const { i, c } = shade(w);
    const owners = m.ownerVersion;
    const things = m.chunkVersion[c];
    // A new tower of a third party takes the tile in the dark (land changes no chunk version).
    w.map.owner[i] = 3;
    w.territoryVersion++;
    m.update(100, true);
    expect(m.owner[i]).toBe(2);
    expect(m.ownerVersion).toBe(owners);
    sight(w, i, true);
    m.update(300, true);
    expect(m.owner[i]).toBe(3);
    expect(m.ownerVersion).toBe(owners + 1);
    // Land alone redraws the territory, not the tile objects.
    expect(m.chunkVersion[c]).toBe(things);
  });

  it('stale tiles are re-checked against the sight at most every 150 ms', () => {
    const { w, m } = setup();
    m.update(1000, true);
    const { i } = shade(w);
    w.map.tree[i] = 2;
    w.map.touch(i);
    m.update(1010);
    sight(w, i, true);
    m.update(1050);
    expect(m.tree[i]).toBe(0);
    m.update(1200);
    expect(m.tree[i]).toBe(2);
  });

  it('a change that is undone out of sight leaves nothing stale', () => {
    const { w, m } = setup();
    m.update(0, true);
    const { i } = shade(w);
    w.map.goods[i] = 2;
    w.map.goodsAmount[i] = 1;
    w.map.touch(i);
    m.update(10, true);
    expect(m.staleCount).toBe(1);
    w.map.goods[i] = 0;
    w.map.goodsAmount[i] = 0;
    w.map.touch(i);
    m.update(200, true);
    expect(m.staleCount).toBe(0);
  });

  it('with the fog off the view is the map itself', () => {
    const w = new World(42, { players: 2 });
    const m = new TileMemory(w, 1, false);
    w.step();
    expect(m.tree).toBe(w.map.tree);
    expect(m.owner).toBe(w.map.owner);
    expect(m.chunkVersion).toBe(w.map.chunkVersion);
    const { i } = shade(w);
    w.map.tree[i] = 1;
    w.territoryVersion++;
    m.update(0, true);
    expect(m.tree[i]).toBe(1);
    expect(m.ownerVersion).toBe(w.territoryVersion);
    expect(m.silent(i)).toBe(false);
  });

  it('a long game: what the player sees matches the map, what he does not may differ', () => {
    const w = new World(7, { players: 2, ai: [2] });
    const m = new TileMemory(w, 1, true);
    for (let t = 0; t < 6000; t++) {
      w.step();
      if (t % 5 === 0) m.update(t * 100);
    }
    m.update(1e9, true);
    let differ = 0;
    for (let i = 0; i < w.map.owner.length; i++) {
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      const same = m.owner[i] === w.map.owner[i] && m.tree[i] === w.map.tree[i] && m.crop[i] === w.map.crop[i] && m.goods[i] === w.map.goods[i] && m.goodsAmount[i] === w.map.goodsAmount[i] && m.stone[i] === w.map.stone[i];
      if (w.isVisible(x, y, 1)) expect(same).toBe(true);
      else if (!same) differ++;
    }
    // The computer player's economy grows in the dark.
    expect(differ).toBeGreaterThan(0);
  });
});
