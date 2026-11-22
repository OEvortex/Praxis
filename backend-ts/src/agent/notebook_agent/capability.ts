//
// Dispatch the Co-writer sub-agent.
//
// Mirrors ``video_lesson.capability``: the main agent only supplies the
// learner's request; Co-writer uses the same system prompt and tool list as the
// notebook chat (``nb_read``/``nb_list``/``nb_search``/``nb_patch`` plus the
// shared research tools) and edits the notebook directly — the same operations a
// user performs in the editor.
//
// ``background=True`` (the default) registers the run with vtx's
// ``BackgroundTaskManager`` so the parent turn returns immediately and the
// compiled report is delivered automatically on a later turn.

import { randomUUID } from "node:crypto";

import { load_co_writer_prompt } from "./prompt.js";
import { COWRITER_TOOL_NAMES, register_writer_tools } from "./tools.js";
import * as notebook_events from "./events.js";
import * as subagent from "../subagent.js";

const MAX_TURNS = 60;

// ---------------------------------------------------------------------------
// vtx SDK bridge
//
// TODO(verify): the Python module lazily imports `vtx.agent.dispatcher`
// (`get_context`), `vtx.agent.tools.task` (`SubagentSpec`,
// `resolve_subagent_runner`), `vtx.agent.background` (`get_manager`) and
// `vtx.core` (`UserMessage`). The vtx SDK is Python-only — same seam as
// src/agent/video_lesson/capability.ts. These helpers isolate the gap so the
// rest of the port stays faithful.
// ---------------------------------------------------------------------------

export interface DispatcherContext {
  progressCallback?: ((toolCallId: string, event: Record<string, unknown>) => void) | null;
  progress_callback?: ((toolCallId: string, event: Record<string, unknown>) => void) | null;
  background_manager?: BackgroundTaskManager | null;
  backgroundManager?: BackgroundTaskManager | null;
  session_id?: string | null;
  session?: { id?: string | null; append_message?: unknown; appendMessage?: unknown; [k: string]: unknown } | null;
  model?: string | null;
  [k: string]: unknown;
}

export interface SubagentResult {
  finalText: string;
  error?: string | null;
  [k: string]: unknown;
}

export interface SubagentRunnerArgs {
  parentCtx: DispatcherContext;
  spec: Record<string, unknown>;
  prompt: string;
  cancelEvent?: AbortSignal | null;
  modelOverride?: string | null;
  progressCallback?: DispatcherContext["progressCallback"];
  toolCallId: string;
  label: string;
}

export type SubagentRunner = (args: SubagentRunnerArgs) => Promise<SubagentResult>;

/** Port of `vtx.agent.dispatcher.get_context`. */
export function getDispatcherContext(): DispatcherContext | null {
  // Implemented in src/agent/subagent.ts — derives the context from the
  // active turn (notebook_agent/events.ts ALS) + the saved model selection.
  return subagent.getDispatcherContext() as DispatcherContext | null;
}

/** Port of `vtx.agent.tools.task.resolve_subagent_runner`. */
export function resolveSubagentRunner(): SubagentRunner {
  // Real runner in src/agent/subagent.ts (LocalAgentRuntime-backed loop).
  return subagent.resolve_subagent_runner() as SubagentRunner;
}

export interface BackgroundTaskRecord {
  task_id: string;
  notified?: boolean;
  [k: string]: unknown;
}

export interface BackgroundTaskManager {
  register(opts: {
    description: string;
    prompt: string;
    subagent_type: string;
    model?: string | null;
    parent_session_id?: string | null;
    run_coro_factory: () => Promise<unknown>;
  }): Promise<BackgroundTaskRecord>;
  [k: string]: unknown;
}

/** Port of `vtx.agent.background.get_manager`. */
export function getBackgroundTaskManager(): BackgroundTaskManager | null {
  // Singleton in src/agent/subagent.ts (process-local task registry).
  return subagent.getBackgroundTaskManager() as unknown as BackgroundTaskManager;
}

function _build_prompt(request: string, title: string, parent_page_id: string): string {
  const parts: string[] = [
    "Build the learner's notebook now.\n",
    title.trim() ? `Title hint: ${title.trim()}\n` : "",
    parent_page_id.trim()
      ? `Parent page: ${parent_page_id.trim()} — pages without an ` +
        "explicit `parent:` are created under this page.\n"
      : "Parent page: none — top-level pages go to the notebook root.\n",
    "Learner request:\n" + request.trim() + "\n",
    "Work like a user editing the notebook: check existing pages with " +
      "nb_list/nb_search first, then make ALL writes with nb_patch — " +
      "create pages, apply exact-match edits, append, rewrite, delete, " +
      "and move/reparent in atomic batches. Use nb_read (offset/limit) " +
      "before editing a page you haven't seen. Your final message is a " +
      "short report of what you created or changed — not the content.",
  ];
  return parts.filter((p) => p).join("");
}

async function _run_writer(
  parent_ctx: DispatcherContext,
  spec: Record<string, unknown>,
  prompt: string,
  tool_call_id: string,
  label: string,
): Promise<SubagentResult> {
  return await resolveSubagentRunner()({
    parentCtx: parent_ctx,
    spec,
    prompt,
    cancelEvent: null,
    modelOverride: null,
    progressCallback: parent_ctx.progressCallback ?? parent_ctx.progress_callback ?? null,
    toolCallId: tool_call_id,
    label,
  });
}

