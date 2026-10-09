import type { ScenarioBuilding } from '../sim/scenario';
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
      done: { k: 'building', type: 'toolsmith' },
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
  bread,
  metal,
  later('trade', { buildings: ['market', 'donkeyranch'], commands: ['pioneer', 'thief'] }, 15),
  later('battle', { buildings: ['tower', 'bigtower', 'barracks', 'lookout', 'infirmary'], menus: ['army'] }, 15),
];

export const missionById = (id: string | null): MissionDef | undefined => MISSIONS.find((m) => m.id === id);
