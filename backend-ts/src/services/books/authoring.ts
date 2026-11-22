// revision-fenced book edits:
// pure previews, explicit apply, and guarded undo.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  atomic_write_json,
  coercePage,
  read_json,
  safe_page_id,
  ValueError,
  type BookStorage,
} from "./storage.js";
import {
  make_block,
  make_page,
  now,
  type Block,
  type BlockType,
  type Book,
  type Page,
  type Spine,
} from "./models.js";

export interface BookEdit {
  action:
    | "add_chapter"
    | "rename_chapter"
    | "move_chapter"
    | "delete_chapter"
    | "add_page"
    | "rename_page"
    | "move_page"
    | "delete_page"
    | "insert_block"
    | "extend_page";
  chapter_id?: string;
  page_id?: string;
  title?: string;
  body?: string;
  learning_objectives?: string[];
  position?: number;
  [k: string]: unknown;
}

const EDIT_ACTIONS = new Set<string>([
  "add_chapter",
  "rename_chapter",
  "move_chapter",
  "delete_chapter",
  "add_page",
  "rename_page",
  "move_page",
  "delete_page",
  "insert_block",
  "extend_page",
]);

function _read(storage: BookStorage, book_id: string): { book: Book; spine: Spine; pages: Map<string, Page> } {
  const book = storage.load_book(book_id);
  const spine = storage.load_spine(book_id);
  if (book === null || spine === null) throw new ValueError("Book or spine not found");
  if (book.status === "compiling") {
    throw new ValueError("Pause book generation before editing its structure");
  }
  const pages = new Map<string, Page>();
  for (const p of storage.list_pages(book_id)) {
    if (p.status === "planning" || p.status === "generating") {
      throw new ValueError("Pause book generation before editing its structure");
    }
    pages.set(p.id, p);
  }
  return { book, spine, pages };
}

function _path(storage: BookStorage, book_id: string, name: string): string {
  if (name === "spine.json" || name === "manifest.json") {
    return join(storage.book_root(book_id), name);
  }
  if (name.startsWith("pages/") && name.endsWith(".json")) {
    return join(storage.book_root(book_id), "pages", `${safe_page_id(name.slice(6, -5))}.json`);
  }
  throw new ValueError("Invalid edit file");
}

function _record_path(storage: BookStorage, book_id: string, edit_id: string): string {
  return join(storage.book_root(book_id), "edits", `${safe_page_id(edit_id)}.json`);
}

function _write_files(storage: BookStorage, book_id: string, values: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(values)) {
    const path = _path(storage, book_id, name);
    if (value === null || value === undefined) {
      try {
        rmSync(path, { force: true });
      } catch { /* missing_ok */ }
    } else {
      atomic_write_json(path, value);
    }
  }
}

function _read_edit_records(storage: BookStorage, book_id: string): Array<Record<string, any>> {
  const dir = join(storage.book_root(book_id), "edits");
  if (!existsSync(dir)) return [];
  const out: Array<Record<string, any>> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const rec = read_json<Record<string, any>>(join(dir, name));
    if (rec) out.push(rec);
  }
  return out;
}

export function recover_edits(storage: BookStorage, book_id: string): void {
  for (const record of _read_edit_records(storage, book_id)) {
    if (!["applying", "undoing"].includes(record["status"])) continue;
    const before = record["transaction_before"] ?? {};
    const after = record["transaction_after"] ?? {};
    let changed = false;
    for (const [name, value] of Object.entries(before)) {
      const current = read_json(_path(storage, book_id, name));
      if (current !== value && current !== after[name]) {
        changed = true;
        break;
      }
    }
    if (changed) {
      throw new ValueError("Interrupted book edit needs recovery; its files changed externally");
    }
    _write_files(storage, book_id, before as Record<string, unknown>);
    record["status"] = record["previous_status"];
    delete record["transaction_before"];
    delete record["transaction_after"];
    atomic_write_json(_record_path(storage, book_id, record["id"]), record);
  }
}

// ── minimal unified-diff (difflib.unified_diff equivalent, lineterm="") ────

function lcs_lines(a: string[], b: string[]): string[] {
  // Simple LCS-based diff producing +/- lines (no context headers beyond
  // the hunks we emit). Good enough for a review diff of book prose.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out;
}

