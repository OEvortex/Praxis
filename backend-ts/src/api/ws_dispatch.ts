// Shared WebSocket upgrade dispatcher for the node http.Server returned by
// serve() in main.ts. Every WS endpoint is mounted under /ws:
//
//   /ws                        → unified turn protocol (unified_ws.py)
//   /ws/questions/judge        → AI quiz judge      (quiz_judge.py)
//   /ws/questions/mimic        → mimic exam gen     (question.py) — stub
//   /ws/questions/generate     → question gen       (question.py) — stub
//   /ws/mastery-paths          → mastery topic_event replay (mastery_path.py)
//   /ws/knowledge-bases/{kb}/progress → KB indexing progress stream
//                                (knowledge.py websocket_progress)
//   /ws/books                  → books channel — implemented as SSE in
//                                realtime.ts (handleBooksChannel), no WS port
//   /ws/partners/{id}          → partner web chat   (partners.py partner_chat_ws)
//   /ws/partner-groups/{id}    → group chat + live turns / invocation approvals
//                                (partner_groups.py partner_group_ws)
//                                both in ./partners_ws.js
//
// The unprefixed aliases (/questions/judge, /mimic, /generate,
// /mastery-paths, /api/mastery-paths) are also accepted for convenience.
//
// Call `attachAllWs(server, { settings })` once from the isMain block in
// main.ts. It owns the server 'upgrade' event: known paths are upgraded via a
// single noServer WebSocketServer and routed by pathname; everything else is
// destroyed (same behavior attachUnifiedWs had for non-/ws paths).

import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Settings } from "../config.js";
import { get_settings } from "../config.js";
import { handleUnifiedWsConnection } from "./unified_ws.js";
import {
  handleMimicWebSocket,
  handleQuestionGenerateWebSocket,
  handleQuizJudgeWebSocket,
} from "./quiz.js";

// NOTE: mastery.ts statically imports ../main.js (appState). A static import
// here would deadlock: main.ts's isMain block top-level-awaits this module
// while main.js is still evaluating. Resolve it lazily per connection instead
// — by then main.js evaluation has completed.
let masteryHandlerPromise: Promise<typeof import("./mastery.js")> | null = null;
function loadMastery() {
  masteryHandlerPromise ??= import("./mastery.js");
  return masteryHandlerPromise;
}

const KB_PROGRESS_RE = /^\/ws\/knowledge-bases\/([^/]+)\/progress$/;
const PARTNER_WS_RE = /^\/ws\/partners\/([^/]+)$/;
const PARTNER_GROUP_WS_RE = /^\/ws\/partner-groups\/([^/]+)$/;
// The live path is "/ws/knowledge-bases/{kb_name}/progress".
const KB_PROGRESS_WS_PATH = "/ws/knowledge-bases/:kb_name/progress";
void KB_PROGRESS_WS_PATH;

function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return req.url ?? "/";
  }
}

export interface WsDispatchOptions {
  settings?: Settings;
}

/**
 * Attach the unified WS upgrade dispatcher to a node http(s) server.
 * Returns the WebSocketServer so callers can close it on shutdown.
 */
