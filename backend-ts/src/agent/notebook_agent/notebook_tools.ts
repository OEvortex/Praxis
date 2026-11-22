//
// DeepTutor's notebook toolset, ported from
// reff/deeptutor/tools/{list_notebook,write_note}.py and
// reff/deeptutor/tools/builtin/__init__.py.
//
// These are the tools the main chat agent uses to work with favorites
// collections: list them, drill into one, page through a saved record,
// and save or patch a record. They replace the old BlockNote `nb_*`
// page tools, which belonged to the removed Co-Writer editor.
//
// The pure helpers are kept separate from the vtx tools so they can be
// unit-tested with a stubbed notebook manager, just like upstream.

import {
  BaseTool,
  register_tool,
  type ToolParamsSchema,
  type ToolResultLike,
} from "../../shared/vtx.js";
import {
  get_notebook_manager,
  type NotebookManager,
} from "../../services/notebook/service.js";
import type { Dict } from "../../shared/types.js";

const MAX_NOTEBOOKS_RENDERED = 50;
const MAX_RECORDS_RENDERED = 80;
const MAX_TITLE_PREVIEW = 100;
const MAX_SUMMARY_PREVIEW = 240;
const MAX_FAVORITE_BODY_PAGE_CHARS = 8_000;

const MAX_TITLE_CHARS = 200;
const MAX_NOTE_CHARS = 4_000;
const MAX_CONTENT_CHARS = 200_000;
const DEFAULT_TURNS_TO_INCLUDE = 3;

const VALID_MODES = ["append", "edit"] as const;

interface Outcome {
  ok: boolean;
  text: string;
  error: string;
  summary: Dict | null;
}

function ok(text = "", summary: Dict | null = null): Outcome {
  return { ok: true, text, error: "", summary };
}

function err(error: string): Outcome {
  return { ok: false, text: "", error, summary: null };
}

function clip(text: unknown, limit: number): string {
  const value = String(text ?? "").trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit).replace(/\s+$/, "") + "…";
}

function formatTimestamp(raw: unknown): string {
  const value = Number(raw ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    return new Date(value * 1000).toISOString().slice(0, 16).replace("T", " ");
  } catch {
    return "";
  }
}

function manager(): NotebookManager {
  return get_notebook_manager();
}

function validIds(notebooks: Dict[]): string {
  return notebooks.map((nb) => `\`${String(nb["id"] ?? "")}\``).join(", ") || "(none)";
}

// ---------------------------------------------------------------------------
// list_notebook — index mode and drill-down mode
// ---------------------------------------------------------------------------

export function listNotebooksOrRecords(
  notebook_id = "",
  mgr: NotebookManager = manager(),
): Outcome {
  const nid = String(notebook_id ?? "").trim();
  if (!nid) return renderIndex(mgr);
  return renderRecords(mgr, nid);
}

function renderIndex(mgr: NotebookManager): Outcome {
  const notebooks = mgr.list_notebooks() ?? [];
  if (!notebooks.length) {
    return ok("The user has no notebooks yet.", { mode: "index", count: 0 });
  }
  const total = notebooks.length;
  const sliced = notebooks.slice(0, MAX_NOTEBOOKS_RENDERED);
  const lines: string[] = ["**User notebooks**"];
  for (const nb of sliced) {
    const id = String(nb["id"] ?? "").trim();
    const name = String(nb["name"] ?? nb["title"] ?? "").trim() || id;
    const description = clip(nb["description"], 200);
    const count = Number(nb["record_count"] ?? 0) || 0;
    const updated = formatTimestamp(nb["updated_at"]);
    let bullet = `- \`${id}\` — **${name}** (${count} records`;
    if (updated) bullet += `, updated ${updated}`;
    bullet += ")";
    if (description) bullet += `\n  ${description}`;
    lines.push(bullet);
  }
  if (total > sliced.length) {
    lines.push(
      `\n_(showing ${sliced.length} of ${total} notebooks — call with a specific notebook_id to drill in.)_`,
    );
  }
  return ok(lines.join("\n"), { mode: "index", count: total });
}

