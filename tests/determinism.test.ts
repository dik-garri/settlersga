/**
 * Determinism across JavaScript engines (roadmap phase 6, step 6.3; docs/NETWORK.md, section 7): the
 * simulation uses no engine-approximated math (only `fmath.ts`), and `fmath.ts` itself gives fixed bits.
 * The full cross-engine check is `npm run sim:determinism` / `determinism.html`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint, runScenarios } from '../src/dev/determinism';
import { dcos, dist2, dsin, hypot, ipow, within } from '../src/sim/fmath';
import { startPositions } from '../src/sim/world';

/** `Math` functions the language leaves to the engine ("implementation-approximated"). */
const APPROXIMATED =
  /\bMath\.(hypot|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|random)\b/;

describe('the simulation uses deterministic math only', () => {
  it('no engine-approximated Math function or ** operator in src/sim outside comments and fmath.ts', () => {
    const dir = join(__dirname, '../src/sim');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'fmath.ts')) {
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const line = code.split('\n').find((x) => APPROXIMATED.test(x) || /\*\*/.test(x));
      expect(line, file).toBeUndefined();
    }
  });
});

describe('fmath', () => {
  it('hypot, dist2 and within are exact on integers', () => {
    expect(hypot(3, 4)).toBe(5);
    expect(hypot(5, 12)).toBe(13);
    expect(hypot(-20, 21)).toBe(29);
    expect(dist2(-3, 4)).toBe(25);
    expect(within(5, 12, 13)).toBe(true);
    expect(within(5, 12, 12.999)).toBe(false);
    expect(within(0.5, 0, 0.5)).toBe(true);
  });

  it('ipow multiplies exactly', () => {
    expect(ipow(2, 10)).toBe(1024);
    expect(ipow(3, 0)).toBe(1);
    expect(ipow(0.5, 6)).toBe(0.015625);
    expect(ipow(-3, 3)).toBe(-27);
  });

  it('dsin/dcos give these exact bits on every engine', () => {
    const xs = [0.5, 1, 2, 3, Math.PI / 4, Math.PI / 3, (2 * Math.PI) / 3, Math.PI / 2, Math.PI, (5 * Math.PI) / 4, 1e-3, 10, 100, -2.5];
    expect(xs.map((x) => [dsin(x), dcos(x)])).toEqual([
      [0.479425538604203, 0.8775825618903728],
      [0.8414709848078965, 0.5403023058681398],
      [0.9092974268256817, -0.4161468365471424],
      [0.1411200080598672, -0.9899924966004454],
      [0.7071067811865475, 0.7071067811865476],
      [0.8660254037844386, 0.5000000000000001],
      [0.8660254037844387, -0.4999999999999998],
      [1, 6.123233995736766e-17],
      [1.2246467991473532e-16, -1],
      [-0.7071067811865475, -0.7071067811865477],
      [0.0009999998333333417, 0.9999995000000417],
      [-0.5440211108893698, -0.8390715290764524],
      [-0.5063656411097588, 0.8623188722876839],
      [-0.5984721441039564, -0.8011436155469337],
    ]);
  });

  it('dsin/dcos stay within two units in the last place of the engine', () => {
    let seed = 12345;
    for (let i = 0; i < 20000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const x = (seed / 2147483648 - 0.5) * 200;
      for (const [f, g] of [
        [dsin, Math.sin],
        [dcos, Math.cos],
      ] as const) {
        const want = g(x);
        expect(Math.abs(f(x) - want), `${f.name}(${x})`).toBeLessThanOrEqual(4.5e-16 * Math.max(Math.abs(want), 1e-3));
      }
    }
    expect(() => dsin(Infinity)).toThrow();
    expect(() => dcos(NaN)).toThrow();
  });

  it('start positions come from dsin/dcos', () => {
    expect(startPositions(128, 3)).toEqual([
      { x: 91, y: 91 },
      { x: 27, y: 74 },
      { x: 74, y: 27 },
    ]);
    expect(startPositions(256, 8).map((p) => `${p.x},${p.y}`).join(' ')).toBe(
      '182,182 128,205 74,182 51,128 74,74 128,51 182,74 205,128',
    );
  });
});

describe('cross-engine scenarios', () => {
  it('play the same twice in one engine (the tool itself is deterministic)', () => {
    const a = runScenarios(undefined, ['map 64×64', 'map 128×128']);
    expect(a.length).toBe(3);
    expect(fingerprint(runScenarios(undefined, ['map 64×64', 'map 128×128']))).toBe(fingerprint(a));
  });
});
