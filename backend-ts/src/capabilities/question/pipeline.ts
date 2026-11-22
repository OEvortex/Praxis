// Port of deeptutor/agents/question/pipeline.py + coordinator.py — the
// QuestionPipeline that backs WS /questions/generate and /questions/mimic.
//
// Phase shape (mirrors upstream):
//   Phase 1 (explore) — agentic THINK/TOOL/FINISH loop over the mounted tool
//     surface; FINISH text streams to the user as the exploration preface.
//   Phase 2 (plan)    — one PLAN-labeled call emitting JSON question templates.
//   Phase 3 (quiz)    — one agentic loop per template; FINISH is a strict JSON
//     payload, normalized + repaired, then emitted as a quiz_question_emitted
//     content event. A terminal `result` event carries the summary envelope.
//
// TS port notes / TODOs:
//  - Upstream runs the loops through runtime.agentic (label protocol, native
//    tool calling, per-tool trace sub-cards, tool-result summarizer). This port
//    re-implements the same protocol over a small chat-completions client:
//    OpenAI-wire providers stream SSE deltas; anthropic / openai-responses use
//    non-streaming calls with native tool calling.
//  - Tool surface is the TS tool set that covers upstream's chat tools:
//    knowledge_base_search (≈ rag/read_source over the attached KB),
//    question_bank, memory, web (≈ web_search/web_fetch), paper_search.
//    Workspace baseline tools, ask_user, cron, exec, pageindex and skill tools
//    are not mounted (no TS counterpart wired here).
//  - Quiz history comes from the question-notebook entries store filtered by
//    session_id (upstream reads notebook_entries; the WS /generate request
//    carries no session id, so upstream effectively sees an empty history too).

import { randomUUID } from "node:crypto";
import type { Settings } from "../../config.js";
import { get_settings } from "../../config.js";
import { get_state } from "../../store/database.js";
import { resolve as resolveModel } from "../../services/llm_text.js";
import { questionPrompts, fmt } from "./prompts.js";
import { knowledge_base_search } from "../../agent/kb_tools.js";
import {
  question_bank,
  memory,
  web,
  paper_search,
} from "../../agent/dt_tools.js";
import type { ToolResult } from "../../shared/types.js";
import * as qn from "../../services/question_notebook.js";

// ---------------------------------------------------------------------------
// Constants (pipeline.py)
// ---------------------------------------------------------------------------

export const SOURCE = "deep_question";
export const STAGE_EXPLORING = "exploring";
export const STAGE_PLANNING = "planning";
export const STAGE_QUIZZING = "quizzing";

const LABEL_THINK = "THINK";
const LABEL_TOOL = "TOOL";
const LABEL_FINISH = "FINISH";
const LABEL_PLAN = "PLAN";

const CALL_KIND_QUIZ_QUESTION = "quiz_question_emitted";
const TRACE_ROLE_QUIZ_QUESTION = "quiz_question";
const TRACE_GROUP_QUIZ = "quiz";

const DEFAULT_MAX_EXPLORE_ITERATIONS = 8;
const DEFAULT_MAX_QUIZ_ITERATIONS_PER_QUESTION = 5;
const FINALIZATION_REPAIR_ATTEMPTS = 2;
const TOOL_SUMMARIZER_TEMPERATURE = 0.2;
const MAX_PARALLEL_TOOL_CALLS = 15;
const DEFAULT_TEMPERATURE = 0.4;

// Token budgets — upstream reads agents.yaml capabilities.question; the TS
// port has no staged-params loader, so the shipped defaults are inline.
const BUDGETS = {
  answering: { max_tokens: 4096 },
  planning: { max_tokens: 2048 },
  quiz_finish: { max_tokens: 4096 },
  repair: { max_tokens: 2048 },
  tool_summarizer: { max_tokens: 800 },
} as const;

const VALID_QUESTION_TYPES = new Set([
  "choice",
  "concept",
  "fill_in_blank",
  "short_answer",
  "written",
  "coding",
]);
const VALID_DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const CHOICE_KEYS = ["A", "B", "C", "D"] as const;
const FILL_IN_BLANK_TOKEN = "____";
const CONCEPT_ANSWERS = new Set(["true", "false"]);

// ---------------------------------------------------------------------------
// Data shapes (pipeline.py dataclasses)
// ---------------------------------------------------------------------------

export interface QuizTemplate {
  question_id: string;
  topic: string;
  question_type: string;
  difficulty: string;
  source?: string;
  reference_question?: string | null;
  reference_answer?: string | null;
}

export interface QuizPlan {
  analysis: string;
  templates: QuizTemplate[];
}

export interface QuizHistoryEntry {
  question: string;
  question_type: string;
  correct_answer: string;
  user_answer: string;
  is_correct: boolean | null;
  turn_id: string;
}

export interface QuizPair {
  question_id: string;
  question: string;
  question_type: string;
  correct_answer: string;
  explanation: string;
  options: Record<string, string> | null;
  topic: string;
  difficulty: string;
  metadata: Record<string, unknown>;
}

type Dict = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Stream bus — emits the same frame dicts as upstream StreamEvent.to_dict()
// ---------------------------------------------------------------------------

export type QuestionStreamEmit = (event: Dict) => void | Promise<void>;

export class QuestionStream {
  private readonly _emit: QuestionStreamEmit;
  private readonly _source: string;
  private readonly _sessionId: string;
  private readonly _turnId: string;

  constructor(
    emit: QuestionStreamEmit,
    opts: { source?: string; session_id?: string; turn_id?: string } = {},
  ) {
    this._emit = emit;
    this._source = opts.source ?? SOURCE;
    this._sessionId = opts.session_id ?? "";
    this._turnId = opts.turn_id ?? "";
  }

  private _event(
    type: string,
    opts: { stage?: string; content?: string; metadata?: Dict } = {},
  ): Dict {
    return {
      type,
      source: this._source,
      stage: opts.stage ?? "",
      content: opts.content ?? "",
      metadata: opts.metadata ?? {},
      session_id: this._sessionId,
      turn_id: this._turnId,
      seq: 0,
      timestamp: Date.now() / 1000,
    };
  }

  async emit(type: string, opts: { stage?: string; content?: string; metadata?: Dict } = {}): Promise<void> {
    await this._emit(this._event(type, opts));
  }

  async stage(name: string, fn: () => Promise<void>): Promise<void> {
    await this.emit("stage_start", { stage: name });
    try {
      await fn();
    } finally {
      await this.emit("stage_end", { stage: name });
    }
  }

  content(text: string, opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("content", { ...opts, content: text });
  }

  thinking(text: string, opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("thinking", { ...opts, content: text });
  }

  observation(text: string, opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("observation", { ...opts, content: text });
  }

  toolCall(toolName: string, args: Dict, opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("tool_call", {
      ...opts,
      stage: opts.stage,
      content: toolName,
      metadata: { args, ...(opts.metadata ?? {}) },
    });
  }

  toolResult(toolName: string, result: string, opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("tool_result", {
      ...opts,
      stage: opts.stage,
      content: result,
      metadata: { tool: toolName, ...(opts.metadata ?? {}) },
    });
  }

  progress(message: string, opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("progress", {
      ...opts,
      stage: opts.stage,
      content: message,
      metadata: { current: 0, total: 0, ...(opts.metadata ?? {}) },
    });
  }

  sources(list: Dict[], opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("sources", { ...opts, stage: opts.stage, metadata: { sources: list, ...(opts.metadata ?? {}) } });
  }

  result(payload: Dict, opts: { metadata?: Dict } = {}): Promise<void> {
    return this.emit("result", { metadata: { ...payload, ...(opts.metadata ?? {}) } });
  }

  error(message: string, opts: { stage?: string; metadata?: Dict } = {}): Promise<void> {
    return this.emit("error", { ...opts, stage: opts.stage, content: message });
  }
}

// ---------------------------------------------------------------------------
// Trace metadata helpers (core/trace.py subset)
// ---------------------------------------------------------------------------

