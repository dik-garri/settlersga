import { DurableObject } from 'cloudflare:workers';
import { CLOSE, HOST, closed, message, opened, refusal, type Role, type RoomSockets } from './room';

/**
 * The game's WebSocket relay on Cloudflare (variant B of docs/NETWORK.md, section 10): a Worker that
 * hands `wss://…/room/<CODE>?role=host|join` to the Durable Object named after the code. The object
 * uses the WebSocket Hibernation API: between frames it sleeps and costs nothing, and the clients'
 * `ping` is answered with `pong` by the platform without waking it. All routing is `room.ts`.
 */

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  /** Comma-separated origins allowed to open rooms (the game's site, local dev); empty = any. */
  ALLOWED_ORIGINS?: string;
}

const CODE = /^\/room\/([A-HJ-NP-Z2-9]{6})$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = CODE.exec(url.pathname);
    if (!m) return new Response('Settlers relay: wss://<this host>/room/<CODE>?role=host|join\n', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket only', { status: 426 });
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') ?? '';
    if (allowed.length && !allowed.some((a) => origin === a || (a.endsWith(':*') && origin.startsWith(a.slice(0, -1))))) {
      return new Response('origin not allowed', { status: 403 });
    }
    const role = url.searchParams.get('role');
    if (role !== 'host' && role !== 'join') return new Response('role must be host or join', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  /** When the socket opened (ms): its liveness until the first ping. */
  at: number;
}

export class Room extends DurableObject<Env> {
  private sockets: RoomSockets<WebSocket>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.sockets = {
      all: () => ctx.getWebSockets(),
      tagOf: (s) => ctx.getTags(s)[0] ?? '',
      send: (s, text) => {
        try {
          s.send(text);
        } catch {
          // closing already
        }
      },
      close: (s, code, reason) => {
        try {
          s.close(code, reason);
        } catch {
          // closed already
        }
      },
      lastSeen: (s) => {
        const pinged = ctx.getWebSocketAutoResponseTimestamp(s)?.getTime() ?? 0;
        const at = (s.deserializeAttachment() as Attachment | null)?.at ?? 0;
        return Math.max(pinged, at);
      },
    };
  }

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get('role') as Role;
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const refused = refusal(this.sockets, role);
    if (refused) {
      server.accept();
      server.send(JSON.stringify({ t: refused }));
      server.close(CLOSE.refused, refused);
      return new Response(null, { status: 101, webSocket: client });
    }
    const tag = role === 'host' ? HOST : 'p' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment({ at: Date.now() } satisfies Attachment);
    opened(this.sockets, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg === 'string') message(this.sockets, ws, msg, Date.now());
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    closed(this.sockets, ws);
    try {
      ws.close(code === 1005 || code === 1006 ? CLOSE.normal : code, reason);
    } catch {
      // closed already
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    closed(this.sockets, ws);
  }
}
