import { SEASON_TICKS, SEASONS, type SeasonDef } from './config';

export interface SeasonInfo {
  index: number;
  def: SeasonDef;
  /** 0 at the start of the season, → 1 at its end. */
  progress: number;
  /** Years completed (the first year is 0). */
  year: number;
}

/** The season at a tick. Pure: the season is a function of time only, so it needs no saved state. */
export function seasonAt(tick: number): SeasonInfo {
  const n = Math.floor(tick / SEASON_TICKS);
  const index = n % SEASONS.length;
  return {
    index,
    def: SEASONS[index],
    progress: (tick % SEASON_TICKS) / SEASON_TICKS,
    year: Math.floor(n / SEASONS.length),
  };
}
