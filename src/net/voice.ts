import { RateLimit, type ChatTo } from './chat';
import type { Seat } from './lockstep';
import type { PeerId, Transport } from './transport';

/**
 * The voice of a network game, «рация» (docs/NETWORK.md section 16): a player holds V (allies) or B
 * (everybody) on, his microphone is sampled down to 16 kHz, coded as 8-bit μ-law (G.711) in frames of
 * 40 ms, and every frame goes as base64 text over the game's own transport, on its own channel
 * (`ch: 'voice'`) — no WebRTC media, no TURN. The speaker's browser picks who hears it (the allies of
 * the speaker, `World.allied`, or everybody else) and, on our relay, sends it **straight to them**
 * (`Transport.relayTo`: one hop, the relay names the sender); where the transport cannot (WebRTC's
 * star, an older relay) it goes through the host as the chat does: the host checks the sender's seat
 * and passes it on. Receivers drop frames that come too fast, are malformed (everything from the
 * network is untrusted JSON) or were not meant for them. Every frame carries the time it was sent on
 * the host's clock (`t`; a client knows its clock's offset from the pings), so a listener knows how
 * long it travelled. Voice is never part of the game: no lockstep turn, no save, no checksum.
 *
 * This module is DOM-free (tested in Vitest): the codec, the down-sampler, the routing, who is talking
 * now, and the playout schedule (`playout`). Capture and playback (getUserMedia, AudioWorklet,
 * AudioBuffer) are in `ui/voice.ts`.
 */

/** The voice's sample rate (Hz) and samples per frame (40 ms). */
export const VOICE_RATE = 16_000;
export const VOICE_FRAME = 640;
/** One frame's length (ms). */
export const VOICE_FRAME_MS = (VOICE_FRAME * 1000) / VOICE_RATE;
/** The longest frame accepted (base64 characters: 640 bytes take 856). */
export const VOICE_MAX_DATA = 1024;
/** Frames a seat may send at once, and how fast the allowance comes back: 30 a second (25 are sent). */
export const VOICE_BURST = 30;
export const VOICE_REFILL_MS = 1000 / 30;
/** A speaker counts as talking this long after his last frame (ms). */
export const TALK_HOLD_MS = 500;
/** A frame numbered at or below the last one is late unless the speaker was silent this long (ms). */
const SEQ_RESET_MS = 2000;
/** How often the host checks whether its seat → peer map changed (ms). */
const SEATS_CHECK_MS = 500;

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

/** A voice frame on the wire: `from` only when the host passes one on, `t` = sent, on the host's clock (ms). */
type VoiceMsg = { ch: 'voice'; to: VoiceTo; seq: number; data: string; from?: Seat; t?: number };
/** The host's map of who plays which seat from which peer, for the speakers' direct frames. */
type SeatsMsg = { ch: 'voice'; k: 'seats'; seats: [Seat, PeerId][] };

const isVoiceCh = (x: unknown): x is { ch: 'voice'; k?: unknown } => typeof x === 'object' && x !== null && (x as VoiceMsg).ch === 'voice';

/** A frame this browser should play. */
export interface VoiceFrame {
  seat: Seat;
  to: VoiceTo;
  seq: number;
  samples: Float32Array;
  /** How long it travelled, sender to here (ms; null while a clock offset is unknown). */
  transit: number | null;
}

export interface NetVoiceOptions {
  transport: Transport;
  /** Every human seat and its peer (read live on the host; a client follows the host's announcements). */
  seats: Map<Seat, PeerId>;
  local: Seat;
  now: () => number;
  /** The host's clock as this browser reckons it (`now` + the offset from the pings); null: not known yet. */
  hostNow?: () => number | null;
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
  /** …of them straight to the listeners through the relay (`relayTo`), not through the host. */
  direct: number;
  /** Frames handed to `onFrame`. */
  received: number;
  /** Host: frames passed on to other seats' browsers (the way through the host). */
  forwarded: number;
  /** Frames dropped: malformed, too fast, late, not meant for us, or from nobody seated. */
  dropped: number;
}

export class NetVoice {
  readonly stats: VoiceStats = { sent: 0, direct: 0, received: 0, forwarded: 0, dropped: 0 };
  /** Per speaker, how long his frames travel to this browser (ms, smoothed; from `t` and the clock offset). */
  readonly transit = new Map<Seat, number>();
  private seq = 0;
  /** Per speaker: the last frame number, when it came and to whom. */
  private readonly heard = new Map<Seat, { seq: number; at: number; to: VoiceTo }>();
  /** Per seat, how fast it may send (host: frames to pass on; anyone: frames heard); also this browser's own allowance. */
  private readonly limit = new RateLimit(VOICE_BURST, VOICE_REFILL_MS);
  /** A client's copy of the seat → peer map, kept up to date by the host (who uses `seats` itself). */
  private readonly peerOf: Map<Seat, PeerId>;
  private seatsSent: string;
  private seatsChecked = -Infinity;
  private readonly offs: (() => void)[];