export function attachAllWs(server: HttpServer, opts: WsDispatchOptions = {}): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = pathnameOf(req);
    const known =
      path === "/ws" ||
      path === "/ws/questions/judge" ||
      path === "/questions/judge" ||
      path === "/ws/questions/mimic" ||
      path === "/mimic" ||
      path === "/ws/questions/generate" ||
      path === "/generate" ||
      path === "/ws/mastery-paths" ||
      path === "/mastery-paths" ||
      path === "/api/mastery-paths" ||
      KB_PROGRESS_RE.test(path) ||
      PARTNER_WS_RE.test(path) ||
      PARTNER_GROUP_WS_RE.test(path);
    if (!known) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const path = pathnameOf(req);
    const settings = opts.settings;
    if (path === "/ws") {
      handleUnifiedWsConnection(ws, req).catch((exc) => {
        try {
          ws.send(
            JSON.stringify({
              type: "protocol_error",
              protocol_version: "2.0",
              error_code: "internal_error",
              message: String(exc),
              retryable: true,
            }),
          );
        } catch { /* closed */ }
        try { ws.close(); } catch { /* closed */ }
      });
    } else if (path === "/ws/questions/judge" || path === "/questions/judge") {
      void handleQuizJudgeWebSocket(ws);
    } else if (path === "/ws/questions/mimic" || path === "/mimic") {
      void handleMimicWebSocket(ws);
    } else if (path === "/ws/questions/generate" || path === "/generate") {
      void handleQuestionGenerateWebSocket(ws);
    } else if (KB_PROGRESS_RE.test(path)) {
      const kbName = decodeURIComponent(KB_PROGRESS_RE.exec(path)![1]);
      void handleKbProgressWebSocket(ws, req, kbName, settings ?? get_settings());
    } else if (PARTNER_WS_RE.test(path) || PARTNER_GROUP_WS_RE.test(path)) {
      const m = (PARTNER_WS_RE.exec(path) ?? PARTNER_GROUP_WS_RE.exec(path))!;
      const id = decodeURIComponent(m[1]);
      void import("./partners_ws.js")
        .then((mod) =>
          PARTNER_WS_RE.test(path)
            ? mod.handlePartnerWs(ws, req, id)
            : mod.handlePartnerGroupWs(ws, req, id),
        )
        .catch(() => {
          try { ws.close(); } catch { /* closed */ }
        });
    } else {
      // /ws/mastery-paths and aliases
      void loadMastery()
        .then((m) => m.handleMasteryWebSocket(ws, { settings }))
        .catch(() => {
          try { ws.close(); } catch { /* closed */ }
        });
    }
  });

  return wss;
}

// -- /ws/knowledge-bases/{kb}/progress (knowledge.py websocket_progress) --------
//
// Streams {"type":"progress","data":{...}} frames built from the KB's
// .progress.json snapshot (ProgressTracker) plus live broadcaster updates.
// With ?task_id= the socket settles on that task's terminal state; without an
// active task it sends the current snapshot once and closes — same contract as
// upstream. Client messages are ignored (upstream only reads to detect
// disconnect).

