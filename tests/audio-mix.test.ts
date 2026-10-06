import { describe, expect, it } from 'vitest';
import { attenuation, DEFAULT_AUDIO, panOf, parseAudioSettings, RateLimiter, type Listener } from '../src/audio/mix';

const L: Listener = { x: 0, y: 0, halfW: 500, zoom: 1 };

describe('attenuation and pan', () => {
  it('is loudest at the screen centre and fades with distance', () => {
    expect(attenuation(0, 0, L)).toBeCloseTo(1);
    const edge = attenuation(500, 0, L);
    expect(edge).toBeGreaterThan(0.1);
    expect(edge).toBeLessThan(0.5);
    expect(attenuation(250, 0, L)).toBeGreaterThan(edge);
    expect(attenuation(1000, 0, L)).toBe(0);
    expect(attenuation(5000, 3000, L)).toBe(0);
  });

  it('weights vertical distance more (the view is wider than tall)', () => {
    expect(attenuation(0, 200, L)).toBeLessThan(attenuation(200, 0, L));
  });

  it('is quieter zoomed out', () => {
    expect(attenuation(0, 0, { ...L, zoom: 0.5 })).toBeLessThan(attenuation(0, 0, L));
  });

  it('pans left and right, clamped', () => {
    expect(panOf(0, L)).toBe(0);
    expect(panOf(-250, L)).toBeLessThan(0);
    expect(panOf(250, L)).toBeGreaterThan(0);
    expect(panOf(99999, L)).toBe(0.8);
    expect(panOf(-99999, L)).toBe(-0.8);
  });
});

describe('RateLimiter', () => {
  it('keeps a minimum gap per sound id', () => {
    const r = new RateLimiter(100, 100, 80);
    expect(r.allow('chop', 0)).toBe(true);
    expect(r.allow('chop', 50)).toBe(false);
    expect(r.allow('hammer', 50)).toBe(true);
    expect(r.allow('chop', 81)).toBe(true);
  });

  it('caps the total rate with a burst budget that refills', () => {
    const r = new RateLimiter(10, 3, 0);
    const first = [0, 1, 2, 3, 4].map((k) => r.allow(`s${k}`, 0));
    expect(first).toEqual([true, true, true, false, false]);
    // 10 per second: one more token after 100 ms.
    expect(r.allow('a', 100)).toBe(true);
    expect(r.allow('b', 100)).toBe(false);
    // Over a long busy stretch the rate converges to perSecond.
    let n = 0;
    for (let t = 1000; t < 11_000; t += 5) if (r.allow(`x${t}`, t)) n++;
    expect(n).toBeGreaterThanOrEqual(99);
    expect(n).toBeLessThanOrEqual(104);
  });
});

describe('stored settings', () => {
  it('falls back to defaults on missing or broken data', () => {
    expect(parseAudioSettings(null)).toEqual(DEFAULT_AUDIO);
    expect(parseAudioSettings('not json')).toEqual(DEFAULT_AUDIO);
    expect(parseAudioSettings('42')).toEqual(DEFAULT_AUDIO);
    expect(parseAudioSettings('{"volume":"loud","muted":1}')).toEqual(DEFAULT_AUDIO);
  });

  it('keeps valid fields and clamps the volume', () => {
    expect(parseAudioSettings('{"muted":true,"volume":3,"music":false}')).toEqual({ muted: true, volume: 1, music: false });
    expect(parseAudioSettings('{"volume":0.25}')).toEqual({ ...DEFAULT_AUDIO, volume: 0.25 });
  });
});
