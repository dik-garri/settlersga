import type { ScenarioBuilding } from '../sim/scenario';
import type { Anchor, MissionDef } from './types';

/**
 * The tutorial missions (docs/TUTORIAL.md §2), in the recommended order. Pure data: maps by seed and
 * size, places by anchors, texts by dictionary keys (`tut.<mission>.<step>`, `.more`, `.hint`,
 * `tut.<mission>.goal.<n>`). A mission marked `soon` would be listed in the menu but not playable (none is now).
 * Seeds are chosen by `tests/tutorial.test.ts`: every anchor resolves and the mission can be won
 * within its time budget.
 */

const home: Anchor = { a: 'home' };
const grove: Anchor = { a: 'guarantee', grove: true };
const quarry: Anchor = { a: 'guarantee', quarry: 0 };
const pond: Anchor = { a: 'guarantee', pond: true };
const mountain: Anchor = { a: 'guarantee', mountain: 0 };
const coalLobe: Anchor = { a: 'guarantee', mountain: 0, lobe: 0 };
const ironLobe: Anchor = { a: 'guarantee', mountain: 0, lobe: 1 };
/** A level meadow for the farm, on the land of mission 3's second tower (south-west of the start). */
const farmSpot: Anchor = { a: 'spot', type: 'farm', near: { a: 'offset', from: home, dx: -8, dy: 8 }, prefer: 'meadow', within: 8 };

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
      // The site is enough (the goals wait for the house itself): a lit button would ask for more.
      done: { k: 'building', type: 'house_small', state: 'any' },
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

/**
 * The economy missions 1–2 built (missions 3 and 4 start with it): wood, stone and a warehouse. It
 * takes in food and the mines' goods only: 8 piles hold little, and planks, stone and tools would fill it.
 */
const woodAndStone: ScenarioBuilding[] = [
  { type: 'woodcutter', near: { dx: 6, dy: -6 }, worker: true },
  { type: 'woodcutter', near: { dx: 10, dy: 1 }, worker: true },
  { type: 'sawmill', near: { dx: 4, dy: 3 }, worker: true },
  { type: 'stonecutter', near: { dx: -5, dy: 1 }, worker: true },
  { type: 'forester', near: { dx: 9, dy: -2 }, worker: true },
  { type: 'warehouse', near: { dx: 3, dy: -3 }, tag: 'warehouse', accepts: ['bread', 'fish', 'meat', 'coal', 'ironore', 'iron'] },
];

const coalmine: Anchor = { a: 'building', type: 'coalmine', owner: 'scenario', tag: 'coalmine' };

