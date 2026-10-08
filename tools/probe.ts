/**
 * Economy health check: plays a standard opening on several seeds for a long stretch and reports
 * production per window, losses and blocked doors. Run before and after balance or logic changes.
 *
 *   npm run sim:probe -- --seeds=42,7,123 --minutes=60 --size=64
 */
import { TICKS_PER_SECOND } from '../src/sim/config';
import { findPath } from '../src/sim/pathfinding';
import { RESOURCES, type BuildingType } from '../src/sim/types';
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
  // Standard opening: wood and stone first, housing, then the food chain around the starting pond.
  // Three woodcutters for the sawmill, as Settlers 4's pace and costs need (a woodcutter fells a tree
  // a minute, a sawmill cuts three logs a minute; buildings cost what Roman S4 ones do).
  const plan: [number, BuildingType, number, number][] = [
    [0, 'stonecutter', -5, 3],
    [0, 'woodcutter', 5, -1],
    [0, 'woodcutter', 6, -6],
    [3, 'woodcutter', 10, 0],
    [0, 'forester', 5, 3],
    [0, 'sawmill', 1, 5],
    [0, 'house_small', -3, -4],
    [3, 'house_small', 3, 3],
    [5, 'waterworks', 0, 8],
    [5, 'farm', 6, 5],
    [5, 'mill', 3, -4],
    [5, 'bakery', -5, -1],
    [5, 'house_medium', 0, -6],
    [10, 'tower', -8, -8],
    [15, 'fisher', -2, 8],
    [15, 'pigfarm', 7, -4],
    [15, 'slaughterhouse', -6, 6],
    [20, 'coalmine', -3, -8],
    [20, 'ironmine', 0, -8],
    [20, 'house_medium', 4, 8],
    [25, 'ironsmelter', -6, -4],
    [25, 'toolsmith', 6, -6],
    [25, 'house_medium', -8, 2],
  ];

  const pending = [...plan];
  const rows: string[] = [];
  let last = { ...w.stats.produced };
  const t0 = performance.now();
  for (let i = 1; i <= minutes * ticksPerMinute; i++) {
    if ((i - 1) % ticksPerMinute === 0) {
      // Due entries that found no spot (e.g. a mine before the tower widened the border) retry every minute.
      for (let k = 0; k < pending.length; k++) {
        const [minute, type, dx, dy] = pending[k];
        if (minute * ticksPerMinute <= i - 1 && placeNear(w, type, c.x + dx, c.y + dy)) pending.splice(k--, 1);
      }
    }
    w.step();
    if (i % (window * ticksPerMinute) === 0) {
      const p = w.stats.produced;
      rows.push(
        RESOURCES.filter((r) => p[r] > last[r])
          .map((r) => `${r}+${p[r] - last[r]}`)
          .join(' ') || '—',
      );
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
    `  buildings ${done}/${w.buildings.size} · settlers ${w.settlers.length} · stock ` +
      RESOURCES.filter((r) => c.output[r] > 0)
        .map((r) => `${r}:${c.output[r]}`)
        .join(' ') +
      ` · lost ${lost} · blocked doors ${blocked}` +
      (pending.length ? ` · not placed ${pending.map((p) => p[1]).join(',')}` : '') +
      ` · ${(ms / (minutes * ticksPerMinute)).toFixed(3)} ms/tick`,
  );
}
