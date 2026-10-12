import { RateLimit, type ChatTo } from './chat';
import type { Seat } from './lockstep';
import type { PeerId, Transport } from './transport';

/**
 * The voice of a network game, «рация» (docs/NETWORK.md section 16): a player holds V (allies) or B
 * (everybody) on, his microphone is sampled down to 16 kHz, coded as 8-bit μ-law (G.711) in frames of
 * 100 ms, and every frame goes as base64 text over the game's own transport, on its own channel
 * (`ch: 'voice'`) — no WebRTC media, no TURN. Like the chat it travels through the host, which knows
 * the seats and the teams: a client sends its frames to the host, the host passes each on to the seats
 * that may hear it (the allies of the speaker, `World.allied`, or everybody else) and plays the ones
 * meant for itself; it drops frames that come too fast or are malformed (everything from the network
 * is untrusted JSON). Voice is never part of the game: no lockstep turn, no save, no checksum.
 *
 * This module is DOM-free (tested in Vitest): the codec, the down-sampler, the routing and who is
 * talking now. Capture and playback (getUserMedia, AudioWorklet, AudioBuffer) are in `ui/voice.ts`.
 */

/** The voice's sample rate (Hz) and samples per frame (100 ms). */
export const VOICE_RATE = 16_000;
export const VOICE_FRAME = 1600;
/** The longest frame accepted (base64 characters: 1600 bytes take 2136). */
export const VOICE_MAX_DATA = 4096;
/** Frames a seat may send at once, and how fast the allowance comes back: 15 a second at most. */
export const VOICE_BURST = 15;
export const VOICE_REFILL_MS = 1000 / 15;
/** A speaker counts as talking this long after his last frame (ms). */
export const TALK_HOLD_MS = 500;
/** A frame numbered at or below the last one is late unless the speaker was silent this long (ms). */
const SEQ_RESET_MS = 2000;

/** Who hears a frame: the speaker's allies or everybody. */
export type VoiceTo = ChatTo;

// ---------------------------------------------------------------- μ-law (ITU-T G.711)

const BIAS = 0x84;
const CLIP = 32635;

/** One sample (−1…1) as a μ-law byte. */
export function muLawEncode(x: number): number {
  let s = Math.round(Math.max(-1, Math.min(1, Number.isFinite(x) ? x : 0)) * 32767);
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = new Float32Array(256);
for (let b = 0; b < 256; b++) {
  const u = ~b & 0xff;
  const exponent = (u >> 4) & 7;
  const s = (((u & 0x0f) << 3) + BIAS) << exponent;
  DECODE[b] = ((u & 0x80 ? -1 : 1) * (s - BIAS)) / 32768;
}

/** A μ-law byte as a sample (−1…1). */
export function muLawDecode(b: number): number {
  return DECODE[b & 0xff];
}

// ---------------------------------------------------------------- frames as text

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A frame of samples as base64 text of its μ-law bytes. */
export function encodeFrame(samples: ArrayLike<number>): string {
  let bin = '';
  for (let i = 0; i < samples.length; i++) bin += String.fromCharCode(muLawEncode(samples[i]));
  return btoa(bin);
}

/** Base64 μ-law text from the network as samples; null if it is not a valid frame. */
export function decodeFrame(data: unknown): Float32Array | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > VOICE_MAX_DATA || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  let bin: string;
  try {
    bin = atob(data);
  } catch {
    return null;
  }
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = DECODE[bin.charCodeAt(i) & 0xff];
  return out;
}