/** Mission 3: water, grain, flour and bread, the fisher, the farm's work area, bread distribution, a mine's food. */
const bread: MissionDef = {
  id: 'bread',
  title: 'tut.bread.title',
  summary: 'tut.bread.summary',
  debrief: 'tut.bread.debrief',
  world: { seed: 42, size: 64, players: 1, start: 'low', fog: true },
  scenario: [
    {
      player: 1,
      buildings: [
        ...woodAndStone,
        { type: 'tower', near: { dx: -3, dy: 10 }, garrison: 1 },
        // A coal mine on the guaranteed coal, still without food (the start's ready-made miners take it up).
        { type: 'coalmine', near: { dx: -4, dy: -8 }, tag: 'coalmine' },
      ],
      piles: [['plank', 8], ['plank', 8], ['stone', 8], ['stone', 6], ['rod', 1], ['scythe', 1], ['bow', 1]],
      people: { carrier: 4, builder: 2, digger: 2 },
    },
  ],
  unlock: { buildings: ['waterworks', 'farm', 'mill', 'bakery', 'fisher', 'hunter', 'pigfarm', 'slaughterhouse'] },
  minutes: 14,
  objectives: [
    { text: 'tut.bread.goal.1', done: { k: 'produced', res: 'bread', min: 1 }, params: { building: { building: 'bakery' } } },
    { text: 'tut.bread.goal.2', done: { k: 'attempts', type: 'coalmine', min: 1 }, params: { building: { building: 'coalmine' } } },
    { text: 'tut.bread.goal.3', done: { k: 'stockAt', type: 'warehouse', res: 'coal', min: 8 }, params: { n: { n: 8 } } },
  ],
  steps: [
    {
      id: 'mine',
      text: 'tut.bread.mine',
      more: 'tut.bread.mine.more',
      params: { building: { building: 'coalmine' } },
      ui: ['info.mineFood'],
      camera: coalmine,
      marker: [coalmine],
      done: { k: 'ack' },
    },
    {
      id: 'fisher',
      text: 'tut.bread.fisher',
      more: 'tut.bread.fisher.more',
      params: { building: { building: 'fisher' }, hunter: { building: 'hunter' }, tab: { label: 'category.food' } },
      hint: { text: 'tut.bread.fisher.hint', after: 60 },
      ui: ['menu.build', 'build.tab.food', 'build.item.fisher'],
      camera: pond,
      marker: [{ a: 'spot', type: 'fisher', near: pond, prefer: 'water' }],
      done: { k: 'building', type: 'fisher', state: 'any' },
    },
    {
      id: 'waterworks',
      text: 'tut.bread.waterworks',
      more: 'tut.bread.waterworks.more',
      params: { building: { building: 'waterworks' } },
      ui: ['menu.build', 'build.tab.food', 'build.item.waterworks'],
      camera: pond,
      marker: [{ a: 'spot', type: 'waterworks', near: pond, prefer: 'water' }],
      done: { k: 'building', type: 'waterworks', state: 'any' },
    },
    {
      id: 'farm',
      text: 'tut.bread.farm',
      more: 'tut.bread.farm.more',
      params: { building: { building: 'farm' } },
      hint: { text: 'tut.bread.farm.hint', after: 60 },
      ui: ['menu.build', 'build.tab.food', 'build.item.farm'],
      camera: farmSpot,
      marker: [farmSpot],
      done: { k: 'building', type: 'farm', state: 'any' },
    },
    {
      id: 'area',
      text: 'tut.bread.area',
      more: 'tut.bread.area.more',
      params: { building: { building: 'farm' }, button: { label: 'info.moveArea' } },
      hint: { text: 'tut.bread.area.hint', after: 60 },
      ui: ['info.workArea'],
      marker: [{ a: 'building', type: 'farm', owner: 'me' }],
      done: { k: 'setting', is: { s: 'workAt', type: 'farm' } },
    },
    {
      id: 'mill',
      text: 'tut.bread.mill',
      more: 'tut.bread.mill.more',
      params: { building: { building: 'mill' } },
      ui: ['menu.build', 'build.tab.food', 'build.item.mill'],
      marker: [{ a: 'spot', type: 'mill', near: farmSpot }],
      done: { k: 'building', type: 'mill', state: 'any' },
    },
    {
      id: 'bakery',
      text: 'tut.bread.bakery',
      more: 'tut.bread.bakery.more',
      params: { building: { building: 'bakery' }, mill: { building: 'mill' }, waterworks: { building: 'waterworks' } },
      ui: ['menu.build', 'build.tab.food', 'build.item.bakery'],
      marker: [{ a: 'spot', type: 'bakery', near: home }],
      done: { k: 'building', type: 'bakery', state: 'any' },
    },
    {
      id: 'grain',
      text: 'tut.bread.grain',
      more: 'tut.bread.grain.more',
      hint: { text: 'tut.bread.grain.hint', after: 120 },
      ui: ['speed.4'],
      marker: [{ a: 'building', type: 'farm', owner: 'me' }],
      done: { k: 'produced', res: 'flour', min: 1 },
    },
    {
      id: 'share',
      text: 'tut.bread.share',
      more: 'tut.bread.share.more',
      params: { menu: { label: 'hud.menu.goods' }, tab: { label: 'goods.distribution' }, building: { building: 'coalmine' } },
      hint: { text: 'tut.bread.share.hint', after: 60 },
      ui: ['menu.goods', 'goods.distribution', 'distribution.bread'],
      done: { k: 'setting', is: { s: 'distribution', res: 'bread' } },
    },
    {
      id: 'coal',
      text: 'tut.bread.coal',
      more: 'tut.bread.coal.more',
      params: { n: { n: 8 } },
      hint: { text: 'tut.bread.coal.hint', after: 120 },
      ui: ['speed.4'],
      camera: coalmine,
      marker: [coalmine],
      done: { k: 'all', of: [
        { k: 'produced', res: 'bread', min: 1 },
        { k: 'stockAt', type: 'warehouse', res: 'coal', min: 8 },
      ] },
    },
  ],
};

