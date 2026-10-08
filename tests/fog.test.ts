import { describe, expect, it } from 'vitest';
import { spawnSettler } from '../src/sim/buildings';
import { FOG, PROFESSIONS } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

function explored(w: World, player: number): number {
  let n = 0;
  for (let y = 0; y < w.map.h; y++) for (let x = 0; x < w.map.w; x++) if (w.isExplored(x, y, player)) n++;
  return n;
}

describe('fog of war', () => {
  it('starts with only the surroundings of the own start tower explored, per player', () => {
    const w = new World(42, { players: 2 });
    w.step();
    const own = explored(w, 1);
    expect(own).toBeGreaterThan(300);
    expect(own).toBeLessThan(w.map.w * w.map.h / 2);
    const c1 = startTower(w, 1);
    const c2 = startTower(w, 2);
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
    // Somewhere walkable well outside the start tower's sight.
    let target: { x: number; y: number } | null = null;
    for (let r = 20; r < 30 && !target; r++) {
      for (let a = 0; a < 16 && !target; a++) {
        const x = Math.round(base(w).x + Math.cos(a) * r);
        const y = Math.round(base(w).y + Math.sin(a) * r);
        if (w.map.isWalkable(x, y) && !w.isExplored(x, y)) target = { x, y };
      }
    }
    expect(target).not.toBeNull();
    s.tasks = [{ t: 'goto', x: target!.x, y: target!.y }];
    run(w, 600);
    expect(explored(w, 1)).toBeGreaterThan(before);
    expect(w.isExplored(target!.x, target!.y)).toBe(true);
    // Walk back home: the far tile is remembered but no longer watched.
    s.tasks = [{ t: 'goto', x: w.homeOf(1).x, y: w.homeOf(1).y }];
    run(w, 400);
    expect(w.isExplored(target!.x, target!.y)).toBe(true);
    expect(w.isVisible(target!.x, target!.y)).toBe(false);
  });

  it('buildings extend sight where they stand', () => {
    const w = new World(42);
    const c = base(w);
    const hut = placeNear(w, 'woodcutter', c.x + 9, c.y + 2)!;
    w.step();
    expect(w.isVisible(hut.x + 4, hut.y + 4)).toBe(true);
    w.demolish(hut.id);
    w.step();
    // Still explored, and visible only if something else watches it.
    expect(w.isExplored(hut.x + 4, hut.y + 4)).toBe(true);
  });

  it('settlers see `FOG.settlerRadius`, a thief further (`ProfessionDef.sight`)', () => {
    const w = new World(42);
    w.step();
    const c = startTower(w);
    const out = (kind: 'carrier' | 'thief', dx: number) => {
      const s = spawnSettler(w, kind, c);
      s.inside = null;
      s.x = s.px = c.x + dx;
      s.y = s.py = c.y;
      return s;
    };
    const carrier = out('carrier', -22);
    const thief = out('thief', 22);
    const r = PROFESSIONS.thief.sight!;
    expect(r).toBeGreaterThan(FOG.settlerRadius);
    const tile = (s: { x: number; y: number }, d: number) => [Math.round(s.x), Math.round(s.y) + d] as const;
    expect(w.isExplored(...tile(thief, r))).toBe(false);
    run(w, FOG.settlerEvery);
    expect(w.isExplored(...tile(carrier, FOG.settlerRadius))).toBe(true);
    expect(w.isExplored(...tile(carrier, FOG.settlerRadius + 1))).toBe(false);
    expect(w.isExplored(...tile(thief, r))).toBe(true);
    expect(w.isExplored(...tile(thief, r + 1))).toBe(false);
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
