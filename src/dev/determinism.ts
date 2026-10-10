/**
 * Cross-engine determinism check (roadmap phase 6, step 6.3; docs/NETWORK.md, section 7): a fixed set
 * of scenarios — map generation on several sizes, computer players against each other, a replay from
 * a command log — that prints `stateChecksum` at fixed checkpoints. Run it under Node (V8), Bun
 * (JavaScriptCore) and in every browser (`determinism.html`): the lines, and so the final
 * fingerprint, must be identical everywhere. Imports only the simulation, so it runs headless too.
 */
import { hashValue, stateChecksum } from '../sim/checksum';
import { TICKS_PER_SECOND } from '../sim/config';
import { playReplay, replayOf } from '../sim/replay';
import { World } from '../sim/world';

export interface Checkpoint {
  scenario: string;
  /** Where in the scenario: `gen`, `5 min`, … */
  at: string;
  checksum: string;
}

export interface Scenario {
  id: string;
  /** Plays the scenario, reporting every checkpoint as it is reached. */
  run(report: (at: string, checksum: string) => void): void;
}

const MINUTE = TICKS_PER_SECOND * 60;

/** A freshly generated world (map, start positions, start goods and people). */
function generation(seed: number, size: number, players: number): Scenario {
  return {
    id: `map ${size}×${size} · ${players}p · seed ${seed}`,
    run(report) {
      report('gen', stateChecksum(new World(seed, { size, players })));
    },
  };
}

/** Every player a computer, checksums every `every` game minutes. */
function aiGame(seed: number, size: number, players: number, minutes: number, every: number): Scenario {
  return {
    id: `AI ${size}×${size} · ${players}p · seed ${seed} · ${minutes} min`,
    run(report) {
      const ai = Array.from({ length: players }, (_, k) => k + 1);
      const w = new World(seed, { size, players, ai });
      for (let m = 1; m <= minutes; m++) {
        for (let i = 0; i < MINUTE; i++) w.step();
        if (m % every === 0) report(`${m} min`, stateChecksum(w));
      }
    },
  };
}

/**
 * A recorded game (computer players logging their commands) played again from seed, setup and log
 * with nobody thinking (`replay.ts`): both checksums must match, here and on every engine.
 */
function replayGame(seed: number, size: number, minutes: number): Scenario {
  return {
    id: `replay ${size}×${size} · 2p · seed ${seed} · ${minutes} min`,
    run(report) {
      const w = new World(seed, { size, players: 2, ai: [1, 2] });
      for (let i = 0; i < minutes * MINUTE; i++) w.step();
      const file = replayOf(w)!;
      report(`recorded (${file.log.length} cmds)`, file.checksum);
      report('replayed', stateChecksum(playReplay(JSON.parse(JSON.stringify(file)))));
    },
  };
}

/** The fixed set every engine plays. Changing it changes the reference table in docs/NETWORK.md. */
export const SCENARIOS: Scenario[] = [
  generation(1, 64, 1),
  generation(42, 64, 2),
  generation(7, 128, 4),
  generation(42, 192, 2),
  generation(7, 256, 4),
  generation(3, 512, 2),
  aiGame(42, 64, 2, 30, 5),
  aiGame(7, 128, 4, 20, 5),
  replayGame(11, 96, 15),
];

/** Plays every scenario (or those whose id contains one of `only`) and returns all checkpoints. */
export function runScenarios(onCheckpoint?: (c: Checkpoint) => void, only?: string[]): Checkpoint[] {
  const out: Checkpoint[] = [];
  for (const s of SCENARIOS) {
    if (only && only.length > 0 && !only.some((o) => s.id.includes(o))) continue;
    s.run((at, checksum) => {
      const c = { scenario: s.id, at, checksum };
      out.push(c);
      onCheckpoint?.(c);
    });
  }
  return out;
}

/** One hash over all checkpoints: equal fingerprints mean every line matched. */
export function fingerprint(checkpoints: readonly Checkpoint[]): string {
  return hashValue(checkpoints.map((c) => [c.scenario, c.at, c.checksum]));
}

/** A checkpoint as one printed line. */
export function lineOf(c: Checkpoint): string {
  return `${c.scenario.padEnd(40)} ${c.at.padEnd(20)} ${c.checksum}`;
}
