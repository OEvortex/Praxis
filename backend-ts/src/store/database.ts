// the one SQLite database for Praxis.
//
// Everything persistent that is not an uploaded binary lives in
// `data/praxis.sqlite3` in WAL mode: sessions, settings, workspace state,
// notebook pages and their review queues, knowledge-base text, the calendar,
// cron jobs and the small agent state files (memory, learning, mastery,
// question bank).
//
// Only two things deliberately stay on disk:
//
// * the cache directories written by third-party libraries, and
// * user-selected workspace folders (they are content, not app state).
//
// Legacy JSON/SQLite stores are imported once on first open; see
// `migrateLegacy`.
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { Settings } from "../config.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ext_items (
    collection TEXT NOT NULL,
    item_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (collection, item_id)
);
CREATE INDEX IF NOT EXISTS idx_ext_collection ON ext_items(collection);

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

-- Notebook page snapshots. One row is a complete, restorable state of a page.
-- Rows are written on save (coalesced while the same kind of edit continues)
-- and pruned to a bounded number per page.
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

CREATE TABLE IF NOT EXISTS kb_meta (
    name TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS kb_docs (
    kb TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kb, name)
);

CREATE TABLE IF NOT EXISTS kb_chunks (
    kb TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    doc TEXT NOT NULL,
    text TEXT NOT NULL,
    tokens TEXT NOT NULL DEFAULT '[]',
    seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kb, chunk_id)
);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_kb ON kb_chunks(kb, seq);

CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO state VALUES (1, 0);

CREATE TABLE IF NOT EXISTS calendars (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    calendar_id TEXT NOT NULL REFERENCES calendars(id),
    series_id TEXT,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar_id);
CREATE INDEX IF NOT EXISTS events_series ON events(series_id);

