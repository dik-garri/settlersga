import { available } from './buildings';
import { isFighter } from './military';
import type { PlayerId, Resource } from './types';
import type { World } from './world';

/** Goods the score counts as ore and as food (our Roman goods). */
export const SCORE_ORE: readonly Resource[] = ['coal', 'ironore', 'goldore'];
export const SCORE_FOOD: readonly Resource[] = ['fish', 'bread', 'meat'];

export interface Score {
  kills: number;
  settlers: number;
  fighters: number;
  gold: number;
  ore: number;
  food: number;
  buildings: number;
  /** (5 · kills + 2 · (settlers + fighters + gold) + ore + food + buildings) / 10, rounded. */
  total: number;
}

/**
 * A player's final score, Settlers 4's formula (Settlers United wiki, «score formula»): enemies killed,
 * settlers and fighters alive, gold, ore and food held (in warehouses, at buildings and on the ground,
 * `available`) and finished buildings — (5 · kills + 2 · (settlers + fighters + gold) + ore + food +
 * buildings) / 10. Derived, for the end screen and the statistics.
 */
export function scoreOf(w: World, player: PlayerId): Score {
  const kills = Object.values(w.stats.war[player]?.killed ?? {}).reduce((n, k) => n + (k ?? 0), 0);
  let settlers = 0;
  let fighters = 0;
  for (const s of w.settlers) {
    if (s.owner !== player || w.dying.has(s.id)) continue;
    if (isFighter(s)) fighters++;
    else settlers++;
  }
  let buildings = 0;
  for (const b of w.buildings.values()) if (b.owner === player && b.done) buildings++;
  const sum = (list: readonly Resource[]) => list.reduce((n, r) => n + available(w, player, r), 0);
  const gold = available(w, player, 'gold');
  const ore = sum(SCORE_ORE);
  const food = sum(SCORE_FOOD);
  const total = Math.round((5 * kills + 2 * (settlers + fighters + gold) + ore + food + buildings) / 10);
  return { kills, settlers, fighters, gold, ore, food, buildings, total };
}