function unified_diff(oldText: string, newText: string, fromfile: string, tofile: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const body = lcs_lines(a, b);
  if (body.every((l) => l.startsWith(" "))) return "";
  return [
    `--- ${fromfile}`,
    `+++ ${tofile}`,
    `@@ -1,${a.length} +1,${b.length} @@`,
    ...body,
  ].join("\n");
}

export function preview_edit(
  storage: BookStorage,
  book_id: string,
  edit: BookEdit,
  opts: { source_session_id?: string; source_turn_id?: string } = {},
): Record<string, any> {
  recover_edits(storage, book_id);
  const { book, spine, pages } = _read(storage, book_id);
  const dump = (o: unknown) => JSON.parse(JSON.stringify(o));
  const before: Record<string, unknown> = {
    "spine.json": dump(spine),
    ...Object.fromEntries([...pages.entries()].map(([pid, p]) => [`pages/${pid}.json`, dump(p)])),
  };

  const action = edit.action;
  if (!EDIT_ACTIONS.has(action)) throw new ValueError(`Unknown edit action: ${action}`);
  const chapter = spine.chapters.find((c) => c.id === (edit.chapter_id ?? ""));
  const page = pages.get(edit.page_id ?? "");

  if (action.endsWith("chapter") && action !== "add_chapter" && !chapter) {
    throw new ValueError("Chapter not found");
  }
  if (
    !["add_chapter", "rename_chapter", "move_chapter", "delete_chapter", "add_page"].includes(action) &&
    !page
  ) {
    throw new ValueError("Page not found");
  }
  if ((chapter && chapter.content_type === "overview") || (page && page.content_type === "overview")) {
    throw new ValueError("The generated overview cannot be structurally edited");
  }
  if (
    ["add_chapter", "rename_chapter", "add_page", "rename_page"].includes(action) &&
    !(edit.title ?? "").trim()
  ) {
    throw new ValueError("Title is required");
  }

  const position = Math.max(0, Math.trunc(edit.position ?? 0));
  const objectives = edit.learning_objectives ?? [];

  if (action === "add_chapter") {
    const ch = {
      id: `ch_${randomBytes(5).toString("hex")}`,
      title: (edit.title ?? "").trim(),
      learning_objectives: [...objectives],
      content_type: "theory",
      source_anchors: [],
      prerequisites: [],
      page_ids: [] as string[],
      summary: "",
      order: 0,
    };
    spine.chapters.splice(Math.min(position, spine.chapters.length), 0, ch as never);
    const pg = make_page({
      book_id,
      chapter_id: ch.id,
      title: ch.title,
      learning_objectives: [...objectives],
    });
    pages.set(pg.id, pg);
    ch.page_ids = [pg.id];
  } else if (action === "rename_chapter" && chapter) {
    chapter.title = (edit.title ?? "").trim();
  } else if (action === "move_chapter" && chapter) {
    spine.chapters = spine.chapters.filter((c) => c.id !== chapter.id);
    spine.chapters.splice(Math.min(position, spine.chapters.length), 0, chapter);
  } else if (action === "delete_chapter" && chapter) {
    const removed = new Set<string>();
    for (const [pid, p] of pages) if (p.chapter_id === chapter.id) removed.add(pid);
    for (const pid of chapter.page_ids) removed.add(pid);
    if ([...pages.values()].some((p) => removed.has(p.parent_page_id ?? "") && !removed.has(p.id))) {
      throw new ValueError("Remove dependent deep-dive pages before deleting this chapter");
    }
    spine.chapters = spine.chapters.filter((c) => c.id !== chapter.id);
    for (const [pid] of [...pages]) if (pages.get(pid)!.chapter_id === chapter.id) pages.delete(pid);
    for (const other of spine.chapters) {
      other.prerequisites = (other.prerequisites ?? []).filter((cid) => cid !== chapter.id);
    }
    if (spine.concept_graph?.nodes) {
      spine.concept_graph.nodes = spine.concept_graph.nodes.filter(
        (n) => !n.chapter_id || n.chapter_id !== chapter.id,
      );
      const nodeIds = new Set(spine.concept_graph.nodes.map((n) => n.id));
      spine.concept_graph.edges = (spine.concept_graph.edges ?? []).filter(
        (e) => nodeIds.has(e.src) && nodeIds.has(e.dst),
      );
    }
  } else if (action === "add_page" && chapter) {
    const pg = make_page({
      book_id,
      chapter_id: chapter.id,
      title: (edit.title ?? "").trim(),
      learning_objectives: [...objectives],
      content_type: chapter.content_type,
      section: true,
    });
    pages.set(pg.id, pg);
    chapter.page_ids.splice(Math.min(position, chapter.page_ids.length), 0, pg.id);
    if (edit.body) {
      pg.blocks = [
        make_block({
          type: "text",
          status: "ready",
          payload: { body: edit.body },
        }),
      ];
      pg.status = "ready";
    }
  } else if (action === "rename_page" && page) {
    page.title = (edit.title ?? "").trim();
    page.section = true;
  } else if ((action === "move_page" || action === "delete_page") && page) {
    const parent = spine.chapters.find((c) => c.id === page.chapter_id);
    if (!parent || !(parent.page_ids ?? []).includes(page.id)) {
      throw new ValueError("Only sections in the book outline can be moved or deleted");
    }
    parent.page_ids = parent.page_ids.filter((pid) => pid !== page.id);
    if (action === "move_page") {
      const destination = chapter ?? parent;
      destination.page_ids.splice(Math.min(position, destination.page_ids.length), 0, page.id);
      page.chapter_id = destination.id;
    } else {
      if ([...pages.values()].some((p) => p.parent_page_id === page.id)) {
        throw new ValueError("Remove the dependent deep-dive pages before deleting this section");
      }
      pages.delete(page.id);
    }
  } else if ((action === "insert_block" || action === "extend_page") && page) {
    if (!(edit.body ?? "").trim()) throw new ValueError("Content is required");
    const block = make_block({
      type: "text",
      status: "ready",
      title: (edit.title ?? "").trim(),
      payload: { body: edit.body },
      metadata: {
        source_session_id: opts.source_session_id ?? "",
        source_turn_id: opts.source_turn_id ?? "",
      },
    });
    const pos =
      action === "extend_page"
        ? page.blocks.length
        : Math.min(position, page.blocks.length);
    page.blocks.splice(pos, 0, block);
    page.status = "ready";
  }

  spine.chapters.forEach((item, index) => {
    item.order = index;
    for (const pid of item.page_ids ?? []) {
      const p = pages.get(pid);
      if (p) p.order = index;
    }
  });

  const after: Record<string, unknown> = {
    "spine.json": JSON.parse(JSON.stringify(spine)),
    ...Object.fromEntries([...pages.entries()].map(([pid, p]) => [`pages/${pid}.json`, JSON.parse(JSON.stringify(p))])),
  };
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...names].filter((n) => JSON.stringify(before[n]) !== JSON.stringify(after[n]));
  if (!changed.length) throw new ValueError("The proposed edit does not change the book");

  const editsDir = join(storage.book_root(book_id), "edits");
  try {
    if (readdirSync(editsDir).filter((n) => n.endsWith(".json")).length >= 1000) {
      throw new ValueError("Book edit history limit reached; export an archive before further edits");
    }
  } catch (e) {
    if (e instanceof ValueError) throw e;
  }

  const record: Record<string, any> = {
    id: `edit_${randomBytes(8).toString("hex")}`,
    book_id,
    page_id: edit.page_id ?? "",
    expected_revision: book.revision,
    status: "proposed",
    created_at: now(),
    source_session_id: opts.source_session_id ?? "",
    source_turn_id: opts.source_turn_id ?? "",
    edit: { ...edit },
    before: Object.fromEntries(changed.map((n) => [n, before[n] ?? null])),
    after: Object.fromEntries(changed.map((n) => [n, after[n] ?? null])),
  };

  // prose() for the review diff
  const prose = (values: Record<string, any>, pageMap: Map<string, Page>): string[] => {
    const lines: string[] = [];
    if (values["spine.json"]) {
      lines.push("# Outline");
      (values["spine.json"].chapters ?? []).forEach((chapter: any, i: number) => {
        lines.push(`${i + 1}. ${chapter.title}`);
        for (const pid of chapter.page_ids ?? []) {
          const item = pageMap.get(pid);
          lines.push(`   - ${item ? item.title : pid}`);
        }
      });
    }
    for (const [name, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (name.startsWith("pages/") && value) {
        lines.push("", `# ${value.title}`);
        for (const block of value.blocks ?? []) {
          lines.push(block.title ?? "", String(block.payload?.body ?? JSON.stringify(block.payload ?? {}, null, 0)));
        }
      }
    }
    return lines;
  };

  const oldPages = new Map<string, Page>();
  for (const [name, value] of Object.entries(record.before)) {
    if (name.startsWith("pages/")) {
      const p = coercePage(value);
      if (p) oldPages.set(name.slice(6, -5), p);
    }
  }
  const newPagesForDiff = new Map<string, Page>();
  for (const [name, value] of Object.entries(record.after)) {
    if (name.startsWith("pages/") && value) {
      const p = coercePage(value);
      if (p) newPagesForDiff.set(name.slice(6, -5), p);
    }
  }
  record["diff"] = unified_diff(
    prose(record.before, oldPages).join("\n"),
    prose(record.after, newPagesForDiff).join("\n"),
    "Current book",
    "Proposed book",
  );

  atomic_write_json(_record_path(storage, book_id, record["id"]), record);
  return public_edit(record);
}

