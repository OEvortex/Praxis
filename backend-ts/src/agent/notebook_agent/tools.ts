//
// Co-writer's tool surface, shared by the notebook chat and the sub-agent.
//
// Co-writer's output is the notebook itself: pages are edited directly with
// ``nb_patch`` (create/update/delete/move), and ``nb_read``/``nb_list``/
// ``nb_search`` keep it from duplicating existing notes. The shared research
// tools cover outside material. The same list is used by the sub-agent the main
// assistant dispatches through its ``notebook`` tool.
//
// These tools are registered into vtx's global tool registry (not the main
// agent's explicit tool list) so a ``SubagentSpec`` can select exactly them via
// ``tools_allow``.

import { BaseTool, ToolResultLike, ToolParamsSchema } from "../../shared/vtx.js";

import { get_co_writer_storage, RevisionConflict } from "../../services/documents/storage.js";

import {
  blocks_to_markdown,
  coarse_markdown_to_blocks,
  resolve_image_queries,
  walk_blocks,
} from "../../services/documents/blocks.js";

// shared_tools(); both modules are ported — accessed loosely in case export
// names differ (snake_case vs camelCase).
import * as dt_tools from "../dt_tools.js";
import * as kb_tools from "../kb_tools.js";

// vtx global tool registry lives in shared/vtx.ts.
import { register_tool } from "../../shared/vtx.js";

// ---------------------------------------------------------------------------
// Local structural types (mirror the wire models / storage row shapes)
// ---------------------------------------------------------------------------

// TODO(verify): replace with exported types from services/documents/* once
// those modules land; kept structural so this file compiles standalone.
export interface BlockLike {
  id?: string;
  type?: string;
  text?: unknown;
  content?: unknown[];
  children?: BlockLike[];
  props?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CoWriterDocumentLike {
  id: string;
  title?: string;
  content?: string;
  blocks?: BlockLike[] | null;
  revision?: number;
  parent_id?: string | null;
  [k: string]: unknown;
}

export interface CoWriterDocumentSummaryLike {
  id: string;
  title?: string;
  parent_id?: string | null;
  [k: string]: unknown;
}

interface CoWriterStorageLike {
  load_document(id: string): CoWriterDocumentLike | null;
  list_documents(): CoWriterDocumentSummaryLike[];
  create_document(opts: {
    title?: string | null;
    content?: string;
    blocks?: BlockLike[] | null;
    parent_id?: string | null;
    tags?: string[] | null;
  }): CoWriterDocumentLike;
  update_document(id: string, opts: Record<string, unknown>): unknown;
  delete_document(id: string, cascade?: boolean): boolean;
}

// TODO(verify): storage.ts currently exposes camelCase methods
// (loadDocument/createDocument/...) although its header comment claims the
// snake_case surface; accept either naming so this keeps working.
function _method(s: Record<string, any>, snake: string, camel: string): (...args: any[]) => any {
  const fn = s[snake] ?? s[camel];
  if (typeof fn !== "function") {
    throw new Error(`CoWriterStorage is missing ${snake}`);
  }
  return fn.bind(s);
}

function _ok(text: string): ToolResultLike {
  return { success: true, result: text };
}

function _fail(text: string): ToolResultLike {
  return { success: false, result: text };
}

function _storage(): CoWriterStorageLike {
  const s = get_co_writer_storage() as unknown as Record<string, any>;
  return {
    load_document: (id: string) =>
      _method(s, "load_document", "loadDocument")(id) as CoWriterDocumentLike | null,
    list_documents: () =>
      _method(s, "list_documents", "listDocuments")() as CoWriterDocumentSummaryLike[],
    create_document: (opts) =>
      _method(s, "create_document", "createDocument")(opts) as CoWriterDocumentLike,
    update_document: (id: string, opts: Record<string, unknown>) =>
      _method(s, "update_document", "updateDocument")(id, opts),
    delete_document: (id: string, cascade = false) =>
      _method(s, "delete_document", "deleteDocument")(id, cascade) as boolean,
  };
}

function isRevisionConflict(err: unknown): boolean {
  if (err instanceof RevisionConflict) return true;
  // TODO(verify): fall back to name checks in case the TS port does not keep
  // RevisionConflict a real class.
  const name = (err as { constructor?: { name?: string }; name?: string })?.constructor?.name
    ?? (err as { name?: string })?.name;
  return name === "RevisionConflict";
}

function has_blocks(doc: CoWriterDocumentLike): boolean {
  return Array.isArray(doc.blocks) && doc.blocks.length > 0;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return haystack.length + 1;
  let count = 0;
  let i = 0;
  for (;;) {
    i = haystack.indexOf(needle, i);
    if (i === -1) return count;
    count += 1;
    i += needle.length;
  }
}

function replaceFirstLiteral(s: string, oldStr: string, newStr: string): string {
  const i = s.indexOf(oldStr);
  if (i === -1) return s;
  return s.slice(0, i) + newStr + s.slice(i + oldStr.length);
}

function pyRepr(s: string): string {
  return JSON.stringify(s);
}

// ---------------------------------------------------------------------------
// Params + tools
// ---------------------------------------------------------------------------

export interface NbReadParams {
  page_id: string;
  offset?: number | null;
  limit?: number | null;
}

const nbReadSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    page_id: { type: "string", description: "Page id to read.", required: true },
    offset: { type: "number", description: "Start line of the Markdown body (1-based)." },
    limit: { type: "number", description: "Number of body lines to return." },
  },
  required: ["page_id"],
};