  constructor(private readonly o: NetVoiceOptions) {
    this.peerOf = o.transport.isHost ? o.seats : new Map(o.seats);
    this.seatsSent = JSON.stringify([...o.seats].sort((a, b) => a[0] - b[0]));
    this.offs = [
      o.transport.on('message', (from, msg) => {
        if (isVoiceCh(msg)) this.receive(from, msg);
      }),
      o.transport.on('relayed', (from, msg) => {
        if (isVoiceCh(msg)) this.direct(from, msg as VoiceMsg & { k?: unknown });
      }),
    ];
  }

  /** Host: tells the clients when a seat's peer changed (a returning player), so their frames find him. */
  update(): void {
    const t = this.o.transport;
    const now = this.o.now();
    if (!t.isHost || now - this.seatsChecked < SEATS_CHECK_MS) return;
    this.seatsChecked = now;
    const seats = [...this.o.seats].sort((a, b) => a[0] - b[0]);
    const key = JSON.stringify(seats);
    if (key === this.seatsSent) return;
    this.seatsSent = key;
    t.broadcast({ ch: 'voice', k: 'seats', seats } satisfies SeatsMsg);
  }

  /** Whether another person plays on this player's team (nobody to talk to with «allies» otherwise). */
  hasAllies(): boolean {
    const present = this.o.present ?? (() => true);
    for (const seat of this.peerOf.keys()) if (seat !== this.o.local && this.o.allied(seat, this.o.local) && present(seat)) return true;
    return false;
  }

  /** The seats that hear a frame of `from` meant for `to` (never the speaker himself). */
  recipients(from: Seat, to: VoiceTo): Seat[] {
    const out: Seat[] = [];
    for (const seat of this.peerOf.keys()) if (seat !== from && (to === 'all' || this.o.allied(seat, from))) out.push(seat);
    return out.sort((a, b) => a - b);
  }

  /** The peer playing a seat as this browser knows it. */
  peerOfSeat(seat: Seat): PeerId | undefined {
    return this.peerOf.get(seat);
  }

  /** Sends one frame of this browser's microphone; false if refused (too fast). */
  send(to: VoiceTo, samples: ArrayLike<number>): boolean {
    if (!this.limit.take(this.o.local, this.o.now())) return false;
    const data = encodeFrame(samples);
    const seq = this.seq++;
    const hostNow = this.o.hostNow?.() ?? null;
    const msg: VoiceMsg = { ch: 'voice', to, seq, data };
    if (hostNow !== null) msg.t = Math.round(hostNow);
    const t = this.o.transport;
    // Straight to the listeners where the relay can: one hop, nothing for the host to pass on.
    if (t.relayTo) {
      const present = this.o.present ?? (() => true);
      const peers: PeerId[] = [];
      for (const seat of this.recipients(this.o.local, to)) {
        const peer = this.peerOf.get(seat);
        if (peer !== undefined && peer !== t.self && present(seat)) peers.push(peer);
      }
      if (peers.length === 0) return true;
      if (t.relayTo(peers, msg)) {
        this.stats.sent++;
        this.stats.direct++;
        return true;
      }
    }
    this.stats.sent++;
    if (t.isHost) this.deliver(this.o.local, to, seq, data, msg.t);
    else t.send(t.host, msg);
    return true;
  }

  /** The speakers this browser hears now and to whom they talk (a frame within `TALK_HOLD_MS`). */
  talking(now = this.o.now()): Map<Seat, VoiceTo> {
    const out = new Map<Seat, VoiceTo>();
    for (const [seat, h] of this.heard) if (now - h.at <= TALK_HOLD_MS) out.set(seat, h.to);
    return out;
  }

  private seatOf(peer: PeerId): Seat | undefined {
    for (const [seat, p] of this.peerOf) if (p === peer) return seat;
    return undefined;
  }

  private static valid(m: VoiceMsg): boolean {
    return (m.to === 'all' || m.to === 'allies') && Number.isSafeInteger(m.seq) && m.seq >= 0 && typeof m.data === 'string' && m.data.length <= VOICE_MAX_DATA;
  }

  /** A message on the voice channel through the host's star: a frame to pass on or to play, or the seat map. */
  private receive(from: PeerId, m: { ch: 'voice'; k?: unknown }): void {
    const t = this.o.transport;
    if (m.k !== undefined) {
      if (m.k === 'seats' && !t.isHost && from === t.host) this.takeSeats((m as SeatsMsg).seats);
      return;
    }
    const v = m as VoiceMsg;
    const valid = NetVoice.valid(v);
    if (t.isHost) {
      const seat = this.seatOf(from);
      // Only seated players speak, only as themselves, and not too fast.
      if (!valid || seat === undefined || seat === this.o.local || decodeFrame(v.data) === null || !this.limit.take(seat, this.o.now())) {
        this.stats.dropped++;
        return;
      }
      this.deliver(seat, v.to, v.seq, v.data, v.t);
    } else {
      const seat = v.from;
      if (!valid || from !== t.host || !Number.isInteger(seat) || seat === this.o.local || !this.peerOf.has(seat!)) {
        this.stats.dropped++;
        return;
      }
      this.hear(seat!, v.to, v.seq, v.data, v.t);
    }
  }

