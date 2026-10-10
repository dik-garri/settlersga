import { AI_LEVEL_IDS, ECONOMY, GAME_MODES, START_CONDITIONS, type AiLevel, type GameMode, type StartLevel } from '../sim/config';
import type { Resource } from '../sim/types';
import type { WorldOptions } from '../sim/world';
import { normaliseCode } from '../net/transport';
import { t } from './i18n';
import { aiLevelName } from './names';

/**
 * The game setup, as on Settlers 4's free-game screen: map, start goods, fog and one slot per player.
 * Pure data and functions (no DOM), shared by the main menu's «Новая игра» and the network lobby of
 * phase 6: a slot is a player colour with a controller (the local human, the computer, a remote human
 * over the network, or closed), a team and the computer's difficulty. `worldArgs` turns it into the
 * `World` constructor's arguments; `launchOf` decides from the page address what to start.
 */

/** Who plays a slot. `remote` is a human over the network (phase 6; only the lobby offers it). */
export type SlotKind = 'human' | 'ai' | 'remote' | 'closed';
export const SLOT_KINDS: readonly SlotKind[] = ['human', 'ai', 'remote', 'closed'];
/** A slot kind's name for the screens. */
export const slotKindName = (k: SlotKind): string => t(`slot.${k}`);

/** Races: only the Romans play until phase 7; the others are listed so the menu has their place. */
export const RACES = [
  { id: 'romans', ready: true },
  { id: 'vikings', ready: false },
  { id: 'mayans', ready: false },
  { id: 'trojans', ready: false },
] as const;
export type RaceId = (typeof RACES)[number]['id'];
/** A race's name for the screens. */
export const raceName = (r: RaceId): string => t(`race.${r}`);

/** Player slots: one per player colour (`PLAYER_COLORS`). */
export const MAX_SLOTS = 4;
/**
 * Map sizes offered in the setup. One of our tiles is about three of Settlers 4's (`docs/PROPORTIONS.md`):
 * 128 ≈ a small S4 map (384) for two, 192 ≈ 576 for three or four, 320 ≈ 960 for up to eight.
 */
export const MAP_SIZES = [64, 96, 128, 160, 192, 256, 320, 384, 512];
/** The map size of a new game and of a development address without `?size`: two players on a small S4 map. */
export const DEFAULT_MAP_SIZE = 128;
/** The size that suits a number of players (a hint on the setup screen). */
export function sizeHint(players: number): number {
  return players <= 2 ? 128 : players <= 4 ? 192 : 320;
}

export interface SlotSetup {
  kind: SlotKind;
  /** Team number: slots with the same team are allies (never fight, win together). */
  team: number;
  /** Difficulty when the computer plays the slot. */
  level: AiLevel;
  race: RaceId;
}

export interface GameSetup {
  /** `network` = the network lobby (`lobby.ts`): same screen, players over the network allowed. */
  mode: 'single' | 'network';
  /**
   * Victory mode (`GAME_MODES`; Settlers 4's conflict, economic and cooperation modes). Default
   * `conquest`. `coop` only in the network lobby (S4: multiplayer only): every human in team 1, the
   * computers in team 2. `economy` also against computers on one machine (S4 offers it only over the
   * network; our single game stands in for a network game with computer players).
   */
  victory?: GameMode;
  /** Economic mode: the goods compared (`ECONOMY.goods` of `ECONOMY.pool`; S4 draws them at random). */
  goods?: Resource[];
  size: number;
  /** Map seed; null = a random one at the start. */
  seed: number | null;
  start: StartLevel;
  fog: boolean;
  /** Slot k is player colour k + 1; slot 0 is the local player. */
  slots: SlotSetup[];
}

const slot = (kind: SlotKind, team: number): SlotSetup => ({ kind, team, level: 'medium', race: 'romans' });

/** One computer opponent of medium difficulty on a `DEFAULT_MAP_SIZE` map. */
export function defaultSetup(): GameSetup {
  return {
    mode: 'single',
    victory: 'conquest',
    size: DEFAULT_MAP_SIZE,
    seed: null,
    start: 'medium',
    fog: true,
    slots: [slot('human', 1), slot('ai', 2), slot('closed', 3), slot('closed', 4)],
  };
}

/** Victory modes the setup offers: cooperation only over the network (Settlers 4: multiplayer only). */
export function modesFor(s: GameSetup): GameMode[] {
  return GAME_MODES.filter((m) => m !== 'coop' || s.mode === 'network');
}