export class NbReadTool extends BaseTool<NbReadParams> {
  name = "nb_read";
  toolIcon = "📖";
  mutating = false;
  description =
    "Read a notebook page by id: title, block outline and Markdown body. " +
    "Use offset/limit to paginate large pages. Use before writing about " +
    "a topic the learner may already have notes on.";
  params = nbReadSchema;

  async execute(params: NbReadParams): Promise<ToolResultLike> {
    const doc = _storage().load_document(params.page_id.trim());
    if (doc == null) {
      return _fail("No notebook page with that id.");
    }
    const lines = [`Title: ${doc.title ?? ""}`, `Id: ${doc.id}`];
    if (doc.parent_id) {
      lines.push(`Parent: ${doc.parent_id}`);
    }
    let body: string;
    if (has_blocks(doc)) {
      const blocks = doc.blocks as BlockLike[];
      for (const block of walk_blocks(blocks) as Iterable<BlockLike>) {
        const text = ((block.content ?? []) as unknown[])
          .filter((b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null)
          .map((b) => String(b["text"] ?? ""))
          .join(" ");
        lines.push(`${block.id} | ${block.type} | ${text.slice(0, 160)}`);
      }
      body = blocks_to_markdown(blocks) as string;
    } else {
      body = doc.content || "";
    }
    const bodyLines = body.split(/\r?\n/);
    const total = bodyLines.length;
    const start = Math.max(1, params.offset ?? 1);
    const end = params.limit == null ? total : Math.min(total, start + params.limit - 1);
    const header = lines.join("\n");
    if (start > total) {
      return _ok(`${header}\n\n--- Markdown (lines 1-${total} of ${total}) ---\n`);
    }
    const window = bodyLines.slice(start - 1, end).join("\n");
    let rangeNote = `lines ${start}-${end} of ${total}`;
    if (end < total) {
      rangeNote += ` — call again with offset=${end + 1} for more`;
    }
    return _ok(`${header}\n\n--- Markdown (${rangeNote}) ---\n${window}`);
  }
}

export interface NbListParams {
  query?: string;
  limit?: number;
}

const nbListSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Case-insensitive title substring.", default: "" },
    limit: { type: "number", description: "Maximum pages to return.", default: 40 },
  },
};

export class NbListTool extends BaseTool<NbListParams> {
  name = "nb_list";
  toolIcon = "📚";
  mutating = false;
  description = "List notebook pages (id | title | parent), optionally filtered.";
  params = nbListSchema;

