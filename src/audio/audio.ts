/**
 * WebAudio engine: positional sound effects (synthesised in `sounds.ts`), a soft generative music
 * loop and bird calls. Nothing is created until the first user gesture (browsers block audio
 * before that); settings persist in localStorage.
 *
 * Signal path: effect → panner → sfx bus ┐
 *              music voices → echo → music bus ┴→ master → speakers
 */
import type { SoundId } from '../render/animConfig';
import { attenuation, DEFAULT_AUDIO, panOf, parseAudioSettings, RateLimiter, type AudioSettings, type Listener } from './mix';
import { RECIPES } from './sounds';

const STORAGE_KEY = 'settlers.audio';
const SFX_LEVEL = 0.55;
const MUSIC_LEVEL = 0.11;
/** Sounds quieter than this after attenuation are skipped. */
const MIN_GAIN = 0.03;

/** G major pentatonic, the music's whole vocabulary (Hz, octave 4). */
const SCALE = [392.0, 440.0, 493.88, 587.33, 659.25];
/** Pad chords (root position, octave 3), eight seconds each. */
const CHORDS = [
  [196.0, 246.94, 293.66], // G
  [164.81, 196.0, 246.94], // Em
  [130.81, 164.81, 196.0], // C
  [146.83, 185.0, 220.0], // D
];
const CHORD_S = 8;

/**
 * The title theme (our own tune, played once by the intro): a horn melody over swelling chords and a
 * few drum strokes, in the music's G major. Beats at `THEME_BPM`; notes as [Hz, beats], chords and
 * drums as [beat, …].
 */
const THEME_BPM = 72;
const THEME_MELODY: [number, number][] = [
  [392.0, 1], [587.33, 1], [493.88, 0.5], [523.25, 0.5], [587.33, 2],
  [659.25, 1], [587.33, 0.5], [493.88, 0.5], [440.0, 2],
  [493.88, 1], [523.25, 0.5], [587.33, 0.5], [659.25, 1], [739.99, 1], [783.99, 4],
];
const THEME_CHORDS: [number, number, number[]][] = [
  [0, 5, CHORDS[0]],
  [5, 2, CHORDS[1]],
  [7, 2, CHORDS[2]],
  [9, 3, CHORDS[3]],
  [12, 6, CHORDS[0]],
];
const THEME_DRUMS: [number, number][] = [
  [0, 1], [5, 0.6], [9, 0.8], [11.5, 0.5], [12, 1],
];
/** Length of the theme in beats (the generative music resumes after it). */
const THEME_BEATS = 18;

function loadSettings(): AudioSettings {
  try {
    return parseAudioSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage blocked (private mode, sandbox): defaults, not persisted.
    return { ...DEFAULT_AUDIO };
  }
}

export class AudioEngine {
  readonly settings: AudioSettings = loadSettings();
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private music: GainNode | null = null;
  private echo: DelayNode | null = null;
  private readonly limiter = new RateLimiter(14, 8, 70);
  private readonly listener: Listener = { x: 0, y: 0, halfW: 1, zoom: 1 };
  private nextChord = 0;
  private chord = 0;
  private nextNote = 0;
  private note = 2;
  private nextBirds = 0;

  /** Call from a user gesture: creates (or resumes) the audio context. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = SFX_LEVEL;
      this.sfx.connect(this.master);
      this.music = ctx.createGain();
      this.music.connect(this.master);
      // A long, soft echo gives the music some space.
      this.echo = ctx.createDelay(1);
      this.echo.delayTime.value = 0.42;
      const feedback = ctx.createGain();
      feedback.gain.value = 0.35;
      const wet = ctx.createGain();
      wet.gain.value = 0.4;
      this.echo.connect(feedback).connect(this.echo);
      this.echo.connect(wet).connect(this.music);
      this.applySettings();
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) void ctx.suspend();
        else void ctx.resume();
      });
    } catch {
      this.ctx = null;
    }
  }

  get started(): boolean {
    return this.ctx !== null;
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.save();
  }

  setVolume(volume: number): void {
    this.settings.volume = Math.min(1, Math.max(0, volume));
    this.save();
  }

  setMusic(on: boolean): void {
    this.settings.music = on;
    this.save();
  }

  private save(): void {
    this.applySettings();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Not persisted; the session still uses the new settings.
    }
  }

  private applySettings(): void {
    if (!this.ctx || !this.master || !this.music) return;
    const t = this.ctx.currentTime;
    const v = this.settings.muted ? 0 : this.settings.volume;
    this.master.gain.setTargetAtTime(v * v, t, 0.05);
    this.music.gain.setTargetAtTime(this.settings.music ? MUSIC_LEVEL : 0, t, 0.4);
  }

  /** Where the camera is (world pixels at the screen centre, half the visible width, zoom). */
  listen(x: number, y: number, halfW: number, zoom: number): void {
    const l = this.listener;
    l.x = x;
    l.y = y;
    l.halfW = halfW;
    l.zoom = zoom;
  }

  /** A sound at a world point: attenuated by distance to the camera centre, panned, rate-limited. */
  at(id: SoundId, x: number, y: number): void {
    if (!this.ctx || this.settings.muted || this.ctx.state !== 'running') return;
    const gain = attenuation(x, y, this.listener);
    if (gain < MIN_GAIN) return;
    if (!this.limiter.allow(id, performance.now())) return;
    this.play(id, gain, panOf(x, this.listener));
  }

