// the
// explore-context loop capability: a near-invisible pre-pass that activates
// whenever the chat turn carries any readable (non-image) attached source.
// It runs the ContextExplorer before the answer loop's first LLM call and
// folds the investigation into the loop's user-message seed.

import { ContextExplorer, type ExploreContext, type ExploreStream, type ExploreUsage } from "./explorer.js";
import { load_prompts } from "./prompts.js";
import { with_source_index } from "./explorer.js";
import type { Dict } from "../../shared/types.js";

export interface PromptBlock {
  name: string;
  content: string;
}

function _isRecord(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Whether the turn has any readable (non-image) attached source. */
export function has_readable_sources(metadata: Dict | null | undefined): boolean {
  const idx = metadata?.["source_index"];
  return _isRecord(idx) && Object.keys(idx).length > 0;
}

export function is_active(metadata: Dict | null | undefined): boolean {
  return has_readable_sources(metadata);
}

export function system_block(): PromptBlock | null {
  // The investigation is delivered via the pre-loop hook, not a system block.
  return null;
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

const _explorerCache = new Map<string, ContextExplorer>();

function _explorer(language: string): ContextExplorer {
  const lang = "en";
  let explorer = _explorerCache.get(lang);
  if (explorer === undefined) {
    explorer = new ContextExplorer({
      language: lang,
      prompts: load_prompts(lang),
    });
    _explorerCache.set(lang, explorer);
  }
  return explorer;
}

/**
 * The async pre-loop hook: investigate the turn's attached context and return
 * it as a prompt block, or null when there is nothing to add.
 */
export async function pre_loop(
  context: ExploreContext,
  stream?: ExploreStream | null,
  usage?: ExploreUsage | null,
): Promise<PromptBlock | null> {
  const metadata = context.metadata ?? {};
  if (!is_active(metadata)) return null;
  const sourceIndex = _isRecord(metadata["source_index"])
    ? (metadata["source_index"] as Record<string, unknown>)
    : {};
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(sourceIndex)) normalized[String(k)] = String(v ?? "");
  const explorer = _explorer(String(context.language ?? "en"));
  const investigation = await with_source_index(normalized, () =>
    explorer.investigate(context, stream ?? null, usage ?? null),
  );
  if (!investigation.trim()) return null;
  return { name: "explore_context", content: investigation };
}
