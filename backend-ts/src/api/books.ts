// Port of deeptutor/api/routers/book.py — Book Engine REST + channel API.
//
// Mount: app.route("/", booksRouter) — paths already carry /api/books.
//
// The upstream WS endpoint (ws_router "/books") maps onto this deployment's
// SSE transport: the frontend posts book operations to
// /api/realtime/commands?channel=books and reads events off /api/realtime/events.
// `handleBooksChannel` implements that protocol; realtime.ts's books branch
// should delegate to it (TODO — realtime.ts is outside this port's scope).

import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { get_settings } from "../config.js";
import type { Dict } from "../shared/types.js";
import { BookEngine, BookPausedError, get_book_engine } from "../services/books/engine.js";
import { chapter_basis } from "../services/books/planner.js";
import { export_filename, render_book_markdown } from "../services/books/export.js";
import * as progress_ops from "../services/books/progress.js";
import {
  apply_edit,
  list_edits,
  preview_edit,
  type BookEdit,
} from "../services/books/authoring.js";
import {
  BLOCK_TYPES,
  CONTENT_TYPES,
  LEARNING_CAPTURE_STATUSES,
  make_learning_capture,
  now,
  type BlockType,
  type Book,
  type BookProposal,
  type Chapter,
  type ContentType,
  type LearningCaptureStatus,
  type Spine,
} from "../services/books/models.js";
import { get_book_storage, ValueError } from "../services/books/storage.js";
import {
  get_book_bus,
  get_book_stream,
  serialize_event,
  SOURCE,
  type BookEvent,
} from "../services/books/streaming.js";
import { tag_book_chat_session } from "../services/books/chat_sessions.js";

export const booksRouter = new Hono();

// ── helpers ────────────────────────────────────────────────────────────────

function engine(): BookEngine {
  return get_book_engine(get_settings());
}

function isValueError(e: unknown): boolean {
  return e instanceof ValueError || (e instanceof Error && e.name === "ValueError");
}

function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ResolvedBook {
  engine: BookEngine;
  can_edit: boolean;
  can_delete: boolean;
  is_shared: boolean;
}

function resolve_book(book_id: string): ResolvedBook | null {
  const eng = engine();
  if (!eng.load_book(book_id)) return null;
  // Single-user deployment: every book is owned and editable.
  return { engine: eng, can_edit: true, can_delete: true, is_shared: false };
}

function resolve_book_or_404(book_id: string, opts: { edit?: boolean; delete?: boolean } = {}): ResolvedBook {
  const resolved = resolve_book(book_id);
  if (!resolved) throw httpError(404, "Book not found");
  if (opts.edit && !resolved.can_edit) throw httpError(404, "Book not found");
  if (opts.delete && !resolved.can_delete) throw httpError(404, "Book not found");
  return resolved;
}

function httpError(status: number, d: unknown): Error & { status: number; detail: unknown } {
  const err = new Error(typeof d === "string" ? d : JSON.stringify(d)) as Error & {
    status: number;
    detail: unknown;
  };
  err.status = status;
  err.detail = d;
  err.name = "HttpError";
  return err;
}

booksRouter.onError((err, c) => {
  const e = err as Error & { status?: number; detail?: unknown };
  if (e.name === "HttpError" && e.status) {
    return c.json({ detail: e.detail ?? e.message }, e.status as never);
  }
  if (err instanceof BookPausedError) {
    return c.json({ detail: { code: "book_paused", message: err.message } }, 409);
  }
  if (isValueError(err)) {
    return c.json({ detail: err.message }, 400);
  }
  console.error("books api error:", err);
  return c.json({ detail: String(err?.message ?? err) }, 500);
});

function book_payload(book: Book, resolved: ResolvedBook): Dict {
  const data: Dict = { ...book } as Dict;
  if (resolved.is_shared) {
    const metadata = { ...((data["metadata"] as Dict) ?? {}) };
    const storage = resolved.engine.storage as {
      load_page_chat_sessions?: (book_id: string) => Dict;
    };
    metadata["page_chat_sessions"] = storage.load_page_chat_sessions?.(book.id) ?? {};
    data["metadata"] = metadata;
  }
  return data;
}

function claim_content_mutation(
  resolved: ResolvedBook,
  book_id: string,
  expected_revision: unknown,
  action: string,
  opts: { extra?: Dict; strict?: boolean } = {},
): number {
  const strict = opts.strict ?? true;
  const eng = resolved.engine;
  const book = eng.load_book(book_id);
  if (!book) throw httpError(404, "Book not found");
  const current = Math.max(1, Math.trunc(book.revision || 1));
  const expected = expected_revision == null ? null : Math.trunc(Number(expected_revision));
  if (strict && resolved.is_shared && expected == null) {
    throw httpError(409, {
      code: "book_revision_required",
      message: "Refresh the shared book before editing.",
      current_revision: current,
    });
  }
  if (strict && expected != null && expected !== current) {
    throw httpError(409, {
      code: "book_revision_conflict",
      message: resolved.is_shared
        ? "The book was updated by another collaborator."
        : "This book changed since your last action — reloading the latest version.",
      expected_revision: expected,
      current_revision: current,
    });
  }
  book.revision = current + 1;
  book.updated_at = now();
  eng.storage.save_book(book);
  return book.revision;
}

function page_summary(page: import("../services/books/models.js").Page): Dict {
  const data: Dict = { ...(page as unknown as Dict) };
  const blocks = (data["blocks"] as unknown[]) ?? [];
  delete data["blocks"];
  data["block_count"] = blocks.length;
  data["blocks"] = [];
  return data;
}

const normalize_capture_text = (v: string) => (v ?? "").trim().split(/\s+/).join(" ");

function build_capture_hash(book_id: string, page_id: string, block_id: string, locator: string, text: string): string {
  return createHash("sha256")
    .update([book_id, page_id, block_id, locator, normalize_capture_text(text)].join("|"), "utf-8")
    .digest("hex");
}

