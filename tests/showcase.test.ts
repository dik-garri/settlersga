import { describe, expect, it } from 'vitest';
import { buildShowcase } from '../src/dev/showcase';
import { BUILDINGS } from '../src/sim/config';
import { isCutOff } from '../src/sim/land';
import { pathLevel } from '../src/sim/paths';
import type { BuildingType } from '../src/sim/types';

describe('dev showcase (?demo)', () => {
  it('shows every building finished, frozen construction stages and goods piles, also on the ground', () => {
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
    expect(crowd.filter((s) => s.inside === null).length).toBeGreaterThan(2);
    // Specialists at work: a pioneer has claimed land, a thief is on his errand.
    expect(w.pioneerLand).toBeGreaterThan(0);
    const thief = w.settlers.find((s) => s.kind === 'thief');
    expect(thief?.errand?.b).toBeDefined();
    // Trade: a market with a route, donkeys under way with goods, and land cut off from every warehouse.
    expect(all.some((b) => b.type === 'market' && b.trade?.to != null)).toBe(true);
    expect(w.settlers.some((s) => s.kind === 'donkey' && s.tasks.length > 0)).toBe(true);
    expect(w.settlers.some((s) => s.kind === 'donkey' && s.carrying !== null)).toBe(true);
    expect(all.some((b) => b.owner === 1 && isCutOff(w, b))).toBe(true);
    // Goods lying on the ground (Settlers 4's piles: start goods, ruins), several kinds of them.
    expect(new Set([...w.stacks].map((i) => w.map.goods[i])).size).toBeGreaterThanOrEqual(4);
    // A field squad stands round its leader (direct army control).
    const leader = w.settlers.find((s) => s.kind === 'leader' && s.post);
    expect(leader).toBeDefined();
    const squad = w.settlers.filter((s) => s.post?.leader === leader!.id);
    expect(squad.length).toBeGreaterThanOrEqual(4);
    for (const s of squad) expect(Math.hypot(s.x - leader!.x, s.y - leader!.y)).toBeLessThan(4);
  });
});
