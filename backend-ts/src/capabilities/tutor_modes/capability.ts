// Lightweight tutor modes selected from the empty composer: Explain, Solve,
// Practice, Plan and Research.
//
// Unlike Deep Solve or Deep Research these modes do not own a pipeline or a
// tool protocol. They are a selected turn mode: the loop stays the ordinary
// chat loop, and a system block at the top of the turn frames *how* the tutor
// answers. Keeping them here (instead of baking the starter prompts into the
// wire payload) means the behaviour lives on the server and survives edits to
// the learner's customizable starter prompts.

import { existsSync, readFileSync } from "node:fs";

import type { BaseTool } from "../../shared/vtx.js";
import type { Dict } from "../../shared/types.js";
import { ownedToolsForMode, TUTOR_MODE_TOOL_NAMES } from "./tools.js";

export const TUTOR_MODES = [
  "explain",
  "solve",
  "practice",
  "plan",
  "research",
] as const;

export type TutorMode = (typeof TUTOR_MODES)[number];

const TUTOR_MODE_SET = new Set<string>(TUTOR_MODES);

/** True for the five composer actions that are also real turn modes. */
export function is_tutor_mode(value: unknown): value is TutorMode {
  return typeof value === "string" && TUTOR_MODE_SET.has(value);
}

const PROMPT_CACHE = new Map<TutorMode, string>();

/** Load a mode's playbook. English ships with Praxis; zh falls back to it. */
export function load_system_prompt(mode: TutorMode, language = "en"): string {
  const cached = PROMPT_CACHE.get(mode);
  if (cached !== undefined) return cached;
  const lang = language.toLowerCase().startsWith("zh") ? "zh" : "en";
  let url = new URL(`./prompts/${lang}/${mode}.txt`, import.meta.url);
  if (!existsSync(url)) url = new URL(`./prompts/en/${mode}.txt`, import.meta.url);
  const text = readFileSync(url, "utf-8").trim();
  PROMPT_CACHE.set(mode, text);
  return text;
}

/**
 * Toggleable backend tools each mode may use. Locked-on built-ins are always
 * kept; this is the server-side half of the frontend's `allowedTools`, so a
 * crafted client payload cannot grant a mode tools it does not own.
 */
export const TUTOR_MODE_ALLOWED_TOOLS: Record<TutorMode, readonly string[]> = {
  explain: ["web", "paper_search"],
  solve: ["web"],
  practice: ["web"],
  plan: ["web"],
  research: ["web", "paper_search"],
};

const TOGGLEABLE = new Set(["web", "paper_search"]);

/** Server-enforced tool allowlist for one tutor-mode turn. */
export function toolFilterForMode(mode: TutorMode): (name: string) => boolean {
  const allowed = new Set<string>(TUTOR_MODE_ALLOWED_TOOLS[mode]);
  const owned = TUTOR_MODE_TOOL_NAMES[mode];
  return (name: string) => {
    if (name === owned) return true;
    if (!TOGGLEABLE.has(name)) return true;
    return allowed.has(name);
  };
}

/** Mode-owned tools, mounted for the active mode only. */
export function ownedTools(mode: TutorMode): BaseTool[] {
  return ownedToolsForMode(mode);
}

/** Inject the server-owned turn state handle into the mode's own tool calls. */
export function augment_kwargs(
  toolName: string,
  kwargs: Dict,
  metadata: Dict,
): Dict {
  const mode = metadata["tutor_mode"];
  if (!is_tutor_mode(mode) || toolName !== TUTOR_MODE_TOOL_NAMES[mode]) {
    return kwargs;
  }
  const stateId = String(metadata["tutor_state_id"] ?? "").trim();
  if (!stateId) return kwargs;
  return { ...kwargs, _tutor_state_id: stateId, _tutor_mode: mode };
}

export interface PromptBlock {
  name: string;
  content: string;
}

/** One system block for the selected tutor mode, or null for other turns. */
export function system_block(
  metadata: Dict | null | undefined,
  opts: { language?: string } = {},
): PromptBlock | null {
  const mode = metadata?.["tutor_mode"];
  if (!is_tutor_mode(mode)) return null;
  return {
    name: `tutor_${mode}`,
    content: load_system_prompt(mode, opts.language),
  };
}
