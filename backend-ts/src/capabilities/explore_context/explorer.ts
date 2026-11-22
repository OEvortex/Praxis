// the agentic
// context investigator: a read-only pre-pass that runs before the answer
// loop's first LLM call, uses ``read_source`` to load the attached sources
// the user's request actually needs, then folds an objective, third-person
// investigation into the loop's user-message seed.
//
// TS port notes / TODOs:
//  - Upstream streams every LLM chunk into the thinking trace and replays
//    provider reasoning state between rounds. The TS port issues non-streaming
//    chat/completions calls (TODO(verify): wire streaming + thinking-channel
//    parity once the runtime exposes a tool-calling chat port).
//  - Only the OpenAI chat/completions wire is implemented for the agentic
//    loop; anthropic / openai-responses providers degrade to the single-pass
//    fallback (same as upstream's non-native-tool-calling path).
//  - ``usage`` is an optional duck-typed accumulator
//    (``add_estimated`` / ``add_from_response``), mirroring upstream.

import { get_settings, type Settings } from "../../config.js";
import { cleanThinkingTags, streamText, resolve as resolveModel } from "../../services/llm_text.js";
import { read_source, current_source_index } from "./read_source.js";
import { prompt_text } from "./prompts.js";
import type { Dict } from "../../shared/types.js";

export const EXPLORE_STAGE = "context_exploration";
export const EXPLORE_SOURCE = "chat";

const MAX_LOOP_ROUNDS = 5;
const PRELOAD_SOURCES_ENABLED = true;
const PRELOAD_MAX_SOURCES = 2;
const PRELOAD_MAX_CHARS = 120000;

// Single-pass fallback budgets.
const MAX_SOURCES = 12;
const CHARS_PER_SOURCE = 8000;
const TOTAL_CHARS = 48000;

// Upstream reads these from agents.yaml capabilities.explore_context; the TS
// port has no staged-params loader yet, so the shipped defaults are inline.
function _budgets(): { loop: { max_tokens: number }; briefing: { max_tokens: number } } {
  return { loop: { max_tokens: 2000 }, briefing: { max_tokens: 1400 } };
}

const KIND_BY_PREFIX: Record<string, [string]> = {
  "hs-": ["Conversation transcript"],
  "nb-": ["Notebook record"],
  "bk-": ["Book excerpt"],
  "rd-": ["Reading excerpt"],
  "qb-": ["Question-bank entry"],
  "at-": ["Document"],
};

const STREAM_IDLE_TIMEOUT_MS = 90_000;