  async execute(params: NbListParams): Promise<ToolResultLike> {
    const needle = (params.query ?? "").trim().toLowerCase();
    const rows: string[] = [];
    for (const summary of _storage().list_documents()) {
      const title = summary.title || "Untitled";
      if (needle && !title.toLowerCase().includes(needle)) {
        continue;
      }
      const parent = summary.parent_id ? ` <- ${summary.parent_id}` : "";
      rows.push(`${summary.id} | ${title}${parent}`);
      if (rows.length >= Math.max(1, Math.min(params.limit ?? 40, 200))) {
        break;
      }
    }
    return _ok(rows.length ? rows.join("\n") : "No matching notebook pages.");
  }
}

export interface NbSearchParams {
  query: string;
  limit?: number;
}

const nbSearchSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Text to find in page titles or content.", required: true },
    limit: { type: "number", description: "Maximum pages to return.", default: 10 },
  },
  required: ["query"],
};

export class NbSearchTool extends BaseTool<NbSearchParams> {
  name = "nb_search";
  toolIcon = "🔎";
  mutating = false;
  description = "Search notebook pages by title and body text.";
  params = nbSearchSchema;

  async execute(params: NbSearchParams): Promise<ToolResultLike> {
    const needle = params.query.trim().toLowerCase();
    if (!needle) {
      return _fail("nb_search needs a query.");
    }
    const storage = _storage();
    const hits: string[] = [];
    for (const summary of storage.list_documents()) {
      const doc = storage.load_document(summary.id);
      if (doc == null) {
        continue;
      }
      const haystack = `${doc.title ?? ""}\n${doc.content ?? ""}`.toLowerCase();
      const index = haystack.indexOf(needle);
      if (index < 0) {
        continue;
      }
      const snippet = (doc.content ?? "")
        .slice(Math.max(0, index - 80), index + 200)
        .replace(/\n/g, " ");
      hits.push(`[${doc.id}] ${doc.title ?? ""} …${snippet}…`);
      if (hits.length >= Math.max(1, Math.min(params.limit ?? 10, 50))) {
        break;
      }
    }
    return _ok(hits.length ? hits.join("\n\n") : "No matching notebook pages.");
  }
}

// ---------------------------------------------------------------------------
// nb_patch — atomic multi-op page edits (apply_patch style)
// ---------------------------------------------------------------------------

export interface NbPatchEdit {
  old: string;
  new: string;
  replace_all?: boolean;
}

export type NbPatchOpKind = "update" | "create" | "delete" | "move";

export interface NbPatchOp {
  op: NbPatchOpKind;
  page?: string;
  edits?: NbPatchEdit[] | null;
  old?: string | null;
  new?: string | null;
  replace_all?: boolean;
  content?: string | null;
  append?: string | null;
  parent?: string | null;
  new_title?: string | null;
}

export interface NbPatchParams {
  ops: NbPatchOp[];
}

// A resolved page reference: either a stored document or a virtual page
// created earlier in the same patch.
interface VirtualEntry {
  op: NbPatchOp;
  title: string;
  content: string;
  parent: PageHit | null;
  deleted: boolean;
}

type PageHit =
  | { kind: "real"; target: CoWriterDocumentLike }
  | { kind: "virtual"; target: VirtualEntry };

function _resolve_page(storage: CoWriterStorageLike, ref: string): CoWriterDocumentLike | null {
  const trimmed = (ref || "").trim();
  if (!trimmed) {
    return null;
  }
  const doc = storage.load_document(trimmed);
  if (doc != null) {
    return doc;
  }
  const needle = trimmed.toLowerCase();
  const summaries = storage.list_documents();
  const exact = summaries
    .map((s) => storage.load_document(s.id))
    .filter((d): d is CoWriterDocumentLike => d != null)
    .filter((d) => (d.title || "").trim().toLowerCase() === needle);
  if (exact.length === 1) {
    return exact[0];
  }
  const partial = summaries
    .map((s) => storage.load_document(s.id))
    .filter((d): d is CoWriterDocumentLike => d != null)
    .filter((d) => (d.title || "").toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0] : null;
}

