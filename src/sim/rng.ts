/**
 * Deterministic PRNG (mulberry32). Calling it returns floats in [0, 1).
 * `state` is the whole generator state, so it can be saved and restored.
 */
export interface Rng {
  (): number;
  state: number;
}

export function createRng(seed: number): Rng {
  const rng = (() => {
    rng.state = (rng.state + 0x6d2b79f5) >>> 0;
    let t = rng.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  rng.state = seed >>> 0;
  return rng;
}

export function randInt(rng: Rng, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}
