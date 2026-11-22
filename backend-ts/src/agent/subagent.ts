// Sub-agent dispatcher bridge — the TS stand-in for vtx's
// ``vtx.agent.dispatcher`` + ``vtx.agent.tools.task`` machinery.
//
// Python flow (vtx SDK):
//   * ``vtx.agent.dispatcher.get_context()`` returns a contextvars-held
//     ``DispatcherContext`` snapshot (provider/model/cwd/session) installed by
//     the ConversationRuntime on every turn.
//   * ``resolve_subagent_runner()`` returns ``_run_subagent`` (or a product
//     override), which builds a scoped tool list + system prompt from the
//     ``SubagentSpec``, runs a fresh ``Agent`` in its own session, auto-approves
//     tool calls, resolves ask_user with an empty response, and returns a
//     ``SubagentRunResult`` (``final_text``, ``error``, ``turns``, ``usage`` …).
//
// TS equivalent:
//   * There is no vtx runtime installing a context slot, so
//     ``getDispatcherContext()`` derives the context from the *active turn*
//     bound by ``notebook_agent/events.ts`` (its AsyncLocalStorage store is set
//     for the whole ``agent.run`` loop, i.e. while tools execute). Model
//     provider/base_url/api_key are re-resolved through
//     ``providerConfig.resolve_runtime_model`` — the same call the parent turn
//     used, minus per-command overrides (the saved selection is what the
//     command carried anyway).
//   * ``runSubagent`` builds the scoped tool list from vtx's global tool
//     registry (``get_all_tools()`` — populated by
//     ``notebook_agent/tools.register_writer_tools()``), composes the system
//     prompt (``instructions_mode`` "replace" | "append" + the sub-agent final
//     answer directive), and drives a fresh ``LocalAgentRuntime``/``LocalAgent``
//     through its streaming chat-completions machinery. The agent loop itself
//     is re-implemented here (rather than calling ``LocalAgent.run``) so the
//     spec's ``max_turns`` is honoured — ``LocalAgent.run`` hard-caps at
//     ``MAX_TOOL_ROUNDS`` and cannot be parameterised without editing
//     runtime.ts. It reuses the runtime's private ``_stream_chat`` SSE parser
//     via a structural cast, so request/response handling stays identical.
//
// Deliberate simplifications vs vtx (documented, not bugs):
//   * The sub-agent gets a fresh in-memory history (``vtx_session: null``) —
//     no JSONL session persistence, matching the local loop's own session
//     model.
//   * ``record_subagent_usage`` on the parent session is not ported (the TS
//     session store has no such hook); usage is still returned on the result.
//   * There is no sub-agent scheduler/queue — runs start immediately.
//   * ``BackgroundTaskManager`` is a minimal in-process registry: ``register``
//     stores the record and runs the factory as a detached promise. Completion
//     delivery is handled by the capability module (``notify_completion``
//     broadcast + session message injection), same observable contract.

import { randomUUID } from "node:crypto";

import { get_settings } from "../config.js";
import * as providerConfig from "../provider-config.js";
import {
  get_all_tools,
  type BaseTool,
  type Ctx,
  type UsageStats,
  type VtxEvent,
} from "../shared/vtx.js";
import { LocalAgentRuntime, _tool_result_text } from "./runtime.js";
import { PRAXIS_BASE } from "./prompt.js";
import * as notebookEvents from "./notebook_agent/events.js";

type AnyDict = Record<string, any>;

// ---------------------------------------------------------------------------
// Dispatcher context (vtx.agent.dispatcher port)
// ---------------------------------------------------------------------------

export interface SubagentSessionLike {
  id?: string | null;
  append_message?: (message: unknown) => void;
  appendMessage?: (message: unknown) => void;
  [k: string]: unknown;
}

export interface BackgroundTaskRecordLike {
  task_id: string;
  notified?: boolean;
  status?: string;
  [k: string]: unknown;
}

