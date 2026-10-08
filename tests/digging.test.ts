import { describe, expect, it } from 'vitest';
import { BUILD_MAX_SLOPE } from '../src/sim/config';
import { diggersWanted, needsLevelling } from '../src/sim/digging';
import { killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { abort } from '../src/sim/settlers';
import type { Building } from '../src/sim/types';
import { World } from '../src/sim/world';

function run(world: World, ticks: number) {
  for (let i = 0; i < ticks; i++) world.step();
}

/**
 * A woodcutter site on ground that is buildable but too steep to build on directly: a flat spot
 * near the castle whose site corners are then tilted by hand.
 */
function slopedSite(): { w: World; b: Building; spot: { x: number; y: number } } {
  const w = new World(42);
  w.castle.output.plank = 60;
  w.castle.output.stone = 30;
  const c = w.castle;
  let spot: { x: number; y: number } | null = null;
  for (let r = 3; r < 10 && !spot; r++) {
    for (let y = c.y - r; y <= c.y + r && !spot; y++) {
      for (let x = c.x - r; x <= c.x + r && !spot; x++) {
        if (w.canPlace('woodcutter', x, y) && !needsLevelling(w.map, 'woodcutter', x, y)) spot = { x, y };
      }
    }
  }
  if (!spot) throw new Error('no flat spot');
  // Tilt it: raise the back row of corners (footprint 2×2 plus door row → corners x..x+2, y..y+3).
  const base = w.map.vertexHeight(spot.x, spot.y);
  for (let vx = spot.x; vx <= spot.x + 2; vx++) w.map.setVertexHeight(vx, spot.y, base + BUILD_MAX_SLOPE + 8);
  expect(needsLevelling(w.map, 'woodcutter', spot.x, spot.y)).toBe(true);
  const b = w.placeBuilding('woodcutter', spot.x, spot.y)!;
  expect(b).not.toBeNull();
  expect(b.levelled).toBe(false);
  return { w, b, spot };
}

const siteRange = (w: World, b: Building) => w.map.heightRange(b.x, b.y, b.x + b.w - 1, b.y + b.h);

describe('diggers', () => {
  it('level a sloped site before the builders start, then it gets built', () => {
    const { w, b } = slopedSite();
    const versions = () => w.map.heightVersion.reduce((a, v) => a + v, 0);
    const before = versions();
    let builtBeforeLevel = false;
    for (let i = 0; i < 4000 && !b.done; i++) {
      w.step();
      if (!b.levelled && b.progress > 0) builtBeforeLevel = true;
    }
    expect(builtBeforeLevel).toBe(false);
    expect(b.levelled).toBe(true);
    expect(b.done).toBe(true);
    expect(siteRange(w, b)).toBe(0);
    expect(versions()).toBeGreaterThan(before); // the renderer is told which chunks to rebuild
    expect(w.settlers.some((s) => s.kind === 'digger')).toBe(true);
  });

  it('two diggers share a sloped site, as in Settlers 4, and clear it about twice as fast as one', () => {
    const levelTicks = (diggers: number) => {
      const { w, b } = slopedSite();
      expect(diggersWanted(w.map, b)).toBeGreaterThanOrEqual(2);
      w.orderWorkers('digger', diggers);
      for (const s of w.settlers.filter((s) => s.kind === 'digger').slice(diggers)) killSettler(w, s);
      let start = -1;
      let most = 0;
      for (let i = 0; i < 6000 && !b.levelled; i++) {
        w.step();
        most = Math.max(most, b.diggerIds.length);
        if (start < 0 && b.diggerIds.some((id) => w.getSettler(id)?.tasks[0]?.t === 'dig')) start = w.tick;
      }
      expect(b.levelled).toBe(true);
      expect(most).toBe(diggers);
      return w.tick - start;
    };
    const one = levelTicks(1);
    const two = levelTicks(2);
    expect(two).toBeLessThan(one * 0.65);
  });

  it('a digger taken off the job releases the site and another one finishes it', () => {
    const { w, b } = slopedSite();
    for (let i = 0; i < 600 && b.diggerIds.length === 0; i++) w.step();
    const digger = w.getSettler(b.diggerIds[0])!;
    expect(digger.kind).toBe('digger');
    abort(w, digger);
    expect(b.diggerIds).not.toContain(digger.id);
    run(w, 4000);
    expect(b.levelled).toBe(true);
    expect(siteRange(w, b)).toBe(0);
  });

  it('demolishing a site mid-dig leaves no job behind', () => {
    const { w, b } = slopedSite();
    for (let i = 0; i < 2000 && (b.diggerIds.length === 0 || siteRange(w, b) === BUILD_MAX_SLOPE + 8); i++) w.step();
    expect(b.diggerIds.length).toBeGreaterThan(0);
    expect(w.demolish(b.id)).toBe(true);
    expect(w.settlers.some((s) => s.tasks.some((t) => 'b' in t && t.b === b.id))).toBe(false);
    run(w, 500);
    expect(Object.values(w.stats.lost).every((n) => n === 0)).toBe(true);
  });

  it('a save taken mid-dig continues identically', () => {
    const { w, b } = slopedSite();
    for (let i = 0; i < 2000 && (b.diggerIds.length === 0 || b.levelled); i++) w.step();
    run(w, 30);
    expect(b.levelled).toBe(false);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1500);
    run(l, 1500);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});
