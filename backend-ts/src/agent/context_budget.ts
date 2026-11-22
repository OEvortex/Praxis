/**
 * Context-window budget for the composer's context bar.
 *
 * Everything in here is pure/testable: the runtime hands it the pieces of the
 * request and the provider's own usage counters, and gets back the payload the
 * UI renders.
 *
 * Two things used to be wrong and are fixed here:
 *
 *  1. The window was looked up with the *catalog id* (a generated UUID), not the
 *     wire model id, so models.dev metadata never matched and a model with a
 *     1M window (e.g. reflection/beam-free) fell back to the 200k default.
 *     `resolve_context_window` looks up the wire model and also finds the
 *     model entry by its wire id when no active selection is saved.
 *
 *  2. The token numbers were invented: `length / 4` and `120 * toolCount`,
 *     then rescaled to add up to the reported total. The header now uses the
 *     provider's native `total_tokens`, and the per-piece breakdown (messages,
 *     system prompt, tool schemas) is counted locally with a real tokenizer —
 *     providers only report input/output totals, never a per-piece split. The
 *     residual between the counted pieces and the native total is shown as its
 *     own "Other context" row instead of being silently spread over the rows.
 */

import { getEncoding, type Tiktoken } from "js-tiktoken";

import type { Settings } from "../config.js";
import * as providerConfig from "../provider-config.js";
import type { UsageStats } from "../shared/vtx.js";

/** vtx's own last-resort UI default (vtx.core.config agent.default_context_window). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** General-purpose BPE vocabulary used only for the local breakdown. */
export const TOKENIZER_NAME = "o200k_base" as const;

let _encoding: Tiktoken | null | undefined;
function encoding(): Tiktoken | null {
  if (_encoding === undefined) {
    try {
      _encoding = getEncoding(TOKENIZER_NAME);
    } catch {
      _encoding = null;
    }
  }
  return _encoding;
}

/** True when real local tokenization is available in this build. */
export function tokenizer_available(): boolean {
  return encoding() !== null;
}

/** Count tokens with a real BPE vocabulary (fallback only if it cannot load). */
export function count_tokens(text: unknown): { tokens: number; exact: boolean } {
  const value = typeof text === "string" ? text : String(text ?? "");
  const enc = encoding();
  if (enc) return { tokens: enc.encode(value).length, exact: true };
  return { tokens: Math.ceil(Buffer.byteLength(value, "utf8") / 4), exact: false };
}

export interface ContextBudgetSegment {
  key: string;
  tokens: number;
}

export interface ContextBudgetPayload {
  window: number;
  window_estimated: boolean;
  used_tokens: number;
  free_tokens: number;
  model?: string;
  reasoning_effort?: string;
  /** "provider_usage" | "tokenizer" | "heuristic" */
  counter: string;
  /** BPE vocabulary used for the local breakdown, when available. */
  tokenizer?: string;
  segments: ContextBudgetSegment[];
}

export interface WindowResolution {
  window: number;
  estimated: boolean;
  source: "catalog" | "metadata" | "default";
}

function positiveInt(value: unknown): number {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sameModel(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Wire ids can arrive with a gateway prefix, e.g. "kilo/reflection/beam-free".
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * Resolve the context window from the catalog (explicit user value), then
 * models.dev metadata, then the conservative vtx default.
 *
 * `wire_model` is the model id that was actually sent to the provider. The
 * catalog id is a UUID and must never be used for metadata lookup — that was
 * the original 200k bug.
 */
export function resolve_context_window(params: {
  settings: Settings;
  wire_model: string;
  profile_id?: string;
  model_id?: string;
}): WindowResolution {
  const wireModel = String(params.wire_model ?? "").trim();
  const profileId = String(params.profile_id ?? "").trim();
  const modelId = String(params.model_id ?? "").trim();

  // 1. Explicit value saved in our own catalog (manual override or a value
  //    detected earlier by "Test this model"). This is the user's say.
  let declared = 0;
  try {
    if (profileId && modelId) {
      declared = providerConfig.context_window_for(profileId, modelId);
    }
  } catch {
    /* best effort */
  }
  if (!declared && wireModel) {
    try {
      const catalog = providerConfig.load_catalog(params.settings) as Record<string, any>;
      const services = catalog?.services ?? {};
      for (const service of Object.values(services) as Record<string, any>[]) {
        for (const profile of (service?.profiles ?? []) as Record<string, any>[]) {
          for (const model of (profile?.models ?? []) as Record<string, any>[]) {
            if (
              sameModel(String(model?.model ?? ""), wireModel) ||
              sameModel(String(model?.id ?? ""), wireModel) ||
              sameModel(String(model?.name ?? ""), wireModel)
            ) {
              declared =
                positiveInt(model?.context_window_tokens) ||
                positiveInt(model?.context_window);
              if (declared) break;
            }
          }
          if (declared) break;
        }
        if (declared) break;
      }
    } catch {
      /* best effort */
    }
  }
  if (declared) return { window: declared, estimated: false, source: "catalog" };

  // 2. Authoritative models.dev metadata, keyed by the WIRE model.
  if (wireModel) {
    try {
      const meta = providerConfig.vtx_model_metadata(wireModel) as Record<string, any> | null;
      const fromMeta = positiveInt(meta?.context_window);
      if (fromMeta) return { window: fromMeta, estimated: false, source: "metadata" };
    } catch {
      /* best effort */
    }
  }

  // 3. Last resort — and the only case where the bar says "est.".
  return {
    window: DEFAULT_CONTEXT_WINDOW,
    estimated: true,
    source: "default",
  };
}

/** Flatten multimodal content blocks into plain text (fallback estimator only). */
function text_of(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as Record<string, unknown>).text ?? "")
          : String(part ?? ""),
      )
      .join("");
  }
  return String(value ?? "");
}

