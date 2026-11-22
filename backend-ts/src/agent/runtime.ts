/**
 * Turn runtime: builds agents and maps the agent event stream onto the
 * Praxis web turn protocol.
 *
 *
 * Event mapping (agent SDK → wire):
 *
 * ==============================  ======================================
 * agent event                        wire StreamEvent
 * ==============================  ======================================
 * ``AgentStartEvent``                 ``stage_start`` (once per turn)
 * ``TextDeltaEvent``                  ``content``
 * ``ToolEndEvent`` (arguments known)  ``tool_call``
 * ``ToolResultEvent``                 ``tool_result``
 * run finished                        ``result`` then ``done``
 * exception / guardrail trip          ``error`` then ``done`` (failed)
 * cancellation set                    ``done`` (cancelled)
 * ==============================  ======================================
 *
 * TS port notes
 * ---------------
 * vtx is not available in TypeScript: there is no ``ConversationRuntime``, ``Session`` or
 * event bus to import. This module therefore implements a **minimal local
 * agent loop** (``LocalAgentRuntime`` / ``LocalAgent`` at the bottom) that
 * reproduces the observable contract: an async stream of ``VtxEvent`` objects,
 * tool dispatch through ``BaseTool``, ask_user futures, auto-approved tool
 * calls, and OpenAI-compatible chat-completions streaming via ``fetch``
 * against the resolved ``base_url``. Everything above the
 * ``// -- local agent loop`` marker is a faithful structural port of the
 *
 *  * ``thinking`` wire event is therefore unused until vtx exposes them.
 *  * Approvals pause a run via futures but cannot be resumed through the
 *    public API — Praxis auto-approves, same as before.
 */

import { randomUUID } from "node:crypto";

import type { Settings } from "../config.js";
import { get_settings } from "../config.js";
import * as providerConfig from "../provider-config.js";
// TODO(verify): sibling ports land concurrently — names assumed snake_case.
import { build_context_budget, tool_manifest_text } from "./context_budget.js";
import { classifyRenderer } from "./renderer.js";
import { InlineThinkingSplitter } from "../services/inline_thinking.js";
import { generate_title } from "../services/title_gen.js";
import * as usageStats from "../services/usage_stats.js";
import {
  SessionStore,
  AUTO_PARENT_MESSAGE,
  type SessionDict,
} from "../store/session_store.js";
import { set_note_context, set_turn_context } from "./turn_context.js";
import {
  prepare_turn_capabilities,
  type TurnCapabilityHooks,
} from "./capability_hooks.js";
import * as notebookEvents from "./notebook_agent/events.js";
import { NotebookAnalysisAgent } from "./notebook/analysis_agent.js";
import { get_notebook_manager } from "../services/notebook/service.js";
import { builtin_tools } from "./tools.js";
import { buildAskUserPayload } from "./ask_user.js";
import { build_praxis_prompt, PRAXIS_BASE } from "./prompt.js";
import {
  bind as bind_dt_session,
  unbind as unbind_dt_session,
  rebind as rebind_dt_session,
  PraxisSession,
} from "./dt_session.js";
import {
  AgentEndEvent,
  AgentStartEvent,
  ApprovalResponse,
  AskUserEvent,
  AskUserResponse,
  AskUserAnswer,
  BackgroundTaskCompletedEvent,
  BaseTool,
  ErrorEvent,
  HostNoticeEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolApprovalEvent,
  ToolEndEvent,
  ToolResult,
  ToolResultEvent,
  ToolStartEvent,
  deferred,
  type AskUserQuestion,
  type Ctx,
  type Deferred,
  type ToolResultLike,
  type UsageStats,
  type VtxEvent,
} from "../shared/vtx.js";

const log = {
  warning: (msg: string, err?: unknown) => console.warn(`[praxis.runtime] ${msg}`, err ?? ""),
};

const PROTOCOL_VERSION = "2.0";

type AnyDict = Record<string, any>;

function now(): number {
  return Date.now() / 1000;
}

// -- small concurrency primitives (asyncio.Event / Queue / Future equivalents) --

/** asyncio.Event equivalent: set once, waiters resolve. */
class Signal {
  private _set = false;
  private readonly _waiters: (() => void)[] = [];
  private readonly _listeners: (() => void)[] = [];

  set(): void {
    if (this._set) return;
    this._set = true;
    for (const w of this._waiters.splice(0)) w();
    for (const l of this._listeners) l();
  }

  is_set(): boolean {
    return this._set;
  }

  async wait(): Promise<void> {
    if (this._set) return;
    await new Promise<void>((resolve) => this._waiters.push(resolve));
  }

  /** Internal hook used by TurnHandle to abort the agent on cancel. */
  on_set(fn: () => void): void {
    this._listeners.push(fn);
  }
}

/**
 * Bounded asyncio.Queue equivalent for turn subscribers. ``put_nowait`` throws
 * when full (mirroring ``asyncio.QueueFull``) so ``_emit`` can drop dead
 * subscribers; ``get`` awaits the next event.
 */
export class TurnEventQueue {
  private buf: AnyDict[] = [];
  private waiters: ((e: AnyDict) => void)[] = [];

  constructor(public maxsize = 1000) {}

  put_nowait(event: AnyDict): void {
    if (this.buf.length >= this.maxsize) {
      const err = new Error("queue full");
      err.name = "QueueFull";
      throw err;
    }
    const w = this.waiters.shift();
    if (w) w(event);
    else this.buf.push(event);
  }

  get(): Promise<AnyDict> {
    const buffered = this.buf.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise<AnyDict>((resolve) => this.waiters.push(resolve));
  }

  get size(): number {
    return this.buf.length;
  }

  get empty(): boolean {
    return this.buf.length === 0;
  }
}

// -- wire helpers -------------------------------------------------------------

