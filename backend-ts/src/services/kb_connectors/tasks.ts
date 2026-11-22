// in-memory SSE task log streams for KB background operations.
import type { Context } from "hono";

interface TaskEvent {
  event: string;
  payload: Record<string, unknown>;
}

const MAX_EVENTS_PER_TASK = 500;
const MAX_BYTES_PER_TASK = 2 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

class TaskStreamManager {
  private buffers = new Map<string, TaskEvent[]>();
  private bufferBytes = new Map<string, number>();
  private subscribers = new Map<string, Set<(e: TaskEvent) => void>>();
  private terminalAt = new Map<string, number>();

  ensureTask(taskId: string): void {
    if (!this.buffers.has(taskId)) {
      this.buffers.set(taskId, []);
      this.bufferBytes.set(taskId, 0);
    }
    if (!this.subscribers.has(taskId)) this.subscribers.set(taskId, new Set());
  }

  private append(taskId: string, event: TaskEvent): void {
    let buf = this.buffers.get(taskId);
    if (!buf) {
      this.ensureTask(taskId);
      buf = this.buffers.get(taskId)!;
    }
    let size = 0;
    try {
      size = Buffer.byteLength(JSON.stringify(event), "utf8");
    } catch {
      size = 256;
    }
    let bytes = this.bufferBytes.get(taskId) ?? 0;
    while (
      buf.length >= MAX_EVENTS_PER_TASK ||
      bytes + size > MAX_BYTES_PER_TASK
    ) {
      const removed = buf.shift()!;
      try {
        bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
      } catch {
        bytes -= 256;
      }
    }
    if (size > MAX_BYTES_PER_TASK) {
      event = {
        event: event.event,
        payload: {
          detail: String((event.payload as Record<string, unknown>)?.["detail"] ?? "").slice(0, 8192),
          truncated: true,
        },
      };
    }
    buf.push(event);
    this.bufferBytes.set(taskId, Math.max(0, bytes) + JSON.stringify(event).length);
  }

  emit(taskId: string, event: string, payload: Record<string, unknown>): void {
    const ev: TaskEvent = { event, payload };
    this.append(taskId, ev);
    if (event === "complete" || event === "failed") {
      this.terminalAt.set(taskId, Date.now());
    }
    for (const fn of this.subscribers.get(taskId) ?? []) {
      try {
        fn(ev);
      } catch {
        /* subscriber gone */
      }
    }
  }

  emitLog(taskId: string, line: string): void {
    this.emit(taskId, "process_log", {
      level: "INFO",
      message: line,
      logger: "deeptutor.knowledge.task",
      timestamp: Date.now() / 1000,
      context: { task_id: taskId, capability: "knowledge", sink: "ui" },
    });
  }

  emitComplete(taskId: string, detail = "Task completed"): void {
    this.emit(taskId, "complete", { detail, task_id: taskId });
  }

  emitFailed(taskId: string, detail: string, extra: Record<string, unknown> = {}): void {
    this.emit(taskId, "failed", { detail, task_id: taskId, ...extra });
  }

  backlog(taskId: string): TaskEvent[] {
    this.ensureTask(taskId);
    return [...(this.buffers.get(taskId) ?? [])];
  }

  subscribe(taskId: string): { backlog: TaskEvent[]; onEvent: (fn: (e: TaskEvent) => void) => () => void; isTerminal: () => boolean } {
    this.ensureTask(taskId);
    return {
      backlog: this.backlog(taskId),
      onEvent: (fn) => {
        let set = this.subscribers.get(taskId);
        if (!set) {
          set = new Set();
          this.subscribers.set(taskId, set);
        }
        set.add(fn);
        return () => set!.delete(fn);
      },
      isTerminal: () => {
        const buf = this.buffers.get(taskId) ?? [];
        const last = buf[buf.length - 1];
        return last !== undefined && (last.event === "complete" || last.event === "failed");
      },
    };
  }
}

export const taskStreamManager = new TaskStreamManager();

// -- task ids (task_id_manager.py) --------------------------------------------------

const taskIds = new Map<string, string>();
const taskMeta = new Map<string, Record<string, unknown>>();

export function buildUniqueTaskId(taskType: string, taskKeyPrefix: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, (ch) => (ch === "T" ? "_" : ch === ":" ? "" : ch))
    .replace(/\..+/, "")
    .replace(/__/g, "_");
  // Match upstream "YYYYMMDD_HHMMSS" shape.
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  void stamp;
  const taskKey = `${taskKeyPrefix}_${new Date().toISOString()}_${crypto.randomUUID().slice(0, 8)}`;
  const existing = taskIds.get(taskKey);
  if (existing) return existing;
  const unique = crypto.randomUUID().slice(0, 8);
  const taskId = `${taskType}_${timestamp}_${unique}`;
  taskIds.set(taskKey, taskId);
  taskMeta.set(taskId, {
    task_type: taskType,
    task_key: taskKey,
    created_at: new Date().toISOString(),
    status: "running",
  });
  taskStreamManager.ensureTask(taskId);
  return taskId;
}

export function updateTaskStatus(taskId: string, status: string, extra: Record<string, unknown> = {}): void {
  const meta = taskMeta.get(taskId);
  if (meta) {
    meta["status"] = status;
    Object.assign(meta, extra);
    if (["completed", "error", "cancelled"].includes(status)) {
      meta["finished_at"] = new Date().toISOString();
    }
  }
}

export function getTaskMetadata(taskId: string): Record<string, unknown> | null {
  const meta = taskMeta.get(taskId);
  return meta ? { ...meta } : null;
}

// -- SSE route helper ------------------------------------------------------------------

function sseFormat(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Hono handler for GET /knowledge-bases/tasks/{task_id}/stream. */
export async function streamTaskLogs(c: Context): Promise<Response> {
  const taskId = c.req.param("task_id") ?? "";
  const sub = taskStreamManager.subscribe(taskId);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (ev: TaskEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseFormat(ev.event, ev.payload)));
        } catch {
          closed = true;
        }
      };
      const unsub = sub.onEvent(send);
      for (const ev of sub.backlog) send(ev);
      if (sub.isTerminal()) {
        closed = true;
        unsub();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        return;
      }
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);
      const origClose = controller.close.bind(controller);
      controller.close = () => {
        closed = true;
        clearInterval(heartbeat);
        unsub();
        origClose();
      };
      // Close when the client disconnects.
      c.req.raw.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(heartbeat);
        unsub();
        try {
          controller.close();
        } catch {
          /* noop */
        }
      });
    },
    cancel() {
      /* client went away; heartbeat/abort handler cleans up */
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
