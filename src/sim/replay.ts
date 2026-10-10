/**
 * Replays (roadmap phase 6): a game is its seed, its setup (`WorldOptions`) and the log of commands
 * applied to it (`World.commandLog`, `commands.ts`). Playing that log in a fresh world made with the
 * same seed and options — the computer players not thinking, their logged commands applied instead
 * (`WorldOptions.replay`) — gives the same world, which `stateChecksum` confirms.
 */
import { stateChecksum } from './checksum';
import type { CommandRecord } from './commands';
import { World, type WorldOptions } from './world';

export const REPLAY_VERSION = 1;

/** Everything a replay needs, as plain JSON. */
export interface ReplayFile {
  version: number;
  seed: number;
  options: WorldOptions;
  /** Ticks the recorded game had run when the replay was taken. */
  ticks: number;
  log: CommandRecord[];
  /** `stateChecksum` of the recorded world at `ticks`. */
  checksum: string;
}

/** The replay of a world made from a seed (null for one loaded from a save: its start is the save). */
export function replayOf(w: World): ReplayFile | null {
  if (!w.origin) return null;
  return JSON.parse(
    JSON.stringify({
      version: REPLAY_VERSION,
      seed: w.origin.seed,
      options: w.origin.options,
      ticks: w.tick,
      log: w.commandLog,
      checksum: stateChecksum(w),
    }),
  ) as ReplayFile;
}

/**
 * Plays a replay in a fresh world up to its `ticks` (then applies what was given after the last
 * tick) and returns that world; `onTick` sees every step.
 */
export function playReplay(file: ReplayFile, onTick?: (w: World) => void): World {
  if (file.version !== REPLAY_VERSION) throw new Error(`unsupported replay version ${file.version}`);
  const w = new World(file.seed, { ...file.options, replay: file.log });
  while (w.tick < file.ticks) {
    w.step();
    onTick?.(w);
  }
  w.flushCommands();
  return w;
}

/** Plays a replay and tells whether it ends in the recorded state. */
export function verifyReplay(file: ReplayFile): { ok: boolean; expected: string; got: string } {
  const got = stateChecksum(playReplay(file));
  return { ok: got === file.checksum, expected: file.checksum, got };
}
