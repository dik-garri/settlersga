import { describe, expect, it } from 'vitest';
import { addBuilding } from '../src/sim/buildings';
import { recomputeTerritory } from '../src/sim/territory';
import { saveWorld } from '../src/sim/save';
import { canProspect, claimable, SPECIALIST_ORDERS } from '../src/sim/specialists';
import { Terrain, type Building, type Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { base, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const owned = (w: World, p: number) => w.map.owner.reduce((n, o) => n + (o === p ? 1 : 0), 0);

/** The player's specialist of `kind`, recruited on order. */
function recruit(w: World, kind: 'pioneer' | 'thief', p = 1): Settler {
  w.orderSpecialist(kind, 1, p);
  for (let i = 0; i < 1500 && !w.settlers.some((s) => s.owner === p && s.kind === kind); i++) w.step();
  const s = w.settlers.find((o) => o.owner === p && o.kind === kind);
  expect(s).toBeDefined();
  run(w, 50);
  return s!;
}

/** A neutral tile next to the player's land, nearest the start. */
function borderTile(w: World, p = 1): { x: number; y: number } {
  const c = base(w, p);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < w.map.h; y++) {
    for (let x = 0; x < w.map.w; x++) {
      if (!claimable(w, x, y, p)) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best!;
}

/** An own walkable tile a few steps from the start tower's door where no specialist's action applies. */
function plainTile(w: World): { x: number; y: number } {
  const c = startTower(w);
  const m = w.map;
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const d = Math.hypot(x - c.door.x, y - c.door.y);
      if (d < 3 || d >= bestD || !m.isWalkable(x, y) || m.door[m.idx(x, y)] !== 0 || !w.owns(x, y)) continue;
      if (SPECIALIST_ORDERS.geologist!.can(w, x, y, undefined, 1) || SPECIALIST_ORDERS.pioneer!.can(w, x, y, undefined, 1)) continue;
      best = { x, y };
      bestD = d;
    }
  }
  if (!best) throw new Error('no plain tile');
  return best;
}

/** An own mountain tile with something left to prospect. */
function mountainTile(w: World): { x: number; y: number } {
  const c = base(w);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < w.map.h; y++) {
    for (let x = 0; x < w.map.w; x++) {
      if (!w.owns(x, y) || w.map.terrain[w.map.idx(x, y)] !== Terrain.Mountain || !canProspect(w, x, y, 1)) continue;
      const d = Math.hypot(x - c.x, y - c.y);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best!;
}

describe('specialists under direct control', () => {
  it('a specialist ordered to a spot with nothing to do walks there and waits', () => {
    const w = new World(42);
    const pioneer = recruit(w, 'pioneer');
    const t = plainTile(w);
    expect(w.orderSpecialists([pioneer.id], t.x, t.y)).toBe(1);
    expect(pioneer.errand).toBeNull();
    expect(pioneer.post).not.toBeNull();
    run(w, 600);
    expect(pioneer.kind).toBe('pioneer');
    expect(Math.hypot(pioneer.x - pioneer.post!.x, pioneer.y - pioneer.post!.y)).toBeLessThan(2);
    // Still there a while later: he waits instead of joining the crowd.
    run(w, 600);
    expect(Math.hypot(pioneer.x - pioneer.post!.x, pioneer.y - pioneer.post!.y)).toBeLessThan(2);
  });

  it('a right click on neutral land sends a pioneer to claim it', () => {
    const w = new World(42);
    const pioneer = recruit(w, 'pioneer');
    const before = owned(w, 1);
    const t = borderTile(w);
    expect(SPECIALIST_ORDERS.pioneer!.can(w, t.x, t.y, undefined, 1)).toBe(true);
    expect(w.orderSpecialists([pioneer.id], t.x, t.y)).toBe(1);
    expect(pioneer.errand).toMatchObject({ x: t.x, y: t.y });
    run(w, 3000);
    expect(owned(w, 1)).toBeGreaterThan(before + 3);
  });

  it('a right click on a mountain sends the selected geologist to prospect there', () => {
    const w = new World(42);
    const m = mountainTile(w);
    expect(w.sendGeologist(m.x, m.y)).toBe(true);
    // Sent elsewhere on the mountain mid-errand (he has fetched his hammer off the ground by now): his
    // queue becomes the new site's tiles.
    run(w, 200);
    const geo = w.settlers.find((s) => s.kind === 'geologist')!;
    const t = plainTile(w);
    expect(w.orderSpecialists([geo.id], t.x, t.y)).toBe(1);
    expect(geo.post).not.toBeNull();
    run(w, 400);
    expect(geo.kind).toBe('geologist'); // waits at the post instead of going back to carrying
    expect(w.orderSpecialists([geo.id], m.x, m.y)).toBe(1);
    expect(geo.post).toBeNull();
    expect(geo.errand).toMatchObject({ x: m.x, y: m.y });
    w.step();
    expect(geo.tasks.some((t) => t.t === 'prospect')).toBe(true);
    const before = w.stats.prospected;
    run(w, 2500);
    expect(w.stats.prospected).toBeGreaterThan(before);
  });

  it('a right click on an explored enemy warehouse sends the thief to rob it; elsewhere he just walks', () => {
    const w = new World(42, { players: 2 });
    const thief = recruit(w, 'thief');
    const other = base(w, 2);
    let store: Building | null = null;
    for (let r = 6; r < 14 && !store; r++) {
      for (let dx = -r; dx <= r && !store; dx++) {
        if (w.canPlace('warehouse', other.x + dx, other.y + r, 2)) store = addBuilding(w, 'warehouse', other.x + dx, other.y + r, 2, true);
      }
    }
    recomputeTerritory(w);
    store!.output.iron = 5;
    // Unexplored: no robbing, he walks there.
    expect(w.orderSpecialists([thief.id], store!.door.x, store!.door.y, store!.id)).toBe(1);
    expect(thief.errand).toBeNull();
    expect(thief.post).not.toBeNull();
    w.map.explored[w.map.idx(store!.door.x, store!.door.y)] |= 1;
    expect(w.orderSpecialists([thief.id], store!.door.x, store!.door.y, store!.id)).toBe(1);
    expect(thief.errand?.b).toBe(store!.id);
    expect(thief.post).toBeNull();
  });

  it('a mixed selection: specialists ignore fighters and fighters ignore specialists', () => {
    const w = new World(42);
    const pioneer = recruit(w, 'pioneer');
    const t = plainTile(w);
    w.releaseFighters(startTower(w).id, 2);
    const fighters = w.settlers.filter((s) => s.post && s.owner === 1 && s.kind !== 'pioneer').map((s) => s.id);
    expect(fighters.length).toBeGreaterThan(0);
    const ids = [pioneer.id, ...fighters];
    expect(w.orderSpecialists(ids, t.x, t.y)).toBe(1);
    expect(w.orderMove(ids, t.x, t.y)).toBe(fighters.length);
  });

  it('hold and dismiss work on the selected specialists', () => {
    const w = new World(42);
    const pioneer = recruit(w, 'pioneer');
    expect(w.holdSpecialists([pioneer.id])).toBe(1);
    expect(pioneer.post).toMatchObject({ x: Math.round(pioneer.x), y: Math.round(pioneer.y) });
    expect(w.dismissUnits([pioneer.id])).toBe(1);
    expect(pioneer.kind).toBe('carrier');
  });

  it('a specialist waiting at his post survives save and load bit-for-bit', () => {
    const w = new World(42);
    const pioneer = recruit(w, 'pioneer');
    const t = plainTile(w);
    w.orderSpecialists([pioneer.id], t.x, t.y);
    run(w, 100);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 800);
    run(l, 800);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});