const toolsmith: Anchor = { a: 'building', type: 'toolsmith', owner: 'me' };

/** Mission 4: the geologist and his signs, messages and Space, mines on ore, the iron smelter, the toolsmith's orders. */
const metal: MissionDef = {
  id: 'metal',
  title: 'tut.metal.title',
  summary: 'tut.metal.summary',
  debrief: 'tut.metal.debrief',
  world: { seed: 42, size: 64, players: 1, start: 'medium', fog: true },
  scenario: [
    {
      player: 1,
      buildings: [
        ...woodAndStone,
        { type: 'tower', near: { dx: -3, dy: 10 }, garrison: 1 },
        // Mission 3's food chain, standing and staffed.
        { type: 'fisher', near: { dx: -3, dy: 5 }, worker: true },
        { type: 'waterworks', near: { dx: 2, dy: 6 }, worker: true },
        { type: 'farm', near: { dx: -9, dy: 9 }, worker: true },
        { type: 'mill', near: { dx: -7, dy: 4 }, worker: true },
        { type: 'bakery', near: { dx: -10, dy: 4 }, worker: true },
      ],
    },
  ],
  unlock: { buildings: ['coalmine', 'ironmine', 'ironsmelter', 'toolsmith'], commands: ['geologist'] },
  // As in Settlers 4's tutorials the mission keeps food at hand, however the food chain fares.
  refill: [
    { res: 'bread', below: 6, to: 8 },
    { res: 'fish', below: 6, to: 8 },
  ],
  minutes: 12,
  objectives: [
    { text: 'tut.metal.goal.1', done: { k: 'prospected', at: mountain, r: 5, min: 1, ore: 'coal' }, params: { res: { res: 'coal' } } },
    { text: 'tut.metal.goal.2', done: { k: 'prospected', at: mountain, r: 5, min: 1, ore: 'ironore' }, params: { res: { res: 'ironore' } } },
    { text: 'tut.metal.goal.3', done: { k: 'produced', res: 'coal', min: 1 }, params: { building: { building: 'coalmine' } } },
    { text: 'tut.metal.goal.4', done: { k: 'produced', res: 'ironore', min: 1 }, params: { building: { building: 'ironmine' } } },
    { text: 'tut.metal.goal.5', done: { k: 'produced', res: 'shovel', min: 2 }, params: { n: { n: 2 } } },
  ],
  steps: [
    {
      id: 'geologist',
      text: 'tut.metal.geologist',
      more: 'tut.metal.geologist.more',
      params: { menu: { label: 'hud.menu.settlers' }, prof: { prof: 'geologist' } },
      ui: ['menu.settlers', 'settlers.cmd.geologist'],
      camera: mountain,
      done: { k: 'any', of: [
        { k: 'ui', is: { u: 'placing', what: 'geologist' } },
        { k: 'prospected', at: mountain, r: 5, min: 1 },
      ] },
    },
    {
      id: 'prospect',
      text: 'tut.metal.prospect',
      more: 'tut.metal.prospect.more',
      params: { prof: { prof: 'geologist' } },
      hint: { text: 'tut.metal.prospect.hint', after: 60 },
      marker: [mountain],
      ring: { at: mountain, r: 3 },
      done: { k: 'prospected', at: mountain, r: 5, min: 6 },
    },
    {
      id: 'message',
      text: 'tut.metal.message',
      more: 'tut.metal.message.more',
      ui: ['hud.ticker'],
      done: { k: 'any', of: [{ k: 'ui', is: { u: 'jumpedToMessage' } }, { k: 'after', s: 25 }] },
    },
    {
      id: 'signs',
      text: 'tut.metal.signs',
      more: 'tut.metal.signs.more',
      params: { coal: { res: 'coal' }, iron: { res: 'ironore' } },
      camera: mountain,
      done: { k: 'ack' },
    },
    {
      id: 'coalmine',
      text: 'tut.metal.coalmine',
      more: 'tut.metal.coalmine.more',
      params: { building: { building: 'coalmine' }, tab: { label: 'category.mining' } },
      hint: { text: 'tut.metal.coalmine.hint', after: 60 },
      ui: ['menu.build', 'build.tab.mining', 'build.item.coalmine'],
      camera: coalLobe,
      marker: [{ a: 'spot', type: 'coalmine', near: coalLobe, prefer: 'ore', within: 4 }],
      done: { k: 'building', type: 'coalmine', state: 'any', near: coalLobe, r: 4 },
    },
    {
      id: 'ironmine',
      text: 'tut.metal.ironmine',
      more: 'tut.metal.ironmine.more',
      params: { building: { building: 'ironmine' }, food: { res: 'meat' } },
      ui: ['menu.build', 'build.tab.mining', 'build.item.ironmine'],
      camera: ironLobe,
      marker: [{ a: 'spot', type: 'ironmine', near: ironLobe, prefer: 'ore', within: 4 }],
      done: { k: 'building', type: 'ironmine', state: 'any', near: ironLobe, r: 4 },
    },
    {
      id: 'smelter',
      text: 'tut.metal.smelter',
      more: 'tut.metal.smelter.more',
      params: { building: { building: 'ironsmelter' }, tab: { label: 'category.metal' } },
      ui: ['menu.build', 'build.tab.metal', 'build.item.ironsmelter'],
      marker: [{ a: 'spot', type: 'ironsmelter', near: home }],
      done: { k: 'building', type: 'ironsmelter', state: 'any' },
    },
    {
      id: 'toolsmith',
      text: 'tut.metal.toolsmith',
      more: 'tut.metal.toolsmith.more',
      params: { building: { building: 'toolsmith' } },
      hint: { text: 'tut.metal.toolsmith.hint', after: 90 },
      ui: ['menu.build', 'build.tab.metal', 'build.item.toolsmith'],
      marker: [{ a: 'spot', type: 'toolsmith', near: home }],
      // The site is enough: a still lit button would ask for a second one while it is built.
      done: { k: 'building', type: 'toolsmith', state: 'any' },
    },
    {
      id: 'order',
      text: 'tut.metal.order',
      more: 'tut.metal.order.more',
      params: { building: { building: 'toolsmith' }, n: { n: 2 }, res: { res: 'shovel' } },
      hint: { text: 'tut.metal.order.hint', after: 60 },
      ui: ['info.toolOrder.shovel'],
      marker: [toolsmith],
      done: { k: 'setting', is: { s: 'toolOrder', res: 'shovel', min: 2 } },
    },
    {
      id: 'shovels',
      text: 'tut.metal.shovels',
      more: 'tut.metal.shovels.more',
      params: { n: { n: 2 } },
      hint: { text: 'tut.metal.shovels.hint', after: 120 },
      ui: ['speed.4'],
      marker: [toolsmith],
      done: { k: 'all', of: [
        { k: 'building', type: 'coalmine' },
        { k: 'building', type: 'ironmine' },
        { k: 'produced', res: 'shovel', min: 2 },
      ] },
    },
  ],
};

