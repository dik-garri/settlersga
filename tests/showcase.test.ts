import { describe, expect, it } from 'vitest';
import { buildShowcase } from '../src/dev/showcase';
import { BUILDINGS } from '../src/sim/config';
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
  });
});
