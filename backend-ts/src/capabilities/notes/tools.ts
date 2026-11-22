// the notes capability's own
// tools: ``note_read``, ``note_suggest``, ``write_note``, ``search_notes``.
//
// Upstream injects ``_note_document_id`` / ``_note_read_state`` /
// ``_workspace_id`` into tool kwargs via ``NotesCapability.augment_kwargs``.
// In Praxis the turn binding already lives in context variables
// (src/agent/turn_context.ts), so the tools resolve the page from
// ``current_note_document_id`` (an explicit ``_note_document_id`` param still
// wins, mirroring the kwarg override) and keep the per-turn read snapshot in a
// ContextVar so ``note_suggest`` can enforce "read before edit".

import {
  ContextVar,
  current_note_document_id,
  current_workspace_id,
} from "../../agent/turn_context.js";
import {
  BaseTool,
  register_tool,
  type ToolParamsSchema,
} from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import { getCoWriterStorage } from "../../services/documents/storage.js";
import type { CoWriterStorage } from "../../services/documents/storage.js";
import { walk_blocks } from "../../services/documents/blocks.js";
import { propose } from "../../services/documents/proposals.js";
import type { Dict } from "../../shared/types.js";

export const NOTE_TOOL_NAMES = ["notes", "note_read", "note_suggest"] as const;
export const NOTES_OWN_TOOL_NAMES = [
  ...NOTE_TOOL_NAMES,
  "write_note",
  "search_notes",
] as const;

// Per-turn snapshot of the blocks note_read has seen (block_id → deep copy),
// used by note_suggest's expected_original conflict check. Null until the
// first note tool call in a turn creates it.
export const note_read_state = new ContextVar<Map<string, Dict> | null>(null);

function ensureReadState(): Map<string, Dict> {
  let state = note_read_state.get();
  if (state === null) {
    state = new Map();
    note_read_state.set(state);
  }
  return state;
}

/** Test/tooling hook: drop the per-turn read snapshot. */
export function reset_note_read_state(): void {
  note_read_state.set(null);
}

interface NoteToolParams extends Dict {
  _note_document_id?: string;
  _workspace_id?: string;
}

function boundDocId(params: NoteToolParams): string {
  return (
    String(params["_note_document_id"] ?? "") ||
    current_note_document_id.get()
  );
}

function boundWorkspaceId(params: NoteToolParams): string {
  return String(params["_workspace_id"] ?? "") || current_workspace_id.get();
}

function storage(): CoWriterStorage {
  return getCoWriterStorage();
}

function deepCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function previewText(value: unknown): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.slice(0, 300);
}

// ---------------------------------------------------------------------------
// note_read
// ---------------------------------------------------------------------------

export interface NoteReadParams {
  block_id?: string;
  _note_document_id?: string;
}

export const noteReadParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    block_id: {
      type: "string",
      description: "Optional block ID to read",
    },
  },
};

export class NoteReadTool extends BaseTool<NoteReadParams> {
  name = "note_read";
  toolIcon = "📖";
  params = noteReadParamsSchema;
  mutating = false;
  description =
    "Read the open notebook page with block IDs, structure and Markdown. " +
    "Large pages return an outline; read a specific block_id to inspect its body.";