let _callSeq = 0;
function newCallId(prefix: string): string {
  _callSeq += 1;
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 10)}-${_callSeq}`;
}

function traceMeta(opts: {
  call_id: string;
  phase: string;
  label: string;
  call_kind: string;
  trace_id?: string;
  trace_role?: string;
  trace_group?: string;
  trace_kind?: string;
  [k: string]: unknown;
}): Dict {
  const meta: Dict = {
    call_id: opts.call_id,
    phase: opts.phase,
    label: opts.label,
    call_kind: opts.call_kind,
  };
  for (const key of ["trace_id", "trace_role", "trace_group", "trace_kind"] as const) {
    if (opts[key]) meta[key] = opts[key];
  }
  for (const [k, v] of Object.entries(opts)) {
    if (!["call_id", "phase", "label", "call_kind", "trace_id", "trace_role", "trace_group", "trace_kind"].includes(k) && v !== undefined) {
      meta[k] = v;
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// LLM client — chat.completions / messages / responses wires
// ---------------------------------------------------------------------------

interface ResolvedModel {
  provider: string;
  model: string;
  api_key: string;
  base_url: string;
}

function resolveModelFor(settings: Settings): ResolvedModel {
  const r = resolveModel(settings, null) as Record<string, unknown>;
  return {
    provider: String(r["provider"] ?? ""),
    model: String(r["model"] ?? ""),
    api_key: r["api_key"] ? String(r["api_key"]) : "",
    base_url: r["base_url"] ? String(r["base_url"]) : "",
  };
}

interface ChatMsg {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ChatOutcome {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: Dict;
}

const REQUEST_TIMEOUT_MS = 180_000;

function _endpoint(base: string, suffix: string): string {
  const b = base.trim().replace(/\/+$/, "");
  if (!b) throw new Error("This model has no base URL configured");
  if (!b.toLowerCase().startsWith("http://") && !b.toLowerCase().startsWith("https://")) {
    throw new Error(`Unsupported base URL: ${b}`);
  }
  return `${b}/${suffix.replace(/^\/+/, "")}`;
}

/** OpenAI-wire chat/completions call with SSE streaming. Yields text deltas
 *  via onDelta while accumulating the full message (incl. tool_calls). */
async function openAiChat(
  llm: ResolvedModel,
  messages: ChatMsg[],
  opts: {
    tools?: ToolSpec[];
    maxTokens: number;
    temperature: number;
    onDelta?: (delta: string) => void;
  },
): Promise<ChatOutcome> {
  const body: Dict = {
    model: llm.model,
    messages,
    stream: true,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (llm.api_key) headers["Authorization"] = `Bearer ${llm.api_key}`;
  const response = await fetch(_endpoint(llm.base_url, "chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    const detail = response.body ? (await response.text()).slice(0, 800) : `HTTP ${response.status}`;
    throw new Error(`${llm.model} rejected the request (${response.status}): ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  const handleEvent = (payload: string) => {
    if (!payload || payload === "[DONE]") return;
    let event: Dict;
    try {
      event = JSON.parse(payload) as Dict;
    } catch {
      return;
    }
    const choices = Array.isArray(event["choices"]) ? (event["choices"] as Dict[]) : [];
    const choice = choices[0];
    if (!choice) return;
    const delta = (choice["delta"] ?? {}) as Dict;
    const piece = typeof delta["content"] === "string" ? (delta["content"] as string) : "";
    if (piece) {
      text += piece;
      opts.onDelta?.(piece);
    }
    const rPiece = String(delta["reasoning_content"] ?? delta["reasoning"] ?? "");
    if (rPiece) reasoning += rPiece;
    const calls = Array.isArray(delta["tool_calls"]) ? (delta["tool_calls"] as Dict[]) : [];
    for (const call of calls) {
      const idx = Number(call["index"] ?? 0);
      let acc = toolAcc.get(idx);
      if (!acc) {
        acc = { id: "", name: "", args: "" };
        toolAcc.set(idx, acc);
      }
      if (typeof call["id"] === "string" && call["id"]) acc.id = call["id"] as string;
      const fn = (call["function"] ?? {}) as Dict;
      if (typeof fn["name"] === "string" && fn["name"]) acc.name = fn["name"] as string;
      if (typeof fn["arguments"] === "string") acc.args += fn["arguments"] as string;
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      handleEvent(line.slice(5).trim());
    }
  }
  const tail = buffer.replace(/\r$/, "");
  if (tail.startsWith("data:")) handleEvent(tail.slice(5).trim());

  const sorted = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, acc] of sorted) {
    if (!acc.name) continue;
    toolCalls.push({ id: acc.id || `call_${randomUUID().slice(0, 8)}`, name: acc.name, arguments: acc.args || "{}" });
  }
  return { text, reasoning, toolCalls };
}

// -- Anthropic messages wire (non-streaming) ---------------------------------

function anthropicMessages(llm: ResolvedModel, messages: ChatMsg[]): { system: string; msgs: Dict[] } {
  let system = "";
  const msgs: Dict[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + String(m.content ?? "");
      continue;
    }
    if (m.role === "tool") {
      // Anthropic tool_result blocks ride in a user message.
      const block = { type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: String(m.content ?? "") };
      const last = msgs[msgs.length - 1];
      if (last && last["role"] === "user" && Array.isArray(last["content"])) {
        (last["content"] as Dict[]).push(block);
      } else {
        msgs.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const content: Dict[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      msgs.push({ role: "assistant", content });
      continue;
    }
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") });
  }
  return { system, msgs };
}

async function anthropicChat(
  llm: ResolvedModel,
  messages: ChatMsg[],
  opts: { tools?: ToolSpec[]; maxTokens: number; temperature: number; onDelta?: (d: string) => void },
): Promise<ChatOutcome> {
  const { system, msgs } = anthropicMessages(llm, messages);
  const body: Dict = {
    model: llm.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    messages: msgs,
  };
  if (system) body.system = system;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (llm.api_key) headers["x-api-key"] = llm.api_key;
  const response = await fetch(_endpoint(llm.base_url, "messages"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    throw new Error(`${llm.model} rejected the request (${response.status}): ${detail}`);
  }
  const event = (await response.json()) as Dict;
  const content = Array.isArray(event["content"]) ? (event["content"] as Dict[]) : [];
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (block["type"] === "text") text += String(block["text"] ?? "");
    if (block["type"] === "tool_use") {
      toolCalls.push({
        id: String(block["id"] ?? `toolu_${randomUUID().slice(0, 8)}`),
        name: String(block["name"] ?? ""),
        arguments: JSON.stringify(block["input"] ?? {}),
      });
    }
  }
  if (text) opts.onDelta?.(text);
  return { text, reasoning: "", toolCalls };
}

// -- OpenAI Responses wire (non-streaming, best-effort tool calling) ----------

function responsesInput(messages: ChatMsg[]): { instructions: string; input: Dict[] } {
  let instructions = "";
  const input: Dict[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      instructions += (instructions ? "\n\n" : "") + String(m.content ?? "");
      continue;
    }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id ?? "", output: String(m.content ?? "") });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      if (m.content) {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      }
      for (const tc of m.tool_calls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || "{}",
        });
      }
      continue;
    }
    if (m.role === "assistant") {
      input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: String(m.content ?? "") }] });
      continue;
    }
    input.push({ role: "user", content: [{ type: "input_text", text: String(m.content ?? "") }] });
  }
  return { instructions, input };
}

async function responsesChat(
  llm: ResolvedModel,
  messages: ChatMsg[],
  opts: { tools?: ToolSpec[]; maxTokens: number; temperature: number; onDelta?: (d: string) => void },
): Promise<ChatOutcome> {
  const { instructions, input } = responsesInput(messages);
  const body: Dict = {
    model: llm.model,
    input,
    max_output_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };
  if (instructions) body.instructions = instructions;
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    body.tool_choice = "auto";
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (llm.api_key) headers["Authorization"] = `Bearer ${llm.api_key}`;
  const response = await fetch(_endpoint(llm.base_url, "responses"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    throw new Error(`${llm.model} rejected the request (${response.status}): ${detail}`);
  }
  const event = (await response.json()) as Dict;
  const output = Array.isArray(event["output"]) ? (event["output"] as Dict[]) : [];
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const item of output) {
    if (item["type"] === "function_call") {
      toolCalls.push({
        id: String(item["call_id"] ?? `call_${randomUUID().slice(0, 8)}`),
        name: String(item["name"] ?? ""),
        arguments: String(item["arguments"] ?? "{}"),
      });
      continue;
    }
    if (item["type"] === "message") {
      const content = Array.isArray(item["content"]) ? (item["content"] as Dict[]) : [];
      for (const part of content) {
        if (part["type"] === "output_text" || part["type"] === "text") {
          text += String(part["text"] ?? "");
        }
      }
    }
  }
  if (text) opts.onDelta?.(text);
  return { text, reasoning: "", toolCalls };
}