/** A frame's loudness: the root mean square of its samples (0…1). */
export function frameLevel(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// ---------------------------------------------------------------- down-sampling

/**
 * Turns a microphone's stream (any rate, usually 48 or 44.1 kHz) into 16 kHz frames of `VOICE_FRAME`
 * samples: every output sample is the mean of the input samples of its time slot (a box filter — it
 * keeps speech and takes most of what would fold back), slots of fractional length carried over.
 */
export class Downsampler {
  /** Where we are in the current slot, counted in units of 1 / (inRate · outRate) s (exact for whole rates). */
  private pos = 0;
  private sum = 0;
  private n = 0;
  private last = 0;
  private frame: Float32Array;
  private k = 0;

  constructor(
    private readonly inRate: number,
    private readonly outRate = VOICE_RATE,
    private readonly frameSize = VOICE_FRAME,
  ) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('voice: bad sample rate');
    this.frame = new Float32Array(frameSize);
  }

  /** Feeds input samples; returns the frames completed by them (often none). */
  push(input: ArrayLike<number>): Float32Array[] {
    const out: Float32Array[] = [];
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.n++;
      this.pos += this.outRate;
      while (this.pos >= this.inRate) {
        this.pos -= this.inRate;
        if (this.n > 0) {
          this.last = this.sum / this.n;
          this.sum = 0;
          this.n = 0;
        }
        this.frame[this.k++] = this.last;
        if (this.k === this.frameSize) {
          out.push(this.frame);
          this.frame = new Float32Array(this.frameSize);
          this.k = 0;
        }
      }
    }
    return out;
  }

  /** Forgets what was fed (a new transmission). */
  reset(): void {
    this.pos = this.sum = this.n = this.last = this.k = 0;
  }

  get rate(): number {
    return this.outRate;
  }
}

// ---------------------------------------------------------------- routing

type VoiceMsg = { ch: 'voice'; to: VoiceTo; seq: number; data: string; from?: Seat };

const isVoice = (x: unknown): x is VoiceMsg => typeof x === 'object' && x !== null && (x as VoiceMsg).ch === 'voice';

/** A frame this browser should play. */
export interface VoiceFrame {
  seat: Seat;
  to: VoiceTo;
  seq: number;
  samples: Float32Array;
}

export interface NetVoiceOptions {
  transport: Transport;
  /** Every human seat and its peer (read live, as the chat's). */
  seats: Map<Seat, PeerId>;
  local: Seat;
  now: () => number;
  /** Whether two players are on one team (`World.allied`). */
  allied: (a: Seat, b: Seat) => boolean;
  /** Whether a seat's player is still at his machine (not left and played by the computer); default yes. */
  present?: (seat: Seat) => boolean;
  /** A frame for this browser (from another seat). */
  onFrame?: (frame: VoiceFrame) => void;
}

/** Counters for the screen and for checks from DevTools (`net.core.voice.stats`). */
export interface VoiceStats {
  /** Frames this browser sent (as speaker). */
  sent: number;
  /** Frames handed to `onFrame`. */
  received: number;
  /** Host: frames passed on to other seats' browsers. */
  forwarded: number;
  /** Frames dropped: malformed, too fast, late, or from nobody seated. */
  dropped: number;
}

export class NetVoice {
  readonly stats: VoiceStats = { sent: 0, received: 0, forwarded: 0, dropped: 0 };
  private seq = 0;
  /** Per speaker: the last frame number, when it came and to whom. */
  private readonly heard = new Map<Seat, { seq: number; at: number; to: VoiceTo }>();
  /** Host: per seat, how fast it may send; also this browser's own allowance. */
  private readonly limit = new RateLimit(VOICE_BURST, VOICE_REFILL_MS);
  private readonly off: () => void;

  constructor(private readonly o: NetVoiceOptions) {
    this.off = o.transport.on('message', (from, msg) => {
      if (isVoice(msg)) this.receive(from, msg);
    });
  }

  /** Whether another person plays on this player's team (nobody to talk to with «allies» otherwise). */
  hasAllies(): boolean {
    const present = this.o.present ?? (() => true);
    for (const seat of this.o.seats.keys()) if (seat !== this.o.local && this.o.allied(seat, this.o.local) && present(seat)) return true;
    return false;
  }

  /** The seats that hear a frame of `from` meant for `to` (never the speaker himself). */
  recipients(from: Seat, to: VoiceTo): Seat[] {
    const out: Seat[] = [];
    for (const seat of this.o.seats.keys()) if (seat !== from && (to === 'all' || this.o.allied(seat, from))) out.push(seat);
    return out.sort((a, b) => a - b);
  }