function renderRecords(mgr: NotebookManager, notebookId: string): Outcome {
  const notebooks = mgr.list_notebooks() ?? [];
  const matched = notebooks.find(
    (nb) => String(nb["id"] ?? "").trim() === notebookId,
  );
  if (!matched) {
    return err(
      `Unknown notebook_id ${JSON.stringify(notebookId)}. Valid ids: ${validIds(notebooks)}.`,
    );
  }
  let records: Dict[];
  try {
    records = mgr.get_records(notebookId) ?? [];
  } catch (exc) {
    return err(`Failed to load records: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
  const name = String(matched["name"] ?? matched["title"] ?? notebookId);
  if (!records.length) {
    return ok(
      `Notebook **${name}** (\`${notebookId}\`) has no records yet.`,
      { mode: "records", notebook_id: notebookId, count: 0 },
    );
  }
  const total = records.length;
  const sorted = [...records].sort(
    (a, b) => Number(b["created_at"] ?? 0) - Number(a["created_at"] ?? 0),
  );
  const sliced = sorted.slice(0, MAX_RECORDS_RENDERED);
  const lines: string[] = [
    `**Records in notebook \`${notebookId}\` — ${name}**`,
  ];
  for (const rec of sliced) {
    const rid = String(rec["id"] ?? "").trim();
    const title = clip(rec["title"], MAX_TITLE_PREVIEW);
    const type = String(rec["type"] ?? "").trim();
    const summary = clip(rec["summary"], MAX_SUMMARY_PREVIEW);
    const created = formatTimestamp(rec["created_at"]);
    let head = `- \`${rid}\` — **${title || "(untitled)"}**`;
    if (type) head += ` [${type}]`;
    if (created) head += ` — ${created}`;
    lines.push(head);
    if (summary) lines.push(`  ${summary}`);
  }
  if (total > sliced.length) {
    lines.push(`\n_(showing ${sliced.length} most-recent of ${total} records.)_`);
  }
  return ok(lines.join("\n"), {
    mode: "records",
    notebook_id: notebookId,
    count: total,
  });
}

// ---------------------------------------------------------------------------
// list_favorites — paged record body reads
// ---------------------------------------------------------------------------

export function readFavoriteRecord(
  notebookId: string,
  recordId: string,
  offset = 0,
  mgr: NotebookManager = manager(),
): Outcome {
  if (!Number.isInteger(offset) || offset < 0) {
    return err("offset must be a non-negative integer.");
  }
  const nid = String(notebookId ?? "").trim();
  const rid = String(recordId ?? "").trim();
  if (!nid || !rid) return err("Both notebook_id and record_id are required.");
  let record: Dict | null;
  try {
    record = mgr.get_record(nid, rid, { read_only: true });
  } catch {
    return err("Failed to load favorite record.");
  }
  if (!record) return err("Unknown notebook_id or record_id.");

  const body = String(record["output"] ?? "");
  const total = body.length;
  if ((total === 0 && offset !== 0) || (total > 0 && offset >= total)) {
    return err(`offset ${offset} is outside the record body (${total} characters).`);
  }
  const page = body.slice(offset, offset + MAX_FAVORITE_BODY_PAGE_CHARS);
  const nextOffset =
    offset + page.length < total ? offset + page.length : null;
  const title = clip(record["title"], MAX_TITLE_PREVIEW);
  const summary = clip(record["summary"], MAX_SUMMARY_PREVIEW);
  const lines = [
    `**Favorite record \`${rid}\` — ${title || "(untitled)"}**`,
  ];
  if (summary) lines.push(`Summary: ${summary}`);
  lines.push(
    `Body characters ${offset}–${offset + page.length} of ${total}; next_offset: ${nextOffset}.`,
  );
  lines.push(page || "(This favorite record has an empty body.)");
  return ok(lines.join("\n\n"), {
    mode: "record",
    notebook_id: nid,
    record_id: rid,
    total_chars: total,
    offset,
    truncated: nextOffset !== null,
    next_offset: nextOffset,
  });
}

// ---------------------------------------------------------------------------
// save_favorite — append / edit records
// ---------------------------------------------------------------------------

interface WriteResult {
  ok: boolean;
  mode: string;
  record_id: string;
  notebook_id: string;
  notebook_name: string;
  error: string;
}

function writeFail(
  mode: string,
  error: string,
  notebookId = "",
  notebookName = "",
): WriteResult {
  return {
    ok: false,
    mode,
    record_id: "",
    notebook_id: notebookId,
    notebook_name: notebookName,
    error,
  };
}

function coerceText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Dict => typeof part === "object" && part !== null)
      .filter((part) => String(part["type"] ?? "") === "text")
      .map((part) => String(part["text"] ?? ""))
      .join("\n")
      .trim();
  }
  return String(content ?? "").trim();
}