/** Serialize the tool manifest (fallback estimator only). */
export function tool_manifest_text(tools: readonly unknown[] | null | undefined): string {
  const rows = (tools ?? []).map((tool) => {
    const t = (tool ?? {}) as Record<string, any>;
    return {
      type: "function",
      function: {
        name: String(t.name ?? ""),
        description: String(t.description ?? ""),
        parameters: t.params ?? { type: "object", properties: {} },
      },
    };
  });
  return rows.length ? JSON.stringify(rows) : "";
}

/**
 * The provider's own total, with no double counting.
 *
 * OpenAI-compatible APIs include cached reads inside `prompt_tokens` and also
 * report `total_tokens`; Anthropic-style APIs report the cache fields as
 * separate buckets and may omit a grand total.
 */
export function reported_tokens(usage: UsageStats | null | undefined): number {
  if (!usage) return 0;
  const u = usage as Record<string, unknown>;
  const total = positiveInt(u.total_tokens);
  if (total) return total;
  const input = positiveInt(u.input_tokens);
  const output = positiveInt(u.output_tokens);
  const cacheRead = positiveInt(u.cache_read_tokens);
  const cacheWrite = positiveInt(u.cache_write_tokens);
  if (cacheRead || cacheWrite) return input + output + cacheRead + cacheWrite;
  return input + output;
}

export interface BuildBudgetInput {
  settings: Settings;
  wire_model: string;
  model_provider?: string;
  reasoning_effort?: string;
  profile_id?: string;
  model_id?: string;
  messages: readonly unknown[];
  system_prompt: string;
  tool_manifest: string;
  usage: UsageStats | null | undefined;
}

/**
 * Build the composer payload.
 *
 * The header (`used_tokens`) is the provider's own total — exact. The rows are
 * a local, real-tokenizer count of each request piece; their sum need not match
 * the header (the provider may count tool results, hidden scaffolding, or a
 * different vocabulary). That difference is surfaced as "Other context" rather
 * than being spread over the rows, so every number in the popover is either a
 * measurement or an explicitly labelled remainder.
 */
export function build_context_budget(input: BuildBudgetInput): ContextBudgetPayload {
  const messageText = (input.messages ?? [])
    .map((m) => text_of((m as Record<string, unknown> | null)?.content))
    .filter(Boolean)
    .join("\n");

  const segments: ContextBudgetSegment[] = [];
  const exact: boolean[] = [];
  for (const [key, text] of [
    ["messages", messageText],
    ["system_prompt", String(input.system_prompt ?? "")],
    ["system_tools", String(input.tool_manifest ?? "")],
  ] as const) {
    const counted = count_tokens(text);
    if (counted.tokens > 0) {
      segments.push({ key, tokens: counted.tokens });
      exact.push(counted.exact);
    }
  }
  const countedTotal = segments.reduce((sum, s) => sum + s.tokens, 0);

  const reported = reported_tokens(input.usage);
  const used = reported > 0 ? reported : countedTotal;
  if (used > countedTotal) {
    segments.push({ key: "other_context", tokens: used - countedTotal });
  }

  const allExact = exact.length > 0 && exact.every(Boolean);
  const counter = reported > 0 ? "provider_usage" : allExact ? "tokenizer" : "heuristic";

  const resolution = resolve_context_window({
    settings: input.settings,
    wire_model: input.wire_model,
    profile_id: input.profile_id,
    model_id: input.model_id,
  });
  const model = `${String(input.model_provider ?? "")}/${String(input.wire_model ?? "")}`
    .replace(/^\/+|\/+$/g, "");

  return {
    window: resolution.window,
    window_estimated: resolution.estimated,
    used_tokens: used,
    free_tokens: Math.max(0, resolution.window - used),
    model,
    ...(input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {}),
    counter,
    ...(allExact ? { tokenizer: TOKENIZER_NAME } : {}),
    segments,
  };
}
