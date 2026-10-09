import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../src/sim/config';
import { available } from '../src/sim/buildings';
import type { Point } from '../src/sim/types';
import { startPositions, World } from '../src/sim/world';
import { ANCHORS, anchorResolver, isLive } from '../src/tutorial/anchors';
import { check, CONDITION_KINDS, SETTING_KINDS, snapshot, UI_CHECK_KINDS } from '../src/tutorial/conditions';
import { locksFor } from '../src/tutorial/locks';
import { MISSIONS } from '../src/tutorial/missions';
import { markDone, MARKS_KEY, readMarks } from '../src/tutorial/progress';
import { TutorialRunner, waitsForAck } from '../src/tutorial/runner';
import type { Anchor, Condition, MissionDef, Probe, UiProbe } from '../src/tutorial/types';
import { buildingOpen, commandOpen, menuOpen, tabOpen } from '../src/ui/locks';
import { SaveSlots, type KeyValue } from '../src/ui/saves';
import { launchOf } from '../src/ui/setup';
import { placeFinished } from '../src/sim/scenario';
import { depot } from './helpers';

/** The player's start tower's door. */
const home0 = (w: World): Point => w.homeOf(1);

const ui = (): UiProbe => ({ menu: 'build', selected: null, selectedUnits: 0, groups: [], camera: { x: 32, y: 32 }, zoom: 1, placing: null, speed: 1, paused: false, jumps: 0 });

function probe(w: World, over: Partial<Probe> = {}): Probe {
  const s = snapshot(w, 1);
  return { world: w, player: 1, ui: ui(), anchor: anchorResolver(w, 1, {}), start: s, step: s, stepUi: { camera: { x: 32, y: 32 }, zoom: 1, jumps: 0 }, acked: false, ...over };
}

const store = (): KeyValue & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};

/** A mission made up for the tests (no texts are shown, so any keys do). */
function testMission(steps: Condition[], extra: Partial<MissionDef> = {}): MissionDef {
  return {
    id: 'forest',
    title: 'tut.forest.title',
    summary: 'tut.forest.summary',
    debrief: 'tut.forest.debrief',
    world: { seed: 1, size: 64, players: 1, start: 'low', fog: true },
    unlock: {},
    minutes: 1,
    objectives: [],
    steps: steps.map((done, k) => ({ id: `s${k}`, text: 'tut.forest.welcome', done })),
    ...extra,
  };
}