/** Mission 4's economy: wood and stone, the second tower and the food chain, all staffed. */
const economy: ScenarioBuilding[] = [
  ...woodAndStone,
  { type: 'tower', near: { dx: -3, dy: 10 }, garrison: 1 },
  { type: 'fisher', near: { dx: -3, dy: 5 }, worker: true },
  { type: 'waterworks', near: { dx: 2, dy: 6 }, worker: true },
  { type: 'farm', near: { dx: -9, dy: 9 }, worker: true },
  { type: 'mill', near: { dx: -7, dy: 4 }, worker: true },
  { type: 'bakery', near: { dx: -10, dy: 4 }, worker: true },
];

const outpost: Anchor = { a: 'building', type: 'tower', owner: 'scenario', tag: 'outpost' };
/** Where the pioneer is sent: open land at the border towards the far guaranteed mountain. */
const borderSpot: Anchor = {
  a: 'nearest',
  terrain: 'border',
  from: { a: 'between', from: home, to: { a: 'guarantee', mountain: 1 }, t: 0.75 },
};
/** Markets: the one by the start tower, the one by the outpost (sites included). */
const marketByHome: Anchor = { a: 'building', type: 'market', owner: 'me', near: home };
const marketByPost: Anchor = { a: 'building', type: 'market', owner: 'me', near: outpost };
const atHome = { near: home, r: 12 } as const;
const atPost = { near: outpost, r: 10 } as const;

