// Port of deeptutor/capabilities/solve/capability.py + loop.py — Deep Solve:
// problem solving driven by the chat agent loop with a deterministic spine
// (committed plan, per-step done gate, bounded replan).
//
// There is no bespoke pipeline: the chat agent loop IS the solver. This
// capability marks the turn as solve mode and resolves a session id; the
// solve tools (tools.ts) and the system prompt below steer the loop.

import { readFileSync } from "node:fs";
import { DEFAULT_MAX_REPLANS, get_session } from "./session.js";
import { SOLVE_TOOL_NAMES } from "./tools.js";
import type { Dict } from "../../shared/types.js";

const UNSAFE_ID_CHARS = /[^A-Za-z0-9_-]/g;

function _sanitize(raw: string): string {
  const cleaned = raw.replace(UNSAFE_ID_CHARS, "_").replace(/^_+|_+$/g, "");
  return cleaned || "default";
}

export interface SolveTurnContext {
  session_id?: string;
  metadata?: Dict | null;
}

/** Resolve the in-memory session key for this solve turn. */
export function resolve_solve_session_id(context: SolveTurnContext): string {
  const meta = context.metadata ?? {};
  const raw = String(
    meta["turn_id"] ?? context.session_id ?? meta["message_id"] ?? "default",
  );
  return _sanitize(raw);
}

const _PROMPT_CACHE = new Map<string, string>();

export function load_system_prompt(language: string): string {
  const lang = language.toLowerCase().startsWith("zh") ? "zh" : "en";
  const cached = _PROMPT_CACHE.get(lang);
  if (cached !== undefined) return cached;
  const url = new URL(`./prompts/${lang}/system.txt`, import.meta.url);
  const text = readFileSync(url, "utf-8").trim();
  _PROMPT_CACHE.set(lang, text);
  return text;
}

export interface PromptBlock {
  name: string;
  content: string;
}

export function is_active(metadata: Dict | null | undefined): boolean {
  return Boolean(metadata?.["solve_mode"]);
}

export function system_block(
  metadata: Dict,
  opts: { language?: string } = {},
): PromptBlock | null {
  if (!is_active(metadata)) return null;
  // prompts override hook (upstream ``prompt_text(prompts, ("solve","system"))``)
  // is intentionally unported — the bundled prompt file is authoritative here.
  void metadata;
  return {
    name: "deep_solve",
    content: load_system_prompt(opts.language ?? "en"),
  };
}

/**
 * Mark a turn as a solve turn: set solve_mode, resolve + publish the session
 * id, and read the solve params the page forwarded (mirrors
 * DeepSolveCapability.run's metadata writes).
 */
export function prepare_solve_turn(
  context: SolveTurnContext,
  params: { max_replans?: number; max_rounds?: number; temperature?: number; max_tokens?: number } = {},
): { session_id: string; max_replans: number } {
  const meta = (context.metadata ??= {});
  meta["solve_mode"] = true;
  const sessionId = resolve_solve_session_id(context);
  meta["solve_session_id"] = sessionId;
  const rawMax = Number(params.max_replans ?? DEFAULT_MAX_REPLANS);
  const maxReplans = Number.isFinite(rawMax)
    ? Math.trunc(rawMax)
    : DEFAULT_MAX_REPLANS;
  meta["solve_max_replans"] = maxReplans;
  return { session_id: sessionId, max_replans: maxReplans };
}

/**
 * Upstream SolveLoopCapability.augment_kwargs: seed the session's replan
 * budget from the solve settings (never the model) and inject the session id.
 */
export function augment_kwargs(
  tool_name: string,
  kwargs: Record<string, unknown>,
  metadata: Dict,
): Record<string, unknown> {
  if (is_active(metadata) && (SOLVE_TOOL_NAMES as readonly string[]).includes(tool_name)) {
    const sessionId = String(metadata["solve_session_id"] ?? "").trim();
    const session = get_session(sessionId);
    try {
      const raw = Number(metadata["solve_max_replans"] ?? DEFAULT_MAX_REPLANS);
      session.max_replans = Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_MAX_REPLANS;
    } catch {
      session.max_replans = DEFAULT_MAX_REPLANS;
    }
    return { ...kwargs, _solve_session_id: sessionId };
  }
  return kwargs;
}

export function pre_loop_seed(_metadata?: Dict): string {
  return "";
}
