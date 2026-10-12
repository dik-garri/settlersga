import { describe, expect, it } from 'vitest';
import { BuildingMemory } from '../src/render/memory';
import { saveWorld } from '../src/sim/save';
import type { Building, PlayerId } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { startTower } from './helpers';

/** The footprint and door tiles of a building. */
function tiles(w: World, b: Pick<Building, 'x' | 'y' | 'w' | 'h' | 'door'>): number[] {
  const out = [w.map.idx(b.door.x, b.door.y)];
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) out.push(w.map.idx(x, y));
  return out;
}

/** Puts a building's place in or out of player `p`'s sight (as a passing settler would), explored either way. */
function sight(w: World, b: Pick<Building, 'x' | 'y' | 'w' | 'h' | 'door'>, on: boolean, p: PlayerId = 1): void {
  for (const i of tiles(w, b)) {
    w.fog.seenUntil[p - 1][i] = on ? 0xffffffff : 0;
    w.map.explored[i] |= 1 << (p - 1);
  }
}

/** A site of player 2's near its start tower, far from player 1. */
function enemySite(w: World): Building {
  const t = startTower(w, 2);
  const b = placeNear(w, 'woodcutter', t.x + 5, t.y + 1, 12, 2);
  expect(b).not.toBeNull();
  return b!;
}

/** A two-player world one tick old, and player 1's memory made before that tick (a new game). */
function setup(): { w: World; m: BuildingMemory } {
  const w = new World(42, { players: 2 });
  const m = new BuildingMemory(w, 1, true);
  w.step();
  return { w, m };
}

function shownIds(m: BuildingMemory): number[] {
  const ids: number[] = [];
  m.forEachShown((l) => ids.push(l.id));
  return ids;
}

describe('memory of buildings under the fog (render side)', () => {
  it('a foreign building never seen is not shown, even on explored tiles', () => {
    const { w, m } = setup();
    const t2 = startTower(w, 2);
    expect(w.isVisible(t2.door.x, t2.door.y, 1)).toBe(false);
    sight(w, t2, false);
    expect(w.isExplored(t2.door.x, t2.door.y, 1)).toBe(true);
    m.refresh();
    expect(m.shows(t2)).toBe(false);
    expect(m.get(t2.id)).toBeUndefined();
    expect(m.at(t2.x, t2.y)).toBeUndefined();
    expect(shownIds(m)).not.toContain(t2.id);
    // The player's own buildings are always shown live.
    const t1 = startTower(w, 1);
    expect(m.live(t1)).toBe(true);
    expect(shownIds(m)).toContain(t1.id);
  });

  it('what was seen is remembered, and growth out of sight is not', () => {
    const { w, m } = setup();
    const site = enemySite(w);
    sight(w, site, true);
    m.refresh();
    expect(m.live(site)).toBe(true);
    const seen = m.get(site.id)!;
    expect(seen.done).toBe(false);
    const progress = seen.progress;
    // Out of sight the builders finish it: the player still sees the site as it was.
    sight(w, site, false);
    site.levelled = true;
    site.progress += 1000;
    site.done = true;
    m.refresh();
    expect(m.live(site)).toBe(false);
    expect(m.shows(site)).toBe(true);
    expect(m.get(site.id)!.done).toBe(false);
    expect(m.get(site.id)!.progress).toBe(progress);
    const known = m.at(site.x, site.y)!;
    expect(known.live).toBe(false);
    expect(known.building).toBe(site);
    expect(known.look.done).toBe(false);
    // Seen again: as it is now.
    sight(w, site, true);
    m.refresh();
    expect(m.live(site)).toBe(true);
    expect(m.get(site.id)!.done).toBe(true);
  });

  it('a building placed in the shade stays unknown until seen', () => {
    const { w, m } = setup();
    const site = enemySite(w);
    sight(w, site, false);
    m.refresh();
    expect(m.shows(site)).toBe(false);
    expect(shownIds(m)).not.toContain(site.id);
    sight(w, site, true);
    m.refresh();
    expect(m.shows(site)).toBe(true);
  });

  it('one demolished out of sight is a ghost until its place is seen again', () => {
    const { w, m } = setup();
    const site = enemySite(w);
    sight(w, site, true);
    m.refresh();
    sight(w, site, false);
    m.refresh();
    expect(w.apply({ kind: 'demolish', player: 2, id: site.id })).toBeTruthy();
    expect(w.buildings.has(site.id)).toBe(false);
    m.refresh();
    expect(m.ghostIds().has(site.id)).toBe(true);
    expect(shownIds(m)).toContain(site.id);
    const ghost = m.at(site.x, site.y)!;
    expect(ghost.look.id).toBe(site.id);
    expect(ghost.building).toBeUndefined();
    expect(ghost.live).toBe(false);
    // The player looks again: the ghost is gone.
    sight(w, site, true);
    m.refresh();
    expect(m.get(site.id)).toBeUndefined();
    expect(m.ghostIds().size).toBe(0);
    expect(m.at(site.x, site.y)).toBeUndefined();
  });

  it('a building that changes hands out of sight keeps the owner it was seen with', () => {
    const { w, m } = setup();
    const site = enemySite(w);
    sight(w, site, true);
    m.refresh();
    sight(w, site, false);
    // Stands for a conquest (a third party), out of the player's sight.
    site.owner = 3 as PlayerId;
    m.refresh();
    expect(m.get(site.id)!.owner).toBe(2);
  });

  it('allies’ buildings are live without sight; foes’ are not', () => {
    const w = new World(42, { size: 96, players: 4, teams: [1, 1, 2, 2] });
    const m = new BuildingMemory(w, 1, true);
    w.step();
    m.refresh();
    const ally = startTower(w, 2);
    const foe = startTower(w, 3);
    expect(m.live(ally)).toBe(true);
    expect(m.live(foe)).toBe(false);
    expect(m.shows(foe)).toBe(false);
  });

  it('with the fog off there is no memory: everything is live', () => {
    const w = new World(42, { players: 2 });
    const m = new BuildingMemory(w, 1, false);
    w.step();
    m.refresh();
    const t2 = startTower(w, 2);
    expect(m.live(t2)).toBe(true);
    expect(m.at(t2.x, t2.y)?.live).toBe(true);
    expect(shownIds(m)).toContain(t2.id);
  });

  it('after a load what stands on explored tiles is known as it stands now; a new game knows nothing', () => {
    const w = new World(42, { players: 2 });
    w.step();
    const site = enemySite(w);
    sight(w, site, false);
    const loaded = World.load(saveWorld(w));
    const seeded = new BuildingMemory(loaded, 1, true);
    expect(seeded.get(site.id)).toBeDefined();
    expect(seeded.live(loaded.buildings.get(site.id)!)).toBe(false);
    // A memory made with the world at tick 0 starts empty.
    const fresh = new World(42, { players: 2 });
    expect(new BuildingMemory(fresh, 1, true).get(startTower(fresh, 2).id)).toBeUndefined();
  });

  it('update is throttled', () => {
    const { w, m } = setup();
    const site = enemySite(w);
    sight(w, site, true);
    m.update(1000);
    expect(m.live(site)).toBe(true);
    sight(w, site, false);
    m.update(1050);
    expect(m.live(site)).toBe(true);
    m.update(1200);
    expect(m.live(site)).toBe(false);
  });
});
