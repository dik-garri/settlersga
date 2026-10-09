import { describe, expect, it } from 'vitest';
import { BUILDINGS, TICKS_PER_SECOND } from '../src/sim/config';
import { saveWorld } from '../src/sim/save';
import { DICTS, LANGS } from '../src/ui/i18n';
import type { BuildingType, Point } from '../src/sim/types';
import { World } from '../src/sim/world';
import { anchorResolver } from '../src/tutorial/anchors';
import { MISSIONS } from '../src/tutorial/missions';
import { anchorsOf, missionWorld, TutorialRunner, type TutorialModel } from '../src/tutorial/runner';
import type { MissionDef, MissionId, UiProbe } from '../src/tutorial/types';

/** A fake interface for the conditions (the browser fills the same fields from `GameState`). */
function fakeUi(): UiProbe {
  return { menu: 'build', selected: null, selectedUnits: 0, groups: [], camera: { x: 32, y: 32 }, zoom: 1, placing: null, speed: 1, paused: false, jumps: 0 };
}

/** Places a site of `type` for the mark at a footprint centre (or the nearest spot that takes it). */
function placeAt(w: World, type: BuildingType, at: Point): boolean {
  const def = BUILDINGS[type];
  const x0 = Math.round(at.x - (def.w - 1) / 2);
  const y0 = Math.round(at.y - (def.h - 1) / 2);
  for (let r = 0; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (w.placeBuilding(type, x0 + dx, y0 + dy)) return true;
      }
    }
  }
  return false;
}

const has = (w: World, type: BuildingType) => [...w.buildings.values()].some((b) => b.owner === 1 && b.type === type);
const own = (w: World, type: BuildingType) => [...w.buildings.values()].find((b) => b.owner === 1 && b.type === type);

type Solution = (w: World, ui: UiProbe, m: TutorialModel, r: TutorialRunner) => void;

/** Builds the marked building once (the player's click on the arrow). */
const build = (type: BuildingType): Solution => (w, _ui, m) => {
  if (!has(w, type) && m.marks[0]) placeAt(w, type, m.marks[0]);
};
const ack: Solution = (_w, _ui, _m, r) => void r.ack();
const wait: Solution = () => {};

/** What a player does at each step: public commands and the interface only. */
const SOLUTIONS: Partial<Record<MissionId, Record<string, Solution>>> = {
  forest: {
    welcome: ack,
    look: (_w, ui) => (ui.camera = { x: ui.camera.x + 10, y: ui.camera.y }),
    zoom: (_w, ui) => (ui.zoom = 1.4),
    piles: ack,
    woodcutter: build('woodcutter'),
    digging: wait,
    sawmill: build('sawmill'),
    stonecutter: build('stonecutter'),
    forester: build('forester'),
    planks: wait,
  },
  logistics: {
    warehouse: build('warehouse'),
    wait,
    select: (w, ui) => (ui.selected = own(w, 'warehouse')?.id ?? null),
    accept: (w) => {
      const b = own(w, 'warehouse')!;
      w.setAccepts(b.id, 'plank', true);
      w.setAccepts(b.id, 'stone', true);
    },
    carry: wait,
    strike: ack,
    house: build('house_small'),
    priority: (w) => {
      let site = [...w.buildings.values()].find((b) => b.owner === 1 && !b.done);
      if (!site) {
        const home = w.homeOf(1);
        placeAt(w, 'forester', { x: home.x + 7, y: home.y - 6 });
        site = [...w.buildings.values()].find((b) => b.owner === 1 && !b.done);
      }
      if (site) w.setPriority(site.id, true);
    },
    stop: (w) => void w.setStopped(own(w, 'sawmill')!.id, true),
    restart: (w) => void w.setStopped(own(w, 'sawmill')!.id, false),
    transport: (w) => void w.moveTransport('stone', 'top'),
    reserve: ack,
    planks: wait,
  },
};

interface Run {
  world: World;
  runner: TutorialRunner;
  ui: UiProbe;
  /** Tick at which each step was entered. */
  entered: number[];
}

function begin(def: MissionDef): Run {
  const world = missionWorld(def);
  const ui = fakeUi();
  const runner = TutorialRunner.start(def, world, ui);
  return { world, runner, ui, entered: [world.tick] };
}

/** Plays until the mission ends or `ticks` pass, applying the solutions; true if won. */
function play(run: Run, ticks: number, stopAt?: number): boolean {
  const { world, runner, ui } = run;
  const sol = SOLUTIONS[runner.def.id]!;
  const end = world.tick + ticks;
  while (world.tick < end && !runner.finished) {
    world.step();
    if (world.tick % 5 !== 0) continue;
    runner.update(world, ui);
    while (run.entered.length <= runner.stepIndex) run.entered.push(world.tick);
    if (stopAt !== undefined && runner.stepIndex >= stopAt) return false;
    const m = runner.model(world);
    if (m.step) sol[m.step.id]?.(world, ui, m, runner);
  }
  return runner.finished === 'won';
}

const READY = MISSIONS.filter((m) => !m.soon);

describe('tutorial missions', () => {
  it('pass 1 has the first two missions ready, the rest listed as coming', () => {
    expect(READY.map((m) => m.id)).toEqual(['forest', 'logistics']);
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
});
