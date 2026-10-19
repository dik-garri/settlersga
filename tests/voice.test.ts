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
  playout,
  PLAYOUT,
  radioPress,
  TALK_HOLD_MS,
  VOICE_BURST,
  VOICE_FRAME,
  VOICE_FRAME_MS,
  VOICE_MAX_DATA,
  VOICE_RATE,
  type Playout,
  type VoiceFrame,
} from '../src/net/voice';
import { PingMeter } from '../src/net/status';

/** The radio's pure parts (docs/NETWORK.md section 16): codec, down-sampling, routing (straight or through the host), delay, playout. */

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

/** A host and clients with radios on a loopback network; teams by seat; `direct`: the relay's direct frames. */
function radios(teams: number[], o: { direct?: boolean; latency?: number; jitter?: number } = {}) {
  const clock = new VirtualClock();
  const net = new LoopbackNetwork({ scheduler: clock, seed: 3, direct: o.direct, conditions: { latency: o.latency ?? 20, jitter: o.jitter ?? 10 } });
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
  return { clock, net, transports, voices, heard, seats, run };
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

describe('voice straight through the relay (direct frames)', () => {
  it('the speaker addresses the listeners himself: the host passes nothing on, two can talk at once', () => {
    // Seats 1 (host) and 2 together, 3 and 4 together.
    const r = radios([1, 1, 2, 2], { direct: true });
    const [a, b, c, d] = r.voices;
    c.send('allies', tone());
    r.run(300);
    expect(r.heard.map((h) => h.map((f) => `${f.seat}:${f.to}`))).toEqual([[], [], [], ['3:allies']]);
    expect(c.stats).toMatchObject({ sent: 1, direct: 1 });
    b.send('all', tone());
    a.send('allies', tone());
    r.run(300);
    expect(r.heard.map((h) => h.map((f) => `${f.seat}:${f.to}`))).toEqual([['2:all'], ['1:allies'], ['2:all'], ['3:allies', '2:all']]);
    // Both enemies at once: the host hears both voices, each under his own seat.
    for (let k = 0; k < 5; k++) {
      c.send('all', tone());
      d.send('all', tone());
      r.run(40);
    }
    r.run(200);
    expect(r.heard[0].filter((f) => f.seat === 3).length).toBe(5);
    expect(r.heard[0].filter((f) => f.seat === 4).length).toBe(5);
    expect([...a.talking()].sort()).toEqual([
      [3, 'all'],
      [4, 'all'],
    ]);
    for (const v of r.voices) expect(v.stats.forwarded).toBe(0);
    for (const v of r.voices) expect(v.stats.dropped).toBe(0);
  });

  it('a receiver checks every direct frame: the sender is the peer the relay names, «allies» only from allies, not too fast', () => {
    const r = radios([1, 1, 2], { direct: true });
    const [a, b] = r.voices;
    const ct = r.transports[2];
    const data = encodeFrame(tone());
    const dropped = a.stats.dropped;
    // An enemy sends «allies» to the host: not his ally, not played.
    ct.relayTo([ct.host], { ch: 'voice', to: 'allies', seq: 1, data });
    // Claiming to be seat 2: the relay's sender (seat 3) counts.
    ct.relayTo([ct.host], { ch: 'voice', to: 'all', seq: 2, data, from: 2 });
    // Rubbish.
    ct.relayTo([ct.host], { ch: 'voice', to: 'all', seq: 3, data: '!!' });
    ct.relayTo([ct.host], { ch: 'voice', to: 'everyone', seq: 4, data });
    // A browser in the room without a seat (a lobby visitor).
    const stranger = r.net.connect('VOICE2', 'p9');
    stranger.relayTo([ct.host], { ch: 'voice', to: 'all', seq: 5, data });
    // A seat map from somebody else than the host is no seat map.
    ct.relayTo([r.transports[1].self], { ch: 'voice', k: 'seats', seats: [[2, ct.self]] });
    r.run(300);
    expect(r.heard[0].map((f) => `${f.seat}:${f.seq}`)).toEqual(['3:2']);
    expect(a.stats.dropped - dropped).toBe(4);
    expect(b.peerOfSeat(2)).toBe(r.transports[1].self);
    // A flood straight at the host: a burst's worth is played.
    for (let k = 0; k < 60; k++) ct.relayTo([ct.host], { ch: 'voice', to: 'all', seq: 100 + k, data });
    r.run(300);
    expect(r.heard[0].filter((f) => f.seq >= 100).length).toBe(VOICE_BURST);
  });

  it("the host tells everybody a returning player's new peer, and his voice finds them", () => {
    const r = radios([1, 2, 2], { direct: true });
    const [a, , c] = r.voices;
    // Seat 2's browser goes; it comes back as another peer, and the host seats it again.
    r.transports[1].close();
    r.run(300);
    const back = r.net.connect('VOICE2', 'p2b');
    const seatsThen = new Map(r.seats);
    seatsThen.set(2, back.self);
    const heardBack: VoiceFrame[] = [];
    const b2 = new NetVoice({
      transport: back,
      seats: seatsThen,
      local: 2,
      now: () => r.clock.now(),
      allied: (x, y) => x === y || (x > 1 && y > 1),
      onFrame: (f) => heardBack.push(f),
    });
    b2.send('allies', tone());
    r.run(300);
    // Seat 3 does not know that peer yet.
    expect(r.heard[2]).toEqual([]);
    r.seats.set(2, back.self); // the host's live map (NetCore.acceptRejoin)
    a.update();
    r.run(300);
    expect(c.peerOfSeat(2)).toBe(back.self);
    b2.send('allies', tone());
    c.send('allies', tone());
    r.run(300);
    expect(r.heard[2].map((f) => f.seat)).toEqual([2]);
    expect(heardBack.map((f) => f.seat)).toEqual([3]);
  });

  it('without direct frames (WebRTC, an older relay) the voice goes through the host as before', () => {
    const r = radios([1, 2, 2]);
    const [a, b] = r.voices;
    b.send('allies', tone());
    r.run(300);
    expect(r.heard.map((h) => h.length)).toEqual([0, 0, 1]);
    expect(b.stats.direct).toBe(0);
    expect(a.stats.forwarded).toBe(1);
  });
});

describe("the voice's delay", () => {
  /** Host and two clients whose clocks are off by `skews` ms, pinging the host; one-way latency 40 ms. */
  function skewed(direct: boolean) {
    const clock = new VirtualClock();
    const net = new LoopbackNetwork({ scheduler: clock, seed: 9, direct, conditions: { latency: 40, jitter: 0 } });
    const host = net.openHost('LAGLAG');
    const ts = [host, net.connect('LAGLAG', 'pa'), net.connect('LAGLAG', 'pb')];
    const skews = [0, 5_000, -3_250];
    const nows = skews.map((s) => () => clock.now() + s);
    const meters = ts.map((t, k) => new PingMeter(t, nows[k], 500));
    const seats = new Map(ts.map((t, k) => [k + 1, t.self]));
    const heard: VoiceFrame[][] = ts.map(() => []);
    const voices = ts.map(
      (transport, k) =>
        new NetVoice({
          transport,
          seats,
          local: k + 1,
          now: nows[k],
          hostNow: () => {
            if (k === 0) return nows[0]();
            const off = meters[k].offset(host.self);
            return off === null ? null : nows[k]() + off;
          },
          allied: () => true,
          onFrame: (f) => heard[k].push(f),
        }),
    );
    for (let t = 0; t < 3_000; t += 10) {
      for (const m of meters) m.update();
      clock.advance(10);
    }
    return { clock, meters, voices, heard, host };
  }

  it("the pings give each client its clock's offset from the host's", () => {
    const g = skewed(false);
    expect(g.meters[1].offset(g.host.self)).toBeCloseTo(-5_000, 6);
    expect(g.meters[2].offset(g.host.self)).toBeCloseTo(3_250, 6);
  });

  it('a frame carries when it was sent: the listener knows how long it travelled, clocks apart or not', () => {
    for (const direct of [true, false]) {
      const g = skewed(direct);
      g.voices[1].send('all', tone());
      g.clock.advance(500);
      // Client to client: one hop through the relay, or two through the host.
      const transit = g.heard[2][0].transit!;
      expect(Math.abs(transit - (direct ? 40 : 80))).toBeLessThanOrEqual(1);
      expect(Math.abs(g.heard[0][0].transit! - 40)).toBeLessThanOrEqual(1);
      expect(g.voices[2].transit.get(2)).toBeCloseTo(transit, 6);
    }
  });
});

describe('the playout (catching up after a bunch)', () => {
  const DUR = VOICE_FRAME_MS / 1000;
  /** Plays frames arriving at the given times (s); returns the start times (null: dropped) and the most queued. */
  function play(arrivals: number[], level = 0.2) {
    const p: Playout = { next: 0, catching: false };
    let most = 0;
    const at = arrivals.map((now) => {
      const a = playout(p, now, DUR, level);
      most = Math.max(most, p.next - now);
      return a;
    });
    return { at, most, p };
  }

  it('a steady stream with jitter plays every frame, back to back, about the target ahead', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // Sent every 40 ms from 1 s on, each up to 50 ms late (in order, as TCP keeps it).
    let last = 0;
    const arrivals = Array.from({ length: 250 }, (_, k) => (last = Math.max(last, 1 + k * DUR + rand() * 0.05)));
    const { at, most } = play(arrivals);
    expect(at.every((x) => x !== null)).toBe(true);
    for (let k = 1; k < at.length; k++) expect(at[k]! - at[k - 1]!).toBeCloseTo(DUR, 9);
    expect(most).toBeLessThanOrEqual(PLAYOUT.target + DUR + 1e-9);
  });

  it('a stall of half a second and then a bunch: the voice never lags more than the limit and is soon back at the target', () => {
    // 2 s of voice, the frames of 1.0…1.5 s held up and let go at once at 1.5 s, then on as before.
    const arrivals = Array.from({ length: 75 }, (_, k) => {
      const sent = 0.5 + k * DUR;
      return sent >= 1 && sent < 1.5 ? 1.5 : sent;
    });
    const { at, most, p } = play(arrivals);
    expect(most).toBeLessThanOrEqual(PLAYOUT.high + DUR + 1e-9);
    // Some frames were dropped to catch up — no more than the stall's worth.
    const dropped = at.filter((x) => x === null).length;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(Math.ceil(0.5 / DUR) + 1);
    // By the end the voice is back at the jitter buffer.
    expect(p.next - arrivals.at(-1)!).toBeLessThanOrEqual(PLAYOUT.target + DUR + 1e-9);
    // Without catching up, the bunch would have kept the whole stall as delay to the end.
    let next = 0;
    let naiveAhead = 0;
    for (const now of arrivals) {
      if (next < now) next = now + PLAYOUT.target;
      next += DUR;
      naiveAhead = next - now;
    }
    expect(naiveAhead).toBeGreaterThan(0.5);
  });

  it('quiet frames go first: between words the queue shrinks without losing a word', () => {
    const p: Playout = { next: 0, catching: false };
    // Four frames of speech at once (under the limit), then silence comes in.
    for (let k = 0; k < 4; k++) playout(p, 1, DUR, 0.2);
    expect(p.next - 1).toBeCloseTo(PLAYOUT.target + 4 * DUR, 9);
    expect(playout(p, 1.03, DUR, 0.2)).not.toBeNull(); // speech is kept
    expect(playout(p, 1.06, DUR, 0.001)).toBeNull(); // a quiet frame is dropped
    // Back at the target, quiet frames are played again (the pauses of speech stay).
    const q: Playout = { next: 0, catching: false };
    expect(playout(q, 1, DUR, 0.001)).toBeCloseTo(1 + PLAYOUT.target, 9);
    expect(playout(q, 1 + DUR, DUR, 0.001)).not.toBeNull();
  });
});
