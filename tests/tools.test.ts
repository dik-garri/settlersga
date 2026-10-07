import { describe, expect, it } from 'vitest';
import { PROFESSIONS } from '../src/sim/config';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function richWorld(seed = 42): World {
  const w = new World(seed);
  w.castle.output.plank = 80;
  w.castle.output.stone = 40;
  return w;
}

describe('smelting', () => {
  it('turns ore and coal into metal bars', () => {
    const w = richWorld();
    const c = w.castle;
    const smelter = placeNear(w, 'ironsmelter', c.x + 5, c.y + 3)!;
    const gold = placeNear(w, 'goldsmelter', c.x - 5, c.y + 3)!;
    run(w, 1500);
    expect(smelter.done && gold.done).toBe(true);
    c.output.ironore = 3;
    c.output.goldore = 2;
    c.output.coal = 5;
    run(w, 2500);
    expect(w.stats.produced.iron).toBe(3);
    expect(w.stats.produced.gold).toBe(2);
  });
});

describe('tools', () => {
  it('a workplace stays empty without its tool and is staffed once one is available', () => {
    expect(PROFESSIONS.woodcutter.tool).toBe('axe');
    const w = richWorld();
    const c = w.castle;
    c.output.axe = 0;
    const hut = placeNear(w, 'woodcutter', c.x + 5, c.y - 1)!;
    run(w, 1500);
    expect(hut.done).toBe(true);
    expect(hut.workerId).toBeNull();

    c.output.axe = 1;
    run(w, 600);
    expect(w.getSettler(hut.workerId)?.kind).toBe('woodcutter');
    expect(c.output.axe).toBe(0); // the axe went with him
  });

  it('the toolsmith forges the tool that workplaces are waiting for', () => {
    const w = richWorld();
    const c = w.castle;
    c.output.saw = 0;
    const smith = placeNear(w, 'toolsmith', c.x - 5, c.y - 1)!;
    const mill = placeNear(w, 'sawmill', c.x + 5, c.y - 1)!;
    run(w, 1500);
    expect(smith.done && mill.done).toBe(true);
    expect(mill.workerId).toBeNull();
    c.output.iron = 2;
    c.output.coal = 2;
    run(w, 1500);
    expect(w.stats.produced.saw).toBeGreaterThanOrEqual(1);
    expect(w.getSettler(mill.workerId)?.kind).toBe('sawmiller');
  });

  it('carriers with hammers become builders when sites outnumber builders', () => {
    const w = richWorld();
    const c = w.castle;
    const builders = () => w.settlers.filter((s) => s.kind === 'builder').length;
    expect(builders()).toBe(3);
    c.output.hammer = 2;
    for (const [dx, dy] of [
      [5, -1],
      [-5, -1],
      [5, 4],
      [-5, 4],
      [1, 6],
    ]) {
      // Already cleared, so only the builder rule is under test (diggers clear sites first).
      placeNear(w, 'house_small', c.x + dx, c.y + dy)!.levelled = true;
    }
    run(w, 200);
    expect(builders()).toBe(5);
    expect(c.output.hammer).toBe(0);
  });
});
