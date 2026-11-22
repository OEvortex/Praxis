// SQLite-backed
// storage for MarginNote 4 objects synced by the MN4 Add-on.
//
// Schema mirrors upstream: mn4_objects / mn4_devices / mn4_cursors /
// mn4_tombstones. One database file per connected library under
// <data_dir>/marginnote4/<kb_name>.db (a KB entry may pin `db_path`).
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Settings } from "../../config.js";
import { get_settings } from "../../config.js";
import { KnowledgeBaseStore } from "../../store/kb_store.js";

export const NOTE = "note";
export const EXCERPT = "excerpt";
export const CARD = "card";
export const MINDMAP_NODE = "mindmap_node";
export const DOCUMENT = "document";
export const COMMENT = "comment";
export const ALL_TYPES: ReadonlySet<string> = new Set([
  NOTE, EXCERPT, CARD, MINDMAP_NODE, DOCUMENT, COMMENT,
]);

export interface MarginNoteObject {
  object_id: string;
  object_type: string;
  title?: string;
  content?: string;
  excerpt?: string | null;
  document_id?: string | null;
  document_title?: string | null;
  page?: number | null;
  tags?: string[];
  links?: string[];
  color?: string | null;
  created_at?: string;
  updated_at?: string;
  synced_at?: string;
  device_id?: string;
  raw?: Record<string, unknown>;
}

export interface SyncBatch {
  device_id: string;
  cursor?: string;
  objects?: MarginNoteObject[];
  deleted_ids?: string[];
}

export interface SyncResult {
  stored: number;
  updated: number;
  deleted: number;
  new_cursor: string;
}

