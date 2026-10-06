import { describe, expect, it } from 'vitest';
import { CROP_KINDS, CROP_RIPE, oreOf, SEASON_TICKS, SEASONS } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { seasonAt } from '../src/sim/seasons';
import { World } from '../src/sim/world';

const WINTER = SEASONS.findIndex((s) => s.key === 'winter');
const SUMMER = SEASONS.findIndex((s) => s.key === 'summer');

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/** Sows `count` fields of `kind` at stage 1 on free plantable tiles near the castle. */
function sow(world: World, kind: (typeof CROP_KINDS)[number], count: number): number[] {
  const m = world.map;
  const c = world.castle;
  const tiles: number[] = [];
  for (let r = 3; r < 20 && tiles.length < count; r++) {
    for (let y = c.y - r; y <= c.y + r && tiles.length < count; y++) {
      for (let x = c.x - r; x <= c.x + r && tiles.length < count; x++) {
        if (Math.max(Math.abs(x - c.x), Math.abs(y - c.y)) !== r || !m.isPlantable(x, y)) continue;
        const i = m.idx(x, y);
        m.crop[i] = 1;
        m.cropKind[i] = CROP_KINDS.indexOf(kind);
        m.touch(i);
        world.fields.add(i);
        tiles.push(i);
      }
    }
  }
  expect(tiles.length).toBe(count);
  return tiles;
}

const stages = (world: World, tiles: number[]) => tiles.map((i) => world.map.crop[i]);

describe('seasons', () => {
  it('cycle through the year by tick alone', () => {
    expect(seasonAt(0)).toMatchObject({ index: 0, progress: 0, year: 0 });
    expect(seasonAt(SEASON_TICKS - 1).index).toBe(0);
    expect(seasonAt(SEASON_TICKS).index).toBe(1);
    expect(seasonAt(SEASON_TICKS * 2.5)).toMatchObject({ index: 2, progress: 0.5, year: 0 });
    expect(seasonAt(SEASON_TICKS * SEASONS.length)).toMatchObject({ index: 0, year: 1 });
    expect(seasonAt(SEASON_TICKS * WINTER).def.key).toBe('winter');
    const w = new World(1);
    w.tick = SEASON_TICKS * (SEASONS.length + SUMMER) + 5;
    expect(w.season().def.key).toBe('summer');
    expect(w.season().year).toBe(1);
  });

  it('crops do not grow in winter and grow again in spring', () => {
    const w = new World(42);
    const fields = sow(w, 'grain', 30);
    w.tick = SEASON_TICKS * WINTER;
    run(w, SEASON_TICKS - 1);
    expect(w.season().def.key).toBe('winter');
    expect(stages(w, fields).every((s) => s === 1)).toBe(true);
    run(w, SEASON_TICKS / 2); // into spring
    expect(stages(w, fields).some((s) => s > 1)).toBe(true);
  });

  it('vines bear fruit only in fruiting seasons', () => {
    const w = new World(42);
    const vines = sow(w, 'vine', 20);
    run(w, SEASON_TICKS - 1); // a whole spring
    expect(Math.max(...stages(w, vines))).toBe(CROP_RIPE - 1);
    run(w, SEASON_TICKS); // summer
    expect(Math.max(...stages(w, vines))).toBe(CROP_RIPE);
  });

  it('are deterministic and survive a save made mid-winter', () => {
    const make = () => {
      const w = new World(7);
      sow(w, 'grain', 10);
      w.tick = SEASON_TICKS * WINTER;
      run(w, SEASON_TICKS / 2);
      return w;
    };
    const a = make();
    expect(saveWorld(make())).toEqual(saveWorld(a));
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    expect(b.season().def.key).toBe('winter');
    run(a, SEASON_TICKS);
    run(b, SEASON_TICKS);
    expect(saveWorld(b)).toEqual(saveWorld(a));
  });
});

describe('big maps', () => {
  it('generate 512×512 with four usable starts in reasonable time', () => {
    const t0 = performance.now();
    const w = new World(42, { size: 512, players: 4 });
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(5000);
    expect(w.map.w).toBe(512);
    const m = w.map;
    for (const p of [1, 2, 3, 4]) {
      const c = w.castleOf(p)!;
      expect(c.owner).toBe(p);
      // Start area: trees, coal and iron ore within reach of the castle.
      let trees = 0;
      const ores = new Set<string>();
      for (let y = c.y - 14; y <= c.y + 14; y++) {
        for (let x = c.x - 14; x <= c.x + 14; x++) {
          const i = m.idx(x, y);
          if (m.tree[i]) trees++;
          const ore = oreOf(m.ore[i]);
          if (ore && m.oreAmount[i] > 0) ores.add(ore);
        }
      }
      expect(trees).toBeGreaterThan(10);
      expect(ores.has('coal') && ores.has('ironore')).toBe(true);
    }
    // Every player can place a woodcutter and a coal and iron mine on their own land.
    for (const p of [1, 2, 3, 4]) {
      for (const type of ['woodcutter', 'coalmine', 'ironmine'] as const) {
        let ok = false;
        for (let i = 0; i < m.w * m.h && !ok; i++) ok = m.owner[i] === p && w.canPlace(type, i % m.w, Math.floor(i / m.w), p);
        expect(ok, `player ${p} ${type}`).toBe(true);
      }
    }
    run(w, 100);
  });
});
