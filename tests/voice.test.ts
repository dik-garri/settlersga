import { describe, expect, it } from 'vitest';
import { LoopbackNetwork, VirtualClock, type LoopbackTransport } from '../src/net/loopback';
import {
  decodeFrame,
  Downsampler,
  encodeFrame,
  frameLevel,
  muLawDecode,
  muLawEncode,
  NetVoice,
  radioPress,
  TALK_HOLD_MS,
  VOICE_BURST,
  VOICE_FRAME,
  VOICE_MAX_DATA,
  VOICE_RATE,
  type VoiceFrame,
} from '../src/net/voice';

/** The radio's pure parts (docs/NETWORK.md section 16): codec, down-sampling, routing through the host. */

describe('μ-law codec', () => {
  it('round-trips samples with a small error, louder ones with a small relative error', () => {
    for (let k = -1000; k <= 1000; k++) {
      const x = k / 1000;
      const y = muLawDecode(muLawEncode(x));
      expect(Math.abs(y - x)).toBeLessThanOrEqual(Math.max(0.0006, 0.035 * Math.abs(x)));
    }
    // Silence stays (near) silence, the extremes stay in range, rubbish is silence.
    expect(Math.abs(muLawDecode(muLawEncode(0)))).toBeLessThan(0.0002);
    expect(muLawDecode(muLawEncode(5))).toBeLessThanOrEqual(1);
    expect(muLawDecode(muLawEncode(-5))).toBeGreaterThanOrEqual(-1);
    expect(muLawEncode(NaN)).toBe(muLawEncode(0));
  });

  it('a frame travels as base64 of one byte a sample; malformed text is refused', () => {
    const frame = Float32Array.from({ length: VOICE_FRAME }, (_, i) => 0.5 * Math.sin(i / 7));
    const data = encodeFrame(frame);
    expect(data.length).toBe(Math.ceil(VOICE_FRAME / 3) * 4);
    expect(data.length).toBeLessThanOrEqual(VOICE_MAX_DATA);
    const back = decodeFrame(data)!;
    expect(back.length).toBe(VOICE_FRAME);
    for (let i = 0; i < VOICE_FRAME; i++) expect(Math.abs(back[i] - frame[i])).toBeLessThan(0.02);
    for (const bad of [null, 42, '', 'a', '!!!!', '<script>', 'A'.repeat(VOICE_MAX_DATA + 4), { length: 4 }]) expect(decodeFrame(bad)).toBeNull();
    expect(frameLevel(new Float32Array(10))).toBe(0);
    expect(frameLevel(Float32Array.from({ length: 10 }, () => 0.5))).toBeCloseTo(0.5);
  });
});

describe('down-sampling to 16 kHz', () => {
  it('48 kHz: every output sample is the mean of three, a tone keeps its shape', () => {
    const d = new Downsampler(48_000);
    const f = 440;
    const input = Float32Array.from({ length: 48_000 }, (_, i) => Math.sin((2 * Math.PI * f * i) / 48_000));
    // Fed in odd pieces, as an audio worklet would.
    const frames: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 1000) frames.push(...d.push(input.subarray(i, i + 1000)));
    expect(frames.length).toBe(VOICE_RATE / VOICE_FRAME);
    let worst = 0;
    frames.forEach((fr, n) =>
      fr.forEach((y, j) => {
        const k = n * VOICE_FRAME + j;
        // The slot of output k is input 3k…3k+2, centred on 3k+1.
        worst = Math.max(worst, Math.abs(y - Math.sin((2 * Math.PI * f * (3 * k + 1)) / 48_000)));
      }),
    );
    expect(worst).toBeLessThan(0.01);
  });

  it('44.1 kHz: a second in is a second out, a constant stays constant', () => {
    const d = new Downsampler(44_100);
    let out = 0;
    for (let n = 0; n < 441; n++) for (const fr of d.push(new Float32Array(100).fill(0.25))) {
      out += fr.length;
      for (const y of fr) expect(y).toBeCloseTo(0.25, 6);
    }
    expect(out).toBe(16_000);
    expect(() => new Downsampler(0)).toThrow();
  });
});

/** A host and clients with radios on a loopback network; teams by seat. */
function radios(teams: number[]) {
  const clock = new VirtualClock();
  const net = new LoopbackNetwork({ scheduler: clock, seed: 3, conditions: { latency: 20, jitter: 10 } });
  const host = net.openHost('VOICE2');
  const transports: LoopbackTransport[] = [host, ...teams.slice(1).map((_, k) => net.connect('VOICE2', `p${k + 2}`))];
  const seats = new Map(transports.map((t, k) => [k + 1, t.self]));
  const heard: VoiceFrame[][] = transports.map(() => []);
  const voices = transports.map(
    (transport, k) =>
      new NetVoice({
        transport,
        seats,
        local: k + 1,
        now: () => clock.now(),
        allied: (a, b) => a === b || teams[a - 1] === teams[b - 1],
        onFrame: (f) => heard[k].push(f),
      }),
  );
  const run = (ms: number) => {
    for (let t = 0; t < ms; t += 10) clock.advance(10);
  };
  run(200);
  return { clock, transports, voices, heard, run };
}