async function chatCall(
  llm: ResolvedModel,
  messages: ChatMsg[],
  opts: {
    tools?: ToolSpec[];
    maxTokens: number;
    temperature?: number;
    stream?: boolean;
    onDelta?: (delta: string) => void;
  },
): Promise<ChatOutcome> {
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  if (llm.provider === "anthropic") {
    return anthropicChat(llm, messages, { tools: opts.tools, maxTokens: opts.maxTokens, temperature, onDelta: opts.stream ? opts.onDelta : undefined });
  }
  if (llm.provider === "openai-responses") {
    return responsesChat(llm, messages, { tools: opts.tools, maxTokens: opts.maxTokens, temperature, onDelta: opts.stream ? opts.onDelta : undefined });
  }
  return openAiChat(llm, messages, {
    tools: opts.tools,
    maxTokens: opts.maxTokens,
    temperature,
    onDelta: opts.stream ? opts.onDelta : undefined,
  });
}

// ---------------------------------------------------------------------------
// Tools — the mounted surface for the quiz loops
// ---------------------------------------------------------------------------

interface MountedTool {
  spec: ToolSpec;
  exec: (args: Dict) => Promise<ToolResult>;
}

function _str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function buildMountedTools(kbName: string | null, settings: Settings): MountedTool[] {
  const tools: MountedTool[] = [];

  if (kbName) {
    tools.push({
      spec: {
        name: "knowledge_base_search",
        description:
          "Search the learner's knowledge bases: retrieve relevant passages, " +
          "list indexed documents, or read one document's full text.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["search", "files", "read"], default: "search" },
            query: { type: "string", default: "" },
            knowledge_bases: { type: "string", default: kbName },
            top_k: { type: "integer", default: 5 },
            kb_name: { type: "string", default: "" },
            doc: { type: "string", default: "" },
          },
          required: [],
          additionalProperties: false,
        },
      },
      exec: async (args) => {
        const a: Dict = { ...args };
        if (!_str(a["knowledge_bases"]).trim()) a["knowledge_bases"] = kbName;
        if (a["action"] === "read" && !_str(a["kb_name"]).trim()) a["kb_name"] = kbName;
        return knowledge_base_search.execute(a as never);
      },
    });
  }

  // question_bank mounts when the learner already has entries (upstream's
  // has_question_bank flag).
  const bank = get_state<unknown>(settings, "question_bank", []) ?? [];
  if (Array.isArray(bank) && bank.length) {
    tools.push({
      spec: {
        name: "question_bank",
        description:
          "Manage the learner's personal Q&A bank: save questions with answers, " +
          "list recent entries, or search by text.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "list", "search"] },
            question: { type: "string", default: "" },
            answer: { type: "string", default: "" },
            topic: { type: "string", default: "" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
      exec: (args) => question_bank.execute(args as never),
    });
  }

  tools.push({
    spec: {
      name: "memory",
      description:
        "Long-term memory about the learner: read stored facts (optionally " +
        "filtered by a substring query) or write a durable fact.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write"] },
          query: { type: "string", default: "" },
          fact: { type: "string", default: "" },
          category: { type: "string", default: "" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    exec: (args) => memory.execute(args as never),
  });

  tools.push({
    spec: {
      name: "web",
      description:
        "Web access: search the web (titles/URLs/snippets) or fetch a URL as " +
        "readable text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          mode: { type: "string", enum: ["search", "fetch"], default: "search" },
          max_results: { type: "integer", default: 8 },
          max_chars: { type: "integer", default: 40000 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    exec: (args) => web.execute(args as never),
  });

  tools.push({
    spec: {
      name: "paper_search",
      description: "Search arXiv for research papers; returns titles, authors, year, URL and abstract.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "integer", default: 5 },
          sort_by: { type: "string", enum: ["relevance", "date"], default: "relevance" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    exec: (args) => paper_search.execute(args as never),
  });

  return tools;
}

// ---------------------------------------------------------------------------
// QuestionPipeline
// ---------------------------------------------------------------------------

export interface QuestionPipelineOptions {
  language?: string;
  kb_name?: string | null;
  settings?: Settings;
  session_id?: string;
  turn_id?: string;
}

export interface QuestionRunParams {
  user_message: string;
  num_questions: number;
  difficulty?: string;
  question_types?: string[] | null;
  per_type_counts?: Record<string, number> | null;
  conversation_context?: string;
  quiz_history?: QuizHistoryEntry[];
  templates_override?: QuizTemplate[] | null;
  /** Extra keys merged into summary (e.g. mimic parse trace). */
  extra_summary?: Dict;
}

export interface QuestionRunResult {
  response: string;
  summary: {
    success: boolean;
    source: string;
    requested: number;
    template_count: number;
    completed: number;
    failed: number;
    templates: Dict[];
    results: Array<{ qa_pair: Dict; metadata: Dict }>;
    analysis: string;
  };
  mode: string;
}

export class QuestionPipeline {
  readonly language: string;
  readonly kbName: string | null;
  private readonly _settings: Settings;
  private readonly _prompts;
  private readonly _llm: ResolvedModel;
  private readonly _sessionId: string;
  private readonly _turnId: string;

  constructor(opts: QuestionPipelineOptions = {}) {
    this.language = String(opts.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
    this.kbName = (opts.kb_name ?? "").trim() || null;
    this._settings = opts.settings ?? get_settings();
    this._prompts = questionPrompts(this.language);
    this._llm = resolveModelFor(this._settings);
    this._sessionId = opts.session_id ?? "";
    this._turnId = opts.turn_id ?? "";
  }

  private _t(key: string, vars: Record<string, unknown> = {}, fallback = ""): string {
    const raw = this._prompts[key];
    if (typeof raw !== "string" || !raw) return fallback;
    return vars && Object.keys(vars).length ? fmt(raw, vars) : raw;
  }

  // -- public entry ---------------------------------------------------------

  async run(
    stream: QuestionStream,
    params: QuestionRunParams,
  ): Promise<QuestionRunResult> {
    const requested = Math.max(1, Math.trunc(Number(params.num_questions) || 1));
    const difficulty = String(params.difficulty ?? "").trim().toLowerCase();
    const allowedTypes = normalizeTypeList(params.question_types);
    const perTypeCounts = normalizePerTypeCounts(params.per_type_counts, allowedTypes);
    const isMimic = Array.isArray(params.templates_override) && params.templates_override.length > 0;

    let finishText = "";
    let explorationTrace = "";
    let plan: QuizPlan = { analysis: "", templates: [] };

    if (isMimic) {
      explorationTrace = this._t("empty.no_exploration_trace");
      plan = { analysis: "", templates: [...(params.templates_override ?? [])] };
    } else {
      await stream.stage(STAGE_EXPLORING, async () => {
        [finishText, explorationTrace] = await this._explore(stream, params, {
          numQuestions: requested,
          difficulty,
          allowedTypes,
          perTypeCounts,
        });
      });
      await stream.stage(STAGE_PLANNING, async () => {
        plan = await this._plan(stream, params, {
          explorationTrace,
          numQuestions: requested,
          difficulty,
          allowedTypes,
          perTypeCounts,
        });
      });
    }

    const qaPairs: QuizPair[] = [];
    await stream.stage(STAGE_QUIZZING, async () => {
      for (let index = 0; index < plan.templates.length; index++) {
        const template = plan.templates[index];
        const qaPair = await this._quizOne(stream, template, {
          questionNumber: index + 1,
          totalQuestions: plan.templates.length,
          explorationTrace,
          plan,
          previousPairs: qaPairs,
        });
        await this._emitQuizQuestion(stream, qaPair, index, plan.templates.length);
        qaPairs.push(qaPair);
      }
    });

    const payload = this._buildResultPayload(plan, qaPairs, { isMimic, finishText });
    if (params.extra_summary) Object.assign(payload.summary, params.extra_summary);
    await stream.result(payload as unknown as Dict);
    return payload as unknown as QuestionRunResult;
  }

  // -- Phase 1: Explore ------------------------------------------------------

  private async _explore(
    stream: QuestionStream,
    params: QuestionRunParams,
    opts: {
      numQuestions: number;
      difficulty: string;
      allowedTypes: string[];
      perTypeCounts: Record<string, number>;
    },
  ): Promise<[string, string]> {
    const tools = buildMountedTools(this.kbName, this._settings);
    const toolSpecs = tools.map((t) => t.spec);
    const systemPrompt = this._t("explore.system", {
      num_questions: opts.numQuestions,
      kb_note: this._kbSystemNote(),
      tool_list: this._toolListText(tools),
    });
    const userPrompt = this._t("explore.user_template", {
      user_message: params.user_message,
      num_questions: opts.numQuestions,
      allowed_types: formatAllowedTypes(opts.allowedTypes),
      per_type_counts: formatPerTypeCounts(opts.perTypeCounts),
      difficulty: opts.difficulty || "auto",
      attachments_summary: this._t("empty.no_attachments"),
      conversation_context: (params.conversation_context ?? "").trim() || this._t("empty.no_conversation"),
      quiz_history: this._renderQuizHistory(params.quiz_history ?? []),
    });
    const messages: ChatMsg[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const initialCount = messages.length;

    const outcome = await this._runLabeledLoop(stream, {
      messages,
      stage: STAGE_EXPLORING,
      protocol: { think: true, tool: true, finish: true },
      maxIterations: DEFAULT_MAX_EXPLORE_ITERATIONS,
      tools: toolSpecs,
      mountedTools: tools,
      tracePrefix: "quiz-explore-iter",
      traceGroup: "stage",
      traceRole: "thought",
      callKind: "llm_reasoning",
      streamBodyLive: true,
      summarizer: true,
      maxTokens: BUDGETS.answering.max_tokens,
    });

    const finishText = (outcome.finalText ?? "").trim();
    const explorationTrace = this._renderExplorationTrace(
      outcome.messages.slice(initialCount),
      finishText,
    );
    return [finishText, explorationTrace];
  }

  // -- Phase 2: Plan ---------------------------------------------------------

  private async _plan(
    stream: QuestionStream,
    params: QuestionRunParams,
    opts: {
      explorationTrace: string;
      numQuestions: number;
      difficulty: string;
      allowedTypes: string[];
      perTypeCounts: Record<string, number>;
    },
  ): Promise<QuizPlan> {
    const systemPrompt = this._t("plan.system", { num_questions: opts.numQuestions });
    const userPrompt = this._t("plan.user_template", {
      exploration_trace: opts.explorationTrace || this._t("empty.no_exploration_trace"),
      user_message: params.user_message,
      num_questions: opts.numQuestions,
      allowed_types: formatAllowedTypes(opts.allowedTypes),
      per_type_counts: formatPerTypeCounts(opts.perTypeCounts),
      difficulty: opts.difficulty || "auto",
    });
    const messages: ChatMsg[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const iterMeta = this._simpleTraceMeta({
      call_id_root: "quiz-plan",
      label: this._t("labels.plan", {}, "Plan"),
      stage: STAGE_PLANNING,
      call_kind: "llm_planning",
      trace_role: "plan",
      trace_group: "plan",
    });
    const step = await this._runLabeledStep(stream, {
      messages,
      stage: STAGE_PLANNING,
      iterMeta,
      maxTokens: BUDGETS.planning.max_tokens,
      allowed: [LABEL_PLAN],
      finalLabels: [],
      toolLabel: null,
    });

    const plan = this._parsePlan(step.text, {
      requested: opts.numQuestions,
      allowedTypes: opts.allowedTypes,
      targetDifficulty: opts.difficulty,
    });
    if (!plan.templates.length) {
      throw new Error(this._t("notices.plan_unusable"));
    }
    if (plan.templates.length < opts.numQuestions) {
      await stream.progress(this._t("notices.plan_count_mismatch", {
        got: plan.templates.length,
        requested: opts.numQuestions,
      }), { stage: STAGE_PLANNING, metadata: { trace_kind: "warning" } });
    }
    return plan;
  }

  // -- Phase 3: one question --------------------------------------------------

  private async _quizOne(
    stream: QuestionStream,
    template: QuizTemplate,
    opts: {
      questionNumber: number;
      totalQuestions: number;
      explorationTrace: string;
      plan: QuizPlan;
      previousPairs: QuizPair[];
    },
  ): Promise<QuizPair> {
    const tools = buildMountedTools(this.kbName, this._settings);
    const systemPrompt = this._t("quiz_step.system", {
      question_number: opts.questionNumber,
      total_questions: opts.totalQuestions,
      kb_note: this._kbSystemNote(),
      tool_list: this._toolListText(tools),
    });
    const userPrompt = this._t("quiz_step.user_template", {
      question_id: template.question_id,
      topic: template.topic,
      question_type: template.question_type,
      difficulty: template.difficulty,
      exploration_trace: opts.explorationTrace || this._t("empty.no_exploration_trace"),
      plan_summary: this._renderPlanSummary(opts.plan),
      previous_questions: this._renderPreviousQuestions(opts.previousPairs),
      reference_block: this._renderReferenceBlock(template),
    });
    const messages: ChatMsg[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const outcome = await this._runLabeledLoop(stream, {
      messages,
      stage: STAGE_QUIZZING,
      protocol: { think: true, tool: true, finish: true },
      maxIterations: DEFAULT_MAX_QUIZ_ITERATIONS_PER_QUESTION,
      tools: tools.map((t) => t.spec),
      mountedTools: tools,
      tracePrefix: `quiz-${template.question_id}-iter`,
      traceGroup: TRACE_GROUP_QUIZ,
      traceRole: "thought",
      callKind: "llm_reasoning",
      streamBodyLive: false,
      summarizer: false,
      maxTokens: BUDGETS.quiz_finish.max_tokens,
      questionId: template.question_id,
    });

    let payload = this._parseQuizPayload(outcome.finalText);
    let normalized = this._normalizeQuizPayload(template, payload);
    let issues = this._collectQuizIssues(template, normalized);
    if (issues.length) {
      await stream.progress(this._t("notices.repair_attempted"), {
        stage: STAGE_QUIZZING,
        metadata: { trace_kind: "warning" },
      });
      const repaired = await this._repairQuizPayload(stream, template, normalized, issues);
      if (repaired) {
        normalized = this._normalizeQuizPayload(template, repaired);
        issues = this._collectQuizIssues(template, normalized);
      }
      if (issues.length) {
        await stream.progress(this._t("notices.repair_failed"), {
          stage: STAGE_QUIZZING,
          metadata: { trace_kind: "warning" },
        });
      }
    }
    return this._payloadToQaPair(template, normalized, issues);
  }

  private async _repairQuizPayload(
    stream: QuestionStream,
    template: QuizTemplate,
    payload: Dict,
    issues: string[],
  ): Promise<Dict | null> {
    const systemPrompt = this._t("repair.system");
    const userPrompt = this._t("repair.user_template", {
      question_id: template.question_id,
      topic: template.topic,
      question_type: template.question_type,
      difficulty: template.difficulty,
      invalid_payload: JSON.stringify(payload, null, 2),
      issues: JSON.stringify(issues),
    });
    const messages: ChatMsg[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const iterMeta = this._simpleTraceMeta({
      call_id_root: `quiz-repair-${template.question_id}`,
      label: this._t("labels.repair", {}, "Repair question format"),
      stage: STAGE_QUIZZING,
      call_kind: "llm_reasoning",
      trace_role: "thought",
      trace_group: TRACE_GROUP_QUIZ,
      question_id: template.question_id,
    });
    const step = await this._runLabeledStep(stream, {
      messages,
      stage: STAGE_QUIZZING,
      iterMeta,
      maxTokens: BUDGETS.repair.max_tokens,
      allowed: [LABEL_FINISH],
      finalLabels: [LABEL_FINISH],
      toolLabel: null,
    });
    return this._parseQuizPayload(step.text);
  }

  // -- labeled single step (plan / repair) ------------------------------------

  private _simpleTraceMeta(opts: {
    call_id_root: string;
    label: string;
    stage: string;
    call_kind?: string;
    trace_role?: string;
    trace_group?: string;
    [k: string]: unknown;
  }): Dict {
    const callId = newCallId(opts.call_id_root);
    const { call_id_root: _root, label, stage, call_kind, trace_role, trace_group, ...extra } = opts;
    void _root;
    return traceMeta({
      call_id: callId,
      phase: stage,
      label,
      call_kind: call_kind ?? "llm_reasoning",
      trace_id: callId,
      trace_role: trace_role ?? "thought",
      trace_group: trace_group ?? "stage",
      ...extra,
    });
  }

  private async _runLabeledStep(
    stream: QuestionStream,
    opts: {
      messages: ChatMsg[];
      stage: string;
      iterMeta: Dict;
      maxTokens: number;
      allowed: string[];
      finalLabels: string[];
      toolLabel: string | null;
      tools?: ToolSpec[];
      onDelta?: (d: string) => void;
    },
  ): Promise<{ text: string; label: string; reasoning: string }> {
    const outcome = await chatCall(this._llm, opts.messages, {
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      stream: true,
      onDelta: opts.onDelta,
    });
    const parsed = parseProtocolReply(outcome.text);
    // Stream the body into the trace as thinking chunks (upstream streams
    // deltas live; we emit the assembled body once the call returns).
    if (parsed.body.trim()) {
      await stream.thinking(parsed.body, {
        stage: opts.stage,
        metadata: { ...opts.iterMeta, trace_kind: "llm_chunk" },
      });
    }
    return { text: parsed.body, label: parsed.label, reasoning: outcome.reasoning };
  }

  // -- agentic labeled loop (explore / quiz) ----------------------------------

  private async _runLabeledLoop(
    stream: QuestionStream,
    opts: {
      messages: ChatMsg[];
      stage: string;
      protocol: { think: boolean; tool: boolean; finish: boolean };
      maxIterations: number;
      tools: ToolSpec[];
      mountedTools: MountedTool[];
      tracePrefix: string;
      traceGroup: string;
      traceRole: string;
      callKind: string;
      streamBodyLive: boolean;
      summarizer: boolean;
      maxTokens: number;
      questionId?: string;
    },
  ): Promise<{ finalText: string; messages: ChatMsg[] }> {
    const messages = opts.messages;
    let finalText = "";
    let finished = false;
    let forcedFinishAppended = false;

    for (let iteration = 1; iteration <= opts.maxIterations; iteration++) {
      const isLast = iteration === opts.maxIterations;
      if (isLast && !forcedFinishAppended) {
        messages.push({ role: "user", content: this._t("protocol.force_finish") });
        forcedFinishAppended = true;
      }

      const iterCallId = newCallId(`${opts.tracePrefix}-${iteration}`);
      const iterMeta = traceMeta({
        call_id: iterCallId,
        phase: opts.stage,
        label: this._t("labels.reasoning", {}, "Reasoning"),
        call_kind: opts.callKind,
        trace_id: iterCallId,
        trace_role: opts.traceRole,
        trace_group: opts.traceGroup,
        ...(opts.questionId ? { question_id: opts.questionId } : {}),
      });

      // Live deltas stream into the thinking trace.
      let pendingDelta = "";
      const flushDelta = async () => {
        if (!pendingDelta) return;
        const chunk = pendingDelta;
        pendingDelta = "";
        await stream.thinking(chunk, {
          stage: opts.stage,
          metadata: { ...iterMeta, trace_kind: "llm_chunk" },
        });
      };

      let outcome: ChatOutcome;
      try {
        outcome = await chatCall(this._llm, messages, {
          tools: opts.tools.length ? opts.tools : undefined,
          maxTokens: opts.maxTokens,
          stream: true,
          onDelta: (d) => {
            pendingDelta += d;
            if (pendingDelta.length > 400) void flushDelta();
          },
        });
      } finally {
        await flushDelta();
      }

      const parsed = parseProtocolReply(outcome.text);
      const label = parsed.label;
      const body = parsed.body;
      const toolCalls = outcome.toolCalls;

      // Protocol validation (upstream LabelProtocol rules).
      let violation: string | null = null;
      if (!label) violation = "missing_label";
      else if (label === LABEL_TOOL && !toolCalls.length) violation = "tool_without_calls";
      else if ((label === LABEL_THINK || label === LABEL_FINISH) && toolCalls.length) {
        violation = label === LABEL_THINK ? "think_with_tools" : "finish_with_tools";
      } else if (toolCalls.length && label !== LABEL_TOOL && opts.protocol.tool) {
        violation = "label_with_tools";
      }

      if (violation) {
        await stream.progress(this._t("notices.protocol_retry"), {
          stage: opts.stage,
          metadata: { trace_kind: "warning" },
        });
        messages.push({
          role: "assistant",
          content: outcome.text || null,
          ...(outcome.reasoning ? { reasoning_content: outcome.reasoning } : {}),
        });
        messages.push({ role: "user", content: this._t(`protocol.${violation}`) });
        continue;
      }

      if (label === LABEL_FINISH) {
        finalText = body;
        finished = true;
        // Explore streams the FINISH body live into the chat bubble.
        if (opts.streamBodyLive && body.trim()) {
          const finalCallId = newCallId(`${opts.tracePrefix}-final`);
          await stream.content(body, {
            stage: opts.stage,
            metadata: traceMeta({
              call_id: finalCallId,
              phase: opts.stage,
              label: this._t("labels.explore", {}, "Explore"),
              call_kind: "llm_final_response",
              trace_id: finalCallId,
              trace_role: "response",
              trace_group: "stage",
              trace_kind: "llm_output",
            }),
          });
        }
        break;
      }

      // THINK or TOOL — keep the loop alive.
      messages.push({
        role: "assistant",
        content: outcome.text || null,
        ...(outcome.reasoning ? { reasoning_content: outcome.reasoning } : {}),
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments || "{}" },
              })),
            }
          : {}),
      });

      if (toolCalls.length) {
        const toolMessages = await this._dispatchTools(stream, {
          stage: opts.stage,
          iteration,
          toolCalls,
          mountedTools: opts.mountedTools,
          tracePrefix: opts.tracePrefix,
          traceGroup: opts.traceGroup,
          summarizer: opts.summarizer,
        });
        messages.push(...toolMessages);
      }
    }

    if (!finished) {
      // Max-iteration recovery: force a FINISH-only step.
      await stream.progress(this._t("notices.max_iterations_reached"), {
        stage: opts.stage,
        metadata: { trace_kind: "warning" },
      });
      const forced = await this._forceFinish(stream, {
        messages,
        stage: opts.stage,
        tracePrefix: opts.tracePrefix,
        traceGroup: opts.traceGroup,
        traceRole: opts.traceRole,
        streamBodyLive: opts.streamBodyLive,
      });
      finalText = forced.text;
      if (opts.streamBodyLive && forced.text.trim() && forced.ok) {
        const finalCallId = newCallId(`${opts.tracePrefix}-force-final`);
        await stream.content(forced.text, {
          stage: opts.stage,
          metadata: traceMeta({
            call_id: finalCallId,
            phase: opts.stage,
            label: this._t("labels.explore", {}, "Explore"),
            call_kind: "llm_final_response",
            trace_id: finalCallId,
            trace_role: "response",
            trace_group: "stage",
            trace_kind: "llm_output",
          }),
        });
      }
    }

    return { finalText, messages };
  }

  private async _forceFinish(
    stream: QuestionStream,
    opts: {
      messages: ChatMsg[];
      stage: string;
      tracePrefix: string;
      traceGroup: string;
      traceRole: string;
      streamBodyLive: boolean;
    },
  ): Promise<{ text: string; ok: boolean }> {
    const messages = opts.messages;
    messages.push({ role: "user", content: this._t("protocol.force_finish") });
    for (let attempt = 0; attempt < FINALIZATION_REPAIR_ATTEMPTS; attempt++) {
      const iterMeta = this._simpleTraceMeta({
        call_id_root: `${opts.tracePrefix}-force-${attempt}`,
        label: this._t("labels.reasoning", {}, "Reasoning"),
        stage: opts.stage,
        call_kind: "llm_reasoning",
        trace_role: opts.traceRole,
        trace_group: opts.traceGroup,
      });
      const step = await this._runLabeledStep(stream, {
        messages,
        stage: opts.stage,
        iterMeta,
        maxTokens: BUDGETS.answering.max_tokens,
        allowed: [LABEL_FINISH],
        finalLabels: [LABEL_FINISH],
        toolLabel: null,
      });
      const parsed = parseProtocolReply(step.text);
      if (parsed.label === LABEL_FINISH) {
        return { text: parsed.body, ok: true };
      }
      messages.push({ role: "assistant", content: step.text.slice(0, 500) || null });
      messages.push({ role: "user", content: this._t("protocol.force_finish_repair") });
    }
    return { text: this._t("protocol.fallback_final"), ok: false };
  }

  // -- tool dispatch -----------------------------------------------------------

  private async _dispatchTools(
    stream: QuestionStream,
    opts: {
      stage: string;
      iteration: number;
      toolCalls: ToolCall[];
      mountedTools: MountedTool[];
      tracePrefix: string;
      traceGroup: string;
      summarizer: boolean;
    },
  ): Promise<ChatMsg[]> {
    const byName = new Map(opts.mountedTools.map((t) => [t.spec.name, t]));
    const executable = opts.toolCalls.slice(0, MAX_PARALLEL_TOOL_CALLS);
    const skipped = opts.toolCalls.slice(MAX_PARALLEL_TOOL_CALLS);
    if (skipped.length) {
      await stream.progress(
        this._t("notices.too_many_tool_calls", { requested: opts.toolCalls.length, limit: MAX_PARALLEL_TOOL_CALLS }),
        { stage: opts.stage, metadata: { trace_kind: "warning" } },
      );
    }

    const results = await Promise.all(
      [...executable, ...skipped].map(async (tc, i) => {
        const isSkipped = i >= executable.length;
        const meta = traceMeta({
          call_id: newCallId(`${opts.tracePrefix}-${opts.iteration}-tool-${i}`),
          phase: opts.stage,
          label: this._t("labels.tool_call", {}, "Tool call"),
          call_kind: "tool_planning",
          trace_id: newCallId(`${opts.tracePrefix}-${opts.iteration}-tool-${i}`),
          trace_role: "tool",
          trace_group: "tool_call",
          tool: tc.name,
          iteration: opts.iteration,
        });
        await stream.toolCall(tc.name, safeJsonParse(tc.arguments), {
          stage: opts.stage,
          metadata: meta,
        });
        let text: string;
        let success = true;
        if (isSkipped) {
          text = "Skipped: the per-round tool-call limit was reached. Retry this call in a later round if still needed.";
          success = false;
        } else {
          const mounted = byName.get(tc.name);
          if (!mounted) {
            text = `Unknown tool: ${tc.name}`;
            success = false;
          } else {
            try {
              const args = safeJsonParse(tc.arguments);
              const out = await mounted.exec(args);
              text = String(out.result ?? "");
              success = Boolean(out.success);
            } catch (e) {
              text = `${tc.name} failed: ${e instanceof Error ? e.message : String(e)}`;
              success = false;
            }
          }
        }
        if (!text.trim()) text = this._t("notices.empty_tool_result");
        await stream.toolResult(tc.name, text, {
          stage: opts.stage,
          metadata: { ...meta, trace_kind: "tool_result" },
        });
        return { tc, text, success };
      }),
    );

    // Explore phase: compress each tool result via the summarizer so the
    // exploration trace stays tight (upstream tool_summarizer).
    const out: ChatMsg[] = [];
    for (const { tc, text } of results) {
      let content = text;
      if (opts.summarizer && text.trim()) {
        const summary = await this._summarizeToolResult(stream, {
          toolName: tc.name,
          toolResult: text,
          iteration: opts.iteration,
        });
        if (summary) content = summary;
      }
      out.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.name,
        content,
      });
    }
    return out;
  }

  private async _summarizeToolResult(
    stream: QuestionStream,
    opts: { toolName: string; toolResult: string; iteration: number },
  ): Promise<string | null> {
    const text = (opts.toolResult ?? "").trim();
    if (!text) return null;
    const callId = newCallId(`quiz-reflect-iter-${opts.iteration}-${opts.toolName || "tool"}`);
    const meta = traceMeta({
      call_id: callId,
      phase: STAGE_EXPLORING,
      label: this._t("labels.reflecting", {}, "Reflecting"),
      call_kind: "tool_result_reflection",
      trace_id: callId,
      trace_role: "reflection",
      trace_group: "reflection",
      tool: opts.toolName,
      iteration: opts.iteration,
    });
    await stream.progress(this._t("labels.reflecting", {}, "Reflecting"), {
      stage: STAGE_EXPLORING,
      metadata: { ...meta, trace_kind: "call_status", call_state: "running" },
    });
    try {
      const chunks: string[] = [];
      // completeText-equivalent: non-streaming accumulation via chatCall.
      const outcome = await chatCall(this._llm, [
        { role: "system", content: this._t("tool_summarizer.system") },
        { role: "user", content: this._t("tool_summarizer.user_template", { tool_result: text }) },
      ], { maxTokens: BUDGETS.tool_summarizer.max_tokens, temperature: TOOL_SUMMARIZER_TEMPERATURE });
      chunks.push(outcome.text);
      const summary = chunks.join("").trim();
      return summary || null;
    } catch (e) {
      await stream.progress(
        this._t("notices.tool_summarizer_failed", { error: e instanceof Error ? e.message : String(e) }),
        { stage: STAGE_EXPLORING, metadata: { ...meta, trace_kind: "warning", call_state: "error" } },
      );
      return null;
    } finally {
      await stream.progress("", {
        stage: STAGE_EXPLORING,
        metadata: { ...meta, trace_kind: "call_status", call_state: "complete" },
      });
    }
  }

  // -- rendering helpers --------------------------------------------------------

  private _renderExplorationTrace(loopMessages: ChatMsg[], finishText: string): string {
    if (!loopMessages.length && !finishText) return this._t("empty.no_exploration_trace");
    const blocks: string[] = [];
    let iteration = 0;
    const toolCallNames = new Map<string, string>();
    for (const message of loopMessages) {
      const role = message.role;
      const content = String(message.content ?? "").trim();
      if (role === "assistant") {
        if (message.tool_calls?.length) {
          iteration += 1;
          for (const tc of message.tool_calls) {
            const name = tc.function.name || "tool";
            if (tc.id) toolCallNames.set(tc.id, name);
            let argsDisplay = tc.function.arguments || "{}";
            try {
              argsDisplay = JSON.stringify(JSON.parse(argsDisplay), null, 2);
            } catch { /* keep raw */ }
            const header = this._t("trace.iteration_tool_call", { n: iteration, tool: name });
            const parts: string[] = [];
            if (content) parts.push(content);
            parts.push(`Arguments:\n\`\`\`json\n${argsDisplay}\n\`\`\``);
            blocks.push(`### ${header}\n\n${parts.join("\n\n")}`);
          }
          continue;
        }
        if (!content) continue;
        iteration += 1;
        const stripped = stripProtocolLabel(content);
        blocks.push(`### ${this._t("trace.iteration_thought", { n: iteration })}\n\n${stripped}`);
      } else if (role === "tool") {
        const name = toolCallNames.get(message.tool_call_id ?? "") || message.name || "tool";
        blocks.push(
          `### ${this._t("trace.iteration_tool_result", { n: iteration, tool: name })}\n\n${content || "(empty)"}`,
        );
      }
      // user-role protocol nudges are noise — skipped like upstream.
    }
    if (finishText) {
      blocks.push(`### ${this._t("trace.finish_note")}\n\n${finishText.trim()}`);
    }
    return blocks.length ? blocks.join("\n\n") : this._t("empty.no_exploration_trace");
  }

  private _renderQuizHistory(history: QuizHistoryEntry[]): string {
    if (!history.length) return this._t("empty.no_quiz_history");
    return history
      .map((entry) => {
        const label = this._correctnessLabel(entry.is_correct);
        return (
          `- (${entry.turn_id || "?"}) ${entry.question} [${entry.question_type || "?"}] — ${label}` +
          (entry.user_answer || entry.correct_answer
            ? ` — learner answer: ${entry.user_answer.slice(0, 80)}; reference: ${entry.correct_answer.slice(0, 80)}`
            : "")
        );
      })
      .join("\n");
  }

  private _correctnessLabel(isCorrect: boolean | null): string {
    if (isCorrect === true) return this.language === "zh" ? "做对" : "correct";
    if (isCorrect === false) return this.language === "zh" ? "做错" : "incorrect";
    return this.language === "zh" ? "未知" : "unknown";
  }

  private _renderPlanSummary(plan: QuizPlan): string {
    if (!plan.templates.length) return "(empty plan)";
    const lines: string[] = [];
    if (plan.analysis) lines.push(`Analysis: ${plan.analysis}`);
    for (const t of plan.templates) {
      lines.push(`  - [${t.question_id}] (${t.question_type}/${t.difficulty}) ${t.topic}`);
    }
    return lines.join("\n");
  }

  private _renderPreviousQuestions(qaPairs: QuizPair[]): string {
    if (!qaPairs.length) return this._t("empty.no_previous_questions");
    return qaPairs.map((qa, i) => `${i + 1}. ${qa.question}`).join("\n");
  }

  private _renderReferenceBlock(template: QuizTemplate): string {
    if ((template.source ?? "custom") !== "mimic") return this._t("empty.no_reference");
    const referenceQ = (template.reference_question ?? "").trim();
    const referenceA = (template.reference_answer ?? "").trim();
    if (!referenceQ && !referenceA) return this._t("empty.no_reference");
    const lines: string[] = [];
    if (referenceQ) lines.push(`Reference question:\n${referenceQ}`);
    if (referenceA) lines.push(`Reference answer:\n${referenceA}`);
    return lines.join("\n\n");
  }

  private _renderQuestionMarkdown(qa: QuizPair, ordinal: number): string {
    const header = this.language === "zh" ? "题目" : "Question";
    const lines = [`### ${header} ${ordinal}\n`, qa.question];
    if (qa.options && typeof qa.options === "object") {
      for (const key of CHOICE_KEYS) {
        if (key in qa.options) lines.push(`- ${key}. ${qa.options[key]}`);
      }
    }
    if (qa.correct_answer) {
      lines.push(`\n**${this.language === "zh" ? "答案" : "Answer"}:** ${qa.correct_answer}`);
    }
    if (qa.explanation) {
      lines.push(`\n**${this.language === "zh" ? "解析" : "Explanation"}:** ${qa.explanation}`);
    }
    return lines.join("\n").trim();
  }

  private _renderSummaryMarkdown(qaPairs: QuizPair[]): string {
    return qaPairs.map((qa, i) => this._renderQuestionMarkdown(qa, i + 1)).join("\n\n");
  }

  private _kbSystemNote(): string {
    if (!this.kbName) return "";
    if (this.language === "zh") {
      return `用户已挂载知识库：${this.kbName}。调用 knowledge_base_search 时，knowledge_bases 必须填这个名称。`;
    }
    return `Attached knowledge bases: ${this.kbName}. When calling knowledge_base_search, knowledge_bases must be ${JSON.stringify(this.kbName)}.`;
  }

  private _toolListText(tools: MountedTool[]): string {
    if (!tools.length) return this.language === "zh" ? "- 无" : "- none";
    return tools.map((t) => `- ${t.spec.name}: ${t.spec.description}`).join("\n");
  }

  private async _emitQuizQuestion(
    stream: QuestionStream,
    qa: QuizPair,
    index: number,
    total: number,
  ): Promise<void> {
    const meta = traceMeta({
      call_id: newCallId(`quiz-question-${index + 1}`),
      phase: STAGE_QUIZZING,
      label: `${this._t("labels.quiz_step", {}, "Question")} ${index + 1}`,
      call_kind: CALL_KIND_QUIZ_QUESTION,
      trace_id: qa.question_id,
      trace_role: TRACE_ROLE_QUIZ_QUESTION,
      trace_group: TRACE_GROUP_QUIZ,
      question_index: index,
      total_questions: total,
      qa_pair: qaPairToDict(qa),
      trace_kind: "llm_output",
    });
    await stream.content(this._renderQuestionMarkdown(qa, index + 1), {
      stage: STAGE_QUIZZING,
      metadata: meta,
    });
  }

  private _buildResultPayload(
    plan: QuizPlan,
    qaPairs: QuizPair[],
    opts: { isMimic: boolean; finishText: string },
  ): QuestionRunResult {
    const results = qaPairs.map((qa) => ({
      qa_pair: qaPairToDict(qa),
      metadata: { ...(qa.metadata ?? {}) },
    }));
    const successful = qaPairs.filter((qa) => !qa.metadata?.["issues"]).length;
    const markdown = this._renderSummaryMarkdown(qaPairs);
    const finishBlock = (opts.finishText ?? "").trim();
    const responseBody = finishBlock || markdown || "No questions generated.";
    return {
      response: responseBody,
      summary: {
        success: successful === qaPairs.length && qaPairs.length > 0,
        source: opts.isMimic ? "exam" : "topic",
        requested: plan.templates.length,
        template_count: plan.templates.length,
        completed: successful,
        failed: qaPairs.length - successful,
        templates: plan.templates.map(templateToDict),
        results,
        analysis: plan.analysis,
      },
      mode: opts.isMimic ? "mimic" : "custom",
    };
  }

  // -- quiz payload parsing / validation / normalization ----------------------

  private _parseQuizPayload(raw: string): Dict {
    const text = (raw ?? "").trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Dict;
    } catch { /* fall through */ }
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    if (fence) {
      const inner = firstJsonObject(fence[1].trim());
      if (inner) return inner;
    }
    return firstJsonObject(text);
  }

  private _parsePlan(
    raw: string,
    opts: { requested: number; allowedTypes: string[]; targetDifficulty: string },
  ): QuizPlan {
    const data = parseJsonLoose(raw);
    if (!data || typeof data !== "object") return { analysis: "", templates: [] };
    const analysis = String((data as Dict)["analysis"] ?? "") || "";
    const d = data as Dict;
    const rawItems = Array.isArray(d["templates"]) ? (d["templates"] as unknown[]) : Array.isArray(d["ideas"]) ? (d["ideas"] as unknown[]) : [];

    const allowedSet = opts.allowedTypes.length ? new Set(opts.allowedTypes) : VALID_QUESTION_TYPES;
    let fallbackType = "short_answer";
    if (!allowedSet.has(fallbackType)) {
      fallbackType = allowedSet.size ? [...allowedSet][0] : "written";
    }

    const templates: QuizTemplate[] = [];
    const seen = new Set<string>();
    for (const item of rawItems) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Dict;
      const topic = String(rec["topic"] ?? rec["concentration"] ?? "").trim();
      if (!topic || seen.has(topic.toLowerCase())) continue;
      seen.add(topic.toLowerCase());
      const qtypeRaw = String(rec["question_type"] ?? "").trim().toLowerCase();
      const qtype = allowedSet.has(qtypeRaw) ? qtypeRaw : fallbackType;
      const diffRaw = String(rec["difficulty"] ?? "").trim().toLowerCase();
      let diff = opts.targetDifficulty || diffRaw;
      if (!VALID_DIFFICULTIES.has(diff)) diff = "medium";
      templates.push({
        question_id: `q_${templates.length + 1}`,
        topic,
        question_type: qtype,
        difficulty: diff,
      });
      if (templates.length >= opts.requested) break;
    }
    return { analysis, templates };
  }

  private _normalizeQuizPayload(template: QuizTemplate, payload: Dict): Dict {
    const normalized: Dict = { ...(payload ?? {}) };
    const expectedType = template.question_type;
    normalized["question_type"] = expectedType;
    normalized["question"] = String(normalized["question"] ?? "").trim();
    normalized["correct_answer"] = String(normalized["correct_answer"] ?? "").trim();
    normalized["explanation"] = String(normalized["explanation"] ?? "").trim();

    const rawOptions = normalized["options"];
    if (expectedType === "choice") {
      const clean: Record<string, string> = {};
      if (rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)) {
        for (const [key, value] of Object.entries(rawOptions as Dict)) {
          const k = String(key ?? "").trim().toUpperCase().slice(0, 1);
          const v = String(value ?? "").trim();
          if ((CHOICE_KEYS as readonly string[]).includes(k) && v) clean[k] = v;
        }
      }
      normalized["options"] = Object.keys(clean).length ? clean : null;
      if (Object.keys(clean).length && normalized["correct_answer"]) {
        const ans = String(normalized["correct_answer"]).toUpperCase().trim();
        if (ans in clean) {
          normalized["correct_answer"] = ans;
        } else {
          for (const [key, value] of Object.entries(clean)) {
            if (String(normalized["correct_answer"]).toLowerCase() === value.toLowerCase()) {
              normalized["correct_answer"] = key;
              break;
            }
          }
        }
      }
    } else if (expectedType === "concept") {
      normalized["options"] = null;
      const rawAns = String(normalized["correct_answer"] ?? "").toLowerCase();
      if (["true", "t", "对", "正确", "yes", "y", "1"].includes(rawAns)) {
        normalized["correct_answer"] = "true";
      } else if (["false", "f", "错", "错误", "no", "n", "0"].includes(rawAns)) {
        normalized["correct_answer"] = "false";
      }
    } else {
      normalized["options"] = null;
    }
    return normalized;
  }

  private _collectQuizIssues(template: QuizTemplate, payload: Dict): string[] {
    const issues: string[] = [];
    const question = String(payload["question"] ?? "").trim();
    const correct = String(payload["correct_answer"] ?? "").trim();
    const explanation = String(payload["explanation"] ?? "").trim();
    const options = payload["options"];

    if (!question) issues.push("missing_question");
    if (!correct) issues.push("missing_correct_answer");
    if (!explanation) issues.push("missing_explanation");

    const qtype = template.question_type;
    const hasOptions = options && typeof options === "object" && !Array.isArray(options) && Object.keys(options as Dict).length > 0;
    if (qtype === "choice") {
      const keys = hasOptions ? Object.keys(options as Dict).sort() : [];
      if (!hasOptions || keys.join(",") !== [...CHOICE_KEYS].sort().join(",")) {
        issues.push("choice_options_must_be_a_to_d");
      }
      if (!CHOICE_KEYS.includes(correct.toUpperCase() as (typeof CHOICE_KEYS)[number])) {
        issues.push("choice_correct_answer_must_be_option_key");
      }
    } else if (qtype === "concept") {
      if (hasOptions) issues.push("concept_must_not_have_options");
      if (!CONCEPT_ANSWERS.has(correct.toLowerCase())) {
        issues.push("concept_correct_answer_must_be_true_or_false");
      }
    } else if (qtype === "fill_in_blank") {
      if (hasOptions) issues.push("fill_in_blank_must_not_have_options");
      if (question && !question.includes(FILL_IN_BLANK_TOKEN)) {
        issues.push("fill_in_blank_question_must_contain_blank_token");
      }
    } else {
      if (hasOptions) issues.push("non_choice_must_not_have_options");
      if (correct.length === 1 && CHOICE_KEYS.includes(correct.toUpperCase() as (typeof CHOICE_KEYS)[number])) {
        issues.push("non_choice_correct_answer_looks_like_option_key");
      }
    }
    return issues;
  }

  private _payloadToQaPair(template: QuizTemplate, payload: Dict, issues: string[]): QuizPair {
    let question = String(payload["question"] ?? "").trim();
    if (!question) question = `[Generation failed] ${template.topic}`;
    const options = payload["options"];
    return {
      question_id: template.question_id,
      question,
      question_type: template.question_type,
      correct_answer: String(payload["correct_answer"] ?? "").trim() || "N/A",
      explanation: String(payload["explanation"] ?? "").trim() || "N/A",
      options: options && typeof options === "object" && !Array.isArray(options) ? (options as Record<string, string>) : null,
      topic: template.topic,
      difficulty: template.difficulty,
      metadata: issues.length ? { issues } : {},
    };
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function normalizeTypeList(raw: string[] | null | undefined): string[] {
  if (!raw?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const v = String(item ?? "").trim().toLowerCase();
    if (VALID_QUESTION_TYPES.has(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function normalizePerTypeCounts(raw: Record<string, number> | null | undefined, allowed: string[]): Record<string, number> {
  if (!raw) return {};
  const accepted = allowed.length ? new Set(allowed) : VALID_QUESTION_TYPES;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = String(key ?? "").trim().toLowerCase();
    if (!accepted.has(k)) continue;
    const n = Math.trunc(Number(value));
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

function formatAllowedTypes(types: string[]): string {
  return types.length ? types.map((t) => `\`${t}\``).join(", ") : "any (planner picks per question)";
}

function formatPerTypeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([t, n]) => `${t}=${n}`).join(", ") : "no per-type targets (planner distributes freely)";
}

function safeJsonParse(text: string): Dict {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Dict) : {};
  } catch {
    return {};
  }
}

function parseJsonLoose(text: string): unknown {
  const t = (text ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch { /* fall through */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const candidate = fence ? fence[1].trim() : t;
  const start = candidate.indexOf("{");
  if (start === -1) return null;
  try {
    const end = findJsonEnd(candidate, start);
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function findJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}

function firstJsonObject(text: string): Dict {
  const parsed = parseJsonLoose(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Dict) : {};
}

/** Strip a leading ``THINK`` / ``TOOL`` / ``FINISH`` label (double-backtick
 *  wrapped, per the protocol) from a reply body for trace rendering. */
function stripProtocolLabel(text: string): string {
  const stripped = text.replace(/^\s+/, "");
  const m = /^``(THINK|TOOL|FINISH|PLAN)``\s*/.exec(stripped);
  if (m) return stripped.slice(m[0].length).replace(/^\n+/, "").replace(/^\s+/, "");
  const bare = /^(THINK|TOOL|FINISH|PLAN)\s*\n/.exec(stripped);
  if (bare) return stripped.slice(bare[0].length);
  return text;
}

/** Parse the first-line protocol label + body of a labeled reply. Accepts the
 *  mandated ``LABEL`` wrapper and (leniently) a bare uppercase label. */
export function parseProtocolReply(text: string): { label: string; body: string } {
  const raw = text ?? "";
  const firstLineEnd = raw.indexOf("\n");
  const firstLine = (firstLineEnd === -1 ? raw : raw.slice(0, firstLineEnd)).trim();
  const rest = firstLineEnd === -1 ? "" : raw.slice(firstLineEnd + 1);

  const wrapped = /^``(THINK|TOOL|FINISH|PLAN)``\s*$/.exec(firstLine);
  if (wrapped) return { label: wrapped[1], body: rest };
  const bare = /^(THINK|TOOL|FINISH|PLAN)\s*$/.exec(firstLine);
  if (bare) return { label: bare[1], body: rest };
  // Label may share the first line with body text (``FINISH`` some text).
  const inline = /^``(THINK|TOOL|FINISH|PLAN)``\s+(.+)$/.exec(firstLine);
  if (inline) return { label: inline[1], body: `${inline[2]}${firstLineEnd === -1 ? "" : `\n${rest}`}` };
  return { label: "", body: raw };
}

function qaPairToDict(qa: QuizPair): Dict {
  return {
    question_id: qa.question_id,
    question: qa.question,
    question_type: qa.question_type,
    options: qa.options,
    correct_answer: qa.correct_answer,
    explanation: qa.explanation,
    difficulty: qa.difficulty,
    concentration: qa.topic,
  };
}

function templateToDict(t: QuizTemplate): Dict {
  return {
    question_id: t.question_id,
    topic: t.topic,
    question_type: t.question_type,
    difficulty: t.difficulty,
    source: t.source ?? "custom",
    reference_question: t.reference_question ?? null,
    reference_answer: t.reference_answer ?? null,
  };
}

// ---------------------------------------------------------------------------
// Quiz history — question-notebook entries for a session (history.py port)
// ---------------------------------------------------------------------------

export function loadSessionQuizHistory(
  sessionId: string,
  settings?: Settings,
  maxEntries = 30,
): QuizHistoryEntry[] {
  if (!sessionId || maxEntries <= 0) return [];
  try {
    const s = settings ?? get_settings();
    // listEntries sorts by updated_at desc; we need the most recent `max`
    // then chronological order, matching upstream's (created_at, id) sort.
    const { items } = qn.listEntries({ limit: 200, sort: "recent" }, s);
    const rows = items
      .filter((e) => String(e.session_id ?? "") === sessionId)
      .sort((a, b) => {
        const ta = Number(a.created_at ?? a.updated_at ?? 0);
        const tb = Number(b.created_at ?? b.updated_at ?? 0);
        return tb - ta || Number(b.id ?? 0) - Number(a.id ?? 0);
      })
      .slice(0, maxEntries)
      .reverse();
    const entries: QuizHistoryEntry[] = [];
    for (const raw of rows) {
      const question = String(raw.question ?? "").trim();
      if (!question) continue;
      const userAnswer = String(raw.user_answer ?? "").trim();
      entries.push({
        question,
        question_type: String(raw.question_type ?? "").trim(),
        correct_answer: String(raw.correct_answer ?? "").trim(),
        user_answer: userAnswer,
        is_correct: userAnswer ? Boolean(raw.is_correct) : null,
        turn_id: String(raw.turn_id ?? "").trim(),
      });
    }
    return entries;
  } catch {
    return [];
  }
}
