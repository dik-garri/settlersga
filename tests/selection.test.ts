import { describe, expect, it } from 'vitest';
import { spawnSettler } from '../src/sim/buildings';
import { maxHp } from '../src/sim/combat';
import { sameRegion } from '../src/sim/regions';
import { Terrain, type Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { sameTypeAround, SELECT_RADIUS, SELECTION_MAX, toggleInSelection, withoutHealthy } from '../src/ui/selection';
import { startTower } from './helpers';

/** A world whose start fighters stand free by the start tower (Settlers 4's start). */
function army() {
  const w = new World(42);
  w.step();
  const out = (kind: string) => w.settlers.filter((s) => s.owner === 1 && s.kind === kind && s.inside === null);
  return { w, soldiers: out('soldier'), archers: out('archer') };
}

describe('selecting units by type (Settlers 4: Shift / Alt + click, Ctrl + click, Backspace)', () => {
  it('radii follow S4’s spirals: 3000 and 19823 positions', () => {
    expect(SELECT_RADIUS.vicinity).toBe(10);
    expect(SELECT_RADIUS.sector).toBe(25);
    expect(SELECTION_MAX).toBe(100);
  });

  it('Alt/Shift + click take own units of the clicked one’s kind (every level), nearest first, within the radius', () => {
    const { w, soldiers, archers } = army();
    expect(soldiers.length).toBeGreaterThan(2);
    expect(archers.length).toBeGreaterThan(0);
    soldiers[1].level = 2; // levels do not split the type
    const far = soldiers[2];
    // A walkable tile of the same walkable area beyond the vicinity, within the sector.
    const m = w.map;
    const from = m.idx(Math.round(soldiers[0].x), Math.round(soldiers[0].y));
    let spot: { x: number; y: number } | null = null;
    for (let dy = -20; dy <= 20 && !spot; dy++) {
      for (let dx = -20; dx <= 20 && !spot; dx++) {
        const x = Math.round(soldiers[0].x) + dx;
        const y = Math.round(soldiers[0].y) + dy;
        const d = Math.hypot(x - soldiers[0].x, y - soldiers[0].y);
        if (d < SELECT_RADIUS.vicinity + 2 || d > SELECT_RADIUS.sector - 2 || !m.isWalkable(x, y)) continue;
        if (sameRegion(m, from, m.idx(x, y))) spot = { x, y };
      }
    }
    expect(spot).not.toBeNull();
    far.x = spot!.x;
    far.y = spot!.y;
    const near = sameTypeAround(w, soldiers[0], SELECT_RADIUS.vicinity, 1);
    expect(near[0]).toBe(soldiers[0].id);
    expect(near).toContain(soldiers[1].id);
    expect(near).not.toContain(far.id);
    for (const a of archers) expect(near).not.toContain(a.id);
    const sector = sameTypeAround(w, soldiers[0], SELECT_RADIUS.sector, 1);
    expect(sector).toContain(far.id);
    // Nearest first.
    const d = (id: number) => {
      const s = w.getSettler(id)!;
      return Math.hypot(s.x - soldiers[0].x, s.y - soldiers[0].y);
    };
    for (let i = 2; i < sector.length; i++) expect(d(sector[i])).toBeGreaterThanOrEqual(d(sector[i - 1]));
  });

  it('only in the clicked unit’s sector (walkable area), only own and outdoor units, at most 100', () => {
    const { w, soldiers } = army();
    const m = w.map;
    // A soldier put on water near the others is in no sector of theirs.
    let water: { x: number; y: number } | null = null;
    for (let r = 1; r < 30 && !water; r++) {
      for (let dy = -r; dy <= r && !water; dy++) {
        for (let dx = -r; dx <= r && !water; dx++) {
          const x = Math.round(soldiers[0].x) + dx;
          const y = Math.round(soldiers[0].y) + dy;
          if (m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Water) water = { x, y };
        }
      }
    }
    expect(water).not.toBeNull();
    const wet = soldiers[1];
    wet.x = water!.x;
    wet.y = water!.y;
    const inside = soldiers[2];
    inside.inside = startTower(w).id;
    const sector = sameTypeAround(w, soldiers[0], 40, 1);
    expect(sector).not.toContain(wet.id);
    expect(sector).not.toContain(inside.id);
    // An enemy's unit is never taken.
    const enemy = w.settlers.find((s) => s.owner === 2 && s.kind === 'soldier');
    if (enemy) expect(sameTypeAround(w, soldiers[0], 1000, 1)).not.toContain(enemy.id);
    // The cap.
    for (let i = 0; i < 130; i++) {
      const s = spawnSettler(w, 'soldier', startTower(w));
      s.inside = null;
      s.x = soldiers[0].x;
      s.y = soldiers[0].y;
    }
    expect(sameTypeAround(w, soldiers[0], SELECT_RADIUS.sector, 1).length).toBe(SELECTION_MAX);
  });

  it('Ctrl + click adds a unit of the selection’s type or takes it out; another type starts anew', () => {
    const { w, soldiers, archers } = army();
    let sel = [soldiers[0].id];
    sel = toggleInSelection(w, sel, soldiers[1]);
    expect(sel).toEqual([soldiers[0].id, soldiers[1].id]);
    sel = toggleInSelection(w, sel, soldiers[0]);
    expect(sel).toEqual([soldiers[1].id]);
    sel = toggleInSelection(w, sel, archers[0]);
    expect(sel).toEqual([archers[0].id]);
  });

  it('Backspace keeps only the units below half their hit points', () => {
    const { w, soldiers, archers } = army();
    const hurt = (s: Settler, share: number) => (s.hp = Math.floor(maxHp(s) * share));
    hurt(soldiers[0], 0.3);
    hurt(soldiers[1], 0.5); // exactly half: healthy, as S4's hp < max / 2
    hurt(archers[0], 0.1);
    const sel = [soldiers[0].id, soldiers[1].id, soldiers[2].id, archers[0].id];
    expect(withoutHealthy(w, sel)).toEqual([soldiers[0].id, archers[0].id]);
  });
});
