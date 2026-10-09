import { AI_LEVELS, BUILDINGS, STRENGTH } from './config';
import type { PlayerId, Settler } from './types';
import type { World } from './world';

/**
 * Fighting strength, after Settlers 4 (see `STRENGTH`): a player's settlement value — wood and stone
 * built into their finished buildings, gold worth more, eyecatchers' materials several times over —
 * buys attack strength along diminishing steps, from a start that depends on the number of players.
 * Fighters on their own or an ally's land always fight at 100 %; on anyone else's land, at their
 * owner's attack strength. Defence is 100 % until attack strength passes it, then grows at half its
 * pace (applied where a fighter defends his own land).
 *
 * Values are derived from the buildings, never saved; they are computed once per tick per world.
 */

/**
 * Settlement value of a player: material points in their finished buildings (`STRENGTH`). A computer
 * player of a level with `strengthDouble` (Settlers 4's AI from «normal» on,
 * `SPlayerStatistic::CalculateFightingStrength`) counts every building's materials twice instead of
 * its eyecatchers' extra.
 */
export function settlementValue(w: World, player: PlayerId): number {
  const level = w.aiLevel(player);
  const double = !!level && AI_LEVELS[level].strengthDouble;
  let value = 0;
  for (const b of w.buildings.values()) {
    if (b.owner !== player || !b.done) continue;
    const def = BUILDINGS[b.type];
    const k = double ? 2 : def.eyecatcher ? STRENGTH.eyecatcher : 1;
    const c = def.cost;
    value += k * (((c.plank ?? 0) + (c.log ?? 0) + (c.stone ?? 0)) * STRENGTH.points + (c.gold ?? 0) * STRENGTH.goldPoints);
  }
  return value;
}

/** Attack strength in per cent for a settlement value, among `players` players. */
export function strengthFor(value: number, players: number): number {
  let pct = Math.max(STRENGTH.min, STRENGTH.start - STRENGTH.perPlayer * Math.max(0, players - 1));
  let left = value;
  for (const [upTo, perPercent] of STRENGTH.steps) {
    if (pct >= upTo) continue;
    const gain = Math.min(upTo - pct, left / perPercent);
    pct += gain;
    left -= gain * perPercent;
    if (left <= 0) break;
  }
  return Math.min(STRENGTH.max, Math.round(pct * 10) / 10);
}

const cache = new WeakMap<World, { tick: number; pct: Map<PlayerId, number> }>();

/** The player's attack strength on foreign land, in per cent. */
export function attackStrength(w: World, player: PlayerId): number {
  let c = cache.get(w);
  if (!c || c.tick !== w.tick) {
    c = { tick: w.tick, pct: new Map() };
    cache.set(w, c);
  }
  let pct = c.pct.get(player);
  if (pct === undefined) {
    pct = strengthFor(settlementValue(w, player), w.players.length);
    c.pct.set(player, pct);
  }
  return pct;
}

/** The player's defence strength in per cent: 100 until attack strength passes it, then half its pace. */
export function defenceStrength(w: World, player: PlayerId): number {
  const a = attackStrength(w, player);
  return a <= 100 ? 100 : 100 + (a - 100) / 2;
}

/**
 * Multiplier on a fighter's strength where he stands: his owner's defence strength on his own or an
 * ally's land, his attack strength anywhere else (neutral land counts as foreign).
 */
export function fieldFactor(w: World, s: Settler): number {
  const m = w.map;
  const x = Math.round(s.x);
  const y = Math.round(s.y);
  const owner = m.inBounds(x, y) ? m.owner[m.idx(x, y)] : 0;
  const home = owner !== 0 && (owner === s.owner || w.allied(owner, s.owner));
  return (home ? defenceStrength(w, s.owner) : attackStrength(w, s.owner)) / 100;
}
