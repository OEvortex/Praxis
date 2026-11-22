// Port of the mastery capability's prompt/pipeline surface
// (capabilities/mastery/pipeline.py + prompts/).
//
// The upstream pipeline assembled a LoopExtension: per-turn prompt blocks
// (general rules, runtime policy, loop protocol, playbook, current-mode
// session text, notices) plus pre-loop status snapshots. The Praxis agent
// runtime has no LoopExtension hook, so this module exposes the same prompt
// assembly as pure functions the orchestrator/prompt builder can call:
//
//   masteryPromptBlocks(language, mode)  → ordered {key, text} blocks
//   modeInstructions(mode, language)     → the session-mode text only
//   preLoopStatusSnapshot(...)           → compact status for the turn brief
//
// Prompt text lives in prompts/<lang>/mastery_loop.txt as `## <section>`
// delimited blocks ported from the upstream YAML pack.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMode, STUDY } from "./mode.js";
import type { LearningProgress } from "./store.js";
import {
  mapSummary,
  nextObjective,
  dueReviews,
  profileStatus,
} from "./engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface PromptBlock {
  key: string;
  text: string;
}

const _cache = new Map<string, Map<string, string>>();

function loadPack(language: string): Map<string, string> {
  const lang = language === "zh" ? "zh" : "en";
  const cached = _cache.get(lang);
  if (cached) return cached;
  const path = join(HERE, "prompts", lang, "mastery_loop.txt");
  let raw = "";
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    raw = "";
  }
  const sections = new Map<string, string>();
  let current = "";
  let buf: string[] = [];
  const flush = () => {
    sections.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of raw.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) flush();
      current = m[1];
    } else {
      buf.push(line);
    }
  }
  if (current) flush();
  _cache.set(lang, sections);
  return sections;
}

function section(language: string, key: string): string {
  return loadPack(language).get(key) ?? "";
}

/** Session-mode instruction block (outline / study / review). */
export function modeInstructions(mode: unknown, language = "en"): string {
  const normalized = normalizeMode(mode);
  return section(language, `session.${normalized}`);
}

/**
 * The full tutor prompt surface for a mastery turn, in upstream order:
 * general rules → runtime policy → loop protocol → playbook → session mode.
 * Engine runtime copy (labels/notices/empty) is left to the host prompt
 * pack, same as upstream's MasteryLoopPipeline.prompt_base_module.
 */
export function masteryPromptBlocks(language = "en", mode: unknown = STUDY): PromptBlock[] {
  const lang = language === "zh" ? "zh" : "en";
  const blocks: PromptBlock[] = [];
  const push = (key: string) => {
    const text = section(lang, key);
    if (text) blocks.push({ key, text });
  };
  push("general");
  push("runtime_policy");
  push("loop.system");
  push("playbook");
  const modeText = modeInstructions(mode, lang);
  if (modeText) blocks.push({ key: `session.${normalizeMode(mode)}`, text: modeText });
  return blocks;
}

/** One-shot status snapshot for a turn brief (pre_loop equivalent). */
export function preLoopStatusSnapshot(
  progress: LearningProgress | null,
  sessionId = "",
): Record<string, unknown> {
  if (!progress) return { status: "empty" };
  const hasOutline = (progress.modules ?? []).some((m) => (m.knowledge_points ?? []).length > 0);
  if (!hasOutline) return { status: "empty", path_revision: progress.version ?? 0 };
  return {
    status: "active",
    path_revision: progress.version,
    next: nextObjective(progress, sessionId),
    map: mapSummary(progress),
    due_review_ids: dueReviews(progress).slice(0, 3).map((t) => t.knowledge_point_id),
    ...profileStatus(progress),
  };
}

export { normalizeMode };
