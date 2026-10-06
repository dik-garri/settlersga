/**
 * Pure mixing rules for positional sound effects: how loud and how far left/right a sound at a
 * world point is, and how often sounds may start. No WebAudio here, so it is unit-tested.
 */

/** The listener: camera centre and half the visible width, in world pixels, plus the zoom. */
export interface Listener {
  x: number;
  y: number;
  halfW: number;
  zoom: number;
}

/**
 * Gain (0..1) of a sound at world point (x, y). Full volume near the screen centre, fading to a
 * quarter at the screen edge and to nothing at twice that distance; zoomed out, everything is a
 * bit quieter so a busy overview does not roar.
 */
export function attenuation(x: number, y: number, l: Listener): number {
  // Isometric screens are twice as wide as tall in tiles; weight vertical distance accordingly.
  const d = Math.hypot(x - l.x, (y - l.y) * 1.6) / Math.max(1, l.halfW);
  const near = Math.max(0, 1 - d / 2);
  const zoomGain = Math.min(1, Math.max(0.35, l.zoom));
  return near * near * zoomGain;
}

/** Stereo position (−1 left … 1 right), never fully hard-panned. */
export function panOf(x: number, l: Listener): number {
  const p = (x - l.x) / Math.max(1, l.halfW);
  return Math.max(-0.8, Math.min(0.8, p * 0.8));
}

/**
 * Throttles sound starts: each sound id at most once per `minGapMs`, and all sounds together at
 * most `burst` at once, refilling at `perSecond` (a token bucket). Busy scenes thus sound busy
 * without a hundred axes landing in the same frame.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill = 0;
  private readonly last = new Map<string, number>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly minGapMs: number,
  ) {
    this.tokens = burst;
  }

  /** Whether a sound `id` may start at `nowMs`; consumes a token when it may. */
  allow(id: string, nowMs: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.lastRefill) / 1000) * this.perSecond);
    this.lastRefill = nowMs;
    const prev = this.last.get(id);
    if (prev !== undefined && nowMs - prev < this.minGapMs) return false;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    this.last.set(id, nowMs);
    return true;
  }
}

/** Audio settings as stored in localStorage. */
export interface AudioSettings {
  muted: boolean;
  /** Master volume 0..1. */
  volume: number;
  music: boolean;
}

export const DEFAULT_AUDIO: AudioSettings = { muted: false, volume: 0.7, music: true };

/** Parses stored settings, falling back to defaults field by field on anything malformed. */
export function parseAudioSettings(raw: string | null): AudioSettings {
  let o: Partial<AudioSettings> = {};
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') o = v as Partial<AudioSettings>;
  } catch {
    // Ignore: defaults below.
  }
  const volume = typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : DEFAULT_AUDIO.volume;
  return {
    muted: typeof o.muted === 'boolean' ? o.muted : DEFAULT_AUDIO.muted,
    volume,
    music: typeof o.music === 'boolean' ? o.music : DEFAULT_AUDIO.music,
  };
}
