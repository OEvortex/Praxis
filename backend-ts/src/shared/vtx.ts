// Minimal TS port of the vtx SDK surface the Python backend uses.
// The real vtx SDK is Python-only; these interfaces mirror the parts
// Praxis touches (tools, sessions, subagents, events).

export interface ToolParamField {
  type: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  enum?: string[];
  items?: ToolParamField;
  [k: string]: unknown;
}

export interface ToolParamsSchema {
  type: "object";
  properties: Record<string, ToolParamField>;
  required?: string[];
}

export interface Ctx {
  sessionId?: string;
  cancelEvent?: AbortSignal;
  emit?: (event: unknown) => void;
  [k: string]: unknown;
}

export abstract class BaseTool<P = unknown> {
  abstract name: string;
  toolIcon?: string;
  mutating?: boolean;
  abstract description: string;
  // Python assigns a pydantic params *model class*; in TS ports this is a
  // ToolParamsSchema (JSON schema) or a constructor — kept loose deliberately.
  params?: unknown;
  abstract execute(params: P, ctx?: Ctx): Promise<ToolResultLike>;
}

export interface ToolResultLike { success: boolean; result: string; [k: string]: unknown }

export interface SubagentSpec {
  name: string;
  description: string;
  prompt?: string;
  instructions?: string | null;
  instructions_mode?: "append" | "replace" | string;
  tools_allow?: string[] | null;
  tools_deny?: string[];
  model?: string | null;
  thinking_level?: string | null;
  max_turns?: number | null;
  [k: string]: unknown;
}

export interface SessionRecord {
  id: string;
  messages: unknown[];
  vtx_header?: Record<string, unknown>;
  vtx_entries?: unknown[];
  [k: string]: unknown;
}

export interface StreamEvent { type: string; [k: string]: unknown }

// ---------------------------------------------------------------------------
// vtx protocol / runtime types used by the agent turn runtime.
// These mirror vtx.protocol.types + vtx.core.events + vtx.core.permissions.
// ---------------------------------------------------------------------------

/** Token-usage counters reported by a model call (vtx UsageStats). */
export interface UsageStats {
  /** Provider's own grand total (prompt + completion), when supplied. */
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /** Provider explicitly reported cache counters (even if all were zero). */
  cache_reported?: boolean;
  reasoning_tokens?: number;
  /** Number of model calls folded into this summary. */
  calls?: number;
  [k: string]: unknown;
}

/** vtx.protocol.types.ToolResult — the object every tool execute() returns. */
export class ToolResult {
  constructor(
    public success: boolean,
    public result: string,
    public is_error?: boolean,
    public output?: unknown,
    public content?: unknown,
    public ui?: unknown,
    ..._rest: unknown[]
  ) {}
  [k: string]: unknown;
}

/** A promise the runtime resolves later (vtx uses asyncio.Future). */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(err?: unknown): void;
  done(): boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v) => { settled = true; res(v); };
    reject = (e) => { settled = true; rej(e); };
  });
  // Avoid unhandled-rejection noise when a waiter is abandoned.
  promise.catch(() => {});
  return { promise, resolve, reject, done: () => settled };
}

// -- permissions (vtx.core.permissions) -------------------------------------

export interface AskUserAnswer {
  question: string;
  kind: string;
  answer: string;
  [k: string]: unknown;
}

export interface AskUserResponse {
  custom_text?: string | null;
  answers: AskUserAnswer[];
  [k: string]: unknown;
}

export const ApprovalResponse = {
  APPROVE: "approve",
  DENY: "deny",
} as const;
export type ApprovalResponse = (typeof ApprovalResponse)[keyof typeof ApprovalResponse];

export interface AskUserOption {
  label: string;
  description?: string | null;
  [k: string]: unknown;
}

export interface AskUserQuestion {
  question: string;
  header?: string | null;
  multi_select?: boolean;
  options?: AskUserOption[];
  [k: string]: unknown;
}

// -- events (vtx.core.events) -------------------------------------------------
// One class per SDK event so `instanceof` checks in the runtime map 1:1 onto
// the Python isinstance() chain.

export class VtxEvent {
  constructor(public type: string) {}
}

export class AgentStartEvent extends VtxEvent {
  constructor(public agentName?: string) { super("agent_start"); }
}

export class AgentEndEvent extends VtxEvent {
  constructor(public total_usage?: UsageStats | null) { super("agent_end"); }
}

export class TextDeltaEvent extends VtxEvent {
  constructor(public delta: string) { super("text_delta"); }
}

export class ThinkingDeltaEvent extends VtxEvent {
  constructor(public delta: string) { super("thinking_delta"); }
}

export class ToolStartEvent extends VtxEvent {
  constructor(
    public tool_name: string,
    public tool_call_id: string,
  ) { super("tool_start"); }
}

export class ToolEndEvent extends VtxEvent {
  // Named ``arguments`` to match the vtx event attribute (a parameter property
  // cannot use that name in strict mode, so it is assigned in the body).
  arguments?: unknown;
  constructor(
    public tool_name: string,
    public tool_call_id: string,
    args?: unknown,
  ) {
    super("tool_end");
    this.arguments = args;
  }
}

export class ToolResultEvent extends VtxEvent {
  constructor(
    public tool_name: string,
    public tool_call_id: string,
    public result: unknown,
  ) { super("tool_result"); }
}

export class ToolApprovalEvent extends VtxEvent {
  constructor(
    public future: Deferred<ApprovalResponse> | null,
    public tool_name?: string,
    public tool_call_id?: string,
  ) { super("tool_approval"); }
}

export class AskUserEvent extends VtxEvent {
  constructor(
    public questions: AskUserQuestion[],
    public future: Deferred<AskUserResponse>,
    public tool_call_id: string,
  ) { super("ask_user"); }
}

export class ErrorEvent extends VtxEvent {
  constructor(public error: unknown) { super("error"); }
}

export class HostNoticeEvent extends VtxEvent {
  constructor(public text: string) { super("host_notice"); }
}

export class BackgroundTaskCompletedEvent extends VtxEvent {
  constructor(
    public task_id: string,
    public status: string,
    public description?: string | null,
    public subagent_type?: string | null,
    public summary?: string | null,
    public turns?: number | null,
    public total_tokens?: number | null,
  ) { super("background_task_completed"); }
}

// -- global tool registry (vtx.agent.tools registry) -------------------------

const _toolRegistry = new Map<string, unknown>();

export function register_tool(tool: { name: string } | string, impl?: unknown): void {
  if (typeof tool === "string") {
    if (impl && typeof impl === "object" && "name" in impl) {
      _toolRegistry.set(tool, impl);
    } else {
      _toolRegistry.set(tool, impl);
    }
    return;
  }
  _toolRegistry.set(tool.name, tool);
}

export function get_all_tools(): unknown[] {
  return [..._toolRegistry.values()];
}
