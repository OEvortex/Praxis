// Port of backend/app/services/documents/storage.py — Co-Writer document store.
//
// Notebook pages live in the shared SQLite database: each page is one row in
// `documents`, with the review queue, margin threads and flashcard scheduling
// kept in `doc_extras` and binary attachments in `doc_assets`. Page snapshots
// live in `document_versions`.
//
// Method names keep the Python snake_case surface so sibling ported modules
// (routes, proposals, noteui) can call them unchanged.

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { getDb, query, queryOne, run } from "../../shared/db.js";
import { get_settings } from "../../config.js";
import type { Dict } from "../../shared/types.js";

import {
  blocks_to_markdown as blocksToMarkdown,
  coarse_markdown_to_blocks as coarseMarkdownToBlocks,
  validate_blocks as validateBlocks,
} from "./blocks.js";

// proposals.ts is ported lazily in Python (`from .proposals import ...` inside
// update_document); mirror that with a lazy require so a missing module does
// not break block saves.
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

function _loadProposals(): Record<string, unknown> | null {
  for (const spec of ["./proposals.js", "./proposals.ts"]) {
    try {
      return _require(spec) as Record<string, unknown>;
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface CoWriterDocument {
  id: string;
  title: string;
  content: string;
  blocks: Dict[] | null;
  schema_version: number;
  revision: number;
  parent_id: string | null;
  icon: string;
  cover: string;
  pinned: boolean;
  tags: string[];
  applied_suggestion_ids: string[];
  created_at: number;
  updated_at: number;
}

export interface CoWriterDocumentSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  preview: string;
  parent_id: string | null;
  icon: string;
  cover: string;
  pinned: boolean;
  revision: number;
}

export interface VersionSummary {
  id: string;
  doc_id: string;
  revision: number;
  created_at: number;
  source: string;
  title: string;
  char_count: number;
  word_count: number;
}

export interface VersionDetail extends VersionSummary {
  content: string;
  blocks: Dict[] | null;
}

export class RevisionConflict extends Error {}

const MAX_VERSIONS_PER_DOCUMENT = 100;
const VERSION_COALESCE_SECONDS = 300;

// ---------------------------------------------------------------------------
// Schema (mirrors the document tables in backend/app/store/database.py).
// ---------------------------------------------------------------------------

let _tablesReady = false;
export function ensureDocumentTables(): void {
  if (_tablesReady) return;
  getDb().exec(`
CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);

CREATE TABLE IF NOT EXISTS doc_extras (
    doc_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_id, kind)
);

CREATE TABLE IF NOT EXISTS doc_assets (
    doc_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    data BLOB NOT NULL,
    created_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_id, name)
);

CREATE TABLE IF NOT EXISTS document_versions (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    created_at REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'edit',
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL,
    char_count INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_document_versions_doc
    ON document_versions(doc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_versions_doc_rev
    ON document_versions(doc_id, revision DESC);
`);
  _tablesReady = true;
}

// ---------------------------------------------------------------------------
// Title / preview helpers
// ---------------------------------------------------------------------------

function deriveTitle(content: string, fallback = "Untitled draft"): string {
  if (!content) return fallback;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const stripped = line.replace(/^#+/, "").trim();
      if (stripped) return stripped.slice(0, 120);
    }
    return line.slice(0, 120);
  }
  return fallback;
}

const FENCE_RE = /^\s*(```|~~~)/;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const LINE_MARK_RE = /^(?:#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)+/;
const EMPHASIS_RE = /(\*\*|__|~~|`)/g;
const RULE_RE = /^\s*([-*_]\s*){3,}$/;
const TABLE_RULE_RE = /^\s*\|?\s*:?-{2,}/;

function plainLines(content: string): string[] {
  const lines: string[] = [];
  let fenced = false;
  for (const raw of content.split("\n")) {
    if (FENCE_RE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || RULE_RE.test(raw) || TABLE_RULE_RE.test(raw)) continue;
    let line = raw.trim();
    if (line.startsWith("|")) {
      line = line
        .replace(/^\|+|\|+$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" · ");
    }
    line = line
      .replace(IMAGE_RE, "")
      .replace(LINK_RE, "$1")
      .replace(TAG_RE, "")
      .trim();
    line = line.replace(LINE_MARK_RE, "").replace(EMPHASIS_RE, "").replace(/\$\$/g, "").trim();
    if (line) lines.push(line);
  }
  return lines;
}

function buildPreview(content: string, limit = 160, title = ""): string {
  if (!content) return "";
  let lines = plainLines(content);
  // A page usually opens with its own title as a heading; the card shows it already.
  if (lines.length && title && lines[0].trim().toLowerCase() === title.trim().toLowerCase()) {
    lines = lines.slice(1);
  }
  const cleaned = lines.join("  ");
  if (cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, limit).replace(/\s+$/, "") + "…";
}

// ---------------------------------------------------------------------------
// Model (de)serialisation — pydantic model_validate equivalents
// ---------------------------------------------------------------------------

const ID_RE = /^[0-9a-f]{8,32}$/;

function toDocument(raw: unknown): CoWriterDocument | null {
  if (raw === null || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== "string" || !d.id) return null;
  return {
    id: d.id,
    title: typeof d.title === "string" ? d.title : "",
    content: typeof d.content === "string" ? d.content : "",
    blocks: Array.isArray(d.blocks) ? (d.blocks as Dict[]) : null,
    schema_version: typeof d.schema_version === "number" ? d.schema_version : 1,
    revision: typeof d.revision === "number" ? d.revision : 0,
    parent_id: typeof d.parent_id === "string" ? d.parent_id : null,
    icon: typeof d.icon === "string" ? d.icon : "",
    cover: typeof d.cover === "string" ? d.cover : "",
    pinned: d.pinned === true,
    tags: Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === "string") : [],
    applied_suggestion_ids: Array.isArray(d.applied_suggestion_ids)
      ? d.applied_suggestion_ids.filter((t): t is string => typeof t === "string")
      : [],
    created_at: typeof d.created_at === "number" ? d.created_at : 0,
    updated_at: typeof d.updated_at === "number" ? d.updated_at : 0,
  };
}

