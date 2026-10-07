import { describe, expect, it } from 'vitest';
import { buildShowcase } from '../src/dev/showcase';
import { BUILDINGS } from '../src/sim/config';
import { pathLevel } from '../src/sim/paths';
import type { BuildingType } from '../src/sim/types';

describe('dev showcase (?demo)', () => {
  it('shows every building finished, frozen construction stages and goods piles', () => {
    const w = buildShowcase();
    const all = [...w.buildings.values()];
    const frozen = (b: (typeof all)[number]) => b.unreachableUntil > 1e15;
    for (const type of Object.keys(BUILDINGS) as BuildingType[]) {
      if (!BUILDINGS[type].playerBuildable) continue;
      expect(all.some((b) => b.type === type && b.done), type).toBe(true);
    }
    expect(all.filter((b) => !b.done && frozen(b)).length).toBeGreaterThanOrEqual(8);
    const piles = all.filter((b) => b.done && frozen(b));
    expect(piles.length).toBeGreaterThanOrEqual(6);
    expect(piles.some((b) => Object.values(b.output).some((n) => n > 8))).toBe(true);
    // The infirmary is in use and the lookout tower stands.
    expect(w.settlers.some((s) => s.tasks.some((t) => t.t === 'heal'))).toBe(true);
    expect(all.some((b) => b.type === 'lookout' && b.done)).toBe(true);
    // The hunter is at work and busy routes have worn into paths.
    expect(all.some((b) => b.type === 'hunter' && b.workerId !== null)).toBe(true);
    expect([...w.worn].some((i) => pathLevel(w.map.wear[i]) >= 1)).toBe(true);
    // Free carriers crowd outside near buildings (`idle.ts`).
    const crowd = w.settlers.filter((s) => s.kind === 'carrier' && s.tasks.length === 0 && s.idleAt !== null);
    expect(crowd.filter((s) => s.inside === null).length).toBeGreaterThan(5);
  });
});
