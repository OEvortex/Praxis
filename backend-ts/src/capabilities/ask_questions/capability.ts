// the
// Ask Questions capability: an explicit user-selected interview mode that
// contributes an adaptive questioning policy to the normal chat loop.
//
// Upstream's TurnCapability.run just sets ``metadata.ask_questions_mode`` and
// runs the standard agentic pipeline with ``initial_tool_choice="ask_user"``;
// here we expose the metadata flag helpers plus the system prompt the loop
// injects while the mode is active.

import { readFileSync } from "node:fs";
import type { Dict } from "../../shared/types.js";

export const ASK_QUESTIONS_MODE_KEY = "ask_questions_mode";

export interface PromptBlock {
  name: string;
  content: string;
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

export function name(): string {
  return "ask_questions";
}

export const owned_tools: string[] = [];

export function is_active(metadata: Dict | null | undefined): boolean {
  return Boolean(metadata?.[ASK_QUESTIONS_MODE_KEY]);
}

/** Mark a turn as Ask-Questions mode (upstream TurnCapability.run). */
export function activate(metadata: Dict): void {
  metadata[ASK_QUESTIONS_MODE_KEY] = true;
}

export function system_block(
  metadata: Dict | null | undefined,
  opts: { language?: string } = {},
): PromptBlock | null {
  if (!is_active(metadata)) return null;
  return {
    name: "ask_questions",
    content: load_system_prompt(opts.language ?? "en"),
  };
}

export function augment_kwargs(
  _tool_name: string,
  kwargs: Record<string, unknown>,
  _metadata?: Dict,
): Record<string, unknown> {
  return kwargs;
}

export function pre_loop_seed(_metadata?: Dict): string {
  return "";
}