describe('conditions', () => {
  /**
   * One world in which each example holds ("yes") and one in which it does not ("no"): every kind
   * of condition, setting and interface check has an entry, so a new kind without a test fails.
   */
  it('every kind has a table entry and an example that holds and one that does not', () => {
    const w = new World(42, { size: 64, start: 'low' });
    w.step(); // sight is worked out in the first tick
    const store = depot(w);
    w.setAccepts(store.id, 'stone', false);
    // A fed mine (10 attempts: its favourite food) and a geologist's finds on the guaranteed coal.
    const coal = anchorResolver(w, 1, {})({ a: 'guarantee', mountain: 0, lobe: 0 })!;
    const mine = placeFinished(w, 'coalmine', 1, Math.round(coal.x), Math.round(coal.y))!;
    mine.attempts = 10;
    const ci = w.map.idx(Math.round(coal.x), Math.round(coal.y));
    w.map.prospected[ci] |= 1;
    // A market donkeys have brought 5 stone to.
    const market = placeFinished(w, 'market', 1, home0(w).x + 4, home0(w).y + 4)!;
    market.received = { stone: 5 };
    const yes = probe(w, { acked: true, ui: { ...ui(), camera: { x: 45, y: 32 }, zoom: 1.5, menu: 'goods', selected: store.id, selectedUnits: 3, groups: [0, 2], placing: 'sawmill', speed: 2, jumps: 1 } });
    const no = probe(w);
    const home = w.homeOf(1);
    const examples: Record<string, [Condition, Probe][]> = {
      ack: [[{ k: 'ack' }, yes]],
      after: [[{ k: 'after', s: 0 }, yes]],
      building: [[{ k: 'building', type: 'warehouse' }, yes]],
      stock: [[{ k: 'stock', res: 'plank', min: 1 }, yes]],
      stockAt: [[{ k: 'stockAt', type: 'warehouse', res: 'plank', min: 0 }, yes]],
      produced: [[{ k: 'produced', res: 'plank', min: 0 }, yes]],
      units: [[{ k: 'units', kind: 'fighter', min: 1 }, yes]],
      garrison: [[{ k: 'garrison', type: 'tower', min: 1 }, yes]],
      attempts: [[{ k: 'attempts', type: 'coalmine', min: 1 }, yes]],
      setting: [[{ k: 'setting', is: { s: 'accepts', res: ['plank'] } }, yes]],
      ui: [[{ k: 'ui', is: { u: 'zoomChanged' } }, yes]],
      explored: [[{ k: 'explored', at: { a: 'home' } }, yes]],
      prospected: [
        [{ k: 'prospected', at: { a: 'home' }, r: 2, min: 0 }, yes],
        [{ k: 'prospected', at: { a: 'guarantee', mountain: 0, lobe: 0 }, r: 1, min: 1, ore: 'coal' }, yes],
      ],
      claimed: [[{ k: 'claimed', min: 0 }, yes]],
      received: [
        [{ k: 'received', res: 'stone', min: 5 }, yes],
        [{ k: 'received', res: 'stone', min: 5, near: { a: 'home' }, r: 12 }, yes],
      ],
      captured: [[{ k: 'captured', min: 0 }, yes]],
      outcome: [[{ k: 'outcome', is: 'playing' as 'won' }, yes]],
      all: [[{ k: 'all', of: [{ k: 'ack' }, { k: 'after', s: 0 }] }, yes]],
      any: [[{ k: 'any', of: [{ k: 'ack' }, { k: 'claimed', min: 99 }] }, yes]],
    };
    const counter: Record<string, Condition> = {
      ack: { k: 'ack' },
      after: { k: 'after', s: 5 },
      building: { k: 'building', type: 'sawmill' },
      stock: { k: 'stock', res: 'plank', min: 1, relative: true },
      stockAt: { k: 'stockAt', type: 'warehouse', res: 'plank', min: 1 },
      produced: { k: 'produced', res: 'plank', min: 1 },
      units: { k: 'units', kind: 'fighter', max: 0 },
      garrison: { k: 'garrison', type: 'tower', min: 9 },
      attempts: { k: 'attempts', type: 'coalmine', min: 11 },
      setting: { k: 'setting', is: { s: 'accepts', res: ['plank', 'stone'] } },
      ui: { k: 'ui', is: { u: 'zoomChanged' } },
      explored: { k: 'explored', at: { a: 'offset', from: { a: 'home' }, dx: -40, dy: -40 } },
      prospected: { k: 'prospected', at: { a: 'home' }, r: 2, min: 1 },
      claimed: { k: 'claimed', min: 1 },
      received: { k: 'received', res: 'stone', min: 6 },
      captured: { k: 'captured', min: 1 },
      outcome: { k: 'outcome', is: 'won' },
      all: { k: 'all', of: [{ k: 'ack' }, { k: 'claimed', min: 99 }] },
      any: { k: 'any', of: [{ k: 'ack' }, { k: 'claimed', min: 99 }] },
    };
    expect(Object.keys(examples).sort()).toEqual([...CONDITION_KINDS].sort());
    for (const kind of CONDITION_KINDS) {
      for (const [c, p] of examples[kind]) expect(check(c, p), `${kind} yes`).toBe(true);
      expect(check(counter[kind], no), `${kind} no`).toBe(false);
    }
    // Only markets near the point count.
    expect(check({ k: 'received', res: 'stone', min: 1, near: { a: 'offset', from: { a: 'home' }, dx: -20, dy: -20 }, r: 5 }, yes)).toBe(false);
    // Only tiles found holding that ore count.
    expect(check({ k: 'prospected', at: { a: 'guarantee', mountain: 0, lobe: 0 }, r: 1, min: 1, ore: 'goldore' }, yes)).toBe(false);
    expect(home).toBeTruthy();
  });

  it('every setting and interface check has a table entry, a yes and a no', () => {
    const w = new World(42, { size: 64, start: 'low' });
    const store = depot(w, 1, undefined, ['plank']);
    const sawmill = [...w.buildings.values()].find((b) => b.type === 'tower')!;
    const no = probe(w);
    const settings: Record<string, [Condition, Condition, () => void]> = {
      accepts: [{ k: 'setting', is: { s: 'accepts', res: ['plank'] } }, { k: 'setting', is: { s: 'accepts', res: ['coal'] } }, () => {}],
      priority: [{ k: 'setting', is: { s: 'priority' } }, { k: 'setting', is: { s: 'priority', site: true } }, () => w.setPriority(store.id, true)],
      stopped: [{ k: 'setting', is: { s: 'stopped', type: 'warehouse', on: true } }, { k: 'setting', is: { s: 'stopped', type: 'tower', on: true } }, () => w.setStopped(store.id, true)],
      transportTop: [{ k: 'setting', is: { s: 'transportTop', res: 'coal' } }, { k: 'setting', is: { s: 'transportTop', res: 'gold' } }, () => w.moveTransport('coal', 'top')],
      reserve: [{ k: 'setting', is: { s: 'reserve' } }, { k: 'setting', is: { s: 'reserve' } }, () => {}],
      workAt: [{ k: 'setting', is: { s: 'workAt', type: 'woodcutter' } }, { k: 'setting', is: { s: 'workAt', type: 'woodcutter' } }, () => {}],
      toolOrder: [{ k: 'setting', is: { s: 'toolOrder', res: 'axe', min: 2 } }, { k: 'setting', is: { s: 'toolOrder', res: 'saw', min: 1 } }, () => w.orderTool('axe', 2)],
      distribution: [{ k: 'setting', is: { s: 'distribution', res: 'bread' } }, { k: 'setting', is: { s: 'distribution', res: 'fish' } }, () => w.setDistribution('bread', 'coalmine', 50)],
      tradeRoute: [{ k: 'setting', is: { s: 'tradeRoute', res: 'plank' } }, { k: 'setting', is: { s: 'tradeRoute', res: 'plank' } }, () => {}],
      recruitOrder: [
        { k: 'setting', is: { s: 'recruitOrder', kind: 'soldier', level: 2, min: 2 } },
        { k: 'setting', is: { s: 'recruitOrder', kind: 'soldier', level: 1, min: 1 } },
        () => w.orderRecruits('soldier', 1, 2),
      ],
    };
    expect(Object.keys(settings).sort()).toEqual([...SETTING_KINDS].sort());
    // «No» before the player did anything.
    for (const kind of SETTING_KINDS) expect(check(settings[kind][1], no), `${kind} no`).toBe(false);
    for (const kind of SETTING_KINDS) settings[kind][2]();
    w.setCarrierReserve(9);
    const yes = probe(w);
    for (const kind of ['accepts', 'priority', 'stopped', 'transportTop', 'reserve', 'toolOrder', 'distribution', 'recruitOrder']) {
      expect(check(settings[kind][0], yes), `${kind} yes`).toBe(true);
    }
    // A moved work area and a trade route need buildings of their own.
    const hut = w.placeBuilding('woodcutter', sawmill.x + 5, sawmill.y + 4) ?? w.placeBuilding('woodcutter', sawmill.x - 5, sawmill.y + 4);
    expect(hut).toBeTruthy();
    hut!.done = true;
    w.setWorkArea(hut!.id, { x: hut!.door.x + 1, y: hut!.door.y });
    expect(check(settings.workAt[0], probe(w))).toBe(true);
    // A route with planks from a market near home; «off» holds where no market there orders the good.
    const here = placeFinished(w, 'market', 1, sawmill.x + 3, sawmill.y - 4)!;
    const there = placeFinished(w, 'market', 1, sawmill.x - 4, sawmill.y + 3)!;
    const hc = anchorResolver(w, 1, {})({ a: 'home' })!;
    const nearHere: Anchor = { a: 'offset', from: { a: 'home' }, dx: here.door.x - hc.x, dy: here.door.y - hc.y };
    const off: Condition = { k: 'setting', is: { s: 'tradeRoute', res: 'plank', near: nearHere, r: 1, off: true } };
    expect(check(off, probe(w))).toBe(true);
    w.setTradeRoute(here.id, there.id);
    w.orderTrade(here.id, 'plank', 3);
    expect(check(settings.tradeRoute[0], probe(w))).toBe(true);
    expect(check({ k: 'setting', is: { s: 'tradeRoute', res: 'plank', near: nearHere, r: 1 } }, probe(w))).toBe(true);
    expect(check(off, probe(w))).toBe(false);
    expect(check({ k: 'setting', is: { s: 'tradeRoute', res: 'stone' } }, probe(w))).toBe(false);

    const uiChecks: Record<string, [Condition, Partial<UiProbe>]> = {
      cameraMoved: [{ k: 'ui', is: { u: 'cameraMoved', tiles: 8 } }, { camera: { x: 45, y: 32 } }],
      zoomChanged: [{ k: 'ui', is: { u: 'zoomChanged' } }, { zoom: 1.4 }],
      menuOpen: [{ k: 'ui', is: { u: 'menuOpen', menu: 'goods' } }, { menu: 'goods' }],
      selected: [{ k: 'ui', is: { u: 'selected', type: 'warehouse' } }, { selected: store.id }],
      placing: [{ k: 'ui', is: { u: 'placing', what: 'sawmill' } }, { placing: 'sawmill' }],
      selectedUnits: [{ k: 'ui', is: { u: 'selectedUnits', min: 2 } }, { selectedUnits: 2 }],
      group: [{ k: 'ui', is: { u: 'group', n: 1 } }, { groups: [0, 3] }],
      jumpedToMessage: [{ k: 'ui', is: { u: 'jumpedToMessage' } }, { jumps: 1 }],
      speed: [{ k: 'ui', is: { u: 'speed', min: 2 } }, { speed: 2 }],
    };
    expect(Object.keys(uiChecks).sort()).toEqual([...UI_CHECK_KINDS].sort());
    for (const kind of UI_CHECK_KINDS) {
      const [c, set] = uiChecks[kind];
      expect(check(c, probe(w)), `${kind} no`).toBe(false);
      expect(check(c, probe(w, { ui: { ...ui(), ...set } })), `${kind} yes`).toBe(true);
    }
  });
});

