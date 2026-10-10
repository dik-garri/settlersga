/**
 * Deterministic math for the simulation (roadmap phase 6, step 6.3; docs/NETWORK.md, section 7).
 *
 * Lockstep play needs every JavaScript engine — V8 (Chrome, Node), SpiderMonkey (Firefox),
 * JavaScriptCore (Safari, Bun) — to compute the same bits. The language only guarantees that for the
 * correctly rounded IEEE 754 operations `+ − × ÷` and `Math.sqrt` (plus exact integer operations and
 * `Math.floor/ceil/round/trunc/abs/min/max/sign/imul/fround`); `Math.hypot`, `sin`, `cos`, `pow`,
 * `exp`, `log`, `**` and the like are "implementation-approximated" and do differ in the last bit
 * between engines. Simulation code therefore uses only the helpers below for anything beyond the
 * elementary operations; `tests/determinism.test.ts` forbids the rest in `src/sim`.
 */
/** Squared length of (dx, dy): exact for integers, the cheapest way to compare distances. */
export function dist2(dx: number, dy: number): number {
  return dx * dx + dy * dy;
}

/**
 * Length of (dx, dy) — the deterministic `Math.hypot` for two arguments: a correctly rounded square
 * root of the squared length (exact for integers), the same bits on every engine.
 */
export function hypot(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy);
}

/** Whether (dx, dy) lies within `r` (inclusive), without a square root. `r` must not be negative. */
export function within(dx: number, dy: number, r: number): boolean {
  return dx * dx + dy * dy <= r * r;
}

/** `x` to a non-negative integer power by repeated squaring (exact operations only). */
export function ipow(x: number, n: number): number {
  let out = 1;
  let base = x;
  for (let k = n; k > 0; k >>= 1) {
    if (k & 1) out *= base;
    base *= base;
  }
  return out;
}

// Sine and cosine after fdlibm (`k_sin.c`, `k_cos.c`, `s_sin.c`, `s_cos.c` and the small and medium
// cases of `e_rem_pio2.c`), written with `+ − × ÷` only. fdlibm compares high words of the IEEE
// representation; the thresholds below are those high words as numbers, and exponents are found by
// exact doubling, so no engine-specific bit access is needed.
const INV_PIO2 = 6.36619772367581382433e-1;
const PIO2_1 = 1.57079632673412561417; // the first 33 bits of π/2
const PIO2_1T = 6.07710050650619224932e-11; // π/2 − PIO2_1
const PIO2_2 = 6.07710050630396597660e-11; // the next 33 bits of π/2
const PIO2_2T = 2.02226624879595063154e-21; // π/2 − (PIO2_1 + PIO2_2)
const PIO2_3 = 2.02226624871116645580e-21; // the next 33 bits of π/2
const PIO2_3T = 8.47842766036889956997e-32; // π/2 − (PIO2_1 + PIO2_2 + PIO2_3)

const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;

const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.0875723212981748279e-9;
const C6 = -1.13596475577881948265e-11;

/** 2^-27: below it sin x = x and cos x = 1 (high word 0x3e400000). */
const TINY = 7.450580596923828e-9;
/** High word 0x3fe921fc: up to here no reduction (just above π/4). */
const NO_REDUCE = 0.7853984832763672;
/** High word 0x4002d97c: below it (≈ 3π/4) the quadrant is ±1. */
const THREE_PIO4 = 2.3561935424804688;
/** High words 0x3ff921fb … 0x3ff921fc: arguments this close to π/2 need 66 bits of π/2. */
const NEAR_PIO2_LO = 1.570796012878418;
const NEAR_PIO2_HI = 1.5707969665527344;
/** High word 0x413921fc: fdlibm's medium case ends here (≈ 2^19·π/2). */
const MAX_ARG = 1647100;

/** The binary exponent of a positive finite v (v in [2^e, 2^(e+1))), by exact doubling and halving. */
function exponentOf(v: number): number {
  let e = 0;
  let p = 1;
  while (v >= p * 2) {
    p *= 2;
    e++;
  }
  while (v < p) {
    p /= 2;
    e--;
  }
  return e;
}

/** fdlibm's exponent field of |v| minus the bias, with 0 (and subnormals) at −1023. */
function expOrZero(v: number): number {
  const a = Math.abs(v);
  return a < 2.2250738585072014e-308 ? -1023 : exponentOf(a);
}