function _page_markdown(doc: CoWriterDocumentLike): string {
  if (has_blocks(doc)) {
    return blocks_to_markdown(doc.blocks as BlockLike[]) as string;
  }
  return doc.content || "";
}

// Returns [newBody, error] — error non-null on failure.
function _apply_text_edits(
  body: string,
  edits: NbPatchEdit[],
): [string | null, string | null] {
  let current = body;
  for (const edit of edits) {
    if (edit.old === edit.new) {
      return [null, "old and new must differ."];
    }
    const count = countOccurrences(current, edit.old);
    if (count === 0) {
      return [null, `old_string not found: ${pyRepr(edit.old.slice(0, 80))}`];
    }
    if (!edit.replace_all && count > 1) {
      return [
        null,
        `old_string matches ${count} places; add more context or set replace_all.`,
      ];
    }
    current = edit.replace_all
      ? current.split(edit.old).join(edit.new)
      : replaceFirstLiteral(current, edit.old, edit.new);
  }
  return [current, null];
}

const nbPatchSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      description:
        "Page operations applied in order. Every op is validated " +
        "before anything is written; one failure aborts the whole patch.",
      required: true,
      items: { type: "object" },
    },
  },
  required: ["ops"],
};

export class NbPatchTool extends BaseTool<NbPatchParams> {
  name = "nb_patch";
  toolIcon = "🩹";
  mutating = true;
  description =
    "Apply page edits atomically, apply_patch style. ops: 'update' (page + " +
    "edits[] or old/new/replace_all — exact-match Markdown edits), 'create' " +
    "(page = new page title, content = body, parent = parent page title/id), " +
    "'delete' (page — deletes the page and all its subpages), 'move' (page + parent and/or new_title). All ops are " +
    "validated first; any failure writes nothing. Pages created earlier in " +
    "the same patch can be referenced by title.";
  params = nbPatchSchema;

