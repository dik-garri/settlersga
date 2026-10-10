/**
 * Victory modes of a free game (`GAME_MODES`, Settlers 4's `CGameType::m_iMode`): the rules a world
 * was started with (`World.rules`, saved; absent = conquest without saboteurs, so older saves and
 * every conquest game are unchanged) and the economic victory check (`checkVictory`, from
 * `World.step`), as S4's `ScriptEconomyModeVictoryConditionCheck`:
 *
 * - the ordinary defeat check runs first (`World.checkDefeats`); a game conquest has already decided
 *   is not looked at again;
 * - once `ECONOMY.minutes` have been played, alliance 1 (the lowest team number; a player without a
 *   team is an alliance of his own, numbered after the teams by player id — S4 numbers the lobby's
 *   teams) and all the other players together compare, good by good of the seven chosen ones, their
 *   current stock (`economyStock`: every pile on their land, S4's `CStatistic::GetGood`); the side
 *   ahead in more goods wins, equal — the greater sum of the seven, equal again — a coin (`World.rng`);
 * - S4's result names alliance 1 or alliance 2 (event 0x37 with 1 or 2), so when alliance 1 loses
 *   only alliance 2 wins: with three or more alliances the others lose with alliance 1 although
 *   their goods counted for side 2 — Settlers 4's own rule, kept.
 *
 * The decision is stored in `World.result` (saved) with the comparison it was made on, for the end
 * screen; `World.outcome` reads it. Deterministic: plain data, the world's RNG only for the coin.
 */
import { ECONOMY, TICKS_PER_SECOND, type GameMode } from './config';
import { sitePile } from './logistics';
import { createRng } from './rng';
import { RESOURCES, type PlayerId, type Resource } from './types';
import type { World } from './world';

/** The rules a world plays by (`WorldOptions.mode`, `economyGoods`, `saboteurs`); saved with it. */
export interface GameRules {
  mode: GameMode;
  /** Economic mode: the goods compared at the end (`ECONOMY.goods` of `ECONOMY.pool`). */
  goods?: Resource[];
  /** Saboteurs may be ordered (Settlers 4: network games only). */
  saboteurs?: boolean;
}

/** One good of the economic comparison: what each side holds and who is ahead. */
export interface EconomyRow {
  res: Resource;
  /** Stock of alliance 1 (`a`) and of all the other players together (`b`). */
  a: number;
  b: number;
}

/** The economic comparison at one moment (`economyTally`). */
export interface EconomyTally {
  rows: EconomyRow[];
  /** Goods in which side a / side b is ahead. */
  winsA: number;
  winsB: number;
  sumA: number;
  sumB: number;
  /** The players of alliance 1 and of alliance 2 (the side that can win against it). */
  sideA: PlayerId[];
  sideB: PlayerId[];
}

/** How a game was decided other than by conquest (`World.result`, saved). */
export interface GameResult {
  reason: 'economy';
  tick: number;
  winners: PlayerId[];
  /** Which rule decided: more goods, the greater sum, or the coin. */
  by: 'goods' | 'sum' | 'coin';
  tally: EconomyTally;
}

/** The rules of a new world from its options; undefined for a plain conquest game (nothing saved). */
export function rulesOf(seed: number, mode: GameMode | undefined, goods: readonly Resource[] | undefined, saboteurs: boolean | undefined): GameRules | undefined {
  const m = mode ?? 'conquest';
  if (m === 'conquest' && !saboteurs) return undefined;
  const rules: GameRules = { mode: m };
  if (m === 'economy') rules.goods = economyGoods(goods, seed);
  if (saboteurs) rules.saboteurs = true;
  return rules;
}

/**
 * The goods an economic game compares: the given ones (unknown, excluded and repeated ones dropped),
 * topped up to `ECONOMY.goods` by a draw from `ECONOMY.pool` — S4's lobby draws all seven at random
 * (`CreateRandomGoods`); this draw has a stream of its own (from the seed), so it shifts nothing else.
 */
export function economyGoods(given: readonly Resource[] | undefined, seed: number): Resource[] {
  const out: Resource[] = [];
  for (const r of given ?? []) if (ECONOMY.pool.includes(r) && !out.includes(r) && out.length < ECONOMY.goods) out.push(r);
  const rng = createRng(seed ^ 0x51ed270b);
  const left = ECONOMY.pool.filter((r) => !out.includes(r));
  while (out.length < ECONOMY.goods && left.length > 0) out.push(left.splice(Math.floor(rng() * left.length), 1)[0]);
  return out;
}

