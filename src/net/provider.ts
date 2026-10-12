import { peerProvider } from './peer';
import { relayProvider } from './relay';
import type { Transport, TransportProvider } from './transport';

/**
 * Which transport a network game uses (docs/NETWORK.md, section 10). By default our relay first
 * (variant B: a WebSocket to Cloudflare goes through any router), then, if the relay cannot be
 * reached, the direct WebRTC channels of variant A. A host that fell back to WebRTC is not on the
 * relay, so a joining browser that finds no such game there tries WebRTC as well.
 *
 * Address parameters for testing: `?net=relay` or `?net=peer` uses only that one, `?relay=<wss url>`
 * another relay (a local `wrangler dev`, say).
 */
export function gameProvider(params: URLSearchParams): TransportProvider {
  const relay = relayProvider(params.get('relay') ? { url: params.get('relay')! } : {});
  const peer = peerProvider();
  const net = params.get('net');
  if (net === 'relay') return relay;
  if (net === 'peer') return peer;
  return fallbackProvider(relay, peer);
}

/** Tries `first`, and `second` when it fails. */
export function fallbackProvider(first: TransportProvider, second: TransportProvider): TransportProvider {
  const either = async (a: () => Promise<Transport>, b: () => Promise<Transport>): Promise<Transport> => {
    try {
      return await a();
    } catch (err) {
      console.warn('network: falling back to the other transport', err);
      return b();
    }
  };
  return {
    host: (code) => either(() => first.host(code), () => second.host(code)),
    join: (code) => either(() => first.join(code), () => second.join(code)),
  };
}
