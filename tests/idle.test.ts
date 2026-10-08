import { describe, expect, it } from 'vitest';
import { BUILDINGS, IDLE, IDLE_GO_HOME_TICKS } from '../src/sim/config';
import { chatPartner } from '../src/sim/idle';
import { saveWorld } from '../src/sim/save';
import type { Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

const idleCarriers = (w: World): Settler[] =>
  w.settlers.filter((s) => s.kind === 'carrier' && s.tasks.length === 0 && s.idleTicks > IDLE_GO_HOME_TICKS + 1);

describe('idle crowds', () => {
  it('with no warehouse or house yet they gather by the start tower', () => {
    const w = new World(42);
    run(w, 600);
    const idle = idleCarriers(w);
    expect(idle.length).toBeGreaterThan(4);
    for (const s of idle) expect(s.idleAt).toBe(startTower(w).id);
  });

  it('free carriers stand outside in small groups near warehouses and houses, never on doors', () => {
    const w = new World(42);
    const c = base(w);
    startTower(w).output.plank = 60;
    startTower(w).output.stone = 30;
    placeNear(w, 'house_small', c.x + 5, c.y - 1);
    placeNear(w, 'house_small', c.x - 5, c.y + 3);
    run(w, 4000);
    const idle = idleCarriers(w);
    expect(idle.length).toBeGreaterThan(8);
    for (const s of idle) {
      expect(s.inside).toBeNull();
      const b = w.buildings.get(s.idleAt!)!;
      // The start tower only for want of a house or warehouse (`IDLE.fallbackAt`); one chosen
      // before the houses stood stays valid until the settler's next idle spell.
      expect(BUILDINGS[b.type].storage || BUILDINGS[b.type].residence || BUILDINGS[b.type].garrison).toBeTruthy();
      expect(Math.hypot(s.x - b.door.x, s.y - b.door.y)).toBeLessThanOrEqual(IDLE.radius * Math.SQRT2 + 1.5);
      if (s.stroll === null) {
        const i = w.map.idx(Math.round(s.x), Math.round(s.y));
        expect(w.map.isWalkable(Math.round(s.x), Math.round(s.y))).toBe(true);
        expect(w.map.door[i]).toBe(0);
      }
    }
    // The houses gather most of them, more than one place once a group is full.
    expect(idle.filter((s) => BUILDINGS[w.buildings.get(s.idleAt!)!.type].residence).length).toBeGreaterThan(idle.length / 2);
    expect(new Set(idle.map((s) => s.idleAt)).size).toBeGreaterThan(1);
    // Some of them are chatting in pairs, facing each other.
    run(w, 1500);
    expect(w.settlers.some((s) => chatPartner(w, s) !== undefined)).toBe(true);
  });

  it('idle carriers outside still take jobs promptly', () => {
    const w = new World(42);
    const c = base(w);
    startTower(w).output.plank = 60;
    startTower(w).output.stone = 30;
    run(w, 1500);
    expect(idleCarriers(w).some((s) => s.stroll !== null || s.inside === null)).toBe(true);
    const site = placeNear(w, 'house_small', c.x + 5, c.y + 4)!;
    run(w, 60);
    expect(site.inbound.plank + site.delivered.plank).toBeGreaterThan(0);
    run(w, 2500);
    expect(site.done).toBe(true);
  });

  it('are deterministic and survive save and load mid-stroll', () => {
    const make = () => {
      const w = new World(7);
      startTower(w).output.plank = 40;
      placeNear(w, 'house_small', base(w).x + 5, base(w).y - 1);
      run(w, 2000);
      return w;
    };
    const a = make();
    expect(a.settlers.some((s) => s.stroll !== null || s.chatWith !== null)).toBe(true);
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    run(a, 1500);
    run(b, 1500);
    expect(saveWorld(b)).toEqual(saveWorld(a));
    expect(saveWorld(make())).toEqual(saveWorld(make()));
  });
});