  async execute(params: NbPatchParams): Promise<ToolResultLike> {
    const storage = _storage();

    // Virtual pages let later ops reference pages created earlier in the
    // same patch (create hub, then children under it, then edit them).
    // key: lowercase title -> VirtualEntry
    const virtual = new Map<string, VirtualEntry>();

    const resolve = (ref: string): PageHit | null => {
      const doc = _resolve_page(storage, ref);
      if (doc != null) {
        return { kind: "real", target: doc };
      }
      const entry = virtual.get((ref || "").trim().toLowerCase());
      return entry ? { kind: "virtual", target: entry } : null;
    };

    const resolve_parent = (ref: string): PageHit | null => resolve(ref);

    // Pass 1: validate everything, building the plan + virtual overlay.
    // plan payload shapes:
    //   create  -> VirtualEntry
    //   update  -> [kind, target, newBody]
    //   move    -> [kind, target, parentHit]
    //   delete  -> [kind, target, null]
    const plan: Array<{ op: NbPatchOp; target: any }> = [];
    const errors: string[] = [];
    const ops = params.ops ?? [];
    for (let index = 0; index < ops.length; index++) {
      const op = ops[index];
      const tag = `op${index + 1}(${op.op})`;
      try {
        if (op.op === "create") {
          const title = (op.page || "").trim();
          if (!title) {
            errors.push(`${tag}: create needs a title in 'page'.`);
            continue;
          }
          let parent: PageHit | null = null;
          if (op.parent) {
            parent = resolve_parent(op.parent);
            if (parent == null) {
              errors.push(`${tag}: parent page not found: ${pyRepr(op.parent)}`);
              continue;
            }
          }
          const entry: VirtualEntry = {
            op,
            title,
            content: op.content || "",
            parent,
            deleted: false,
          };
          virtual.set(title.toLowerCase(), entry);
          plan.push({ op, target: entry });
          continue;
        }

        const hit = resolve(op.page || "");
        if (hit == null) {
          errors.push(`${tag}: page not found: ${pyRepr(op.page ?? "")}`);
          continue;
        }
        const { kind, target } = hit;

        if (op.op === "update") {
          const edits: NbPatchEdit[] = [...(op.edits ?? [])];
          if (op.old != null || op.new != null) {
            if (op.old == null || op.new == null) {
              errors.push(`${tag}: old and new must be given together.`);
              continue;
            }
            edits.unshift({
              old: op.old,
              new: op.new,
              replace_all: op.replace_all ?? false,
            });
          }
          const body =
            kind === "real"
              ? _page_markdown(target as CoWriterDocumentLike)
              : (target as VirtualEntry).content;
          let newBody: string;
          if (op.content != null) {
            newBody = op.content;
          } else if (op.append != null) {
            newBody = body.replace(/\s+$/, "") + "\n\n" + op.append;
          } else {
            if (edits.length === 0) {
              errors.push(`${tag}: update needs edits[] or old/new.`);
              continue;
            }
            const [applied, err] = _apply_text_edits(body, edits);
            if (err) {
              errors.push(`${tag}: ${err}`);
              continue;
            }
            newBody = applied as string;
          }
          if (kind === "virtual") {
            (target as VirtualEntry).content = newBody;
          }
          plan.push({ op, target: [kind, target, newBody] });
        } else if (op.op === "move") {
          let parent: PageHit | null = null;
          const has_parent = op.parent != null;
          if (has_parent && (op.parent as string).trim()) {
            parent = resolve_parent(op.parent as string);
            if (parent == null) {
              errors.push(`${tag}: parent page not found: ${pyRepr(op.parent ?? "")}`);
              continue;
            }
          }
          if (kind === "virtual") {
            const entry = target as VirtualEntry;
            entry.parent = has_parent ? parent : entry.parent;
            if (op.new_title) {
              entry.title = op.new_title.trim();
            }
          }
          plan.push({ op, target: [kind, target, parent] });
        } else {
          // delete
          if (kind === "virtual") {
            // Cascade through virtual children created in this patch.
            const entry = target as VirtualEntry;
            const doomedTitles = new Set<string>([entry.title.toLowerCase()]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const other of virtual.values()) {
                if (other.deleted) continue;
                const p = other.parent;
                if (
                  p &&
                  p.kind === "virtual" &&
                  doomedTitles.has((p.target as VirtualEntry).title.toLowerCase())
                ) {
                  other.deleted = true;
                  doomedTitles.add(other.title.toLowerCase());
                  changed = true;
                }
              }
            }
            entry.deleted = true;
          }
          plan.push({ op, target: [kind, target, null] });
        }
      } catch (exc) {
        // noqa: BLE001 equivalent — validation must not throw
        errors.push(`${tag}: ${exc instanceof Error ? exc.message : String(exc)}`);
      }
    }
    if (errors.length) {
      return _fail("Patch aborted — nothing was written:\n" + errors.join("\n"));
    }

    // Pass 2: write in order, tracking created pages for parent refs.
    const created = new Map<string, string>(); // lowercase title -> doc id
    const results: string[] = [];

    const parent_id_of = (parent: PageHit | null): string | null => {
      if (parent == null) {
        return null;
      }
      if (parent.kind === "real") {
        return (parent.target as CoWriterDocumentLike).id;
      }
      return created.get((parent.target as VirtualEntry).title.toLowerCase()) ?? null;
    };

