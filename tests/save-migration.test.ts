/**
 * Saves of version 32 still load: back then the Romans had a pig farm (a pig farmer, pigs at
 * `RESOURCES` index 8) and, in its last saves, the sheep farm as well, with the sheep at the end of the
 * goods. On load the pig farm becomes a sheep farm, the pig farmer a shepherd and every pig a sheep
 * (`upgradeFrom32`; the ground's goods codes in `mapFromSave`).
 */
import { describe, expect, it } from 'vitest';
import { spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, TRANSPORT_PRIORITY } from '../src/sim/config';
import { goodsOn, putGoods, stackTiles } from '../src/sim/ground';
import { PIG_SAVE_VERSION, saveWorld, SAVE_VERSION, type SaveData } from '../src/sim/save';
import { RESOURCES, type Building, type BuildingType } from '../src/sim/types';
import { World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { base } from './helpers';

const run = (w: World, ticks: number) => {
  for (let i = 0; i < ticks; i++) w.step();
};

/** Version 32's goods (the sheep only in its last saves). */
const OLD_GOODS = [...RESOURCES.map((r) => (r === 'sheep' ? 'pig' : r)), 'sheep'];
const BACK: Record<string, string> = { sheep: 'pig', sheepfarm: 'pigfarm', shepherd: 'pigfarmer' };

/** A finished workshop with its worker inside. */
function workshop(w: World, type: BuildingType, dx: number, dy: number): Building {
  const c = base(w);
  const b = placeNear(w, type, c.x + dx, c.y + dy)!;
  b.done = true;
  b.levelled = true;
  const worker = spawnSettler(w, BUILDINGS[type].worker!, b);
  worker.home = b.id;
  b.workerId = worker.id;
  return b;
}

/**
 * What `w`'s save looked like in version 32: every sheep a pig, the sheep farm a pig farm, the shepherd a
 * pig farmer. With `sheep` (the last saves of version 32) every full stock also counts `sheep` (that
 * many units), the ground holds `sheep` sheep (code 26) and the transport list has both, the pig last.
 */
function asVersion32(w: World, sheep = 0): SaveData {
  const save = JSON.parse(JSON.stringify(saveWorld(w))) as SaveData;
  const back = (v: unknown): unknown => {
    if (typeof v === 'string') return BACK[v] ?? v;
    if (Array.isArray(v)) return v.map(back);
    if (v === null || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[BACK[k] ?? k] = back(x);
    if (sheep > 0 && RESOURCES.every((r) => typeof o[r] === 'number')) out.sheep = sheep;
    return out;
  };
  const all = save as unknown as Record<string, unknown>;
  for (const key of Object.keys(all)) if (key !== 'map') all[key] = back(all[key]);
  const goods = Uint8Array.from(atob(save.map.goods), (c) => c.charCodeAt(0));
  const amount = Uint8Array.from(atob(save.map.goodsAmount), (c) => c.charCodeAt(0));
  for (let i = 0; i < goods.length; i++) if (goods[i] > 0) goods[i] = OLD_GOODS.indexOf(BACK[RESOURCES[goods[i] - 1]] ?? RESOURCES[goods[i] - 1]) + 1;
  if (sheep > 0) {
    // A sheep stack (code 26) on the first free tile after the first pig stack.
    let i = goods.findIndex((k) => k === OLD_GOODS.indexOf('pig') + 1);
    while (goods[i] > 0) i++;
    goods[i] = OLD_GOODS.indexOf('sheep') + 1;
    amount[i] = sheep;
    for (const p of save.players) {
      const list = p.economy!.transport as string[];
      list.splice(list.indexOf('pig'), 0, 'sheep');
      list.splice(list.indexOf('pig'), 1);
      list.push('pig');
    }
  }
  save.map.goods = btoa(String.fromCharCode(...goods));
  save.map.goodsAmount = btoa(String.fromCharCode(...amount));
  save.version = PIG_SAVE_VERSION;
  return save;
}

/** Sheep lying on the ground. */
const sheepOnGround = (w: World) => stackTiles(w).reduce((n, i) => n + (goodsOn(w, i) === 'sheep' ? w.map.goodsAmount[i] : 0), 0);

/** A world with a staffed sheep farm and slaughterhouse, sheep on the ground and in the stats. */
function farmWorld(): { w: World; farm: Building; slaughter: Building } {
  const w = new World(42);
  const farm = workshop(w, 'sheepfarm', 6, 4);
  const slaughter = workshop(w, 'slaughterhouse', -6, 4);
  farm.output.sheep = 3;
  farm.input.grain = 4;
  farm.input.water = 4;
  const c = base(w);
  expect(putGoods(w, { x: c.x + 2, y: c.y + 6 }, 'sheep', 5)).toBe(0);
  w.stats.produced.sheep = 7;
  expect(w.setDistribution('grain', 'sheepfarm', 30)).toBe(true);
  run(w, 50);
  return { w, farm, slaughter };
}

describe('version-32 saves: the pig farm becomes a sheep farm', () => {
  it('this version has no pig: the sheep stands where the pig stood', () => {
    expect(SAVE_VERSION).toBe(PIG_SAVE_VERSION + 1);
    expect(RESOURCES.indexOf('sheep')).toBe(8);
    expect(RESOURCES as readonly string[]).not.toContain('pig');
    expect(Object.keys(BUILDINGS)).not.toContain('pigfarm');
  });

  it('a save from before the sheep farm: pig farm, pig farmer and pigs become sheep farm, shepherd and sheep', () => {
    const { w } = farmWorld();
    const old = asVersion32(w);
    expect(old.buildings.some((b) => (b.type as string) === 'pigfarm')).toBe(true);
    expect(old.settlers.some((s) => (s.kind as string) === 'pigfarmer')).toBe(true);
    expect(old.players[0].economy!.transport).toContain('pig');

    const l = World.load(old);
    // Exactly the world it was saved from.
    expect(saveWorld(l)).toEqual(saveWorld(w));
    const farm = [...l.buildings.values()].find((b) => b.type === 'sheepfarm')!;
    expect(l.settlers.find((s) => s.id === farm.workerId)!.kind).toBe('shepherd');
    expect(sheepOnGround(l)).toBe(sheepOnGround(w));
    expect(sheepOnGround(l)).toBeGreaterThan(0);
    expect(l.stats.produced.sheep).toBe(7);
    expect(l.players[0].economy!.distribution.grain?.sheepfarm).toBe(30);
    expect(Object.keys(l.players[0].economy!.distribution.grain!)).not.toContain('pigfarm');
    expect([...l.players[0].economy!.transport]).toEqual([...TRANSPORT_PRIORITY]);
  });

  it('a save with both: pigs and sheep add up, the sheep on the ground (code 26) get the new code', () => {
    const { w, farm: before } = farmWorld();
    const old = asVersion32(w, 2);
    const l = World.load(old);
    const farm = l.buildings.get(before.id)!;
    expect(farm.type).toBe('sheepfarm');
    expect(farm.output.sheep).toBe(before.output.sheep + 2);
    expect(Object.keys(farm.output).sort()).toEqual([...RESOURCES].sort());
    expect(l.stats.produced.sheep).toBe(7 + 2);
    expect(sheepOnGround(l)).toBe(sheepOnGround(w) + 2);
    for (const i of stackTiles(l)) expect(goodsOn(l, i)).not.toBeNull();
    const list = l.players[0].economy!.transport;
    expect([...list]).toEqual([...TRANSPORT_PRIORITY]);
  });

  it('the loaded game plays on: the sheep farm breeds, the slaughterhouse turns sheep into meat', () => {
    const { w } = farmWorld();
    const l = World.load(asVersion32(w));
    const farm = [...l.buildings.values()].find((b) => b.type === 'sheepfarm')!;
    farm.input.grain = 8;
    farm.input.water = 8;
    const meat = l.stats.produced.meat;
    const sheep = l.stats.produced.sheep;
    run(l, 9000);
    expect(l.stats.produced.sheep).toBeGreaterThan(sheep);
    expect(l.stats.produced.meat).toBeGreaterThan(meat);
    // It saves as this version and loads again.
    const again = saveWorld(l);
    expect(again.version).toBe(SAVE_VERSION);
    expect(saveWorld(World.load(again))).toEqual(again);
  });
});
