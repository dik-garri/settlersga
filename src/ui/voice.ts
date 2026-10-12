import type { AudioEngine } from '../audio/audio';
import type { Seat } from '../net/lockstep';
import { Downsampler, frameLevel, radioPress, VOICE_RATE, type NetVoice, type VoiceTo } from '../net/voice';
import { el } from './dom';
import { t } from './i18n';

/**
 * The radio's browser side (docs/NETWORK.md section 16; the routing and the codec are DOM-free in
 * `net/voice.ts`): `VoiceCapture` takes the microphone only while the radio is on the air, sampled
 * down to 16 kHz frames of 100 ms in an AudioWorklet (a ScriptProcessor where there is none);
 * `VoicePlayer` plays every speaker's frames one after another through the game's audio context, on
 * the voice bus (`AudioEngine.voiceOutput`: its own volume, not muted with M); `Radio` is the V/B
 * switch with its clicks and the «В эфире» plaque over the game.
 */

/** How far ahead a speaker's first frame (and one after a gap) is scheduled: the jitter buffer (s). */
const JITTER_S = 0.15;
/** A speaker more than this far ahead of the clock is skipped until he catches up (s). */
const MAX_AHEAD_S = 1;

/** Plays the voices: per speaker, his frames back to back. */
export class VoicePlayer {
  /** Frames scheduled and frames skipped (too far behind), for checks from DevTools. */
  scheduled = 0;
  skipped = 0;
  private readonly next = new Map<Seat, number>();

  constructor(private readonly audio: AudioEngine) {}

  play(seat: Seat, samples: Float32Array): void {
    const o = this.audio.voiceOutput();
    if (!o || o.ctx.state !== 'running') return;
    const { ctx, out } = o;
    const buffer = toBuffer(ctx, samples);
    const now = ctx.currentTime;
    let at = this.next.get(seat) ?? 0;
    // Run dry (the first frame, a gap, a late packet): start again a jitter buffer ahead.
    if (at < now + 0.01) at = now + JITTER_S;
    if (at > now + MAX_AHEAD_S) {
      this.skipped++;
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    src.onended = () => src.disconnect();
    src.start(at);
    this.next.set(seat, at + buffer.duration);
    this.scheduled++;
  }

  /** Whether a speaker's voice is still playing (scheduled past now). */
  playing(seat: Seat): boolean {
    const o = this.audio.voiceOutput();
    return !!o && (this.next.get(seat) ?? 0) > o.ctx.currentTime;
  }
}

/** A 16 kHz frame as an audio buffer (resampled to the context's rate where 16 kHz buffers are refused). */
function toBuffer(ctx: AudioContext, samples: Float32Array): AudioBuffer {
  try {
    const b = ctx.createBuffer(1, samples.length, VOICE_RATE);
    b.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    return b;
  } catch {
    const n = Math.round((samples.length * ctx.sampleRate) / VOICE_RATE);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    const k = VOICE_RATE / ctx.sampleRate;
    for (let i = 0; i < n; i++) {
      const x = i * k;
      const j = Math.floor(x);
      const a = samples[Math.min(j, samples.length - 1)];
      const c = samples[Math.min(j + 1, samples.length - 1)];
      d[i] = a + (c - a) * (x - j);
    }
    return b;
  }
}

/** The audio worklet that hands the microphone's samples to the page in blocks of 1024. */
const TAP_WORKLET = `
class SettlersVoiceTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(1024); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('settlers-voice-tap', SettlersVoiceTap);
`;

/** Why the microphone did not come on. */
export type MicProblem = 'denied' | 'noMic' | 'error';

export class MicError extends Error {
  constructor(
    readonly problem: MicProblem,
    message: string,
  ) {
    super(message);
  }
}

/** The microphone while the radio is on: 16 kHz frames of 100 ms to `onFrame`. */
export class VoiceCapture {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private stopped = false;

