/**
 * A worker whose workplace goes keeps his profession and tool, as in Settlers 4 (docs/S4-AUDIT.md,
 * item 13): he waits with the idle crowd and the next workplace of his trade takes him first.
 */
import { describe, expect, it } from 'vitest';
import { addBuilding, isReadyWorker, spawnSettler } from '../src/sim/buildings';
import { PROFESSIONS } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base, groundUnits, startTower } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

describe('a jobless worker (Settlers 4)', () => {
  it('stays a woodcutter when his hut goes and takes the next one without a new axe', () => {
    const w = new World(42);
    startTower(w).output.plank = 40;
    startTower(w).output.stone = 20;
    const c = base(w);
    const hut = placeNear(w, 'woodcutter', c.x + 7, c.y - 4)!;
    let i = 0;
    while (hut.workerId === null && i++ < 20000) w.step();
    const worker = w.getSettler(hut.workerId)!;
    expect(worker.kind).toBe('woodcutter');
    run(w, 300);

    w.demolish(hut.id);
    expect(worker.kind).toBe('woodcutter');
    expect(worker.home).toBeNull();
    expect(isReadyWorker(worker)).toBe(true);
    run(w, 600);
    // He waits outside with the others, still a woodcutter.
    expect(worker.inside).toBeNull();
    expect(worker.kind).toBe('woodcutter');

    // Every axe gone: only he can staff the new hut.
    for (const b of w.buildings.values()) b.output.axe = 0;
    const axesOnGround = groundUnits(w, 'axe');
    const next = placeNear(w, 'woodcutter', c.x - 6, c.y + 3)!;
    i = 0;
    while (next.workerId === null && i++ < 20000) w.step();
    expect(next.workerId).toBe(worker.id);
    expect(worker.home).toBe(next.id);
    // He brought his own axe: none was used up.
    expect(groundUnits(w, 'axe')).toBe(axesOnGround);
  });

  it('a recruit in training is a carrier again when his barracks goes', () => {
    expect(PROFESSIONS.recruit.transient).toBe(true);
    const w = new World(42);
    const c = base(w);
    const barracks = addBuilding(w, 'barracks', c.x + 6, c.y + 6, 1, true);
    const recruit = spawnSettler(w, 'recruit', barracks);
    recruit.home = barracks.id;
    barracks.workerId = recruit.id;
    w.removeBuilding(barracks, 'none');
    expect(recruit.kind).toBe('carrier');
    expect(isReadyWorker(recruit)).toBe(false);
  });

  it('is saved as what he is', () => {
    const w = new World(42);
    const s = spawnSettler(w, 'woodcutter', startTower(w));
    s.inside = null;
    const back = World.load(saveWorld(w));
    expect(isReadyWorker(back.getSettler(s.id)!)).toBe(true);
  });
});