export interface BackgroundTaskManagerLike {
  register(opts: {
    description: string;
    prompt: string;
    subagent_type: string;
    model?: string | null;
    parent_session_id?: string | null;
    run_coro_factory: () => Promise<unknown>;
  }): Promise<BackgroundTaskRecordLike>;
  [k: string]: unknown;
}

export type ProgressCallback = (
  toolCallId: string,
  event: Record<string, unknown>,
) => void;

/** Structural mirror of vtx's ``DispatcherContext`` dataclass. */
export interface SubagentDispatcherContext {
  provider?: unknown;
  model?: string | null;
  model_provider?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  thinking_level?: unknown;
  agent_registry?: unknown;
  cwd?: string;
  system_prompt?: string | null;
  progressCallback?: ProgressCallback | null;
  progress_callback?: ProgressCallback | null;
  background_manager?: BackgroundTaskManagerLike | null;
  backgroundManager?: BackgroundTaskManagerLike | null;
  session?: SubagentSessionLike | null;
  session_id?: string | null;
  [k: string]: unknown;
}

function _ctxProgressCallback(ctx: SubagentDispatcherContext | null | undefined): ProgressCallback | null {
  return ctx?.progressCallback ?? ctx?.progress_callback ?? null;
}

/**
 * Port of ``vtx.agent.dispatcher.get_context``.
 *
 * Returns ``null`` when no agent turn is active (the capability modules turn
 * that into their user-facing "dispatcher context not initialized" error).
 * The context is rebuilt per call from the live turn handle + the saved model
 * selection, so it is always fresh — the TS equivalent of vtx re-installing
 * the slot on every runtime state change.
 */
