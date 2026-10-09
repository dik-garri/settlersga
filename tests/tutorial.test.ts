import { describe, expect, it } from 'vitest';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { DICTS, LANGS } from '../src/ui/i18n';
import type { BuildingType } from '../src/sim/types';
import { World } from '../src/sim/world';
import { anchorResolver } from '../src/tutorial/anchors';
import { MISSIONS } from '../src/tutorial/missions';
import { anchorsOf, missionWorld, onHand, TutorialRunner } from '../src/tutorial/runner';
import { begin, own, play, type Run } from './tutorialPlay';

const READY = MISSIONS.filter((m) => !m.soon);

describe('tutorial missions', () => {
  it('pass 2 has the first four missions ready, the rest listed as coming', () => {
    expect(READY.map((m) => m.id)).toEqual(['forest', 'logistics', 'bread', 'metal']);
    expect(MISSIONS.length).toBe(6);
  });

  for (const def of READY) {
    it(`${def.id}: every anchor resolves on its map`, () => {
      const run = begin(def);
      const resolve = anchorResolver(run.world, 1, {});
      for (const a of anchorsOf(def)) {
        // Live anchors (buildings the player makes) resolve once they exist.
        if (a.a === 'building' && a.owner !== 'scenario') continue;
        if (a.a === 'pile') continue;
        expect(resolve(a), JSON.stringify(a)).not.toBeNull();
      }
      for (const s of def.steps) for (const a of s.marker ?? []) if (a.a === 'spot') expect(resolve(a), s.id).not.toBeNull();
    });

    it(`${def.id}: a player following the steps wins within the time budget`, () => {
      const run = begin(def);
      const budget = Math.round(def.minutes * 1.5 * 60 * TICKS_PER_SECOND);
      const won = play(run, budget);
      const minutes = run.world.tick / TICKS_PER_SECOND / 60;
      process.stderr.write(`${def.id}: ${won ? 'won' : 'not won'} after ${minutes.toFixed(1)} min; steps entered at ${run.entered.map((t) => (t / 600).toFixed(1)).join(' ')}\n`);
      expect(won).toBe(true);
      // Every step was entered in turn (none skipped by an index jump).
      expect(run.entered.length).toBe(def.steps.length + 1);
      for (let k = 1; k < run.entered.length; k++) expect(run.entered[k]).toBeGreaterThanOrEqual(run.entered[k - 1]);
      // Counters never negative and nothing promised that is not there (world.test.ts' invariants).
      for (const b of run.world.buildings.values()) {
        for (const r of Object.keys(b.inbound) as (keyof typeof b.inbound)[]) {
          expect(b.inbound[r]).toBeGreaterThanOrEqual(0);
          expect(b.outReserved[r]).toBeGreaterThanOrEqual(0);
        }
      }
      for (const i of run.world.stacks) expect(run.world.map.goodsReserved[i]).toBeLessThanOrEqual(run.world.map.goodsAmount[i]);
      expect(run.world.stats.lost.plank + run.world.stats.lost.stone).toBe(0);
    });

    it(`${def.id}: saved and loaded halfway, it goes on and ends exactly as without the load`, () => {
      const budget = Math.round(def.minutes * 1.5 * 60 * TICKS_PER_SECOND);
      const half = Math.floor(def.steps.length / 2);
      const a = begin(def);
      play(a, budget, half);
      expect(a.runner.stepIndex).toBeGreaterThanOrEqual(half);
      // What the browser keeps in a slot: the world and, in its description, the mission's progress.
      const data = JSON.parse(JSON.stringify(saveWorld(a.world)));
      const progress = JSON.parse(JSON.stringify(a.runner.serialize()));
      const world = World.load(data);
      const b: Run = { world, runner: TutorialRunner.restore(def, progress), ui: { ...a.ui, camera: { ...a.ui.camera } }, entered: [...a.entered] };
      expect(b.runner.stepIndex).toBe(a.runner.stepIndex);
      expect(b.runner.serialize().anchors).toEqual(a.runner.serialize().anchors);
      expect(play(a, budget)).toBe(true);
      expect(play(b, budget)).toBe(true);
      expect(b.world.tick).toBe(a.world.tick);
      expect(b.entered).toEqual(a.entered);
    });

    it(`${def.id}: every text names only what its step fills in, in all three languages`, () => {
      const placeholders = (s: string) => new Set(s.match(/\{(\w+)\}/g)?.map((m) => m.slice(1, -1)) ?? []);
      const texts: [string, Record<string, unknown> | undefined][] = [];
      for (const s of def.steps) {
        texts.push([s.text, s.params]);
        if (s.more) texts.push([s.more, s.params]);
        if (s.hint) texts.push([s.hint.text, s.params]);
      }
      for (const o of def.objectives) texts.push([o.text, o.params]);
      texts.push([def.title, {}], [def.summary, {}], [def.debrief, {}]);
      for (const l of LANGS) {
        for (const [key, params] of texts) {
          const s = (DICTS[l] as Record<string, string>)[key];
          expect(s, `${l} ${key}`).toBeTruthy();
          for (const name of placeholders(s)) expect(params && name in params, `${l} ${key}: {${name}}`).toBe(true);
        }
      }
    });
  }

  it('missions still to come have their menu texts in every language', () => {
    for (const def of MISSIONS) {
      for (const l of LANGS) {
        expect((DICTS[l] as Record<string, string>)[def.title], `${l} ${def.title}`).toBeTruthy();
        expect((DICTS[l] as Record<string, string>)[def.summary], `${l} ${def.summary}`).toBeTruthy();
      }
    }
  });

  it('mission 2 starts with its scenario: ready buildings with their workers, and more carriers than beds', () => {
    const def = MISSIONS.find((m) => m.id === 'logistics')!;
    const w = missionWorld(def);
    const done = (type: BuildingType) => [...w.buildings.values()].filter((b) => b.owner === 1 && b.type === type && b.done).length;
    expect(done('woodcutter')).toBe(2);
    expect(done('sawmill')).toBe(1);
    expect(done('stonecutter')).toBe(1);
    expect(w.tags.get('sawmill')).toBe(own(w, 'sawmill')!.id);
    for (let i = 0; i < 200; i++) w.step();
    const beds = w.bedsOf(1);
    expect(beds.carriers).toBeGreaterThan(beds.beds);
    expect(beds.striking).toBeGreaterThan(0);
    // The ready-made workers took their workplaces.
    for (let i = 0; i < 1000; i++) w.step();
    for (const b of w.buildings.values()) if (b.owner === 1 && b.type !== 'tower') expect(b.workerId, b.type).not.toBeNull();
  });

  it('mission 3 starts with a hungry coal mine on the guaranteed coal and a second tower for room', () => {
    const def = MISSIONS.find((m) => m.id === 'bread')!;
    const w = missionWorld(def);
    const mine = w.buildings.get(w.tags.get('coalmine')!)!;
    expect(mine.type).toBe('coalmine');
    // Most of its digging disc lies on coal (`map.ore` code 1).
    const c = { x: mine.x + 0.5, y: mine.y + 0.5 };
    let coal = 0;
    for (let y = mine.y - 2; y <= mine.y + 3; y++) {
      for (let x = mine.x - 2; x <= mine.x + 3; x++) if (Math.hypot(x - c.x, y - c.y) <= 2 && w.map.ore[w.map.idx(x, y)] === 1) coal++;
    }
    expect(coal).toBeGreaterThanOrEqual(6);
    const store = w.buildings.get(w.tags.get('warehouse')!)!;
    expect(store.accept).toContain('coal');
    for (let i = 0; i < 600; i++) w.step();
    // No food at the start: the mine has eaten nothing yet; both towers are manned.
    expect(mine.attempts ?? 0).toBe(0);
    expect([...w.buildings.values()].filter((b) => b.owner === 1 && b.type === 'tower' && b.garrison.length > 0).length).toBe(2);
  });

  it('mission 4 tops up bread and fish, counting what carriers hold', () => {
    const def = MISSIONS.find((m) => m.id === 'metal')!;
    const run = begin(def);
    for (let i = 0; i < 3000; i++) {
      run.world.step();
      if (i % 5 === 0) run.runner.update(run.world, run.ui);
      expect(onHand(run.world, 1, 'bread')).toBeLessThanOrEqual(40);
    }
    expect(onHand(run.world, 1, 'bread')).toBeGreaterThanOrEqual(6);
  });
});