async function _run_writer_only(
  parent_ctx: DispatcherContext,
  spec: Record<string, unknown>,
  prompt: string,
  tool_call_id: string,
  label: string,
): Promise<SubagentResult> {
  // Run the writer once; its tools do the editing, text is the report.
  const result = await _run_writer(parent_ctx, spec, prompt, tool_call_id, label);
  if (result.error && !result.finalText) {
    throw new Error(`Notebook writer failed: ${result.error}`);
  }
  return result;
}

function _append_user_message(session: unknown, content: string): void {
  // TODO(verify): vtx.core.UserMessage is not ported; append a user-role
  // message through whichever session API the TS runtime exposes.
  const s = session as Record<string, any> | null | undefined;
  if (s == null) return;
  const message = { role: "user", content, type: "user" };
  if (typeof s.append_message === "function") {
    s.append_message(message);
  } else if (typeof s.appendMessage === "function") {
    s.appendMessage(message);
  } else if (Array.isArray(s.messages)) {
    s.messages.push(message);
  }
}

export async function launch_notebook_job(opts: {
  request: string;
  title?: string;
  parent_page_id?: string;
  background?: boolean;
  tool_call_id?: string | null;
}): Promise<string> {
  // Dispatch the notebook writer; returns the tool-result text.
  //
  // Raises an `Error` with a user-facing ``Notebook ...`` prefix on failure.
  const { request } = opts;
  const title = opts.title ?? "";
  const parent_page_id = opts.parent_page_id ?? "";
  const background = opts.background ?? true;

  register_writer_tools();
  const ctx = getDispatcherContext();
  if (ctx == null) {
    throw new Error("Notebook writer failed: dispatcher context not initialized.");
  }

  const spec: Record<string, unknown> = {
    name: "co-writer",
    description: "Co-writer — writes and manages the learner's notebook",
    instructions: load_co_writer_prompt(),
    instructions_mode: "replace",
    tools_allow: [...COWRITER_TOOL_NAMES],
    tools_deny: [],
    max_turns: MAX_TURNS,
  };

  const label = (title || request || "Notebook").trim().slice(0, 48);
  const prompt = _build_prompt(request, title, parent_page_id);
  const tool_call_id =
    opts.tool_call_id || `notebook_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  // Populated after register() returns so the factory can mark the record
  // notified (vtx's between-turn drain must not inject the same report twice).
  const record_holder: { record?: BackgroundTaskRecord } = {};

  const factory = async (): Promise<SubagentResult> => {
    let status = "completed";
    let report = "";
    try {
      const result = await _run_writer_only(ctx, spec, prompt, tool_call_id, label);
      report = result.finalText || "";
      return result;
    } catch (exc) {
      // still notify on failure
      status = "error";
      const msg = exc instanceof Error ? exc.message : String(exc);
      // _run_writer_only already prefixes its throws with "Notebook writer
      // failed:" — don't double it in the report/injected message.
      report = /^Notebook\b/.test(msg) ? msg : `Notebook writer failed: ${msg}`;
      throw exc;
    } finally {
      const record = record_holder.record;
      if (record != null) {
        record.notified = true;
      }

      const session_id = ctx.session_id || ctx.session?.id || "";
      const handle = notebook_events.current_turn(session_id);
      await notebook_events.notify_completion({
        session_id,
        turn_id: handle != null ? handle.turn_id : "",
        task_id: record ? record.task_id : tool_call_id,
        label,
        report,
        status,
        error: status === "error" ? report : "",
      });
      // Main agent: put the finished report in the session history now,
      // so it is part of context on the next turn even if the learner
      // never comes back to this notebook thread.
      const session = ctx.session;
      if (session != null) {
        try {
          _append_user_message(
            session,
            `<vtx:background-task-completion> Background task ` +
              `'${label}' (co-writer) finished with status ` +
              `${status}. Final answer:\n${report}` +
              `</vtx:background-task-completion>`,
          );
        } catch {
          // notification is best effort
        }
      }
    }
  };

  if (!background) {
    const result = await factory();
    return result.finalText || "Notebook writer finished without a report.";
  }

  const manager = ctx.background_manager ?? ctx.backgroundManager ?? getBackgroundTaskManager();
  if (manager == null) {
    throw new Error(
      "Notebook writer failed: no background task manager is installed.",
    );
  }

  // TODO(verify): BackgroundTaskManager.register kwargs -> options object.
  const record = await manager.register({
    description: label,
    prompt,
    subagent_type: spec["name"] as string,
    model: ctx.model ?? null,
    parent_session_id: ctx.session_id || ctx.session?.id || null,
    run_coro_factory: factory,
  });
  // register() starts the coroutine immediately; the writer awaits the LLM
  // for minutes before it needs the record, so this assignment lands first.
  record_holder.record = record;
  const marker = JSON.stringify({
    task_id: record.task_id,
    label,
    request,
    title,
    parent_page_id,
    tool_call_id,
  });
  return (
    "Notebook job launched in the background.\n" +
    `  task_id: ${record.task_id}\n` +
    `  label: ${label}\n` +
    "The Co-writer sub-agent is building the pages now (this can " +
    "take several minutes). Its report will be delivered automatically " +
    "when it finishes — tell the learner the notebook is being built and " +
    "they will see the result soon; do not claim the pages already exist.\n" +
    `NOTEBOOK_TASK:${marker}`
  );
}