function dumpDocument(document: CoWriterDocument): string {
  return JSON.stringify(document);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class CoWriterStorage {
  constructor(_root?: unknown) {
    // ``root`` is accepted for backwards compatibility; pages live in the DB.
    ensureDocumentTables();
  }

  private static _checkId(docId: string): string {
    if (!ID_RE.test(docId ?? "")) throw new Error("Invalid page ID");
    return docId;
  }

  docExists(docId: string): boolean {
    try {
      docId = CoWriterStorage._checkId(docId);
    } catch {
      return false;
    }
    return (
      queryOne("SELECT 1 AS one FROM documents WHERE id = ?", docId) !== undefined
    );
  }

  // ── CRUD ─────────────────────────────────────────────────────────────

  listDocIds(): string[] {
    const rows = query<{ id: string }>(
      "SELECT id FROM documents ORDER BY updated_at DESC"
    );
    return rows.map((row) => String(row.id));
  }

  listDocuments(): CoWriterDocumentSummary[] {
    const summaries: CoWriterDocumentSummary[] = [];
    for (const docId of this.listDocIds()) {
      const doc = this.loadDocument(docId);
      if (doc === null) continue;
      summaries.push({
        id: doc.id,
        title: doc.title || deriveTitle(doc.content),
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        preview: buildPreview(doc.content, 160, doc.title),
        parent_id: doc.parent_id,
        icon: doc.icon,
        cover: doc.cover,
        pinned: doc.pinned,
        revision: doc.revision,
      });
    }
    summaries.sort((a, b) => b.updated_at - a.updated_at);
    return summaries;
  }

  createDocument(opts: {
    title?: string | null;
    content?: string;
    blocks?: Dict[] | null;
    parent_id?: string | null;
    tags?: string[] | null;
  } = {}): CoWriterDocument {
    return this.locked(() => {
      const { title = null, content = "", blocks = null, parent_id = null, tags = null } =
        opts;
      if (parent_id && this.loadDocument(parent_id) === null) {
        throw new Error("Parent page does not exist");
      }
      let resolvedContent = content;
      if (blocks !== null && blocks !== undefined) {
        resolvedContent = blocksToMarkdown(validateBlocks(blocks));
      }
      let docId = randomUUID().replace(/-/g, "").slice(0, 12);
      // Avoid extremely unlikely collisions.
      while (this.docExists(docId)) {
        docId = randomUUID().replace(/-/g, "").slice(0, 12);
      }

      const now = Date.now() / 1000;
      const resolvedTitle =
        (title ?? "").trim() || deriveTitle(resolvedContent, "Untitled draft");
      const document: CoWriterDocument = {
        id: docId,
        title: resolvedTitle,
        content: resolvedContent,
        blocks: blocks ?? null,
        schema_version: 1,
        revision: 0,
        parent_id: parent_id ?? null,
        icon: "",
        cover: "",
        pinned: false,
        tags: (tags ?? []).map((t) => t.trim()).filter(Boolean),
        applied_suggestion_ids: [],
        created_at: now,
        updated_at: now,
      };
      this._write(document, "create");
      return document;
    });
  }

  ensureBlockDocument(docId: string): CoWriterDocument | null {
    // Give a markdown-only page block IDs so edits can be proposed on it.
    // The markdown projection is left untouched.
    return this.locked(() => {
      const doc = this.loadDocument(docId);
      if (doc === null || doc.blocks !== null) return doc;
      doc.blocks = coarseMarkdownToBlocks(doc.content);
      this._write(doc, "migrate");
      return doc;
    });
  }

  loadDocument(docId: string): CoWriterDocument | null {
    try {
      docId = CoWriterStorage._checkId(docId);
    } catch {
      return null;
    }
    const row = queryOne<{ payload: string }>(
      "SELECT payload FROM documents WHERE id = ?",
      docId
    );
    if (row === undefined) return null;
    try {
      return toDocument(JSON.parse(row.payload));
    } catch (exc) {
      console.warn(`Failed to validate Co-Writer document ${docId}:`, exc);
      return null;
    }
  }

  /**
   * Serialise writers. Node is single-threaded and every storage operation is
   * synchronous (node:sqlite), so the Python RLock has no contention to guard;
   * the queue below keeps the same serialisation contract for any future
   * async caller.
   */
  private _lockTail: Promise<void> = Promise.resolve();

  locked<T>(fn: () => T): T {
    // Synchronous fast-path: run immediately. The promise chain is maintained
    // so that an async variant can be added without changing call sites.
    void this._lockTail;
    return fn();
  }

  /** Async variant of {@link locked} for callers that need real mutual exclusion. */
  async lockedAsync<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this._lockTail;
    let release!: () => void;
    this._lockTail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ── Extras (review queue, threads, flashcard scheduling) ─────────────

  loadExtra(docId: string, kind: string, defaultValue: unknown = null): unknown {
    docId = CoWriterStorage._checkId(docId);
    const row = queryOne<{ payload: string }>(
      "SELECT payload FROM doc_extras WHERE doc_id = ? AND kind = ?",
      docId,
      kind
    );
    if (row === undefined) return defaultValue;
    try {
      return JSON.parse(row.payload);
    } catch {
      return defaultValue;
    }
  }

  saveExtra(docId: string, kind: string, payload: unknown): void {
    docId = CoWriterStorage._checkId(docId);
    run(
      `INSERT INTO doc_extras (doc_id, kind, payload, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(doc_id, kind) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      docId,
      kind,
      JSON.stringify(payload),
      Date.now() / 1000
    );
  }

  // ── Page versions ────────────────────────────────────────────────────

  private static _versionCounts(content: string): [number, number] {
    return [content.length, content.split(/\s+/).filter(Boolean).length];
  }

  private _snapshot(document: CoWriterDocument, source: string): void {
    // Store a complete snapshot of ``document``, coalescing a live session.
    // A snapshot is skipped when the page's text and title did not change.
    const now = Date.now() / 1000;
    const payload = dumpDocument(document);
    const row = queryOne<Record<string, unknown>>(
      `SELECT id, created_at, source, title, content, revision,
              char_count, word_count
       FROM document_versions WHERE doc_id = ? ORDER BY created_at DESC LIMIT 1`,
      document.id
    );
    if (row !== undefined) {
      const sameState =
        row["title"] === document.title &&
        row["content"] === document.content &&
        Number(row["revision"]) === document.revision - 1;
      const coalesce =
        row["source"] === source &&
        now - Number(row["created_at"]) <= VERSION_COALESCE_SECONDS;
      if (sameState) {
        // The text is unchanged (metadata-only write): keep the tail.
        return;
      }
      if (coalesce) {
        const [charCount, wordCount] = CoWriterStorage._versionCounts(document.content);
        run(
          `UPDATE document_versions
           SET revision = ?, created_at = ?, title = ?, content = ?,
               payload = ?, char_count = ?, word_count = ?
           WHERE id = ?`,
          document.revision,
          now,
          document.title,
          document.content,
          payload,
          charCount,
          wordCount,
          row["id"]
        );
        return;
      }
    }
    const [charCount, wordCount] = CoWriterStorage._versionCounts(document.content);
    run(
      `INSERT INTO document_versions
          (id, doc_id, revision, created_at, source, title, content,
           payload, char_count, word_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID().replace(/-/g, ""),
      document.id,
      document.revision,
      now,
      source,
      document.title,
      document.content,
      payload,
      charCount,
      wordCount
    );
    run(
      `DELETE FROM document_versions WHERE doc_id = ? AND id NOT IN (
          SELECT id FROM document_versions WHERE doc_id = ?
          ORDER BY created_at DESC LIMIT ?
      )`,
      document.id,
      document.id,
      MAX_VERSIONS_PER_DOCUMENT
    );
  }

  listVersions(docId: string): VersionSummary[] {
    docId = CoWriterStorage._checkId(docId);
    const rows = query<Record<string, unknown>>(
      `SELECT id, doc_id, revision, created_at, source, title,
              char_count, word_count
       FROM document_versions WHERE doc_id = ? ORDER BY created_at DESC`,
      docId
    );
    return rows.map((row) => ({
      id: String(row["id"]),
      doc_id: String(row["doc_id"]),
      revision: Number(row["revision"]),
      created_at: Number(row["created_at"]),
      source: String(row["source"]),
      title: String(row["title"]),
      char_count: Number(row["char_count"]),
      word_count: Number(row["word_count"]),
    }));
  }

  createVersion(docId: string, source = "manual"): VersionSummary | null {
    // Snapshot the current page explicitly (e.g. "Save version").
    return this.locked(() => {
      const document = this.loadDocument(docId);
      if (document === null) return null;
      this._snapshot(document, source);
      const versions = this.listVersions(docId);
      return versions.length ? versions[0] : null;
    });
  }

  getVersion(docId: string, versionId: string): VersionDetail | null {
    docId = CoWriterStorage._checkId(docId);
    if (!ID_RE.test(versionId ?? "")) return null;
    const row = queryOne<Record<string, unknown>>(
      `SELECT id, doc_id, revision, created_at, source, title, content,
              payload, char_count, word_count
       FROM document_versions WHERE doc_id = ? AND id = ?`,
      docId,
      versionId
    );
    if (row === undefined) return null;
    const data = { ...row };
    const payload = data["payload"];
    delete data["payload"];
    let blocks: Dict[] | null = null;
    if (payload) {
      try {
        const parsed = JSON.parse(String(payload)) as Record<string, unknown>;
        blocks = Array.isArray(parsed.blocks) ? (parsed.blocks as Dict[]) : null;
      } catch {
        blocks = null;
      }
    }
    return {
      id: String(data["id"]),
      doc_id: String(data["doc_id"]),
      revision: Number(data["revision"]),
      created_at: Number(data["created_at"]),
      source: String(data["source"]),
      title: String(data["title"]),
      char_count: Number(data["char_count"]),
      word_count: Number(data["word_count"]),
      content: String(data["content"]),
      blocks,
    };
  }

  restoreVersion(
    docId: string,
    versionId: string,
    expectedRevision: number
  ): CoWriterDocument | null {
    // Restore a snapshot as a *new* revision, never rolling time back.
    return this.locked(() => {
      const version = this.getVersion(docId, versionId);
      const current = this.loadDocument(docId);
      if (version === null || current === null) return null;
      if (current.revision !== expectedRevision) {
        throw new RevisionConflict(
          "This page changed elsewhere. Reload before restoring."
        );
      }
      // Keep the state being left behind available as its own version.
      this._snapshot(current, "before-restore");
      const row = queryOne<{ payload: string }>(
        "SELECT payload FROM document_versions WHERE id = ?",
        version.id
      );
      if (row === undefined) return null;
      let snapshot: CoWriterDocument | null;
      try {
        snapshot = toDocument(JSON.parse(row.payload));
      } catch {
        return null;
      }
      if (snapshot === null) return null;
      for (const key of [
        "title",
        "content",
        "blocks",
        "tags",
        "applied_suggestion_ids",
        "parent_id",
        "icon",
        "cover",
        "pinned",
      ] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (current as any)[key] = (snapshot as any)[key];
      }
      current.revision += 1;
      current.updated_at = Date.now() / 1000;
      this._write(current, "restore");
      return current;
    });
  }

  // ── Assets ───────────────────────────────────────────────────────────

  saveAsset(docId: string, name: string, data: Uint8Array, contentType = ""): void {
    docId = CoWriterStorage._checkId(docId);
    run(
      `INSERT OR REPLACE INTO doc_assets
          (doc_id, name, content_type, data, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      docId,
      name,
      contentType,
      data,
      Date.now() / 1000
    );
  }

  loadAsset(docId: string, name: string): [Uint8Array, string] | null {
    docId = CoWriterStorage._checkId(docId);
    const row = queryOne<{ data: Uint8Array; content_type: string }>(
      "SELECT data, content_type FROM doc_assets WHERE doc_id = ? AND name = ?",
      docId,
      name
    );
    if (row === undefined) return null;
    const data =
      row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data as ArrayBuffer);
    return [data, String(row.content_type ?? "")];
  }

  updateDocument(
    docId: string,
    opts: {
      title?: string | null;
      content?: string | null;
      blocks?: Dict[] | null;
      expected_revision?: number | null;
      source?: string;
      [metadata: string]: unknown;
    } = {}
  ): CoWriterDocument | null {
    return this.locked(() => {
      const {
        title = null,
        content = null,
        blocks = null,
        expected_revision = null,
        source = "save",
        ...metadata
      } = opts;
      // Tolerate camelCase callers; the Python name is expected_revision.
      const expectedRevision =
        expected_revision ??
        (metadata["expectedRevision"] as number | null | undefined) ??
        null;
      delete metadata["expectedRevision"];
      const document = this.loadDocument(docId);
      if (document === null) return null;
      if (expectedRevision !== null && document.revision !== expectedRevision) {
        throw new RevisionConflict(
          "This page changed elsewhere. Reload before saving."
        );
      }
      if (
        (blocks !== null || (document.blocks !== null && content !== null)) &&
        expectedRevision === null
      ) {
        throw new RevisionConflict("Block pages require expected_revision.");
      }
      if (document.blocks !== null && content !== null && blocks === null) {
        throw new RevisionConflict("Edit this page through its block editor.");
      }
      const previousBlocks = document.blocks ?? [];
      let resolvedContent = content;
      if (blocks !== null) {
        validateBlocks(blocks);
        if (document.blocks === null) {
          if (this.loadExtra(docId, "legacy_markdown") === null) {
            this.saveExtra(docId, "legacy_markdown", document.content);
          }
        }
        document.blocks = blocks;
        resolvedContent = blocksToMarkdown(blocks);
      }
      if (resolvedContent !== null) {
        document.content = resolvedContent;
        if (
          title === null &&
          (!document.title || document.title === "Untitled draft")
        ) {
          document.title = deriveTitle(
            resolvedContent,
            document.title || "Untitled draft"
          );
        }
      }
      if (title !== null) {
        document.title = (title as string).trim() || deriveTitle(document.content);
      }
      if ("parent_id" in metadata) {
        const parent = (metadata["parent_id"] as string | null) || null;
        let cursor: string | null = parent;
        const seen = new Set<string>([docId]);
        while (cursor) {
          if (seen.has(cursor)) {
            throw new Error("Pages cannot contain themselves");
          }
          seen.add(cursor);
          const ancestor = this.loadDocument(cursor);
          if (ancestor === null) {
            throw new Error("Parent page does not exist");
          }
          cursor = ancestor.parent_id;
        }
        document.parent_id = parent;
      }
      for (const key of ["icon", "cover", "pinned"] as const) {
        if (key in metadata) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (document as any)[key] = metadata[key];
        }
      }
      document.revision += 1;
      document.updated_at = Date.now() / 1000;
      this._write(document, source);
      if (blocks !== null) {
        // Python: from .proposals import refresh_review_anchors (lazy).
        const proposals = _loadProposals();
        const refresh =
          (proposals?.["refresh_review_anchors"] ??
            proposals?.["refreshReviewAnchors"]) as
            | ((
                storage: CoWriterStorage,
                docId: string,
                blocks: Dict[],
                previousBlocks: Dict[]
              ) => void)
            | undefined;
        if (refresh) {
          refresh(this, docId, blocks, previousBlocks);
        } else {
          console.warn(
            "documents/proposals is not available; review anchors not refreshed"
          );
        }
      }
      return document;
    });
  }

  deleteDocument(docId: string, cascade = false): boolean {
    return this.locked(() => {
      const document = this.loadDocument(docId);
      if (document === null) return false;
      const purge = (id: string) => {
        run("DELETE FROM documents WHERE id = ?", id);
        run("DELETE FROM doc_extras WHERE doc_id = ?", id);
        run("DELETE FROM doc_assets WHERE doc_id = ?", id);
        run("DELETE FROM document_versions WHERE doc_id = ?", id);
      };
      if (cascade) {
        // Delete the whole subtree: collect descendants first.
        const doomed = new Set<string>([docId]);
        const frontier = [docId];
        while (frontier.length) {
          const current = frontier.pop()!;
          for (const summary of this.listDocuments()) {
            if (summary.parent_id === current && !doomed.has(summary.id)) {
              doomed.add(summary.id);
              frontier.push(summary.id);
            }
          }
        }
        doomed.delete(docId);
        for (const childId of doomed) purge(childId);
      } else {
        // Preserve children by promoting them to the deleted page's parent.
        for (const summary of this.listDocuments()) {
          if (summary.parent_id === docId) {
            const child = this.loadDocument(summary.id);
            if (child === null) continue;
            child.parent_id = document.parent_id;
            child.revision += 1;
            this._write(child, "move");
          }
        }
      }
      purge(docId);
      return true;
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private _write(document: CoWriterDocument, source = "edit"): void {
    run(
      `INSERT INTO documents (id, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
      document.id,
      dumpDocument(document),
      document.created_at || 0,
      document.updated_at || 0
    );
    // A saved page always leaves a restorable trail.
    this._snapshot(document, source);
  }
}

const _storages = new Map<string, CoWriterStorage>();

export function getCoWriterStorage(): CoWriterStorage {
  const key = resolve(get_settings().data_dir);
  let store = _storages.get(key);
  if (store === undefined) {
    store = new CoWriterStorage();
    _storages.set(key, store);
  }
  return store;
}

// snake_case alias mirroring the Python name for callers that keep it.
export const get_co_writer_storage = getCoWriterStorage;

export {
  MAX_VERSIONS_PER_DOCUMENT,
  VERSION_COALESCE_SECONDS,
};
