import { describe, expect, it } from 'vitest';
import { AI, AI_LEVELS, AI_LEVEL_IDS } from '../src/sim/config';
import { tuning } from '../src/sim/ai';
import { World } from '../src/sim/world';
import type { Resource } from '../src/sim/types';
import { groundUnits } from './helpers';
import { saveWorld } from '../src/sim/save';
import { AUTO_ID, gameTime, SaveSlots, type KeyValue } from '../src/ui/saves';
import { defaultSetup, devWorldArgs, launchOf, parseSetup, setupProblem, worldArgs, type GameSetup } from '../src/ui/setup';

describe('game setup', () => {
  it('the default setup is one medium computer opponent on 128×128 (a small Settlers 4 map for two)', () => {
    const s = defaultSetup();
    expect(setupProblem(s)).toBeNull();
    const { seed, opts } = worldArgs(s, 99);
    expect(seed).toBe(99);
    expect(opts).toMatchObject({ size: 128, players: 2, ai: [2], start: 'medium' });
    expect(opts.teams).toBeUndefined();
    expect(opts.difficulty).toBeUndefined();
  });

  it('maps slots to players, computer ids, teams and difficulty; closed slots are skipped', () => {
    const s: GameSetup = {
      ...defaultSetup(),
      seed: 5,
      size: 96,
      start: 'high',
      slots: [
        { kind: 'human', team: 1, level: 'medium', race: 'romans' },
        { kind: 'closed', team: 2, level: 'medium', race: 'romans' },
        { kind: 'ai', team: 1, level: 'easy', race: 'romans' },
        { kind: 'ai', team: 2, level: 'hard', race: 'romans' },
      ],
    };
    expect(setupProblem(s)).toBeNull();
    const { seed, opts } = worldArgs(s, 1);
    expect(seed).toBe(5);
    expect(opts).toMatchObject({ size: 96, players: 3, ai: [2, 3], teams: [1, 1, 2], start: 'high' });
    expect(opts.difficulty).toEqual(['medium', 'easy', 'hard']);
    const w = new World(seed, { ...opts, size: 64 });
    expect(w.allied(1, 2)).toBe(true);
    expect(w.allied(1, 3)).toBe(false);
    expect(w.ai.map((a) => [a.player, a.level])).toEqual([
      [2, 'easy'],
      [3, 'hard'],
    ]);
  });

  it('refuses setups that cannot be played', () => {
    const one = (patch: Partial<GameSetup>) => setupProblem({ ...defaultSetup(), ...patch });
    const s = defaultSetup();
    expect(one({ slots: s.slots.map((x) => ({ ...x, team: 1 })) })).toMatch(/одной команде/);
    expect(one({ slots: [{ ...s.slots[0], kind: 'ai' }, ...s.slots.slice(1)] })).toMatch(/ваше/);
    expect(one({ slots: [s.slots[0], { ...s.slots[1], kind: 'remote' }, ...s.slots.slice(2)] })).toMatch(/сетевой/);
    expect(one({ slots: [{ ...s.slots[0], race: 'vikings' }, ...s.slots.slice(1)] })).toMatch(/скоро/);
    expect(one({ mode: 'network' })).toMatch(/скоро/);
    // Alone on the map (a sandbox) is fine.
    expect(one({ slots: [s.slots[0], ...s.slots.slice(1).map((x) => ({ ...x, kind: 'closed' as const }))] })).toBeNull();
  });

  it('reads a setup back from JSON, repairing bad fields', () => {
    const s = { ...defaultSetup(), seed: 12, size: 160 };
    expect(parseSetup(JSON.stringify(s))).toEqual(s);
    const bad = parseSetup(JSON.stringify({ size: 7, seed: -1, start: 'lots', slots: [{ kind: 'x', team: 9, level: 'god' }] }))!;
    expect(bad.size).toBe(128);
    expect(bad.seed).toBeNull();
    expect(bad.start).toBe('medium');
    expect(bad.slots[0]).toEqual({ kind: 'human', team: 1, level: 'medium', race: 'romans' });
    expect(parseSetup('{')).toBeNull();
    expect(parseSetup(null)).toBeNull();
  });

  it('the address decides between menu, setup, load, demo and development games', () => {
    const p = (q: string) => launchOf(new URLSearchParams(q));
    expect(p('')).toEqual({ kind: 'menu' });
    expect(p('?menu&seed=4')).toEqual({ kind: 'menu' });
    expect(p('?seed=4')).toEqual({ kind: 'dev' });
    expect(p('?art=classic')).toEqual({ kind: 'dev' });
    expect(p('?demo')).toEqual({ kind: 'demo' });
    expect(p('?load=1')).toEqual({ kind: 'load', slot: null });
    expect(p('?load=auto')).toEqual({ kind: 'load', slot: 'auto' });
    expect(p(`?game=${encodeURIComponent(JSON.stringify(defaultSetup()))}`)).toEqual({ kind: 'setup', setup: defaultSetup() });
    expect(p('?game=nonsense')).toEqual({ kind: 'menu' });
  });

  it('development parameters keep their meaning', () => {
    const { seed, opts } = devWorldArgs(new URLSearchParams('?seed=3&size=96&players=3&teams=1,1,2&start=low&levels=medium,hard,easy'), 0);
    expect(seed).toBe(3);
    expect(opts).toEqual({ size: 96, players: 3, ai: [2, 3], teams: [1, 1, 2], difficulty: ['medium', 'hard', 'easy'], start: 'low' });
    expect(devWorldArgs(new URLSearchParams('?ai=off'), 8).opts.ai).toEqual([]);
    // Without ?size the development game is as big as a new game from the menu.
    expect(devWorldArgs(new URLSearchParams('?seed=1'), 8).opts.size).toBe(128);
  });
});

