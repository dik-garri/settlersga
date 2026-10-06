/**
 * Computer players against each other (or against a passive player 1), headless. Prints each side's
 * growth every few minutes and how the game ends.
 *
 *   npm run sim:ai -- --seeds=42,7 --minutes=60 --players=2 --passive=0
 */
import { TICKS_PER_SECOND } from '../src/sim/config';
import { isArcher, isFighter } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';
import { arg } from './scenario';

const seeds = arg('seeds', '42,7,123').split(',').map(Number);
const minutes = Number(arg('minutes', '60'));
const size = Number(arg('size', '64'));
const players = Number(arg('players', '2'));
const passive = arg('passive', '0') === '1';
const every = Number(arg('every', '10'));
const perMinute = TICKS_PER_SECOND * 60;

for (const seed of seeds) {
  const ai = Array.from({ length: players }, (_, k) => k + 1).filter((p) => !(passive && p === 1));
  const w = new World(seed, { size, players, ai });
  console.log(`seed ${seed} · ${size}×${size} · players ${players} · AI ${ai.join(',')}${passive ? ' · player 1 passive' : ''}`);
  const t0 = performance.now();
  let end = '';
  for (let i = 1; i <= minutes * perMinute; i++) {
    w.step();
    if (i % (every * perMinute) === 0 || (w.defeated.length > 0 && !end)) {
      if (w.defeated.length > 0 && !end) end = `player ${w.defeated.join(',')} defeated at ${(i / perMinute).toFixed(1)} min`;
      const rows = w.players.map((p) => {
        const own = [...w.buildings.values()].filter((b) => b.owner === p.id);
        const done = own.filter((b) => b.done).length;
        const people = w.settlers.filter((s) => s.owner === p.id);
        const fighters = people.filter((s) => isFighter(s));
        const archers = fighters.filter((s) => isArcher(s)).length;
        const ranked = fighters.filter((s) => s.level > 0).length;
        const soldiers = `${fighters.length} (archers ${archers}, ranked ${ranked})`;
        let land = 0;
        for (const o of w.map.owner) if (o === p.id) land++;
        const st = w.ai.find((a) => a.player === p.id)?.stats;
        const ai = st ? ` · placed ${st.placed} attacks ${st.attacks} (sent ${st.soldiersSent}) geo ${st.geologists}` : '';
        const out = w.isDefeated(p.id) ? ' DEFEATED' : '';
        return `  p${p.id}: buildings ${done}/${own.length} · settlers ${people.length} · soldiers ${soldiers} · land ${land}${ai}${out}`;
      });
      console.log(`  ${(i / perMinute).toFixed(0).padStart(3)} min`);
      rows.forEach((r) => console.log(r));
      if (w.outcome(1) !== 'playing' && players === 2) break;
    }
  }
  console.log(`  result: ${end || 'nobody defeated'} · ${((performance.now() - t0) / (w.tick || 1)).toFixed(3)} ms/tick`);
}

/**
 * The computer players' own share of the tick cost: continue one mid-game position (from a save)
 * for the same number of ticks with and without the AI, alternating to even out machine load.
 */
if (arg('cost', '0') === '1') {
  const base = new World(seeds[0], { size, players, ai: Array.from({ length: players }, (_, k) => k + 1) });
  for (let i = 0; i < 20 * perMinute; i++) base.step();
  const save = JSON.stringify(saveWorld(base));
  const timed = (withAi: boolean) => {
    const w = World.load(JSON.parse(save));
    if (!withAi) w.ai.length = 0;
    const t = performance.now();
    for (let i = 0; i < 3 * perMinute; i++) w.step();
    return (performance.now() - t) / (3 * perMinute);
  };
  const runs = { with: [] as number[], without: [] as number[] };
  for (let k = 0; k < 3; k++) {
    runs.with.push(timed(true));
    runs.without.push(timed(false));
  }
  const best = (xs: number[]) => Math.min(...xs).toFixed(3);
  console.log(`cost at minute 20: ${best(runs.with)} ms/tick with AI, ${best(runs.without)} without (best of 3)`);
}
