/**
 * Procedural sound effects: every sound is synthesised with WebAudio nodes when played, no sample
 * files. A recipe gets the context, the node to connect to (already panned and attenuated), the
 * start time and a small random variation so repeated sounds do not sound identical.
 *
 * To add a sound: add its id to `SoundId` (`render/animConfig.ts`) and a recipe here; then trigger
 * it from an `ActionDef.sound`, a `BuildingFx.sound` or a renderer `sound(...)` call.
 */
import type { SoundId } from '../render/animConfig';

type Recipe = (ctx: AudioContext, out: AudioNode, t: number, vary: number) => void;

let noiseBuffer: AudioBuffer | null = null;

/** One second of white noise, shared by every noisy sound. */
function noise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    // A tiny LCG is plenty for noise.
    let s = 12345;
    for (let i = 0; i < d.length; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      d[i] = (s / 0xffffffff) * 2 - 1;
    }
  }
  return noiseBuffer;
}

/** Gain envelope: quick attack to `peak`, exponential decay over `decay` seconds. */
function env(ctx: AudioContext, out: AudioNode, t: number, peak: number, decay: number, attack = 0.004): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  g.connect(out);
  return g;
}

/** Filtered noise burst. */
function burst(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  type: BiquadFilterType,
  freq: number,
  q: number,
  peak: number,
  decay: number,
  freqEnd?: number,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(freqEnd, t + decay);
  f.Q.value = q;
  src.connect(f);
  f.connect(env(ctx, out, t, peak, decay));
  src.start(t, Math.random() * 0.5);
  src.stop(t + decay + 0.05);
}

/** Oscillator tone with an optional pitch glide. */
function tone(
  ctx: AudioContext,
  out: AudioNode,
  t: number,
  type: OscillatorType,
  freq: number,
  peak: number,
  decay: number,
  freqEnd?: number,
  attack?: number,
): void {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd !== undefined) o.frequency.exponentialRampToValueAtTime(freqEnd, t + decay);
  o.connect(env(ctx, out, t, peak, decay, attack));
  o.start(t);
  o.stop(t + decay + 0.05);
}

/** Inharmonic partials: metal ringing. */
function ring(ctx: AudioContext, out: AudioNode, t: number, base: number, ratios: number[], peak: number, decay: number): void {
  ratios.forEach((r, k) => tone(ctx, out, t, 'sine', base * r, peak / (k + 1.5), decay / (1 + k * 0.4)));
}

export const RECIPES: Record<SoundId, Recipe> = {
  // Axe biting wood: a dull knock plus a woody crack.
  chop: (ctx, out, t, v) => {
    tone(ctx, out, t, 'sine', 170 * v, 0.7, 0.09, 90);
    burst(ctx, out, t, 'bandpass', 1300 * v, 1.4, 0.55, 0.07);
  },
  // Hammer on wood and nails.
  hammer: (ctx, out, t, v) => {
    tone(ctx, out, t, 'triangle', 420 * v, 0.35, 0.06, 260);
    ring(ctx, out, t, 1650 * v, [1, 1.53, 2.31], 0.18, 0.12);
    burst(ctx, out, t, 'highpass', 2500, 0.7, 0.25, 0.03);
  },
  // Pick on stone: bright clink and gravel.
  pick: (ctx, out, t, v) => {
    ring(ctx, out, t, 2300 * v, [1, 1.41, 2.04], 0.22, 0.09);
    burst(ctx, out, t, 'bandpass', 3200, 0.9, 0.35, 0.06);
    burst(ctx, out, t + 0.03, 'lowpass', 900, 0.5, 0.2, 0.12);
  },
  // Shovel into soil: a soft scrape.
  dig: (ctx, out, t, v) => {
    burst(ctx, out, t, 'lowpass', 1400 * v, 0.8, 0.5, 0.16, 500);
    tone(ctx, out, t, 'sine', 120, 0.25, 0.07, 80);
  },
  // Scythe swish.
  reap: (ctx, out, t, v) => burst(ctx, out, t, 'bandpass', 4200 * v, 2.5, 0.35, 0.22, 1600),
  // Saw strokes: a buzzy rasp, back and forth.
  saw: (ctx, out, t, v) => {
    for (let k = 0; k < 3; k++) {
      const s = t + k * 0.28;
      burst(ctx, out, s, 'bandpass', (k % 2 ? 2600 : 3100) * v, 3, 0.28, 0.22);
      tone(ctx, out, s, 'sawtooth', (k % 2 ? 130 : 150) * v, 0.05, 0.2, undefined, 0.05);
    }
  },
  // Water: a falling noise sweep and a couple of bubbles.
  splash: (ctx, out, t, v) => {
    burst(ctx, out, t, 'lowpass', 2600 * v, 0.7, 0.5, 0.35, 350);
    tone(ctx, out, t + 0.05, 'sine', 600 * v, 0.12, 0.08, 1100);
    tone(ctx, out, t + 0.14, 'sine', 750 * v, 0.08, 0.07, 1300);
  },
  // Swords meeting: ringing metal over a short scrape.
  clash: (ctx, out, t, v) => {
    ring(ctx, out, t, 1450 * v, [1, 1.62, 2.47, 3.3], 0.3, 0.35);
    burst(ctx, out, t, 'highpass', 3500, 0.7, 0.35, 0.05);
  },
  // A blow landing.
  hit: (ctx, out, t, v) => {
    tone(ctx, out, t, 'sine', 110 * v, 0.6, 0.12, 55);
    burst(ctx, out, t, 'lowpass', 800, 0.7, 0.3, 0.06);
  },
  // Bow string: a plucked, falling twang.
  twang: (ctx, out, t, v) => {
    tone(ctx, out, t, 'triangle', 260 * v, 0.35, 0.22, 190);
    tone(ctx, out, t, 'sine', 520 * v, 0.12, 0.12, 380);
    burst(ctx, out, t, 'highpass', 5000, 0.7, 0.12, 0.02);
  },
  // A building is finished: a bright three-note chime.
  complete: (ctx, out, t) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => {
      tone(ctx, out, t + k * 0.09, 'sine', f, 0.28, 0.7);
      tone(ctx, out, t + k * 0.09, 'triangle', f * 2, 0.04, 0.3);
    });
  },
  // UI button.
  click: (ctx, out, t) => {
    tone(ctx, out, t, 'sine', 1800, 0.18, 0.03, 1200, 0.002);
    burst(ctx, out, t, 'highpass', 4000, 0.7, 0.06, 0.015);
  },
  // A tree creaks over and lands with a thump and rustle.
  fall: (ctx, out, t, v) => {
    tone(ctx, out, t, 'sawtooth', 95 * v, 0.04, 0.55, 55, 0.2);
    burst(ctx, out, t + 0.62, 'lowpass', 500, 0.7, 0.7, 0.3, 120);
    tone(ctx, out, t + 0.62, 'sine', 70, 0.6, 0.25, 40);
    burst(ctx, out, t + 0.66, 'bandpass', 3000, 0.8, 0.22, 0.45, 1500);
  },
  // Furnace breath.
  hiss: (ctx, out, t, v) => burst(ctx, out, t, 'bandpass', 900 * v, 0.6, 0.3, 0.8, 600),
};
