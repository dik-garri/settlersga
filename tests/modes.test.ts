import { afterEach, describe, expect, it } from 'vitest';
import { addBuilding } from '../src/sim/buildings';
import { stateChecksum } from '../src/sim/checksum';
import { AI, ECONOMY } from '../src/sim/config';
import { putGoods } from '../src/sim/ground';
import { alliances, decideEconomy, economyEndTick, economyGoods, economyStock, economyTally, type EconomyTally } from '../src/sim/modes';
import { playReplay, replayOf } from '../src/sim/replay';
import { saveWorld } from '../src/sim/save';
import type { Resource } from '../src/sim/types';
import { World } from '../src/sim/world';
import { defaultSetup, parseSetup, randomGoods, setupProblem, setVictory, worldArgs } from '../src/ui/setup';
import { base } from './helpers';

const GOODS: Resource[] = ['plank', 'stone', 'coal', 'iron', 'gold', 'bread', 'fish'];
const minutes = ECONOMY.minutes;
afterEach(() => {
  ECONOMY.minutes = minutes;
});

const tally = (pairs: [number, number][]): EconomyTally => {
  const rows = pairs.map(([a, b], k) => ({ res: GOODS[k], a, b }));
  return {
    rows,
    winsA: rows.filter((r) => r.a > r.b).length,
    winsB: rows.filter((r) => r.b > r.a).length,
    sumA: rows.reduce((n, r) => n + r.a, 0),
    sumB: rows.reduce((n, r) => n + r.b, 0),
    sideA: [1],
    sideB: [2],
  };
};

/** Every good lying on the ground and in piles is set aside: the test puts exactly what it counts. */
function emptyStocks(w: World): void {
  for (const i of [...w.stacks]) {
    w.map.goods[i] = 0;
    w.map.goodsAmount[i] = 0;
    w.map.goodsReserved[i] = 0;
    w.stacks.delete(i);
  }
  w.stackOrder = null;
  for (const b of w.buildings.values()) for (const r of Object.keys(b.output) as Resource[]) b.output[r] = b.input[r] = 0;
}

