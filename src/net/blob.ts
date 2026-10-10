import type { PeerId, Transport } from './transport';

/**
 * Long texts over the transport (roadmap 6.6–6.7): a network save the host sends to a player who
 * lacks it, the snapshot for a returning player. They go in pieces of `BLOB_CHUNK` characters on
 * their own channel (`ch: 'blob'`), so the receiver can show how far it got and other messages
 * (the lockstep's turns, the chat) are not stuck behind one huge message. The transport keeps the
 * order on a connection, so the pieces arrive in order; a piece of another id, a gap or a repeat
 * starts nothing new and is ignored.
 */

/** Characters a piece (≈ 32 kB of a base64 save: eight `PeerTransport` frames). */
export const BLOB_CHUNK = 32_000;

interface BlobMsg {
  ch: 'blob';
  id: string;
  i: number;
  n: number;
  s: string;
}

const isBlob = (x: unknown): x is BlobMsg => {
  if (typeof x !== 'object' || x === null) return false;
  const m = x as BlobMsg;
  return m.ch === 'blob' && typeof m.id === 'string' && Number.isInteger(m.i) && Number.isInteger(m.n) && typeof m.s === 'string';
};

/** Sends `text` to a peer in pieces under `id`. */
export function sendBlob(transport: Transport, to: PeerId, id: string, text: string): void {
  const n = Math.max(1, Math.ceil(text.length / BLOB_CHUNK));
  for (let i = 0; i < n; i++) transport.send(to, { ch: 'blob', id, i, n, s: text.slice(i * BLOB_CHUNK, (i + 1) * BLOB_CHUNK) } satisfies BlobMsg);
}

/** Puts texts sent with `sendBlob` together again (from one peer, usually the host). */
export class BlobReceiver {
  private readonly parts = new Map<string, { n: number; got: string[] }>();
  private readonly off: () => void;

  constructor(
    transport: Transport,
    from: PeerId,
    private readonly onDone: (id: string, text: string) => void,
    private readonly onProgress?: (id: string, got: number, of: number) => void,
  ) {
    this.off = transport.on('message', (peer, msg) => {
      if (peer === from && isBlob(msg)) this.piece(msg);
    });
  }

  private piece(m: BlobMsg): void {
    let p = this.parts.get(m.id);
    if (m.i === 0) this.parts.set(m.id, (p = { n: m.n, got: [] }));
    if (!p || m.i !== p.got.length || m.n !== p.n) return;
    p.got.push(m.s);
    this.onProgress?.(m.id, p.got.length, p.n);
    if (p.got.length === p.n) {
      this.parts.delete(m.id);
      this.onDone(m.id, p.got.join(''));
    }
  }

  /** How far a text has come (0…1), or null if none is on its way. */
  progress(id: string): number | null {
    const p = this.parts.get(id);
    return p ? p.got.length / p.n : null;
  }

  dispose(): void {
    this.off();
  }
}