describe('anchors', () => {
  const fixed: Anchor[] = [
    { a: 'home' },
    { a: 'guarantee', mountain: 0 },
    { a: 'guarantee', mountain: 0, lobe: 1 },
    { a: 'guarantee', mountain: 1, lobe: 2 },
    { a: 'guarantee', grove: true },
    { a: 'guarantee', pond: true },
    { a: 'nearest', terrain: 'water', from: { a: 'home' } },
    { a: 'nearest', terrain: 'meadow', from: { a: 'home' } },
    { a: 'nearest', terrain: 'forest', from: { a: 'home' } },
    { a: 'nearest', terrain: 'border', from: { a: 'guarantee', mountain: 1 } },
    { a: 'spot', type: 'woodcutter', near: { a: 'guarantee', grove: true }, prefer: 'forest' },
    { a: 'spot', type: 'sawmill', near: { a: 'home' } },
    { a: 'spot', type: 'house_small', near: { a: 'home' }, prefer: 'meadow' },
    { a: 'spot', type: 'coalmine', near: { a: 'guarantee', mountain: 0, lobe: 0 }, prefer: 'ore', within: 4 },
    { a: 'between', from: { a: 'home' }, to: { a: 'guarantee', pond: true }, t: 0.5 },
    { a: 'offset', from: { a: 'home' }, dx: 3, dy: -2 },
  ];

  it('the start anchors resolve on several maps, and a spot is a place the building fits', () => {
    for (const seed of [1, 2, 3, 7, 42, 99]) {
      const w = new World(seed, { size: 64, start: 'low' });
      const resolve = anchorResolver(w, 1, {});
      for (const a of fixed) expect(resolve(a), `seed ${seed} ${JSON.stringify(a)}`).not.toBeNull();
      for (const a of fixed.filter((x) => x.a === 'spot')) {
        const p = resolve(a)!;
        const def = BUILDINGS[a.a === 'spot' ? a.type : 'sawmill'];
        expect(w.canPlace(a.a === 'spot' ? a.type : 'sawmill', p.x - (def.w - 1) / 2, p.y - (def.h - 1) / 2)).toBe(true);
      }
      const water = resolve({ a: 'nearest', terrain: 'water', from: { a: 'home' } })!;
      expect(w.map.isWalkable(water.x, water.y)).toBe(false);
      // Open land a pioneer can claim: nobody's, beside the player's own.
      const border = resolve({ a: 'nearest', terrain: 'border', from: { a: 'guarantee', mountain: 1 } })!;
      expect(w.map.owner[w.map.idx(border.x, border.y)]).toBe(0);
      expect([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => w.owns(border.x + dx, border.y + dy, 1))).toBe(true);
    }
  });

  it('every kind has a resolver; fixed ones are cached and kept, buildings and piles followed', () => {
    expect(Object.keys(ANCHORS).sort()).toEqual(['between', 'building', 'enemyHome', 'guarantee', 'home', 'nearest', 'offset', 'pile', 'spot'].sort());
    const w = new World(5, { size: 64, players: 2, start: 'low' });
    const cache: Record<string, Point | null> = {};
    const resolve = anchorResolver(w, 1, cache);
    expect(resolve({ a: 'enemyHome' })).toEqual(startPositions(64, 2)[1]);
    resolve({ a: 'home' });
    expect(Object.keys(cache).length).toBe(2);
    const wh: Anchor = { a: 'building', type: 'warehouse', owner: 'me' };
    expect(isLive(wh)).toBe(true);
    expect(resolve(wh)).toBeNull();
    depot(w);
    expect(resolve(wh)).not.toBeNull();
    expect(resolve({ a: 'pile', res: 'plank', near: { a: 'home' } })).not.toBeNull();
    // The own building nearest a point, rather than the newest.
    const second = placeFinished(w, 'warehouse', 1, w.homeOf(1).x + 6, w.homeOf(1).y - 6)!;
    const first = [...w.buildings.values()].find((b) => b.type === 'warehouse' && b.id !== second.id)!;
    const at = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + (b.w - 1) / 2, y: b.y + (b.h - 1) / 2 });
    expect(resolve(wh)).toEqual(at(second));
    const hc = resolve({ a: 'home' })!;
    const nearFirst: Anchor = { a: 'offset', from: { a: 'home' }, dx: first.door.x - hc.x, dy: first.door.y - hc.y };
    expect(resolve({ ...wh, near: nearFirst } as Anchor)).toEqual(at(first));
    // An enemy's building exists for the anchor only once its door is explored (the fog rule).
    expect(resolve({ a: 'building', type: 'tower', owner: 'enemy' })).toBeNull();
  });
});