export function _tool_result_text(out: any): string {
  /** Readable text from a vtx ``ToolResultMessage``-like object. */
  let value = out?.output;
  if (value === undefined || value === null) {
    const content = out?.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const part of content) {
        if (typeof part === "string") parts.push(part);
        else if (part && typeof part === "object" && !Array.isArray(part)) {
          parts.push(String((part as AnyDict).text ?? (part as AnyDict).content ?? ""));
        } else {
          const txt = (part as AnyDict)?.text;
          if (txt !== undefined && txt !== null) parts.push(String(txt));
        }
      }
      value = parts.filter((p) => p.trim()).join("\n");
    } else if (content !== undefined && content !== null) {
      value = content;
    }
  }
  if (value === undefined || value === null) {
    value = typeof out === "string" ? out : safeJson(out);
  }
  return String(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const ERROR_PREFIXES = [
  "render failed",
  "video sub-agent failed",
  "error:",
  "failed:",
  "traceback",
  "unavailable:",
];

function _tool_result_is_error(out: any, text: string): boolean {
  /** Tools return plain strings, so failure text must be detected too. */
  if (out?.is_error) return true;
  if (out?.success === false) return true;
  const head = text.trim().toLowerCase();
  return ERROR_PREFIXES.some((p) => head.startsWith(p));
}

/**
 * vtx's initialize() persists last_selected/recent_models into its own config
 * There is no vtx module to patch in TS — kept as a documented no-op for
 * structural parity (the local agent loop never performs selection writes).
 */
function _suppress_vtx_selection_writes(): () => void {
  return () => {};
}

// -- turn handle ---------------------------------------------------------------

export class TurnHandle {
  turn_id: string;
  session_id: string;
  status = "running";
  /** asyncio.Event equivalent — set by the cancel command. */
  cancel = new Signal();
  /** AbortSignal view of ``cancel`` for the local agent loop. */
  readonly abort = new AbortController();
  /**
   * Subscriber queues. Typed minimally so both this module's ``TurnEventQueue``
   * and the realtime transport's ``AsyncQueue`` (which also exposes
   * ``put_nowait`` throwing on full) can be added interchangeably.
   */
  subscribers = new Set<{ put_nowait(event: AnyDict): void }>();
  events: AnyDict[] = [];
  seq = 0;
  // Stable id used by the frontend to group one model call's trace rows.
  call_id = "";
  // Set once post-``done`` work (title generation) has finished or was never
  // needed. Event pumps wait on this before closing so frames the runtime
  // settles after the turn can still reach the open client.
  settled = new Signal();
  // Live session dict the turn is writing to. Events are recorded into it
  // as they are emitted so a client that misses live frames can replay them.
  session_ref: SessionDict | null = null;
  // Title request fired at turn start, in parallel with the reply.
  title_task: Promise<string | null> | null = null;

  constructor(turn_id: string, session_id: string, session_ref: SessionDict | null, call_id: string) {
    this.turn_id = turn_id;
    this.session_id = session_id;
    this.session_ref = session_ref;
    this.call_id = call_id;
    this.cancel.on_set(() => this.abort.abort());
  }

  next_seq(): number {
    this.seq += 1;
    return this.seq;
  }
}

// -- SDK tool adapter ------------------------------------------------------------

/**
 * Adapt a vtx SDK ``@tool`` FunctionTool-like object to the ``BaseTool``
 * interface the runtime expects. In the TS port, ``builtin_tools`` already
 * returns ``BaseTool`` instances, so this adapter mostly passes through — it
 * remains for parity with function-tool objects that only expose
 * ``{name, description, execute}``.
 */
class SdkToolAdapter extends BaseTool {
  declare name: string;
  declare description: string;
  toolIcon?: string;
  mutating: boolean;
  params?: unknown;
  private readonly _fn: any;

  constructor(fn: any) {
    super();
    this._fn = fn;
    this.name = fn?.name ?? "tool";
    this.description = fn?.description ?? "";
    this.toolIcon = fn?.tool_icon ?? fn?.toolIcon ?? "🛠️";
    const params = fn?.params;
    this.params = typeof params === "function" ? params : params ?? Object;
    this.mutating = Boolean(fn?.mutating ?? true);
  }

  formatCall(_params: unknown): string {
    return this.name;
  }

  formatPreview(_params: unknown): string | null {
    return null;
  }

  async execute(params: unknown, _cancelEvent?: unknown): Promise<ToolResultLike> {
    try {
      const res = await this._fn.execute(params);
      // Class-based tools already return a ToolResult — pass it through
      // so success=False and ui fields survive instead of being wrapped
      // into a successful string result.
      if (res instanceof ToolResult) return res;
      const text = res?.result ?? String(res);
      return new ToolResult(true, String(text));
    } catch (exc) {
      return new ToolResult(false, `${this.name} error: ${String(exc)}`);
    }
  }
}

// -- agent runtime ----------------------------------------------------------------

export class AgentRuntime {
  private readonly _settings: Settings;
  private readonly _store: SessionStore;
  private readonly _turns = new Map<string, TurnHandle>();
  private readonly _vtx_runtimes = new Map<string, { runtime: LocalAgentRuntime; agent: LocalAgent }>();
  // turn_id -> (deferred to resolve, tool_call_id, question prompts by id)
  private readonly _ask_user_waiters = new Map<
    string,
    { future: Deferred<AskUserResponse>; tool_call_id: string; prompts: Map<string, string> }
  >();
  // Keeps post-turn work (title generation) from being garbage collected
  // before it runs. Failures are logged in the task itself.
  private readonly _background_tasks = new Set<Promise<unknown>>();

  constructor(settings: Settings, store: SessionStore) {
    this._settings = settings;
    this._store = store;
    // The notebook writer reports progress through this runtime; mirror the
    try {
      notebookEvents.set_runtime(this);
    } catch {
      /* events module may not be wired yet */
    }
  }

  // -- turn registry ----------------------------------------------------

  active_turn_for_session(session_id: string): TurnHandle | null {
    for (const turn of this._turns.values()) {
      if (turn.session_id === session_id && turn.status === "running") return turn;
    }
    return null;
  }

  get_turn(turn_id: string): TurnHandle | null {
    return this._turns.get(turn_id) ?? null;
  }

  /**
   * Push a user-role message into the session's cached agent history.
   *
   * Background completions (notebook co-writer etc.) arrive after the parent
   * turn ended; without this they would only reach the session row and never
   * the ``LocalAgent._messages`` array that ``_stream_chat`` sends to the
   * model. No-op when no runtime is cached for the session (e.g. after a
   * restart — the agent rebuilds its history from scratch either way).
   */
  inject_user_message(session_id: string, content: string): void {
    const cached = this._vtx_runtimes.get(session_id);
    cached?.agent.inject_user_message(content);
  }

  async resolve_ask_user(
    turn_id: string,
    text: string,
    answers: AnyDict[],
  ): Promise<boolean> {
    /**
     * Feed a learner's answer into a paused ask_user tool call.
     *
     * Resolves the deferred so the same turn resumes with the answer
     * substituted into the tool result. Emits the resolution event the UI
     * uses to seal the question card. Returns false when no question is
     * currently waiting on this turn (e.g. after a backend restart).
     */
    const waiter = this._ask_user_waiters.get(turn_id);
    if (waiter === undefined) return false;
    this._ask_user_waiters.delete(turn_id);
    const { future, tool_call_id, prompts } = waiter;
    const resolved: AnyDict[] = [];
    const sdk_answers: AskUserAnswer[] = [];
    for (const a of answers) {
      if (typeof a !== "object" || a === null) continue;
      const qid = String(a.questionId ?? a.id ?? "").trim();
      const value = String(a.text ?? "").trim();
      const question = prompts.get(qid) ?? qid;
      resolved.push({ questionId: qid, text: value });
      if (value) {
        sdk_answers.push({ question, kind: "custom", answer: value });
      }
    }
    if (text.trim() && sdk_answers.length === 0) {
      // Legacy flat reply: attribute it to the first pending question.
      const first = prompts.values().next().value ?? "";
      sdk_answers.push({ question: first, kind: "custom", answer: text.trim() });
    }
    const response: AskUserResponse = {
      custom_text: text.trim() || null,
      answers: sdk_answers,
    };
    if (future && !future.done()) future.resolve(response);
    const handle = this._turns.get(turn_id);
    if (handle !== undefined) {
      await this._emit(
        handle,
        AgentRuntime._stream_event(handle, "progress", {
          source: "ask_user",
          stage: "responding",
          metadata: {
            ask_user_resolved: true,
            ask_user_tool_call_id: tool_call_id,
            answers: resolved,
            reply_preview: text.trim(),
          },
        }),
      );
    }
    return true;
  }

  // -- agent construction -------------------------------------------------

  static _stream_event(
    turn: TurnHandle,
    etype: string,
    opts: {
      content?: string;
      source?: string;
      stage?: string;
      metadata?: AnyDict | null;
    } = {},
  ): AnyDict {
    return {
      type: etype,
      protocol_version: PROTOCOL_VERSION,
      seq: turn.next_seq(),
      session_id: turn.session_id,
      turn_id: turn.turn_id,
      timestamp: now(),
      source: opts.source ?? "",
      stage: opts.stage ?? "",
      content: opts.content ?? "",
      metadata: opts.metadata ?? {},
    };
  }

  /** Provider usage in the shape the chat footer's `combineUsage` expects. */
  static _usage_summary(
    usage: UsageStats | null | undefined,
    timing?: { started_at?: number; first_token_at?: number | null; ended_at?: number } | null,
  ): AnyDict {
    if (!usage) return {};
    const u = usage as AnyDict;
    const input = Number(u.input_tokens ?? 0) || 0;
    const output = Number(u.output_tokens ?? 0) || 0;
    const cacheRead = Number(u.cache_read_tokens ?? 0) || 0;
    const cacheWrite = Number(u.cache_write_tokens ?? 0) || 0;
    const calls = Math.max(1, Number(u.calls ?? 1) || 1);
    const reported = Boolean(u.cache_reported);

    // Stream timings are gathered in _run but were never put on the wire, so
    // the footer's Model time / TTFT / TPS rows only ever showed dashes.
    const started = Number(timing?.started_at ?? 0) || 0;
    const first = Number(timing?.first_token_at ?? 0) || 0;
    const ended = Number(timing?.ended_at ?? 0) || 0;
    const ttft = first && started ? Math.max(0, first - started) : 0;
    const generation = ended && first ? Math.max(0, ended - first) : 0;

    return {
      total_tokens: Number(u.total_tokens ?? 0) || input + output,
      prompt_tokens: input,
      completion_tokens: output,
      total_calls: calls,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
      cache_input_tokens: reported ? input : 0,
      cache_reported_calls: reported ? calls : 0,
      cache_write_reported_calls: reported ? calls : 0,
      cache_hit_rate: reported && input > 0 ? cacheRead / input : null,
      reasoning_tokens: Number(u.reasoning_tokens ?? 0) || 0,
      // "Model time" in the footer matches the usage page: time from the
      // first token to the end of generation, not the whole turn incl. tools.
      duration_seconds: generation ? Math.round(generation * 1000) / 1000 : 0,
      ttft_seconds: ttft ? Math.round(ttft * 1000) / 1000 : null,
      ttft_calls: ttft ? calls : 0,
      generation_seconds: generation ? Math.round(generation * 1000) / 1000 : 0,
      timed_completion_tokens: generation ? output : 0,
      tokens_per_second:
        generation > 0 && output > 0
          ? Math.round((output / generation) * 10) / 10
          : null,
    };
  }

  static _context_budget(runtime: any, session: SessionDict, usage: UsageStats | null | undefined): AnyDict {
    /** Build the context-budget payload for the composer's context bar. */
    let profile_id = "";
    let model_id = "";
    let reasoning_effort = "";
    try {
      const selection = providerConfig.get_selection(get_settings()) as AnyDict | null;
      profile_id = String(selection?.profile_id ?? "") || "";
      model_id = String(selection?.model_id ?? "") || "";
      reasoning_effort = String(selection?.reasoning_effort ?? "") || "";
    } catch {
      /* best effort */
    }
    return build_context_budget({
      settings: get_settings(),
      // The wire model actually used for this turn — never the catalog UUID.
      wire_model: String(runtime?.model ?? model_id ?? ""),
      model_provider: String(runtime?.model_provider ?? ""),
      reasoning_effort,
      profile_id,
      model_id,
      messages: (session.messages as AnyDict[]) ?? [],
      system_prompt: String(runtime?.agent?._system_prompt ?? ""),
      tool_manifest: tool_manifest_text((runtime?.tools as unknown[]) ?? []),
      usage,
    });
  }

  async _emit(turn: TurnHandle, event: AnyDict): Promise<void> {
    turn.events.push(event);
    // Mirror into the session record so turn_events_after() can replay the
    // suffix once the in-memory handle is dropped on completion.
    if (turn.session_ref !== null) {
      this._store.record_turn_event(turn.session_ref, turn.turn_id, event);
    }
    const dead: { put_nowait(event: AnyDict): void }[] = [];
    for (const queue of turn.subscribers) {
      try {
        queue.put_nowait(event);
      } catch {
        dead.push(queue);
      }
    }
    for (const queue of dead) turn.subscribers.delete(queue);
  }

  // -- turn execution ------------------------------------------------------

  async start_turn(
    command: AnyDict,
  ): Promise<{ handle: TurnHandle | null; session_event: AnyDict | null; error: string | null }> {
    /**
     * Validate and launch a turn. Returns (handle, session_event, error).
     *
     * The returned ``session_event`` must be emitted first so the client
     * learns the (possibly new) session_id before stream events arrive.
     */
    const content = String(command.content ?? "");
    const attachments = (command.attachments as AnyDict[] | undefined) ?? [];
    if (!content.trim() && attachments.length === 0) {
      return { handle: null, session_event: null, error: "Turn content must not be empty" };
    }

    const session_id = String(command.session_id ?? "").trim() || null;
    let session = session_id ? this._store.get(session_id) : null;
    if (session === null) {
      session = this._store.create({
        preferences: { workspace_id: command.workspace_id },
      });
    }

    const capability = String(command.capability ?? "chat").trim() || "chat";
    const turn_id = _new_id("turn");
    const handle = new TurnHandle(
      turn_id,
      session.id as string,
      session,
      `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    );
    this._turns.set(turn_id, handle);

    // Persist the user row up front so a crash never loses the prompt.
    const user_message = this._store.append_user_message(session, content, {
      attachments,
      metadata: { capability, turn_id },
      // dict.get(key, sentinel): an explicit null stays null, only an absent
      // key falls back to AUTO_PARENT_MESSAGE.
      parent_message_id:
        "parent_message_id" in command ? command.parent_message_id : AUTO_PARENT_MESSAGE,
    });
    session.status = "running";
    session.last_input = content;
    this._store.save(session);

    const session_event = AgentRuntime._stream_event(handle, "session", {
      metadata: { session_id: session.id, turn_id },
    });

    // Fire the title request now in the background: it generates the title
    // asynchronously from the user's first message and emits `session_meta`
    // as soon as it resolves, without blocking the reply.
    if (session.title_auto) {
      handle.title_task = this._start_title_request(handle, session, content);
    }

    // Tools that need to know who is asking (cron) read these; the turn
    // task copies this context, so each turn sees only its own values.
    set_turn_context(
      session.id as string,
      String(command.workspace_id ?? (session.preferences as AnyDict | undefined)?.workspace_id ?? ""),
    );
    // A notebook thread is an ordinary chat session bound to a Co-Writer
    // page. Keep the binding on the session so later turns inherit it even
    // when the client does not resend it.
    const note_doc = String(
      command.note_document_id ??
        (session.preferences as AnyDict | undefined)?.note_document_id ??
        "",
    ).trim();
    const note_generation = (command.note_generation ?? {}) as AnyDict;
    if (note_doc) {
      ((session.preferences ??= {}) as AnyDict).note_document_id = note_doc;
      this._store.save(session);
    }
    set_note_context(
      note_doc,
      String(note_generation.block_id ?? ""),
      String(note_generation.kind ?? ""),
    );
    // asyncio.create_task equivalent: the promise body runs with the context
    // vars set above (AsyncLocalStorage propagates into the async call).
    const task = this._run(handle, session, command, user_message);
    task
      .finally(() => {
        // Mirrors task.add_done_callback(lambda _t: self._turns.pop(turn_id))
        this._turns.delete(turn_id);
      })
      .catch((err) => log.warning("turn task failed", err));
    return { handle, session_event, error: null };
  }

  /**
   * TS equivalent of ``_run_vtx``: drive a turn through the local agent loop
   * (the stand-in for vtx's ConversationRuntime — see the file header).
   *
   * Streams ThinkingDeltaEvent live. Returns true if the turn completed
   * through this path (always, in the local implementation).
   */
  private async _run_local_agent(
    handle: TurnHandle,
    session: SessionDict,
    command: AnyDict,
    user_message: SessionDict,
  ): Promise<boolean> {
    const capability = String(command.capability ?? "chat").trim() || "chat";
    const content = String(command.content ?? "");
    const attachments = (command.attachments as AnyDict[] | undefined) ?? [];
    let prompt = content;
    if (attachments.length > 0) {
      const notes = attachments.map(
        (a) =>
          `[Attachment: ${a.filename ?? a.id ?? "attachment"}]` +
          (a.extracted_text ? `\n${a.extracted_text}` : ""),
      );
      prompt = [content, ...notes].filter(Boolean).join("\n\n");
    }

    // Ground the turn in any notebook favorites the learner attached.
    // Mirrors deeptutor/services/session/turns/executor.py: the analysis
    // agent picks up to five records and appends a compact context note.
    const notebookRefs = (command.notebook_references as AnyDict[] | undefined) ?? [];
    if (notebookRefs.length) {
      try {
        const records = get_notebook_manager().get_records_by_references(notebookRefs);
        if (records.length) {
          const language = String(command.language ?? "en");
          const analysis = new NotebookAnalysisAgent(language, this._settings);
          const note = await analysis.analyze(content, records, (event) => {
            void this._emit(
              handle,
              AgentRuntime._stream_event(handle, String(event.type), {
                content: event.content ?? "",
                source: "notebook_analysis",
                stage: event.stage,
                metadata: event.metadata ?? null,
              }),
            );
          });
          if (note) prompt = [prompt, note].filter(Boolean).join("\n\n");
        }
      } catch (exc) {
        // Context enrichment must never block a turn.
        console.warn("notebook analysis failed:", exc);
      }
    }

    // Per-session runtime cache — the runtime owns the agent session history.
    const cache_key = session.id as string;
    let cached = this._vtx_runtimes.get(cache_key);
    if (cached === undefined) {
      try {
        // Mirror the vtx coding agent's _ensure_agent: resolve model/provider
        // from Praxis's own catalog (nothing is read from ~/.vtx), build
        // the tool list, then construct the runtime + agent.
        const cwd = String((this._settings as AnyDict).workspace_dir ?? "");
        const resolved = providerConfig.resolve_runtime_model(this._settings, command) as AnyDict;
        const provider = String(resolved.provider ?? "");
        let model = String(resolved.model ?? "") || String(session.model ?? "");
        if (!model) {
          throw new Error("no model configured — pick one in Settings → LLM");
        }
        const base_url = String(resolved.base_url ?? "");
        const api_key = String(resolved.api_key ?? "");
        const thinking_level =
          command.thinking_level ?? resolved.thinking_level ?? null;

        const fns = builtin_tools(this._settings, command.tools as string[] | undefined);
        const tools = fns.map((t) => new SdkToolAdapter(t));

        // Bind this Praxis record while the agent builds its session, so
        // entries are loaded from / saved to our JSON document instead of
        // ~/.vtx/sessions/*.jsonl. (Local loop keeps history in memory; the
        // PraxisSession still persists vtx_header/vtx_entries on the row.)
        const dt_token = bind_dt_session(this._store as never, session as never);
        let vtx_session: PraxisSession;
        try {
          // _suppress_vtx_selection_writes() equivalent: no-op in TS.
          const restore = _suppress_vtx_selection_writes();
          try {
            vtx_session = new PraxisSession();
          } finally {
            restore();
          }
        } finally {
          unbind_dt_session(dt_token);
        }

        const runtime = new LocalAgentRuntime({
          cwd,
          model,
          model_provider: provider,
          api_key,
          base_url,
          thinking_level,
          tools,
          vtx_session,
          settings: this._settings,
        });
        runtime.set_progress_callback(notebookEvents.progress_callback);
        const agent = runtime.prepare_agent();
        if (agent === null) {
          throw new Error("agent initialization failed");
        }

        // MCP + hooks, mirroring coding_agent: failures warn, never fail the
        // run. No vtx MCP/hook bridge exists in TS — skipped by design.
        this._vtx_runtimes.set(cache_key, { runtime, agent });
        cached = { runtime, agent };
      } catch (exc) {
        await this._emit(handle, AgentRuntime._stream_event(handle, "error", {
          content: `agent init failed: ${String(exc)}`,
          source: capability,
          stage: "responding",
        }));
        await this._emit(handle, AgentRuntime._stream_event(handle, "done", {
          source: capability,
          stage: "responding",
          metadata: {
            status: "error",
            user_message_id: user_message.id ?? null,
            assistant_message_id: null,
          },
        }));
        this._finalize_turn(handle, session, "error");
        return true;
      }
    } else {
      // The cached runtime still points at the dict from the turn that created
      // it. Re-point persistence at this turn's record so new history is not
      // written into the stale object.
      const vtx_session = cached.runtime.vtx_session ?? cached.agent.vtx_session;
      if (vtx_session) {
        rebind_dt_session(vtx_session, this._store as never, session as never);
      }
    }
    const { runtime, agent } = cached;
    await this._emit(handle, AgentRuntime._stream_event(handle, "stage_start", {
      source: capability,
      stage: "responding",
    }));

    let status = "completed";
    const assistant_parts: string[] = [];
    let usage: UsageStats | null = null;
    const turn_started_at = now();
    let first_token_at: number | null = null;
    // Some OpenAI-compatible gateways forget to move a model's scratchpad
    // into `reasoning`/`reasoning_content` and leave it inline in the text
    // stream. Split the other common tag families here before they are
    // published as the answer.
    const inline_thinking = new InlineThinkingSplitter();

    const publish_text_piece = async (kind: string, piece: string): Promise<void> => {
      if (!piece) return;
      if (kind === "think") {
        await this._emit(handle, AgentRuntime._stream_event(handle, "thinking", {
          content: piece,
          source: capability,
          stage: "responding",
          metadata: {
            call_id: handle.call_id,
            call_kind: "llm_reasoning",
            trace_kind: "llm_reasoning",
            call_role: "assistant",
          },
        }));
        return;
      }
      assistant_parts.push(piece);
      await this._emit(handle, AgentRuntime._stream_event(handle, "content", {
        content: piece,
        source: capability,
        stage: "responding",
      }));
    };

    // The sync progress callback the notebook writer needs to know which turn
    // to write progress events into.
    const turn_token = notebookEvents.set_current_turn(handle);
    // Upstream LoopExtension hooks (capabilities/*/capability.py): resolve
    // turn metadata, collect system blocks + user-message seeds, and build
    // the per-tool kwargs augmenter. Best-effort — never fails the turn.
    let turn_caps: TurnCapabilityHooks | null = null;
    try {
      turn_caps = await prepare_turn_capabilities({
        command,
        session,
        turn_id: handle.turn_id,
        prompt,
        progress: async (text) => {
          await this._emit(handle, AgentRuntime._stream_event(handle, "progress", {
            content: text,
            source: capability,
            stage: "responding",
          }));
        },
      });
    } catch (exc) {
      log.warning("capability turn hooks failed", exc);
    }
    try {
      for await (const event of agent.run(prompt, handle.abort.signal, turn_caps)) {
        if (event instanceof AskUserEvent) {
          // The agent intercepts ask_user and hands us the questionnaire
          // plus a deferred for the learner's answer. Publish a card to the
          // client now and let submit_user_reply resolve it.
          const prompts = new Map<string, string>();
          const questions: AnyDict[] = [];
          (event.questions ?? []).forEach((q: AskUserQuestion, i: number) => {
            const qid = q.id || `q${i + 1}`;
            const prompt = q.prompt || q.question;
            prompts.set(qid, prompt);
            questions.push({
              id: qid,
              prompt,
              header: q.header ?? null,
              multi_select: Boolean(q.multi_select),
              options: (q.options ?? []).map((o) => ({
                label: o.label,
                description: o.description ?? null,
              })),
              allow_free_text: q.allow_free_text !== false,
              placeholder: q.placeholder ?? null,
            });
          });
          await this._emit(handle, AgentRuntime._stream_event(handle, "tool_result", {
            source: capability,
            stage: "responding",
            metadata: {
              tool_call_id: event.tool_call_id,
              tool_name: "ask_user",
              tool_metadata: {
                ask_user: { intro: event.intro ?? null, questions },
              },
            },
          }));
          this._ask_user_waiters.set(handle.turn_id, {
            future: event.future,
            tool_call_id: event.tool_call_id,
            prompts,
          });
          continue;
        }
        if (event instanceof ThinkingDeltaEvent) {
          if (event.delta && first_token_at === null) first_token_at = now();
          if (event.delta) {
            // The frontend groups trace rows by metadata.call_id; a single id
            // per turn groups one model call's reasoning into one row.
            await this._emit(handle, AgentRuntime._stream_event(handle, "thinking", {
              content: event.delta,
              source: capability,
              stage: "responding",
              metadata: {
                call_id: handle.call_id,
                call_kind: "llm_reasoning",
                trace_kind: "llm_reasoning",
                call_role: "assistant",
              },
            }));
          }
        } else if (event instanceof TextDeltaEvent) {
          if (event.delta && first_token_at === null) first_token_at = now();
          if (event.delta) {
            for (const [kind, piece] of inline_thinking.feed(event.delta)) {
              await publish_text_piece(kind, piece);
            }
          }
        } else if (event instanceof ToolStartEvent) {
          await this._emit(handle, AgentRuntime._stream_event(handle, "progress", {
            content: `Calling ${event.tool_name}`,
            source: capability,
            stage: "responding",
            metadata: {
              tool_name: event.tool_name,
              tool_call_id: event.tool_call_id,
            },
          }));
        } else if (event instanceof ToolEndEvent) {
          await this._emit(handle, AgentRuntime._stream_event(handle, "tool_call", {
            content: event.tool_name,
            source: capability,
            stage: "responding",
            metadata: {
              tool: event.tool_name,
              tool_name: event.tool_name,
              tool_call_id: event.tool_call_id,
              args: event.arguments ?? null,
            },
          }));
        } else if (event instanceof ToolApprovalEvent) {
          // Praxis has no permission UI — auto-approve tool calls.
          if (event.future && !event.future.done()) {
            event.future.resolve(ApprovalResponse.APPROVE);
          }
        } else if (event instanceof ToolResultEvent) {
          const out = event.result;
          let text = _tool_result_text(out);
          const tool_meta: AnyDict = {};
          // The video tool publishes a self-contained Remotion player
          // page into the /files tree and marks its result with a
          // machine-readable prefix. Marker format: VIDEO_LESSON_RESULT:<json>
          if (
            text.startsWith("VIDEO_LESSON_RESULT:") &&
            !(out as AnyDict)?.is_error
          ) {
            let lesson: AnyDict = {};
            try {
              lesson = JSON.parse(text.split(":", 2)[1]) as AnyDict;
            } catch {
              lesson = {};
            }
            const rel = String(lesson.rel ?? "").trim();
            if (rel && !rel.includes("..") && !rel.startsWith("/")) {
              const title = String(lesson.title ?? "").trim();
              const summary = String(lesson.summary ?? "").trim();
              await this._emit(handle, AgentRuntime._stream_event(handle, "result", {
                source: "video_lesson",
                stage: "responding",
                metadata: {
                  response: summary,
                  title,
                  artifacts: [{
                    type: "html",
                    url: `/files/${rel}`,
                    filename: rel.split("/").pop(),
                    content_type: "text/html",
                    label: title || null,
                  }],
                  code: {
                    language: "tsx",
                    content: String(lesson.code ?? ""),
                  },
                  render: {
                    duration_seconds: lesson.duration_seconds ?? null,
                    attempts: Array.from(
                      { length: Math.max(1, Number(lesson.attempts ?? 1) || 1) },
                      (_, i) => i,
                    ),
                  },
                },
              }));
              text = summary || "Video lesson ready.";
            }
          }

          // Legacy marker for pre-Remotion MP4/HyperFrames lessons.
          // Marker format: VIDEO_ARTIFACT:<rel>|<title>|<readable>
          if (
            text.startsWith("VIDEO_ARTIFACT:") &&
            !(out as AnyDict)?.is_error
          ) {
            const markerEnd = text.indexOf("|");
            const marker = markerEnd === -1 ? text : text.slice(0, markerEnd);
            const rest = markerEnd === -1 ? "" : text.slice(markerEnd + 1);
            const rel = marker.split(":", 2)[1]?.trim() ?? "";
            const secondPipe = rest.indexOf("|");
            let title = "";
            let readable = rest;
            if (secondPipe !== -1) {
              title = rest.slice(0, secondPipe);
              readable = rest.slice(secondPipe + 1);
            }
            if (rel && !rel.includes("..") && !rel.startsWith("/")) {
              tool_meta.artifacts = [{
                filename: rel.split("/").pop(),
                url: `/files/${rel}`,
                mime_type: rel.endsWith(".mp4") ? "video/mp4" : "application/x-hyperframes",
                title: title.trim() || null,
                generated: true,
              }];
              text = readable.trim() || "Video ready.";
            }
          }

          // Notebook: open a live writer panel in the chat. The tool result
          // carries a JSON marker with the background task id; mirroring
          // video's `result` event is what makes the frontend mount a custom
          // viewer for this turn.
          if (
            text.includes("NOTEBOOK_TASK:") &&
            !(out as AnyDict)?.is_error
          ) {
            let task_info: AnyDict = {};
            try {
              const marker = text.split("NOTEBOOK_TASK:", 2)[1].trim().split(/\r?\n/)[0];
              task_info = JSON.parse(marker) as AnyDict;
            } catch {
              task_info = {};
            }
            if (task_info.task_id) {
              tool_meta.notebook_task = task_info;
              await this._emit(handle, AgentRuntime._stream_event(handle, "result", {
                source: "notebook",
                stage: "responding",
                metadata: {
                  response:
                    "Co-writer is building the pages. You will see the result here when it finishes.",
                  notebook_task: task_info,
                },
              }));
              text = text.split("NOTEBOOK_TASK:", 2)[0].trim();
            }
          }
          await this._emit(handle, AgentRuntime._stream_event(handle, "tool_result", {
            content: text,
            source: capability,
            stage: "responding",
            metadata: {
              tool_call_id: event.tool_call_id,
              tool_name: event.tool_name,
              is_error: _tool_result_is_error(out, text),
              tool_metadata: tool_meta,
            },
          }));
        } else if (event instanceof BackgroundTaskCompletedEvent) {
          // A background sub-agent (e.g. the notebook writer) finished. The
          // result was already injected into the session as a synthetic
          // message; surface a progress row so the learner sees it settle.
          await this._emit(handle, AgentRuntime._stream_event(handle, "progress", {
            content:
              `Background task finished: ${event.description ?? event.task_id} (${event.status})`,
            source: capability,
            stage: "responding",
            metadata: {
              tool_name: "background_task",
              background_task: {
                task_id: event.task_id,
                description: event.description ?? null,
                subagent_type: event.subagent_type ?? null,
                status: event.status,
                summary: event.summary ?? null,
                turns: event.turns ?? null,
                total_tokens: event.total_tokens ?? null,
              },
            },
          }));
        } else if (event instanceof HostNoticeEvent) {
          await this._emit(handle, AgentRuntime._stream_event(handle, "progress", {
            content: event.text.slice(0, 300),
            source: capability,
            stage: "responding",
            metadata: { tool_name: "host_notice" },
          }));
        } else if (event instanceof ErrorEvent) {
          status = "error";
          // Surface the provider/agent failure to the UI. Without an explicit
          // frame the turn just ends with status=error and the user sees an
          // empty reply with no explanation.
          await this._emit(handle, AgentRuntime._stream_event(handle, "error", {
            content: String(event.error ?? "") || "Agent failed.",
            source: capability,
            stage: "responding",
            metadata: { turn_terminal: true },
          }));
        } else if (event instanceof AgentEndEvent) {
          usage = event.total_usage ?? null;
        } else if (event instanceof AgentStartEvent) {
          // stage_start is emitted once per turn before the loop; the SDK's
          // _AgentStartEvent for the same single frame — see header table).
        }
      }
      for (const [kind, piece] of inline_thinking.flush()) {
        await publish_text_piece(kind, piece);
      }
    } catch (exc) {
      if (exc instanceof DOMException && exc.name === "AbortError") {
        status = "cancelled";
      } else if (handle.cancel.is_set()) {
        status = "cancelled";
      } else {
        status = "error";
        await this._emit(handle, AgentRuntime._stream_event(handle, "error", {
          content: String(exc),
          source: capability,
          stage: "responding",
        }));
      }
    } finally {
      notebookEvents.reset_current_turn(turn_token);
      // A turn that ends with a question still pending (cancelled, errored)
      // must not leave a resolvable waiter behind — resolve_ask_user would
      // otherwise accept an answer for a dead turn.
      this._ask_user_waiters.delete(handle.turn_id);
    }
    // Emit the context-window readout the composer's context bar consumes.
    await this._emit(handle, AgentRuntime._stream_event(handle, "result", {
      source: capability,
      stage: "responding",
      metadata: {
        metadata: {
          context_budget: AgentRuntime._context_budget(runtime, session, usage),
          renderer: classifyRenderer(assistant_parts.join("")),
          usage_summary: AgentRuntime._usage_summary(usage, {
            started_at: turn_started_at,
            first_token_at,
            ended_at: now(),
          }),
        },
      },
    }));
    try {
      const s = get_settings();
      usageStats.record_call_usage(s, {
        session_id: handle.session_id,
        turn_id: handle.turn_id,
        model: String(runtime.model ?? ""),
        provider: String(runtime.model_provider ?? ""),
        usage,
        duration_s: first_token_at !== null ? now() - first_token_at : 0,
        ttft_s: first_token_at !== null ? first_token_at - turn_started_at : 0,
      });
      if (first_token_at !== null) {
        usageStats.record_turn_timing(s, {
          turn_id: handle.turn_id,
          session_id: handle.session_id,
          model: String(runtime.model ?? ""),
          provider: String(runtime.model_provider ?? ""),
          ttft_s: first_token_at - turn_started_at,
          gen_s: now() - first_token_at,
        });
      }
    } catch {
      /* accounting must never break a turn */
    }
    const assistant_text = assistant_parts.join("").trim();
    let assistant_message: SessionDict | null = null;
    if (assistant_text) {
      try {
        assistant_message = this._store.append_assistant_message(session, assistant_text, {
          events: [], // events live on the turn log, not the message row
          turn_id: handle.turn_id,
          capability,
          metadata: { status },
          parent_message_id: user_message.id,
        });
      } catch {
        /* best effort */
      }
    }
    session.status = status === "completed" ? "completed" : status;
    session.last_output = assistant_text.slice(0, 500);
    try {
      this._store.save(session);
    } catch {
      /* best effort */
    }
    handle.status = status;

    await this._emit(handle, AgentRuntime._stream_event(handle, "stage_end", {
      source: capability,
      stage: "responding",
      metadata: { status },
    }));
    // The client reconciles its optimistic rows and clears failed-
    // submission records from these ids.
    const done_meta: AnyDict = {
      status,
      user_message_id: user_message.id ?? null,
      assistant_message_id: assistant_message ? assistant_message.id : null,
      usage_summary: AgentRuntime._usage_summary(usage, {
        started_at: turn_started_at,
        first_token_at,
        ended_at: now(),
      }),
    };
    await this._emit(handle, AgentRuntime._stream_event(handle, "done", {
      source: capability,
      stage: "responding",
      metadata: done_meta,
    }));
    // Persist the recorded turn (incl. done) before the done callback drops
    // the in-memory handle — replay must find these frames in the store.
    this._finalize_turn(handle, session, status);
    handle.settled.set();
    return true;
  }

  private async _run_vtx(
    handle: TurnHandle,
    session: SessionDict,
    command: AnyDict,
    user_message: SessionDict,
  ): Promise<boolean> {
    return this._run_local_agent(handle, session, command, user_message);
  }

  private _start_title_request(
    handle: TurnHandle,
    session: SessionDict,
    user_text: string,
  ): Promise<string | null> {
    /** Kick off title generation asynchronously without blocking the turn. */
    session.title_auto = false;
    const task = this._generate_and_emit_title(handle, session, user_text);
    this._background_tasks.add(task);
    task.finally(() => this._background_tasks.delete(task));
    return task;
  }

  private async _generate_and_emit_title(
    handle: TurnHandle,
    session: SessionDict,
    user_text: string,
  ): Promise<string | null> {
    /** Generate title asynchronously and emit session_meta immediately. */
    try {
      // TODO(verify): generate_title(user_text, assistant_text="", settings=…)
      const title = await generate_title(user_text, "", this._settings);
      if (!title) return null;
      session.title = title;
      await this._emit(
        handle,
        AgentRuntime._stream_event(handle, "session_meta", { metadata: { title } }),
      );
      this._store.save(session);
      return title;
    } catch {
      log.warning("chat title update failed");
      return null;
    } finally {
      handle.settled.set();
    }
  }

  private _finalize_turn(handle: TurnHandle, session: SessionDict, status: string): void {
    /** Seal the recorded turn and flush it to disk. */
    const turns = (session.turns ?? {}) as AnyDict;
    const turn = turns[handle.turn_id] as AnyDict | undefined;
    if (turn !== undefined) {
      turn.status = status;
      turn.finished_at = now();
      turn.last_seq = handle.seq;
    }
    handle.status = status;
    try {
      this._store.save(session);
    } catch {
      /* best effort */
    }
  }

  private async _run(
    handle: TurnHandle,
    session: SessionDict,
    command: AnyDict,
    user_message: SessionDict,
  ): Promise<void> {
    await this._run_vtx(handle, session, command, user_message);
  }

  turn_events_after(turn_id: string, after_seq: number): AnyDict[] {
    const handle = this._turns.get(turn_id);
    if (handle !== undefined) {
      return handle.events.filter((e) => Number(e.seq ?? 0) > after_seq);
    }
    // Fall back to the persisted log (turn finished or server restarted).
    return this._store.turn_events(turn_id, after_seq) as AnyDict[];
  }
}

function _new_id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ============================================================================
// -- local agent loop (vtx stand-in) -----------------------------------------
//
// vtx's ConversationRuntime/Agent/Session are not available in TypeScript. This section is a
// minimal equivalent that preserves the contract the runtime above relies on:
//
//   * per-session cached runtime holding the conversation history;
//   * an async generator of VtxEvent objects (text/thinking deltas, tool
//     start/end/result, approval + ask_user deferreds, agent end/error);
//   * OpenAI-compatible chat-completions streaming via fetch against
//     settings-resolved base_url/api_key;
//   * tool dispatch through BaseTool.execute with JSON-schema tool specs.
//
// Deliberate simplifications vs vtx (documented, not bugs):
//   * history lives in memory on the runtime (plus optional PraxisSession
//     entry persistence), not a JSONL session store;
//   * no sub-agent/task machinery, MCP, hooks, compaction, or guardrails —
//     BackgroundTaskCompletedEvent etc. remain mapped for forward compat;
//   * approvals are always auto-approved by the runtime's event loop, so the
//     agent only *requests* them.
// ============================================================================

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

const MAX_TOOL_ROUNDS = 25; // mirrors settings.max_turns cap on agentic turns

export class LocalAgentRuntime {
  cwd: string;
  model: string;
  model_provider: string;
  api_key: string;
  base_url: string;
  thinking_level: unknown;
  tools: BaseTool[];
  vtx_session: PraxisSession | null;
  private readonly _settings: Settings;
  private _progress_callback: ((tool_call_id: string, payload: AnyDict) => void) | null = null;
  readonly agent: LocalAgent;

  constructor(opts: {
    cwd: string;
    model: string;
    model_provider: string;
    api_key: string;
    base_url: string;
    thinking_level?: unknown;
    tools: BaseTool[];
    vtx_session?: PraxisSession | null;
    settings: Settings;
  }) {
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.model_provider = opts.model_provider;
    this.api_key = opts.api_key;
    this.base_url = opts.base_url;
    this.thinking_level = opts.thinking_level ?? null;
    this.tools = opts.tools;
    this.vtx_session = opts.vtx_session ?? null;
    this._settings = opts.settings;
    this.agent = new LocalAgent(this);
  }

  set_progress_callback(cb: (tool_call_id: string, payload: AnyDict) => void): void {
    this._progress_callback = cb;
  }

  /** prepare_for_run equivalent — the local agent needs no async init. */
  prepare_agent(): LocalAgent {
    return this.agent;
  }
}

export class LocalAgent {
  private readonly _runtime: LocalAgentRuntime;
  _system_prompt = "";
  private _messages: ChatMessage[] = [];
  private _prompt_built = false;
  /** Turn-scoped capability surface (tool gate + owned tools). */
  private _turn: TurnCapabilityHooks | null = null;

  constructor(runtime: LocalAgentRuntime) {
    this._runtime = runtime;
  }

  get vtx_session(): PraxisSession | null {
    return this._runtime.vtx_session;
  }

  /** Mirror of runtime.tools for _context_budget. */
  get tools(): BaseTool[] {
    return this._runtime.tools;
  }

  private _build_system_prompt(): string {
    if (this._prompt_built) return this._system_prompt;
    this._prompt_built = true;
    try {
      // build_praxis_prompt(runtime, session, context) — the TS port keeps
      // the vtx Context/builder internals behind the same call shape.
      const runtimeLike = {
        cwd: this._runtime.cwd,
        declared_tools: () => this._runtime.tools,
        declaredTools: () => this._runtime.tools,
      };
      const built = (build_praxis_prompt as any)(runtimeLike, null, null);
      this._system_prompt = typeof built === "string" && built ? built : PRAXIS_BASE;
    } catch {
      this._system_prompt = PRAXIS_BASE;
    }
    return this._system_prompt;
  }

  private _ensure_system_message(): void {
    if (this._messages.length === 0 || this._messages[0].role !== "system") {
      this._messages.unshift({
        role: "system",
        content: this._build_system_prompt(),
      });
    }
  }

  private _openai_tools(): AnyDict[] {
    const gate = this._turn?.toolFilter;
    const available = [
      ...this._runtime.tools,
      ...(this._turn?.ownedTools ?? []),
    ].filter((t) => (gate ? gate(t.name) : true));
    return available.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters:
          (t.params as AnyDict | undefined) ?? { type: "object", properties: {} },
      },
    }));
  }

  /**
   * Compose the system message for this turn: the cached base prompt plus any
   * capability-contributed blocks (upstream ``capability_blocks`` sit after
   * the foundation blocks; the TS prompt builder has no block seam, so they
   * are appended — same net effect for the model).
   */
  private _apply_turn_system_prompt(turn: TurnCapabilityHooks | null): void {
    const base = this._build_system_prompt();
    const extras = (turn?.systemBlocks ?? [])
      .map((b) => String(b.content ?? b.text ?? "").trim())
      .filter(Boolean);
    const composed = extras.length ? `${base}\n\n${extras.join("\n\n")}` : base;
    this._system_prompt = composed;
    const first = this._messages[0];
    if (first !== undefined && first.role === "system") {
      first.content = composed;
    } else {
      this._messages.unshift({ role: "system", content: composed });
    }
  }

  /**
   * Async stream of agent events for one user prompt — the local equivalent
   * of ``agent.run(prompt, cancel_event=...)``.
   *
   * ``turn`` carries the capability LoopExtension surface resolved for this
   * turn (system blocks, user-message seed, kwargs augmenter); it is null for
   * plain chat and for Co-Writer-adjacent internal runs.
   */
  async *run(
    prompt: string,
    cancelSignal?: AbortSignal,
    turn?: TurnCapabilityHooks | null,
  ): AsyncGenerator<VtxEvent> {
    this._turn = turn ?? null;
    this._apply_turn_system_prompt(turn ?? null);
    // Upstream folds capability pre_loop_seed + async pre_loop briefings into
    // the user-message seed (kb_seed slot); appended here verbatim.
    const seed = String(turn?.seedText ?? "").trim();
    const userContent = seed ? `${prompt}\n\n${seed}` : prompt;
    this._messages.push({ role: "user", content: userContent });
    this._persist_entry("user", userContent);

    const tools = this._openai_tools();
    // A tool-heavy turn makes several model calls; the final AgentEndEvent must
    // carry the sum, not just the last call's usage.
    let turnUsage: UsageStats | null = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (cancelSignal?.aborted) throw new DOMException("Aborted", "AbortError");

      const gen = this._stream_chat(this._messages, tools, cancelSignal);
      let step = await gen.next();
      while (!step.done) {
        yield step.value;
        step = await gen.next();
      }
      const { content, tool_calls, usage } = step.value;
      turnUsage = usageStats.add_usage(turnUsage, usage) as UsageStats;

      if (tool_calls.length === 0) {
        if (content) {
          this._messages.push({ role: "assistant", content });
          this._persist_entry("assistant", content);
        }
        yield new AgentEndEvent(turnUsage);
        return;
      }

      // Assistant message carrying the tool calls, then one tool result per call.
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: content || null,
        tool_calls,
      };
      this._messages.push(assistantMsg);
      this._persist_entry("assistant", content || "", tool_calls);

      for (const call of tool_calls) {
        if (cancelSignal?.aborted) throw new DOMException("Aborted", "AbortError");
        const name = call.function.name;
        let args: AnyDict = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as AnyDict;
        } catch {
          args = {};
        }
        // Capability augment_kwargs: server-owned private params (material id,
        // solve session, note document, creation context, mastery turn handles)
        // are merged in before dispatch — the model never names them.
        if (turn?.augment) {
          try {
            args = turn.augment(name, args);
          } catch (exc) {
            log.warning(`capability augment_kwargs failed for ${name}`, exc);
          }
        }

        yield new ToolStartEvent(name, call.id);
        yield new ToolEndEvent(name, call.id, args);

        // The SDK intercepts ask_user before dispatch: validate + normalise
        // the questionnaire, publish the card, and pause until the learner's
        // answer resolves the deferred. Invalid arguments fail the tool call
        // (the error goes back to the model) instead of parking the turn.
        if (name === "ask_user") {
          const { payload, error } = buildAskUserPayload(args);
          if (payload === null) {
            const failure = new ToolResult(false, error ?? "Invalid ask_user arguments.", true);
            this._messages.push({
              role: "tool",
              tool_call_id: call.id,
              name,
              content: failure.result,
            });
            this._persist_entry("tool", failure.result, undefined, name);
            yield new ToolResultEvent(name, call.id, failure);
            continue;
          }
          const questions: AskUserQuestion[] = payload.questions.map((q) => ({
            question: q.prompt,
            prompt: q.prompt,
            id: q.id,
            header: q.header,
            multi_select: q.multi_select,
            allow_free_text: q.allow_free_text,
            placeholder: q.placeholder,
            options: q.options,
          }));
          const future = deferred<AskUserResponse>();
          yield new AskUserEvent(questions, future, call.id, payload.intro);
          // Race the learner's answer against turn cancellation — without
          // this a cancelled turn stays parked on the question forever
          const response = await Promise.race([
            future.promise,
            new Promise<never>((_res, rej) => {
              if (cancelSignal?.aborted) {
                rej(new DOMException("Aborted", "AbortError"));
                return;
              }
              cancelSignal?.addEventListener(
                "abort",
                () => rej(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            }),
          ]);
          const text = formatAskUserResponse(response);
          this._messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: text,
          });
          this._persist_entry("tool", text, undefined, name);
          yield new ToolResultEvent(name, call.id, new ToolResult(true, text));
          continue;
        }

        // Approvals: vtx pauses for permission; Praxis auto-approves. The
        const approval = deferred<typeof ApprovalResponse.APPROVE>();
        yield new ToolApprovalEvent(approval, name, call.id);
        await approval.promise;

        const gated = this._turn?.toolFilter;
        const tool = [
          ...(this._turn?.ownedTools ?? []),
          ...this._runtime.tools,
        ].find((t) => t.name === name);
        let result: ToolResultLike;
        if (tool === undefined || (gated && !gated(name))) {
          result = new ToolResult(false, `unknown tool: ${name}`);
        } else {
          try {
            result = await tool.execute(args, { sessionId: "" } as Ctx);
          } catch (exc) {
            result = new ToolResult(false, `${name} error: ${String(exc)}`);
          }
        }
        const text = _tool_result_text(result);
        this._messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: text,
        });
        this._persist_entry("tool", text, undefined, name);
        yield new ToolResultEvent(name, call.id, result);
      }
    }
    // Tool-round cap reached — end the turn rather than looping forever.
    yield new AgentEndEvent(turnUsage);
  }

  /** Persist a lightweight message entry into the bound PraxisSession. */
  private _persist_entry(
    role: string,
    content: string,
    tool_calls?: ChatToolCall[],
    name?: string,
  ): void {
    const session = this._runtime.vtx_session;
    if (!session) return;
    try {
      const entry = {
        type: "message",
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        role,
        content,
        ...(tool_calls ? { tool_calls: tool_calls } : {}),
        ...(name ? { name } : {}),
      };
      session._entries.push(entry);
      session._by_id.set(entry.id, entry);
      session._persist_entry(entry);
    } catch {
      /* persistence is best-effort */
    }
  }

  /**
   * Inject a user-role message into this agent's cached in-memory history.
   *
   * Used for background-task completion reports (vtx's
   * ``session.append_message(UserMessage(...))`` in the notebook capability):
   * the parent turn has already ended, so the message must land in
   * ``_messages`` to be part of the next turn's LLM context — persisting to
   * the session row alone is not enough because ``run()`` never rebuilds
   * ``_messages`` from the store.
   */
  inject_user_message(content: string): void {
    if (!content) return;
    this._ensure_system_message();
    this._messages.push({ role: "user", content });
    this._persist_entry("user", content);
  }

  /**
   * One streaming chat-completions call, as an async generator: yields
   * ``ThinkingDeltaEvent``/``TextDeltaEvent`` for each SSE delta and returns
   * the assembled ``{content, tool_calls, usage}`` when the stream ends.
   */
  private async *_stream_chat(
    messages: ChatMessage[],
    tools: AnyDict[],
    cancelSignal: AbortSignal | undefined,
  ): AsyncGenerator<VtxEvent, {
    content: string;
    tool_calls: ChatToolCall[];
    usage: UsageStats | null;
  }, void> {
    const body: AnyDict = {
      model: this._runtime.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) body.tools = tools;

    const base = this._runtime.base_url.replace(/\/+$/, "");
    const url = /\/(chat\/completions|responses)$/.test(base)
      ? base
      : `${base}/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this._runtime.api_key ? { authorization: `Bearer ${this._runtime.api_key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: cancelSignal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`LLM request failed (${resp.status}): ${text.slice(0, 500)}`);
    }
    if (!resp.body) throw new Error("LLM response had no body");

    let content = "";
    const tool_calls = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: UsageStats | null = null;
    let buffer = "";
    // Delta events are queued by handleLine and drained by the read loop —
    // a plain closure cannot yield, so ordering is preserved via this buffer.
    const pending: VtxEvent[] = [];

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let chunk: AnyDict;
      try {
        chunk = JSON.parse(data) as AnyDict;
      } catch {
        return;
      }
      if (chunk.usage && typeof chunk.usage === "object") {
        const u = chunk.usage as AnyDict;
        // OpenAI-compatible gateways nest cache reads under
        // `prompt_tokens_details.cached_tokens`; Anthropic-style APIs put them
        // at the top level. Normalize both into one UsageStats shape.
        const promptDetails = (u.prompt_tokens_details ?? {}) as AnyDict;
        const completionDetails = (u.completion_tokens_details ?? {}) as AnyDict;
        const hasCache =
          u.cache_read_tokens != null ||
          u.cache_read_input_tokens != null ||
          u.cache_creation_input_tokens != null ||
          u.cache_write_tokens != null ||
          promptDetails.cached_tokens != null;
        usage = {
          // `prompt_tokens` already includes cached reads on OpenAI-compatible
          // APIs, so prefer the provider's grand total when it gives us one.
          total_tokens: Number(u.total_tokens ?? 0) || undefined,
          input_tokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0) || undefined,
          output_tokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) || undefined,
          cache_read_tokens:
            Number(
              u.cache_read_tokens ??
                u.cache_read_input_tokens ??
                promptDetails.cached_tokens ??
                0,
            ) || undefined,
          cache_write_tokens:
            Number(u.cache_creation_input_tokens ?? u.cache_write_tokens ?? 0) || undefined,
          cache_reported: hasCache,
          reasoning_tokens: Number(completionDetails.reasoning_tokens ?? 0) || undefined,
        };
      }
      const choices = (chunk.choices as AnyDict[] | undefined) ?? [];
      for (const choice of choices) {
        const delta = (choice.delta ?? {}) as AnyDict;
        const reasoningDelta = String(
          delta.reasoning_content ?? delta.reasoning ?? "",
        );
        if (reasoningDelta) {
          pending.push(new ThinkingDeltaEvent(reasoningDelta));
        }
        const textDelta = String(delta.content ?? "");
        if (textDelta) {
          content += textDelta;
          pending.push(new TextDeltaEvent(textDelta));
        }
        const calls = (delta.tool_calls as AnyDict[] | undefined) ?? [];
        for (const tc of calls) {
          const idx = Number(tc.index ?? 0);
          const existing = tool_calls.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) existing.id = String(tc.id);
          const fn = (tc.function ?? {}) as AnyDict;
          if (fn.name) existing.name += String(fn.name);
          if (fn.arguments) existing.arguments += String(fn.arguments);
          tool_calls.set(idx, existing);
        }
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handleLine(line);
          yield* pending.splice(0);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        handleLine(buffer);
        yield* pending.splice(0);
      }
    } finally {
      reader.releaseLock();
    }

    const calls: ChatToolCall[] = [...tool_calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({
        id: tc.id || `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      }));

    return { content, tool_calls: calls, usage };
  }
}

function formatAskUserResponse(response: AskUserResponse): string {
  const parts: string[] = [];
  for (const a of response.answers ?? []) {
    parts.push(`${a.question}: ${a.answer}`);
  }
  if (response.custom_text) parts.push(response.custom_text);
  return parts.join("\n") || "(no answer)";
}
