// the unified WebSocket turn
// protocol at /ws. The TS realtime hub is SSE+REST (realtime.ts); this adds
// the upstream WS transport on top of the SAME ClientSession command handler,
// so every command type the original socket accepts works identically: frames
// produced by ClientSession.handle are forwarded verbatim as WS text frames.
//
// @hono/node-server has no WS upgrade helper, so this module exports
// `attachUnifiedWs(server)` — call it with the http.Server returned by
// serve() in main.ts (server.on('upgrade', ...)). See the wiring TODO in the
// report; nothing here edits main.ts.

import { WebSocketServer, WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { RealtimeHub } from "./realtime.js";
import type { Dict } from "../shared/types.js";

const PROTOCOL_VERSION = "2.0";

interface WsConn {
  ws: WebSocket;
  clientId: string;
  closed: boolean;
  pump: Promise<void> | null;
}

async function hubFor(): Promise<RealtimeHub> {
  const mod = (await import("../main.js")) as unknown as {
    appState?: { realtime?: RealtimeHub };
  };
  const hub = mod.appState?.realtime;
  if (!hub) throw new Error("RealtimeHub not configured");
  return hub;
}

function sendFrame(conn: WsConn, frame: Dict): void {
  if (conn.closed || conn.ws.readyState !== WebSocket.OPEN) return;
  try {
    conn.ws.send(JSON.stringify({ protocol_version: PROTOCOL_VERSION, ...frame }));
  } catch {
    conn.closed = true;
  }
}

async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  const hub = await hubFor();
  const url = new URL(req.url ?? "/", "http://localhost");
  const clientId = url.searchParams.get("client_id") || `ws_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const client = await hub.get(clientId);

  const conn: WsConn = { ws, clientId, closed: false, pump: null };

  const sendError = (message: string, extra: Dict = {}) =>
    sendFrame(conn, { type: "protocol_error", error_code: "internal_error", message, retryable: true, ...extra });

  // Pump the client's outbound queue onto the socket. Mirrors the SSE route's
  // frame pump (named SSE events become plain JSON text frames upstream).
  const pump = (async () => {
    while (!conn.closed) {
      const frame = await client.queue.getWithTimeout(1000);
      if (frame === null) continue;
      sendFrame(conn, frame);
    }
  })();
  conn.pump = pump;

  ws.on("message", (data) => {
    void (async () => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(data));
      } catch {
        sendFrame(conn, { type: "protocol_error", error_code: "invalid_json", message: "Invalid JSON.", retryable: false });
        return;
      }
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        sendFrame(conn, { type: "protocol_error", error_code: "invalid_command", message: "WebSocket commands must be JSON objects.", retryable: false });
        return;
      }
      const msg = decoded as Dict;
      if (msg["protocol_version"] !== PROTOCOL_VERSION) {
        sendFrame(conn, {
          type: "protocol_error",
          error_code: "unsupported_protocol_version",
          message: `Unsupported or missing protocol_version; expected ${PROTOCOL_VERSION}.`,
          retryable: false,
        });
        return;
      }
      try {
        await client.handle(msg, "");
      } catch (exc) {
        sendError(exc instanceof Error ? exc.message : String(exc));
      }
    })();
  });

  const cleanup = () => {
    conn.closed = true;
    client.queue.close();
    void hub.release(clientId).catch(() => {});
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

export { handleConnection as handleUnifiedWsConnection };

/**
 * Attach the /ws upgrade handler to a node http(s) server. Returns the
 * WebSocketServer so callers can close it on shutdown.
 *
 * NOTE: this registers its own 'upgrade' listener that destroys every other
 * path. Prefer `attachAllWs` from ./ws_dispatch.js when multiple WS endpoints
 * share the server.
 */
export function attachUnifiedWs(server: HttpServer, path = "/ws"): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  wss.on("connection", (ws, req) => {
    handleConnection(ws, req).catch((exc) => {
      try {
        ws.send(JSON.stringify({ type: "protocol_error", protocol_version: PROTOCOL_VERSION, error_code: "internal_error", message: String(exc), retryable: true }));
      } catch { /* closed */ }
      ws.close();
    });
  });
  return wss;
}

/** Hono-side informational route so `app.route('/', unifiedWsRouter)` is safe. */
export const unifiedWsInfo = { path: "/ws", protocol_version: PROTOCOL_VERSION };