describe('locks', () => {
  it('a mission opens its own buildings and inherits what earlier missions opened', () => {
    const [forest, logistics, bread] = MISSIONS;
    const l1 = locksFor(forest, 0);
    expect(buildingOpen(l1, 'woodcutter')).toBe(true);
    expect(buildingOpen(l1, 'warehouse')).toBe(false);
    expect(tabOpen(l1, 'resources')).toBe(true);
    expect(tabOpen(l1, 'housing')).toBe(false);
    expect(menuOpen(l1, 'settlers')).toBe(false);
    expect(menuOpen(l1, 'options')).toBe(true);
    const l2 = locksFor(logistics, 0);
    expect(buildingOpen(l2, 'woodcutter')).toBe(true);
    expect(buildingOpen(l2, 'warehouse')).toBe(true);
    expect(buildingOpen(l2, 'house_large')).toBe(false);
    expect(menuOpen(l2, 'settlers')).toBe(true);
    expect(menuOpen(l2, 'army')).toBe(false);
    expect(commandOpen(l2, 'geologist')).toBe(false);
    const l3 = locksFor(bread, 0);
    expect(buildingOpen(l3, 'farm') && buildingOpen(l3, 'warehouse')).toBe(true);
    // No locks: a normal game.
    expect(buildingOpen(null, 'castle' as 'tower') && tabOpen(null, 'military') && menuOpen(null, 'army')).toBe(true);
  });

  it('a step opens more from itself on', () => {
    const def = testMission([{ k: 'ack' }, { k: 'ack' }]);
    def.steps[1].unlock = { buildings: ['barracks'] };
    expect(buildingOpen(locksFor(def, 0), 'barracks')).toBe(false);
    expect(buildingOpen(locksFor(def, 1), 'barracks')).toBe(true);
  });
});

