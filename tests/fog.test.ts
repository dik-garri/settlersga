import { describe, expect, it } from 'vitest';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function explored(w: World, player: number): number {
  let n = 0;
  for (let y = 0; y < w.map.h; y++) for (let x = 0; x < w.map.w; x++) if (w.isExplored(x, y, player)) n++;
  return n;
}

describe('fog of war', () => {
  it('starts with only the surroundings of the own castle explored, per player', () => {
    const w = new World(42, { players: 2 });
    w.step();
    const own = explored(w, 1);
    expect(own).toBeGreaterThan(300);
    expect(own).toBeLessThan(w.map.w * w.map.h / 2);
    const c1 = w.castleOf(1);
    const c2 = w.castleOf(2);
    expect(w.isExplored(c1.x, c1.y, 1)).toBe(true);
    expect(w.isVisible(c1.x, c1.y, 1)).toBe(true);
    expect(w.isExplored(c2.x, c2.y, 1)).toBe(false);
    expect(w.isExplored(c1.x, c1.y, 2)).toBe(false);
  });

  it('a walking settler explores; the tiles stay explored but leave sight once he is gone', () => {
    const w = new World(42);
    w.step();
    const before = explored(w, 1);
    const s = w.settlers.find((x) => x.kind === 'carrier')!;
    // Somewhere walkable well outside the castle's sight.
    let target: { x: number; y: number } | null = null;
    for (let r = 20; r < 30 && !target; r++) {
      for (let a = 0; a < 16 && !target; a++) {
        const x = Math.round(w.castle.x + Math.cos(a) * r);
        const y = Math.round(w.castle.y + Math.sin(a) * r);
        if (w.map.isWalkable(x, y) && !w.isExplored(x, y)) target = { x, y };
      }
    }
    expect(target).not.toBeNull();
    s.tasks = [{ t: 'goto', x: target!.x, y: target!.y }];
    run(w, 400);
    expect(explored(w, 1)).toBeGreaterThan(before);
    expect(w.isExplored(target!.x, target!.y)).toBe(true);
    // Walk back home: the far tile is remembered but no longer watched.
    s.tasks = [{ t: 'goto', x: w.castle.door.x, y: w.castle.door.y }];
    run(w, 400);
    expect(w.isExplored(target!.x, target!.y)).toBe(true);
    expect(w.isVisible(target!.x, target!.y)).toBe(false);
  });

  it('buildings extend sight where they stand', () => {
    const w = new World(42);
    w.castle.output.plank = 40;
    w.castle.output.stone = 20;
    const c = w.castle;
    const hut = placeNear(w, 'woodcutter', c.x + 9, c.y + 2)!;
    w.step();
    expect(w.isVisible(hut.x + 4, hut.y + 4)).toBe(true);
    w.demolish(hut.id);
    w.step();
    // Still explored, and visible only if something else watches it.
    expect(w.isExplored(hut.x + 4, hut.y + 4)).toBe(true);
  });

  it('explored state survives save and load and continues identically', () => {
    const w = new World(7, { players: 2, ai: [2] });
    run(w, 1500);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1000);
    run(l, 1000);
    expect(saveWorld(l)).toEqual(saveWorld(w));
    expect(explored(l, 1)).toBe(explored(w, 1));
  });
});
