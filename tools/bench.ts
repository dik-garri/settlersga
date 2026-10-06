/**
 * Simulation performance benchmark: a large map fully claimed by one player, production clusters
 * spread over it and a target number of settlers. Reports milliseconds per tick.
 *
 *   npm run sim:bench -- --size=256 --settlers=1000 --ticks=3000
 */
import { spawnSettler } from '../src/sim/buildings';
import { TOOLS } from '../src/sim/config';
import { pathStats } from '../src/sim/pathfinding';
import { World } from '../src/sim/world';
import { arg, placeNear } from './scenario';

const size = Number(arg('size', '256'));
const target = Number(arg('settlers', '1000'));
const ticks = Number(arg('ticks', '3000'));
const seed = Number(arg('seed', '42'));

const w = new World(seed, { size });
// Bench shortcut: the whole map belongs to the player, so clusters can go anywhere.
w.map.owner.fill(1);
w.territoryVersion++;

let clusters = 0;
for (let cy = 12; cy < size - 8; cy += 16) {
  for (let cx = 12; cx < size - 8; cx += 16) {
    const built = [
      placeNear(w, 'woodcutter', cx, cy, 6),
      placeNear(w, 'forester', cx + 4, cy, 6),
      placeNear(w, 'sawmill', cx, cy + 4, 6),
      placeNear(w, 'stonecutter', cx + 4, cy + 4, 6),
    ].filter((b) => b !== null);
    for (const b of built) b.done = true;
    if (built.length > 0) clusters++;
  }
}
// Every workplace needs its tool (phase 1.3); give the castle enough for all of them.
for (const tool of TOOLS) w.castle.output[tool] = 1000;
while (w.settlers.length < target) spawnSettler(w, 'carrier', w.castle);

const warmup = 600;
for (let i = 0; i < warmup; i++) w.step();
let worst = 0;
Object.assign(pathStats, { calls: 0, failures: 0, expanded: 0, expandedInFailures: 0 });
const t0 = performance.now();
for (let done = 0; done < ticks; done += 100) {
  const s = performance.now();
  for (let i = 0; i < 100; i++) w.step();
  worst = Math.max(worst, (performance.now() - s) / 100);
}
const avg = (performance.now() - t0) / ticks;
const busy = w.settlers.filter((s) => s.tasks.length > 0).length;
console.log(
  `map ${size}×${size} · ${clusters} clusters · ${w.buildings.size} buildings · ${w.settlers.length} settlers (${busy} busy)`,
);
console.log(`avg ${avg.toFixed(3)} ms/tick · worst 100-tick window ${worst.toFixed(3)} ms/tick · budget at 10 ticks/s: 100 ms`);
console.log(
  `A*: ${(pathStats.calls / ticks).toFixed(2)} searches/tick · ${((100 * pathStats.failures) / Math.max(1, pathStats.calls)).toFixed(1)}% failed` +
    ` · ${Math.round(pathStats.expanded / Math.max(1, pathStats.calls))} nodes/search` +
    ` · ${((100 * pathStats.expandedInFailures) / Math.max(1, pathStats.expanded)).toFixed(0)}% of nodes in failed searches`,
);