describe('the step automaton', () => {
  it('passes steps already done at once, but never one waiting for «Next»', () => {
    const w = new World(1, { size: 64, start: 'low' });
    const def = testMission([{ k: 'after', s: 0 }, { k: 'stock', res: 'plank', min: 1 }, { k: 'ack' }, { k: 'after', s: 0 }]);
    const r = TutorialRunner.start(def, w, ui());
    r.update(w, ui());
    expect(r.stepIndex).toBe(2);
    expect(r.model(w).waitsAck).toBe(true);
    r.update(w, ui());
    expect(r.stepIndex).toBe(2);
    expect(r.ack()).toBe(true);
    expect(r.ack()).toBe(false);
    r.update(w, ui());
    expect(r.finished).toBe('won');
    expect(waitsForAck({ k: 'all', of: [{ k: 'after', s: 1 }, { k: 'ack' }] })).toBe(true);
  });

  it('wins only once every goal is met, latching goals; shows the hint after its time', () => {
    const w = new World(1, { size: 64, start: 'low' });
    const def = testMission([{ k: 'after', s: 1 }], { objectives: [{ text: 'tut.forest.goal.1', done: { k: 'after', s: 3 } }] });
    def.steps[0].hint = { text: 'tut.forest.look.hint', after: 2 };
    const r = TutorialRunner.start(def, w, ui());
    for (let i = 0; i < 15; i++) w.step();
    r.update(w, ui());
    expect(r.stepIndex).toBe(1);
    expect(r.finished).toBeNull();
    for (let i = 0; i < 20; i++) w.step();
    r.update(w, ui());
    // Every step is passed, but the goal is not met yet.
    expect(r.finished).toBeNull();
    for (let i = 0; i < 20; i++) w.step();
    r.update(w, ui());
    expect(r.finished).toBe('won');
    expect(r.model(w).goals[0].done).toBe(true);

    const def2 = testMission([{ k: 'ack' }]);
    def2.steps[0].hint = { text: 'tut.forest.look.hint', after: 2 };
    const r2 = TutorialRunner.start(def2, w, ui());
    r2.update(w, ui());
    expect(r2.model(w).hint).toBe(false);
    for (let i = 0; i < 25; i++) w.step();
    r2.update(w, ui());
    expect(r2.model(w).hint).toBe(true);
  });

  it('a step grants its goods on entry and the mission tops goods up (commands, as a player would)', () => {
    const w = new World(1, { size: 64, start: 'low' });
    const before = available(w, 1, 'coal');
    const def = testMission([{ k: 'ack' }, { k: 'ack' }], { refill: [{ res: 'bread', below: 4, to: 6 }] });
    def.steps[1].grant = [{ res: 'coal', n: 5 }];
    const r = TutorialRunner.start(def, w, ui());
    r.update(w, ui());
    expect(available(w, 1, 'bread')).toBe(6);
    expect(available(w, 1, 'coal')).toBe(before);
    r.ack();
    r.update(w, ui());
    expect(available(w, 1, 'coal')).toBe(before + 5);
    // Starting at a later step grants what the steps before it would have.
    const w2 = new World(1, { size: 64, start: 'low' });
    const def2 = testMission([{ k: 'ack' }, { k: 'ack' }, { k: 'ack' }]);
    def2.steps[1].grant = [{ res: 'coal', n: 3 }];
    const r3 = TutorialRunner.start(def2, w2, ui(), { from: 2 });
    expect(r3.stepIndex).toBe(2);
    expect(available(w2, 1, 'coal')).toBe(before + 3);
  });

  it('the camera goes to a step’s place on entry, and «Show» finds it again', () => {
    const w = new World(1, { size: 64, start: 'low' });
    const def = testMission([{ k: 'ack' }]);
    def.steps[0].camera = { a: 'guarantee', pond: true };
    const r = TutorialRunner.start(def, w, ui());
    const cam = r.takeCamera();
    expect(cam).not.toBeNull();
    expect(r.takeCamera()).toBeNull();
    expect(r.show(w)).toEqual(cam);
  });
});