  /** A non-positional sound (UI). */
  ui(id: SoundId): void {
    if (!this.ctx || this.settings.muted || this.ctx.state !== 'running') return;
    this.play(id, 0.8, 0);
  }

  private play(id: SoundId, gain: number, pan: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.sfx!);
    RECIPES[id](ctx, g, ctx.currentTime + 0.005, 0.92 + Math.random() * 0.16);
    // Disconnect the voice's mixer once its tail is over so nodes can be collected.
    setTimeout(() => p.disconnect(), 2500);
  }

  /** Schedules music and ambience a little ahead; call every frame. */
  update(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.settings.muted) return;
    const t = ctx.currentTime;
    if (this.settings.music) {
      if (this.nextChord < t + 0.5) {
        this.nextChord = Math.max(this.nextChord, t + 0.1);
        this.pad(this.nextChord, CHORDS[this.chord]);
        this.chord = (this.chord + 1) % CHORDS.length;
        this.nextChord += CHORD_S;
      }
      if (this.nextNote < t + 0.3) {
        this.nextNote = Math.max(this.nextNote, t + 0.1);
        // A slow random walk over the pentatonic scale, with rests.
        if (Math.random() < 0.6) {
          this.note = Math.max(0, Math.min(SCALE.length * 2 - 1, this.note + Math.floor(Math.random() * 5) - 2));
          const f = SCALE[this.note % SCALE.length] * (this.note >= SCALE.length ? 2 : 1);
          this.pluck(this.nextNote, f);
        }
        this.nextNote += [0.6, 0.9, 1.2, 1.8][Math.floor(Math.random() * 4)];
      }
    }
    if (this.nextBirds < t) {
      if (this.nextBirds > 0) this.birds(t + 0.05);
      this.nextBirds = t + 7 + Math.random() * 12;
    }
  }

  /**
   * Plays the title theme once (the intro calls it, after a gesture has unlocked the audio); the
   * generative music picks up when it ends. Does nothing while muted or with the music off.
   */
  theme(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || this.settings.muted || !this.settings.music) return;
    const beat = 60 / THEME_BPM;
    const t0 = ctx.currentTime + 0.15;
    for (const [b, len, chord] of THEME_CHORDS) this.pad(t0 + b * beat, chord, len * beat, Math.min(1.2, len * beat * 0.4));
    let b = 0;
    for (const [f, len] of THEME_MELODY) {
      this.horn(t0 + b * beat, f, len * beat);
      b += len;
    }
    for (const [at, v] of THEME_DRUMS) this.drum(t0 + at * beat, v);
    // The title theme stands in front; the background music after it is quieter again.
    this.music!.gain.setTargetAtTime(MUSIC_LEVEL * 1.8, ctx.currentTime, 0.2);
    this.music!.gain.setTargetAtTime(MUSIC_LEVEL, t0 + THEME_BEATS * beat, 1.5);
    this.nextChord = t0 + THEME_BEATS * beat;
    this.nextNote = this.nextChord + 2;
    this.chord = 1;
  }

  private pad(t: number, chord: number[], dur = CHORD_S, attack = 2.5): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + attack);
    g.gain.setValueAtTime(0.22, t + Math.max(attack, dur - 1));
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 2);
    lp.connect(g).connect(this.music!);
    for (const f of chord) {
      for (const detune of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 2.1);
      }
    }
  }

  /** A soft brass-like note: two detuned saws through a low-pass that opens with the attack, light vibrato. */
  private horn(t: number, f: number, dur: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2;
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1800, t + 0.12);
    lp.frequency.linearRampToValueAtTime(1100, t + Math.max(0.2, dur));
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.09);
    g.gain.setValueAtTime(0.28, t + Math.max(0.1, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.35);
    lp.connect(g);
    g.connect(this.music!);
    g.connect(this.echo!);
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const depth = ctx.createGain();
    depth.gain.value = f * 0.004;
    vib.connect(depth);
    for (const detune of [-5, 5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f / 2;
      o.detune.value = detune;
      depth.connect(o.frequency);
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.4);
    }
    vib.start(t);
    vib.stop(t + dur + 0.4);
  }

  /** A deep drum stroke (a falling sine with a short noise-free click), `v` = 0..1 strength. */
  private drum(t: number, v: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9 * v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    o.connect(g).connect(this.music!);
    o.start(t);
    o.stop(t + 1);
  }

  private pluck(t: number, f: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    g.connect(this.music!);
    g.connect(this.echo!);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f;
    o.connect(g);
    o.start(t);
    o.stop(t + 1.5);
  }

  /** A short bird call: a few quick rising whistles. */
  private birds(t: number): void {
    const ctx = this.ctx!;
    const n = 2 + Math.floor(Math.random() * 3);
    const base = 2200 + Math.random() * 1400;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    pan.connect(this.sfx!);
    for (let k = 0; k < n; k++) {
      const s = t + k * 0.13;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(base, s);
      o.frequency.exponentialRampToValueAtTime(base * 1.5, s + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.05, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.09);
      o.connect(g).connect(pan);
      o.start(s);
      o.stop(s + 0.1);
    }
    setTimeout(() => pan.disconnect(), 2000);
  }
}