async function handleKbProgressWebSocket(
  ws: WebSocket,
  req: IncomingMessage,
  kbName: string,
  settings: Settings,
): Promise<void> {
  const send = (payload: Record<string, unknown>) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* closed */
    }
  };
  try {
    const { getKbEntry } = await import("../services/kb_connectors/store.js");
    const { ProgressTracker, subscribeProgress } = await import(
      "../services/kb_connectors/indexing.js"
    );
    const { getTaskMetadata } = await import("../services/kb_connectors/tasks.js");

    const entry = getKbEntry(settings, kbName);
    if (entry === null) {
      send({ type: "error", message: `Knowledge base '${kbName}' not found` });
      try { ws.close(); } catch { /* closed */ }
      return;
    }

    const tracker = new ProgressTracker(settings, kbName);
    const initial = tracker.getProgress();
    const url = new URL(req.url ?? "/", "http://localhost");
    const expectedTaskId = url.searchParams.get("task_id") ?? "";

    const sendAndClose = (data: Record<string, unknown>) => {
      send({ type: "progress", data });
      setTimeout(() => {
        try { ws.close(); } catch { /* closed */ }
      }, 50);
    };

    if (expectedTaskId) {
      const progressTaskId = initial?.["task_id"] ? String(initial["task_id"]) : null;
      const stage = initial?.["stage"] ? String(initial["stage"]) : null;
      const taskMeta = getTaskMetadata(expectedTaskId);

      // A terminal durable snapshot is authoritative — replay and close.
      if (progressTaskId === expectedTaskId && (stage === "completed" || stage === "error")) {
        sendAndClose(initial!);
        return;
      }
      if (!taskMeta) {
        // Orphaned task id (server restarted / task evicted): settle as a
        // durable retryable error, like upstream.
        const errorMessage =
          "Knowledge-base processing was interrupted by a server restart. Retry the operation to continue.";
        sendAndClose({
          kb_name: kbName,
          task_id: expectedTaskId,
          stage: "error",
          message: errorMessage,
          error: errorMessage,
          error_code: "knowledge_task_interrupted",
          retryable: true,
          progress_percent: 0,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      const taskStatus = String(taskMeta["status"] ?? "");
      if (["completed", "error", "cancelled"].includes(taskStatus)) {
        const isCompleted = taskStatus === "completed";
        const message = isCompleted
          ? "Knowledge-base processing completed."
          : String(taskMeta["error"] ?? "Knowledge-base processing failed.");
        sendAndClose({
          kb_name: kbName,
          task_id: expectedTaskId,
          stage: isCompleted ? "completed" : "error",
          message,
          progress_percent: isCompleted ? 100 : 0,
          timestamp: String(taskMeta["finished_at"] ?? new Date().toISOString()),
          ...(isCompleted
            ? {}
            : { error: message, error_code: "knowledge_task_failed", retryable: true }),
        });
        return;
      }
    }

    // Fast path: no active task — send current state and close.
    const stage = initial?.["stage"] ? String(initial["stage"]) : null;
    const ts = initial?.["timestamp"] ? Date.parse(String(initial["timestamp"])) : NaN;
    const ageSeconds = Number.isFinite(ts) ? (Date.now() - ts) / 1000 : null;
    const hasActiveTask =
      stage !== null && !["completed", "error"].includes(stage) && ageSeconds !== null && ageSeconds < 120;
    const kbIsReady = String(entry["status"] ?? "") === "ready";

    if (!hasActiveTask && !expectedTaskId) {
      if (kbIsReady) {
        sendAndClose({ stage: "completed", message: "Knowledge base is ready.", percent: 100, current: 1, total: 1 });
      } else {
        sendAndClose(
          initial ?? { stage: "error", message: "Knowledge base needs reindex or initialization." },
        );
      }
      return;
    }

    // Live path: replay the current snapshot, then stream timestamp changes
    // (broadcaster pushes + 1s file poll, mirroring upstream's receive timeout).
    let lastTimestamp = initial?.["timestamp"] ? String(initial["timestamp"]) : null;
    const unsubscribe = subscribeProgress(kbName, (progress) => {
      send({ type: "progress", data: progress });
      const pstage = String(progress["stage"] ?? "");
      if (["completed", "error"].includes(pstage)) {
        setTimeout(() => {
          cleanup();
          try { ws.close(); } catch { /* closed */ }
        }, 3000);
      }
    });

    const cleanup = () => {
      unsubscribe();
      clearInterval(timer);
      ws.off("close", cleanup);
    };
    ws.on("close", cleanup);

    if (initial) send({ type: "progress", data: initial });

    const timer = setInterval(() => {
      try {
        const current = tracker.getProgress();
        if (current) {
          const currentTs = current["timestamp"] ? String(current["timestamp"]) : null;
          const progressTaskId = current["task_id"] ? String(current["task_id"]) : null;
          if (!(expectedTaskId && progressTaskId && progressTaskId !== expectedTaskId)) {
            if (currentTs !== lastTimestamp) {
              lastTimestamp = currentTs;
              send({ type: "progress", data: current });
              const pstage = String(current["stage"] ?? "");
              if (["completed", "error"].includes(pstage)) {
                setTimeout(() => {
                  cleanup();
                  try { ws.close(); } catch { /* closed */ }
                }, 3000);
                return;
              }
            }
          }
        }
        if (expectedTaskId) {
          const meta = getTaskMetadata(expectedTaskId);
          const status = String(meta?.["status"] ?? "");
          if (["completed", "error", "cancelled"].includes(status)) {
            const isCompleted = status === "completed";
            const message = isCompleted
              ? "Knowledge-base processing completed."
              : String(meta?.["error"] ?? "Knowledge-base processing failed.");
            send({
              type: "progress",
              data: {
                kb_name: kbName,
                task_id: expectedTaskId,
                stage: isCompleted ? "completed" : "error",
                message,
                error: isCompleted ? null : message,
                error_code: isCompleted ? null : "knowledge_task_failed",
                retryable: !isCompleted,
                progress_percent: isCompleted ? 100 : 0,
                timestamp: String(meta?.["finished_at"] ?? new Date().toISOString()),
              },
            });
            setTimeout(() => {
              cleanup();
              try { ws.close(); } catch { /* closed */ }
            }, 3000);
          }
        }
      } catch {
        /* transient read failure — keep polling */
      }
    }, 1000);
    timer.unref?.();
  } catch (exc) {
    send({ type: "error", message: String(exc) });
    try { ws.close(); } catch { /* closed */ }
  }
}