  /** A direct frame from the relay: the sender is the peer the relay names; is it for us at all? */
  private direct(from: PeerId, m: VoiceMsg & { k?: unknown }): void {
    if (m.k !== undefined) return;
    const seat = this.seatOf(from);
    if (
      !NetVoice.valid(m) ||
      seat === undefined ||
      seat === this.o.local ||
      (m.to === 'allies' && !this.o.allied(seat, this.o.local)) ||
      !this.limit.take(seat, this.o.now())
    ) {
      this.stats.dropped++;
      return;
    }
    this.hear(seat, m.to, m.seq, m.data, m.t);
  }

  /** A client: the host's seat map (only entries that make sense, and only one that seats us). */
  private takeSeats(seats: unknown): void {
    if (!Array.isArray(seats)) return;
    const next = new Map<Seat, PeerId>();
    for (const e of seats) if (Array.isArray(e) && Number.isInteger(e[0]) && typeof e[1] === 'string') next.set(e[0] as Seat, e[1] as PeerId);
    if (next.get(this.o.local) !== this.o.transport.self) return;
    this.peerOf.clear();
    for (const [s, p] of next) this.peerOf.set(s, p);
  }

  /** Host: a frame goes to every seat that may hear it; the host plays it if it is one of them. */
  private deliver(seat: Seat, to: VoiceTo, seq: number, data: string, sent: number | undefined): void {
    const t = this.o.transport;
    const connected = t.peers();
    for (const s of this.recipients(seat, to)) {
      if (s === this.o.local) this.hear(seat, to, seq, data, sent);
      else {
        const peer = this.o.seats.get(s);
        if (peer === undefined || !connected.includes(peer)) continue;
        const msg: VoiceMsg = { ch: 'voice', from: seat, to, seq, data };
        if (typeof sent === 'number' && Number.isFinite(sent)) msg.t = sent;
        t.send(peer, msg);
        this.stats.forwarded++;
      }
    }
  }

  /** A frame for this browser: late or repeated ones are skipped, the rest played. */
  private hear(seat: Seat, to: VoiceTo, seq: number, data: string, sent: unknown): void {
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
    let transit: number | null = null;
    const hostNow = this.o.hostNow?.() ?? null;
    if (hostNow !== null && typeof sent === 'number' && Number.isFinite(sent)) {
      // The offsets are estimates: a few ms below zero is a measuring error, not time travel.
      transit = Math.max(0, hostNow - sent);
      const old = this.transit.get(seat);
      this.transit.set(seat, old === undefined || !h || now - h.at > SEQ_RESET_MS ? transit : old + 0.2 * (transit - old));
    }
    this.o.onFrame?.({ seat, to, seq, samples, transit });
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}

// ---------------------------------------------------------------- playout

/**
 * The playout schedule (`ui/voice.ts` `VoicePlayer`, per speaker; seconds of the audio clock): a
 * frame goes right after the one before; when the queue ran dry (the first frame, a pause, a late
 * frame) it starts `target` ahead — the jitter buffer. Frames that arrive in a bunch (the relay's
 * TCP holds them up, then lets them go together) would push the voice further and further behind;
 * so once more than `high` is queued, frames are dropped until no more than `target` is, and while
 * more than `target` + a frame is queued, quiet frames (the gaps between words, below `quiet` RMS)
 * are dropped too — that catches up without a word going missing.
 */
export const PLAYOUT = { target: 0.12, high: 0.3, quiet: 0.01 } as const;

export interface Playout {
  /** When the queued voice ends (audio clock, s). */
  next: number;
  /** Dropping frames until the queue is back at `target`. */
  catching: boolean;
}

/** Where a frame of `dur` s and loudness `level` arriving at `now` is played (its start, s), or null: dropped. */
export function playout(p: Playout, now: number, dur: number, level: number): number | null {
  if (p.next < now + 0.005) {
    p.next = now + PLAYOUT.target;
    p.catching = false;
  }
  const ahead = p.next - now;
  if (ahead > PLAYOUT.high) p.catching = true;
  else if (ahead <= PLAYOUT.target) p.catching = false;
  if (p.catching || (ahead > PLAYOUT.target + dur && level < PLAYOUT.quiet)) return null;
  const at = p.next;
  p.next += dur;
  return at;
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
