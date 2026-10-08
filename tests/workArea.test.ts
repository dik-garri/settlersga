import { describe, expect, it } from 'vitest';
import { spawnSettler } from '../src/sim/buildings';
import { PROFESSIONS, WORK_AREA } from '../src/sim/config';
import { findGatherTarget, hasGatherTargetNear } from '../src/sim/nature';
import { saveWorld } from '../src/sim/save';
import { movableWorkArea, workCentre, workRadius } from '../src/sim/workArea';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function richWorld(seed = 42): World {
  const w = new World(seed);
  // Extra materials on the start tower's pile (a supply like any other).
  startTower(w).output.plank = 80;
  startTower(w).output.stone = 40;
  return w;
}

describe('work areas (Settlers 4)', () => {
  it('come from the data: gather, plant, hunt and mine radii', () => {
    expect(workRadius('woodcutter')).toBe(PROFESSIONS.woodcutter.gather!.radius);
    expect(workRadius('forester')).toBe(PROFESSIONS.forester.plant!.radius);
    expect(workRadius('hunter')).toBe(PROFESSIONS.hunter.hunt!.radius);
    expect(workRadius('coalmine')).toBeGreaterThan(0);
    expect(workRadius('sawmill')).toBeNull();
    expect(workRadius('warehouse')).toBeNull();
    expect(movableWorkArea('woodcutter')).toBe(true);
    expect(movableWorkArea('coalmine')).toBe(false);
  });

  it('can be moved by the owner within reach of the door, and back', () => {
    const w = richWorld();
    const hut = placeNear(w, 'woodcutter', base(w).x + 5, base(w).y - 1)!;
    const r = workRadius('woodcutter')!;
    expect(workCentre(hut)).toEqual(hut.door);
    expect(w.setWorkArea(hut.id, { x: hut.door.x + 4, y: hut.door.y }, 2)).toBe(false); // not the owner
    expect(w.setWorkArea(hut.id, { x: hut.door.x + Math.ceil(r * WORK_AREA.maxShift) + 2, y: hut.door.y })).toBe(false);
    expect(w.setWorkArea(hut.id, { x: hut.door.x + 4, y: hut.door.y })).toBe(true);
    expect(workCentre(hut)).toEqual({ x: hut.door.x + 4, y: hut.door.y });
    expect(w.setWorkArea(hut.id, null)).toBe(true);
    expect(workCentre(hut)).toEqual(hut.door);
    const tower = startTower(w);
    expect(w.setWorkArea(tower.id, { x: tower.door.x, y: tower.door.y })).toBe(false);
  });

  it('steer where a gatherer looks for work', () => {
    const w = richWorld();
    const hut = placeNear(w, 'woodcutter', base(w).x + 5, base(w).y - 1)!;
    const def = PROFESSIONS.woodcutter.gather!;
    const m = w.map;
    // A tree within reach of a moved centre.
    let tree: { x: number; y: number } | null = null;
    for (let y = 0; y < m.h && !tree; y++) {
      for (let x = 0; x < m.w && !tree; x++) {
        const d = Math.hypot(x - hut.door.x, y - hut.door.y);
        if (m.tree[m.idx(x, y)] && m.owner[m.idx(x, y)] === 1 && d > 3 && d <= def.radius * WORK_AREA.maxShift) tree = { x, y };
      }
    }
    expect(tree).not.toBeNull();
    expect(w.setWorkArea(hut.id, tree!)).toBe(true);
    expect(hasGatherTargetNear(w, hut, def)).toBe(true);
    const s = spawnSettler(w, 'woodcutter', hut);
    const t = findGatherTarget(w, s, hut, def);
    if (t) expect(Math.hypot(t.x - tree!.x, t.y - tree!.y)).toBeLessThanOrEqual(def.radius);
  });

  it('survive save and load', () => {
    const w = richWorld();
    const hut = placeNear(w, 'forester', base(w).x + 5, base(w).y + 3)!;
    expect(w.setWorkArea(hut.id, { x: hut.door.x + 3, y: hut.door.y + 2 })).toBe(true);
    for (let i = 0; i < 300; i++) w.step();
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(workCentre(l.buildings.get(hut.id)!)).toEqual(workCentre(hut));
    for (let i = 0; i < 1500; i++) {
      w.step();
      l.step();
    }
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});
