import type { Anchor, MissionDef } from './types';

/**
 * The tutorial missions (docs/TUTORIAL.md §2), in the recommended order. Pure data: maps by seed and
 * size, places by anchors, texts by dictionary keys (`tut.<mission>.<step>`, `.more`, `.hint`,
 * `tut.<mission>.goal.<n>`). Missions marked `soon` are listed in the menu but come in a later pass.
 * Seeds are chosen by `tests/tutorial.test.ts`: every anchor resolves and the mission can be won
 * within its time budget.
 */

const home: Anchor = { a: 'home' };
const grove: Anchor = { a: 'guarantee', grove: true };
const quarry: Anchor = { a: 'guarantee', quarry: 0 };

/** Mission 1: camera, goods on the ground, the build menu, digger and builders, wood and stone. */
const forest: MissionDef = {
  id: 'forest',
  title: 'tut.forest.title',
  summary: 'tut.forest.summary',
  debrief: 'tut.forest.debrief',
  world: { seed: 42, size: 64, players: 1, start: 'low', fog: false },
  unlock: { buildings: ['woodcutter', 'sawmill', 'stonecutter', 'forester'], menus: ['build', 'goods', 'stats'] },
  minutes: 10,
  objectives: [
    { text: 'tut.forest.goal.1', done: { k: 'building', type: 'woodcutter' }, params: { building: { building: 'woodcutter' } } },
    { text: 'tut.forest.goal.2', done: { k: 'building', type: 'sawmill' }, params: { building: { building: 'sawmill' } } },
    { text: 'tut.forest.goal.3', done: { k: 'building', type: 'stonecutter' }, params: { building: { building: 'stonecutter' } } },
    { text: 'tut.forest.goal.4', done: { k: 'building', type: 'forester' }, params: { building: { building: 'forester' } } },
    { text: 'tut.forest.goal.5', done: { k: 'produced', res: 'plank', min: 6 }, params: { n: { n: 6 } } },
  ],
  steps: [
    { id: 'welcome', text: 'tut.forest.welcome', more: 'tut.forest.welcome.more', camera: home, done: { k: 'ack' } },
    {
      id: 'look',
      text: 'tut.forest.look',
      more: 'tut.forest.look.more',
      hint: { text: 'tut.forest.look.hint', after: 40 },
      done: { k: 'ui', is: { u: 'cameraMoved', tiles: 8 } },
    },
    { id: 'zoom', text: 'tut.forest.zoom', more: 'tut.forest.zoom.more', done: { k: 'ui', is: { u: 'zoomChanged' } } },
    {
      id: 'piles',
      text: 'tut.forest.piles',
      more: 'tut.forest.piles.more',
      camera: home,
      marker: [{ a: 'pile', res: 'plank', near: home }],
      done: { k: 'ack' },
    },
    {
      id: 'woodcutter',
      text: 'tut.forest.woodcutter',
      more: 'tut.forest.woodcutter.more',
      params: { building: { building: 'woodcutter' } },
      hint: { text: 'tut.forest.woodcutter.hint', after: 60 },
      ui: ['menu.build', 'build.tab.resources', 'build.item.woodcutter'],
      camera: grove,
      marker: [{ a: 'spot', type: 'woodcutter', near: grove, prefer: 'forest' }],
      done: { k: 'building', type: 'woodcutter', state: 'any' },
    },
    {
      id: 'digging',
      text: 'tut.forest.digging',
      more: 'tut.forest.digging.more',
      params: { building: { building: 'woodcutter' }, digger: { prof: 'digger' }, builder: { prof: 'builder' } },
      hint: { text: 'tut.forest.digging.hint', after: 45 },
      ui: ['speed.2'],
      marker: [{ a: 'building', type: 'woodcutter', owner: 'me' }],
      done: { k: 'building', type: 'woodcutter' },
    },
    {
      id: 'sawmill',
      text: 'tut.forest.sawmill',
      more: 'tut.forest.sawmill.more',
      params: { building: { building: 'sawmill' } },
      ui: ['menu.build', 'build.tab.resources', 'build.item.sawmill'],
      marker: [{ a: 'spot', type: 'sawmill', near: home }],
      done: { k: 'building', type: 'sawmill', state: 'any' },
    },
    {
      id: 'stonecutter',
      text: 'tut.forest.stonecutter',
      more: 'tut.forest.stonecutter.more',
      params: { building: { building: 'stonecutter' } },
      ui: ['menu.build', 'build.tab.resources', 'build.item.stonecutter'],
      camera: quarry,
      marker: [{ a: 'spot', type: 'stonecutter', near: quarry, prefer: 'stone' }],
      done: { k: 'building', type: 'stonecutter', state: 'any' },
    },
    {
      id: 'forester',
      text: 'tut.forest.forester',
      more: 'tut.forest.forester.more',
      params: { building: { building: 'forester' } },
      ui: ['menu.build', 'build.tab.resources', 'build.item.forester'],
      camera: grove,
      marker: [{ a: 'spot', type: 'forester', near: grove, prefer: 'meadow' }],
      done: { k: 'building', type: 'forester', state: 'any' },
    },
    {
      id: 'planks',
      text: 'tut.forest.planks',
      more: 'tut.forest.planks.more',
      params: { n: { n: 6 } },
      hint: { text: 'tut.forest.planks.hint', after: 90 },
      ui: ['speed.4'],
      marker: [{ a: 'building', type: 'sawmill', owner: 'me' }],
      done: { k: 'all', of: [
        { k: 'building', type: 'woodcutter' },
        { k: 'building', type: 'sawmill' },
        { k: 'building', type: 'stonecutter' },
        { k: 'building', type: 'forester' },
        { k: 'produced', res: 'plank', min: 6 },
      ] },
    },
  ],
};

