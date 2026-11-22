// Port of backend/app/agent/tools.py — built-in tools exposed to the tutor agent.
//
// Tools are registered by name in ``builtin_tools``; each tool object carries
// its own params schema and mutation flag for the permission layer.

import type { Settings } from "../config.js";
import type { BaseTool } from "../shared/vtx.js";
import * as dt_tools from "./dt_tools.js";
import { knowledge_base_search } from "./kb_tools.js";
import {
  CO_WRITER_TOOL_NAMES,
  co_writer_tools,
  is_co_writer_turn,
} from "./co_writer.js";
// Upstream chat capabilities (deeptutor/capabilities/*) ported as agent tools.
import { MASTERY_TOOLS } from "../capabilities/mastery/index.js";
import { READING_TOOLS } from "../capabilities/reading/index.js";
import { SOLVE_TOOLS } from "../capabilities/solve/index.js";
import { CREATOR_TOOLS } from "../capabilities/creator/index.js";
import { read_source } from "../capabilities/explore_context/read_source.js";
import { OBSIDIAN_TOOLS } from "../capabilities/obsidian/index.js";
import { IMA_TOOLS } from "../capabilities/ima/index.js";
import { AUDIO_OVERVIEW_TOOLS } from "../capabilities/audio_overview/index.js";
import { SETUP_TOOLS } from "../capabilities/setup/index.js";
import { MARGINNOTE_TOOLS } from "../capabilities/marginnote4/index.js";
import { SUBAGENT_EXT_TOOLS } from "../capabilities/subagent_ext/index.js";
import { propose_partner, invoke_other } from "../capabilities/partners/tools.js";
import { notes_tools } from "../capabilities/notes/index.js";
// Side effect in Python: keep params named "title" in the model-facing tool
// schema. The TS shim is a no-op without a vtx module, but keep the import for
// parity with modules that install it explicitly.
import "./_vtx_compat.js";

const TOGGLEABLE = new Set(["web", "web_search", "paper_search"]);
const WEB_SEARCH_ALIAS = new Map([["web_search", "web"]]);

/**
 * All builtin tools, filtered by the turn's ``tools`` allowlist.
 *
 * ``enabled=None`` means "everything"; an empty list also means everything
 * (the frontend sends the user's tool selection — absent = unrestricted).
 */
export function builtin_tools(
  _settings: Settings,
  enabled?: string[] | null,
): BaseTool[] {
  const registry = new Map<string, BaseTool>([
    // Praxis portable ports (dt_tools.py)
    ["web", dt_tools.web],
    ["paper_search", dt_tools.paper_search],
    ["question_bank", dt_tools.question_bank],
    ["memory", dt_tools.memory],
    ["knowledge_base_search", knowledge_base_search],
    // File-inspection/editing tools are intentionally NOT exposed: Praxis
    // is a tutor, not a coding agent. The learner-facing `workspace` tool
    // still handles artifacts the app itself creates (notes, media).
    ["learning", dt_tools.learning],
    ["workspace", dt_tools.workspace],
    // `ask_user` is intentionally not registered for now.
    ["mastery", dt_tools.mastery],
    ["video", dt_tools.video],
    // Background notebook builder: dispatches the Co-writer sub-agent
    // (shared prompt + nb_* tools) via vtx's task machinery.
    ["notebook", dt_tools.notebook],
    // Scheduled reminders: the run lands in the turn's own session and
    // shows up on the calendar's Automations layer.
    ["cron", dt_tools.cron],
    ["review", dt_tools.review],
    // Upstream capability tools — mounted unconditionally like upstream keeps
    // them registered; per-tool mode gates live inside the tools themselves.
    ...MASTERY_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...READING_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...SOLVE_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...CREATOR_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    [read_source.name, read_source as BaseTool],
    ...OBSIDIAN_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...IMA_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...AUDIO_OVERVIEW_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...SETUP_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...MARGINNOTE_TOOLS.map((t: BaseTool) => [t.name, t] as [string, BaseTool]),
    ...SUBAGENT_EXT_TOOLS.map((t: BaseTool) => [t.name, t] as [string, BaseTool]),
    [propose_partner.name, propose_partner as BaseTool],
    [invoke_other.name, invoke_other as BaseTool],
    ...notes_tools().map((t) => [t.name, t] as [string, BaseTool]),
  ]);

  // Praxis semantics: only the user-toggleable tools are gated by the
  // frontend's `tools` list; every other built-in is locked-on and must
  // always reach the model's schema.
  const toggleable = TOGGLEABLE;

  // The notebook companion gets its own playbook: read the page and propose
  // reviewable changes (including learning blocks/flashcards). These tools
  // are absent from ordinary chat turns.
  if (is_co_writer_turn()) {
    for (const tool of co_writer_tools()) {
      registry.set(tool.name, tool);
    }
    // Co-writer's toolset is deliberately narrower than the main chat's: no
    // video, cron, mastery, workspace files or question bank.
    const allowed = new Set<string>(CO_WRITER_TOOL_NAMES);
    for (const name of [...registry.keys()]) {
      if (!allowed.has(name)) registry.delete(name);
    }
  }

  // web_search is the frontend's toggle name for the merged `web` tool.
  const requested = (enabled ?? []).map((n) => WEB_SEARCH_ALIAS.get(n) ?? n);
  const lockedOn = new Set([...registry.keys()].filter((n) => !toggleable.has(n)));
  if (requested.length) {
    const requestedSet = new Set(requested);
    const keep = new Set(lockedOn);
    for (const name of requestedSet) {
      if (toggleable.has(name) && registry.has(name)) keep.add(name);
    }
    return [...registry.entries()]
      .filter(([name]) => keep.has(name))
      .map(([, tool]) => tool);
  }
  return [...registry.values()];
}