/** Mission 5: the pioneer, land cut off from the warehouses, markets, the donkey ranch, a route there and back. */
const trade: MissionDef = {
  id: 'trade',
  title: 'tut.trade.title',
  summary: 'tut.trade.summary',
  debrief: 'tut.trade.debrief',
  world: { seed: 42, size: 64, players: 1, start: 'medium', fog: true },
  scenario: [
    {
      player: 1,
      buildings: [
        ...economy,
        // A manned tower far out on its own (Settlers 4 maps give such ones): land no carrier reaches.
        // Its last settlers left a pickaxe behind.
        { type: 'tower', near: { dx: 16, dy: -27 }, founding: true, garrison: 1, tag: 'outpost', piles: [['pickaxe', 1]] },
      ],
      // Two donkeys came along; feed for the ranch's next ones until the farm keeps up.
      people: { donkey: 2 },
      piles: [['grain', 8], ['water', 8]],
    },
  ],
  unlock: { buildings: ['market', 'donkeyranch'], commands: ['pioneer', 'thief'] },
  minutes: 18,
  objectives: [
    { text: 'tut.trade.goal.1', done: { k: 'claimed', min: 8 }, params: { n: { n: 8 } } },
    { text: 'tut.trade.goal.2', done: { k: 'building', type: 'stonecutter', ...atPost }, params: { building: { building: 'stonecutter' } } },
    { text: 'tut.trade.goal.3', done: { k: 'received', res: 'stone', min: 6, ...atHome }, params: { n: { n: 6 }, res: { res: 'stone' } } },
  ],
  steps: [
    {
      id: 'pioneer',
      text: 'tut.trade.pioneer',
      more: 'tut.trade.pioneer.more',
      params: { menu: { label: 'hud.menu.settlers' }, prof: { prof: 'pioneer' }, res: { res: 'shovel' } },
      ui: ['menu.settlers', 'settlers.order.pioneer'],
      done: { k: 'units', kind: 'pioneer', min: 1 },
    },
    {
      id: 'claim',
      text: 'tut.trade.claim',
      more: 'tut.trade.claim.more',
      params: { prof: { prof: 'pioneer' }, cmd: { label: 'settlers.cmd.pioneer' } },
      hint: { text: 'tut.trade.claim.hint', after: 60 },
      ui: ['menu.settlers', 'settlers.cmd.pioneer'],
      camera: borderSpot,
      marker: [borderSpot],
      done: { k: 'claimed', min: 1 },
    },
    {
      id: 'outpost',
      text: 'tut.trade.outpost',
      more: 'tut.trade.outpost.more',
      camera: outpost,
      marker: [outpost],
      done: { k: 'ack' },
    },
    {
      id: 'stonecutter',
      text: 'tut.trade.stonecutter',
      more: 'tut.trade.stonecutter.more',
      params: { building: { building: 'stonecutter' } },
      ui: ['menu.build', 'build.tab.resources', 'build.item.stonecutter'],
      camera: outpost,
      marker: [{ a: 'spot', type: 'stonecutter', near: outpost, prefer: 'stone', within: 8 }],
      done: { k: 'building', type: 'stonecutter', state: 'any', ...atPost },
    },
    {
      id: 'market',
      text: 'tut.trade.market',
      more: 'tut.trade.market.more',
      params: { building: { building: 'market' }, tab: { label: 'category.trade' } },
      ui: ['menu.build', 'build.tab.trade', 'build.item.market'],
      camera: home,
      marker: [{ a: 'spot', type: 'market', near: home, within: 10 }],
      done: { k: 'building', type: 'market', state: 'any', ...atHome },
    },
    {
      id: 'ranch',
      text: 'tut.trade.ranch',
      more: 'tut.trade.ranch.more',
      params: { building: { building: 'donkeyranch' } },
      ui: ['menu.build', 'build.tab.trade', 'build.item.donkeyranch'],
      marker: [{ a: 'spot', type: 'donkeyranch', near: home, within: 12 }],
      done: { k: 'building', type: 'donkeyranch', state: 'any' },
    },
    {
      id: 'postMarket',
      text: 'tut.trade.postMarket',
      more: 'tut.trade.postMarket.more',
      params: { building: { building: 'market' } },
      ui: ['menu.build', 'build.tab.trade', 'build.item.market'],
      camera: outpost,
      marker: [{ a: 'spot', type: 'market', near: outpost, within: 8 }],
      done: { k: 'building', type: 'market', state: 'any', ...atPost },
    },
    {
      id: 'wait',
      text: 'tut.trade.wait',
      more: 'tut.trade.wait.more',
      params: { market: { building: 'market' }, ranch: { building: 'donkeyranch' } },
      hint: { text: 'tut.trade.wait.hint', after: 120 },
      ui: ['speed.2'],
      camera: home,
      marker: [marketByHome],
      done: { k: 'all', of: [{ k: 'building', type: 'market', ...atHome }, { k: 'building', type: 'donkeyranch' }] },
    },
    {
      id: 'route',
      text: 'tut.trade.route',
      more: 'tut.trade.route.more',
      params: { plank: { res: 'plank' }, stone: { res: 'stone' }, list: { label: 'trade.notCarried' } },
      hint: { text: 'tut.trade.route.hint', after: 60 },
      ui: ['trade.route', 'trade.goods.plank', 'trade.goods.stone'],
      marker: [marketByHome],
      done: {
        k: 'all',
        of: [
          { k: 'setting', is: { s: 'tradeRoute', res: 'plank', ...atHome } },
          { k: 'setting', is: { s: 'tradeRoute', res: 'stone', ...atHome } },
        ],
      },
    },
    {
      id: 'built',
      text: 'tut.trade.built',
      more: 'tut.trade.built.more',
      params: { building: { building: 'stonecutter' }, market: { building: 'market' } },
      hint: { text: 'tut.trade.built.hint', after: 120 },
      ui: ['speed.4'],
      camera: outpost,
      marker: [outpost],
      done: { k: 'all', of: [{ k: 'building', type: 'stonecutter', ...atPost }, { k: 'building', type: 'market', ...atPost }] },
    },
    {
      id: 'stop',
      text: 'tut.trade.stop',
      more: 'tut.trade.stop.more',
      params: { plank: { res: 'plank' }, stone: { res: 'stone' }, list: { label: 'trade.carried' } },
      camera: home,
      marker: [marketByHome],
      done: {
        k: 'all',
        of: [
          { k: 'setting', is: { s: 'tradeRoute', res: 'plank', ...atHome, off: true } },
          { k: 'setting', is: { s: 'tradeRoute', res: 'stone', ...atHome, off: true } },
        ],
      },
    },
    {
      id: 'back',
      text: 'tut.trade.back',
      more: 'tut.trade.back.more',
      params: { res: { res: 'stone' }, list: { label: 'trade.notCarried' } },
      hint: { text: 'tut.trade.back.hint', after: 60 },
      // Only the route: the home market's window, if still open, would light its own stone.
      ui: ['trade.route'],
      camera: outpost,
      marker: [marketByPost],
      done: { k: 'setting', is: { s: 'tradeRoute', res: 'stone', ...atPost } },
    },
    {
      id: 'stone',
      text: 'tut.trade.stone',
      more: 'tut.trade.stone.more',
      params: { n: { n: 6 }, res: { res: 'stone' }, carried: { label: 'trade.carried' } },
      hint: { text: 'tut.trade.stone.hint', after: 120 },
      ui: ['speed.4'],
      done: { k: 'received', res: 'stone', min: 6, ...atHome },
    },
  ],
};

