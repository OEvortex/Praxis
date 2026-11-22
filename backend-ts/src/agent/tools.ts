// built-in tools exposed to the tutor agent.
//
// Tools are registered by name in ``builtin_tools``; each tool object carries
// its own params schema and mutation flag for the permission layer.

import type { Settings } from "../config.js";
import type { BaseTool } from "../shared/vtx.js";
import * as dt_tools from "./dt_tools.js";
import { register_notebook_tools } from "./notebook_agent/notebook_tools.js";
import { register_notes_tools } from "../capabilities/notes/tools.js";
// Consolidated action-dispatched tools (one per tool family).
import { MERGED_TOOLS } from "./merged_tools.js";
// Capabilities still exposed as individual tools.
import { AUDIO_OVERVIEW_TOOLS } from "../capabilities/audio_overview/index.js";

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
    // File-inspection/editing tools are intentionally NOT exposed: Praxis
    // is a tutor, not a coding agent. The learner-facing `workspace` tool
    // still handles artifacts the app itself creates (notes, media).
    ["learning", dt_tools.learning],
    ["workspace", dt_tools.workspace],
    // `ask_user` is intentionally not registered for now.
    // Scheduled reminders: the run lands in the turn's own session and
    // shows up on the calendar's Automations layer.
    ["cron", dt_tools.cron],
    ["review", dt_tools.review],
    // Consolidated families: external stores, mastery, reading, solve,
    // setup, subagents, proposals, generation, notes and source retrieval.
    ...MERGED_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
    ...AUDIO_OVERVIEW_TOOLS.map((t) => [t.name, t] as [string, BaseTool]),
  ]);

  // Praxis semantics: only the user-toggleable tools are gated by the
  // frontend's `tools` list; every other built-in is locked-on and must
  // always reach the model's schema.
  const toggleable = TOGGLEABLE;

  // Notebook and notes tools are mounted for the main agent (DeepTutor
  // semantics). Registering them globally also makes them resolvable by
  // the notebook sub-agent's ``tools_allow`` selection.
  register_notebook_tools();
  register_notes_tools();

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
