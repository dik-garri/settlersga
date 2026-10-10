/**
 * Plays a recorded game again without a browser (docs/NETWORK.md section 5): a replay file
 * (`window.replay.save()`) or a network game's desync report («Скачать отчёт»). Prints the state's
 * checksum by section every `--every` ticks and, for a report, checks every checksum the player's
 * browser handed in (turn, tick, sum) against the replay: the first one that fails shows the tick
 * and the sections where that browser's game left the commands' path; two players' reports side by
 * side show whose did.
 *
 *   npm run sim:replay -- report.json             # sections every 600 ticks, the report's sums checked
 *   npm run sim:replay -- report.json --every=10  # finer
 */
import { readFileSync } from 'node:fs';
import { replaySums, type DesyncFile } from '../src/net/match';
import { CHECKSUM_SECTIONS, sectionChecksums, stateChecksum } from '../src/sim/checksum';
import { playReplay, type ReplayFile } from '../src/sim/replay';

const path = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!path) {
  console.error('usage: npm run sim:replay -- <replay or desync report .json> [--every=600]');
  process.exit(2);
}
const everyArg = process.argv.find((a) => a.startsWith('--every='));
const every = everyArg ? Math.max(1, Number(everyArg.slice('--every='.length))) : 600;
const print = (w: { tick: number }) => {
  if (w.tick % every !== 0) return;
  const s = sectionChecksums(w as Parameters<typeof sectionChecksums>[0]);
  console.log(`tick ${w.tick}: ${CHECKSUM_SECTIONS.map((k) => `${k} ${s[k]}`).join(' · ')}`);
};

const raw = JSON.parse(readFileSync(path, 'utf8')) as ReplayFile | DesyncFile;
if ((raw as DesyncFile).kind === 'settlers-desync') {
  const report = raw as DesyncFile;
  if (!report.replay) {
    console.error('the report holds no replay (a game loaded from a save)');
    process.exit(2);
  }
  console.log(`desync report of seat ${report.seat} (host ${report.host}), turns of ${report.turnTicks} ticks, delay ${report.delay}`);
  if (report.desync) console.log(`desync after turn ${report.desync.turn} (last agreed: ${report.desync.agreed ?? '—'}): ${JSON.stringify(report.desync.sums)}`);
  console.log(`seed ${report.replay.seed} · ${report.replay.log.length} commands · ${report.replay.ticks} ticks · ${report.sums.length} sums to check`);
  const checks = replaySums(report, print);
  for (const c of checks) console.log(`turn ${c.turn} · tick ${c.tick} · ${c.ok ? 'matches' : `DIFFERS in ${c.differ.join(', ')}`}`);
  const bad = checks.find((c) => !c.ok);
  console.log(bad ? `first difference: turn ${bad.turn}, tick ${bad.tick} (${bad.differ.join(', ')})` : 'every sum of the report matches the replay');
} else {
  const file = raw as ReplayFile;
  console.log(`seed ${file.seed} · ${file.log.length} commands · ${file.ticks} ticks`);
  const got = stateChecksum(playReplay(file, print));
  console.log(got === file.checksum ? `ends as recorded (${got})` : `ends at ${got}, recorded ${file.checksum}`);
}
