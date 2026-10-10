/**
 * Cross-engine determinism check (docs/NETWORK.md, section 7): plays the fixed scenarios of
 * `src/dev/determinism.ts` and prints `stateChecksum` at every checkpoint plus one fingerprint over
 * all of them. Run it under every engine and compare the output:
 *
 *   npm run sim:determinism                      # Node (V8)
 *   bun tools/determinism.ts                     # Bun (JavaScriptCore)
 *   npm run sim:determinism -- --only=map,replay # only scenarios whose id contains one of these
 *
 * In browsers: `determinism.html` on the dev server.
 */
import { fingerprint, lineOf, runScenarios } from '../src/dev/determinism';

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined;
const engine = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined' ? 'Bun (JavaScriptCore)' : `Node ${process.version} (V8)`;
console.log(`engine: ${engine}`);
const t0 = performance.now();
const all = runScenarios((c) => console.log(lineOf(c)), only);
console.log(`fingerprint: ${fingerprint(all)} · ${all.length} checkpoints · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