export interface PairedDevice {
  device_id: string;
  device_name: string;
  device_kind: string;
  paired_at: string;
  last_seen: string;
  active: boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mn4_objects (
    object_id     TEXT NOT NULL,
    device_id     TEXT NOT NULL,
    object_type   TEXT NOT NULL,
    title         TEXT NOT NULL DEFAULT '',
    content       TEXT NOT NULL DEFAULT '',
    excerpt       TEXT,
    document_id   TEXT,
    document_title TEXT,
    page          INTEGER,
    tags          TEXT NOT NULL DEFAULT '[]',
    links         TEXT NOT NULL DEFAULT '[]',
    color         TEXT,
    created_at    TEXT NOT NULL DEFAULT '',
    updated_at    TEXT NOT NULL DEFAULT '',
    synced_at     TEXT NOT NULL DEFAULT '',
    raw           TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (object_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_mn4_type   ON mn4_objects (object_type);
CREATE INDEX IF NOT EXISTS idx_mn4_doc    ON mn4_objects (document_id);
CREATE INDEX IF NOT EXISTS idx_mn4_search ON mn4_objects (title);
CREATE TABLE IF NOT EXISTS mn4_devices (
    device_id    TEXT PRIMARY KEY,
    device_name  TEXT NOT NULL DEFAULT '',
    device_kind  TEXT NOT NULL DEFAULT 'macos',
    token_hash   TEXT NOT NULL,
    paired_at    TEXT NOT NULL DEFAULT '',
    last_seen    TEXT NOT NULL DEFAULT '',
    active       INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS mn4_cursors (
    device_id  TEXT PRIMARY KEY,
    cursor     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS mn4_tombstones (
    object_id  TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    deleted_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (object_id, device_id)
);
`;

function nowIso(): string {
  return new Date().toISOString();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeKbName(kbName: string): string {
  return [...kbName].map((ch) => /[A-Za-z0-9_-]/.test(ch) ? ch : "_").join("");
}

function defaultDbPath(kbName: string, settings: Settings): string {
  return join(settings.data_dir, "marginnote4", `${safeKbName(kbName)}.db`);
}

function kbMetadata(kbName: string, settings: Settings): Record<string, unknown> | null {
  try {
    const kb = new KnowledgeBaseStore(settings);
    const rows = kb.list() as Array<Record<string, unknown>>;
    const row = rows.find(
      (r) => String(r["id"] ?? r["name"] ?? "") === kbName || String(r["name"] ?? "") === kbName,
    );
    return row ?? null;
  } catch {
    return null;
  }
}

/** Resolve the store a connected MN4 library actually uses (upstream resolve_db_path). */
export function resolveDbPath(kbName: string, settings?: Settings): string {
  const s = settings ?? get_settings();
  const metadata = kbMetadata(kbName, s);
  const pinned = String(metadata?.["db_path"] ?? "").trim();
  if (pinned) return pinned;
  return defaultDbPath(kbName, s);
}

type Row = Record<string, unknown>;

function rowToObject(row: Row): MarginNoteObject {
  const parseJson = (v: unknown, fallback: unknown): unknown => {
    try {
      return JSON.parse(String(v ?? ""));
    } catch {
      return fallback;
    }
  };
  return {
    object_id: String(row.object_id ?? ""),
    object_type: String(row.object_type ?? ""),
    title: String(row.title ?? ""),
    content: String(row.content ?? ""),
    excerpt: (row.excerpt as string | null) ?? null,
    document_id: (row.document_id as string | null) ?? null,
    document_title: (row.document_title as string | null) ?? null,
    page: (row.page as number | null) ?? null,
    tags: parseJson(row.tags, []) as string[],
    links: parseJson(row.links, []) as string[],
    color: (row.color as string | null) ?? null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    synced_at: String(row.synced_at ?? ""),
    device_id: String(row.device_id ?? ""),
    raw: parseJson(row.raw, {}) as Record<string, unknown>,
  };
}

function rowToDevice(row: Row): PairedDevice {
  return {
    device_id: String(row.device_id ?? ""),
    device_name: String(row.device_name ?? ""),
    device_kind: String(row.device_kind ?? ""),
    paired_at: String(row.paired_at ?? ""),
    last_seen: String(row.last_seen ?? ""),
    active: Boolean(row.active),
  };
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function snippet(body: string, query: string, width = 160): string {
  if (!body) return "";
  const flat = body.replace(/\n/g, " ");
  if (!query) return flat.slice(0, width).trim();
  const idx = flat.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return flat.slice(0, width).trim();
  const start = Math.max(0, idx - Math.floor(width / 3));
  const tail = start + width < flat.length ? "..." : "";
  return `${start ? "..." : ""}${flat.slice(start, start + width).trim()}${tail}`;
}

function toSummary(obj: MarginNoteObject, query: string): Record<string, unknown> {
  const body = obj.content || obj.excerpt || "";
  return {
    object_id: obj.object_id,
    object_type: obj.object_type,
    title: obj.title,
    document_title: obj.document_title,
    page: obj.page,
    tags: obj.tags ?? [],
    snippet: snippet(body, query),
    updated_at: obj.updated_at,
  };
}

export class MarginNoteStore {
  readonly dbPath: string;
  private readonly settings: Settings;

  constructor(dbPath: string | { dbPath?: string }, settings?: Settings) {
    // Accept either a plain path string or an options object.
    this.dbPath = typeof dbPath === "string" ? dbPath : String(dbPath?.dbPath ?? "");
    this.settings = settings ?? get_settings();
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.initSchema();
  }

  static openExisting(dbPath: string, settings?: Settings): MarginNoteStore | null {
    if (!existsSync(dbPath)) return null;
    return new MarginNoteStore(dbPath, settings);
  }

  private connect(): DatabaseSync {
    const conn = new DatabaseSync(this.dbPath);
    try {
      conn.exec("PRAGMA journal_mode=WAL");
    } catch { /* ignore */ }
    return conn;
  }

  private initSchema(): void {
    const conn = this.connect();
    try {
      conn.exec(SCHEMA);
    } finally {
      conn.close();
    }
  }

  // -- device pairing -------------------------------------------------------

  pairDevice(args: { device_name?: string; device_kind?: string } = {}): [PairedDevice, string] {
    const deviceId = randomBytes(9).toString("base64url");
    const token = randomBytes(24).toString("base64url");
    const tokenHash = hashToken(token);
    const now = nowIso();
    const device: PairedDevice = {
      device_id: deviceId,
      device_name: args.device_name ?? "",
      device_kind: args.device_kind ?? "macos",
      paired_at: now,
      last_seen: now,
      active: true,
    };
    const conn = this.connect();
    try {
      conn.prepare(
        `INSERT INTO mn4_devices
         (device_id, device_name, device_kind, token_hash, paired_at, last_seen, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).run(deviceId, device.device_name, device.device_kind, tokenHash, now, now);
      conn.prepare(
        "INSERT OR REPLACE INTO mn4_cursors (device_id, cursor) VALUES (?, '')",
      ).run(deviceId);
    } finally {
      conn.close();
    }
    return [device, token];
  }

  revokeDevice(deviceId: string): boolean {
    const conn = this.connect();
    try {
      const r = conn
        .prepare("UPDATE mn4_devices SET active = 0 WHERE device_id = ? AND active = 1")
        .run(deviceId);
      return Number(r.changes) > 0;
    } finally {
      conn.close();
    }
  }

  verifyToken(deviceId: string, token: string): boolean {
    const conn = this.connect();
    try {
      const row = conn
        .prepare("SELECT token_hash, active FROM mn4_devices WHERE device_id = ?")
        .get(deviceId) as Row | undefined;
      if (!row || !row.active) return false;
      const expected = String(row.token_hash ?? "");
      const actual = hashToken(token);
      const a = Buffer.from(expected, "utf8");
      const b = Buffer.from(actual, "utf8");
      return a.length === b.length && timingSafeEqual(a, b);
    } finally {
      conn.close();
    }
  }

  listDevices(): PairedDevice[] {
    const conn = this.connect();
    try {
      const rows = conn.prepare("SELECT * FROM mn4_devices ORDER BY paired_at").all() as Row[];
      return rows.map(rowToDevice);
    } finally {
      conn.close();
    }
  }

  touchDevice(deviceId: string): void {
    const conn = this.connect();
    try {
      conn.prepare("UPDATE mn4_devices SET last_seen = ? WHERE device_id = ?").run(nowIso(), deviceId);
    } finally {
      conn.close();
    }
  }

  // -- sync ingest ----------------------------------------------------------

  ingest(batch: SyncBatch): SyncResult {
    let stored = 0;
    let updated = 0;
    let deleted = 0;
    const now = nowIso();
    const conn = this.connect();
    try {
      conn.exec("BEGIN IMMEDIATE");
      try {
        for (const obj of batch.objects ?? []) {
          if (!ALL_TYPES.has(String(obj.object_type))) continue;
          const prev = conn
            .prepare("SELECT synced_at FROM mn4_objects WHERE object_id = ? AND device_id = ?")
            .get(String(obj.object_id), batch.device_id) as Row | undefined;
          const syncedAt = obj.synced_at || now;
          conn.prepare(
            `INSERT INTO mn4_objects
             (object_id, device_id, object_type, title, content,
              excerpt, document_id, document_title, page, tags,
              links, color, created_at, updated_at, synced_at, raw)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(object_id, device_id) DO UPDATE SET
               object_type=excluded.object_type,
               title=excluded.title, content=excluded.content,
               excerpt=excluded.excerpt,
               document_id=excluded.document_id,
               document_title=excluded.document_title,
               page=excluded.page, tags=excluded.tags,
               links=excluded.links, color=excluded.color,
               created_at=excluded.created_at,
               updated_at=excluded.updated_at,
               synced_at=excluded.synced_at, raw=excluded.raw`,
          ).run(
            String(obj.object_id),
            batch.device_id,
            String(obj.object_type),
            obj.title ?? "",
            obj.content ?? "",
            obj.excerpt ?? null,
            obj.document_id ?? null,
            obj.document_title ?? null,
            obj.page ?? null,
            JSON.stringify(obj.tags ?? []),
            JSON.stringify(obj.links ?? []),
            obj.color ?? null,
            obj.created_at ?? "",
            obj.updated_at ?? "",
            syncedAt,
            JSON.stringify(obj.raw ?? {}),
          );
          if (prev) updated += 1;
          else stored += 1;
        }
        for (const oid of batch.deleted_ids ?? []) {
          conn.prepare(
            "INSERT OR REPLACE INTO mn4_tombstones (object_id, device_id, deleted_at) VALUES (?, ?, ?)",
          ).run(String(oid), batch.device_id, now);
          conn.prepare("DELETE FROM mn4_objects WHERE object_id = ? AND device_id = ?")
            .run(String(oid), batch.device_id);
          deleted += 1;
        }
        const newCursor = nowIso();
        conn.prepare("INSERT OR REPLACE INTO mn4_cursors (device_id, cursor) VALUES (?, ?)")
          .run(batch.device_id, newCursor);
        conn.exec("COMMIT");
        return { stored, updated, deleted, new_cursor: newCursor };
      } catch (e) {
        conn.exec("ROLLBACK");
        throw e;
      }
    } finally {
      conn.close();
    }
  }

  getCursor(deviceId: string): string {
    const conn = this.connect();
    try {
      const row = conn.prepare("SELECT cursor FROM mn4_cursors WHERE device_id = ?").get(deviceId) as Row | undefined;
      return String(row?.cursor ?? "");
    } finally {
      conn.close();
    }
  }

  // -- read operations ------------------------------------------------------

  get(objectId: string, opts: { device_id?: string } = {}): MarginNoteObject | null {
    const conn = this.connect();
    try {
      const row = opts.device_id
        ? (conn.prepare("SELECT * FROM mn4_objects WHERE object_id = ? AND device_id = ?").get(objectId, opts.device_id) as Row | undefined)
        : (conn.prepare("SELECT * FROM mn4_objects WHERE object_id = ? LIMIT 1").get(objectId) as Row | undefined);
      return row ? rowToObject(row) : null;
    } finally {
      conn.close();
    }
  }

  search(
    query: string,
    opts: { object_type?: string; device_id?: string; limit?: number } = {},
  ): Array<Record<string, unknown>> {
    const q = (query ?? "").trim();
    if (!q) return [];
    const needle = `%${escapeLike(q.toLowerCase())}%`;
    let sql =
      "SELECT * FROM mn4_objects " +
      "WHERE (LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(content) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(excerpt, '')) LIKE ? ESCAPE '\\' " +
      "OR LOWER(COALESCE(document_title, '')) LIKE ? ESCAPE '\\')";
    const params: unknown[] = [needle, needle, needle, needle];
    if (opts.object_type) {
      sql += " AND object_type = ?";
      params.push(opts.object_type);
    }
    if (opts.device_id) {
      sql += " AND device_id = ?";
      params.push(opts.device_id);
    }
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(opts.limit ?? 20);
    const conn = this.connect();
    try {
      const rows = conn.prepare(sql).all(...(params as never[])) as Row[];
      return rows.map((r) => toSummary(rowToObject(r), q));
    } finally {
      conn.close();
    }
  }

  listObjects(
    opts: { object_type?: string; document_id?: string; device_id?: string; limit?: number } = {},
  ): Array<Record<string, unknown>> {
    let sql = "SELECT * FROM mn4_objects WHERE 1=1";
    const params: unknown[] = [];
    if (opts.object_type) { sql += " AND object_type = ?"; params.push(opts.object_type); }
    if (opts.document_id) { sql += " AND document_id = ?"; params.push(opts.document_id); }
    if (opts.device_id) { sql += " AND device_id = ?"; params.push(opts.device_id); }
    sql += " ORDER BY COALESCE(document_title, title), updated_at DESC LIMIT ?";
    params.push(opts.limit ?? 200);
    const conn = this.connect();
    try {
      const rows = conn.prepare(sql).all(...(params as never[])) as Row[];
      return rows.map((r) => toSummary(rowToObject(r), ""));
    } finally {
      conn.close();
    }
  }

  listDocuments(opts: { device_id?: string } = {}): Array<Record<string, unknown>> {
    let sql =
      "SELECT document_id, document_title, COUNT(*) AS n " +
      "FROM mn4_objects WHERE document_id IS NOT NULL";
    const params: unknown[] = [];
    if (opts.device_id) { sql += " AND device_id = ?"; params.push(opts.device_id); }
    sql += " GROUP BY document_id, document_title ORDER BY document_title";
    const conn = this.connect();
    try {
      const rows = conn.prepare(sql).all(...(params as never[])) as Row[];
      return rows.map((r) => ({
        document_id: r.document_id,
        title: r.document_title || "(untitled)",
        count: Number(r.n),
      }));
    } finally {
      conn.close();
    }
  }

  linkedObjects(objectId: string, opts: { device_id?: string } = {}): Array<Record<string, unknown>> {
    const obj = this.get(objectId, opts);
    if (!obj) return [];
    const linkedIds = new Set<string>(obj.links ?? []);
    const conn = this.connect();
    try {
      const rows = conn
        .prepare("SELECT object_id FROM mn4_objects WHERE links LIKE ? ESCAPE '\\'")
        .all(`%"${escapeLike(objectId)}"%`) as Row[];
      for (const r of rows) linkedIds.add(String(r.object_id));
    } finally {
      conn.close();
    }
    const results: Array<Record<string, unknown>> = [];
    for (const lid of linkedIds) {
      const linked = this.get(lid, opts);
      if (linked) results.push(toSummary(linked, ""));
    }
    return results;
  }

  collectTags(opts: { device_id?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    let sql = "SELECT tags FROM mn4_objects";
    const params: unknown[] = [];
    if (opts.device_id) { sql += " WHERE device_id = ?"; params.push(opts.device_id); }
    const conn = this.connect();
    let rows: Row[];
    try {
      rows = conn.prepare(sql).all(...(params as never[])) as Row[];
    } finally {
      conn.close();
    }
    const counts = new Map<string, number>();
    for (const r of rows) {
      let tags: unknown;
      try { tags = JSON.parse(String(r.tags ?? "[]")); } catch { tags = []; }
      for (const tag of Array.isArray(tags) ? tags : []) {
        const t = String(tag).trim();
        if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, opts.limit ?? 200)
      .map(([tag, count]) => ({ tag, count }));
  }

  count(opts: { device_id?: string } = {}): number {
    const conn = this.connect();
    try {
      const row = opts.device_id
        ? (conn.prepare("SELECT COUNT(*) AS n FROM mn4_objects WHERE device_id = ?").get(opts.device_id) as Row | undefined)
        : (conn.prepare("SELECT COUNT(*) AS n FROM mn4_objects").get() as Row | undefined);
      return Number(row?.n ?? 0);
    } finally {
      conn.close();
    }
  }
}

export const MN4_OBJECT_TYPES = ALL_TYPES;