describe('economic victory (Settlers 4 ScriptEconomyModeVictoryConditionCheck)', () => {
  it('the side ahead in more goods wins; equal goods — the greater sum; a full tie — the coin', () => {
    // 4 goods to 3, although the other side has more in all.
    expect(decideEconomy(tally([[5, 1], [5, 1], [5, 1], [5, 1], [0, 90], [0, 90], [0, 90]]), () => 0)).toEqual({ side: 'a', by: 'goods' });
    expect(decideEconomy(tally([[0, 1], [0, 1], [0, 1], [0, 1], [99, 0], [99, 0], [99, 0]]), () => 0)).toEqual({ side: 'b', by: 'goods' });
    // 3 : 3 and one level good: the sum decides.
    expect(decideEconomy(tally([[5, 1], [5, 1], [5, 1], [1, 5], [1, 5], [1, 2], [7, 7]]), () => 0)).toEqual({ side: 'a', by: 'sum' });
    expect(decideEconomy(tally([[5, 1], [5, 1], [5, 1], [1, 5], [1, 5], [1, 9], [7, 7]]), () => 0)).toEqual({ side: 'b', by: 'sum' });
    // Everything equal: the coin, either way.
    const level = tally([[3, 3], [3, 3], [3, 3], [3, 3], [3, 3], [3, 3], [3, 3]]);
    expect(decideEconomy(level, () => 0.2)).toEqual({ side: 'a', by: 'coin' });
    expect(decideEconomy(level, () => 0.7)).toEqual({ side: 'b', by: 'coin' });
  });

  it('counts every pile on the land — output, stock and input piles, site materials, goods on the ground — not goods in hands', () => {
    const w = new World(42, { players: 2, mode: 'economy', economyGoods: GOODS });
    emptyStocks(w);
    const b = base(w, 1);
    let store = null;
    for (let dy = 5; dy < 12 && !store; dy++) if (w.canPlace('warehouse', b.x + dy, b.y + 6, 1)) store = addBuilding(w, 'warehouse', b.x + dy, b.y + 6, 1, true);
    expect(store).not.toBeNull();
    store!.output.coal = 7;
    store!.input.coal = 2;
    putGoods(w, w.homeOf(1), 'coal', 5);
    w.settlers.find((s) => s.owner === 1 && s.kind === 'carrier')!.carrying = 'coal';
    expect(economyStock(w, 1).coal).toBe(14);
    expect(economyStock(w, 2).coal).toBe(0);
  });

  it('decides after the time limit and stores the result with the comparison; conquest is not overruled', () => {
    const w = new World(42, { players: 2, mode: 'economy', economyGoods: GOODS });
    emptyStocks(w);
    putGoods(w, w.homeOf(1), 'coal', 5);
    putGoods(w, w.homeOf(1), 'iron', 3);
    putGoods(w, w.homeOf(2), 'plank', 4);
    w.tick = economyEndTick() - 2;
    w.step();
    expect(w.result).toBeUndefined();
    expect(w.outcome(1)).toBe('playing');
    w.step();
    expect(w.result).toBeDefined();
    expect(w.result!.by).toBe('goods');
    expect(w.result!.winners).toEqual([1]);
    expect(w.outcome(1)).toBe('won');
    expect(w.outcome(2)).toBe('lost');
    expect(w.result!.tally.rows.find((r) => r.res === 'coal')).toEqual({ res: 'coal', a: 5, b: 0 });

    // A game conquest decided first stays decided by conquest.
    const c = new World(42, { players: 2, mode: 'economy', economyGoods: GOODS });
    c.defeatPlayer(2);
    c.tick = economyEndTick() - 1;
    c.step();
    expect(c.result).toBeUndefined();
    expect(c.outcome(1)).toBe('won');
  });

  it('alliance 1 is the lowest team; only alliance 1 or 2 can win, the rest count for side 2', () => {
    const w = new World(42, { players: 3, mode: 'economy', economyGoods: GOODS });
    expect(alliances(w)).toEqual([[1], [2], [3]]);
    emptyStocks(w);
    // Player 3 alone holds the goods: side 2 is ahead, and S4 names alliance 2 the winner.
    putGoods(w, w.homeOf(3), 'coal', 8);
    w.tick = economyEndTick() - 1;
    w.step();
    expect(w.result!.winners).toEqual([2]);
    expect(w.outcome(3)).toBe('lost');

    const t = new World(42, { players: 2, teams: [2, 1], mode: 'economy', economyGoods: GOODS });
    expect(alliances(t)).toEqual([[2], [1]]);
    expect(economyTally(t).sideA).toEqual([2]);
  });

  it('the goods: the given ones kept, the rest drawn from the pool (never the pig), the same for a seed', () => {
    expect(ECONOMY.pool).not.toContain('pig');
    expect(economyGoods(['bread', 'pig', 'bread'] as Resource[], 5)).toHaveLength(7);
    expect(economyGoods(['bread', 'pig'] as Resource[], 5)[0]).toBe('bread');
    expect(economyGoods(['bread', 'pig'] as Resource[], 5)).not.toContain('pig');
    const a = economyGoods(undefined, 9);
    expect(new Set(a).size).toBe(7);
    expect(economyGoods(undefined, 9)).toEqual(a);
    const w = new World(9, { mode: 'economy' });
    expect(w.rules?.goods).toEqual(a);
  });

  it('a conquest world has no rules (its checksums stay as before)', () => {
    const w = new World(42, { players: 2 });
    expect(w.rules).toBeUndefined();
    expect(w.result).toBeUndefined();
  });

  it('survives save and load bit-for-bit, before and after the decision', () => {
    ECONOMY.minutes = 2;
    const w = new World(11, { players: 2, ai: [1, 2], mode: 'economy', economyGoods: GOODS });
    for (let i = 0; i < 900; i++) w.step();
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(l.rules).toEqual(w.rules);
    for (let i = 0; i < 600; i++) {
      w.step();
      l.step();
    }
    expect(w.result).toBeDefined();
    expect(stateChecksum(l)).toBe(stateChecksum(w));
    expect(saveWorld(l)).toEqual(saveWorld(w));
    const again = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(again.result).toEqual(w.result);
    expect(again.outcome(1)).toBe(w.outcome(1));
  });

  it('replays to the same state and result', () => {
    ECONOMY.minutes = 1;
    const w = new World(7, { players: 2, ai: [1, 2], mode: 'economy' });
    for (let i = 0; i < 700; i++) w.step();
    expect(w.result).toBeDefined();
    const file = replayOf(w)!;
    const r = playReplay(file);
    expect(r.result).toEqual(w.result);
    expect(stateChecksum(r)).toBe(file.checksum);
  });

  it('the computer keeps the counted goods near the end: its sites using them stop, it builds nothing new', () => {
    const w = new World(42, { players: 2, ai: [1, 2], mode: 'economy', economyGoods: GOODS });
    for (let i = 0; i < 3000; i++) w.step();
    const before = [...w.buildings.values()].filter((b) => b.owner === 1 && !b.done).length;
    expect(before).toBeGreaterThan(0);
    w.tick = economyEndTick() - AI.economyHold + 1;
    for (let i = 0; i < 400; i++) w.step();
    const sites = [...w.buildings.values()].filter((b) => b.owner === 1 && !b.done);
    // Every building site of player 1 asks for planks or stone (both counted): all stopped.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((b) => b.stopped)).toBe(true);
  });
});

describe('setup: modes', () => {
  it('cooperation puts every human in team 1 and the computers in team 2, only over the network', () => {
    const s = defaultSetup();
    s.mode = 'network';
    s.slots[1].kind = 'remote';
    s.slots[2].kind = 'ai';
    s.slots[3].kind = 'ai';
    setVictory(s, 'coop');
    expect(setupProblem(s)).toBeNull();
    const { opts } = worldArgs(s, 1);
    expect(opts.teams).toEqual([1, 1, 2, 2]);
    expect(opts.saboteurs).toBe(true);
    s.slots[2].kind = 'closed';
    s.slots[3].kind = 'closed';
    expect(setupProblem(s)).not.toBeNull();
    // A single game cannot be co-operative.
    const single = parseSetup(JSON.stringify({ ...defaultSetup(), victory: 'coop' }))!;
    expect(single.victory).toBe('conquest');
  });

  it('the economic mode draws seven goods on entering it and carries them into the world', () => {
    const s = defaultSetup();
    setVictory(s, 'economy', () => 0.5);
    expect(s.goods).toHaveLength(7);
    expect(new Set(s.goods).size).toBe(7);
    const { opts } = worldArgs(s, 3);
    expect(opts.mode).toBe('economy');
    expect(opts.economyGoods).toEqual(s.goods);
    // A single game has no saboteurs (Settlers 4: network games only).
    expect(opts.saboteurs).toBeUndefined();
    expect(randomGoods(() => 0)).toEqual(ECONOMY.pool.slice(0, 7));
    const back = parseSetup(JSON.stringify(s))!;
    expect(back.goods).toEqual(s.goods);
  });
});
