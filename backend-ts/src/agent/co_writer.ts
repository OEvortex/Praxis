// The notebook pairing agent.
//
// The chat beside an open page and the sub-agent dispatched by the main
// assistant's ``notebook`` tool share one system prompt and one tool list.
// DeepTutor's favorites toolset (list_notebook / list_favorites /
// save_favorite) is the single source of truth; the old BlockNote ``nb_*``
// page tools are gone with the Co-Writer editor.

import { load_co_writer_prompt } from "./notebook_agent/prompt.js";
import {
  NOTEBOOK_TOOL_NAMES,
  notebook_tools,
  register_notebook_tools,
} from "./notebook_agent/notebook_tools.js";
import { notes_tools } from "../capabilities/notes/tools.js";
import { current_session_id, note_context } from "./turn_context.js";
import { getCoWriterStorage } from "../services/documents/storage.js";
import type { BaseTool } from "../shared/vtx.js";

// DeepTutor's notebook toolset: the three favorites tools plus the two
// global notes tools. The old `nb_*` BlockNote page tools are deliberately
// absent — the Co-Writer editor they served has been removed in favour of
// the favorites-style notebooks at /notebooks.
export const CO_WRITER_OWN_TOOL_NAMES = NOTEBOOK_TOOL_NAMES;
export const CO_WRITER_TOOL_NAMES = [
  ...NOTEBOOK_TOOL_NAMES,
  "write_note",
  "search_notes",
] as string[];

export const CO_WRITER_SYSTEM_PROMPT = load_co_writer_prompt();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when the running turn is bound to a Co-Writer page. */
export function is_co_writer_turn(): boolean {
  return Boolean(note_context()[0]);
}

/** Page/thread anchor and generation instructions for a notebook turn. */
export function notebook_context_block(
  page_id: string,
  session_id: string,
  block_id: string,
  kind: string,
): string {
  const parts: string[] = [];
  try {
    const storage = getCoWriterStorage();
    const doc = storage.loadDocument(page_id);
    if (doc !== null) {
      parts.push(`Open notebook page: "${doc.title}".`);
      // list_threads(storage, page_id) is a thin wrapper over the page's
      // "threads" extra; storage.loadExtra keeps this module independent of
      // the concurrently-ported threads.ts.
      const raw = storage.loadExtra(page_id, "threads", []);
      const threads = Array.isArray(raw) ? raw.filter(isRecord) : [];
      for (const thread of threads) {
        if (String(thread["session_id"] ?? "") !== session_id) continue;
        const quote = String(thread["quote"] ?? "").trim();
        if (quote) {
          parts.push(`The learner had selected: "${quote.slice(0, 600)}".`);
        }
        if (thread["block_id"]) {
          parts.push(
            '"Here", "this part" and "this sentence" mean that ' +
              "passage. Place material next to it and leave the rest of the page alone.",
          );
        }
        break;
      }
    }
  } catch {
    // Context must never block a turn.
  }
  if (block_id) {
    parts.push(
      `This turn fills learning block ${block_id} (kind ${kind || "chat"}) on the page. ` +
        "Use the favorites notebook tools to save the material as a record " +
        "(list_notebook first to find the right collection). In your visible " +
        "reply, describe only the learning material.",
    );
  }
  return parts.length ? "\n\n# This notebook thread\n\n" + parts.join("\n") : "";
}

/** The shared notebook toolset, in DeepTutor's exposure order. */
export function co_writer_tools(): BaseTool[] {
  register_notebook_tools();
  const notes = new Set(["write_note", "search_notes"]);
  return [
    ...(notebook_tools() as BaseTool[]),
    ...notes_tools().filter((tool) => notes.has(tool.name)),
  ];
}

export {
  current_session_id,
  load_co_writer_prompt,
};
