/**
 * Link-cable relay Worker.
 *
 * Clients connect a WebSocket to `wss://<worker>/link/<roomCode>`. All
 * clients sharing a roomCode land on the same Durable Object instance
 * (`idFromName(roomCode)`), which pairs the first two and relays every
 * message between them verbatim. A third joiner is rejected with a
 * `room-full` message before the WebSocket closes.
 *
 * The Worker is transport-only — it doesn't understand the Game Boy
 * serial protocol at all. The emulator client owns the message shape;
 * this file just shuttles bytes (and WebRTC signalling payloads — the
 * relay treats both as opaque strings, no parsing needed).
 */

/** Origins permitted to open a relay socket. Edit this list when the
 *  app moves to a new domain. Browser clients always send `Origin` on
 *  WebSocket upgrade, so the check filters out casual third-party use
 *  (custom non-browser clients can spoof it, but the check still cuts
 *  off the easy-to-misuse browser path). */
const ALLOWED_ORIGINS: readonly string[] = ["https://glowboot.pages.dev"];

function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

/** Cloudflare's Rate Limiting binding. Hand-typed because the
 *  `unsafe.bindings` API isn't in `@cloudflare/workers-types` yet. */
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ROOMS: DurableObjectNamespace;
  RATE_LIMITER: RateLimit;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const match = url.pathname.match(/^\/link\/([A-Za-z0-9_-]{1,32})$/);
    if (!match) return new Response("Not found", { status: 404 });

    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    if (!isOriginAllowed(req.headers.get("Origin"))) {
      return new Response("Forbidden origin", { status: 403 });
    }

    // Gate the expensive DO path per client IP. Sits after the cheap
    // rejections so probe traffic doesn't eat a legitimate user's
    // quota, and 429s short-circuit before any DO is instantiated.
    const clientIp = req.headers.get("CF-Connecting-IP");
    if (!clientIp) return new Response("Bad request", { status: 400 });
    const { success } = await env.RATE_LIMITER.limit({ key: clientIp });
    if (!success) return new Response("Too many requests", { status: 429 });

    // `idFromName` is deterministic: the same roomCode always lands on
    // the same DO instance, guaranteeing pair-ability regardless of
    // which edge location each client hit.
    const objId = env.ROOMS.idFromName(match[1]!.toLowerCase());
    const stub = env.ROOMS.get(objId);
    return stub.fetch(req);
  }
};

/** Hard ceiling on a single relayed message. Game Boy serial bytes
 *  amount to one transfer/transfer-reply object (~50 bytes); WebRTC
 *  signalling SDP can run a few KB. 4 KB is well above the
 *  legitimate worst case while still cutting off bandwidth-amp abuse. */
const MAX_MESSAGE_BYTES = 4 * 1024;
/** Sockets idle for this long are dropped. Real link sessions are
 *  always bursty — even a paused game pings every few seconds. Five
 *  minutes of total silence means someone's parking the room. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** How often the idle sweeper runs. The DO wakes up only on this
 *  alarm + on real WebSocket activity; setting it tighter than a
 *  minute would burn CPU on quiet rooms for no real benefit. */
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

/** Per-socket bookkeeping persisted via the Hibernating-WebSocket
 *  attachment API so it survives DO hibernation. */
interface SocketAttachment {
  last: number; // ms timestamp of last activity (open / message / pong)
}

/** Per-room Durable Object. Holds the two connected WebSockets and
 *  forwards everything one sends to the other. Uses the "Hibernating
 *  WebSockets" API (`acceptWebSocket`) so rooms with no activity
 *  stop billing CPU / memory until the next message. */
export class LinkRoom {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(_req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    // `WebSocketPair` is always {0: WebSocket, 1: WebSocket}; the
    // non-null assertions exist because `noUncheckedIndexedAccess`
    // widens numeric indexing to `T | undefined` and TypeScript has no
    // way to see the pair's fixed shape from its declaration.
    const client = pair[0]!;
    const server = pair[1]!;
    // Count existing peers BEFORE accepting the new one so the third
    // joiner gets rejected instead of being the one to get rejected.
    const existing = this.state.getWebSockets();
    if (existing.length >= 2) {
      server.accept();
      server.send(JSON.stringify({ type: "room-full" }));
      server.close(1000, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ last: Date.now() } satisfies SocketAttachment);
    // Notify both sides when the second joiner lands so each knows
    // the pair is ready for traffic.
    const nowPaired = existing.length === 1;
    server.send(JSON.stringify({ type: "joined", paired: nowPaired }));
    if (nowPaired) {
      for (const s of existing) {
        try {
          s.send(JSON.stringify({ type: "peer-joined" }));
        } catch {
          /* already closed — webSocketClose will clean up */
        }
      }
    }
    await this.ensureIdleAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MAX_MESSAGE_BYTES) {
      try {
        ws.close(1009, "message too large");
      } catch {
        /* already closed */
      }
      return;
    }
    ws.serializeAttachment({ last: Date.now() } satisfies SocketAttachment);
    // Relay verbatim to every OTHER peer. Strings and binary both
    // forward unchanged; the client protocol owns the encoding.
    for (const s of this.state.getWebSockets()) {
      if (s === ws) continue;
      try {
        s.send(message);
      } catch {
        /* closed socket mid-broadcast */
      }
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Notify the remaining peer (if any) so its UI can mark the link
    // disconnected. `getWebSockets()` has already removed `ws` by the
    // time this fires.
    for (const s of this.state.getWebSockets()) {
      if (s === ws) continue;
      try {
        s.send(JSON.stringify({ type: "peer-left" }));
      } catch {
        /* ignore */
      }
    }
  }

  webSocketError(ws: WebSocket, _err: unknown): void {
    this.webSocketClose(ws, 1011, "error", false);
  }

  /** Periodic sweep — closes any socket that hasn't sent a message in
   *  `IDLE_TIMEOUT_MS`. Runs on a self-rescheduling alarm so the DO
   *  goes back to hibernation between sweeps in quiet rooms. */
  async alarm(): Promise<void> {
    const now = Date.now();
    let aliveCount = 0;
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as SocketAttachment | null;
      const last = att?.last ?? now;
      if (now - last > IDLE_TIMEOUT_MS) {
        try {
          ws.close(1000, "idle timeout");
        } catch {
          /* already closed */
        }
      } else {
        aliveCount++;
      }
    }
    // Stop scheduling sweeps once the room is empty — the next
    // `acceptWebSocket` will rearm the alarm.
    if (aliveCount > 0) {
      await this.state.storage.setAlarm(Date.now() + IDLE_SWEEP_INTERVAL_MS);
    }
  }

  private async ensureIdleAlarm(): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null) {
      await this.state.storage.setAlarm(Date.now() + IDLE_SWEEP_INTERVAL_MS);
    }
  }
}