  /** Sends one frame of this browser's microphone; false if refused (too fast). */
  send(to: VoiceTo, samples: ArrayLike<number>): boolean {
    if (!this.limit.take(this.o.local, this.o.now())) return false;
    const data = encodeFrame(samples);
    const seq = this.seq++;
    this.stats.sent++;
    const t = this.o.transport;
    if (t.isHost) this.deliver(this.o.local, to, seq, data);
    else t.send(t.host, { ch: 'voice', to, seq, data } satisfies VoiceMsg);
    return true;
  }

  /** The speakers this browser hears now and to whom they talk (a frame within `TALK_HOLD_MS`). */
  talking(now = this.o.now()): Map<Seat, VoiceTo> {
    const out = new Map<Seat, VoiceTo>();
    for (const [seat, h] of this.heard) if (now - h.at <= TALK_HOLD_MS) out.set(seat, h.to);
    return out;
  }

  private seatOf(peer: PeerId): Seat | undefined {
    for (const [seat, p] of this.o.seats) if (p === peer) return seat;
    return undefined;
  }

  private receive(from: PeerId, m: VoiceMsg): void {
    const t = this.o.transport;
    const valid = (m.to === 'all' || m.to === 'allies') && Number.isSafeInteger(m.seq) && m.seq >= 0 && typeof m.data === 'string' && m.data.length <= VOICE_MAX_DATA;
    if (t.isHost) {
      const seat = this.seatOf(from);
      // Only seated players speak, only as themselves, and not too fast.
      if (!valid || seat === undefined || seat === this.o.local || decodeFrame(m.data) === null || !this.limit.take(seat, this.o.now())) {
        this.stats.dropped++;
        return;
      }
      this.deliver(seat, m.to, m.seq, m.data);
    } else {
      const seat = m.from;
      if (!valid || from !== t.host || !Number.isInteger(seat) || seat === this.o.local || !this.o.seats.has(seat!)) {
        this.stats.dropped++;
        return;
      }
      this.hear(seat!, m.to, m.seq, m.data);
    }
  }

  /** Host: a frame goes to every seat that may hear it; the host plays it if it is one of them. */
  private deliver(seat: Seat, to: VoiceTo, seq: number, data: string): void {
    const t = this.o.transport;
    const connected = t.peers();
    for (const s of this.recipients(seat, to)) {
      if (s === this.o.local) this.hear(seat, to, seq, data);
      else {
        const peer = this.o.seats.get(s);
        if (peer === undefined || !connected.includes(peer)) continue;
        t.send(peer, { ch: 'voice', from: seat, to, seq, data } satisfies VoiceMsg);
        this.stats.forwarded++;
      }
    }
  }

  /** A frame for this browser: late or repeated ones are skipped, the rest played. */
  private hear(seat: Seat, to: VoiceTo, seq: number, data: string): void {
    const now = this.o.now();
    const h = this.heard.get(seat);
    if (h && seq <= h.seq && now - h.at < SEQ_RESET_MS) {
      this.stats.dropped++;
      return;
    }
    const samples = decodeFrame(data);
    if (!samples) {
      this.stats.dropped++;
      return;
    }
    this.heard.set(seat, { seq, at: now, to });
    this.stats.received++;
    this.o.onFrame?.({ seat, to, seq, samples });
  }

  dispose(): void {
    this.off();
  }
}

// ---------------------------------------------------------------- the keys

/** What pressing V (`allies`) or B (`all`) does to the radio. */
export interface RadioStep {
  /** The radio after the press: off (null) or on the air to whom. */
  on: VoiceTo | null;
  /** Why the press did nothing: no ally to talk to. */
  refused?: 'noAllies';
}

/**
 * One air for both keys: the same key again switches the radio off, the other key switches it over
 * (the microphone stays on); «allies» with no ally in the game is refused and changes nothing.
 */
export function radioPress(on: VoiceTo | null, key: VoiceTo, hasAllies: boolean): RadioStep {
  if (on === key) return { on: null };
  if (key === 'allies' && !hasAllies) return { on, refused: 'noAllies' };
  return { on: key };
}