function formatTranscript(
  history: Dict[],
  currentUserMessage: string,
  turns: number | null,
): string {
  const pairs: Array<[string, string]> = [];
  let pendingUser: string | null = null;
  for (const entry of history) {
    const role = String(entry["role"] ?? "").trim().toLowerCase();
    const text = coerceText(entry["content"]);
    if (!text) continue;
    if (role === "user") {
      if (pendingUser !== null) pairs.push([pendingUser, ""]);
      pendingUser = text;
    } else if (role === "assistant") {
      pairs.push([pendingUser ?? "", text]);
      pendingUser = null;
    }
  }
  if (pendingUser !== null) pairs.push([pendingUser, ""]);
  if (currentUserMessage) pairs.push([currentUserMessage, ""]);

  const selected = turns === null ? pairs : pairs.slice(-Math.max(1, turns));
  const blocks: string[] = [];
  for (const [userText, assistantText] of selected) {
    if (userText) blocks.push(`### User\n\n${userText}`);
    if (assistantText) {
      blocks.push(`### Assistant\n\n${assistantText}`);
    } else if (userText) {
      blocks.push("### Assistant\n\n_(assistant response in progress)_");
    }
  }
  return blocks.join("\n\n---\n\n");
}

function coerceTurns(raw: unknown): number | null {
  if (typeof raw === "string" && raw.trim().toLowerCase() === "all") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TURNS_TO_INCLUDE;
  return Math.max(1, Math.floor(value));
}

function lastUserMessage(history: Dict[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (String(history[i]["role"] ?? "").toLowerCase() === "user") {
      return coerceText(history[i]["content"]);
    }
  }
  return "";
}

function summaryFromTranscript(transcript: string): string {
  const first = transcript.split(/\n+/).find((line) => line.trim()) ?? "";
  return clip(first, 240);
}

