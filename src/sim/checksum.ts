/**
 * A checksum of the simulation state (roadmap phase 6): lockstep peers compare it every few ticks to
 * notice a desync, and a replay compares it with the recorded game's.
 *
 * It covers what a save holds (`save.ts`): every saved map layer, read straight from its typed array,
 * and the rest of the state walked canonically — object keys sorted, keys holding `undefined`
 * skipped (as JSON drops them), −0 counted as 0 —, so it does not depend on the order objects got
 * their keys in. Two exceptions: the computer players' own memory (`AiState`) is left out — it is
 * not the world, and a replay without thinking computer players has none of it —, and the reserved
 * tile sets are hashed sorted. Cost: one pass over the map layers, four bytes at a time, plus the
 * objects — ≈ 1.3 ms on 64×64 with a few hundred settlers, ≈ 13 ms on 1024×1024 (the layers).
 */
import { SAVED_LAYERS } from './save';
import type { World } from './world';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** FNV-1a over 32-bit words, with tags so values of different types never collide by layout. */
class StateHash {
  h = 0x811c9dc5;

  word(v: number): void {
    this.h = Math.imul(this.h ^ (v | 0), 0x01000193);
  }

  num(v: number): void {
    if (v === 0) v = 0; // −0 counts as 0
    if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) {
      this.word(6);
      this.word(v);
      return;
    }
    this.word(5);
    f64[0] = Number.isNaN(v) ? NaN : v;
    this.word(u32[0]);
    this.word(u32[1]);
  }

  str(s: string): void {
    this.word(7);
    this.word(s.length);
    for (let i = 0; i < s.length; i++) this.word(s.charCodeAt(i));
  }

  /** A typed array, four bytes at a time (little-endian, as every browser runs). */
  layer(a: ArrayBufferView): void {
    this.word(9);
    this.word(a.byteLength);
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const whole = a.byteOffset % 4 === 0 ? a.byteLength >> 2 : 0;
    const words = new Int32Array(a.buffer, a.byteOffset, whole);
    let h = this.h;
    for (let i = 0; i < whole; i++) h = Math.imul(h ^ words[i], 0x01000193);
    for (let i = whole << 2; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
    this.h = h;
  }

  value(v: unknown): void {
    if (v === null) return this.word(1);
    switch (typeof v) {
      case 'undefined':
        return this.word(2);
      case 'boolean':
        return this.word(v ? 4 : 3);
      case 'number':
        return this.num(v);
      case 'string':
        return this.str(v);
      case 'object':
        break;
      default:
        throw new Error(`stateChecksum: cannot hash a ${typeof v}`);
    }
    if (Array.isArray(v)) {
      this.word(8);
      this.word(v.length);
      for (const x of v) this.value(x);
      return;
    }
    if (ArrayBuffer.isView(v)) return this.layer(v);
    if (v instanceof Map || v instanceof Set) throw new Error('stateChecksum: Map/Set is not plain state');
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    this.word(10);
    this.word(keys.length);
    for (const k of keys) {
      this.str(k);
      this.value(o[k]);
    }
  }
}

/** Hash of any plain JSON-like value, independent of object key order (exported for tests). */
export function hashValue(v: unknown): string {
  const h = new StateHash();
  h.value(v);
  return (h.h >>> 0).toString(16).padStart(8, '0');
}

/** The simulation state's checksum, eight hex digits: equal worlds give equal sums on every machine. */
export function stateChecksum(w: World): string {
  const h = new StateHash();
  h.word(w.map.w);
  h.word(w.map.h);
  for (const layer of SAVED_LAYERS) h.layer(w.map[layer]);
  h.value({
    tick: w.tick,
    nextId: w.nextId,
    rngState: w.rng.state,
    territoryVersion: w.territoryVersion,
    stats: w.stats,
    players: w.players,
    buildings: [...w.buildings.values()],
    settlers: w.settlers,
    reservedTargets: [...w.reservedTargets].sort((a, b) => a - b),
    reservedPlots: [...w.reservedPlots].sort((a, b) => a - b),
    defeated: w.defeated,
    animals: w.animals,
    nextAnimalId: w.nextAnimalId,
    animalRngState: w.animalRng.state,
    idleRngState: w.idleRng.state,
    commands: w.pendingCommands,
    commandSeq: w.nextCommandSeq,
  });
  return (h.h >>> 0).toString(16).padStart(8, '0');
}
