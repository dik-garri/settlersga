import type { AudioEngine } from '../audio/audio';
import type { Seat } from '../net/lockstep';
import { Downsampler, frameLevel, playout, radioPress, VOICE_RATE, type NetVoice, type Playout, type VoiceTo } from '../net/voice';
import { el } from './dom';
import { t } from './i18n';

/**
 * The radio's browser side (docs/NETWORK.md section 16; the routing, the codec and the playout
 * schedule are DOM-free in `net/voice.ts`): `VoiceCapture` takes the microphone only while the radio
 * is on the air, sampled down to 16 kHz frames of 40 ms in an AudioWorklet (a ScriptProcessor where
 * there is none); `VoicePlayer` plays every speaker's frames one after another through the game's
 * audio context, on the voice bus (`AudioEngine.voiceOutput`: its own volume, not muted with M),
 * catching up when they come in a bunch (`playout`); `Radio` is the V/B switch with its clicks, the
 * «В эфире» plaque over the game and the line of who is talking now.
 */

/** A smoothed mouth-to-ear delay per speaker (ms) moves this share of the way to each new frame's. */
const LAG_SMOOTH = 0.2;

/** Plays the voices: per speaker, his frames back to back. */
export class VoicePlayer {
  /** Frames scheduled and frames dropped to catch up, for checks from DevTools. */
  scheduled = 0;
  skipped = 0;
  /** The most any speaker's voice was queued ahead of the clock (s), for checks from DevTools. */
  maxAhead = 0;
  /**
   * Per speaker, the delay from his mouth to our ear (ms, smoothed): the frame's travel (`transit`,
   * on the host's clock), its time queued here, its own length (its last sample was spoken when it
   * was sent) and the output's latency. Not counted: the microphone's own input latency and up to one
   * worklet block (≈ 11 ms) before the frame is complete.
   */
  readonly lags = new Map<Seat, number>();
  private readonly queues = new Map<Seat, Playout>();

  constructor(private readonly audio: AudioEngine) {}

