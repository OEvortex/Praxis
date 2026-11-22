// per-book directory + per-page file
// persistence with atomic writes.
//
// Layout (relative to ``<book_root>/``)::
//
//     book_{book_id}/
//     ├── manifest.json    # Book metadata
//     ├── spine.json       # Spine
//     ├── progress.json    # Progress
//     ├── inputs.json      # Captured BookInputs
//     ├── learning_captures.json
//     ├── exploration.json
//     ├── log.md           # Append-only operation log
//     ├── pages/{page_id}.json
//     └── assets/...
//
// The root defaults to ``<data_dir>/book`` (env override ``PRAXIS_BOOK_DIR``),
// the analogue of upstream's workspace "book" feature dir.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { get_settings, type Settings } from "../../config.js";
import {
  make_block,
  make_chapter,
  make_page,
  type Block,
  type Book,
  type BookInputs,
  type Chapter,
  type ExplorationReport,
  type LearningCapture,
  type LearningCaptureStatus,
  type Page,
  type PageLink,
  type Progress,
  type Spine,
} from "./models.js";

const SAFE_ID = /[^A-Za-z0-9_-]/;

export function safe_book_id(book_id: string): string {
  const value = (book_id ?? "").trim();
  if (!value || SAFE_ID.test(value)) {
    throw new ValueError(`Invalid book id: ${JSON.stringify(book_id)}`);
  }
  return value;
}

