import { peerProvider } from './peer';
import { bindLockstep, type LockstepSession } from './session';
import { normaliseCode, type Transport } from './transport';

/**
 * Dev smoke page for the network layer (`nettest.html`, served by `npm run dev` only — the
 * production build has a single entry, `index.html`). Two tabs: «Host» in one, «Join» with its code
 * in the other; then messages, a ping (round trip over the data channel) and a lockstep run (turns
 * of 100 ms, a random command now and then, a running hash per turn that must match in every tab).
 * Not player-facing, so its few words are not in the dictionaries.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const logBox = $('log');
const status = $('status');
const lsBox = $('ls');
const provider = peerProvider();
let transport: Transport | null = null;
let session: LockstepSession | null = null;
let loop: ReturnType<typeof setInterval> | null = null;

function log(text: string): void {
  logBox.textContent += `${new Date().toISOString().slice(11, 23)}  ${text}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

/** For poking from DevTools (and the browser checks): the last lines, the state. */
(window as unknown as { nettest: unknown }).nettest = {
  get transport() {
    return transport;
  },
  get lockstep() {
    return session?.lockstep ?? null;
  },
  log: () => logBox.textContent,
};

function hash(h: number, text: string): number {
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function wire(t: Transport): void {
  transport = t;
  status.textContent = `${t.isHost ? 'host' : 'client'} · code ${t.code} · me ${t.self}`;
  log(`${t.isHost ? 'hosting' : 'joined'} code ${t.code} as ${t.self}`);
  t.on('join', (p) => log(`join ${p} (peers: ${t.peers().join(', ')})`));
  t.on('leave', (p, why) => log(`leave ${p}: ${why}`));
  t.on('error', (e) => log(`error: ${e.message}`));
  t.on('message', (from, msg) => {
    const m = msg as { chat?: string; ping?: number; pong?: number; start?: [number, string][]; ch?: string };
    if (m.chat !== undefined) {
      log(`${from}: ${m.chat}`);
      if (t.isHost) for (const p of t.peers()) if (p !== from) t.send(p, msg); // the hub relays chat
    } else if (m.ping !== undefined) t.send(from, { pong: m.ping });
    else if (m.pong !== undefined) log(`rtt to ${from}: ${(performance.now() - m.pong).toFixed(1)} ms`);
    else if (m.start) startLockstep(new Map(m.start));
  });
}

function startLockstep(seats: Map<number, string>): void {
  if (!transport || session) return;
  let state = 2166136261;
  let stalls = 0;
  let hostLost = false;
  session = bindLockstep(transport, {
    seats,
    delay: 3,
    onDesync: (r) => log(`DESYNC at turn ${r.turn}: ${JSON.stringify(r.sums)}`),
    onHostLost: () => {
      hostLost = true;
      log('host lost');
    },
    onSeatLeft: (s) => log(`seat ${s} left: the computer takes over`),
  });
  const ls = session.lockstep;
  log(`lockstep: seats ${JSON.stringify([...seats])}, I am seat ${ls.local}`);
  loop = setInterval(() => {
    if (hostLost) return;
    if (ls.canSubmit()) ls.submit(Math.random() < 0.3 ? [{ seat: ls.local, r: Math.floor(Math.random() * 1000) }] : []);
    const turn = ls.next();
    if (!turn) {
      stalls++;
      return;
    }
    state = hash(state, JSON.stringify(turn));
    ls.checksum(turn.turn, state);
    if (turn.dropped.length) log(`turn ${turn.turn}: dropped ${turn.dropped.join(', ')}`);
    lsBox.textContent = `turn ${turn.turn} · hash ${state.toString(16)} · buffered ${ls.buffered()} · stalls ${stalls} · waiting for ${ls.waitingFor().join(', ') || '-'}`;
  }, 100);
}

$('host').onclick = async () => {
  if (transport) return;
  status.textContent = 'opening…';
  try {
    wire(await provider.host());
  } catch (e) {
    status.textContent = 'failed';
    log(`host failed: ${(e as Error).message}`);
  }
};

$('join').onclick = async () => {
  if (transport) return;
  const code = normaliseCode(($('code') as HTMLInputElement).value);
  if (!code) return log('not a code');
  status.textContent = 'joining…';
  try {
    wire(await provider.join(code));
  } catch (e) {
    status.textContent = 'failed';
    log(`join failed: ${(e as Error).message}`);
  }
};

$('send').onclick = () => {
  const text = ($('text') as HTMLInputElement).value;
  transport?.broadcast({ chat: text });
  log(`me: ${text}`);
};

$('ping').onclick = () => transport?.broadcast({ ping: performance.now() });

$('lockstep').onclick = () => {
  if (!transport?.isHost) return log('only the host starts a lockstep run');
  const seats: [number, string][] = [[1, transport.self], ...transport.peers().map((p, k): [number, string] => [k + 2, p])];
  transport.broadcast({ start: seats });
  startLockstep(new Map(seats));
};

$('close').onclick = () => {
  if (loop) clearInterval(loop);
  session?.dispose();
  transport?.close();
  transport = null;
  session = null;
  status.textContent = 'closed';
};