    for (const { op, target } of plan) {
      try {
        if (op.op === "create") {
          const entry = target as VirtualEntry;
          if (entry.deleted) {
            continue;
          }
          const createContent = entry.content;
          // Pages with ```noteui programs need real blocks now — the
          // client-side Markdown parser does not know the DSL.
          const createBlocks = /^\s*`{3,}(noteui|nb|note)\b/im.test(createContent)
            ? (coarse_markdown_to_blocks(createContent) as BlockLike[])
            : null;
          if (createBlocks) {
            await resolve_image_queries(createBlocks);
          }
          const doc = storage.create_document({
            title: entry.title || null,
            content: createContent,
            blocks: createBlocks,
            parent_id: parent_id_of(entry.parent),
          });
          created.set(entry.title.toLowerCase(), doc.id);
          results.push(`created "${doc.title ?? entry.title}" (${doc.id})`);
          continue;
        }
        const [kind, docOrEntry, payload] = target as [string, any, any];
        if (kind === "virtual") {
          continue; // folded into its create op
        }
        let doc = docOrEntry as CoWriterDocumentLike;
        if (op.op === "update") {
          const newBody = payload as string;
          const newBlocks = coarse_markdown_to_blocks(newBody) as BlockLike[];
          await resolve_image_queries(newBlocks);
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              storage.update_document(doc.id, {
                blocks: newBlocks,
                expected_revision: doc.revision,
              });
              break;
            } catch (err) {
              if (!isRevisionConflict(err)) throw err;
              const fresh = storage.load_document(doc.id);
              if (fresh == null) {
                throw new Error("page vanished mid-patch");
              }
              doc = fresh;
            }
          }
          results.push(`updated "${doc.title ?? ""}" (${doc.id})`);
        } else if (op.op === "move") {
          const kwargs: Record<string, unknown> = {};
          if (op.new_title) {
            kwargs["title"] = op.new_title;
          }
          if (op.parent != null) {
            kwargs["parent_id"] = parent_id_of(payload as PageHit | null);
          }
          if (Object.keys(kwargs).length) {
            storage.update_document(doc.id, kwargs);
          }
          results.push(`moved "${doc.title ?? ""}" (${doc.id})`);
        } else {
          // delete
          storage.delete_document(doc.id, true);
          results.push(`deleted "${doc.title ?? ""}" (${doc.id})`);
        }
      } catch (exc) {
        return _fail(
          "Patch failed partway:\n" +
            results.join("\n") +
            `\nerror: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
    }
    return _ok("Patch applied:\n" + results.map((r) => `- ${r}`).join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const nb_read = new NbReadTool();
export const nb_list = new NbListTool();
export const nb_search = new NbSearchTool();
export const nb_patch = new NbPatchTool();

export const NB_OWN_TOOL_NAMES = [
  "nb_read",
  "nb_list",
  "nb_search",
  "nb_patch",
] as const;

// Research tools the writer may also use. They are Praxis tools registered
// under their usual names; "web" intentionally overrides vtx's built-in web
// tool inside the sub-agent registry (the main agent's tools are unaffected —
// they come from an explicit list, not this registry).
export const SHARED_TOOL_NAMES = ["web", "paper_search", "knowledge_base_search"] as const;

export const WRITER_TOOL_NAMES = [...NB_OWN_TOOL_NAMES, ...SHARED_TOOL_NAMES];

// The Co-writer agent uses exactly this tool list, both as the sub-agent
// dispatched by the main assistant and as the companion in the notebook chat.
export const COWRITER_TOOL_NAMES = WRITER_TOOL_NAMES;

let _registered = false;

export function writer_tools(): BaseTool[] {
  return [nb_read, nb_list, nb_search, nb_patch];
}

export function shared_tools(): BaseTool[] {
  // kb_tools.knowledge_base_search]; tolerate camelCase export names too.
  const dt = dt_tools as unknown as Record<string, any>;
  const kb = kb_tools as unknown as Record<string, any>;
  return [
    dt["web"] ?? dt["webTool"],
    dt["paper_search"] ?? dt["paperSearch"],
    kb["knowledge_base_search"] ?? kb["knowledgeBaseSearch"],
  ];
}

export function register_writer_tools(): void {
  // Put the writer's tools into vtx's global registry (idempotent).
  //
  // ``SubagentSpec.tools_allow`` only resolves names found in
  // ``get_all_tools()``, so the ``nb_*`` tools — and the shared research
  // tools — must live there before dispatch.
  if (_registered) {
    return;
  }
  for (const tool of [...writer_tools(), ...shared_tools()]) {
    register_tool(tool);
  }
  _registered = true;
}