const enemyHome: Anchor = { a: 'enemyHome' };
/** Towards the rival: a point this far along the line from home to his start. */
const toward = (t: number): Anchor => ({ a: 'between', from: home, to: enemyHome, t });
const bigtower: Anchor = { a: 'building', type: 'bigtower', owner: 'me' };
/** Where the squad gathers: open ground on the way, inside the big tower's land. */
const rally: Anchor = { a: 'nearest', terrain: 'meadow', from: toward(0.33) };
/** The rival's nearest tower the player has seen (none before scouting). */
const enemyTower: Anchor = { a: 'building', type: 'tower', owner: 'enemy' };

/**
 * Mission 6: the big tower and its garrison, the barracks and recruit orders by level, selecting and
 * ordering fighters, control groups, scouting, attack and capture, the healer, victory over a
 * passive rival (Settlers 4's eighth tutorial: its computer player switched off).
 */
const battle: MissionDef = {
  id: 'battle',
  title: 'tut.battle.title',
  summary: 'tut.battle.summary',
  debrief: 'tut.battle.debrief',
  // The rival is not in `ai`: he builds nothing, his fighters stand by his towers. He starts poorer.
  world: { seed: 7, size: 96, players: 2, start: 'medium', starts: ['medium', 'low'], fog: true },
  scenario: [
    { player: 1, piles: [['sword', 8], ['bow', 6], ['gold', 8]] },
    // A second tower out on its own towards the player, held by one swordsman.
    { player: 2, buildings: [{ type: 'tower', near: { dx: 14, dy: 14 }, founding: true, garrison: 1, tag: 'front' }] },
  ],
  unlock: { buildings: ['tower', 'bigtower', 'barracks', 'lookout', 'infirmary'], menus: ['army'] },
  // As in Settlers 4's eighth tutorial: weapons and gold never run out.
  refill: [
    { res: 'sword', below: 4, to: 6 },
    { res: 'bow', below: 4, to: 6 },
    { res: 'gold', below: 4, to: 6 },
  ],
  minutes: 15,
  objectives: [
    { text: 'tut.battle.goal.1', done: { k: 'garrison', type: 'bigtower', min: 3 }, params: { building: { building: 'bigtower' } } },
    { text: 'tut.battle.goal.2', done: { k: 'units', kind: 'fighter', min: 8, relative: true }, params: { n: { n: 8 } } },
    { text: 'tut.battle.goal.3', done: { k: 'captured', min: 1 } },
    { text: 'tut.battle.goal.4', done: { k: 'outcome', is: 'won' } },
  ],
  steps: [
    {
      id: 'bigtower',
      text: 'tut.battle.bigtower',
      more: 'tut.battle.bigtower.more',
      params: { building: { building: 'bigtower' }, tab: { label: 'category.military' } },
      hint: { text: 'tut.battle.bigtower.hint', after: 60 },
      ui: ['menu.build', 'build.tab.military', 'build.item.bigtower'],
      camera: toward(0.2),
      marker: [{ a: 'spot', type: 'bigtower', near: toward(0.22), prefer: 'border', within: 10 }],
      done: { k: 'building', type: 'bigtower', state: 'any' },
    },
    {
      id: 'wait',
      text: 'tut.battle.wait',
      more: 'tut.battle.wait.more',
      params: { building: { building: 'bigtower' } },
      ui: ['speed.2'],
      marker: [bigtower],
      done: { k: 'building', type: 'bigtower' },
    },
    {
      id: 'fill',
      text: 'tut.battle.fill',
      more: 'tut.battle.fill.more',
      params: { building: { building: 'bigtower' }, button: { label: 'army.fill' } },
      hint: { text: 'tut.battle.fill.hint', after: 60 },
      ui: ['garrison.fill'],
      marker: [bigtower],
      done: { k: 'garrison', type: 'bigtower', min: 3 },
    },
    {
      id: 'barracks',
      text: 'tut.battle.barracks',
      more: 'tut.battle.barracks.more',
      params: { building: { building: 'barracks' }, sword: { res: 'sword' }, bow: { res: 'bow' }, gold: { res: 'gold' } },
      ui: ['menu.build', 'build.tab.military', 'build.item.barracks'],
      camera: home,
      marker: [{ a: 'spot', type: 'barracks', near: home, within: 10 }],
      done: { k: 'building', type: 'barracks', state: 'any' },
    },
    {
      id: 'orders',
      text: 'tut.battle.orders',
      more: 'tut.battle.orders.more',
      params: { menu: { label: 'hud.menu.army' } },
      hint: { text: 'tut.battle.orders.hint', after: 60 },
      // The menu first: open, it is passed over; each row's button counts as used once the row holds an order.
      ui: ['menu.army', 'recruit.soldier.1.plus5', 'recruit.archer.1.plus5', 'recruit.soldier.2.plus1'],
      done: {
        k: 'all',
        of: [
          { k: 'setting', is: { s: 'recruitOrder', kind: 'soldier', level: 1, min: 5 } },
          { k: 'setting', is: { s: 'recruitOrder', kind: 'archer', level: 1, min: 5 } },
          { k: 'setting', is: { s: 'recruitOrder', kind: 'soldier', level: 2, min: 1 } },
        ],
      },
    },
    {
      id: 'recruits',
      text: 'tut.battle.recruits',
      more: 'tut.battle.recruits.more',
      params: { n: { n: 8 }, building: { building: 'barracks' } },
      hint: { text: 'tut.battle.recruits.hint', after: 120 },
      ui: ['speed.4'],
      marker: [{ a: 'building', type: 'barracks', owner: 'me' }],
      done: { k: 'units', kind: 'fighter', min: 8, relative: true },
    },
    {
      id: 'select',
      text: 'tut.battle.select',
      more: 'tut.battle.select.more',
      params: { n: { n: 5 }, alt: { key: 'alt' }, shift: { key: 'shift' }, ctrl: { key: 'ctrl' } },
      hint: { text: 'tut.battle.select.hint', after: 60 },
      marker: [{ a: 'building', type: 'barracks', owner: 'me' }],
      done: { k: 'ui', is: { u: 'selectedUnits', min: 5 } },
    },
    {
      id: 'move',
      text: 'tut.battle.move',
      more: 'tut.battle.move.more',
      params: { n: { n: 5 } },
      hint: { text: 'tut.battle.move.hint', after: 90 },
      camera: rally,
      marker: [rally],
      done: { k: 'units', kind: 'fighter', min: 5, near: rally, r: 4 },
    },
    {
      id: 'group',
      text: 'tut.battle.group',
      more: 'tut.battle.group.more',
      params: { ctrl: { key: 'ctrl' } },
      done: { k: 'ui', is: { u: 'group', n: 1 } },
    },
    {
      id: 'scout',
      text: 'tut.battle.scout',
      more: 'tut.battle.scout.more',
      params: { building: { building: 'lookout' }, menu: { label: 'hud.menu.settlers' } },
      hint: { text: 'tut.battle.scout.hint', after: 90 },
      ui: ['menu.build', 'build.tab.military', 'build.item.lookout'],
      marker: [{ a: 'spot', type: 'lookout', near: toward(0.42), prefer: 'border', within: 10 }],
      done: { k: 'explored', at: enemyTower },
    },
    {
      id: 'attack',
      text: 'tut.battle.attack',
      more: 'tut.battle.attack.more',
      hint: { text: 'tut.battle.attack.hint', after: 120 },
      camera: enemyTower,
      marker: [enemyTower],
      done: { k: 'captured', min: 1 },
    },
    {
      id: 'infirmary',
      text: 'tut.battle.infirmary',
      more: 'tut.battle.infirmary.more',
      params: { building: { building: 'infirmary' } },
      ui: ['menu.build', 'build.tab.military', 'build.item.infirmary'],
      marker: [{ a: 'spot', type: 'infirmary', near: rally, within: 10 }],
      done: { k: 'building', type: 'infirmary', state: 'any' },
    },
    {
      id: 'victory',
      text: 'tut.battle.victory',
      more: 'tut.battle.victory.more',
      hint: { text: 'tut.battle.victory.hint', after: 150 },
      camera: enemyHome,
      marker: [enemyHome],
      done: { k: 'outcome', is: 'won' },
    },
  ],
};

export const MISSIONS: readonly MissionDef[] = [
  forest,
  logistics,
  bread,
  metal,
  trade,
  battle,
];

export const missionById = (id: string | null): MissionDef | undefined => MISSIONS.find((m) => m.id === id);