/**
 * Seven distinct goods drawn at random from `ECONOMY.pool`, as Settlers 4's lobby does when it opens
 * in economic mode (`CStateLobbyGameSettings::CreateRandomGoods`). `random` is the interface's own
 * dice (the chosen goods go into the world's options, so the game stays deterministic).
 */
export function randomGoods(random: () => number = Math.random): Resource[] {
  const left = [...ECONOMY.pool];
  const out: Resource[] = [];
  while (out.length < ECONOMY.goods && left.length > 0) out.push(left.splice(Math.floor(random() * left.length), 1)[0]);
  return out;
}

/** Sets the victory mode: entering the economic mode draws its goods, as S4's lobby does. */
export function setVictory(s: GameSetup, m: GameMode, random: () => number = Math.random): void {
  s.victory = m;
  if (m === 'economy' && (s.goods?.length ?? 0) !== ECONOMY.goods) s.goods = randomGoods(random);
}

/** The slots that take part, in player order (closed ones are skipped). */
export const activeSlots = (s: GameSetup): SlotSetup[] => s.slots.filter((x) => x.kind !== 'closed');

/** Why the setup cannot start (in the interface language, for the screen), or null if it can. */
export function setupProblem(s: GameSetup): string | null {
  const active = activeSlots(s);
  if (s.slots[0]?.kind !== 'human') return t('setup.problem.firstSlot');
  if (s.slots.some((x, k) => k > 0 && x.kind === 'human')) return t('setup.problem.secondHuman');
  if (s.mode === 'single' && active.some((x) => x.kind === 'remote')) return t('setup.problem.remote');
  if (active.some((x) => !RACES.find((r) => r.id === x.race)?.ready)) return t('setup.problem.race');
  if (s.victory === 'coop') {
    if (!active.some((x) => x.kind === 'ai')) return t('setup.problem.coopNoAi');
    return null;
  }
  if (active.length > 1 && new Set(active.map((x) => x.team)).size === 1) return t('setup.problem.oneTeam');
  return null;
}

/** The `World` constructor's arguments for a setup (`seed` = the setup's or `randomSeed`). */
export function worldArgs(s: GameSetup, randomSeed: number): { seed: number; opts: WorldOptions } {
  const active = activeSlots(s);
  const ai: number[] = [];
  active.forEach((x, k) => {
    if (x.kind === 'ai') ai.push(k + 1);
  });
  const victory = s.victory ?? 'conquest';
  // Cooperation: every human (here and over the network) in team 1, the computers in team 2.
  const teams = active.map((x) => (victory === 'coop' ? (x.kind === 'ai' ? 2 : 1) : x.team));
  // Teams only matter when two players share one; otherwise everyone is on their own, as by default.
  const shared = new Set(teams).size < teams.length;
  const difficulty = active.map((x) => x.level);
  return {
    seed: s.seed ?? randomSeed,
    opts: {
      size: s.size,
      players: active.length,
      ai,
      teams: shared ? teams : undefined,
      difficulty: ai.length > 0 && difficulty.some((l) => l !== 'medium') ? difficulty : undefined,
      start: s.start,
      mode: victory === 'conquest' ? undefined : victory,
      economyGoods: victory === 'economy' ? s.goods : undefined,
      // The saboteur exists only in network games (Settlers 4).
      saboteurs: s.mode === 'network' ? true : undefined,
    },
  };
}

const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;

/** A setup read back from JSON (the address or storage), every field checked; null if unusable. */
export function parseSetup(text: string | null): GameSetup | null {
  if (!text) return null;
  let raw: Partial<GameSetup>;
  try {
    raw = JSON.parse(text) as Partial<GameSetup>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.slots)) return null;
  const def = defaultSetup();
  const slots = Array.from({ length: MAX_SLOTS }, (_, k): SlotSetup => {
    const x = (raw.slots as Partial<SlotSetup>[])[k] ?? {};
    return {
      kind: oneOf(x.kind, SLOT_KINDS, def.slots[k].kind),
      team: Number.isInteger(x.team) && x.team! >= 1 && x.team! <= MAX_SLOTS ? x.team! : k + 1,
      level: oneOf(x.level, AI_LEVEL_IDS, 'medium'),
      race: oneOf(x.race, RACES.map((r) => r.id), 'romans'),
    };
  });
  const mode = raw.mode === 'network' ? 'network' : 'single';
  let victory = oneOf(raw.victory, GAME_MODES, 'conquest');
  if (victory === 'coop' && mode !== 'network') victory = 'conquest';
  const goods = Array.isArray(raw.goods)
    ? (raw.goods as unknown[]).filter((r, k, all): r is Resource => ECONOMY.pool.includes(r as Resource) && all.indexOf(r) === k).slice(0, ECONOMY.goods)
    : [];
  return {
    mode,
    victory,
    goods: victory === 'economy' && goods.length === ECONOMY.goods ? goods : victory === 'economy' ? randomGoods() : undefined,
    size: MAP_SIZES.includes(Number(raw.size)) ? Number(raw.size) : def.size,
    seed: Number.isInteger(raw.seed) && raw.seed! >= 0 ? raw.seed! : null,
    start: oneOf(raw.start, Object.keys(START_CONDITIONS) as StartLevel[], def.start),
    fog: raw.fog !== false,
    slots,
  };
}