function _isRecord(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function _str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function _chars(s: string): string[] {
  return [...s];
}
function _clipChars(s: string, n: number): string {
  return _chars(s).slice(0, Math.max(0, n)).join("");
}

/** Minimal stream surface the pre-pass writes to (thinking/progress trace). */
export interface ExploreStream {
  stage?: (name: string, opts?: Dict) => Promise<unknown> | unknown;
  progress?: (text: string, opts?: Dict) => Promise<unknown> | unknown;
  thinking?: (delta: string, opts?: Dict) => Promise<unknown> | unknown;
  emit?: (event: Dict) => Promise<unknown> | unknown;
}

export interface ExploreUsage {
  add_estimated?: (opts: { input_chars: number; output_chars: number }) => void;
  add_from_response?: (entry: Dict) => void;
}

export interface ExploreContext {
  session_id?: string;
  user_message?: string;
  source_manifest?: string;
  active_capability?: string;
  language?: string;
  metadata?: Dict | null;
}

interface ResolvedModel {
  provider: string;
  model: string;
  api_key: string;
  base_url: string;
}

function _resolve(settings: Settings): ResolvedModel {
  const r = resolveModel(settings, null) as Record<string, unknown>;
  return {
    provider: _str(r["provider"]),
    model: _str(r["model"]),
    api_key: r["api_key"] ? _str(r["api_key"]) : "",
    base_url: r["base_url"] ? _str(r["base_url"]) : "",
  };
}

// Providers whose wire protocol this port can drive with native tool calls.
// TODO(verify): anthropic / openai-responses tool-calling loops.
function _supports_tool_calling(provider: string): boolean {
  return provider !== "anthropic" && provider !== "openai-responses";
}

export class ContextExplorer {
  language: "en";
  private readonly _prompts: Record<string, unknown>;
  private readonly _settings: Settings;
  private readonly _llm: ResolvedModel;

  constructor(opts: { language: string; prompts: Record<string, unknown>; settings?: Settings }) {
    this.language = "en";
    this._prompts = opts.prompts || {};
    this._settings = opts.settings ?? get_settings();
    this._llm = _resolve(this._settings);
  }

  get model(): string {
    return this._llm.model;
  }

  /** Run the pre-pass and return the investigation wrapped in its header.
   * Returns "" when there is nothing to investigate or every path fails. */
  async investigate(
    context: ExploreContext,
    stream?: ExploreStream | null,
    usage?: ExploreUsage | null,
  ): Promise<string> {
    const sourceIndex = ContextExplorer._source_index(context);
    if (!sourceIndex || !Object.keys(sourceIndex).length) return "";

    let investigation = "";
    if (_supports_tool_calling(this._llm.provider)) {
      try {
        investigation = await this._run_loop(context, stream ?? null, sourceIndex, usage ?? null);
      } catch {
        investigation = "";
      }
    }
    // Non-native providers, or a failed/empty loop, degrade to the robust
    // dump-and-brief single pass so the answer loop is never left without
    // grounding.
    if (!investigation.trim()) {
      investigation = await this._single_pass(context, stream ?? null, sourceIndex, usage ?? null);
    }

    investigation = cleanThinkingTags(investigation).trim();
    if (!investigation) return "";
    return `${this._briefing_header()}\n\n${investigation}`.trim();
  }

  // ---- agentic loop ----------------------------------------------------

  private _t(key: string, fallback = ""): string {
    return prompt_text(this._prompts, key, fallback);
  }

  private async _run_loop(
    context: ExploreContext,
    stream: ExploreStream | null,
    sourceIndex: Record<string, string>,
    usage: ExploreUsage | null,
  ): Promise<string> {
    const systemPrompt = this._t("loop.system").replace(
      "{tool_call_limit}",
      String(MAX_PARALLEL_TOOL_CALLS),
    );
    const userTemplate = this._t("loop.user_template");
    if (!systemPrompt || !userTemplate) return "";

    const messages: Dict[] = [{ role: "system", content: systemPrompt }];
    const question = (context.user_message ?? "").trim() || "(empty)";
    const mode = String(context.active_capability || "chat");
    const manifest = (context.source_manifest ?? "").trim() || "(none)";
    const cacheShaped = this._cache_shaped_messages({
      source_index: sourceIndex,
      question,
      mode,
      manifest,
    });
    if (cacheShaped.length) {
      messages.push(...cacheShaped);
    } else {
      messages.push({
        role: "user",
        content: userTemplate
          .replace("{question}", question)
          .replace("{mode}", mode)
          .replace("{manifest}", manifest),
      });
    }
    const toolSchemas = this._read_source_schemas(sourceIndex);

    await this._progress(stream, this._status_exploring(), {
      trace_kind: "call_status",
      call_state: "running",
    });

    let investigation = "";
    let nudgedEmptyFinish = false;
    let forcedFinishAppended = false;
    try {
      for (let roundIdx = 0; roundIdx < MAX_LOOP_ROUNDS; roundIdx++) {
        const isLast = roundIdx === MAX_LOOP_ROUNDS - 1;
        if (isLast && !forcedFinishAppended) {
          messages.push({ role: "user", content: this._forced_finish_instruction() });
          forcedFinishAppended = true;
        }
        const result = await this._call_llm(
          messages,
          isLast ? null : toolSchemas,
          stream,
        );
        if (!result.tool_calls.length) {
          investigation = result.text;
          if (
            !investigation.trim() &&
            result.reasoning_content &&
            !isLast &&
            !nudgedEmptyFinish
          ) {
            nudgedEmptyFinish = true;
            messages.push({
              role: "assistant",
              content: result.text || null,
              ...(result.reasoning_content
                ? { reasoning_content: result.reasoning_content }
                : {}),
            });
            messages.push({ role: "user", content: this._forced_finish_instruction() });
            forcedFinishAppended = true;
            continue;
          }
          break;
        }
        messages.push({
          role: "assistant",
          content: result.text || null,
          tool_calls: result.tool_calls,
          ...(result.reasoning_content
            ? { reasoning_content: result.reasoning_content }
            : {}),
        });
        // Dispatch: execute read_source calls. Upstream bounds parallelism at
        // MAX_PARALLEL_TOOL_CALLS and reports the skipped remainder back to
        // the model so it can retry in a smaller batch.
        const executable = result.tool_calls.slice(0, MAX_PARALLEL_TOOL_CALLS);
        const skipped = result.tool_calls.slice(MAX_PARALLEL_TOOL_CALLS);
        for (const call of [...executable, ...skipped]) {
          const fn = call["function"];
          const fnName = _isRecord(fn) ? _str(fn["name"]) : "";
          let args: Dict = {};
          try {
            args = JSON.parse(_isRecord(fn) ? _str(fn["arguments"] ?? "{}") : "{}");
          } catch {
            args = {};
          }
          let toolResult: { success: boolean; result: string };
          if (skipped.includes(call)) {
            toolResult = {
              success: false,
              result:
                "Skipped: the per-round tool-call limit was reached. Retry this " +
                "read in a later round if still needed.",
            };
          } else if (fnName === "read_source") {
            const out = await read_source.execute(
              { ...args, source_index: sourceIndex } as never,
            );
            toolResult = { success: out.success, result: String(out.result ?? "") };
          } else {
            toolResult = { success: false, result: `Unknown tool: ${fnName}` };
          }
          messages.push({
            role: "tool",
            tool_call_id: _str(call["id"]),
            name: fnName,
            content: toolResult.result,
          });
        }
      }
    } finally {
      await this._progress(stream, "", {
        trace_kind: "call_status",
        call_state: "complete",
      });
    }

    this._account_usage(
      usage,
      messages.reduce((acc, m) => acc + _content_chars(m), 0),
      _chars(investigation).length,
      investigation,
    );
    return investigation;
  }

  private async _call_llm(
    messages: Dict[],
    toolSchemas: Dict[] | null,
    stream: ExploreStream | null,
  ): Promise<{
    text: string;
    reasoning_content: string;
    tool_calls: Dict[];
    output_chars: number;
  }> {
    const budget = _budgets()["loop"]["max_tokens"];
    const body: Dict = {
      model: this._llm.model,
      messages,
      stream: false,
      temperature: 0.2,
      max_tokens: budget,
    };
    if (toolSchemas && toolSchemas.length) {
      body["tools"] = toolSchemas;
      body["tool_choice"] = "auto";
    }
    const base = this._llm.base_url.trim().replace(/\/+$/, "");
    if (!base) throw new Error("This model has no base URL configured");
    const url = `${base}/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this._llm.api_key) headers["Authorization"] = `Bearer ${this._llm.api_key}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STREAM_IDLE_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`${this._llm.model} rejected the request (${response.status}): ${detail}`);
    }
    const event = (await response.json()) as Dict;
    const choices = Array.isArray(event["choices"]) ? (event["choices"] as Dict[]) : [];
    const choice = choices[0] ?? {};
    const message = _isRecord(choice["message"]) ? (choice["message"] as Dict) : {};
    const content = message["content"];
    const text = typeof content === "string" ? content : "";
    const reasoning = _str(
      message["reasoning_content"] ?? message["reasoning"] ?? "",
    );
    const toolCalls = Array.isArray(message["tool_calls"])
      ? (message["tool_calls"] as Dict[])
      : [];
    const outputChars =
      _chars(text).length +
      _chars(reasoning).length +
      toolCalls.reduce((acc, c) => acc + _chars(JSON.stringify(c)).length, 0);
    // Best-effort thinking-channel mirror (upstream streams deltas).
    if (reasoning && stream?.thinking) {
      await stream.thinking(reasoning, { source: EXPLORE_SOURCE, stage: EXPLORE_STAGE });
    }
    if (text && stream?.thinking) {
      await stream.thinking(text, { source: EXPLORE_SOURCE, stage: EXPLORE_STAGE });
    }
    return {
      text,
      reasoning_content: reasoning,
      tool_calls: toolCalls,
      output_chars: outputChars,
    };
  }

  private _read_source_schemas(sourceIndex: Record<string, string>): Dict[] {
    const sourceIds = Object.keys(sourceIndex).sort();
    const parameters: Dict = {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description:
            "The source identifier from the Attached Sources manifest. " +
            "Begins with one of: nb-, bk-, rd-, hs-, qb-, at-.",
          ...(sourceIds.length ? { enum: sourceIds } : {}),
        },
        offset: { type: "integer", default: 0 },
      },
      required: ["source_id"],
      additionalProperties: false,
    };
    return [
      {
        type: "function",
        function: {
          name: "read_source",
          description: read_source.description,
          parameters,
        },
      },
    ];
  }

  // ---- single-pass fallback -------------------------------------------

  private async _single_pass(
    context: ExploreContext,
    stream: ExploreStream | null,
    sourceIndex: Record<string, string>,
    usage: ExploreUsage | null,
  ): Promise<string> {
    const sourcesText = this._render_source_blocks(sourceIndex);
    if (!sourcesText) return "";
    const systemPrompt = this._t("system");
    const userTemplate = this._t("user_template");
    if (!systemPrompt || !userTemplate) return "";
    const userPrompt = userTemplate
      .replace("{question}", (context.user_message ?? "").trim() || "(empty)")
      .replace("{mode}", String(context.active_capability || "chat"))
      .replace("{manifest}", (context.source_manifest ?? "").trim() || "(none)")
      .replace("{sources}", sourcesText);

    await this._progress(stream, this._status_exploring(), {
      trace_kind: "call_status",
      call_state: "running",
    });
    const chunks: string[] = [];
    try {
      for await (const chunk of streamText(this._settings, {
        system: systemPrompt,
        prompt: userPrompt,
      })) {
        if (!chunk) continue;
        chunks.push(chunk);
        if (stream?.thinking) {
          await stream.thinking(chunk, {
            source: EXPLORE_SOURCE,
            stage: EXPLORE_STAGE,
          });
        }
      }
    } catch {
      // Fall through — an empty briefing disables the pre-pass.
    } finally {
      await this._progress(stream, "", {
        trace_kind: "call_status",
        call_state: "complete",
      });
    }
    const briefing = cleanThinkingTags(chunks.join("")).trim();
    this._account_usage(
      usage,
      _chars(systemPrompt).length + _chars(userPrompt).length,
      _chars(briefing).length,
      briefing,
    );
    return briefing;
  }

  private _render_source_blocks(sourceIndex: Record<string, string>): string {
    const blocks: string[] = [];
    let total = 0;
    for (const [sid, text] of Object.entries(sourceIndex)) {
      const body = _str(text ?? "").trim();
      if (!body) continue;
      if (blocks.length >= MAX_SOURCES || total >= TOTAL_CHARS) break;
      const remaining = TOTAL_CHARS - total;
      const clipped = this._clip(body, Math.min(CHARS_PER_SOURCE, remaining));
      blocks.push(`### [${sid}] (${this._kind_label(sid)})\n${clipped}`);
      total += _chars(clipped).length;
    }
    return blocks.join("\n\n");
  }

  private _kind_label(sid: string): string {
    for (const [prefix, [en]] of Object.entries(KIND_BY_PREFIX)) {
      if (sid.startsWith(prefix)) return en;
    }
    return "Source";
  }

  private _clip(text: string, limit: number): string {
    const trimmed = (text || "").trim();
    if (limit <= 0) return "";
    if (_chars(trimmed).length <= limit) return trimmed;
    const note = "\n…(truncated)";
    return _clipChars(trimmed, limit).replace(/\s+$/, "") + note;
  }

  // ---- shared helpers --------------------------------------------------

  private _account_usage(
    usage: ExploreUsage | null,
    inputChars: number,
    outputChars: number,
    produced: string,
  ): void {
    if (!usage || !produced.trim()) return;
    try {
      usage.add_estimated?.({ input_chars: inputChars, output_chars: outputChars });
    } catch {
      // usage accounting is best-effort
    }
  }

  private _cache_shaped_messages(opts: {
    source_index: Record<string, string>;
    question: string;
    mode: string;
    manifest: string;
  }): Dict[] {
    const preambleTemplate = this._t("loop.preamble_template");
    const questionTemplate = this._t("loop.question_template");
    if (!preambleTemplate || !questionTemplate) return [];
    const selected = this._preload_selection(opts.source_index);
    const sourcesText = this._render_preloaded_sources(opts.source_index, selected);
    return [
      {
        role: "user",
        content: preambleTemplate
          .replace("{mode}", opts.mode)
          .replace("{manifest}", opts.manifest)
          .replace("{sources}", sourcesText || "(none)"),
      },
      {
        role: "user",
        content: questionTemplate.replace("{question}", opts.question),
      },
    ];
  }

  private _preload_selection(sourceIndex: Record<string, string>): string[] {
    if (!PRELOAD_SOURCES_ENABLED || PRELOAD_MAX_SOURCES <= 0) return [];
    const ranked = Object.keys(sourceIndex)
      .filter((sid) => _str(sourceIndex[sid] ?? "").trim())
      .sort(
        (a, b) =>
          _chars(_str(sourceIndex[b] ?? "")).length -
            _chars(_str(sourceIndex[a] ?? "")).length || (a < b ? -1 : a > b ? 1 : 0),
      );
    const selected: string[] = [];
    let total = 0;
    for (const sid of ranked) {
      if (selected.length >= PRELOAD_MAX_SOURCES) break;
      const size = _chars(_str(sourceIndex[sid] ?? "")).length;
      if (total + size > PRELOAD_MAX_CHARS) continue;
      selected.push(sid);
      total += size;
    }
    return selected;
  }

  private _render_preloaded_sources(
    sourceIndex: Record<string, string>,
    selected: string[],
  ): string {
    const blocks: string[] = [];
    for (const sid of selected) {
      const body = _str(sourceIndex[sid] ?? "").trim();
      if (body) blocks.push(`### [${sid}] (${this._kind_label(sid)})\n${body}`);
    }
    return blocks.join("\n\n");
  }

  private static _source_index(context: ExploreContext): Record<string, string> {
    const idx = context.metadata?.["source_index"];
    if (_isRecord(idx) && Object.keys(idx).length) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(idx)) out[String(k)] = _str(v);
      return out;
    }
    return {};
  }

  private _forced_finish_instruction(): string {
    return this._t(
      "loop.forced_finish",
      "Investigation budget reached. Stop calling tools and write your " +
        "objective, thorough investigation now from what you have gathered.",
    );
  }

  private _status_exploring(): string {
    return this._t(
      "status.exploring",
      "Context exploration",
    );
  }

  private _briefing_header(): string {
    return this._t("briefing_header", "[Context Investigation]");
  }

  private async _progress(
    stream: ExploreStream | null,
    text: string,
    extra: Dict,
  ): Promise<void> {
    if (!stream?.progress) return;
    try {
      await stream.progress(text, {
        source: EXPLORE_SOURCE,
        stage: EXPLORE_STAGE,
        metadata: { call_kind: "context_exploration", ...extra },
      });
    } catch {
      // trace writes are best-effort
    }
  }
}

const MAX_PARALLEL_TOOL_CALLS = 15; // runtime.agentic.tool_dispatch upstream

function _content_chars(message: Dict): number {
  const content = message["content"];
  if (typeof content === "string") return _chars(content).length;
  if (Array.isArray(content)) {
    return content.reduce(
      (acc, part) =>
        acc + (_isRecord(part) ? _chars(_str(part["text"] ?? "")).length : 0),
      0,
    );
  }
  return 0;
}

/** Publish the turn's source index so read_source can resolve ids. */
export function with_source_index<T>(sourceIndex: Record<string, string>, fn: () => T): T {
  const token = current_source_index.set(sourceIndex);
  try {
    return fn();
  } finally {
    current_source_index.reset(token);
  }
}