  async execute(p: NoteReadParams): Promise<ToolResult> {
    const docId = boundDocId(p as NoteToolParams);
    if (!docId) {
      return fail("No notebook page is bound to this turn");
    }
    try {
      const doc = storage().loadDocument(docId);
      if (doc === null) throw new Error("Page not found");

      const state = ensureReadState();
      for (const block of walk_blocks((doc.blocks ?? []) as Dict[])) {
        if (!p.block_id || block["id"] === p.block_id) {
          state.set(String(block["id"] ?? ""), deepCopy(block));
        }
      }

      if (p.block_id) {
        const target = [...walk_blocks((doc.blocks ?? []) as Dict[])].find(
          (b) => b["id"] === p.block_id,
        );
        if (target === undefined) throw new Error("Block not found");
        return ok(
          JSON.stringify({
            page_id: doc.id,
            revision: doc.revision,
            block: target,
          }),
        );
      }
      if (JSON.stringify(doc.blocks ?? []).length > 80000) {
        return ok(
          JSON.stringify({
            id: doc.id,
            title: doc.title,
            revision: doc.revision,
            outline: [...walk_blocks((doc.blocks ?? []) as Dict[])].map((b) => ({
              id: b["id"],
              type: b["type"],
              preview: previewText(b["content"] ?? b["props"] ?? ""),
            })),
          }),
        );
      }
      return ok(JSON.stringify(doc));
    } catch (exc) {
      if (exc instanceof Error && exc.message === "Page not found") {
        return fail("Page not found");
      }
      if (exc instanceof Error && exc.message === "Block not found") {
        return fail("Block not found");
      }
      return fail(exc instanceof Error ? exc.message : String(exc));
    }
  }
}

// ---------------------------------------------------------------------------
// note_suggest
// ---------------------------------------------------------------------------

export interface NoteSuggestParams {
  operation: "insert" | "replace" | "delete" | "comment" | string;
  block_id?: string;
  markdown?: string;
  blocks?: Dict[] | null;
  explanation?: string;
  _note_document_id?: string;
  _workspace_id?: string;
}

export const noteSuggestParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: ["insert", "replace", "delete", "comment"],
      description: "Edit operation",
    },
    block_id: {
      type: "string",
      description: "Target block ID; empty inserts at the end",
    },
    markdown: {
      type: "string",
      description: "Suggested content in Markdown",
    },
    blocks: {
      type: "array",
      items: { type: "object" },
      description:
        "Optional complete BlockNote blocks, each with unique id, type, props, " +
        "content and children. For interactive learning blocks use type " +
        "learning, props kind (quiz or flashcards), data (JSON string with " +
        "questions [{question, options, correct_answer, explanation}] or " +
        "cards [{front, back}]), markdown (plain text projection), prompt. " +
        "Timeline data uses events [{date,title,description}]; concept_map " +
        "uses nodes and edges. Visualizations use kind=visualization and the " +
        "complete validated visualization result in data. Media uses " +
        "kind=media and workspace_items from the producing tool. Run code " +
        "with exec only if mounted and report real output as a comment. " +
        "Use Markdown for ordinary prose.",
    },
    explanation: {
      type: "string",
      description: "Why this edit, or teaching feedback with sources",
    },
  },
};

export class NoteSuggestTool extends BaseTool<NoteSuggestParams> {
  name = "note_suggest";
  toolIcon = "💡";
  params = noteSuggestParamsSchema;
  mutating = true;
  description =
    "Propose a block edit or teaching comment for user review. Does not " +
    "change the page until accepted. Text-only parent replacements preserve " +
    "existing child blocks; propose deletions of children separately.";

  async execute(p: NoteSuggestParams): Promise<ToolResult> {
    const docId = boundDocId(p as unknown as NoteToolParams);
    if (!docId) {
      return fail("No notebook page is bound to this turn");
    }
    try {
      const blockId = String(p.block_id ?? "");
      const expected: { expected_original?: Dict } = {};
      if (blockId) {
        const state = note_read_state.get();
        const snapshot = state?.get(blockId);
        if (snapshot === undefined) {
          throw new Error(
            "Use note_read to read the target block before suggesting changes",
          );
        }
        expected.expected_original = snapshot;
      }
      const result = propose(storage(), docId, {
        operation: String(p.operation),
        block_id: blockId,
        markdown: String(p.markdown ?? ""),
        explanation: String(p.explanation ?? ""),
        blocks: Array.isArray(p.blocks) ? (p.blocks as Dict[]) : null,
        workspace_id: boundWorkspaceId(p as unknown as NoteToolParams),
        ...expected,
      });
      return ok(
        JSON.stringify({
          suggestion_id: result.id,
          status: "pending_user_review",
        }),
      );
    } catch (exc) {
      return fail(exc instanceof Error ? exc.message : String(exc));
    }
  }
}

