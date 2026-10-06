/**
 * Economy health check: plays a standard opening on several seeds for a long stretch and reports
 * production per window, losses and blocked doors. Run before and after balance or logic changes.
 *
 *   npm run sim:probe -- --seeds=42,7,123 --minutes=60 --size=64
 */
import { TICKS_PER_SECOND } from '../src/sim/config';
import { findPath } from '../src/sim/pathfinding';
import { RESOURCES } from '../src/sim/types';
import { World } from '../src/sim/world';
import { arg, placeNear } from './scenario';

const seeds = arg('seeds', '42,7,123,999').split(',').map(Number);
const minutes = Number(arg('minutes', '60'));
const size = Number(arg('size', '64'));
const window = Number(arg('window', '20'));
const ticksPerMinute = TICKS_PER_SECOND * 60;

for (const seed of seeds) {
  const w = new World(seed, { size });
  const c = w.castle;
  placeNear(w, 'stonecutter', c.x - 5, c.y + 3);
  placeNear(w, 'woodcutter', c.x + 5, c.y - 1);
  placeNear(w, 'forester', c.x + 5, c.y + 3);
  placeNear(w, 'sawmill', c.x + 1, c.y + 5);

  const rows: string[] = [];
  let last = { ...w.stats.produced };
  const t0 = performance.now();
  for (let i = 1; i <= minutes * ticksPerMinute; i++) {
    w.step();
    if (i === 10 * ticksPerMinute) placeNear(w, 'tower', c.x - 8, c.y - 8);
    if (i % (window * ticksPerMinute) === 0) {
      const p = w.stats.produced;
      rows.push(RESOURCES.map((r) => `${r}+${p[r] - last[r]}`).join(' '));
      last = { ...p };
    }
  }
  const ms = performance.now() - t0;
  const door = c.door;
  const blocked = [...w.buildings.values()].filter((b) => !findPath(w.map, door.x, door.y, b.door.x, b.door.y)).length;
  const done = [...w.buildings.values()].filter((b) => b.done).length;
  const lost = RESOURCES.map((r) => w.stats.lost[r]).reduce((a, b) => a + b, 0);
  console.log(`seed ${seed}`);
  rows.forEach((r, k) => console.log(`  ${(k * window).toString().padStart(3)}–${(k + 1) * window} min: ${r}`));
  console.log(
    `  buildings ${done}/${w.buildings.size} · settlers ${w.settlers.length} · stock ${JSON.stringify(c.output)}` +
      ` · lost ${lost} · blocked doors ${blocked} · ${(ms / (minutes * ticksPerMinute)).toFixed(3)} ms/tick`,
  );
}