/** sin(x + y) for |x| ≤ π/4; `tail` says y is a reduction tail (fdlibm's iy = 1). */
function kSin(x: number, y: number, tail: boolean): number {
  if (Math.abs(x) < TINY) return x;
  const z = x * x;
  const v = z * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  if (!tail) return x + v * (S1 + z * r);
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

/** cos(x + y) for |x| ≤ π/4, y the tail of x. */
function kCos(x: number, y: number): number {
  const ax = Math.abs(x);
  if (ax < TINY) return 1;
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  if (ax < 0.2999999523162842) return 1 - (0.5 * z - (z * r - x * y)); // high word 0x3fd33333
  // fdlibm's qx: |x|/4 with the low word cleared, or 0.28125 above high word 0x3fe90000.
  const qx = ax >= 0.7812504768371582 ? 0.28125 : truncHigh(ax / 4);
  const hz = 0.5 * z - qx;
  const a = 1 - qx;
  return a - (hz - (z * r - x * y));
}

/** Positive normal v with the low 32 bits of its mantissa cleared (20 fraction bits kept); exact. */
function truncHigh(v: number): number {
  let unit = 1;
  for (let e = exponentOf(v) - 20; e > 0; e--) unit *= 2;
  for (let e = exponentOf(v) - 20; e < 0; e++) unit /= 2;
  return Math.floor(v / unit) * unit;
}

/** x reduced by multiples of π/2 (fdlibm's `__ieee754_rem_pio2` for |x| < 2^19·π/2): quadrant, head, tail. */
function remPio2(x: number): [number, number, number] {
  const t = Math.abs(x);
  const sign = x < 0 ? -1 : 1;
  let n: number;
  let y0: number;
  let y1: number;
  if (t < THREE_PIO4) {
    n = 1;
    let z = t - PIO2_1;
    if (t < NEAR_PIO2_LO || t >= NEAR_PIO2_HI) {
      y0 = z - PIO2_1T;
      y1 = z - y0 - PIO2_1T;
    } else {
      z -= PIO2_2;
      y0 = z - PIO2_2T;
      y1 = z - y0 - PIO2_2T;
    }
  } else {
    n = Math.floor(t * INV_PIO2 + 0.5);
    let r = t - n * PIO2_1;
    let w = n * PIO2_1T;
    y0 = r - w;
    const j = exponentOf(t);
    if (j - expOrZero(y0) > 16) {
      // Cancellation: a second (and maybe third) round with more bits of π/2.
      let u = r;
      w = n * PIO2_2;
      r = u - w;
      w = n * PIO2_2T - (u - r - w);
      y0 = r - w;
      if (j - expOrZero(y0) > 49) {
        u = r;
        w = n * PIO2_3;
        r = u - w;
        w = n * PIO2_3T - (u - r - w);
        y0 = r - w;
      }
    }
    y1 = r - y0 - w;
  }
  return [sign * n, sign * y0, sign * y1];
}

/** Deterministic `Math.sin` (radians, |x| below about 1.6·10^6). */
export function dsin(x: number): number {
  if (Math.abs(x) < NO_REDUCE) return kSin(x, 0, false);
  if (!(Math.abs(x) < MAX_ARG)) throw new RangeError(`dsin: argument out of range: ${x}`);
  const [n, y0, y1] = remPio2(x);
  switch (n & 3) {
    case 0:
      return kSin(y0, y1, true);
    case 1:
      return kCos(y0, y1);
    case 2:
      return -kSin(y0, y1, true);
    default:
      return -kCos(y0, y1);
  }
}

/** Deterministic `Math.cos` (radians, |x| below about 1.6·10^6). */
export function dcos(x: number): number {
  if (Math.abs(x) < NO_REDUCE) return kCos(x, 0);
  if (!(Math.abs(x) < MAX_ARG)) throw new RangeError(`dcos: argument out of range: ${x}`);
  const [n, y0, y1] = remPio2(x);
  switch (n & 3) {
    case 0:
      return kCos(y0, y1);
    case 1:
      return -kSin(y0, y1, true);
    case 2:
      return -kCos(y0, y1);
    default:
      return kSin(y0, y1, true);
  }
}