const tone = (amp = 0.3) => Float32Array.from({ length: VOICE_FRAME }, (_, i) => amp * Math.sin(i / 5));

describe('voice routing through the host', () => {
  it('«allies» reach only the speaker\'s team, «all» everybody but the speaker', () => {
    // Seats 1 (host) and 2 together, 3 alone.
    const r = radios([1, 1, 2]);
    const [a, b, c] = r.voices;
    expect(a.hasAllies()).toBe(true);
    expect(c.hasAllies()).toBe(false);
    expect(a.recipients(2, 'allies')).toEqual([1]);
    expect(a.recipients(3, 'all')).toEqual([1, 2]);
    b.send('allies', tone());
    r.run(300);
    expect(r.heard.map((h) => h.map((f) => f.seat))).toEqual([[2], [], []]);
    expect(r.heard[0][0].to).toBe('allies');
    expect(r.heard[0][0].samples.length).toBe(VOICE_FRAME);
    // The host's own voice goes the same way.
    a.send('allies', tone());
    c.send('all', tone());
    r.run(300);
    expect(r.heard.map((h) => h.map((f) => `${f.seat}:${f.to}`))).toEqual([['2:allies', '3:all'], ['1:allies', '3:all'], []]);
    // Who is talking: for a while after the last frame.
    expect([...b.talking().keys()].sort()).toEqual([1, 3]);
    expect(b.talking().get(3)).toBe('all');
    r.run(TALK_HOLD_MS + 100);
    expect(b.talking().size).toBe(0);
    expect(c.talking().size).toBe(0);
  });

  it('the host drops floods, rubbish, impersonation and late frames', () => {
    const r = radios([1, 2, 3]);
    const [a, , c] = r.voices;
    const ct = r.transports[2];
    const data = encodeFrame(tone());
    // A modified browser sends 60 frames at once: the host passes on a burst's worth.
    for (let k = 0; k < 60; k++) ct.send(ct.host, { ch: 'voice', to: 'all', seq: k, data });
    r.run(300);
    expect(r.heard[0].length).toBe(VOICE_BURST);
    expect(r.heard[1].length).toBe(VOICE_BURST);
    // …and its own radio refuses past the burst too.
    r.run(3_000);
    const sent = Array.from({ length: 40 }, () => c.send('all', tone()));
    expect(sent.filter(Boolean).length).toBe(VOICE_BURST);
    r.run(3_000);
    const before = r.heard[0].length;
    const dropped = a.stats.dropped;
    for (const bad of [
      { ch: 'voice', to: 'all', seq: 1000, data: 'not base64!' },
      { ch: 'voice', to: 'enemies', seq: 1001, data },
      { ch: 'voice', to: 'all', seq: -1, data },
      { ch: 'voice', to: 'all', seq: 1.5, data },
      { ch: 'voice', to: 'all', seq: 1002, data: 'A'.repeat(VOICE_MAX_DATA + 4) },
      { ch: 'voice', to: 'all', seq: 1003 },
      { ch: 'voice' },
    ])
      ct.send(ct.host, bad);
    r.run(300);
    expect(r.heard[0].length).toBe(before);
    expect(a.stats.dropped - dropped).toBe(7);
    // Speaking for another seat: the host names the sender itself.
    ct.send(ct.host, { ch: 'voice', to: 'all', seq: 2000, data, from: 2 });
    r.run(300);
    expect(r.heard[0].at(-1)!.seat).toBe(3);
    // A client accepts frames only from the host: one from another peer is dropped.
    const bt = r.transports[1];
    bt.receive(ct.self, { ch: 'voice', from: 1, to: 'all', seq: 9999, data });
    // A late frame (an older number from a speaker just heard) is skipped.
    ct.send(ct.host, { ch: 'voice', to: 'all', seq: 1999, data });
    r.run(300);
    expect(r.heard[1].filter((f) => f.seq >= 1999).map((f) => f.seq)).toEqual([2000]);
  });
});

describe('the radio keys', () => {
  it('V and B share one air: the same key switches off, the other switches over, V without allies is refused', () => {
    expect(radioPress(null, 'allies', true)).toEqual({ on: 'allies' });
    expect(radioPress('allies', 'allies', true)).toEqual({ on: null });
    expect(radioPress('allies', 'all', true)).toEqual({ on: 'all' });
    expect(radioPress('all', 'allies', true)).toEqual({ on: 'allies' });
    expect(radioPress('all', 'all', false)).toEqual({ on: null });
    expect(radioPress(null, 'all', false)).toEqual({ on: 'all' });
    expect(radioPress(null, 'allies', false)).toEqual({ on: null, refused: 'noAllies' });
    expect(radioPress('all', 'allies', false)).toEqual({ on: 'all', refused: 'noAllies' });
  });
});
