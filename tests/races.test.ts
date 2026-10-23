import { describe, expect, it } from 'vitest';
import {
  AI_PLAN,
  buildableBy,
  BUILDINGS,
  GOODS_ORDER,
  GOODS_SHOWN,
  goodOfRace,
  PLAYED_RACE,
  RESOURCE_INFO,
} from '../src/sim/config';
import { LATER_GOODS, saveWorld, type SaveData } from '../src/sim/save';
import { RESOURCES, type BuildingType } from '../src/sim/types';
import { World } from '../src/sim/world';
import { MISSIONS } from '../src/tutorial/missions';
import { placeNear } from '../tools/scenario';
import { base, placeForeign } from './helpers';

const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) w.step();
};

describe('races: the Romans keep sheep, the pig farm is the Vikings’ (Settlers 4)', () => {
  it('the sheep farm is Roman; the pig farm stays in the data but no Roman builds it', () => {
    expect(PLAYED_RACE).toBe('romans');
    expect(buildableBy('sheepfarm')).toBe(true);
    expect(buildableBy('pigfarm')).toBe(false);
    expect(buildableBy('pigfarm', 'vikings')).toBe(true);
    expect(BUILDINGS.sheepfarm.recipe!.outputs).toEqual({ sheep: 1 });
    expect(BUILDINGS.pigfarm.recipe!.outputs).toEqual({ pig: 1 });
    // The same animal ranch otherwise (S4's `CAnimalRanchRole`).
    const { outputs: _a, ...sheep } = BUILDINGS.sheepfarm.recipe!;
    const { outputs: _b, ...pig } = BUILDINGS.pigfarm.recipe!;
    expect(sheep).toEqual(pig);
    expect(BUILDINGS.sheepfarm.cost).toEqual(BUILDINGS.pigfarm.cost);
  });

  it('the AI plan and the tutorial offer only what the Romans build', () => {
    for (const step of AI_PLAN) expect(buildableBy(step.type), step.type).toBe(true);
    expect(AI_PLAN.some((s) => s.type === 'sheepfarm')).toBe(true);
    for (const m of MISSIONS) for (const t of (m.unlock?.buildings ?? []) as BuildingType[]) expect(buildableBy(t), `${m.id} ${t}`).toBe(true);
  });

  it('the sheep is a new good at the end of RESOURCES; the menus show it, not the pig', () => {
    expect(RESOURCES.at(-1)).toBe('sheep');
    expect(LATER_GOODS).toEqual(['sheep']);
    // Goods on the ground keep their codes: the pig is still the ninth good.
    expect(RESOURCES.indexOf('pig')).toBe(8);
    expect(GOODS_ORDER.slice().sort()).toEqual([...RESOURCES].sort());
    expect(GOODS_SHOWN).toContain('sheep');
    expect(GOODS_SHOWN).not.toContain('pig');
    expect(goodOfRace('pig', 'vikings')).toBe(true);
    expect(RESOURCE_INFO.sheep.group).toBe('food');
    // In the food group the sheep comes where the pig was, before the meat.
    expect(GOODS_ORDER.indexOf('sheep')).toBe(GOODS_ORDER.indexOf('bread') + 1);
  });

  it('a Roman cannot place a pig farm, but one standing (an older save) works, stops and is demolished', () => {
    const w = new World(42);
    const c = base(w);
    let free: { x: number; y: number } | null = null;
    for (let y = c.y - 8; y <= c.y + 8 && !free; y++) for (let x = c.x - 8; x <= c.x + 8 && !free; x++) if (w.canPlace('pigfarm', x, y)) free = { x, y };
    expect(free).not.toBeNull();
    expect(w.placeBuilding('pigfarm', free!.x, free!.y)).toBeNull();
    const farm = placeForeign(w, 'pigfarm', c.x + 6, c.y + 4, true)!;
    farm.input.grain = 6;
    farm.input.water = 6;
    run(w, 1500);
    expect(farm.workerId).not.toBeNull();
    expect(w.stats.produced.pig).toBeGreaterThan(0);
    expect(w.setStopped(farm.id, true)).toBe(true);
    expect(w.demolish(farm.id)).toBe(true);
  });

  it('a Roman places a sheep farm (the meat chain: tests/food.test.ts)', () => {
    const w = new World(42);
    const c = base(w);
    const farm = placeNear(w, 'sheepfarm', c.x + 6, c.y + 4)!;
    expect(farm).not.toBeNull();
    expect(farm.type).toBe('sheepfarm');
  });

  it('an older save (no sheep in its stocks or transport list) loads and plays on', () => {
    const w = new World(42);
    const c = base(w);
    const farm = placeForeign(w, 'pigfarm', c.x + 6, c.y + 4, true)!;
    farm.input.grain = 8;
    farm.input.water = 8;
    run(w, 1200);
    const raw = JSON.parse(JSON.stringify(saveWorld(w))) as SaveData;
    // What a save written before the sheep looked like.
    const strip = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(strip);
      if (v === null || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      delete o.sheep;
      for (const k of Object.keys(o)) strip(o[k]);
    };
    strip(raw.buildings);
    strip(raw.stats);
    strip(raw.players);
    for (const p of raw.players) p.economy!.transport = p.economy!.transport.filter((r) => r !== 'sheep');
    expect(raw.buildings.every((b) => !('sheep' in b.output))).toBe(true);

    const l = World.load(raw);
    const pig = [...l.buildings.values()].find((b) => b.type === 'pigfarm')!;
    expect(pig).toBeDefined();
    for (const b of l.buildings.values()) for (const k of ['output', 'input', 'inbound', 'outReserved', 'delivered'] as const) expect(b[k].sheep).toBe(0);
    expect(l.stats.produced.sheep).toBe(0);
    const order = l.players[0].economy!.transport;
    expect([...order].sort()).toEqual([...RESOURCES].sort());
    expect(order.at(-1)).toBe('sheep');
    const before = l.stats.produced.pig;
    pig.input.grain = 8;
    pig.input.water = 8;
    run(l, 1500);
    expect(l.stats.produced.pig).toBeGreaterThan(before);
    for (const b of l.buildings.values()) for (const n of Object.values(b.output)) expect(Number.isFinite(n)).toBe(true);
  });
});