CREATE TABLE IF NOT EXISTS undo (
    token TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    owner_key TEXT NOT NULL,
    next_run_at_ms INTEGER,
    payload TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_owner ON cron_jobs(owner_key);
`;

const _INIT_LOCK_KEY = "migration/schema-v1";
const _TABLES_READY = new Set<string>();
const _MIGRATED = new Set<string>();

export function database_path(settings: Settings): string {
  return settings.sessions_db;
}

/** Open the shared database with WAL and sane concurrency defaults. */
export function connect(settings: Settings): DatabaseSync {
  const path = database_path(settings);
  mkdirSync(dirname(path), { recursive: true });
  const connection = new DatabaseSync(path);
  try {
    connection.exec("PRAGMA journal_mode=WAL");
  } catch {
    // ignore — same as the OperationalError pass
  }
  connection.exec("PRAGMA busy_timeout=30000");
  connection.exec("PRAGMA synchronous=NORMAL");
  connection.exec("PRAGMA foreign_keys=ON");
  return connection;
}

export function ensure_tables(settings: Settings): void {
  // Create the schema if this process has not opened the database yet.
  const path = database_path(settings);
  if (_TABLES_READY.has(path) && existsSync(path)) return;
  // Node is single-threaded and every step here is synchronous, so the
  // A lock is unnecessary.
  if (_TABLES_READY.has(path) && existsSync(path)) return;
  const connection = connect(settings);
  try {
    connection.exec(SCHEMA);
  } finally {
    connection.close();
  }
  _TABLES_READY.add(path);
}

export function ensure_schema(settings: Settings): void {
  // Create tables and import any pre-SQLite stores once.
  ensure_tables(settings);
  const path = database_path(settings);
  if (_MIGRATED.has(path)) return;
  if (_MIGRATED.has(path)) return;
  const connection = connect(settings);
  let marker: unknown;
  try {
    marker = connection
      .prepare("SELECT 1 FROM kv WHERE key = ?")
      .get(_INIT_LOCK_KEY);
  } finally {
    connection.close();
  }
  if (marker === undefined) {
    migrate_legacy(settings);
    put_state(settings, _INIT_LOCK_KEY, { version: 1, at: Date.now() / 1000 });
  }
  _MIGRATED.add(path);
}

// ---------------------------------------------------------------------------
// Key/value state (settings, workspaces, small agent state files)
// ---------------------------------------------------------------------------

export function get_state<T = unknown>(
  settings: Settings,
  key: string,
  defaultValue: T | null = null,
): T | null {
  ensure_tables(settings);
  const connection = connect(settings);
  let row: { value: string } | undefined;
  try {
    row = connection
      .prepare("SELECT value FROM kv WHERE key = ?")
      .get(key) as { value: string } | undefined;
  } finally {
    connection.close();
  }
  if (row === undefined) return defaultValue;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return defaultValue;
  }
}

// Mirrors json.dumps(..., ensure_ascii=False, default=str) closely enough:
// BigInt becomes a string, everything else JSON.stringify handles natively.
function dumpJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}

export function put_state(settings: Settings, key: string, value: unknown): void {
  ensure_tables(settings);
  const connection = connect(settings);
  try {
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection
        .prepare(
          `
          INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
              value = excluded.value,
              updated_at = excluded.updated_at
          `,
        )
        .run(key, dumpJson(value), Date.now() / 1000);
      connection.exec("COMMIT");
    } catch (e) {
      connection.exec("ROLLBACK");
      throw e;
    }
  } finally {
    connection.close();
  }
}

export function delete_state(settings: Settings, key: string): void {
  ensure_tables(settings);
  const connection = connect(settings);
  try {
    connection.prepare("DELETE FROM kv WHERE key = ?").run(key);
  } finally {
    connection.close();
  }
}

// ---------------------------------------------------------------------------
// Generic extended-surface items (memory docs, notebooks, partners, ...)
// ---------------------------------------------------------------------------

export function list_items(
  settings: Settings,
  collection: string,
): Record<string, unknown>[] {
  ensure_tables(settings);
  const connection = connect(settings);
  let rows: { payload: string }[];
  try {
    rows = connection
      .prepare(
        "SELECT payload FROM ext_items WHERE collection = ? ORDER BY updated_at DESC",
      )
      .all(collection) as { payload: string }[];
  } finally {
    connection.close();
  }
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    let item: unknown;
    try {
      item = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      out.push(item as Record<string, unknown>);
    }
  }
  return out;
}

export function get_item(
  settings: Settings,
  collection: string,
  item_id: string,
): Record<string, unknown> | null {
  ensure_tables(settings);
  const connection = connect(settings);
  let row: { payload: string } | undefined;
  try {
    row = connection
      .prepare(
        "SELECT payload FROM ext_items WHERE collection = ? AND item_id = ?",
      )
      .get(collection, String(item_id)) as { payload: string } | undefined;
  } finally {
    connection.close();
  }
  if (row === undefined) return null;
  try {
    const item: unknown = JSON.parse(row.payload);
    return item !== null && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function put_item(
  settings: Settings,
  collection: string,
  item: Record<string, unknown>,
): void {
  const itemId = String(item["id"] ?? "");
  if (!itemId) {
    throw new Error("An extended-surface item needs an id");
  }
  const now = Date.now() / 1000;
  const created = Number(item["created_at"] ?? now) || now;
  ensure_tables(settings);
  const connection = connect(settings);
  try {
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection
        .prepare(
          `
          INSERT INTO ext_items (collection, item_id, payload, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(collection, item_id) DO UPDATE SET
              payload = excluded.payload,
              updated_at = excluded.updated_at
          `,
        )
        .run(collection, itemId, dumpJson(item), created, now);
      connection.exec("COMMIT");
    } catch (e) {
      connection.exec("ROLLBACK");
      throw e;
    }
  } finally {
    connection.close();
  }
}

export function delete_item(
  settings: Settings,
  collection: string,
  item_id: string,
): boolean {
  ensure_tables(settings);
  const connection = connect(settings);
  try {
    const result = connection
      .prepare(
        "DELETE FROM ext_items WHERE collection = ? AND item_id = ?",
      )
      .run(collection, String(item_id));
    return Number(result.changes) > 0;
  } finally {
    connection.close();
  }
}

// ---------------------------------------------------------------------------
// One-shot import of the old JSON stores
// ---------------------------------------------------------------------------

function _read_json<T = unknown>(path: string, defaultValue: T | null = null): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return defaultValue;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _import_kv(settings: Settings, key: string, path: string): void {
  if (get_state(settings, key) !== null) return;
  if (existsSync(path)) {
    const data = _read_json(path);
    if (data !== null) {
      put_state(settings, key, data);
    }
  }
}

function _import_documents(settings: Settings, root: string): void {
  if (!isDir(root)) return;
  const connection = connect(settings);
  try {
    const children = readdirSync(root)
      .filter((name) => name.startsWith("doc_"))
      .sort()
      .map((name) => join(root, name))
      .filter((p) => isDir(p));
    for (const child of children) {
      const manifest = join(child, "manifest.json");
      const payload = _read_json<Record<string, unknown>>(manifest);
      if (!isRecord(payload) || !payload["id"]) continue;
      const docId = String(payload["id"]);
      const exists = connection
        .prepare("SELECT 1 FROM documents WHERE id = ?")
        .get(docId);
      if (exists) continue;
      connection
        .prepare(
          "INSERT INTO documents (id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          docId,
          dumpJson(payload),
          Number(payload["created_at"] ?? 0) || 0,
          Number(payload["updated_at"] ?? 0) || 0,
        );
      for (const [name, kind] of [
        ["suggestions.json", "suggestions"],
        ["threads.json", "threads"],
        ["review.json", "review"],
      ] as const) {
        const extra = _read_json(join(child, name));
        if (extra !== null) {
          connection
            .prepare(
              `
              INSERT OR REPLACE INTO doc_extras (doc_id, kind, payload, updated_at)
              VALUES (?, ?, ?, ?)
              `,
            )
            .run(docId, kind, JSON.stringify(extra), Date.now() / 1000);
        }
      }
    }
  } finally {
    connection.close();
  }
}

function* walkJsonFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonFiles(p);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      yield p;
    }
  }
}

function _import_ext(settings: Settings, root: string): void {
  if (!isDir(root)) return;
  for (const path of walkJsonFiles(root)) {
    const data = _read_json<Record<string, unknown>>(path);
    if (!isRecord(data)) continue;
    const rel = relative(root, path);
    const parts = rel.split(sep);
    const collection = parts.slice(0, -1).join("/") || "misc";
    const stem = parts[parts.length - 1].replace(/\.json$/, "");
    const itemId = String(data["id"] ?? stem);
    if (!("id" in data)) data["id"] = itemId;
    if (get_item(settings, collection, itemId) === null) {
      put_item(settings, collection, data);
    }
  }
}

function _import_calendar(settings: Settings, path: string): void {
  if (!existsSync(path)) return;
  let source: DatabaseSync | null = null;
  let calendars: Record<string, unknown>[] = [];
  let events: Record<string, unknown>[] = [];
  let revision: { revision: number } | undefined;
  let undo: Record<string, unknown>[] = [];
  try {
    source = new DatabaseSync(path);
    calendars = source
      .prepare("SELECT id, payload FROM calendars")
      .all() as Record<string, unknown>[];
    events = source
      .prepare("SELECT id, calendar_id, series_id, payload FROM events")
      .all() as Record<string, unknown>[];
    revision = source
      .prepare("SELECT revision FROM state WHERE id = 1")
      .get() as { revision: number } | undefined;
    undo = source
      .prepare("SELECT token, created_at, before_json, after_json FROM undo")
      .all() as Record<string, unknown>[];
  } catch {
    return;
  } finally {
    source?.close();
  }
  const connection = connect(settings);
  try {
    if (
      connection.prepare("SELECT 1 FROM calendars LIMIT 1").get() !== undefined
    ) {
      return;
    }
    connection.exec("BEGIN IMMEDIATE");
    try {
      for (const row of calendars) {
        connection
          .prepare(
            "INSERT OR REPLACE INTO calendars (id, payload) VALUES (?, ?)",
          )
          .run(row["id"] as never, row["payload"] as never);
      }
      for (const row of events) {
        connection
          .prepare(
            `
            INSERT OR REPLACE INTO events
                (id, calendar_id, series_id, payload)
            VALUES (?, ?, ?, ?)
            `,
          )
          .run(row["id"] as never, row["calendar_id"] as never, row["series_id"] as never, row["payload"] as never);
      }
      for (const row of undo) {
        connection
          .prepare(
            `
            INSERT OR REPLACE INTO undo
                (token, created_at, before_json, after_json)
            VALUES (?, ?, ?, ?)
            `,
          )
          .run(
            row["token"] as never,
            row["created_at"] as never,
            row["before_json"] as never,
            row["after_json"] as never,
          );
      }
      if (revision !== undefined) {
        connection
          .prepare("UPDATE state SET revision = ? WHERE id = 1")
          .run(Math.trunc(Number(revision["revision"])));
      }
      connection.exec("COMMIT");
    } catch (e) {
      connection.exec("ROLLBACK");
      throw e;
    }
  } finally {
    connection.close();
  }
}

function _import_cron(
  settings: Settings,
  path: string,
  legacyJson: string,
): void {
  const connection = connect(settings);
  try {
    if (
      connection.prepare("SELECT 1 FROM cron_jobs LIMIT 1").get() !== undefined
    ) {
      return;
    }
  } finally {
    connection.close();
  }
  const rows: unknown[][] = [];
  let revision = 0;
  if (existsSync(path)) {
    let source: DatabaseSync | null = null;
    try {
      source = new DatabaseSync(path);
      const jobRows = source
        .prepare(
          "SELECT id, owner_key, next_run_at_ms, payload, updated_at_ms FROM cron_jobs",
        )
        .all() as Record<string, unknown>[];
      for (const row of jobRows) {
        rows.push([
          row["id"],
          row["owner_key"],
          row["next_run_at_ms"],
          row["payload"],
          row["updated_at_ms"],
        ]);
      }
      const meta = source
        .prepare("SELECT revision FROM cron_meta WHERE singleton = 1")
        .get() as { revision: number } | undefined;
      revision = meta ? Math.trunc(Number(meta["revision"])) : 0;
    } catch {
      rows.length = 0;
    } finally {
      source?.close();
    }
  } else if (existsSync(legacyJson)) {
    const raw = _read_json<Record<string, unknown>>(legacyJson, {});
    const jobs = isRecord(raw) ? raw["jobs"] : undefined;
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (!isRecord(job) || !job["id"]) continue;
      const owner = isRecord(job["owner"]) ? job["owner"] : {};
      const ownerKey =
        owner["kind"] === "partner"
          ? `partner:${owner["partner_id"] ?? ""}`
          : "chat:local-admin";
      const state = isRecord(job["state"]) ? job["state"] : {};
      rows.push([
        String(job["id"]),
        ownerKey,
        state["next_run_at_ms"] ?? null,
        JSON.stringify(job),
        Math.trunc(Date.now()),
      ]);
    }
  }
  if (rows.length === 0) return;
  const conn2 = connect(settings);
  try {
    conn2.exec("BEGIN IMMEDIATE");
    try {
      const insert = conn2.prepare(
        `
        INSERT OR REPLACE INTO cron_jobs
            (id, owner_key, next_run_at_ms, payload, updated_at_ms)
        VALUES (?, ?, ?, ?, ?)
        `,
      );
      for (const row of rows) insert.run(...(row as never[]));
      conn2.exec(
        `
        CREATE TABLE IF NOT EXISTS cron_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            revision INTEGER NOT NULL
        )
        `,
      );
      conn2
        .prepare(
          `
          INSERT INTO cron_meta (singleton, revision) VALUES (1, ?)
          ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision
          `,
        )
        .run(Math.max(revision, 1));
      conn2.exec("COMMIT");
    } catch (e) {
      conn2.exec("ROLLBACK");
      throw e;
    }
  } finally {
    conn2.close();
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function _import_kbs(settings: Settings, root: string): void {
  if (!isDir(root)) return;
  const connection = connect(settings);
  try {
    if (
      connection.prepare("SELECT 1 FROM kb_meta LIMIT 1").get() !== undefined
    ) {
      return;
    }
  } finally {
    connection.close();
  }
  const kbDirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
    .sort();
  for (const kbDir of kbDirs) {
    const name = kbDir.split(sep).pop() ?? "";
    const meta =
      _read_json<Record<string, unknown>>(join(kbDir, "meta.json"), {}) ?? {};
    const index =
      _read_json<Record<string, unknown>>(join(kbDir, "index.json"), {}) ?? {};
    const conn = connect(settings);
    try {
      conn.exec("BEGIN IMMEDIATE");
      try {
        conn
          .prepare(
            "INSERT OR REPLACE INTO kb_meta (name, payload, updated_at) VALUES (?, ?, ?)",
          )
          .run(name, JSON.stringify(meta), Date.now() / 1000);
        const docsDir = join(kbDir, "docs");
        if (isDir(docsDir)) {
          const docs = readdirSync(docsDir, { withFileTypes: true })
            .filter((e) => e.isFile() && !e.name.startsWith("."))
            .map((e) => join(docsDir, e.name))
            .sort();
          for (const doc of docs) {
            const data = readFileSync(doc);
            conn
              .prepare(
                `
                INSERT OR REPLACE INTO kb_docs (kb, name, data, size)
                VALUES (?, ?, ?, ?)
                `,
              )
              .run(name, doc.split(sep).pop() ?? doc, data, data.length);
          }
        }
        const chunks = Array.isArray(index["chunks"]) ? index["chunks"] : [];
        chunks.forEach((chunk, position) => {
          if (!isRecord(chunk)) return;
          conn
            .prepare(
              `
              INSERT OR REPLACE INTO kb_chunks
                  (kb, chunk_id, doc, text, tokens, seq)
              VALUES (?, ?, ?, ?, ?, ?)
              `,
            )
            .run(
              name,
              String(chunk["id"] ?? `chunk-${position}`),
              String(chunk["doc"] ?? ""),
              String(chunk["text"] ?? ""),
              JSON.stringify(chunk["tokens"] ?? []),
              position,
            );
        });
        conn.exec("COMMIT");
      } catch (e) {
        conn.exec("ROLLBACK");
        throw e;
      }
    } finally {
      conn.close();
    }
  }
}

export function migrate_legacy(settings: Settings): void {
  // Import every pre-SQLite store once, then leave the old files untouched.
  const data = settings.data_dir;
  const kvImports: [string, string][] = [
    ["settings/catalog", join(data, "settings-catalog.json")],
    ["settings/selection", join(data, "settings.json")],
    ["settings/draft", join(data, "settings-draft.json")],
    ["workspaces", join(data, "workspaces.json")],
    ["memory", join(data, "memory.json")],
    ["learning", join(data, "learning.json")],
    ["mastery", join(data, "mastery.json")],
    ["question_bank", join(data, "question_bank.json")],
    ["reviews", join(data, "reviews.json")],
    ["cron/reports", join(data, "cron", "reports.json")],
    ["notes/index", join(data, "notes", ".notebook-index.json")],
    ["documents/history", join(data, "documents", "history.json")],
  ];
  for (const [key, path] of kvImports) {
    _import_kv(settings, key, path);
  }
  _import_documents(settings, join(data, "documents"));
  _import_ext(settings, join(data, "ext"));
  const calendarDb = join(data, "calendar", "calendar.sqlite");
  if (existsSync(calendarDb)) {
    _import_calendar(settings, calendarDb);
  }
  _import_cron(
    settings,
    join(data, "cron", "jobs.sqlite3"),
    join(data, "cron", "jobs.json"),
  );
  _import_kbs(settings, join(data, "kbs"));
}

export const ensureTables = ensure_tables;
export const ensureSchema = ensure_schema;
export const databasePath = database_path;
export const getState = get_state;
export const putState = put_state;
export const deleteState = delete_state;
export const listItems = list_items;
export const getItem = get_item;
export const putItem = put_item;
export const deleteItem = delete_item;
export const migrateLegacy = migrate_legacy;
