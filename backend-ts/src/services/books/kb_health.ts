// Port of deeptutor/book/kb_health.py — KB drift detection & log.md health.
//
// KB fingerprints are derived from the per-document content hashes of each
// knowledge base's raw documents. In this deployment the KB store is
// KnowledgeBaseStore (kb_docs blobs); we fingerprint name → sha256(content).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { get_settings } from "../../config.js";
import { KnowledgeBaseStore } from "../../store/kb_store.js";
import { get_book_storage, safe_book_id, type BookStorage } from "./storage.js";
import type { Book, Page } from "./models.js";

const FINGERPRINT_SCHEME = "sha256-paths-v1";

function _hash_bytes(data: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function scheme_changed(stored: Record<string, string>): boolean {
  return Object.values(stored).some((v) => v && !v.startsWith(`${FINGERPRINT_SCHEME}:`));
}

export function digest_documents(documents: Record<string, string>): string {
  const entries = Object.entries(documents).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return "";
  const payload = entries.map(([p, v]) => `${p}:${v}`).join("|");
  return `${FINGERPRINT_SCHEME}:${createHash("sha256").update(payload, "utf-8").digest("hex")}`;
}

/** Per-document hashes keyed by stable paths under a KB. */
export function fingerprint_kb_documents(kb_name: string): Record<string, string> {
  try {
    const store = new KnowledgeBaseStore(get_settings());
    if (!store.exists(kb_name)) return {};
    const result: Record<string, string> = {};
    for (const doc of store.list_documents(kb_name) as Array<Record<string, unknown>>) {
      const name = String(doc["name"] ?? doc["filename"] ?? "");
      if (!name) continue;
      try {
        const data = store.read_source(kb_name, name);
        result[name] = _hash_bytes(typeof data === "string" ? data : String(data));
      } catch {
        // skip unreadable docs, same spirit as upstream's OSError → ""
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function fingerprint_kb(kb_name: string): string {
  return digest_documents(fingerprint_kb_documents(kb_name));
}

export function fingerprint_kbs(kb_names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of kb_names) out[name] = fingerprint_kb(name);
  return out;
}

export function fingerprint_kb_documents_batch(kb_names: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const name of kb_names) out[name] = fingerprint_kb_documents(name);
  return out;
}

// ── drift report ───────────────────────────────────────────────────────────

export interface KBDriftReport {
  book_id: string;
  has_drift: boolean;
  new_kbs: string[];
  removed_kbs: string[];
  changed_kbs: string[];
  changed_documents: Record<string, string[]>;
  current_fingerprints: Record<string, string>;
  stale_page_ids: string[];
  fallback_stale_pages: boolean;
}

function anchor_matches(anchor_ref: string, document_ref: string): boolean {
  const anchor = anchor_ref.trim().replace(/\/+$/, "");
  const document = document_ref.trim().replace(/\/+$/, "");
  if (!anchor || !document) return false;
  return anchor === document || anchor.endsWith(`/${document}`) || document.endsWith(`/${anchor}`);
}

function anchor_kb_names_exist(anchors: Array<Record<string, unknown>>): boolean {
  return anchors.some((a) => String(a["kb_name"] ?? ""));
}

export function detect_kb_drift(
  book: Book,
  storage: BookStorage = get_book_storage(),
): KBDriftReport {
  const current_documents = fingerprint_kb_documents_batch(book.knowledge_bases ?? []);
  const current: Record<string, string> = {};
  for (const [name, docs] of Object.entries(current_documents)) {
    current[name] = digest_documents(docs);
  }
  const stored: Record<string, string> = { ...(book.kb_fingerprints ?? {}) };
  const stored_documents: Record<string, Record<string, string>> = {
    ...(book.kb_document_fingerprints ?? {}),
  };

  const empty: KBDriftReport = {
    book_id: book.id,
    has_drift: false,
    new_kbs: [],
    removed_kbs: [],
    changed_kbs: [],
    changed_documents: {},
    current_fingerprints: current,
    stale_page_ids: [],
    fallback_stale_pages: false,
  };
  if (!Object.keys(stored).length || scheme_changed(stored)) {
    return empty;
  }

  const kbs = new Set(book.knowledge_bases ?? []);
  const new_kbs = Object.keys(current).filter((k) => !(k in stored) && kbs.has(k));
  const removed_kbs = Object.keys(stored).filter((k) => !(k in current) && kbs.has(k));
  const changed_kbs = Object.keys(current).filter(
    (k) => k in stored && stored[k] && stored[k] !== current[k],
  );
  const has_drift = new_kbs.length > 0 || removed_kbs.length > 0 || changed_kbs.length > 0;

  const changed_documents: Record<string, string[]> = {};
  for (const kb_name of changed_kbs) {
    const before = stored_documents[kb_name] ?? {};
    const after = current_documents[kb_name] ?? {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    changed_documents[kb_name] = [...keys]
      .filter((key) => before[key] !== after[key])
      .sort();
  }
  for (const kb_name of new_kbs) {
    changed_documents[kb_name] = Object.keys(current_documents[kb_name] ?? {}).sort();
  }

  const stale_pages: string[] = [];
  let fallback = false;
  const spine = storage.load_spine(book.id);
  const chapter_anchors = new Map<string, Array<Record<string, unknown>>>(
    (spine?.chapters ?? []).map((c) => [c.id, (c.source_anchors ?? []) as Array<Record<string, unknown>>]),
  );

  if (has_drift) {
    for (const page of storage.list_pages(book.id)) {
      if (page.status !== "ready") continue;
      const anchors: Array<Record<string, unknown>> = [
        ...(chapter_anchors.get(page.chapter_id) ?? []),
      ];
      for (const block of page.blocks ?? []) {
        anchors.push(...((block.source_anchors ?? []) as Array<Record<string, unknown>>));
      }
      let page_impacted = false;
      for (const [kb_name, refs] of Object.entries(changed_documents)) {
        const scoped = anchors.filter(
          (a) =>
            a["kind"] === "kb" &&
            (String(a["kb_name"] ?? "") === kb_name ||
              (!a["kb_name"] && (book.knowledge_bases ?? []).length === 1)),
        );
        if (!refs.length || !scoped.length) {
          page_impacted = true;
          fallback = !refs.length || !scoped.length;
          continue;
        }
        const known_refs = new Set([
          ...Object.keys(stored_documents[kb_name] ?? {}),
          ...Object.keys(current_documents[kb_name] ?? {}),
        ]);
        const known_anchors = scoped.filter((a) =>
          [...known_refs].some((ref) => anchor_matches(String(a["ref"] ?? ""), ref)),
        );
        const changed_anchors = scoped.filter((a) =>
          refs.some((ref) => anchor_matches(String(a["ref"] ?? ""), ref)),
        );
        if (changed_anchors.length) page_impacted = true;
        else if (known_anchors.length !== scoped.length) {
          page_impacted = true;
          fallback = true;
        }
      }
      for (const kb_name of removed_kbs) {
        const scoped = anchors.filter(
          (a) => a["kind"] === "kb" && String(a["kb_name"] ?? "") === kb_name,
        );
        if (scoped.length || anchor_kb_names_exist(anchors)) {
          page_impacted = page_impacted || scoped.length > 0;
        } else {
          page_impacted = true;
          fallback = true;
        }
      }
      if (page_impacted) stale_pages.push(page.id);
    }
  }

  const stale_page_ids = [...new Set([...(book.stale_page_ids ?? []), ...stale_pages])];
  return {
    book_id: book.id,
    has_drift,
    new_kbs,
    removed_kbs,
    changed_kbs,
    changed_documents,
    current_fingerprints: current,
    stale_page_ids,
    fallback_stale_pages: fallback,
  };
}

function _refuse_stale_dismissal(store: BookStorage, book: Book, force: boolean): void {
  if (!book.stale_page_ids?.length || force) return;
  if (!book.stale_detected_at) {
    throw new ValueError(
      "Cannot mark KB drift as seen before all stale pages have been recompiled.",
    );
  }
  const not_recompiled = book.stale_page_ids.filter((page_id) => {
    const page = store.load_page(book.id, page_id);
    return page === null || page.status !== "ready" || (page.updated_at ?? 0) < book.stale_detected_at;
  });
  if (not_recompiled.length) {
    throw new ValueError(
      "Cannot mark KB drift as seen before these pages are recompiled: " +
        not_recompiled.join(", "),
    );
  }
}

export function ensure_can_refresh_fingerprints(
  book_id: string,
  storage: BookStorage = get_book_storage(),
  force = false,
): Book | null {
  const book = storage.load_book(book_id);
  if (book === null) return null;
  _refuse_stale_dismissal(storage, book, force);
  return book;
}

export function refresh_book_fingerprints(
  book_id: string,
  storage: BookStorage = get_book_storage(),
  force = false,
): Book | null {
  const book = storage.load_book(book_id);
  if (book === null) return null;
  _refuse_stale_dismissal(storage, book, force);
  const documents = fingerprint_kb_documents_batch(book.knowledge_bases ?? []);
  book.kb_document_fingerprints = documents;
  book.kb_fingerprints = {};
  for (const [name, docs] of Object.entries(documents)) {
    book.kb_fingerprints[name] = digest_documents(docs);
  }
  book.stale_page_ids = [];
  book.stale_detected_at = 0;
  storage.save_book(book);
  storage.append_log(book_id, `refreshed kb fingerprints (${Object.keys(book.kb_fingerprints).length} kbs)`, "kb_health");
  return book;
}

export function mark_drift_on_book(
  book_id: string,
  storage: BookStorage = get_book_storage(),
): KBDriftReport | null {
  const book = storage.load_book(book_id);
  if (book === null) return null;
  const report = detect_kb_drift(book, storage);
  let dirty = false;

  if (
    !report.has_drift &&
    (book.knowledge_bases ?? []).length &&
    (!Object.keys(book.kb_fingerprints ?? {}).length || scheme_changed(book.kb_fingerprints ?? {}))
  ) {
    const documents = fingerprint_kb_documents_batch(book.knowledge_bases ?? []);
    book.kb_document_fingerprints = documents;
    book.kb_fingerprints = report.current_fingerprints;
    for (const [name, docs] of Object.entries(documents)) {
      book.kb_fingerprints[name] = digest_documents(docs);
    }
    dirty = true;
  }

  if (report.has_drift) {
    book.stale_page_ids = report.stale_page_ids;
    book.stale_detected_at = Date.now() / 1000;
    dirty = true;
    storage.append_log(
      book_id,
      `detected kb drift: changed=${report.changed_kbs} new=${report.new_kbs} removed=${report.removed_kbs} → ${report.stale_page_ids.length} stale pages`,
      "kb_health",
    );
  }

  if (dirty) storage.save_book(book);
  return report;
}

// ── log.md health check ────────────────────────────────────────────────────

const LOG_LINE = /^- `([^`]+)` \*\*([^*]+)\*\* — (.+)$/;

export interface LogHealthReport {
  book_id: string;
  total_entries: number;
  error_entries: number;
  block_failures: number;
  last_compile_at: string;
  last_error_at: string;
  repeated_failures: Array<{ signature: string; count: number }>;
}

export function scan_log_health(book_id: string, storage: BookStorage = get_book_storage()): LogHealthReport {
  const report: LogHealthReport = {
    book_id,
    total_entries: 0,
    error_entries: 0,
    block_failures: 0,
    last_compile_at: "",
    last_error_at: "",
    repeated_failures: [],
  };
  let log_path: string;
  try {
    safe_book_id(book_id);
    log_path = join(storage.book_root(book_id), "log.md");
  } catch {
    return report;
  }
  if (!existsSync(log_path)) return report;

  const counter = new Map<string, { op: string; msg: string; count: number }>();
  let text = "";
  try {
    text = readFileSync(log_path, "utf-8");
  } catch {
    return report;
  }
  for (const line of text.split("\n")) {
    const m = LOG_LINE.exec(line.trim());
    if (!m) continue;
    const [, ts, opRaw, msgRaw] = m;
    const op = opRaw.trim();
    const msg = msgRaw.trim();
    report.total_entries += 1;
    if (["compile_page", "page_compiled", "page_planned"].includes(op)) {
      report.last_compile_at = ts;
    }
    if (op.toLowerCase().includes("error") || op.toLowerCase().includes("fail")) {
      report.error_entries += 1;
      report.last_error_at = ts;
    }
    if (op === "block_error") report.block_failures += 1;
    const key = `${op}${msg.slice(0, 80)}`;
    const entry = counter.get(key) ?? { op, msg: msg.slice(0, 80), count: 0 };
    entry.count += 1;
    counter.set(key, entry);
  }

  const repeated = [...counter.values()]
    .filter(
      (e) =>
        e.count >= 3 &&
        (e.op.toLowerCase().includes("error") || e.op.toLowerCase().includes("fail")),
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((e) => ({ signature: `${e.op}:${e.msg}`, count: e.count }));
  report.repeated_failures = repeated;
  return report;
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
