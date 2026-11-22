// Port of deeptutor/services/storage/file_library.py — persistent file
// library (issue #1437). SQLite metadata + files on disk, SHA-256 dedup,
// soft delete/restore. Backed by its own database file under the data dir.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { get_settings } from "../../config.js";

export class FileLibraryContentConflict extends Error {}

interface LibraryEntry {
  id: string;
  sha256: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  library_path: string;
  created_at: number;
  updated_at: number;
  is_deleted: boolean;
  deleted_at: number | null;
}

let _db: DatabaseSync | null = null;
let _root: string | null = null;

function paths() {
  const settings = get_settings();
  const base = join(settings.data_dir, "library");
  return {
    dbPath: join(base, "library.db"),
    root: resolve(join(base, "files")),
  };
}

function db(): DatabaseSync {
  if (_db) return _db;
  const { dbPath } = paths();
  mkdirSync(dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _db.exec(`PRAGMA journal_mode=WAL`);
  _db.exec(`PRAGMA busy_timeout=30000`);
  _db.exec(`PRAGMA foreign_keys=ON`);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS library_files (
      id TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      library_path TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at REAL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_library_sha256_active
      ON library_files(sha256) WHERE is_deleted = 0;
    CREATE INDEX IF NOT EXISTS idx_library_is_deleted ON library_files(is_deleted);
  `);
  return _db;
}

function rootDir(): string {
  if (!_root) {
    _root = paths().root;
    mkdirSync(_root, { recursive: true });
  }
  return _root;
}

function filePath(libraryPath: string): string {
  const target = resolve(rootDir(), libraryPath);
  const root = rootDir();
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error("library path escapes root");
  }
  return target;
}

function rowToEntry(row: Record<string, unknown>): LibraryEntry {
  return {
    id: String(row.id),
    sha256: String(row.sha256),
    filename: String(row.filename),
    mime_type: String(row.mime_type ?? ""),
    size_bytes: Number(row.size_bytes ?? 0),
    library_path: String(row.library_path),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    is_deleted: !!Number(row.is_deleted),
    deleted_at: row.deleted_at == null ? null : Number(row.deleted_at),
  };
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function addFile(opts: { data: Buffer; filename: string; mime_type?: string }): LibraryEntry {
  const sha = sha256(opts.data);
  const now = Date.now() / 1000;
  const conn = db();
  const existing = conn
    .prepare("SELECT * FROM library_files WHERE sha256 = ? AND is_deleted = 0")
    .get(sha) as Record<string, unknown> | undefined;
  if (existing) return rowToEntry(existing);

  const fileId = randomUUID();
  const ext = (opts.filename.match(/\.[A-Za-z0-9]{1,10}$/) ?? [""])[0];
  const libraryPath = `${fileId}${ext}`;
  const target = filePath(libraryPath);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, opts.data);
  renameSync(tmp, target);

  try {
    conn
      .prepare(
        `INSERT INTO library_files (id, sha256, filename, mime_type, size_bytes, library_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fileId, sha, opts.filename, opts.mime_type ?? "", opts.data.length, libraryPath, now, now);
  } catch (exc) {
    // Unique-index race (multi-process): discard file, return winner.
    try { rmSync(target, { force: true }); } catch { /* ignore */ }
    const winner = conn
      .prepare("SELECT * FROM library_files WHERE sha256 = ? AND is_deleted = 0")
      .get(sha) as Record<string, unknown> | undefined;
    if (winner) return rowToEntry(winner);
    throw exc;
  }
  return {
    id: fileId, sha256: sha, filename: opts.filename,
    mime_type: opts.mime_type ?? "", size_bytes: opts.data.length,
    library_path: libraryPath, created_at: now, updated_at: now,
    is_deleted: false, deleted_at: null,
  };
}

export function getFile(fileId: string): LibraryEntry | null {
  const row = db().prepare("SELECT * FROM library_files WHERE id = ?").get(fileId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToEntry(row) : null;
}

export function deleteFile(fileId: string): boolean {
  const now = Date.now() / 1000;
  const exists = db().prepare("SELECT 1 FROM library_files WHERE id = ?").get(fileId);
  if (!exists) return false;
  db()
    .prepare("UPDATE library_files SET is_deleted = 1, deleted_at = ?, updated_at = ? WHERE id = ? AND is_deleted = 0")
    .run(now, now, fileId);
  return true;
}

export function restoreFile(fileId: string): boolean {
  const now = Date.now() / 1000;
  const exists = db().prepare("SELECT 1 FROM library_files WHERE id = ?").get(fileId);
  if (!exists) return false;
  try {
    db()
      .prepare("UPDATE library_files SET is_deleted = 0, deleted_at = NULL, updated_at = ? WHERE id = ? AND is_deleted = 1")
      .run(now, fileId);
  } catch (exc) {
    const msg = String(exc);
    if (/UNIQUE/i.test(msg)) {
      throw new FileLibraryContentConflict(
        "A file with the same content is already active in your library.",
      );
    }
    throw exc;
  }
  return true;
}

export function listFiles(limit = 50, offset = 0): LibraryEntry[] {
  const rows = db()
    .prepare(
      "SELECT * FROM library_files WHERE is_deleted = 0 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .all(Math.trunc(limit), Math.trunc(offset)) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function searchFiles(query: string): LibraryEntry[] {
  const q = String(query ?? "").trim();
  if (!q) return [];
  const pattern = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const rows = db()
    .prepare(
      `SELECT * FROM library_files
       WHERE is_deleted = 0 AND LOWER(filename) LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC, id DESC`,
    )
    .all(pattern) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

export function resolvePath(fileId: string): string | null {
  const row = db()
    .prepare("SELECT library_path FROM library_files WHERE id = ? AND is_deleted = 0")
    .get(fileId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const p = filePath(String(row.library_path));
  return existsSync(p) && statSync(p).isFile() ? p : null;
}