// ---------------------------------------------------------------------------
// write_note
// ---------------------------------------------------------------------------

export interface WriteNoteParams {
  title: string;
  content: string;
}

export const writeNoteParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["title", "content"],
  properties: {
    title: { type: "string", description: "Page title" },
    content: {
      type: "string",
      description:
        "Full authored Markdown, preserving citations and source links",
    },
  },
};

export class WriteNoteTool extends BaseTool<WriteNoteParams> {
  name = "write_note";
  toolIcon = "📝";
  params = writeNoteParamsSchema;
  mutating = true;
  description =
    "Create an authored notebook page. To preserve an original conversation " +
    "use save_favorite. Existing pages are edited through reviewable " +
    "note_suggest in their editor.";

  async execute(p: WriteNoteParams): Promise<ToolResult> {
    const title = String(p.title ?? "");
    const content = String(p.content ?? "");
    if (!title.trim() || !content.trim() || content.length > 200000) {
      return fail("Provide a title and content (up to 200000 characters)");
    }
    const doc = storage().createDocument({
      title: title.slice(0, 200),
      content,
    });
    return ok(
      JSON.stringify({ id: doc.id, title: doc.title, url: `/co-writer/${doc.id}` }),
    );
  }
}

// ---------------------------------------------------------------------------
// search_notes
// ---------------------------------------------------------------------------

export interface SearchNotesParams {
  query?: string;
  page_id?: string;
}

export const searchNotesParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Text to find" },
    page_id: { type: "string", description: "Page ID to read" },
  },
};

export class SearchNotesTool extends BaseTool<SearchNotesParams> {
  name = "search_notes";
  toolIcon = "🔍";
  params = searchNotesParamsSchema;
  mutating = false;
  description =
    "Find authored notebook pages by title or full text; returns excerpts " +
    "and page links. Empty query lists recent pages. Read a whole page with " +
    "page_id.";

  async execute(p: SearchNotesParams): Promise<ToolResult> {
    const store = storage();
    try {
      if (p.page_id) {
        const doc = store.loadDocument(String(p.page_id));
        return doc !== null
          ? ok(JSON.stringify({ title: doc.title, content: doc.content }))
          : fail("Page not found");
      }
      const query = String(p.query ?? "").toLowerCase();
      const results: Dict[] = [];
      for (const summary of store.listDocuments()) {
        const doc = store.loadDocument(summary.id);
        if (doc === null) continue;
        const text = `${doc.title}\n${doc.content}`;
        const pos = text.toLowerCase().indexOf(query);
        if (pos >= 0) {
          results.push({
            id: doc.id,
            title: doc.title,
            excerpt: text.slice(Math.max(0, pos - 100), pos + 600),
            url: `/co-writer/${doc.id}`,
          });
        }
        if (results.length >= 20) break;
      }
      return ok(JSON.stringify(results));
    } catch (exc) {
      return fail(exc instanceof Error ? exc.message : String(exc));
    }
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const note_read = new NoteReadTool();
export const note_suggest = new NoteSuggestTool();
export const write_note = new WriteNoteTool();
export const search_notes = new SearchNotesTool();

let _registered = false;

/** The capability's own tools, in upstream exposure order. */
export function notes_tools(): BaseTool[] {
  return [note_read, note_suggest, write_note, search_notes];
}

/** NOTE_TOOL_NAMES owns note_read/note_suggest; the other two are global. */
export function owned_tool_names(): readonly string[] {
  return NOTE_TOOL_NAMES;
}

export function register_notes_tools(): void {
  if (_registered) return;
  for (const t of notes_tools()) register_tool(t);
  _registered = true;
}