export function safe_page_id(page_id: string): string {
  const value = (page_id ?? "").trim();
  if (!value || SAFE_ID.test(value)) {
    throw new ValueError(`Invalid page id: ${JSON.stringify(page_id)}`);
  }
  return value;
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export function isValueError(e: unknown): e is ValueError {
  return e instanceof ValueError || (e instanceof Error && e.name === "ValueError");
}

/** Atomic text write via tmp file + rename (port of atomic_write_text). */
export function atomic_write_text(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

export function atomic_write_json(path: string, payload: unknown): void {
  atomic_write_text(path, JSON.stringify(payload, null, 2));
}

export function read_json<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ── coercion helpers (model_validate equivalents) ────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStr(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : v == null ? dflt : String(v);
}

function asNum(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function asStrArray(v: unknown): string[] {
  return asArray(v).map((x) => String(x));
}

export function coerceBook(data: unknown): Book | null {
  const d = asRecord(data);
  if (!d.id) return null;
  return {
    id: asStr(d.id),
    revision: Math.max(1, Math.trunc(asNum(d.revision, 1))),
    title: asStr(d.title),
    description: asStr(d.description),
    status: (asStr(d.status, "draft") || "draft") as Book["status"],
    proposal: d.proposal == null ? null : (asRecord(d.proposal) as Book["proposal"]),
    knowledge_bases: asStrArray(d.knowledge_bases),
    language: asStr(d.language, "en"),
    depth: (asStr(d.depth, "standard") || "standard") as Book["depth"],
    page_count: Math.trunc(asNum(d.page_count)),
    chapter_count: Math.trunc(asNum(d.chapter_count)),
    created_at: asNum(d.created_at),
    updated_at: asNum(d.updated_at),
    metadata: asRecord(d.metadata),
    kb_fingerprints: asRecord(d.kb_fingerprints) as Record<string, string>,
    kb_document_fingerprints: asRecord(
      d.kb_document_fingerprints,
    ) as Record<string, Record<string, string>>,
    stale_page_ids: asStrArray(d.stale_page_ids),
    stale_detected_at: asNum(d.stale_detected_at),
    ...Object.fromEntries(
      Object.entries(d).filter(
        (k) =>
          ![
            "id",
            "revision",
            "title",
            "description",
            "status",
            "proposal",
            "knowledge_bases",
            "language",
            "depth",
            "page_count",
            "chapter_count",
            "created_at",
            "updated_at",
            "metadata",
            "kb_fingerprints",
            "kb_document_fingerprints",
            "stale_page_ids",
            "stale_detected_at",
          ].includes(k[0]),
      ),
    ),
  };
}

export function coerceSpine(data: unknown): Spine | null {
  const d = asRecord(data);
  if (!d.book_id && !Array.isArray(d.chapters)) return null;
  return {
    book_id: asStr(d.book_id),
    chapters: asArray(d.chapters).map((c) => coerceChapter(c)),
    version: Math.trunc(asNum(d.version, 1)),
    updated_at: asNum(d.updated_at),
    concept_graph: coerceConceptGraph(d.concept_graph),
    exploration_summary: asStr(d.exploration_summary),
    ...Object.fromEntries(
      Object.entries(d).filter(
        (k) => !["book_id", "chapters", "version", "updated_at", "concept_graph", "exploration_summary"].includes(k[0]),
      ),
    ),
  };
}

export function coerceChapter(data: unknown): Chapter {
  const d = asRecord(data);
  const base = make_chapter({
    title: asStr(d.title),
    summary: asStr(d.summary),
    order: Math.trunc(asNum(d.order)),
  });
  return {
    ...base,
    id: asStr(d.id) || base.id,
    learning_objectives: asStrArray(d.learning_objectives),
    content_type: (asStr(d.content_type, "theory") || "theory") as Chapter["content_type"],
    source_anchors: asArray(d.source_anchors).map((a) => asRecord(a)),
    prerequisites: asStrArray(d.prerequisites),
    page_ids: asStrArray(d.page_ids),
    ...Object.fromEntries(
      Object.entries(d).filter(
        (k) =>
          ![
            "id",
            "title",
            "learning_objectives",
            "content_type",
            "source_anchors",
            "prerequisites",
            "page_ids",
            "summary",
            "order",
          ].includes(k[0]),
      ),
    ),
  };
}

export function coerceConceptGraph(data: unknown): Spine["concept_graph"] {
  const d = asRecord(data);
  return {
    nodes: asArray(d.nodes).map((n) => {
      const r = asRecord(n);
      return {
        id: asStr(r.id),
        label: asStr(r.label),
        chapter_id: asStr(r.chapter_id),
        description: asStr(r.description),
        weight: asNum(r.weight, 1),
        ...r,
      };
    }),
    edges: asArray(d.edges).map((e) => {
      const r = asRecord(e);
      return {
        src: asStr(r.src),
        dst: asStr(r.dst),
        relation: asStr(r.relation, "depends_on") || "depends_on",
        rationale: asStr(r.rationale),
        ...r,
      };
    }),
  };
}

export function coerceBlock(data: unknown): Block {
  const d = asRecord(data);
  const base = make_block({ title: asStr(d.title) });
  return {
    ...base,
    ...d,
    id: asStr(d.id) || base.id,
    type: (asStr(d.type, "text") || "text") as Block["type"],
    status: (asStr(d.status, "pending") || "pending") as Block["status"],
    params: asRecord(d.params),
    payload: asRecord(d.payload),
    source_anchors: asArray(d.source_anchors).map((a) => asRecord(a)),
    metadata: asRecord(d.metadata),
    error: asStr(d.error),
    created_at: asNum(d.created_at, base.created_at),
    updated_at: asNum(d.updated_at, base.updated_at),
  };
}

export function coercePage(data: unknown): Page | null {
  const d = asRecord(data);
  if (!d.id) return null;
  const base = make_page({ book_id: asStr(d.book_id), title: asStr(d.title) });
  return {
    ...base,
    ...d,
    id: asStr(d.id),
    chapter_id: asStr(d.chapter_id),
    learning_objectives: asStrArray(d.learning_objectives),
    content_type: (asStr(d.content_type, "theory") || "theory") as Page["content_type"],
    status: (asStr(d.status, "pending") || "pending") as Page["status"],
    order: Math.trunc(asNum(d.order)),
    blocks: asArray(d.blocks).map((b) => coerceBlock(b)),
    links: asArray(d.links).map((l) => asRecord(l) as PageLink),
    parent_page_id: asStr(d.parent_page_id),
    error: asStr(d.error),
    created_at: asNum(d.created_at, base.created_at),
    updated_at: asNum(d.updated_at, base.updated_at),
  };
}

export function coerceProgress(data: unknown): Progress | null {
  const d = asRecord(data);
  if (!d.book_id) return null;
  return {
    book_id: asStr(d.book_id),
    current_page_id: asStr(d.current_page_id),
    visited_page_ids: asStrArray(d.visited_page_ids),
    bookmarked_page_ids: asStrArray(d.bookmarked_page_ids),
    quiz_attempts: asArray(d.quiz_attempts).map((a) => ({
      ...asRecord(a),
      timestamp: asNum(asRecord(a).timestamp),
    })) as Progress["quiz_attempts"],
    weak_chapters: asStrArray(d.weak_chapters),
    score: Math.trunc(asNum(d.score)),
    updated_at: asNum(d.updated_at),
    ...Object.fromEntries(
      Object.entries(d).filter(
        (k) =>
          ![
            "book_id",
            "current_page_id",
            "visited_page_ids",
            "bookmarked_page_ids",
            "quiz_attempts",
            "weak_chapters",
            "score",
            "updated_at",
          ].includes(k[0]),
      ),
    ),
  };
}

export function coerceLearningCapture(data: unknown): LearningCapture | null {
  const d = asRecord(data);
  if (!d.id) return null;
  return {
    id: asStr(d.id),
    book_id: asStr(d.book_id),
    page_id: asStr(d.page_id),
    block_id: asStr(d.block_id),
    capture_type: asStr(d.capture_type, "selection") || "selection",
    source_text: asStr(d.source_text),
    context_before: asStr(d.context_before),
    context_after: asStr(d.context_after),
    source_locator: asStr(d.source_locator),
    book_title: asStr(d.book_title),
    chapter_title: asStr(d.chapter_title),
    user_note: asStr(d.user_note),
    content_hash: asStr(d.content_hash),
    status: (asStr(d.status, "captured") || "captured") as LearningCaptureStatus,
    version: Math.trunc(asNum(d.version, 1)),
    rejected_reason: asStr(d.rejected_reason),
    created_at: asNum(d.created_at),
    updated_at: asNum(d.updated_at),
    ...Object.fromEntries(
      Object.entries(d).filter(
        (k) =>
          ![
            "id",
            "book_id",
            "page_id",
            "block_id",
            "capture_type",
            "source_text",
            "context_before",
            "context_after",
            "source_locator",
            "book_title",
            "chapter_title",
            "user_note",
            "content_hash",
            "status",
            "version",
            "rejected_reason",
            "created_at",
            "updated_at",
          ].includes(k[0]),
      ),
    ),
  };
}

export function coerceBookInputs(data: unknown): BookInputs | null {
  const d = asRecord(data);
  if (!Object.keys(d).length) return null;
  return d as BookInputs;
}

export function coerceExplorationReport(data: unknown): ExplorationReport | null {
  const d = asRecord(data);
  if (!Object.keys(d).length) return null;
  return d as ExplorationReport;
}

// ── storage ────────────────────────────────────────────────────────────────

export class BookStorage {
  constructor(private readonly settings?: Settings) {}

  get settings_(): Settings {
    return this.settings ?? get_settings();
  }

  /** Root directory holding all books (one sub-directory per book). */
  get_book_dir(): string {
    const override = (process.env.PRAXIS_BOOK_DIR ?? "").trim();
    if (override) return override;
    return join(this.settings_.data_dir, "book");
  }

  book_root(book_id: string): string {
    return join(this.get_book_dir(), `book_${safe_book_id(book_id)}`);
  }

  ensure_book_root(book_id: string): string {
    const root = this.book_root(book_id);
    mkdirSync(join(root, "pages"), { recursive: true });
    mkdirSync(join(root, "assets"), { recursive: true });
    return root;
  }

  list_book_ids(): string[] {
    const root = this.get_book_dir();
    if (!existsSync(root)) return [];
    const ids: string[] = [];
    for (const child of readdirSync(root, { withFileTypes: true })) {
      if (!child.isDirectory() || !child.name.startsWith("book_")) continue;
      try {
        ids.push(safe_book_id(child.name.slice("book_".length)));
      } catch {
        // skip invalid directory names, same as upstream
      }
    }
    return ids;
  }

  book_exists(book_id: string): boolean {
    try {
      return existsSync(this.book_root(book_id));
    } catch {
      return false;
    }
  }

  // ── manifest ──
  save_book(book: Book): void {
    this.ensure_book_root(book.id);
    atomic_write_json(
      join(this.book_root(book.id), "manifest.json"),
      book,
    );
  }

  load_book(book_id: string): Book | null {
    try {
      safe_book_id(book_id);
    } catch {
      return null;
    }
    const data = read_json(join(this.book_root(book_id), "manifest.json"));
    return data == null ? null : coerceBook(data);
  }

  // ── inputs ──
  save_inputs(book_id: string, inputs: BookInputs): void {
    this.ensure_book_root(book_id);
    atomic_write_json(join(this.book_root(book_id), "inputs.json"), inputs);
  }

  load_inputs(book_id: string): BookInputs | null {
    try {
      safe_book_id(book_id);
    } catch {
      return null;
    }
    const data = read_json(join(this.book_root(book_id), "inputs.json"));
    return data == null ? null : coerceBookInputs(data);
  }

  // ── spine ──
  save_spine(spine: Spine): void {
    const book_id = safe_book_id(spine.book_id);
    this.ensure_book_root(book_id);
    atomic_write_json(join(this.book_root(book_id), "spine.json"), spine);
  }

  load_spine(book_id: string): Spine | null {
    try {
      safe_book_id(book_id);
    } catch {
      return null;
    }
    const data = read_json(join(this.book_root(book_id), "spine.json"));
    return data == null ? null : coerceSpine(data);
  }

  // ── exploration report ──
  save_exploration(book_id: string, report: ExplorationReport): void {
    this.ensure_book_root(book_id);
    report.book_id = report.book_id || book_id;
    atomic_write_json(join(this.book_root(book_id), "exploration.json"), report);
  }

  load_exploration(book_id: string): ExplorationReport | null {
    const data = read_json(join(this.book_root(book_id), "exploration.json"));
    return data == null ? null : coerceExplorationReport(data);
  }

  // ── progress ──
  save_progress(progress: Progress): void {
    this.ensure_book_root(progress.book_id);
    atomic_write_json(join(this.book_root(progress.book_id), "progress.json"), progress);
  }

  load_progress(book_id: string): Progress | null {
    try {
      safe_book_id(book_id);
    } catch {
      return null;
    }
    const data = read_json(join(this.book_root(book_id), "progress.json"));
    return data == null ? null : coerceProgress(data);
  }

  // ── learning captures ──
  get_learning_captures_path(book_id: string): string {
    return join(this.book_root(book_id), "learning_captures.json");
  }

  private _sort_captures(captures: LearningCapture[]): LearningCapture[] {
    return [...captures].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }

  load_learning_captures(
    book_id: string,
    status?: LearningCaptureStatus | null,
  ): LearningCapture[] {
    const data = read_json<unknown[]>(this.get_learning_captures_path(book_id));
    if (!Array.isArray(data)) return [];
    const out: LearningCapture[] = [];
    for (const raw of data) {
      const capture = coerceLearningCapture(raw);
      if (!capture) continue;
      if (status != null && capture.status !== status) continue;
      out.push(capture);
    }
    return this._sort_captures(out);
  }

  load_learning_capture(book_id: string, capture_id: string): LearningCapture | null {
    for (const capture of this.load_learning_captures(book_id)) {
      if (capture.id === capture_id) return capture;
    }
    return null;
  }

  save_learning_captures(book_id: string, captures: LearningCapture[]): void {
    this.ensure_book_root(book_id);
    atomic_write_json(
      this.get_learning_captures_path(book_id),
      this._sort_captures(captures),
    );
  }

  upsert_learning_capture(capture: LearningCapture): void {
    const captures = this.load_learning_captures(capture.book_id);
    const idx = captures.findIndex((c) => c.id === capture.id);
    if (idx >= 0) captures[idx] = capture;
    else captures.push(capture);
    this.save_learning_captures(capture.book_id, captures);
  }

  // ── pages ──
  save_page(page: Page): void {
    const book_id = safe_book_id(page.book_id);
    const page_id = safe_page_id(page.id);
    this.ensure_book_root(book_id);
    atomic_write_json(join(this.book_root(book_id), "pages", `${page_id}.json`), page);
  }

  load_page(book_id: string, page_id: string): Page | null {
    try {
      safe_book_id(book_id);
      safe_page_id(page_id);
    } catch {
      return null;
    }
    const data = read_json(join(this.book_root(book_id), "pages", `${page_id}.json`));
    return data == null ? null : coercePage(data);
  }

  list_pages(book_id: string): Page[] {
    const pages_dir = join(this.book_root(book_id), "pages");
    if (!existsSync(pages_dir)) return [];
    const result: Page[] = [];
    for (const name of readdirSync(pages_dir)) {
      if (!name.endsWith(".json")) continue;
      const data = read_json(join(pages_dir, name));
      if (data == null) continue;
      const page = coercePage(data);
      if (page) result.push(page);
    }
    const spine = this.load_spine(book_id);
    const positions = new Map<string, [number, number]>();
    (spine?.chapters ?? []).forEach((chapter, index) => {
      chapter.page_ids.forEach((pid, section) => positions.set(pid, [index, section]));
    });
    result.sort((a, b) => {
      const pa = positions.get(a.id) ?? [a.order, 100000];
      const pb = positions.get(b.id) ?? [b.order, 100000];
      if (pa[0] !== pb[0]) return pa[0] - pb[0];
      if (pa[1] !== pb[1]) return pa[1] - pb[1];
      return (a.created_at ?? 0) - (b.created_at ?? 0);
    });
    return result;
  }

  delete_page(book_id: string, page_id: string): boolean {
    try {
      const path = join(
        this.book_root(safe_book_id(book_id)),
        "pages",
        `${safe_page_id(page_id)}.json`,
      );
      if (existsSync(path)) {
        rmSync(path);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── log (append-only) ──
  append_log(book_id: string, message: string, op = "info"): void {
    const path = join(this.book_root(safe_book_id(book_id)), "log.md");
    mkdirSync(join(path, ".."), { recursive: true });
    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace("T", " ").slice(0, 19);
    appendFileSync(path, `- \`${ts}Z\` **${op}** — ${message.trim()}\n`, "utf-8");
  }

  // ── delete ──
  delete_book(book_id: string): boolean {
    const root = this.book_root(book_id);
    if (!existsSync(root)) return false;
    rmSync(root, { recursive: true, force: true });
    return !existsSync(root);
  }
}

// ── singleton ──────────────────────────────────────────────────────────────

const _storages = new Map<string, BookStorage>();

export function get_book_storage(settings?: Settings): BookStorage {
  const key = (settings ?? get_settings()).data_dir;
  let storage = _storages.get(key);
  if (!storage) {
    storage = new BookStorage(settings);
    _storages.set(key, storage);
  }
  return storage;
}