  /** Asks for the microphone (the browser asks the player the first time) and starts sampling. */
  async start(onFrame: (frame: Float32Array) => void): Promise<void> {
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) throw new MicError('noMic', 'getUserMedia unavailable');
    try {
      this.stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', name);
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') throw new MicError('noMic', name);
      throw new MicError('error', e instanceof Error ? e.message : String(e));
    }
    if (this.stopped) return this.stop();
    const ctx = new AudioContext();
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(this.stream);
    const down = new Downsampler(ctx.sampleRate);
    const feed = (block: Float32Array) => {
      if (this.stopped) return;
      for (const frame of down.push(block)) onFrame(frame);
    };
    // Nothing is heard locally: the tap ends in a silent gain so the graph keeps pulling it.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let tap: AudioNode;
    try {
      const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'settlers-voice-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => feed(e.data);
      tap = node;
    } catch {
      // No audio worklets (an old browser, an insecure page): the deprecated script processor.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => feed(e.inputBuffer.getChannelData(0).slice());
      tap = node;
    }
    if (this.stopped) return this.stop();
    source.connect(tap);
    tap.connect(sink);
  }

  /** Lets go of the microphone (the browser's indicator goes out). */
  stop(): void {
    this.stopped = true;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

export interface RadioOptions {
  voice: NetVoice;
  audio: AudioEngine;
  /** A line for the message ticker (no allies, no microphone). */
  toast: (text: string) => void;
}

/** The V/B radio: one air, switched on, over and off; the plaque shows it. */
export class Radio {
  /** On the air to whom (null: off). */
  on: VoiceTo | null = null;
  /** The plaque over the game while on the air. */
  readonly el = el('div', 'radio-on');
  private capture: VoiceCapture | null = null;
  private level = 0;
  private readonly label = el('span', 'radio-label');
  private readonly meter = el('span', 'radio-meter');
  private readonly bar = el('span', 'radio-bar');
  private readonly hint = el('span', 'radio-hint');

  constructor(private readonly o: RadioOptions) {
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.meter.append(this.bar);
    this.el.append(el('span', 'radio-dot'), this.label, this.meter, this.hint);
  }

  /** V (`allies`) or B (`all`) pressed. */
  press(key: VoiceTo): void {
    const step = radioPress(this.on, key, this.o.voice.hasAllies());
    if (step.refused) return this.o.toast(t('voice.noAllies'));
    if (step.on === null) return this.stop();
    const starting = this.on === null;
    this.on = step.on;
    this.o.audio.radio('radioOn');
    this.show();
    if (starting) this.open();
  }

  /** Off the air (also when the game ends). */
  stop(): void {
    if (this.on === null && !this.capture) return;
    const was = this.on;
    this.on = null;
    this.capture?.stop();
    this.capture = null;
    this.level = 0;
    if (was !== null) this.o.audio.radio('radioOff');
    this.show();
  }

  private open(): void {
    const capture = new VoiceCapture();
    this.capture = capture;
    capture
      .start((frame) => {
        if (this.capture !== capture || this.on === null) return;
        this.level = Math.max(frameLevel(frame), this.level * 0.6);
        this.o.voice.send(this.on, frame);
        this.bar.style.width = `${Math.min(100, Math.round(Math.sqrt(this.level) * 140))}%`;
      })
      .catch((e: unknown) => {
        if (this.capture !== capture) return;
        this.capture = null;
        this.on = null;
        this.o.audio.radio('radioOff');
        this.show();
        const problem = e instanceof MicError ? e.problem : 'error';
        this.o.toast(problem === 'denied' ? t('voice.denied') : problem === 'noMic' ? t('voice.noMic') : t('voice.micError'));
      });
  }

  /** Redraws the plaque (also after a change of language). */
  show(): void {
    this.el.hidden = this.on === null;
    if (this.on === null) {
      this.bar.style.width = '0';
      return;
    }
    this.el.classList.toggle('all', this.on === 'all');
    this.label.textContent = t(this.on === 'all' ? 'voice.onAll' : 'voice.onAllies');
    this.hint.textContent = t('voice.offHint', { key: this.on === 'all' ? 'B' : 'V' });
  }
}