/** Tick at which an economic game is decided (`ECONOMY.minutes`). */
export const economyEndTick = (): number => ECONOMY.minutes * 60 * TICKS_PER_SECOND;

/**
 * The player's current stock of every good as S4 counts it (`CStatistic::GetGood`, kept by
 * `CPile::AdjustStatistic`): every pile on his land — buildings' output, stock and input piles, a
 * site's materials not yet built in, goods on the ground. Goods in hands or packs are no pile.
 * O(buildings + stacks).
 */
export function economyStock(w: World, player: PlayerId): Record<Resource, number> {
  return stocks(w).get(player) ?? zero();
}

const zero = () => Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;

/** Every player's stock (`economyStock`), in one pass. */
function stocks(w: World): Map<PlayerId, Record<Resource, number>> {
  const out = new Map<PlayerId, Record<Resource, number>>();
  const of = (p: PlayerId) => {
    let s = out.get(p);
    if (!s) out.set(p, (s = zero()));
    return s;
  };
  for (const b of w.buildings.values()) {
    const s = of(b.owner);
    for (const r of RESOURCES) {
      s[r] += b.output[r] + b.input[r];
      if (!b.done) s[r] += sitePile(b, r);
    }
  }
  const m = w.map;
  for (const i of w.stacks) {
    const o = m.owner[i];
    if (o === 0 || m.goods[i] === 0) continue;
    of(o)[RESOURCES[m.goods[i] - 1]] += m.goodsAmount[i];
  }
  return out;
}

/**
 * The alliances in S4's numbering: by team number, then the players without a team by id. The first
 * is alliance 1, the second alliance 2.
 */
export function alliances(w: World): PlayerId[][] {
  const teams = new Map<number, PlayerId[]>();
  const alone: PlayerId[][] = [];
  for (const p of w.players) {
    if (p.team === undefined) alone.push([p.id]);
    else teams.set(p.team, [...(teams.get(p.team) ?? []), p.id]);
  }
  return [...[...teams.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids), ...alone];
}

/** The economic comparison right now (also the live view of the HUD). */
export function economyTally(w: World): EconomyTally {
  const groups = alliances(w);
  const sideA = groups[0] ?? [];
  const sideB = groups[1] ?? [];
  const all = stocks(w);
  const rows: EconomyRow[] = [];
  let winsA = 0;
  let winsB = 0;
  let sumA = 0;
  let sumB = 0;
  for (const res of w.rules?.goods ?? []) {
    let a = 0;
    let b = 0;
    for (const p of w.players) {
      const n = all.get(p.id)?.[res] ?? 0;
      if (sideA.includes(p.id)) a += n;
      else b += n;
    }
    rows.push({ res, a, b });
    if (a > b) winsA++;
    else if (a < b) winsB++;
    sumA += a;
    sumB += b;
  }
  return { rows, winsA, winsB, sumA, sumB, sideA, sideB };
}

/** S4's decision on a tally: alliance 1 (`a`) or 2 (`b`), and by which rule; `coin` is used only on a full tie. */
export function decideEconomy(t: EconomyTally, coin: () => number): { side: 'a' | 'b'; by: GameResult['by'] } {
  if (t.winsA !== t.winsB) return { side: t.winsA > t.winsB ? 'a' : 'b', by: 'goods' };
  if (t.sumA !== t.sumB) return { side: t.sumA > t.sumB ? 'a' : 'b', by: 'sum' };
  return { side: coin() < 0.5 ? 'a' : 'b', by: 'coin' };
}

/** Whether conquest has already decided the game (one alliance left standing). */
function conquered(w: World): boolean {
  return w.players.some((p) => !w.isDefeated(p.id) && w.players.every((q) => w.allied(p.id, q.id) || w.isDefeated(q.id)) && w.players.some((q) => !w.allied(p.id, q.id)));
}

/**
 * Every tick after the defeat check (`World.step`): an economic game is decided once its time is up,
 * unless conquest decided it before. Other modes need nothing here.
 */
export function checkVictory(w: World): void {
  if (w.rules?.mode !== 'economy' || w.result || w.tick < economyEndTick()) return;
  if (conquered(w)) return;
  const tally = economyTally(w);
  const { side, by } = decideEconomy(tally, () => w.rng());
  w.result = { reason: 'economy', tick: w.tick, winners: [...(side === 'a' ? tally.sideA : tally.sideB)], by, tally };
}