export function writeNote(
  opts: {
    mode?: string;
    notebook_id?: string;
    record_id?: string;
    title?: string;
    content?: string;
    turns_to_include?: unknown;
    note?: string;
    conversation_history?: Dict[];
    current_user_message?: string;
  },
  mgr: NotebookManager = manager(),
): WriteResult {
  const mode = String(opts.mode ?? "").trim().toLowerCase();
  if (!VALID_MODES.includes(mode as (typeof VALID_MODES)[number])) {
    return writeFail(mode, `Unknown mode ${JSON.stringify(opts.mode)}. Use one of: ${VALID_MODES.join(", ")}.`);
  }
  const nid = String(opts.notebook_id ?? "").trim();
  if (!nid) return writeFail(mode, "notebook_id is required.");

  const notebooks = mgr.list_notebooks() ?? [];
  if (!notebooks.length) {
    return writeFail(mode, "No notebooks are available for this user.");
  }
  const matched = notebooks.find((nb) => String(nb["id"] ?? "").trim() === nid);
  if (!matched) {
    return writeFail(
      mode,
      `Unknown notebook_id ${JSON.stringify(nid)}. Valid ids: ${validIds(notebooks)}.`,
    );
  }
  const notebookName = String(matched["name"] ?? matched["title"] ?? nid);

  if (mode === "append") {
    let title = String(opts.title ?? "").trim();
    if (!title) {
      return writeFail(mode, "title must not be empty in append mode.", nid, notebookName);
    }
    if (title.length > MAX_TITLE_CHARS) {
      title = title.slice(0, MAX_TITLE_CHARS).replace(/\s+$/, "") + "…";
    }
    let note = String(opts.note ?? "").trim();
    if (note.length > MAX_NOTE_CHARS) {
      note = note.slice(0, MAX_NOTE_CHARS).replace(/\s+$/, "") + "…";
    }
    const explicitContent = String(opts.content ?? "").trim();
    const history = Array.isArray(opts.conversation_history)
      ? opts.conversation_history
      : [];
    const currentUserMessage = String(opts.current_user_message ?? "").trim();
    const transcript = explicitContent ||
      formatTranscript(history, currentUserMessage, coerceTurns(opts.turns_to_include));
    if (!transcript.trim()) {
      return writeFail(
        mode,
        "Nothing to save: the chat history is empty and no explicit content was provided.",
        nid,
        notebookName,
      );
    }
    const parts: string[] = [];
    if (note) parts.push(`**Note:** ${note}`);
    parts.push(transcript);
    let output = parts.join("\n\n---\n\n").trim();
    if (output.length > MAX_CONTENT_CHARS) {
      output = output.slice(0, MAX_CONTENT_CHARS).replace(/\s+$/, "") + "\n…[truncated]";
    }
    const userQuery = currentUserMessage || lastUserMessage(history);
    let added: { record: Dict; added_to_notebooks: string[] };
    try {
      added = mgr.add_record({
        notebook_ids: [nid],
        record_type: "chat",
        title,
        user_query: userQuery,
        output,
        summary: note || summaryFromTranscript(transcript),
        metadata: {
          source: "save_favorite_tool",
          mode: "append",
          note_provided: Boolean(note),
          explicit_content: Boolean(explicitContent),
        },
      });
    } catch (exc) {
      return writeFail(
        mode,
        `Save failed: ${exc instanceof Error ? exc.message : String(exc)}`,
        nid,
        notebookName,
      );
    }
    const record = added?.record ?? {};
    const recordId = String(record["id"] ?? "");
    if (!recordId) {
      return writeFail(mode, "Notebook service did not return a record id.", nid, notebookName);
    }
    if (!added.added_to_notebooks?.includes(nid)) {
      return writeFail(
        mode,
        `Notebook ${JSON.stringify(notebookName)} did not accept the record. Its file may be missing or damaged.`,
        nid,
        notebookName,
      );
    }
    return {
      ok: true,
      mode,
      record_id: recordId,
      notebook_id: nid,
      notebook_name: notebookName,
      error: "",
    };
  }

  // edit mode — favorites preserve the original body unless `content` is given.
  const rid = String(opts.record_id ?? "").trim();
  if (!rid) {
    return writeFail(mode, "record_id is required in edit mode.", nid, notebookName);
  }
  if (String(opts.content ?? "").trim()) {
    return writeFail(
      mode,
      "Favorites preserve original content; add to a notebook page to edit.",
      nid,
      notebookName,
    );
  }
  let existing: Dict | null;
  try {
    existing = mgr.get_record(nid, rid);
  } catch (exc) {
    return writeFail(
      mode,
      `Could not read notebook ${JSON.stringify(notebookName)}: ${exc instanceof Error ? exc.message : String(exc)}`,
      nid,
      notebookName,
    );
  }
  if (!existing) {
    return writeFail(
      mode,
      `Record ${JSON.stringify(rid)} not found in notebook ${JSON.stringify(nid)}. Call list_favorites first to discover valid record ids.`,
      nid,
      notebookName,
    );
  }
  let title = String(opts.title ?? "").trim();
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).replace(/\s+$/, "") + "…";
  }
  const note = String(opts.note ?? "").trim();
  const changes: Dict = {};
  if (title) changes.title = title;
  if (note) changes.summary = note.slice(0, MAX_NOTE_CHARS);
  if (!Object.keys(changes).length) {
    return writeFail(
      mode,
      "edit mode requires at least one of `title` or `note` to change.",
      nid,
      notebookName,
    );
  }
  try {
    const updated = mgr.update_record(nid, rid, changes);
    if (!updated) throw new Error("record vanished");
  } catch (exc) {
    return writeFail(
      mode,
      `Edit failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      nid,
      notebookName,
    );
  }
  return {
    ok: true,
    mode,
    record_id: rid,
    notebook_id: nid,
    notebook_name: notebookName,
    error: "",
  };
}

// ---------------------------------------------------------------------------
// vtx tools
// ---------------------------------------------------------------------------

function toolOk(text: string, extra: Dict = {}): ToolResultLike {
  return { success: true, result: text, ...extra };
}

function toolFail(text: string): ToolResultLike {
  return { success: false, result: text };
}

export interface ListNotebookParams {
  notebook_id?: string;
}

const listNotebookSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    notebook_id: {
      type: "string",
      description:
        "Leave empty to list all favorites collections; supply an id to list the records inside one.",
    },
  },
};

export class ListNotebookTool extends BaseTool<ListNotebookParams> {
  name = "list_notebook";
  toolIcon = "📚";
  mutating = false;
  description =
    "List the user's favorites notebooks, or the records inside one. " +
    "Call with no arguments for the index, then with notebook_id to drill down.";
  params = listNotebookSchema;

  async execute(params: ListNotebookParams): Promise<ToolResultLike> {
    const outcome = listNotebooksOrRecords(params.notebook_id ?? "");
    if (!outcome.ok) return toolFail(outcome.error);
    return toolOk(outcome.text, { notebooks: outcome.summary ?? {} });
  }
}

export interface ListFavoritesParams {
  notebook_id?: string;
  record_id?: string;
  offset?: number;
}

const listFavoritesSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    notebook_id: { type: "string", description: "Favorites collection id." },
    record_id: { type: "string", description: "Record id to read." },
    offset: {
      type: "number",
      description: "Character offset into the record body (pages of 8000).",
      default: 0,
    },
  },
  required: ["notebook_id", "record_id"],
};

export class ListFavoritesTool extends BaseTool<ListFavoritesParams> {
  name = "list_favorites";
  toolIcon = "⭐";
  mutating = false;
  description =
    "Read one saved favorite record's body in pages of 8000 characters. " +
    "Use list_notebook first to discover notebook_id and record_id.";
  params = listFavoritesSchema;

  async execute(params: ListFavoritesParams): Promise<ToolResultLike> {
    const outcome = readFavoriteRecord(
      String(params.notebook_id ?? ""),
      String(params.record_id ?? ""),
      Number.isFinite(Number(params.offset)) ? Number(params.offset) : 0,
    );
    if (!outcome.ok) return toolFail(outcome.error);
    return toolOk(outcome.text, { favorites: outcome.summary ?? {} });
  }
}

export interface SaveFavoriteParams {
  mode?: string;
  notebook_id?: string;
  record_id?: string;
  title?: string;
  content?: string;
  turns_to_include?: unknown;
  note?: string;
  conversation_history?: Dict[];
  current_user_message?: string;
}

const saveFavoriteSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["append", "edit"],
      description: "'append' creates a new record; 'edit' patches an existing one.",
    },
    notebook_id: { type: "string", description: "Target favorites collection id." },
    record_id: { type: "string", description: "Required for mode='edit'." },
    title: { type: "string", description: "Short title (append) or new title (edit)." },
    content: {
      type: "string",
      description: "Append: optional agent-authored body. Edit: must be omitted.",
    },
    turns_to_include: {
      type: "string",
      description: "Append only: recent user+assistant turns to save, or 'all'. Default '3'.",
    },
    note: { type: "string", description: "One-paragraph note / summary." },
  },
  required: ["mode", "notebook_id"],
};

export class SaveFavoriteTool extends BaseTool<SaveFavoriteParams> {
  name = "save_favorite";
  toolIcon = "💾";
  mutating = true;
  description =
    "Save a new favorite record or edit an existing one. In append mode the " +
    "real recent chat transcript is saved unless `content` is supplied. " +
    "In edit mode only the title and note can change — favorites preserve " +
    "their original body.";
  params = saveFavoriteSchema;

  async execute(params: SaveFavoriteParams): Promise<ToolResultLike> {
    const outcome = writeNote(params);
    if (!outcome.ok) return toolFail(outcome.error);
    const action = outcome.mode === "append" ? "Saved new record" : "Updated record";
    return toolOk(
      `${action} in favorites collection ${JSON.stringify(outcome.notebook_name)} (record id: ${outcome.record_id}).`,
      {
        mode: outcome.mode,
        record_id: outcome.record_id,
        notebook_id: outcome.notebook_id,
        notebook_name: outcome.notebook_name,
      },
    );
  }
}

export const list_notebook = new ListNotebookTool();
export const list_favorites = new ListFavoritesTool();
export const save_favorite = new SaveFavoriteTool();

export const NOTEBOOK_TOOL_NAMES = [
  "list_notebook",
  "list_favorites",
  "save_favorite",
] as const;

export function notebook_tools(): BaseTool[] {
  return [list_notebook, list_favorites, save_favorite];
}

let _registered = false;

export function register_notebook_tools(): void {
  if (_registered) return;
  for (const tool of notebook_tools()) register_tool(tool);
  _registered = true;
}