const CAPTURE_TRANSITIONS: Record<LearningCaptureStatus, Set<LearningCaptureStatus>> = {
  captured: new Set(["captured", "drafted", "pending_confirmation", "approved", "rejected"]),
  drafted: new Set(["drafted", "pending_confirmation", "approved", "rejected"]),
  pending_confirmation: new Set(["pending_confirmation", "approved", "rejected"]),
  approved: new Set(["approved", "delivered"]),
  delivered: new Set(["delivered", "imported"]),
  imported: new Set(["imported"]),
  rejected: new Set(["rejected"]),
};

function coerce_capture_status(raw: unknown): LearningCaptureStatus | null {
  if (raw == null) return null;
  const s = String(raw);
  if ((LEARNING_CAPTURE_STATUSES as readonly string[]).includes(s)) return s as LearningCaptureStatus;
  throw httpError(400, `Invalid capture status: ${raw}`);
}

function find_capture_duplicate(storage: ReturnType<typeof get_book_storage>, book_id: string, page_id: string, content_hash: string) {
  for (const capture of storage.load_learning_captures(book_id)) {
    if (capture.page_id !== page_id) continue;
    if (capture.content_hash !== content_hash) continue;
    if (capture.status === "rejected") continue;
    return capture;
  }
  return null;
}

function derive_capture_title_values(eng: BookEngine, book_id: string, page_id: string, block_id: string) {
  const book = eng.load_book(book_id);
  if (!book) throw httpError(404, "Book not found");
  const page = eng.load_page(book_id, page_id);
  if (!page) throw httpError(404, "Page not found");
  const spine = eng.load_spine(book_id);
  let chapter_title = page.title;
  if (spine && page.chapter_id) {
    for (const chapter of spine.chapters) {
      if (chapter.id === page.chapter_id) {
        chapter_title = chapter.title;
        break;
      }
    }
  }
  const base = `/books/${book_id}/pages/${page_id}`;
  return { book_title: book.title, chapter_title, source_locator: block_id ? `${base}/block/${block_id}` : base };
}

function focus_check_question(questions: unknown[], requested_id: string, block_id: string) {
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (q === null || typeof q !== "object" || Array.isArray(q)) continue;
    const question = q as Record<string, unknown>;
    const qid = String(question["question_id"] ?? "").trim();
    if (requested_id && qid === requested_id) return [qid, question] as const;
    if (!requested_id && !qid) return [`${block_id}:${i + 1}`, question] as const;
  }
  if (requested_id) return [requested_id, {} as Record<string, unknown>] as const;
  return null;
}

function verified_choice_grade(question: Record<string, unknown>, user_answer: string): boolean | null {
  const qt = String(question["question_type"] ?? "").trim().toLowerCase().replace(/ /g, "_");
  if (!["choice", "multiple_choice", "multiple-choice", "mcq"].includes(qt)) return null;
  const options = question["options"];
  if (options === null || typeof options !== "object" || Array.isArray(options)) return null;
  const answer = user_answer.trim().toUpperCase();
  const keys = new Map<string, string>();
  for (const [k, v] of Object.entries(options as Record<string, unknown>)) {
    keys.set(k.trim().toUpperCase(), String(v).trim());
  }
  const correct_text = String(question["correct_answer"] ?? "").trim();
  let correct = correct_text.toUpperCase();
  if (!keys.has(correct)) {
    const matching = [...keys.entries()].filter(([, label]) => label.toLowerCase() === correct_text.toLowerCase());
    if (matching.length !== 1) return null;
    correct = matching[0][0];
  }
  if (!keys.has(answer)) return null;
  return answer === correct;
}

function body(c: Context): Promise<Dict> {
  return c.req.json() as Promise<Dict>;
}

function str(v: unknown, dflt = ""): string {
  return v == null ? dflt : String(v);
}

function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map((x) => Math.trunc(Number(x))).filter((n) => Number.isFinite(n)) : [];
}

// ── REST endpoints ─────────────────────────────────────────────────────────

booksRouter.get("/api/books/health", (c) => c.json({ status: "healthy", service: "book" }));

booksRouter.get("/api/books/estimate-basis", (c) => {
  const depth = c.req.query("depth") ?? "standard";
  return c.json({ depth, basis: chapter_basis(depth) });
});

booksRouter.get("/api/books/block-types", (c) => {
  const { PLANNABLE_BLOCK_TYPES, PLANNER_DEFAULT_BLOCK_TYPES } = planner_exports();
  return c.json({
    block_types: [...PLANNABLE_BLOCK_TYPES]
      .sort()
      .map((value) => ({ value, planner_default: PLANNER_DEFAULT_BLOCK_TYPES.has(value) })),
  });
});

import * as _planner from "../services/books/planner.js";
function planner_exports() {
  return { PLANNABLE_BLOCK_TYPES: _planner.PLANNABLE_BLOCK_TYPES, PLANNER_DEFAULT_BLOCK_TYPES: _planner.PLANNER_DEFAULT_BLOCK_TYPES };
}

booksRouter.get("/api/books", (c) => {
  const eng = engine();
  const books: Dict[] = [];
  for (const book of eng.list_books()) {
    const resolved = resolve_book(book.id)!;
    const data = book_payload(book, resolved);
    data["reading"] = eng.reading_summary(book);
    data["generation"] = eng.generation_overview(book);
    books.push(data);
  }
  return c.json({ books, can_create: true });
});

booksRouter.get("/api/books/:book_id/learning-captures", (c) => {
  const book_id = c.req.param("book_id");
  const resolved = resolve_book_or_404(book_id);
  const statusParam = c.req.query("status");
  const parsed = statusParam != null ? coerce_capture_status(statusParam) : null;
  const captures = resolved.engine.storage.load_learning_captures(book_id, parsed ?? undefined);
  return c.json({ captures });
});