/** Mission 2: the warehouse and what it takes in, the building window, beds and strike, priorities, stop, transport, reserve. */
const logistics: MissionDef = {
  id: 'logistics',
  title: 'tut.logistics.title',
  summary: 'tut.logistics.summary',
  debrief: 'tut.logistics.debrief',
  world: { seed: 42, size: 64, players: 1, start: 'low', fog: true },
  scenario: [
    {
      player: 1,
      buildings: [
        { type: 'woodcutter', near: { dx: 6, dy: -6 }, worker: true },
        { type: 'woodcutter', near: { dx: 10, dy: 1 }, worker: true },
        { type: 'sawmill', near: { dx: 4, dy: 3 }, tag: 'sawmill', worker: true },
        { type: 'stonecutter', near: { dx: -5, dy: 1 }, worker: true },
      ],
      piles: [['log', 6]],
      people: { carrier: 4 },
      beds: 14,
    },
  ],
  unlock: { buildings: ['warehouse', 'house_small', 'house_medium'], menus: ['settlers'] },
  minutes: 12,
  objectives: [
    { text: 'tut.logistics.goal.1', done: { k: 'setting', is: { s: 'accepts', res: ['plank', 'stone'] } } },
    { text: 'tut.logistics.goal.2', done: { k: 'building', type: 'house_small' }, params: { building: { building: 'house_small' } } },
    {
      text: 'tut.logistics.goal.3',
      done: { k: 'all', of: [{ k: 'building', type: 'house_small' }, { k: 'units', kind: 'striker', max: 0 }] },
    },
    { text: 'tut.logistics.goal.4', done: { k: 'stockAt', type: 'warehouse', res: 'plank', min: 16 }, params: { n: { n: 16 } } },
  ],
  steps: [
    {
      id: 'warehouse',
      text: 'tut.logistics.warehouse',
      more: 'tut.logistics.warehouse.more',
      params: { building: { building: 'warehouse' } },
      hint: { text: 'tut.logistics.warehouse.hint', after: 90 },
      ui: ['menu.build', 'build.tab.housing', 'build.item.warehouse'],
      camera: home,
      marker: [{ a: 'spot', type: 'warehouse', near: home }],
      done: { k: 'building', type: 'warehouse', state: 'any' },
    },
    {
      id: 'wait',
      text: 'tut.logistics.wait',
      more: 'tut.logistics.wait.more',
      params: { building: { building: 'warehouse' } },
      ui: ['speed.2'],
      marker: [{ a: 'building', type: 'warehouse', owner: 'me' }],
      done: { k: 'building', type: 'warehouse' },
    },
    {
      id: 'select',
      text: 'tut.logistics.select',
      more: 'tut.logistics.select.more',
      params: { building: { building: 'warehouse' } },
      marker: [{ a: 'building', type: 'warehouse', owner: 'me' }],
      done: { k: 'ui', is: { u: 'selected', type: 'warehouse' } },
    },
    {
      id: 'accept',
      text: 'tut.logistics.accept',
      more: 'tut.logistics.accept.more',
      params: { accepts: { label: 'eco.accepts' }, refuses: { label: 'eco.refuses' } },
      hint: { text: 'tut.logistics.accept.hint', after: 40 },
      ui: ['accept.plank', 'accept.stone'],
      marker: [{ a: 'building', type: 'warehouse', owner: 'me' }],
      done: { k: 'setting', is: { s: 'accepts', res: ['plank', 'stone'] } },
    },
    {
      id: 'carry',
      text: 'tut.logistics.carry',
      more: 'tut.logistics.carry.more',
      params: { n: { n: 8 } },
      camera: home,
      done: { k: 'stockAt', type: 'warehouse', res: 'plank', min: 8 },
    },
    {
      id: 'strike',
      text: 'tut.logistics.strike',
      more: 'tut.logistics.strike.more',
      params: { menu: { label: 'hud.menu.settlers' } },
      ui: ['menu.settlers', 'settlers.beds'],
      done: { k: 'ack' },
    },
    {
      id: 'house',
      text: 'tut.logistics.house',
      more: 'tut.logistics.house.more',
      params: { building: { building: 'house_small' } },
      hint: { text: 'tut.logistics.house.hint', after: 120 },
      ui: ['menu.build', 'build.tab.housing', 'build.item.house_small'],
      marker: [{ a: 'spot', type: 'house_small', near: home }],
      done: { k: 'building', type: 'house_small' },
    },
    {
      id: 'priority',
      text: 'tut.logistics.priority',
      more: 'tut.logistics.priority.more',
      params: { button: { label: 'info.priorityBtn' } },
      hint: { text: 'tut.logistics.priority.hint', after: 60 },
      ui: ['info.priority'],
      done: { k: 'setting', is: { s: 'priority', site: true } },
    },
    {
      id: 'stop',
      text: 'tut.logistics.stop',
      more: 'tut.logistics.stop.more',
      params: { button: { label: 'info.stop' } },
      ui: ['info.stop'],
      camera: { a: 'building', type: 'sawmill', owner: 'scenario', tag: 'sawmill' },
      marker: [{ a: 'building', type: 'sawmill', owner: 'scenario', tag: 'sawmill' }],
      done: { k: 'setting', is: { s: 'stopped', type: 'sawmill', on: true } },
    },
    {
      id: 'restart',
      text: 'tut.logistics.restart',
      more: 'tut.logistics.restart.more',
      ui: ['info.stop'],
      marker: [{ a: 'building', type: 'sawmill', owner: 'scenario', tag: 'sawmill' }],
      done: { k: 'setting', is: { s: 'stopped', type: 'sawmill', on: false } },
    },
    {
      id: 'transport',
      text: 'tut.logistics.transport',
      more: 'tut.logistics.transport.more',
      params: { menu: { label: 'hud.menu.goods' }, tab: { label: 'goods.transport' } },
      ui: ['menu.goods', 'goods.transport', 'transport.stone.top'],
      done: { k: 'setting', is: { s: 'transportTop', res: 'stone' } },
    },
    {
      id: 'reserve',
      text: 'tut.logistics.reserve',
      more: 'tut.logistics.reserve.more',
      params: { menu: { label: 'hud.menu.settlers' }, label: { label: 'eco.reserve' } },
      ui: ['menu.settlers', 'settlers.reserve'],
      done: { k: 'ack' },
    },
    {
      id: 'planks',
      text: 'tut.logistics.planks',
      more: 'tut.logistics.planks.more',
      params: { n: { n: 16 } },
      hint: { text: 'tut.logistics.planks.hint', after: 120 },
      ui: ['speed.4'],
      done: { k: 'stockAt', type: 'warehouse', res: 'plank', min: 16 },
    },
  ],
};

