//
// Bridge the Co-writer sub-agent's progress into Praxis's live chat.
//
// Two gaps this closes:
//
// 1. vtx's ``progress_callback`` is never installed by Praxis, so the writer's
//    ``subagent_start`` / ``text_delta`` / ``tool_start`` / ``tool_result`` events
//    went nowhere. Installing this module's sync callback on the vtx
//    ``ConversationRuntime`` turns them into SSE ``progress`` events on the
//    parent turn, so the chat shows a live panel while the notebook is written.
//
// 2. Background tasks settle long after the parent turn ended. ``notify_completion``
//    broadcasts a completion frame to every connected browser client immediately,
//    instead of waiting for vtx's between-turn drain.

import { AsyncLocalStorage } from "node:async_hooks";

// ported yet — console.error is the closest equivalent.
const logger = {
  exception: (msg: string, err?: unknown) =>
    console.error(`[notebook_agent.events] ${msg}`, err ?? ""),
};

type BroadcastFn = (frame: Record<string, unknown>) => Promise<void> | void;

let _broadcast: BroadcastFn | null = null;
let _runtime: any = null; // TODO(verify): AgentRuntime type once src/agent/runtime.ts lands

// Node equivalent: AsyncLocalStorage. Tokens emulate ContextVar.set/reset.
const _turnStorage = new AsyncLocalStorage<any>();

let _seq = 1; // itertools.count(1)

export function set_broadcast(fn: BroadcastFn | null): void {
  _broadcast = fn;
}

export function set_runtime(runtime: any): void {
  _runtime = runtime;
}

// camelCase aliases for callers that prefer TS convention.
export const setBroadcast = set_broadcast;
export const setRuntime = set_runtime;

export function set_current_turn(turn: any): { prev: unknown } {
  // Binds the turn that owns the active tool call; returns a reset token.
  const prev = _turnStorage.getStore();
  _turnStorage.enterWith(turn);
  return { prev };
}

export function reset_current_turn(token: any): void {
  try {
    const prev = token && typeof token === "object" ? (token as { prev?: unknown }).prev : undefined;
    _turnStorage.enterWith(prev);
  } catch {
  }
}

export function current_turn(session_id = ""): any {
  // Prefer the turn bound to this call, else the session's active turn.
  const turn = _turnStorage.getStore();
  if (turn != null && (!session_id || turn.session_id === session_id)) {
    return turn;
  }
  const runtime = _runtime;
  if (runtime != null && session_id) {
    return runtime.active_turn_for_session(session_id);
  }
  return null;
}

export function progress_callback(tool_call_id: string, payload: Record<string, any>): void {
  // Sync vtx callback: ``callback(tool_call_id, {kind, subagent, ...})``.
  const turn = _turnStorage.getStore();
  const runtime = _runtime;
  if (turn == null || runtime == null) {
    return;
  }
  const kind = String(payload?.kind || "progress");
  const subagent = payload?.subagent;
  if (subagent != null && subagent !== "co-writer" && subagent !== "notebook-writer") {
    return;
  }

  const labels: Record<string, string> = {
    subagent_start: "Starting Co-writer",
    text_delta: "Writing notebook",
    tool_start: "Looking up notebook pages",
    tool_result: "Finished a lookup",
    turn_end: "Drafting pages",
    subagent_end: "Notebook draft complete",
    error: "Co-writer hit an error",
    cancelled: "Co-writer cancelled",
    interrupted: "Co-writer interrupted",
  };
  let content = labels[kind] ?? kind;
  if (kind === "tool_start") {
    content = `Calling ${payload?.tool_name || "a tool"}`;
  }
  if (kind === "error") {
    content = `Co-writer error: ${String(payload?.error || "").slice(0, 300)}`;
  }

  const meta: Record<string, any> = {
    tool_call_id: tool_call_id,
    tool_name: "notebook",
    notebook_progress: {
      kind,
      delta: kind === "text_delta" ? String(payload?.delta || "") : "",
      tool: kind ? String(payload?.tool_name || "") : "",
      tool_counts: payload?.tool_counts || {},
      turns: Number(payload?.turns || 0),
      subagent: "co-writer",
    },
  };
  // Node has no get_running_loop check; _emit_progress never rejects.
  void _emit_progress(runtime, turn, content, meta);
}

async function _emit_progress(
  runtime: any,
  turn: any,
  content: string,
  meta: Record<string, any>,
): Promise<void> {
  try {
    // `from ..runtime import AgentRuntime`.
    const { AgentRuntime } = await import("../runtime.js");
    const event = AgentRuntime._stream_event(turn, "progress", {
      content,
      source: "notebook",
      stage: "responding",
      metadata: meta,
    });
    await runtime._emit(turn, event);
    // Once the parent turn has ended its subscriber pumps are gone, so
    // ``_emit`` only records the frame into the turn log — a detached
    // background task would look frozen in the chat. Push the same frame to
    // the session's realtime broadcast channel so progress keeps streaming
    // live (identical shape to the in-turn ``progress`` frames; clients
    // de-dupe by ``turn_id:seq`` during the short post-``done`` grace window
    // where a pump may still be attached). While the turn is still running
    // the live pump already delivers it, so broadcasting would duplicate.
    if (turn != null && turn.status !== "running") {
      const fn = _broadcast;
      if (fn != null) {
        try {
          await fn(event);
        } catch (bErr) {
          logger.exception("Could not broadcast background progress", bErr);
        }
      }
    }
  } catch (err) {
    // progress must never fail the writer
    logger.exception("Could not emit notebook progress event", err);
  }
}

/**
 * Inject a user-role message into the session's cached agent history so a
 * background-task completion reaches the model on the next turn. Delegates
 * to the AgentRuntime registered via ``set_runtime``; a no-op when no
 * runtime/agent is cached (e.g. before the first turn or after a restart).
 */
export function inject_session_message(session_id: string, content: string): void {
  try {
    _runtime?.inject_user_message?.(session_id, content);
  } catch (err) {
    // injection is best effort — never fail the completion path
    logger.exception("Could not inject session message", err);
  }
}

export async function notify_completion(opts: {
  session_id: string;
  turn_id: string;
  task_id: string;
  label: string;
  report: string;
  status?: string;
  error?: string;
}): Promise<void> {
  // Push a completion frame to every connected client, immediately.
  const { session_id, turn_id, task_id, label, report } = opts;
  const status = opts.status ?? "completed";
  const error = opts.error ?? "";
  const fn = _broadcast;
  if (fn == null || !session_id) {
    return;
  }
  const payload = { task_id, label, report, status, error };
  const frame: Record<string, unknown> = {
    type: "turn_event",
    protocol_version: "2.0",
    seq: _seq++,
    session_id,
    turn_id,
    timestamp: Date.now() / 1000,
    source: "notebook",
    stage: "responding",
    content: status === "completed" ? `Notebook ready: ${label}` : `Notebook failed: ${label}`,
    metadata: { notebook_completed: payload },
  };
  try {
    await fn(frame);
  } catch (err) {
    logger.exception("Could not broadcast notebook completion", err);
  }
}