booksRouter.post("/api/books/:book_id/learning-captures", async (c) => {
  const book_id = c.req.param("book_id");
  const resolved = resolve_book_or_404(book_id);
  const eng = resolved.engine;
  const req = await body(c);
  const page_id = str(req["page_id"]);
  const page = eng.load_page(book_id, page_id);
  if (!page) throw httpError(404, "Page not found");

  const source_text = normalize_capture_text(str(req["source_text"]));
  if (!source_text) throw httpError(400, "source_text is required");

  const derived = derive_capture_title_values(eng, book_id, page_id, str(req["block_id"]));
  const source_locator = str(req["source_locator"]).trim() || derived.source_locator;
  const status = coerce_capture_status(req["status"]) ?? "captured";
  const content_hash = build_capture_hash(book_id, page_id, str(req["block_id"]), source_locator, source_text);

  const storage = eng.storage;
  const duplicate = find_capture_duplicate(storage, book_id, page_id, content_hash);
  if (duplicate) return c.json({ capture: duplicate });

  const capture = make_learning_capture({
    book_id,
    page_id,
    block_id: str(req["block_id"]),
    source_text,
    context_before: normalize_capture_text(str(req["context_before"])),
    context_after: normalize_capture_text(str(req["context_after"])),
    source_locator,
    book_title: str(req["book_title"]) || derived.book_title,
    chapter_title: str(req["chapter_title"]) || derived.chapter_title,
    user_note: str(req["user_note"]).trim(),
    content_hash,
    status,
  });
  storage.upsert_learning_capture(capture);
  return c.json({ capture });
});

booksRouter.patch("/api/books/:book_id/learning-captures/:capture_id", async (c) => {
  const book_id = c.req.param("book_id");
  const capture_id = c.req.param("capture_id");
  const resolved = resolve_book_or_404(book_id);
  const storage = resolved.engine.storage;
  const capture = storage.load_learning_capture(book_id, capture_id);
  if (!capture) throw httpError(404, "Learning capture not found");

  const req = await body(c);
  const requested = req["status"] != null ? coerce_capture_status(req["status"]) : null;
  if (requested && !CAPTURE_TRANSITIONS[capture.status].has(requested)) {
    throw httpError(400, `Invalid state transition: ${capture.status} -> ${requested}`);
  }

  let changed = false;
  const updated = { ...capture };
  if (requested != null && requested !== capture.status) {
    updated.status = requested;
    changed = true;
  }
  if (req["user_note"] != null && req["user_note"] !== capture.user_note) {
    updated.user_note = str(req["user_note"]);
    changed = true;
  }
  if (req["rejected_reason"] != null && req["rejected_reason"] !== capture.rejected_reason) {
    updated.rejected_reason = str(req["rejected_reason"]);
    changed = true;
  }
  if (!changed) return c.json({ capture });

  updated.version = capture.version + 1;
  updated.updated_at = now();
  storage.upsert_learning_capture(updated);
  return c.json({ capture: updated });
});

booksRouter.get("/api/books/:book_id", async (c) => {
  const book_id = c.req.param("book_id");
  const include_blocks = c.req.query("include_blocks") !== "false";
  const resolved = resolve_book_or_404(book_id);
  const eng = resolved.engine;
  let book = eng.load_book(book_id);
  if (!book) throw httpError(404, "Book not found");

  if (!resolved.is_shared) {
    await eng.maybe_resume_on_open(book_id);
    book = eng.load_book(book_id) ?? book;
  }

  const spine = eng.load_spine(book_id);
  const pages = eng.list_pages(book_id);
  const progress = eng.load_progress(book_id);
  return c.json({
    book: book_payload(book, resolved),
    spine: spine ?? null,
    pages: pages.map((p) => (include_blocks ? p : page_summary(p))),
    progress,
    generation: eng.generation_summary(book_id, { book, pages }),
  });
});

booksRouter.get("/api/books/:book_id/spine", (c) => {
  const book_id = c.req.param("book_id");
  const eng = resolve_book_or_404(book_id).engine;
  const spine = eng.load_spine(book_id);
  if (!spine) throw httpError(404, "Spine not found");
  return c.json({ spine });
});

booksRouter.get("/api/books/:book_id/pages/:page_id", (c) => {
  const book_id = c.req.param("book_id");
  const page_id = c.req.param("page_id");
  const eng = resolve_book_or_404(book_id).engine;
  const page = eng.load_page(book_id, page_id);
  if (!page) throw httpError(404, "Page not found");
  return c.json({ page });
});

booksRouter.delete("/api/books/:book_id", (c) => {
  const book_id = c.req.param("book_id");
  const resolved = resolve_book_or_404(book_id, { delete: true });
  const ok = resolved.engine.delete_book(book_id);
  if (!ok) throw httpError(404, "Book not found");
  return c.json({ deleted: true, book_id });
});