export function public_edit(record: Record<string, any>): Record<string, any> {
  const keys = [
    "id",
    "book_id",
    "page_id",
    "expected_revision",
    "applied_revision",
    "status",
    "created_at",
    "source_session_id",
    "source_turn_id",
    "edit",
    "diff",
  ];
  const out: Record<string, any> = {};
  for (const k of keys) if (k in record) out[k] = record[k];
  return out;
}

export function list_edits(storage: BookStorage, book_id: string, page_id?: string | null): Array<Record<string, any>> {
  recover_edits(storage, book_id);
  const records = _read_edit_records(storage, book_id)
    .sort((a, b) => (b["created_at"] ?? 0) - (a["created_at"] ?? 0));
  return records
    .filter((r) => page_id == null || r["page_id"] === page_id)
    .slice(0, 50)
    .map(public_edit);
}

export function apply_edit(
  storage: BookStorage,
  book_id: string,
  edit_id: string,
  expected_revision: number,
  opts: { undo?: boolean } = {},
): Record<string, any> {
  const undo = opts.undo === true;
  recover_edits(storage, book_id);
  const { book, spine, pages } = _read(storage, book_id);
  const path = _record_path(storage, book_id, edit_id);
  const record = read_json<Record<string, any>>(path);
  if (!record || record["book_id"] !== book_id) throw new ValueError("Edit not found");

  const completed = undo ? "undone" : "applied";
  if (record["status"] === completed) return public_edit(record);
  const wanted = undo ? "applied" : "proposed";
  const revision = undo ? record["applied_revision"] : record["expected_revision"];
  if (record["status"] !== wanted || expected_revision !== revision || book.revision !== revision) {
    throw new ValueError("Book revision changed; review a new proposal before applying or undoing");
  }
  const before = undo ? record["after"] : record["before"];
  const after = undo ? record["before"] : record["after"];
  for (const [name, value] of Object.entries(before ?? {})) {
    if (JSON.stringify(read_json(_path(storage, book_id, name))) !== JSON.stringify(value)) {
      throw new ValueError("Book content changed since the preview; review a new proposal");
    }
  }

  const manifest_before = JSON.parse(JSON.stringify(book));
  book.revision += 1;
  book.updated_at = now();
  const resulting_spine = (after?.["spine.json"] ?? JSON.parse(JSON.stringify(spine))) as { chapters?: unknown[] };
  book.chapter_count = Array.isArray(resulting_spine.chapters) ? resulting_spine.chapters.length : 0;
  const beforePages = Object.keys(before ?? {}).filter((n) => n.startsWith("pages/"));
  const afterPages = Object.keys(after ?? {}).filter((n) => n.startsWith("pages/"));
  book.page_count =
    pages.size +
    afterPages.filter((n) => before?.[n] == null).length -
    afterPages.filter((n) => after?.[n] == null).length;
  void beforePages;

  const transaction_before: Record<string, unknown> = { ...(before ?? {}), "manifest.json": manifest_before };
  const transaction_after: Record<string, unknown> = { ...(after ?? {}), "manifest.json": JSON.parse(JSON.stringify(book)) };
  Object.assign(record, {
    previous_status: record["status"],
    status: undo ? "undoing" : "applying",
    transaction_before,
    transaction_after,
  });
  atomic_write_json(path, record);
  try {
    _write_files(storage, book_id, transaction_after);
  } catch (e) {
    recover_edits(storage, book_id);
    throw e;
  }
  Object.assign(record, {
    status: completed,
    ...(undo ? { undo_revision: book.revision } : { applied_revision: book.revision }),
  });
  delete record["transaction_before"];
  delete record["transaction_after"];
  atomic_write_json(path, record);
  return public_edit(record);
}
