import { BUILDINGS } from '../src/sim/config';
import type { BuildingType, Point } from '../src/sim/types';
import type { World } from '../src/sim/world';
import { missionWorld, TutorialRunner, type TutorialModel } from '../src/tutorial/runner';
import type { MissionDef, MissionId, UiProbe } from '../src/tutorial/types';

/**
 * A headless player for the tutorial missions (`tests/tutorial.test.ts`): what he does at each step
 * (`SOLUTIONS`, public commands and a fake interface only) and the loop that plays a mission.
 */

/** A fake interface for the conditions (the browser fills the same fields from `GameState`). */
export function fakeUi(): UiProbe {
  return { menu: 'build', selected: null, selectedUnits: 0, groups: [], camera: { x: 32, y: 32 }, zoom: 1, placing: null, speed: 1, paused: false, jumps: 0 };
}

/** Places a site of `type` for the mark at a footprint centre (or the nearest spot that takes it). */
export function placeAt(w: World, type: BuildingType, at: Point): boolean {
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

export const has = (w: World, type: BuildingType) => [...w.buildings.values()].some((b) => b.owner === 1 && b.type === type);
export const own = (w: World, type: BuildingType) => [...w.buildings.values()].find((b) => b.owner === 1 && b.type === type);

export type Solution = (w: World, ui: UiProbe, m: TutorialModel, r: TutorialRunner) => void;

/** Builds the marked building once (the player's click on the arrow). */
export const build = (type: BuildingType): Solution => (w, _ui, m) => {
  if (!has(w, type) && m.marks[0]) placeAt(w, type, m.marks[0]);
};
export const ack: Solution = (_w, _ui, _m, r) => void r.ack();
export const wait: Solution = () => {};

/** What a player does at each step: public commands and the interface only. */
export const SOLUTIONS: Partial<Record<MissionId, Record<string, Solution>>> = {
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
  bread: {
    mine: (w, ui, _m, r) => {
      ui.selected = w.tags.get('coalmine') ?? null;
      r.ack();
    },
    fisher: build('fisher'),
    waterworks: build('waterworks'),
    farm: build('farm'),
    area: (w, ui) => {
      const farm = own(w, 'farm')!;
      ui.selected = farm.id;
      w.setWorkArea(farm.id, freestMeadow(w, farm.door, 5, 4));
    },
    mill: build('mill'),
    bakery: build('bakery'),
    grain: (_w, ui) => (ui.speed = 4),
    share: (w, ui) => {
      ui.menu = 'goods';
      w.setDistribution('bread', 'coalmine', 100);
    },
    coal: wait,
  },
  metal: {
    geologist: (_w, ui) => {
      ui.menu = 'settlers';
      ui.placing = 'geologist';
    },
    // The click on the mountain under the ring.
    prospect: (w, ui, m) => {
      const at = m.marks[0];
      if (ui.placing === 'geologist' && at && w.sendGeologist(Math.round(at.x), Math.round(at.y))) ui.placing = null;
    },
    // Space: the camera goes to the last message.
    message: (_w, ui) => void ui.jumps++,
    signs: ack,
    coalmine: build('coalmine'),
    ironmine: build('ironmine'),
    smelter: build('ironsmelter'),
    toolsmith: build('toolsmith'),
    order: (w, ui) => {
      ui.selected = own(w, 'toolsmith')?.id ?? null;
      w.orderTool('shovel', 2);
    },
    shovels: (_w, ui) => (ui.speed = 4),
  },
};

/** The tile within `reach` of `at` whose disc of radius `r` holds the most free plantable ground (the player's eye for a meadow). */
export function freestMeadow(w: World, at: Point, reach: number, r: number): Point {
  let best = at;
  let most = -1;
  for (let y = at.y - reach; y <= at.y + reach; y++) {
    for (let x = at.x - reach; x <= at.x + reach; x++) {
      if (Math.hypot(x - at.x, y - at.y) > reach) continue;
      let n = 0;
      for (let v = y - r; v <= y + r; v++) {
        for (let u = x - r; u <= x + r; u++) {
          if (Math.hypot(u - x, v - y) <= r && w.map.inBounds(u, v) && w.map.isPlantable(u, v) && w.map.owner[w.map.idx(u, v)] === 1) n++;
        }
      }
      if (n > most) {
        most = n;
        best = { x, y };
      }
    }
  }
  return best;
}

export interface Run {
  world: World;
  runner: TutorialRunner;
  ui: UiProbe;
  /** Tick at which each step was entered. */
  entered: number[];
}

export function begin(def: MissionDef): Run {
  const world = missionWorld(def);
  const ui = fakeUi();
  const runner = TutorialRunner.start(def, world, ui);
  return { world, runner, ui, entered: [world.tick] };
}

/** Plays until the mission ends or `ticks` pass, applying the solutions; true if won. */
export function play(run: Run, ticks: number, stopAt?: number): boolean {
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

