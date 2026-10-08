/**
 * Economy health check: plays a standard opening on several seeds for a long stretch and reports
 * production per window, losses and blocked doors. Run before and after balance or logic changes.
 *
 *   npm run sim:probe -- --seeds=42,7,123 --minutes=60 --size=64
 */
import { BUILDINGS, TICKS_PER_SECOND } from '../src/sim/config';
import { findPath } from '../src/sim/pathfinding';
import { pilesUsed } from '../src/sim/storage';
import { RESOURCES, type BuildingType, type Resource } from '../src/sim/types';
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
  // Offsets from the start position (the castle's footprint centre, rounded).
  const cx = Math.round(c.x + (c.w - 1) / 2);
  const cy = Math.round(c.y + (c.h - 1) / 2);
  // Standard opening: wood and stone first, housing, then the food chain around the starting pond.
  // Three woodcutters for the sawmill, as Settlers 4's pace and costs need (a woodcutter fells a tree
  // a minute, a sawmill cuts three logs a minute; buildings cost what Roman S4 ones do).
  const plan: [number, BuildingType, number, number][] = [
    [0, 'stonecutter', -6, 2],
    [0, 'woodcutter', 4, -2],
    [0, 'woodcutter', 5, -7],
    [3, 'woodcutter', 9, -1],
    [0, 'forester', 4, 2],
    [0, 'sawmill', 0, 4],
    [0, 'house_small', -4, -5],
    [3, 'house_small', 2, 2],
    [5, 'waterworks', -1, 7],
    [5, 'farm', 5, 4],
    [5, 'mill', 2, -5],
    [5, 'bakery', -6, -2],
    [5, 'house_medium', -1, -7],
    [10, 'tower', -9, -9],
    [15, 'fisher', -3, 7],
    [15, 'pigfarm', 6, -5],
    [15, 'slaughterhouse', -7, 5],
    [20, 'coalmine', -4, -9],
    [20, 'ironmine', -1, -9],
    [20, 'house_medium', 3, 7],
    [25, 'ironsmelter', -7, -5],
    [25, 'toolsmith', 5, -7],
    [25, 'house_medium', -9, 1],
    // Warehouses hold 8 piles of 8 (Settlers 4) and the castle 40: coal and ore fill them by the half hour.
    [20, 'warehouse', -3, -11],
    [35, 'warehouse', 8, 8],
  ];

  const pending = [...plan];
  const rows: string[] = [];
  let last = { ...w.stats.produced };
  const t0 = performance.now();
  for (let i = 1; i <= minutes * ticksPerMinute; i++) {
    if ((i - 1) % ticksPerMinute === 0) {
      // Due entries that found no spot (e.g. a mine before the tower widened the border) retry every
      // minute; ten minutes overdue they look further (a 3×3 pig farm in a full core goes out on the
      // tower's land).
      for (let k = 0; k < pending.length; k++) {
        const [minute, type, dx, dy] = pending[k];
        if (minute * ticksPerMinute > i - 1) continue;
        const radius = i - 1 >= (minute + 10) * ticksPerMinute ? 24 : 12;
        if (placeNear(w, type, cx + dx, cy + dy, radius)) pending.splice(k--, 1);
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
  // Stock: the castle and the warehouses together; `full` = piles in use of all their piles.
  const stores = [...w.buildings.values()].filter((b) => b.done && BUILDINGS[b.type].storage);
  const stock = (r: Resource) => stores.reduce((n, b) => n + b.output[r], 0);
  const piles = stores.reduce((n, b) => n + pilesUsed(b, BUILDINGS[b.type].storage!), 0);
  const maxPiles = stores.reduce((n, b) => n + (BUILDINGS[b.type].storage!.piles ?? 0), 0);
  console.log(
    `  buildings ${done}/${w.buildings.size} · settlers ${w.settlers.length} · ${stores.length} stores, piles ${piles}/${maxPiles} · stock ` +
      RESOURCES.filter((r) => stock(r) > 0)
        .map((r) => `${r}:${stock(r)}`)
        .join(' ') +
      ` · lost ${lost} · blocked doors ${blocked}` +
      (pending.length ? ` · not placed ${pending.map((p) => p[1]).join(',')}` : '') +
      ` · ${(ms / (minutes * ticksPerMinute)).toFixed(3)} ms/tick`,
  );
}