  play(seat: Seat, samples: Float32Array, transit: number | null = null): void {
    const o = this.audio.voiceOutput();
    if (!o || o.ctx.state !== 'running') return;
    const { ctx, out } = o;
    const buffer = toBuffer(ctx, samples);
    const now = ctx.currentTime;
    let q = this.queues.get(seat);
    if (!q) this.queues.set(seat, (q = { next: 0, catching: false }));
    const at = playout(q, now, buffer.duration, frameLevel(samples));
    if (at === null) {
      this.skipped++;
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    src.onended = () => src.disconnect();
    src.start(at);
    this.scheduled++;
    this.maxAhead = Math.max(this.maxAhead, q.next - now);
    if (transit !== null) {
      const output = ctx.outputLatency || ctx.baseLatency || 0;
      const lag = transit + (at - now + buffer.duration + output) * 1000;
      const old = this.lags.get(seat);
      this.lags.set(seat, old === undefined ? lag : old + LAG_SMOOTH * (lag - old));
    }
  }

  /** Whether a speaker's voice is still playing (scheduled past now). */
  playing(seat: Seat): boolean {
    const o = this.audio.voiceOutput();
    return !!o && (this.queues.get(seat)?.next ?? 0) > o.ctx.currentTime;
  }

  /** How far a speaker's voice is queued ahead of the clock now (s). */
  ahead(seat: Seat): number {
    const o = this.audio.voiceOutput();
    return o ? Math.max(0, (this.queues.get(seat)?.next ?? 0) - o.ctx.currentTime) : 0;
  }

  /** A speaker's mouth-to-ear delay (ms), null before his first frame with a known travel time. */
  lag(seat: Seat): number | null {
    return this.lags.get(seat) ?? null;
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

/** The audio worklet that hands the microphone's samples to the page in blocks of 512 (≈ 11 ms at 48 kHz). */
const TAP_WORKLET = `
class SettlersVoiceTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(512); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(512); this.n = 0; }
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

/** The microphone while the radio is on: 16 kHz frames of 40 ms to `onFrame`. */
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
      const node = ctx.createScriptProcessor(2048, 1, 1);
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
  /** A line for the message ticker (no allies, no microphone, the headphones hint). */
  toast: (text: string) => void;
  /** Who is talking now as heard here, and to whom (`NetVoice.talking`). */
  talking: () => Map<Seat, VoiceTo>;
  /** A seat's player name. */
  nameOf: (seat: Seat) => string;
  /** Whether this browser muted a seat's voice. */
  muted: (seat: Seat) => boolean;
}

/** How often the line of who is talking is redrawn (ms). */
const TALKERS_EVERY_MS = 150;

/**
 * The V/B radio: one air, switched on, over and off; the plaque shows it. Under the plaque, the line
 * of everybody talking now as heard here («Говорят: Вася → союзникам, Петя → всем») — voices mix,
 * as in a conference call, and this says whose they are.
 */
export class Radio {
  /** On the air to whom (null: off). */
  on: VoiceTo | null = null;
  /** The plaque and the talkers' line over the game. */
  readonly el = el('div', 'radio');
  private readonly plaque = el('div', 'radio-on');
  private readonly talkers = el('div', 'radio-talkers');
  private capture: VoiceCapture | null = null;
  private level = 0;
  /** The headphones hint was shown in this game. */
  private hinted = false;
  private talkersKey = '';
  private lastTalkers = -Infinity;
  private readonly label = el('span', 'radio-label');
  private readonly meter = el('span', 'radio-meter');
  private readonly bar = el('span', 'radio-bar');
  private readonly hint = el('span', 'radio-hint');

  constructor(private readonly o: RadioOptions) {
    this.plaque.hidden = true;
    this.plaque.setAttribute('role', 'status');
    this.plaque.setAttribute('aria-live', 'polite');
    this.meter.append(this.bar);
    this.plaque.append(el('span', 'radio-dot'), this.label, this.meter, this.hint);
    this.talkers.hidden = true;
    this.el.append(this.plaque, this.talkers);
  }

  /** Redraws the line of who is talking (from the frame loop; throttled). */
  update(nowMs: number): void {
    if (nowMs - this.lastTalkers < TALKERS_EVERY_MS) return;
    this.lastTalkers = nowMs;
    const list = [...this.o.talking()].sort((a, b) => a[0] - b[0]).map(([seat, to]) => ({ seat, to, muted: this.o.muted(seat) }));
    const key = JSON.stringify(list);
    if (key === this.talkersKey) return;
    this.talkersKey = key;
    this.talkers.hidden = list.length === 0;
    this.talkers.replaceChildren();
    if (list.length === 0) return;
    this.talkers.append(el('span', 'radio-talkers-head', t('voice.talking')));
    for (const { seat, to, muted } of list) {
      const text = t('voice.talker', { who: this.o.nameOf(seat), to: t(to === 'all' ? 'voice.toAll' : 'voice.toAllies') });
      this.talkers.append(el('span', `radio-talker${to === 'all' ? ' all' : ''}${muted ? ' muted' : ''}`, muted ? t('voice.talkerMuted', { text }) : text));
    }
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
    // Voices from loudspeakers go back into the microphone: say it once a game.
    if (!this.hinted) {
      this.hinted = true;
      this.o.toast(t('voice.headphones'));
    }
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
        this.level = Math.max(frameLevel(frame), this.level * 0.8);
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

  /** Redraws the plaque, and the talkers' line on the next update (also after a change of language). */
  show(): void {
    this.talkersKey = '';
    this.lastTalkers = -Infinity;
    this.plaque.hidden = this.on === null;
    if (this.on === null) {
      this.bar.style.width = '0';
      return;
    }
    this.plaque.classList.toggle('all', this.on === 'all');
    this.label.textContent = t(this.on === 'all' ? 'voice.onAll' : 'voice.onAllies');
    this.hint.textContent = t('voice.offHint', { key: this.on === 'all' ? 'B' : 'V' });
  }
}