booksRouter.post("/api/books", async (c) => {
  const req = await body(c);
  if (!str(req["user_intent"]).trim()) throw httpError(400, "user_intent is required");
  const eng = engine();
  try {
    const { book, proposal } = await eng.create_book({
      user_intent: str(req["user_intent"]),
      source_refs: (req["source_refs"] as Dict[]) ?? [],
      chat_session_id: str(req["chat_session_id"]),
      chat_selections: (req["chat_selections"] as Dict[]) ?? [],
      notebook_refs: (req["notebook_refs"] as Dict[]) ?? [],
      knowledge_bases: Array.isArray(req["knowledge_bases"]) ? req["knowledge_bases"].map(String) : [],
      question_categories: numArray(req["question_categories"]),
      question_entries: numArray(req["question_entries"]),
      language: str(req["language"], "en"),
      fallback_language: str(req["fallback_language"], "en"),
      depth: str(req["depth"], "standard"),
    });
    return c.json({ book, proposal });
  } catch (exc) {
    console.error("create_book failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/confirm-proposal", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "confirm_proposal");
  let edited: BookProposal | null = null;
  if (req["proposal"]) {
    edited = req["proposal"] as BookProposal;
  }
  try {
    const { book, spine } = await resolved.engine.confirm_proposal({
      book_id,
      edited_proposal: edited,
    });
    return c.json({ book, spine, book_revision: revision });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(404, detail(exc));
    console.error("confirm_proposal failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/confirm-spine", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "confirm_spine");
  const edited = req["spine"] ? (req["spine"] as Spine) : null;
  const block_types = req["block_types"];
  persist_requested_block_types(resolved, book_id, Array.isArray(block_types) ? block_types.map(String) : null);
  try {
    const pages = await resolved.engine.confirm_spine({
      book_id,
      edited_spine: edited,
      auto_compile: req["auto_compile"] !== false,
    });
    return c.json({ pages, book_revision: revision });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(404, detail(exc));
    console.error("confirm_spine failed:", exc);
    throw httpError(500, detail(exc));
  }
});

function persist_requested_block_types(resolved: ResolvedBook, book_id: string, requested: string[] | null): void {
  if (requested === null || requested === undefined) return;
  const eng = resolved.engine;
  const book = eng.load_book(book_id);
  if (!book) throw httpError(404, "Book not found");
  const metadata = { ...(book.metadata ?? {}) };
  if (requested.length) {
    const normalized = ["section"];
    const seen = new Set<string>(["section"]);
    for (const value of requested) {
      const v = value.trim().toLowerCase();
      if (!(BLOCK_TYPES as readonly string[]).includes(v) || seen.has(v)) continue;
      seen.add(v);
      normalized.push(v);
    }
    metadata["block_types"] = normalized;
  } else {
    delete metadata["block_types"];
  }
  book.metadata = metadata;
  book.updated_at = now();
  eng.storage.save_book(book);
}

booksRouter.post("/api/books/compile-page", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const page_id = str(req["page_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(
    resolved, book_id, req["expected_revision"], "compile_page",
    { extra: { page_id, force: req["force"] === true }, strict: false },
  );
  try {
    const page = await resolved.engine.compile_page({
      book_id, page_id, force: req["force"] === true,
    });
    return c.json({ page, book_revision: revision });
  } catch (exc) {
    if (exc instanceof BookPausedError) throw httpError(409, { code: "book_paused", message: exc.message });
    if (isValueError(exc)) throw httpError(404, detail(exc));
    console.error("compile_page failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/regenerate-block", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "regenerate_block", {
    extra: { page_id: str(req["page_id"]), block_id: str(req["block_id"]) },
  });
  try {
    const block = await resolved.engine.regenerate_block({
      book_id,
      page_id: str(req["page_id"]),
      block_id: str(req["block_id"]),
      params_override: (req["params_override"] as Dict) ?? null,
    });
    if (!block) throw httpError(404, "Block not found");
    return c.json({ block, book_revision: revision });
  } catch (exc) {
    if (exc instanceof BookPausedError) throw httpError(409, { code: "book_paused", message: exc.message });
    console.error("regenerate_block failed:", exc);
    throw httpError(500, detail(exc));
  }
});

function coerce_block_type(name: string): BlockType {
  const v = name.trim();
  if ((BLOCK_TYPES as readonly string[]).includes(v)) return v as BlockType;
  throw httpError(400, `Unknown block type: ${name}`);
}

function coerce_content_type(name: string): ContentType {
  const v = name.trim();
  if ((CONTENT_TYPES as readonly string[]).includes(v)) return v as ContentType;
  throw httpError(400, `Unknown content type: ${name}`);
}

booksRouter.post("/api/books/insert-block", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "insert_block", {
    extra: { page_id: str(req["page_id"]), block_type: str(req["block_type"]) },
  });
  const block_type = coerce_block_type(str(req["block_type"]));
  try {
    const block = await resolved.engine.insert_block({
      book_id,
      page_id: str(req["page_id"]),
      block_type,
      params: (req["params"] as Dict) ?? null,
      position: req["position"] == null ? null : Math.trunc(Number(req["position"])),
      compile_now: req["compile_now"] !== false,
    });
    if (!block) throw httpError(404, "Page or chapter not found");
    return c.json({ block, book_revision: revision });
  } catch (exc) {
    if (exc instanceof BookPausedError) throw httpError(409, { code: "book_paused", message: exc.message });
    console.error("insert_block failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/delete-block", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "delete_block", {
    extra: { page_id: str(req["page_id"]), block_id: str(req["block_id"]) },
  });
  const ok = await resolved.engine.delete_block(book_id, str(req["page_id"]), str(req["block_id"]));
  if (!ok) throw httpError(404, "Block not found");
  return c.json({ ok: true, book_revision: revision });
});

booksRouter.post("/api/books/move-block", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "move_block", {
    extra: { page_id: str(req["page_id"]), block_id: str(req["block_id"]) },
  });
  const ok = await resolved.engine.move_block(
    book_id, str(req["page_id"]), str(req["block_id"]), Math.trunc(Number(req["new_position"])),
  );
  if (!ok) throw httpError(404, "Block not found");
  return c.json({ ok: true, book_revision: revision });
});

booksRouter.post("/api/books/change-block-type", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "change_block_type", {
    extra: { page_id: str(req["page_id"]), block_id: str(req["block_id"]) },
  });
  const new_type = coerce_block_type(str(req["new_type"]));
  try {
    const block = await resolved.engine.change_block_type({
      book_id,
      page_id: str(req["page_id"]),
      block_id: str(req["block_id"]),
      new_type,
      params_override: (req["params_override"] as Dict) ?? null,
    });
    if (!block) throw httpError(404, "Block not found");
    return c.json({ block, book_revision: revision });
  } catch (exc) {
    if (exc instanceof BookPausedError) throw httpError(409, { code: "book_paused", message: exc.message });
    console.error("change_block_type failed:", exc);
    throw httpError(500, detail(exc));
  }
});

