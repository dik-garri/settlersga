/**
 * Beds and strike, as in Settlers 4 (`CEcoSectorMgr::CalculateInitialFreeBeds`,
 * `GetNrOfCurrentTotalBeds`, `UpdateStrikeSettlers`, `CResidenceBuildingRole::Init`; manual, «Strike!»):
 * - a player has `startBeds` (`BEDS`: 10 × ⌈start carriers / 10⌉ + 10, fixed when the game starts)
 *   plus the beds of every finished house of his (`bedsOf`: as many as it releases residents);
 * - only carriers need a bed — all of them, busy or free; workers, specialists and fighters do not;
 * - every `BEDS.checkEvery` ticks the carriers beyond the beds (less those already striking) put as
 *   many free carriers on strike (`Settler.strike`): they hang about and take no job (the dispatcher
 *   skips them); with room again the latest strikers go back to work first;
 * - a new house first takes in strikers: it releases that many fewer new settlers (`houseBuilt`).
 * Strikes come from lost houses (demolished, burnt with the land) and from settlers turned back into
 * carriers, never from houses themselves: a house brings as many beds as people.
 */
import { BEDS, BUILDINGS, bedsOf, residentsOf } from './config';
import type { Building, PlayerId } from './types';
import type { World } from './world';

/** Beds a player starts with for `carriers` start carriers. */
export function startBeds(carriers: number): number {
  return BEDS.round * Math.ceil(carriers / BEDS.round) + BEDS.extra;
}

/** The player's beds: the start's plus every finished house's. */
export function bedsFor(w: World, player: PlayerId): number {
  let n = w.players[player - 1]?.startBeds ?? 0;
  for (const b of w.buildings.values()) if (b.owner === player && b.done) n += bedsOf(BUILDINGS[b.type]);
  return n;
}

/** The player's carriers (all of them, busy or free) and how many of them strike. */
export function carriersFor(w: World, player: PlayerId): { carriers: number; striking: number } {
  let carriers = 0;
  let striking = 0;
  for (const s of w.settlers) {
    if (s.owner !== player || s.kind !== 'carrier' || w.dying.has(s.id)) continue;
    carriers++;
    if (s.strike) striking++;
  }
  return { carriers, striking };
}

/** Every `BEDS.checkEvery` ticks: strikes start and end by the beds of every player. */
export function updateStrikes(w: World): void {
  if (w.tick % BEDS.checkEvery !== 0) return;
  for (const p of w.players) if (!w.isDefeated(p.id)) settleStrike(w, p.id);
}

/**
 * Settlers 4's `UpdateStrikeSettlers` for one player: carriers beyond the beds, less those striking
 * already, put that many free carriers on strike; a shortfall calls strikers back, the latest first.
 */
function settleStrike(w: World, player: PlayerId): void {
  const { carriers, striking } = carriersFor(w, player);
  let excess = carriers - bedsFor(w, player) - striking;
  if (excess === 0) return;
  if (excess > 0) {
    for (const s of w.settlers) {
      if (excess === 0) return;
      if (s.owner !== player || s.kind !== 'carrier' || s.strike || s.tasks.length > 0 || w.dying.has(s.id)) continue;
      s.strike = true;
      excess--;
    }
    return;
  }
  for (let i = w.settlers.length - 1; i >= 0 && excess < 0; i--) {
    const s = w.settlers[i];
    if (s.owner !== player || !s.strike) continue;
    delete s.strike;
    excess++;
  }
}

/**
 * A house has just been finished (`CResidenceBuildingRole::Init`): it takes in the player's strikers
 * first — it releases that many fewer new settlers (none once they fill it) — and the strike is
 * settled at once, so they go back to work.
 */
export function houseBuilt(w: World, b: Building): void {
  const { striking } = carriersFor(w, b.owner);
  if (striking > 0) b.spawned = Math.max(b.spawned, Math.min(striking, residentsOf(BUILDINGS[b.type])));
  settleStrike(w, b.owner);
}
