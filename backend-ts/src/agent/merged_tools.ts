/**
 * The consolidated agent tool surface.
 *
 * One `action`-dispatched tool replaces each family of narrow tools. The
 * implementations are the original tool objects, so behaviour, hidden params
 * and UI metadata are unchanged — only the number of tools the model sees.
 */

import type { BaseTool } from "../shared/vtx.js";

import { actionTool, type MergedAction } from "./merged_tools_factory.js";
import * as dt_tools from "./dt_tools.js";
import { knowledge_base_search } from "./kb_tools.js";
import { read_source } from "../capabilities/explore_context/read_source.js";
import { propose_creation } from "../capabilities/creator/tools.js";
import { propose_partner, invoke_other } from "../capabilities/partners/tools.js";
import { OBSIDIAN_TOOLS } from "../capabilities/obsidian/tools.js";
import { IMA_TOOLS } from "../capabilities/ima/tools.js";
import { MARGINNOTE_TOOLS } from "../capabilities/marginnote4/tools.js";
import { SETUP_TOOLS } from "../capabilities/setup/tools.js";
import { SUBAGENT_EXT_TOOLS } from "../capabilities/subagent_ext/tools.js";
import { SOLVE_TOOLS } from "../capabilities/solve/tools.js";
import { READING_TOOLS } from "../capabilities/reading/tools.js";
import { MASTERY_TOOLS } from "../capabilities/mastery/tools.js";
import { notes_tools } from "../capabilities/notes/tools.js";
import { writer_tools } from "./notebook_agent/tools.js";

/** One short sentence per action — the enum already names the operation. */
function gloss(description: string): string {
  const text = String(description ?? "").trim();
  const first = text.split(/(?<=[.!?])\s/)[0] ?? "";
  return first.slice(0, 80);
}

function byName(tools: readonly BaseTool[], prefix = ""): Record<string, MergedAction> {
  const out: Record<string, MergedAction> = {};
  for (const tool of tools) {
    const key = prefix && tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
    out[key] = { tool, description: gloss(String(tool.description ?? "")) };
  }
  return out;
}

function one(name: string, tool: BaseTool, description?: string): MergedAction {
  return { tool, description: description ?? gloss(String(tool.description ?? "")) };
}

/** 22 external-store tools become three. */
export const obsidian = actionTool({
  name: "obsidian",
  description: "Search, read and edit the user's Obsidian vault. Jailed to the configured vault root.",
  toolIcon: "🗃️",
  actions: byName(OBSIDIAN_TOOLS, "obsidian_"),
});

export const ima = actionTool({
  name: "ima",
  description: "Search and manage the user's IMA subscribed knowledge bases and notes.",
  toolIcon: "📚",
  actions: byName(IMA_TOOLS, "ima_"),
});

export const marginnote = actionTool({
  name: "marginnote",
  description: "Search, read and inspect the user's MarginNote 4 library, or manage its bridge.",
  toolIcon: "🧠",
  actions: byName(MARGINNOTE_TOOLS, "marginnote_"),
});

/** Four setup tools become one. */
export const setup = actionTool({
  name: "setup",
  description: "Inspect Praxis configuration, apply settings, request credentials and run setup jobs. Call inspect first.",
  toolIcon: "⚙️",
  actions: byName(SETUP_TOOLS, "setup_"),
});

/** Three subagent tools become one. */
export const subagent = actionTool({
  name: "subagent",
  description: "List available external agents, configure the consultation budget, and delegate a question.",
  toolIcon: "🤝",
  actions: {
    consult: one("consult", SUBAGENT_EXT_TOOLS.find((t) => t.name === "consult_subagent")!),
    backends: one("backends", SUBAGENT_EXT_TOOLS.find((t) => t.name === "subagent_backends")!),
    configure: one("configure", SUBAGENT_EXT_TOOLS.find((t) => t.name === "subagent_configure")!),
  },
});

/** Three approval-only proposal tools become one. */
export const propose = actionTool({
  name: "propose",
  description: "Publish a reviewable draft. Nothing is created or started until the user approves it in the UI.",
  toolIcon: "📝",
  actions: {
    creation: one("creation", propose_creation),
    partner: one("partner", propose_partner),
    invoke_other: one("invoke_other", invoke_other),
  },
});

/** Two background-generation tools become one. */
export const generate = actionTool({
  name: "generate",
  description: "Dispatch a background writer sub-agent. The result is published for review when it finishes.",
  toolIcon: "✨",
  actions: {
    video: one("video", dt_tools.video),
    notebook: one("notebook", dt_tools.notebook),
  },
});

/** Three solve-loop tools become one. */
export const solve = actionTool({
  name: "solve",
  description: "Plan a multi-step solution, finish the current step, or replan. Returns the next step to work on.",
  toolIcon: "🧩",
  actions: byName(SOLVE_TOOLS, "solve_"),
});

/** Eight reading tools become one. */
export const reading = actionTool({
  name: "reading",
  description: "Work with the open reading material: switch tabs, outline, search, read passages, jump the reader, and annotate.",
  toolIcon: "📖",
  actions: Object.fromEntries(
    Object.entries({
      list_tabs: "reading_list_tabs",
      switch_tab: "reading_switch_tab",
      outline: "material_outline",
      search: "search_material",
      read: "read_material",
      goto: "reader_goto",
      annotate: "reader_annotate",
      view_figure: "view_figure",
    }).map(([action, toolName]) => [
      action,
      one(action, READING_TOOLS.find((tool) => tool.name === toolName)!),
    ]),
  ),
});

/** Sixteen mastery tools (and the legacy subset) become one. */
export const mastery = actionTool({
  name: "mastery",
  description: "The whole Guided Learning loop: paths, modes, outlines, lessons, questions, grading and reviews. Call status first.",
  toolIcon: "🎯",
  actions: byName(MASTERY_TOOLS, "mastery_"),
});

/** Notebook CRUD, both tool sets, becomes one. */
const noteTools = notes_tools();
const writerTools = writer_tools();
export const notes = actionTool({
  name: "notes",
  description: "Read, search and edit notebook pages. Propose block edits with suggest, or apply page edits atomically with patch.",
  toolIcon: "📓",
  actions: Object.fromEntries(
    Object.entries({
      read: "note_read",
      suggest: "note_suggest",
      write: "write_note",
      search: "search_notes",
      nb_read: "nb_read",
      nb_list: "nb_list",
      nb_search: "nb_search",
      nb_patch: "nb_patch",
    }).map(([action, toolName]) => [
      action,
      one(
        action,
        [...noteTools, ...writerTools].find((tool) => tool.name === toolName)!,
      ),
    ]),
  ),
});

/** Knowledge base + attached-source retrieval becomes one. */
export const sources = actionTool({
  name: "sources",
  description: "Retrieve from the learner's knowledge bases and read attached sources.",
  toolIcon: "🔎",
  actions: {
    kb: one("kb", knowledge_base_search),
    read: one("read", read_source),
  },
});

/** All merged tools, for registration. */
export const MERGED_TOOLS: BaseTool[] = [
  obsidian,
  ima,
  marginnote,
  setup,
  subagent,
  propose,
  generate,
  solve,
  reading,
  mastery,
  notes,
  sources,
];