export function getDispatcherContext(): SubagentDispatcherContext | null {
  const turn = notebookEvents.current_turn("");
  if (turn == null) return null;

  const settings = get_settings();
  let resolved: AnyDict = {};
  try {
    resolved = (providerConfig.resolve_runtime_model(settings, null) ?? {}) as AnyDict;
  } catch {
    resolved = {};
  }

  const sessionDict = (turn.session_ref ?? null) as AnyDict | null;
  const sessionId = String(turn.session_id ?? "");
  const session: SubagentSessionLike | null = sessionDict
    ? {
        id: sessionId,
        // Mirrors ``session.append_message(UserMessage(...))``: the capability
        // passes ``{role, content}``. Persistence goes through the app's
        // SessionStore when reachable (dynamic import avoids a module cycle
        // with main.ts); otherwise the row is still appended in memory.
        append_message: (message: unknown) => {
          const content =
            typeof message === "string"
              ? message
              : String((message as AnyDict)?.content ?? "");
          if (!content) return;
          // Mirror vtx's session.append_message(UserMessage(...)): besides
          // persisting to the session row, the message must reach the cached
          // agent's in-memory history or the next turn's LLM context never
          // sees it (LocalAgent._messages is never rebuilt from the store).
          notebookEvents.inject_session_message(sessionId, content);
          const pushInMemory = (): void => {
            // Fallback so the message is at least visible on the row this
            // process still holds when the SessionStore is unreachable.
            try {
              const messages = (sessionDict.messages ??= []) as AnyDict[];
              messages.push({
                id: `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
                session_id: sessionId,
                role: "user",
                content,
                created_at: Date.now() / 1000,
              });
            } catch {
              /* ignore */
            }
          };
          void import("../main.js")
            .then(({ appState }) => {
              const store = (appState as AnyDict)?.store;
              if (store && typeof store.append_user_message === "function") {
                store.append_user_message(sessionDict, content, {
                  metadata: { source: "background_task" },
                });
                if (typeof store.save === "function") store.save(sessionDict);
              } else {
                pushInMemory();
              }
            })
            .catch(() => {
              pushInMemory();
            });
        },
      }
    : null;

  return {
    provider: null,
    model: String(resolved.model ?? "") || null,
    model_provider: String(resolved.provider ?? "") || null,
    base_url: String(resolved.base_url ?? "") || null,
    api_key: String(resolved.api_key ?? "") || null,
    thinking_level: resolved.thinking_level ?? null,
    agent_registry: null,
    cwd: String(settings.workspace_dir ?? ""),
    system_prompt: null,
    progressCallback: notebookEvents.progress_callback,
    progress_callback: notebookEvents.progress_callback,
    background_manager: getBackgroundTaskManager(),
    backgroundManager: getBackgroundTaskManager(),
    session,
    session_id: sessionId || null,
  };
}

// ---------------------------------------------------------------------------
// Background task manager (vtx.agent.background port, minimal)
// ---------------------------------------------------------------------------

interface BackgroundTask extends BackgroundTaskRecordLike {
  description: string;
  prompt: string;
  subagent_type: string;
  model?: string | null;
  parent_session_id?: string | null;
  run_coro_factory: () => Promise<unknown>;
}

/**
 * Process-local background task registry. ``register`` stores the record and
 * starts ``run_coro_factory`` as a detached task; the record's ``status`` /
 * ``error`` fields settle when the factory resolves. There is no between-turn
 * drain in the TS port — the capability modules deliver completion themselves
 * (``notebook_events.notify_completion`` broadcast + session injection).
 */
export class LocalBackgroundTaskManager implements BackgroundTaskManagerLike {
  [k: string]: unknown;
  private readonly _tasks = new Map<string, BackgroundTask>();

  async register(opts: {
    description: string;
    prompt: string;
    subagent_type: string;
    model?: string | null;
    parent_session_id?: string | null;
    run_coro_factory: () => Promise<unknown>;
  }): Promise<BackgroundTaskRecordLike> {
    const record: BackgroundTask = {
      task_id: `task_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      description: opts.description,
      prompt: opts.prompt,
      subagent_type: opts.subagent_type,
      model: opts.model ?? null,
      parent_session_id: opts.parent_session_id ?? null,
      run_coro_factory: opts.run_coro_factory,
      notified: false,
      status: "running",
    };
    this._tasks.set(record.task_id, record);
    // register() must return before the factory's first await so callers can
    // stash the record (mirrors vtx starting the coroutine immediately).
    void this._run(record);
    return record;
  }

  private async _run(record: BackgroundTask): Promise<void> {
    try {
      await record.run_coro_factory();
      record.status = "completed";
    } catch (exc) {
      record.status = "error";
      record.error = exc instanceof Error ? exc.message : String(exc);
    }
  }

  get(taskId: string): BackgroundTaskRecordLike | undefined {
    return this._tasks.get(taskId);
  }

  list(): BackgroundTaskRecordLike[] {
    return [...this._tasks.values()];
  }
}

let _backgroundManager: LocalBackgroundTaskManager | null = null;

/** Port of ``vtx.agent.background.get_manager`` (singleton). */
export function getBackgroundTaskManager(): LocalBackgroundTaskManager {
  _backgroundManager ??= new LocalBackgroundTaskManager();
  return _backgroundManager;
}

// ---------------------------------------------------------------------------
// Sub-agent runner (vtx.agent.tools.task port)
// ---------------------------------------------------------------------------

/** Verbatim from vtx ``SUBAGENT_FINAL_ANSWER_DIRECTIVE``. */
const SUBAGENT_FINAL_ANSWER_DIRECTIVE =
  "You are an isolated sub-agent dispatched by a parent agent via the " +
  "Subagent dispatch. Your final text response is returned to the parent agent " +
  "verbatim as the tool result, so:\n" +
  "\n" +
  "  - Return ONLY your final answer — no preamble, no 'I will now...', " +
  "no step-by-step narration of the work you did.\n" +
  "  - Do not summarise the tools you called or the files you read; the " +
  "parent does not see those and they would just clutter the answer.\n" +
  "  - If the request was open-ended, prefer a focused, self-contained " +
  "answer that another agent can act on without further questions.\n" +
  "  - Tool calls are fine — they let you actually do the work — but the " +
  "final text is what the parent reads.";

const DEFAULT_SUBAGENT_MAX_TURNS = 200;

export interface SubagentSpecLike {
  name?: string;
  description?: string;
  instructions?: string | null;
  instructions_mode?: string;
  tools_allow?: string[] | null;
  tools_deny?: string[] | null;
  model?: string | null;
  thinking_level?: string | null;
  max_turns?: number | null;
  [k: string]: unknown;
}

export interface SubagentRunnerArgs {
  parentCtx: SubagentDispatcherContext | Record<string, unknown> | null;
  spec: SubagentSpecLike | Record<string, unknown>;
  prompt: string;
  cancelEvent?: AbortSignal | null;
  modelOverride?: string | null;
  progressCallback?: ProgressCallback | null;
  toolCallId: string;
  label?: string;
}

export interface SubagentRunResult {
  finalText: string;
  final_text?: string;
  error: string | null;
  turns: number;
  usage: UsageStats | null;
  transcript: string[];
  session_id: string | null;
  duration_ms: number | null;
  stop_reason: string;
  [k: string]: unknown;
}

export type SubagentRunner = (args: SubagentRunnerArgs) => Promise<SubagentRunResult>;

let _subagentRunnerOverride: SubagentRunner | null = null;

/** Port of ``vtx.agent.tools.task.set_subagent_runner``. */
export function set_subagent_runner(runner: SubagentRunner | null): void {
  _subagentRunnerOverride = runner;
}

/** Port of ``vtx.agent.tools.task.resolve_subagent_runner``. */
export function resolve_subagent_runner(): SubagentRunner {
  return _subagentRunnerOverride ?? runSubagent;
}

function _specString(spec: SubagentSpecLike, key: string): string {
  const v = spec[key];
  return typeof v === "string" ? v : "";
}

function _resolve_subagent_tools(spec: SubagentSpecLike): BaseTool[] {
  /**
   * Resolve ``tools_allow``/``tools_deny`` against vtx's global tool registry.
   * ``__none__`` is the "no tools" marker (matches nothing). A missing
   * ``tools_allow`` falls back to every registered tool — the TS registry only
   * holds tools a capability explicitly registered, so this stays narrow.
   */
  const allow = spec.tools_allow ?? null;
  const deny = new Set(spec.tools_deny ?? []);
  const registered = (get_all_tools() as AnyDict[]).filter(
    (t) => t && typeof t.name === "string" && typeof t.execute === "function",
  ) as unknown as BaseTool[];

  if (allow === null) {
    return registered.filter((t) => !deny.has(t.name));
  }
  const wanted = allow.filter((n) => n !== "__none__");
  if (wanted.length === 0) return [];
  const byName = new Map(registered.map((t) => [t.name, t]));
  const out: BaseTool[] = [];
  for (const name of wanted) {
    if (deny.has(name)) continue;
    const tool = byName.get(name);
    if (tool !== undefined) out.push(tool);
  }
  return out;
}

function _build_subagent_system_prompt(
  parentCtx: SubagentDispatcherContext | null,
  spec: SubagentSpecLike,
): string {
  const extra = (spec.instructions ?? "").trim();
  const mode = spec.instructions_mode ?? "append";
  if (mode === "replace") {
    const base = extra || PRAXIS_BASE;
    return `${base}\n\n${SUBAGENT_FINAL_ANSWER_DIRECTIVE}`;
  }
  const base =
    (typeof parentCtx?.system_prompt === "string" && parentCtx.system_prompt.trim()
      ? parentCtx.system_prompt
      : PRAXIS_BASE);
  const parts = [base.trimEnd()];
  if (extra) parts.push(extra);
  parts.push(SUBAGENT_FINAL_ANSWER_DIRECTIVE);
  return parts.join("\n\n") + "\n";
}

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

interface StreamChatResult {
  content: string;
  tool_calls: ChatToolCall[];
  usage: UsageStats | null;
}

/** The private SSE streaming call on LocalAgent, reached structurally. */
interface StreamChatCapable {
  _stream_chat(
    messages: ChatMessage[],
    tools: AnyDict[],
    cancelSignal: AbortSignal | undefined,
  ): AsyncGenerator<VtxEvent, StreamChatResult, void>;
}

function _openai_tool_specs(tools: BaseTool[]): AnyDict[] {
  return tools.map((t) => ({
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
 * Run one sub-agent to completion — the TS port of vtx's ``_run_subagent``.
 *
 * Kept deliberately close to ``LocalAgent.run`` (same message shapes, same
 * tool dispatch semantics) with two differences: the system prompt comes from
 * the spec, and the round cap is the spec's ``max_turns``.
 */
export async function runSubagent(args: SubagentRunnerArgs): Promise<SubagentRunResult> {
  const spec = (args.spec ?? {}) as SubagentSpecLike;
  const parentCtx = (args.parentCtx ?? null) as SubagentDispatcherContext | null;
  const specName = _specString(spec, "name") || "subagent";
  const specDescription = _specString(spec, "description");
  const label = args.label || specDescription || specName;
  const progressCallback =
    args.progressCallback ?? _ctxProgressCallback(parentCtx);
  const toolCallId = args.toolCallId || `subagent_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const cancelSignal = args.cancelEvent ?? null;

  const emit = (kind: string, fields: AnyDict = {}): void => {
    if (progressCallback == null) return;
    try {
      progressCallback(toolCallId, { kind, subagent: specName, ...fields });
    } catch {
      /* progress must never fail the run */
    }
  };

  const result: SubagentRunResult = {
    finalText: "",
    error: null,
    turns: 0,
    usage: null,
    transcript: [],
    session_id: null,
    duration_ms: null,
    stop_reason: "stop",
    final_text: "",
  };

  const startedAt = Date.now();
  const tools = _resolve_subagent_tools(spec);
  const systemPrompt = _build_subagent_system_prompt(parentCtx, spec);
  const maxTurns =
    Number(spec.max_turns ?? 0) > 0
      ? Number(spec.max_turns)
      : DEFAULT_SUBAGENT_MAX_TURNS;
  const model =
    args.modelOverride ||
    (typeof spec.model === "string" && spec.model.trim() ? spec.model : null) ||
    parentCtx?.model ||
    "";

  const settings = get_settings();
  // Fall back to the saved selection for anything the context lacks.
  let resolved: AnyDict = {};
  try {
    resolved = (providerConfig.resolve_runtime_model(settings, null) ?? {}) as AnyDict;
  } catch {
    resolved = {};
  }
  if (!model) {
    result.error = "no model configured — pick one in Settings → LLM";
    result.duration_ms = Date.now() - startedAt;
    emit("error", { error: result.error });
    return result;
  }

  const toolCounts: Record<string, number> = {};
  emit("subagent_start", {
    description: specDescription,
    label,
    model,
    max_turns: maxTurns,
    tool_counts: { ...toolCounts },
  });

  const runtime = new LocalAgentRuntime({
    cwd: parentCtx?.cwd || String(settings.workspace_dir ?? ""),
    model,
    model_provider:
      parentCtx?.model_provider || String(resolved.provider ?? ""),
    api_key: parentCtx?.api_key || String(resolved.api_key ?? ""),
    base_url: parentCtx?.base_url || String(resolved.base_url ?? ""),
    thinking_level:
      spec.thinking_level ??
      parentCtx?.thinking_level ??
      resolved.thinking_level ??
      null,
    tools,
    vtx_session: null,
    settings,
  });
  const agent = runtime.prepare_agent() as unknown as StreamChatCapable;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: args.prompt },
  ];
  const openaiTools = _openai_tool_specs(tools);
  const sessionId = parentCtx?.session_id ?? parentCtx?.session?.id ?? "";
  const toolCtx = {
    sessionId: String(sessionId ?? ""),
    cancelEvent: cancelSignal ?? undefined,
    emit: () => {},
  } as Ctx;

  const usage: UsageStats = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  };
  let sawUsage = false;

  try {
    for (let round = 0; round < maxTurns; round++) {
      if (cancelSignal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const gen = agent._stream_chat(messages, openaiTools, cancelSignal ?? undefined);
      // Drain the delta events for live progress, then take the assembled
      // result — same consumption pattern as LocalAgent.run.
      let step = await gen.next();
      while (!step.done) {
        const ev = step.value;
        if (ev && (ev as AnyDict).type === "text_delta") {
          emit("text_delta", { delta: String((ev as AnyDict).delta ?? "") });
        }
        step = await gen.next();
      }
      const { content, tool_calls, usage: roundUsage } = step.value;
      if (roundUsage) {
        sawUsage = true;
        usage.input_tokens =
          (usage.input_tokens ?? 0) + Number(roundUsage.input_tokens ?? 0);
        usage.output_tokens =
          (usage.output_tokens ?? 0) + Number(roundUsage.output_tokens ?? 0);
        usage.cache_read_tokens =
          (usage.cache_read_tokens ?? 0) + Number(roundUsage.cache_read_tokens ?? 0);
        usage.cache_write_tokens =
          (usage.cache_write_tokens ?? 0) + Number(roundUsage.cache_write_tokens ?? 0);
      }
      result.turns += 1;

      if (!tool_calls || tool_calls.length === 0) {
        if (content) {
          messages.push({ role: "assistant", content });
        }
        result.finalText = content ?? "";
        result.final_text = result.finalText;
        break;
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: content || null,
        tool_calls,
      };
      messages.push(assistantMsg);

      for (const call of tool_calls) {
        if (cancelSignal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const name = call.function.name;
        let callArgs: AnyDict = {};
        try {
          callArgs = JSON.parse(call.function.arguments || "{}") as AnyDict;
        } catch {
          callArgs = {};
        }

        emit("tool_start", { tool_name: name, tool_counts: { ...toolCounts } });
        toolCounts[name] = (toolCounts[name] ?? 0) + 1;
        result.transcript.push(`  → ${name}`);

        let toolText: string;
        if (name === "ask_user") {
          // vtx resolves sub-agent ask_user with an empty response rather than
          // blocking on the learner — mirror that (formatAskUserResponse of an
          // empty AskUserResponse is "(no answer)").
          toolText = "(no answer)";
        } else {
          const tool = tools.find((t) => t.name === name);
          let toolResult: unknown;
          if (tool === undefined) {
            toolResult = { success: false, result: `unknown tool: ${name}` };
          } else {
            try {
              toolResult = await tool.execute(callArgs, toolCtx);
            } catch (exc) {
              toolResult = {
                success: false,
                result: `${name} error: ${exc instanceof Error ? exc.message : String(exc)}`,
              };
            }
          }
          toolText = _tool_result_text(toolResult);
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: toolText,
        });
        emit("tool_result", { tool_name: name, tool_counts: { ...toolCounts } });
      }

      emit("turn_end", {
        turns: result.turns,
        tokens: sawUsage ? usage.total_tokens ?? null : null,
        tool_counts: { ...toolCounts },
      });
    }

    if (result.finalText === "" && result.turns >= maxTurns) {
      // Loop exhausted without a tool-free final answer.
      result.stop_reason = "max_turns";
    }
  } catch (exc) {
    if (exc instanceof DOMException && exc.name === "AbortError") {
      result.error = "Sub-agent cancelled.";
      result.stop_reason = "cancelled";
      emit("cancelled");
    } else {
      result.error = `Sub-agent raised: ${exc instanceof Error ? exc.message : String(exc)}`;
      result.stop_reason = "error";
      emit("error", { error: result.error });
    }
  }

  result.duration_ms = Date.now() - startedAt;
  result.usage = sawUsage ? usage : null;
  result.final_text = result.finalText;

  emit("subagent_end", {
    turns: result.turns,
    stop_reason: result.stop_reason,
    final_text: result.finalText,
    tool_counts: { ...toolCounts },
    tokens: result.usage?.total_tokens ?? null,
    transcript: [...result.transcript],
  });
  return result;
}
