/**
 * DevTools hooks for replays (`window.replay`, see docs/DEVELOPMENT.md): download the running game's
 * replay (seed, setup, command log, checksum) and check one — played headless in this tab, it must end
 * in the recorded state.
 */
import { stateChecksum } from '../sim/checksum';
import { replayOf, verifyReplay, type ReplayFile } from '../sim/replay';
import type { World } from '../sim/world';

export function replayTools(world: World) {
  return {
    /** The replay of the running game as data (null for a game loaded from a save). */
    data: (): ReplayFile | null => replayOf(world),
    /** Downloads it as `replay-<seed>-<tick>.json`. */
    save(): boolean {
      const file = replayOf(world);
      if (!file) return false;
      const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `replay-${file.seed}-${file.ticks}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    },
    /** Plays a replay (the running game's if none is given) and compares the final checksums. */
    check: (file?: ReplayFile) => {
      const f = file ?? replayOf(world);
      return f ? verifyReplay(f) : null;
    },
    /** The running game's state checksum. */
    checksum: () => stateChecksum(world),
  };
}