function preflight_chapter_mutation(resolved: ResolvedBook, book_id: string, chapter_id?: string | null, deleting = false): void {
  try {
    const exists = resolved.engine.check_chapter_mutation(book_id, chapter_id, deleting);
    if (!exists) throw httpError(404, "Chapter or book spine not found");
  } catch (exc) {
    if ((exc as { status?: number }).status === 404) throw exc;
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
}

booksRouter.post("/api/books/:book_id/chapters", async (c) => {
  const book_id = c.req.param("book_id");
  const req = await body(c);
  if (!str(req["title"]).trim()) throw httpError(400, "title is required");
  const resolved = resolve_book_or_404(book_id, { edit: true });
  preflight_chapter_mutation(resolved, book_id);
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "add_chapter", {
    extra: { title: str(req["title"]).trim(), position: req["position"] },
  });
  const content_type = coerce_content_type(str(req["content_type"], "theory"));
  try {
    const chapter = await resolved.engine.add_chapter({
      book_id,
      title: str(req["title"]).trim(),
      position: req["position"] == null ? null : Math.trunc(Number(req["position"])),
      content_type,
      learning_objectives: Array.isArray(req["learning_objectives"]) ? req["learning_objectives"].map(String) : [],
      summary: str(req["summary"]),
    });
    if (!chapter) throw httpError(404, "Book spine not found");
    return c.json({ chapter, book_revision: revision });
  } catch (exc) {
    console.error("add_chapter failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.patch("/api/books/:book_id/chapters/:chapter_id", async (c) => {
  const book_id = c.req.param("book_id");
  const chapter_id = c.req.param("chapter_id");
  const req = await body(c);
  if (req["title"] != null && !str(req["title"]).trim()) throw httpError(400, "title cannot be empty");
  const resolved = resolve_book_or_404(book_id, { edit: true });
  preflight_chapter_mutation(resolved, book_id, chapter_id);
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "rename_chapter", {
    extra: { chapter_id },
  });
  try {
    const chapter = await resolved.engine.rename_chapter({
      book_id,
      chapter_id,
      title: req["title"] != null ? str(req["title"]).trim() : null,
      summary: req["summary"] != null ? str(req["summary"]) : null,
      learning_objectives: req["learning_objectives"] != null
        ? (req["learning_objectives"] as unknown[]).map(String)
        : null,
    });
    if (!chapter) throw httpError(404, "Chapter not found");
    return c.json({ chapter, book_revision: revision });
  } catch (exc) {
    console.error("rename_chapter failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.delete("/api/books/:book_id/chapters/:chapter_id", async (c) => {
  const book_id = c.req.param("book_id");
  const chapter_id = c.req.param("chapter_id");
  const expected = c.req.query("expected_revision");
  const resolved = resolve_book_or_404(book_id, { edit: true });
  preflight_chapter_mutation(resolved, book_id, chapter_id, true);
  const revision = claim_content_mutation(resolved, book_id, expected, "delete_chapter", {
    extra: { chapter_id },
  });
  try {
    const ok = await resolved.engine.delete_chapter(book_id, chapter_id);
    if (!ok) throw httpError(404, "Chapter not found");
    return c.json({ ok: true, book_revision: revision });
  } catch (exc) {
    console.error("delete_chapter failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/:book_id/chapters/:chapter_id/move", async (c) => {
  const book_id = c.req.param("book_id");
  const chapter_id = c.req.param("chapter_id");
  const req = await body(c);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  preflight_chapter_mutation(resolved, book_id, chapter_id);
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "move_chapter", {
    extra: { chapter_id, new_position: req["new_position"] },
  });
  try {
    const ok = await resolved.engine.move_chapter(book_id, chapter_id, Math.trunc(Number(req["new_position"])));
    if (!ok) throw httpError(404, "Chapter not found");
    return c.json({ ok: true, book_revision: revision });
  } catch (exc) {
    console.error("move_chapter failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/deep-dive", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "deep_dive", {
    extra: { page_id: str(req["parent_page_id"]), topic: str(req["topic"]) },
  });
  const content_type = coerce_content_type(str(req["content_type"], "concept"));
  try {
    const page = await resolved.engine.create_deep_dive_subpage({
      book_id,
      parent_page_id: str(req["parent_page_id"]),
      topic: str(req["topic"]),
      block_id: req["block_id"] == null ? null : str(req["block_id"]),
      content_type,
    });
    if (!page) throw httpError(404, "Parent page not found");
    return c.json({ page, book_revision: revision });
  } catch (exc) {
    if (exc instanceof BookPausedError) throw httpError(409, { code: "book_paused", message: exc.message });
    console.error("deep_dive failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/quiz-attempt", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id);
  const eng = resolved.engine;
  const book = eng.load_book(book_id);
  const page = eng.list_pages(book_id).find((p) => p.id === str(req["page_id"])) ?? null;
  const block = page ? (page.blocks ?? []).find((b) => b.id === str(req["block_id"])) ?? null : null;
  const questions = block
    ? ((block.payload?.["questions"] as unknown[]) ?? []).filter((q) => q !== null && typeof q === "object" && !Array.isArray(q))
    : [];
  const resolved_question = focus_check_question(questions, str(req["question_id"]), str(req["block_id"]));
  const current_progress = eng.load_progress(book_id);
  const previous_attempts = (current_progress.quiz_attempts ?? []).length;

  const page_to_chapter: Record<string, string> = {};
  for (const p of eng.list_pages(book_id)) if (p.chapter_id) page_to_chapter[p.id] = p.chapter_id;

  let progress;
  try {
    progress = progress_ops.record_attempt(current_progress, {
      page_id: str(req["page_id"]),
      block_id: str(req["block_id"]),
      question_id: str(req["question_id"]),
      user_answer: str(req["user_answer"]),
      is_correct: req["is_correct"] == null ? null : req["is_correct"] === true,
      page_to_chapter,
      submission_id: str(req["submission_id"]).trim(),
    });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
  if ((progress.quiz_attempts ?? []).length !== previous_attempts) {
    eng.storage.save_progress(progress);
  }

  // Focus-check evidence sync to the question bank is a no-op when the
  // session/assessment stores are unavailable; the attempt is already saved.
  if (req["is_correct"] != null && resolved_question && book) {
    try {
      await sync_focus_check({ book, page, block, req, progress, resolved_question });
    } catch (exc) {
      console.warn("focus-check sync failed:", exc);
      throw httpError(500, "Failed to save Focus-Check evidence");
    }
  }
  return c.json({ progress });
});

async function sync_focus_check(args: {
  book: Book;
  page: import("../services/books/models.js").Page | null;
  block: import("../services/books/models.js").Block | null;
  req: Dict;
  progress: import("../services/books/models.js").Progress;
  resolved_question: readonly [string, Record<string, unknown>];
}): Promise<void> {
  // Port of the assessment-record path: persist a question-bank style record
  // via the shared ext_items store when a session exists.
  const { book, page, block, req, progress, resolved_question } = args;
  const [question_id, question] = resolved_question;
  const metadata = (book.metadata ?? {}) as Dict;
  const page_sessions = (metadata["page_chat_sessions"] as Dict) ?? {};
  const session_id = str(page_sessions[str(req["page_id"])] ?? book["chat_session_id"] ?? "").trim();
  const verified = block ? verified_choice_grade(question, str(req["user_answer"])) : null;
  const trusted = verified != null && verified === (req["is_correct"] === true);

  const matching = (progress.quiz_attempts ?? []).filter(
    (a) => a.block_id === str(req["block_id"]) && (a.question_id ?? "") === str(req["question_id"]),
  );
  const latest = matching.find((a) => str(req["submission_id"]) && a.submission_id === str(req["submission_id"])) ?? matching[matching.length - 1];
  const attempt_count = latest ? matching.indexOf(latest) + 1 : 1;

  const record = {
    id: `fc_${createHash("sha1").update(`${book.id}:${str(req["block_id"])}:${question_id}:${latest?.submission_id ?? latest?.timestamp ?? Date.now()}`).digest("hex").slice(0, 12)}`,
    session_id: session_id || "",
    origin_type: session_id ? "conversation" : "document_analysis",
    origin_ref: session_id || `book:${book.id}`,
    turn_id: str(req["block_id"]),
    question_id,
    question: str(question["question"] ?? block?.title ?? "Focus check"),
    question_type: str(question["question_type"]),
    options: question["options"] ?? {},
    correct_answer: str(question["correct_answer"]),
    explanation: str(question["explanation"]),
    difficulty: str(question["difficulty"]),
    user_answer: str(req["user_answer"]),
    is_correct: req["is_correct"] === true,
    result: req["is_correct"] === true ? "correct" : "incorrect",
    source: "book",
    assessment_type: "focus_check",
    material_id: book.id,
    material_title: book.title,
    section_id: str(req["page_id"]),
    section_title: page?.title ?? "",
    mastery_path_id: trusted ? str(question["mastery_path_id"]) : "",
    knowledge_point_id: trusted ? str(question["knowledge_point_id"]) : "",
    attempt_count,
    attempt_id: `book:${book.id}:${str(req["block_id"])}:${question_id}:${latest?.submission_id || latest?.timestamp || Date.now()}`,
    created_at: now(),
  };
  try {
    const { put_item } = await import("../store/database.js");
    const settings = get_settings();
    put_item(settings, "book_focus_checks", record);
  } catch {
    // Assessment persistence is best-effort in single-user deployments.
  }
}

booksRouter.post("/api/books/update-block", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "update_block", {
    extra: { page_id: str(req["page_id"]), block_id: str(req["block_id"]) },
  });
  const block = await resolved.engine.update_block({
    book_id,
    page_id: str(req["page_id"]),
    block_id: str(req["block_id"]),
    title: req["title"] == null ? null : str(req["title"]),
    body: req["body"] == null ? null : str(req["body"]),
  });
  if (!block) throw httpError(404, "Block not found or not editable");
  return c.json({ block, book_revision: revision });
});

booksRouter.post("/api/books/progress/visit", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id);
  const progress = resolved.engine.load_progress(book_id);
  if (progress_ops.mark_visited(progress, str(req["page_id"]))) {
    resolved.engine.storage.save_progress(progress);
  }
  return c.json({ progress });
});

booksRouter.post("/api/books/progress/bookmark", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id);
  const progress = resolved.engine.load_progress(book_id);
  progress_ops.toggle_bookmark(progress, str(req["page_id"]));
  resolved.engine.storage.save_progress(progress);
  return c.json({ progress });
});

booksRouter.get("/api/books/:book_id/export", async (c) => {
  const book_id = c.req.param("book_id");
  const eng = resolve_book_or_404(book_id).engine;
  const book = eng.load_book(book_id);
  if (!book) throw httpError(404, "Book not found");
  const markdown = render_book_markdown(book, eng.load_spine(book_id), eng.list_pages(book_id));
  const filename = export_filename(book);
  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
});

booksRouter.get("/api/books/:book_id/health", (c) => {
  const book_id = c.req.param("book_id");
  const resolved = resolve_book_or_404(book_id);
  const eng = resolved.engine;
  let drift: Dict;
  if (resolved.is_shared && !resolved.can_edit) {
    const book = eng.load_book(book_id);
    const stale = book?.stale_page_ids ?? [];
    drift = {
      book_id, has_drift: stale.length > 0, new_kbs: [], removed_kbs: [],
      changed_kbs: [], stale_page_ids: stale, cached: true,
    };
  } else {
    drift = eng.kb_drift_report(book_id);
  }
  return c.json({ kb_drift: drift, log_health: eng.log_health(book_id), generation: eng.generation_summary(book_id) });
});

booksRouter.post("/api/books/:book_id/refresh-fingerprints", (c) => {
  const book_id = c.req.param("book_id");
  const force = c.req.query("force") === "true";
  const expected = c.req.query("expected_revision");
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const eng = resolved.engine;
  try {
    eng.check_refresh_kb_fingerprints(book_id, force);
  } catch (exc) {
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
  const revision = claim_content_mutation(resolved, book_id, expected, "refresh_fingerprints", {
    extra: { force },
  });
  try {
    const result = eng.refresh_kb_fingerprints(book_id, force);
    if (!result) throw httpError(404, "Book not found");
    return c.json({ ...result, book_revision: revision });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
});

booksRouter.post("/api/books/supplement", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "supplement", {
    extra: { page_id: str(req["page_id"]), topic: str(req["topic"]) },
  });
  try {
    const block = await resolved.engine.supplement_for_weakness({
      book_id,
      page_id: str(req["page_id"]),
      topic: str(req["topic"]),
    });
    if (!block) throw httpError(404, "Page not found");
    return c.json({ block, book_revision: revision });
  } catch (exc) {
    if (exc instanceof BookPausedError) throw httpError(409, { code: "book_paused", message: exc.message });
    console.error("supplement failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/page-chat-session", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id);
  const eng = resolved.engine;
  const book = eng.set_page_chat_session(book_id, str(req["page_id"]), str(req["session_id"]));
  if (!book) throw httpError(404, "Book or page not found");
  await tag_book_chat_session(str(req["session_id"]).trim(), { book_id, page_id: str(req["page_id"]) });
  return c.json({ book: book_payload(book, resolved) });
});

booksRouter.post("/api/books/resume", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "resume", { strict: false });
  try {
    const pages = await resolved.engine.resume_book(book_id);
    return c.json({ pages, book_revision: revision });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(404, detail(exc));
    console.error("resume_book failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/pause", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "pause", { strict: false });
  try {
    const pages = await resolved.engine.pause_book(book_id);
    return c.json({ pages, book_revision: revision });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(404, detail(exc));
    console.error("pause_book failed:", exc);
    throw httpError(500, detail(exc));
  }
});

booksRouter.post("/api/books/rebuild", async (c) => {
  const req = await body(c);
  const book_id = str(req["book_id"]);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  const revision = claim_content_mutation(resolved, book_id, req["expected_revision"], "rebuild");
  const block_types = req["block_types"];
  persist_requested_block_types(resolved, book_id, Array.isArray(block_types) ? block_types.map(String) : null);
  try {
    const pages = await resolved.engine.rebuild_book(book_id, req["auto_compile"] !== false);
    return c.json({ pages, book_revision: revision });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(404, detail(exc));
    console.error("rebuild_book failed:", exc);
    throw httpError(500, detail(exc));
  }
});

// ── authoring edits ────────────────────────────────────────────────────────

booksRouter.post("/api/books/:book_id/edits/preview", async (c) => {
  const book_id = c.req.param("book_id");
  const req = (await body(c)) as unknown as BookEdit;
  const resolved = resolve_book_or_404(book_id, { edit: true });
  try {
    return c.json(preview_edit(resolved.engine.storage, book_id, req));
  } catch (exc) {
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
});

booksRouter.get("/api/books/:book_id/edits", (c) => {
  const book_id = c.req.param("book_id");
  const page_id = c.req.query("page_id");
  const resolved = resolve_book_or_404(book_id, { edit: true });
  try {
    return c.json({ edits: list_edits(resolved.engine.storage, book_id, page_id ?? null) });
  } catch (exc) {
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
});

booksRouter.post("/api/books/:book_id/edits/:edit_id/apply", async (c) => {
  const book_id = c.req.param("book_id");
  const edit_id = c.req.param("edit_id");
  const req = await body(c);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  try {
    const result = apply_edit(resolved.engine.storage, book_id, edit_id, Math.trunc(Number(req["expected_revision"])));
    return c.json(result);
  } catch (exc) {
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
});

booksRouter.post("/api/books/:book_id/edits/:edit_id/undo", async (c) => {
  const book_id = c.req.param("book_id");
  const edit_id = c.req.param("edit_id");
  const req = await body(c);
  const resolved = resolve_book_or_404(book_id, { edit: true });
  try {
    const result = apply_edit(resolved.engine.storage, book_id, edit_id, Math.trunc(Number(req["expected_revision"])), { undo: true });
    return c.json(result);
  } catch (exc) {
    if (isValueError(exc)) throw httpError(409, detail(exc));
    throw exc;
  }
});

// ── channel handler (WS-equivalent over the SSE realtime transport) ────────

export interface BookChannelClient {
  emit(frame: Dict): Promise<void>;
}

const channelSubs = new Map<string, Set<() => void>>();

/**
 * Handle one ``channel=books`` command — the SSE-transport equivalent of the
 * upstream ``/ws/books`` WebSocket. ``emit`` delivers serialized book events
 * (same shape as ``_serialize_event``). Subscribe keeps a live forwarding
 * task alive on the caller's client; call ``releaseBooksChannel(clientKey)``
 * when the client disconnects.
 */
export async function handleBooksChannel(
  client: BookChannelClient,
  clientKey: string,
  message: Dict,
): Promise<{ accepted: boolean }> {
  const emit = (frame: Dict) => client.emit(frame);
  const send = (event: BookEvent | Dict) => emit("seq" in event ? serialize_event(event as BookEvent) : event);

  const msg_type = str(message["type"]).trim();
  if (!msg_type) {
    await emit({ type: "error", content: "Missing 'type' field" });
    return { accepted: true };
  }

  const book_id = str(message["book_id"]).trim();

  // subscribe: stream book events to this client until released.
  if (msg_type === "subscribe") {
    if (!book_id) {
      await emit({ type: "error", content: "subscribe requires book_id" });
      return { accepted: true };
    }
    const bus = get_book_bus(book_id);
    let after_seq = 0;
    try {
      after_seq = Math.max(0, Math.trunc(Number(message["after_seq"] ?? 0)));
    } catch { /* keep 0 */ }
    const reset = after_seq > bus.latest_seq;
    const effective = reset ? 0 : after_seq;
    await emit({ type: "subscribed", book_id, latest_seq: bus.latest_seq, reset });
    const sub = bus.subscribe(effective);
    const key = `${clientKey}:${book_id}`;
    const cleanups = channelSubs.get(key) ?? new Set<() => void>();
    cleanups.add(() => sub.close());
    channelSubs.set(key, cleanups);
    void (async () => {
      try {
        for (;;) {
          const event = await sub.next();
          if (!event || event.source !== SOURCE) {
            if (!event) break;
            continue;
          }
          await emit(serialize_event(event));
        }
      } catch { /* client gone */ }
      cleanups.delete(sub.close);
      if (!cleanups.size) channelSubs.delete(key);
    })();
    return { accepted: true };
  }

  const eng = engine();
  const resolved = book_id ? resolve_book(book_id) : null;
  if (book_id && !resolved) {
    await emit({ type: "error", content: `Book not found: ${book_id}` });
    return { accepted: true };
  }

  // Attach this client to the book's stream for action events.
  const attachBus = (id: string) => {
    const bus = get_book_bus(id);
    const key = `${clientKey}:${id}`;
    const cleanups = channelSubs.get(key) ?? new Set<() => void>();
    const sub = bus.subscribe(bus.latest_seq);
    const cleanup = () => sub.close();
    cleanups.add(cleanup);
    channelSubs.set(key, cleanups);
    void (async () => {
      try {
        for (;;) {
          const event = await sub.next();
          if (!event) break;
          if (event.source !== SOURCE) continue;
          await emit(serialize_event(event));
        }
      } catch { /* ignore */ }
      cleanups.delete(cleanup);
      if (!cleanups.size) channelSubs.delete(key);
    })();
  };

  try {
    if (msg_type === "create") {
      if (!str(message["user_intent"])) {
        await emit({ type: "error", content: "user_intent is required" });
        return { accepted: true };
      }
      const creationBus = new (await import("../services/books/streaming.js")).StreamBus();
      const sub = creationBus.subscribe(0);
      void (async () => {
        for (;;) {
          const event = await sub.next();
          if (!event) break;
          if (event.source !== SOURCE) continue;
          await emit(serialize_event(event));
        }
      })();
      const { book, proposal } = await eng.create_book({
        user_intent: str(message["user_intent"]),
        source_refs: (message["source_refs"] as Dict[]) ?? [],
        chat_session_id: str(message["chat_session_id"]),
        chat_selections: (message["chat_selections"] as Dict[]) ?? [],
        notebook_refs: (message["notebook_refs"] as Dict[]) ?? [],
        knowledge_bases: Array.isArray(message["knowledge_bases"]) ? message["knowledge_bases"].map(String) : [],
        question_categories: numArray(message["question_categories"]),
        question_entries: numArray(message["question_entries"]),
        language: str(message["language"], "en"),
        fallback_language: str(message["fallback_language"], "en"),
        depth: str(message["depth"], "standard"),
        stream: creationBus,
      });
      attachBus(book.id);
      creationBus.mark_closed();
      await emit({ type: "create_result", book, proposal });
    } else if (msg_type === "confirm_proposal") {
      if (!resolved?.can_edit) throw httpError(404, "Book not found");
      attachBus(book_id);
      const revision = claim_content_mutation(resolved!, book_id, message["expected_revision"], "confirm_proposal");
      const edited = message["proposal"] ? (message["proposal"] as BookProposal) : null;
      const { book, spine } = await resolved!.engine.confirm_proposal({ book_id, edited_proposal: edited });
      await emit({ type: "confirm_proposal_result", book, spine, book_revision: revision });
    } else if (msg_type === "confirm_spine") {
      if (!resolved?.can_edit) throw httpError(404, "Book not found");
      attachBus(book_id);
      const revision = claim_content_mutation(resolved!, book_id, message["expected_revision"], "confirm_spine");
      const edited = message["spine"] ? (message["spine"] as Spine) : null;
      const pages = await resolved!.engine.confirm_spine({
        book_id,
        edited_spine: edited,
        auto_compile: message["auto_compile"] !== false,
      });
      await emit({ type: "confirm_spine_result", pages, book_revision: revision });
    } else if (msg_type === "compile_page") {
      if (!resolved?.can_edit) throw httpError(404, "Book not found");
      attachBus(book_id);
      const revision = claim_content_mutation(resolved!, book_id, message["expected_revision"], "compile_page", {
        extra: { page_id: str(message["page_id"]) },
        strict: false,
      });
      const page = await resolved!.engine.compile_page({
        book_id, page_id: str(message["page_id"]), force: message["force"] === true,
      });
      await emit({ type: "compile_page_result", page, book_revision: revision });
    } else if (msg_type === "regenerate_block") {
      if (!resolved?.can_edit) throw httpError(404, "Book not found");
      attachBus(book_id);
      const revision = claim_content_mutation(resolved!, book_id, message["expected_revision"], "regenerate_block", {
        extra: { page_id: str(message["page_id"]), block_id: str(message["block_id"]) },
      });
      const block = await resolved!.engine.regenerate_block({
        book_id,
        page_id: str(message["page_id"]),
        block_id: str(message["block_id"]),
        params_override: (message["params_override"] as Dict) ?? null,
      });
      await emit({ type: "regenerate_block_result", block: block ?? null, book_revision: revision });
    } else {
      await emit({ type: "error", content: `Unknown message type: ${msg_type}` });
    }
  } catch (exc) {
    if (exc instanceof BookPausedError) {
      await emit({ type: "error", content: exc.message, status: 409, code: "book_paused" });
    } else {
      const e = exc as Error & { status?: number; detail?: unknown };
      const detailObj = e.detail;
      const payload: Dict = {
        type: "error",
        content:
          detailObj && typeof detailObj === "object"
            ? str((detailObj as Dict)["message"] ?? (detailObj as Dict)["code"] ?? "Book action failed")
            : typeof detailObj === "string"
              ? detailObj
              : detail(exc),
        status: e.status ?? 500,
      };
      if (detailObj && typeof detailObj === "object") {
        for (const key of ["code", "current_revision"]) {
          if (key in (detailObj as Dict)) payload[key] = (detailObj as Dict)[key];
        }
      }
      await emit(payload);
    }
  }
  return { accepted: true };
}

/** Release all book subscriptions owned by a client (call on disconnect). */
export function releaseBooksChannel(clientKey: string): void {
  for (const [key, cleanups] of [...channelSubs.entries()]) {
    if (!key.startsWith(`${clientKey}:`)) continue;
    for (const cleanup of cleanups) {
      try { cleanup(); } catch { /* ignore */ }
    }
    channelSubs.delete(key);
  }
}

// Tag book chat sessions — thin port of deeptutor/book/chat_sessions.py.
// (Kept in a sibling module to keep this file focused.)
void tag_book_chat_session;
void get_book_stream;
void get_book_bus;