/** Address parameters that describe a game directly (development): they skip the menu. */
export const DEV_PARAMS = ['seed', 'size', 'players', 'teams', 'start', 'demo', 'art', 'fog', 'ai', 'levels', 'load', 'tutorial', 'mode', 'saboteurs'] as const;

/** What the page should start with, read from its address. */
export type Launch =
  | { kind: 'menu' }
  | { kind: 'setup'; setup: GameSetup }
  | { kind: 'load'; slot: string | null }
  | { kind: 'demo' }
  /** A tutorial mission (`?tutorial=<id>`, optionally `&step=<n>`, 1-based). */
  | { kind: 'tutorial'; id: string; step: number }
  /** Joining a network game by its link (`?join=<code>`): the lobby screen, connecting at once. */
  | { kind: 'join'; code: string }
  | { kind: 'dev' };

export function launchOf(params: URLSearchParams): Launch {
  if (params.has('join')) {
    const code = normaliseCode(params.get('join') ?? '');
    if (code) return { kind: 'join', code };
  }
  if (params.has('menu')) return { kind: 'menu' };
  if (params.has('game')) {
    const setup = parseSetup(params.get('game'));
    return setup && !setupProblem(setup) ? { kind: 'setup', setup } : { kind: 'menu' };
  }
  if (params.has('load')) {
    const v = params.get('load');
    // ?load=1 (or empty) = the latest save, as the single slot used to be.
    return { kind: 'load', slot: !v || v === '1' ? null : v };
  }
  if (params.has('tutorial')) {
    const step = Number(params.get('step'));
    return { kind: 'tutorial', id: params.get('tutorial') ?? '', step: Number.isInteger(step) && step > 0 ? step : 1 };
  }
  if (params.has('demo')) return { kind: 'demo' };
  if (DEV_PARAMS.some((p) => params.has(p))) return { kind: 'dev' };
  return { kind: 'menu' };
}

/**
 * The `World` arguments of a development address: `?seed`, `?size`, `?players` (default 2, all but
 * player 1 computer-controlled; `?ai=off` keeps them passive), `?teams=1,1,2,2`, `?start=low|high`,
 * `?levels=easy,hard` (difficulty per player), `?mode=economy|coop` (victory mode; `?goods=bread,coal,…`
 * the economic goods, else drawn from the seed), `?saboteurs=1` (saboteurs allowed, as in a network game).
 */
export function devWorldArgs(params: URLSearchParams, randomSeed: number): { seed: number; opts: WorldOptions } {
  const seed = params.has('seed') ? Number(params.get('seed')) : randomSeed;
  const size = params.has('size') ? Number(params.get('size')) : DEFAULT_MAP_SIZE;
  const players = params.has('players') ? Number(params.get('players')) : 2;
  const ai = params.get('ai') === 'off' ? [] : Array.from({ length: players - 1 }, (_, k) => k + 2);
  const teams = params.get('teams')?.split(',').map(Number);
  const levels = params.get('levels')?.split(',');
  const difficulty = levels?.map((l) => oneOf(l, AI_LEVEL_IDS, 'medium'));
  const v = params.get('start');
  const start: StartLevel = v === 'low' || v === 'high' ? v : 'medium';
  const mode = oneOf(params.get('mode'), GAME_MODES, 'conquest');
  const goods = params.get('goods')?.split(',').filter((r): r is Resource => ECONOMY.pool.includes(r as Resource));
  return {
    seed,
    opts: {
      size,
      players,
      ai,
      teams,
      difficulty,
      start,
      mode: mode === 'conquest' ? undefined : mode,
      economyGoods: mode === 'economy' ? goods : undefined,
      saboteurs: params.get('saboteurs') === '1' ? true : undefined,
    },
  };
}

/** Names of the difficulty levels for the screens. */
export const levelName = (l: AiLevel): string => aiLevelName(l);