describe('scenario and grant', () => {
  it('a world without a scenario is the same as before; grant lays goods by the home', () => {
    const a = new World(9, { size: 64 });
    const b = new World(9, { size: 64, scenario: [] });
    for (let i = 0; i < 300; i++) {
      a.step();
      b.step();
    }
    expect(JSON.stringify(a.settlers.map((s) => [s.x, s.y]))).toBe(JSON.stringify(b.settlers.map((s) => [s.x, s.y])));
    const n = available(a, 1, 'gold');
    expect(a.grant('gold', 4)).toBe(true);
    expect(available(a, 1, 'gold')).toBe(n + 4);
    expect(a.grant('gold', 0)).toBe(false);
  });
});

describe('progress and launch', () => {
  it('completion marks survive in storage, broken storage is no error', () => {
    const s = store();
    expect(readMarks(s).done).toEqual({});
    markDone('forest', 9.5, 1000, s);
    markDone('forest', 12, 2000, s);
    expect(readMarks(s).done.forest).toEqual({ at: 2000, minutes: 9.5 });
    s.map.set(MARKS_KEY, '{not json');
    expect(readMarks(s).done).toEqual({});
    const broken: KeyValue = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); }, removeItem: () => {} };
    expect(markDone('logistics', 3, 0, broken).done.logistics).toBeTruthy();
    expect(readMarks(null).done).toEqual({});
  });

  it('a save slot keeps the mission progress in its description', async () => {
    const w = new World(1, { size: 64, start: 'low' });
    const def = MISSIONS[0];
    const r = TutorialRunner.start(def, w, ui());
    const slots = new SaveSlots(store());
    const { saveWorld } = await import('../src/sim/save');
    const meta = await slots.write(saveWorld(w), 'x', 1, undefined, { mission: r.serialize() });
    expect(slots.meta(meta!.id)?.mission?.id).toBe('forest');
    const plain = await slots.write(saveWorld(w), 'y', 2);
    expect(slots.meta(plain!.id)?.mission).toBeUndefined();
  });

  it('?tutorial=<id>&step=<n> starts a mission', () => {
    expect(launchOf(new URLSearchParams('tutorial=logistics&step=4'))).toEqual({ kind: 'tutorial', id: 'logistics', step: 4 });
    expect(launchOf(new URLSearchParams('tutorial=forest'))).toEqual({ kind: 'tutorial', id: 'forest', step: 1 });
  });
});