describe('AI difficulty', () => {
  it('medium is exactly the AI table; easy is slower and more careful, hard faster and bolder', () => {
    const t = (level: (typeof AI_LEVEL_IDS)[number]) => tuning({ level } as never);
    expect(t('medium')).toEqual({
      thinkEvery: AI.thinkEvery,
      attackRatio: AI.attackRatio,
      peaceTicks: AI.peaceTicks,
      attackCooldown: AI.attackCooldown,
      maxOpenSites: AI.maxOpenSites,
    });
    expect(t('easy').thinkEvery).toBeGreaterThan(AI.thinkEvery);
    expect(t('easy').peaceTicks).toBeGreaterThan(AI.peaceTicks);
    expect(t('hard').thinkEvery).toBeLessThan(AI.thinkEvery);
    expect(t('hard').attackRatio).toBeLessThan(AI.attackRatio);
    for (const l of AI_LEVEL_IDS) expect(t(l).maxOpenSites).toBeGreaterThanOrEqual(1);
    // An AI from a save made before levels plays medium.
    expect(tuning({} as never)).toEqual(t('medium'));
  });

  it("a computer player starts with Settlers 4's help (goods and people by level); the level survives a save", () => {
    const human = new World(4, { players: 2 });
    for (const level of AI_LEVEL_IDS) {
      const ai = new World(4, { players: 2, ai: [2], difficulty: ['medium', level] });
      for (const [res, n] of Object.entries(AI_LEVELS[level].bonus) as [Resource, number][]) {
        expect(groundUnits(ai, res, 2) - groundUnits(human, res, 2)).toBe(n);
        expect(groundUnits(ai, res, 1)).toBe(groundUnits(human, res, 1));
      }
      const people = (w: World, kind: string) => w.settlers.filter((s) => s.owner === 2 && s.kind === kind).length;
      for (const [kind, n] of Object.entries(AI_LEVELS[level].people)) {
        expect(people(ai, kind) - people(human, kind)).toBe(n);
      }
      // Pioneers wait for orders: the order grows with them (none is dismissed).
      expect(ai.players[1].economy!.orders.pioneer ?? 0).toBe(people(ai, 'pioneer'));
      expect(World.load(JSON.parse(JSON.stringify(saveWorld(ai)))).ai[0].level).toBe(level);
    }
    // S4's start script: every AI 8 planks, 16 stone, 5 pioneers; from «normal» on again, and 5 swordsmen.
    expect(AI_LEVELS.easy.bonus).toEqual({ plank: 8, stone: 16 });
    expect(AI_LEVELS.hard.people).toEqual({ pioneer: 10, soldier: 5 });
  });
});

class FakeStorage implements KeyValue {
  readonly data = new Map<string, string>();
  quota = Infinity;
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe('save slots', () => {
  const world = new World(2, { players: 2, ai: [2] });
  for (let i = 0; i < 50; i++) world.step();
  const data = saveWorld(world);

  it('writes, lists newest first, reads back and deletes', async () => {
    const store = new FakeStorage();
    const slots = new SaveSlots(store);
    const a = (await slots.write(data, 'Первая', 1000))!;
    const b = (await slots.write(data, 'Вторая', 2000))!;
    expect(a.id).not.toBe(b.id);
    expect(slots.list().map((m) => m.name)).toEqual(['Вторая', 'Первая']);
    expect(slots.latest()!.id).toBe(b.id);
    expect(a).toMatchObject({ tick: 50, size: 64, players: 2 });
    // Compressed when the platform can.
    expect(store.getItem(`settlers.save.${a.id}`)!.length).toBeLessThan(JSON.stringify(data).length / 4);
    expect(await slots.read(a.id)).toEqual(JSON.parse(JSON.stringify(data)));
    expect(slots.remove(a.id)).toBe(true);
    expect(slots.list().map((m) => m.id)).toEqual([b.id]);
    expect(await slots.read(a.id)).toBeNull();
  });

  it('overwrites a slot by id; the autosave keeps one slot', async () => {
    const slots = new SaveSlots(new FakeStorage());
    await slots.write(data, 'Автосохранение', 1, AUTO_ID);
    await slots.write(data, 'Автосохранение', 2, AUTO_ID);
    expect(slots.list()).toHaveLength(1);
    expect(slots.list()[0]).toMatchObject({ id: AUTO_ID, auto: true, savedAt: 2 });
  });

  it('lists and loads the old single slot; reports a full or missing storage', async () => {
    const store = new FakeStorage();
    store.setItem('settlers.save.v1', JSON.stringify(data));
    const slots = new SaveSlots(store);
    expect(slots.list()).toEqual([expect.objectContaining({ id: 'v1', tick: 50 })]);
    expect((await slots.read('v1'))!.tick).toBe(50);
    store.quota = 10;
    expect(await slots.write(data, 'x', 3)).toBeNull();
    expect(slots.list()).toHaveLength(1);
    const none = new SaveSlots(null);
    expect(none.list()).toEqual([]);
    expect(await none.write(data, 'x', 1)).toBeNull();
  });

  it('formats game time', () => {
    expect(gameTime(0, 10)).toBe('0:00');
    expect(gameTime(10 * 65, 10)).toBe('1:05');
    expect(gameTime(10 * 3725, 10)).toBe('1:02:05');
  });
});
