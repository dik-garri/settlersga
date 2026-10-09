import { BUILDINGS } from '../src/sim/config';
import { ENDLESS, workerOrder } from '../src/sim/economy';
import { isFighter } from '../src/sim/military';
import type { Building, BuildingType, Point, Settler } from '../src/sim/types';
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
    // The order is in the window of the finished smithy.
    order: (w, ui) => {
      const smith = own(w, 'toolsmith');
      if (!smith?.done) return;
      ui.selected = smith.id;
      w.orderTool('shovel', 2);
    },
    shovels: (_w, ui) => (ui.speed = 4),
  },
  trade: {
    // «+1» in the settlers menu's worker orders.
    pioneer: (w, ui) => {
      ui.menu = 'settlers';
      if (workerOrder(w, 1, 'pioneer') < 1) w.orderSpecialist('pioneer', 1);
    },
    // The errand chosen in the settlers menu, then a click on the arrow.
    claim: (w, ui, m) => {
      const at = m.marks[0];
      if (!at || w.settlers.some((s) => s.owner === 1 && s.kind === 'pioneer' && s.errand)) return;
      ui.placing = 'pioneer';
      if (w.sendPioneer(Math.round(at.x), Math.round(at.y))) ui.placing = null;
    },
    outpost: ack,
    stonecutter: (w, _ui, m) => {
      if (!marketNear(w, 'stonecutter', m.marks[0]) && m.marks[0]) placeAt(w, 'stonecutter', m.marks[0]);
    },
    market: build('market'),
    ranch: build('donkeyranch'),
    postMarket: (w, _ui, m) => {
      if (!marketNear(w, 'market', m.marks[0]) && m.marks[0]) placeAt(w, 'market', m.marks[0]);
    },
    wait: (_w, ui) => (ui.speed = 2),
    // The home market's window: the route to the outpost's market, then planks and stone.
    route: (w) => {
      const [here, there] = markets(w);
      if (!here || !there) return;
      w.setTradeRoute(here.id, there.id);
      for (const res of ['plank', 'stone'] as const) w.orderTrade(here.id, res, ENDLESS);
    },
    built: (_w, ui) => (ui.speed = 4),
    stop: (w) => {
      const [here] = markets(w);
      if (here) for (const res of ['plank', 'stone'] as const) w.orderTrade(here.id, res, 0);
    },
    back: (w) => {
      const [here, there] = markets(w);
      if (!here || !there) return;
      w.setTradeRoute(there.id, here.id);
      w.orderTrade(there.id, 'stone', ENDLESS);
    },
    stone: wait,
  },
  battle: {
    bigtower: build('bigtower'),
    wait: (_w, ui) => (ui.speed = 2),
    // A click on the finished tower, then «Fill».
    fill: (w, ui) => {
      const t = own(w, 'bigtower');
      if (!t) return;
      ui.selected = t.id;
      if ((t.wish?.melee ?? 0) + (t.wish?.ranged ?? 0) < 6) w.fillGarrison(t.id);
    },
    barracks: build('barracks'),
    // The army menu's recruit orders: +5 swordsmen and +5 archers of level 1, +1 swordsman of level 2.
    orders: (w, ui) => {
      ui.menu = 'army';
      if (w.recruitOrder('soldier', 0) === 0) w.orderRecruits('soldier', 0, 5);
      if (w.recruitOrder('archer', 0) === 0) w.orderRecruits('archer', 0, 5);
      if (w.recruitOrder('soldier', 1) === 0) w.orderRecruits('soldier', 1, 1);
    },
    recruits: (_w, ui) => (ui.speed = 4),
    // A box round the fighters standing by the barracks.
    select: (w, ui) => (ui.selectedUnits = freeFighters(w).length),
    // A right click on the arrow.
    move: (w, _ui, m) => {
      const ids = freeFighters(w).filter((s) => !s.post).map((s) => s.id);
      const at = m.marks[0];
      if (at && ids.length > 0) w.orderMove(ids, Math.round(at.x), Math.round(at.y));
    },
    group: (w, ui) => (ui.groups[1] = fieldUnits(w).length),
    scout: build('lookout'),
    // The group (key 1), then a right click on the enemy tower.
    attack: (w) => {
      const target = enemyBuildingNear(w);
      const ids = fieldUnits(w).filter((s) => !s.tasks.some((t) => t.t === 'assault')).map((s) => s.id);
      if (target && ids.length > 0) w.orderAttack(ids, target.id);
    },
    infirmary: build('infirmary'),
    // Everyone outside at the rival's last tower; with none left, at his last fighters.
    victory: (w) => {
      if (w.tick % 300 !== 0) return;
      const ids = [...fieldUnits(w), ...freeFighters(w)].filter((s) => !s.tasks.some((t) => t.t === 'assault' || t.t === 'engage')).map((s) => s.id);
      if (ids.length === 0) return;
      const target = enemyBuildingNear(w);
      if (target) w.orderAttack(ids, target.id);
      else {
        const foe = w.settlers.find((s) => s.owner === 2 && isFighter(s) && !w.dying.has(s.id));
        if (foe) w.orderMove(ids, Math.round(foe.x), Math.round(foe.y));
      }
    },
  },
};

/** Own fighters outdoors with no building of their own and none they are walking into. */
function freeFighters(w: World): Settler[] {
  return w.settlers.filter(
    (s) => s.owner === 1 && isFighter(s) && !w.dying.has(s.id) && s.inside === null && s.home === null && !s.tasks.some((t) => t.t === 'join'),
  );
}

/** Own fighters under direct orders (a post on the map). */
function fieldUnits(w: World): Settler[] {
  return freeFighters(w).filter((s) => !!s.post);
}

/** The rival's military building nearest the player's start that the player has seen. */
function enemyBuildingNear(w: World): Building | undefined {
  const home = w.homeOf(1);
  const d = (b: Building) => Math.hypot(b.door.x - home.x, b.door.y - home.y);
  return [...w.buildings.values()]
    .filter((b) => b.owner === 2 && BUILDINGS[b.type].garrison && w.isExplored(b.door.x, b.door.y, 1))
    .sort((a, b) => d(a) - d(b))[0];
}

/** An own building of the type within 6 tiles of the point, if any. */
function marketNear(w: World, type: BuildingType, at: Point | undefined): boolean {
  return !!at && [...w.buildings.values()].some((b) => b.owner === 1 && b.type === type && Math.hypot(b.door.x - at.x, b.door.y - at.y) < 8);
}

/** The player's markets: the one nearest home first, the one farthest from it second. */
function markets(w: World): Building[] {
  const home = w.homeOf(1);
  const d = (b: Building) => Math.hypot(b.door.x - home.x, b.door.y - home.y);
  return [...w.buildings.values()].filter((b) => b.owner === 1 && b.type === 'market').sort((a, b) => d(a) - d(b));
}

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
  /** Steps shown with fewer marks on the map than they name (an anchor that found nothing). */
  unmarked?: string[];
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
    // Every arrow and ring of a step the player sees is on the map.
    if (m.step && m.marks.length < (m.step.marker?.length ?? 0) + (m.step.ring ? 1 : 0)) {
      (run.unmarked ??= []).includes(m.step.id) || run.unmarked.push(m.step.id);
    }
    if (m.step) sol[m.step.id]?.(world, ui, m, runner);
  }
  return runner.finished === 'won';
}