/** A mission of a later pass: listed in the menu as coming, what it opens already set (docs/TUTORIAL.md §2.5–2.8). */
function later(id: MissionDef['id'], unlock: MissionDef['unlock'], minutes: number): MissionDef {
  return {
    id,
    title: `tut.${id}.title`,
    summary: `tut.${id}.summary`,
    debrief: `tut.${id}.summary`,
    world: { seed: 1, size: 64, players: 1, start: 'medium', fog: true },
    unlock,
    minutes,
    objectives: [],
    steps: [],
    soon: true,
  };
}

export const MISSIONS: readonly MissionDef[] = [
  forest,
  logistics,
  later('bread', { buildings: ['waterworks', 'farm', 'mill', 'bakery', 'fisher', 'hunter', 'pigfarm', 'slaughterhouse'] }, 14),
  later('metal', { buildings: ['coalmine', 'ironmine', 'ironsmelter', 'toolsmith'], commands: ['geologist'] }, 14),
  later('trade', { buildings: ['market', 'donkeyranch'], commands: ['pioneer', 'thief'] }, 15),
  later('battle', { buildings: ['tower', 'bigtower', 'barracks', 'lookout', 'infirmary'], menus: ['army'] }, 15),
];

export const missionById = (id: string | null): MissionDef | undefined => MISSIONS.find((m) => m.id === id);
