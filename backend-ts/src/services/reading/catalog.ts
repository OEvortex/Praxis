// Port of deeptutor/reading/catalog_store.py + catalog_models.py — SQLite
// catalog for private Immersive Reading workspaces. The database lives at
// <root>/_catalog.sqlite3, same as upstream.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ReadingError } from "./models.js";

export type SourceKind = "file" | "web" | "video" | "youtube" | "bilibili" | "audio";
export type IngestionStatus = "queued" | "processing" | "ready" | "failed";

export interface MaterialRecord {
  material_id: string;
  content_id: string;
  filename: string;
  title: string;
  source_kind: SourceKind;
  source_url: string;
  mime: string;
  render_mode: string;
  cover_url: string;
  duration_seconds: number;
  status: IngestionStatus;
  progress: number;
  error_code: string;
  error_detail: string;
  created_at: number;
  updated_at: number;
  last_opened_at: number;
}

export interface WorkspaceTab {
  material: MaterialRecord;
  tab_order: number;
  pinned: boolean;
  opened: boolean;
  added_at: number;
}

export interface WorkspaceRecord {
  workspace_id: string;
  title: string;
  description: string;
  color: string;
  active_material_id: string | null;
  created_at: number;
  updated_at: number;
  tabs: WorkspaceTab[];
}

export interface ReadingSessionRecord {
  workspace_id: string;
  session_id: string;
  title: string;
  active_material_id: string | null;
  created_at: number;
  updated_at: number;
}

function materialToDict(m: MaterialRecord): Record<string, unknown> {
  return { ...m };
}

function workspaceToDict(w: WorkspaceRecord): Record<string, unknown> {
  return {
    workspace_id: w.workspace_id,
    title: w.title,
    description: w.description,
    color: w.color,
    active_material_id: w.active_material_id,
    created_at: w.created_at,
    updated_at: w.updated_at,
    tabs: w.tabs.map((t) => ({
      material: materialToDict(t.material),
      tab_order: t.tab_order,
      pinned: t.pinned,
      opened: t.opened,
      added_at: t.added_at,
    })),
  };
}

function sessionToDict(s: ReadingSessionRecord): Record<string, unknown> {
  return { ...s };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COLLECTION_COLORS = new Set(["blue", "teal", "green", "amber", "orange", "rose", "violet", "slate"]);

function collectionColor(color: string): string {
  const key = String(color ?? "").trim().toLowerCase();
  return COLLECTION_COLORS.has(key) ? key : "";
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reading_schema (version INTEGER NOT NULL);
INSERT INTO reading_schema(version) SELECT 3 WHERE NOT EXISTS (SELECT 1 FROM reading_schema);

CREATE TABLE IF NOT EXISTS reading_materials (
    material_id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    filename TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    render_mode TEXT NOT NULL DEFAULT 'text',
    cover_url TEXT NOT NULL DEFAULT '',
    duration_seconds REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    error_detail TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    last_opened_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reading_materials_updated ON reading_materials(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reading_materials_content ON reading_materials(content_id);

CREATE TABLE IF NOT EXISTS reading_workspaces (
    workspace_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    active_material_id TEXT REFERENCES reading_materials(material_id) ON DELETE SET NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_workspaces_updated ON reading_workspaces(updated_at DESC);

CREATE TABLE IF NOT EXISTS reading_workspace_materials (
    workspace_id TEXT NOT NULL REFERENCES reading_workspaces(workspace_id) ON DELETE CASCADE,
    material_id TEXT NOT NULL REFERENCES reading_materials(material_id) ON DELETE CASCADE,
    tab_order INTEGER NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    opened INTEGER NOT NULL DEFAULT 1,
    added_at REAL NOT NULL,
    PRIMARY KEY (workspace_id, material_id),
    UNIQUE (workspace_id, tab_order)
);

CREATE TABLE IF NOT EXISTS reading_workspace_sessions (
    workspace_id TEXT NOT NULL REFERENCES reading_workspaces(workspace_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT 'New reading conversation',
    active_material_id TEXT REFERENCES reading_materials(material_id) ON DELETE SET NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (workspace_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_reading_sessions_workspace_updated
    ON reading_workspace_sessions(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS reading_session_links (
    workspace_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (workspace_id, source_session_id, target_session_id),
    FOREIGN KEY (workspace_id, source_session_id)
        REFERENCES reading_workspace_sessions(workspace_id, session_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, target_session_id)
        REFERENCES reading_workspace_sessions(workspace_id, session_id) ON DELETE CASCADE,
    CHECK (source_session_id <> target_session_id)
);
`;

type Row = Record<string, unknown>;

export class ReadingCatalogStore {
  readonly root: string;
  readonly dbPath: string;
  private db: DatabaseSync | null = null;

  constructor(root: string) {
    this.root = root;
    mkdirSync(this.root, { recursive: true });
    this.dbPath = join(this.root, "_catalog.sqlite3");
    this.init();
  }

  private conn(): DatabaseSync {
    if (this.db) return this.db;
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 30000");
    return this.db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private init(): void {
    const conn = this.conn();
    conn.exec(SCHEMA);
    // Tolerate older layouts: ensure columns exist.
    const cols = new Set(
      (conn.prepare("PRAGMA table_info(reading_materials)").all() as Row[]).map((r) => String(r.name)),
    );
    if (!cols.has("duration_seconds")) {
      conn.exec("ALTER TABLE reading_materials ADD COLUMN duration_seconds REAL NOT NULL DEFAULT 0");
    }
    const wcols = new Set(
      (conn.prepare("PRAGMA table_info(reading_workspaces)").all() as Row[]).map((r) => String(r.name)),
    );
    if (!wcols.has("color")) {
      conn.exec("ALTER TABLE reading_workspaces ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    }
    conn.exec("CREATE INDEX IF NOT EXISTS idx_reading_materials_updated ON reading_materials(updated_at DESC)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_reading_materials_content ON reading_materials(content_id)");
  }

  // -- materials -------------------------------------------------------------

  upsertMaterial(opts: {
    content_id: string;
    filename: string;
    title: string;
    source_kind: SourceKind | string;
    source_url?: string;
    mime?: string;
    render_mode?: string;
    cover_url?: string;
    duration_seconds?: number;
    status?: IngestionStatus | string;
    progress?: number | null;
    material_id?: string | null;
    error_code?: string;
    error_detail?: string;
  }): MaterialRecord {
    const contentId = String(opts.content_id ?? "").trim();
    let resolvedId = opts.material_id ||
      (SAFE_ID.test(contentId) ? contentId : newId("mat"));
    resolvedId = this.validateId(resolvedId, "material");
    const finalContentId = contentId || resolvedId;
    const sourceValue = String(opts.source_kind);
    if (!["file", "web", "video", "youtube", "bilibili", "audio"].includes(sourceValue)) {
      throw new ReadingError(`invalid source kind: ${sourceValue}`);
    }
    const statusValue = String(opts.status ?? "queued") as IngestionStatus;
    if (!["queued", "processing", "ready", "failed"].includes(statusValue)) {
      throw new ReadingError(`invalid ingestion status: ${statusValue}`);
    }
    const resolvedProgress = statusValue === "ready"
      ? 100
      : Math.max(0, Math.min(opts.progress ?? 0, 99));
    const now = Date.now() / 1000;
    const conn = this.conn();
    conn.prepare(
      `INSERT INTO reading_materials (
          material_id, content_id, filename, title, source_kind, source_url,
          mime, render_mode, cover_url, status, progress, error_code,
          error_detail, duration_seconds, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(material_id) DO UPDATE SET
          content_id = excluded.content_id,
          filename = excluded.filename, title = excluded.title,
          source_kind = excluded.source_kind, source_url = excluded.source_url,
          mime = excluded.mime, render_mode = excluded.render_mode,
          cover_url = CASE WHEN excluded.cover_url <> '' THEN excluded.cover_url
                           ELSE reading_materials.cover_url END,
          duration_seconds = CASE WHEN excluded.duration_seconds > 0
                                  THEN excluded.duration_seconds
                                  ELSE reading_materials.duration_seconds END,
          status = excluded.status, progress = excluded.progress,
          error_code = excluded.error_code, error_detail = excluded.error_detail,
          updated_at = excluded.updated_at`,
    ).run(
      resolvedId,
      finalContentId,
      String(opts.filename ?? "").trim().slice(0, 500),
      String(opts.title || opts.filename || "Untitled material").trim().slice(0, 500),
      sourceValue,
      String(opts.source_url ?? "").trim().slice(0, 4096),
      String(opts.mime ?? "").trim().slice(0, 255),
      String(opts.render_mode ?? "text").trim().slice(0, 32) || "text",
      String(opts.cover_url ?? "").trim().slice(0, 4096),
      statusValue,
      resolvedProgress,
      String(opts.error_code ?? "").trim().slice(0, 128),
      String(opts.error_detail ?? "").trim().slice(0, 4000),
      Math.max(0, Number(opts.duration_seconds) || 0),
      now,
      now,
    );
    const row = conn.prepare("SELECT * FROM reading_materials WHERE material_id = ?").get(resolvedId) as Row;
    return this.material(row);
  }

  registerManifest(manifest: {
    material_id: string;
    filename: string;
    title: string;
    mime: string;
    render_mode: string;
  }): MaterialRecord {
    return this.upsertMaterial({
      content_id: manifest.material_id,
      material_id: manifest.material_id,
      filename: manifest.filename,
      title: manifest.title,
      source_kind: "file",
      mime: manifest.mime,
      render_mode: manifest.render_mode,
      status: "ready",
    });
  }

  getMaterial(materialId: string): MaterialRecord | null {
    this.validateId(materialId, "material");
    const row = this.conn()
      .prepare("SELECT * FROM reading_materials WHERE material_id = ?")
      .get(materialId) as Row | undefined;
    return row ? this.material(row) : null;
  }

  findMaterialByContent(contentId: string): MaterialRecord | null {
    const resolved = String(contentId ?? "").trim();
    if (!resolved) return null;
    const row = this.conn()
      .prepare(
        `SELECT * FROM reading_materials WHERE content_id = ?
         ORDER BY created_at, material_id LIMIT 1`,
      )
      .get(resolved) as Row | undefined;
    return row ? this.material(row) : null;
  }

  findReadyMaterialByFilename(filename: string, opts: { mime?: string } = {}): MaterialRecord | null {
    const resolvedName = String(filename ?? "").split(/[\\/]/).pop()?.trim() ?? "";
    if (!resolvedName) return null;
    const mime = String(opts.mime ?? "").trim();
    const rows = this.conn()
      .prepare(
        `SELECT * FROM reading_materials
         WHERE filename = ? AND status = 'ready'
         ORDER BY updated_at DESC LIMIT 20`,
      )
      .all(resolvedName) as Row[];
    for (const row of rows) {
      const record = this.material(row);
      if (!mime || record.mime === mime || !record.mime) return record;
    }
    return null;
  }

  listMaterials(opts: {
    search?: string;
    status?: IngestionStatus | string | null;
    library_filter?: string;
    limit?: number;
    offset?: number;
  } = {}): MaterialRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const search = String(opts.search ?? "").trim();
    if (search) {
      const escaped = escapeLike(search);
      clauses.push("(title LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\')");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (opts.status != null) {
      clauses.push("status = ?");
      params.push(String(opts.status));
    }
    const filter = opts.library_filter ?? "all";
    if (filter === "unassigned") {
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM reading_workspace_materials wm WHERE wm.material_id = reading_materials.material_id)",
      );
    } else if (filter === "processing") {
      clauses.push("status IN ('queued', 'processing')");
    } else if (filter === "failed") {
      clauses.push("status = 'failed'");
    } else if (filter !== "all") {
      throw new ReadingError(`unsupported material library filter: ${filter}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(opts.limit ?? 200, 500)), Math.max(0, opts.offset ?? 0));
    const rows = this.conn()
      .prepare(
        `SELECT * FROM reading_materials ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[])) as Row[];
    return rows.map((r) => this.material(r));
  }

  collectionsForMaterials(materialIds: string[]): Record<string, Array<{ workspace_id: string; title: string }>> {
    const unique = [...new Set(materialIds)];
    const grouped: Record<string, Array<{ workspace_id: string; title: string }>> = {};
    for (const id of unique) grouped[id] = [];
    if (!unique.length) return grouped;
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.conn()
      .prepare(
        `SELECT wm.material_id, w.workspace_id, w.title
         FROM reading_workspace_materials wm
         JOIN reading_workspaces w USING (workspace_id)
         WHERE wm.material_id IN (${placeholders})
         ORDER BY w.title COLLATE NOCASE, w.workspace_id`,
      )
      .all(...(unique as never[])) as Row[];
    for (const row of rows) {
      const list = grouped[String(row.material_id)];
      if (list) {
        list.push({ workspace_id: String(row.workspace_id), title: String(row.title) });
      }
    }
    return grouped;
  }

  collectionsForMaterial(materialId: string): Array<{ workspace_id: string; title: string }> {
    this.validateId(materialId, "material");
    return this.collectionsForMaterials([materialId])[materialId] ?? [];
  }

  libraryCounts(materialIds?: string[] | null): Record<string, unknown> {
    let where = "";
    const params: string[] = [];
    if (materialIds != null) {
      const ids = [...new Set(materialIds.map(String).filter(Boolean))];
      if (ids.length) {
        where = `WHERE material_id IN (${ids.map(() => "?").join(",")})`;
        params.push(...ids);
      } else {
        where = "WHERE 0";
      }
    }
    const row = this.conn()
      .prepare(
        `SELECT
          COUNT(*) AS all_count,
          COALESCE(SUM(NOT EXISTS (
              SELECT 1 FROM reading_workspace_materials wm
              WHERE wm.material_id = reading_materials.material_id
          )), 0) AS unassigned_count,
          COALESCE(SUM(status IN ('queued', 'processing')), 0) AS processing_count,
          COALESCE(SUM(status = 'failed'), 0) AS failed_count,
          COALESCE(SUM(CASE WHEN render_mode = 'video' OR source_kind = 'video' THEN 1 ELSE 0 END), 0) AS video_count,
          COALESCE(SUM(CASE WHEN render_mode = 'audio' OR source_kind = 'audio' THEN 1 ELSE 0 END), 0) AS audio_count,
          COALESCE(SUM(CASE WHEN render_mode NOT IN ('video', 'audio') AND source_kind = 'web' THEN 1 ELSE 0 END), 0) AS web_count,
          COALESCE(SUM(CASE WHEN render_mode NOT IN ('video', 'audio') AND source_kind = 'file' THEN 1 ELSE 0 END), 0) AS document_count
        FROM reading_materials ${where}`,
      )
      .get(...(params as never[])) as Row;
    return {
      all: Number(row.all_count),
      unassigned: Number(row.unassigned_count),
      processing: Number(row.processing_count),
      failed: Number(row.failed_count),
      by_kind: {
        document: Number(row.document_count),
        web: Number(row.web_count),
        video: Number(row.video_count),
        audio: Number(row.audio_count),
      },
    };
  }

  countMaterialsForContent(contentId: string): number {
    const row = this.conn()
      .prepare("SELECT COUNT(*) AS count FROM reading_materials WHERE content_id = ?")
      .get(String(contentId ?? "").trim()) as Row;
    return Number(row.count) || 0;
  }

  updateMaterialStatus(
    materialId: string,
    status: IngestionStatus | string,
    opts: { progress?: number | null; error_code?: string; error_detail?: string } = {},
  ): MaterialRecord {
    this.validateId(materialId, "material");
    const value = String(status) as IngestionStatus;
    const resolvedProgress = value === "ready" ? 100 : Math.max(0, Math.min(opts.progress ?? 0, 99));
    const changed = this.conn()
      .prepare(
        `UPDATE reading_materials
         SET status = ?, progress = ?, error_code = ?, error_detail = ?, updated_at = ?
         WHERE material_id = ?`,
      )
      .run(
        value,
        resolvedProgress,
        String(opts.error_code ?? "").slice(0, 128),
        String(opts.error_detail ?? "").slice(0, 4000),
        Date.now() / 1000,
        materialId,
      );
    if (!changed.changes) throw new ReadingError(`material ${JSON.stringify(materialId)} not found`);
    return this.getMaterial(materialId)!;
  }

  deleteMaterial(materialId: string): boolean {
    this.validateId(materialId, "material");
    return Boolean(
      this.conn()
        .prepare("DELETE FROM reading_materials WHERE material_id = ?")
        .run(materialId).changes,
    );
  }

  // -- workspaces ---------------------------------------------------------------

  createWorkspace(
    title: string,
    materialIds: string[] = [],
    opts: { description?: string; color?: string; workspace_id?: string | null } = {},
  ): WorkspaceRecord {
    const resolvedId = opts.workspace_id || newId("rw");
    this.validateId(resolvedId, "workspace");
    const uniqueMaterials = [...new Set(materialIds)];
    const now = Date.now() / 1000;
    const conn = this.conn();
    this.requireMaterials(conn, uniqueMaterials);
    conn.prepare(
      `INSERT INTO reading_workspaces (
          workspace_id, title, description, color, active_material_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      resolvedId,
      (title || "Untitled reading workspace").trim().slice(0, 300),
      String(opts.description ?? "").trim().slice(0, 2000),
      collectionColor(String(opts.color ?? "")),
      uniqueMaterials[0] ?? null,
      now,
      now,
    );
    const insertTab = conn.prepare(
      `INSERT INTO reading_workspace_materials (workspace_id, material_id, tab_order, added_at)
       VALUES (?, ?, ?, ?)`,
    );
    uniqueMaterials.forEach((materialId, index) => {
      insertTab.run(resolvedId, materialId, index, now);
    });
    return this.getWorkspace(resolvedId)!;
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | null {
    this.validateId(workspaceId, "workspace");
    const conn = this.conn();
    const row = conn
      .prepare("SELECT * FROM reading_workspaces WHERE workspace_id = ?")
      .get(workspaceId) as Row | undefined;
    if (!row) return null;
    return this.workspace(row, this.workspaceTabs(conn, workspaceId));
  }

  listWorkspaces(opts: { search?: string; limit?: number; offset?: number } = {}): WorkspaceRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const search = String(opts.search ?? "").trim();
    if (search) {
      clauses.push("w.title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(search)}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.max(1, Math.min(opts.limit ?? 100, 500)), Math.max(0, opts.offset ?? 0));
    const rows = this.conn()
      .prepare(
        `SELECT w.workspace_id FROM reading_workspaces w ${where}
         ORDER BY w.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[])) as Row[];
    const results: WorkspaceRecord[] = [];
    for (const row of rows) {
      const workspace = this.getWorkspace(String(row.workspace_id));
      if (workspace) results.push(workspace);
    }
    return results;
  }

  updateWorkspace(
    workspaceId: string,
    opts: { title?: string | null; description?: string | null; color?: string | null },
  ): WorkspaceRecord {
    this.validateId(workspaceId, "workspace");
    const assignments: string[] = ["updated_at = ?"];
    const params: unknown[] = [Date.now() / 1000];
    if (opts.title !== undefined && opts.title !== null) {
      assignments.push("title = ?");
      params.push((opts.title || "Untitled reading workspace").trim().slice(0, 300));
    }
    if (opts.description !== undefined && opts.description !== null) {
      assignments.push("description = ?");
      params.push(String(opts.description).trim().slice(0, 2000));
    }
    if (opts.color !== undefined && opts.color !== null) {
      assignments.push("color = ?");
      params.push(collectionColor(String(opts.color)));
    }
    params.push(workspaceId);
    const changed = this.conn()
      .prepare(`UPDATE reading_workspaces SET ${assignments.join(", ")} WHERE workspace_id = ?`)
      .run(...(params as never[]));
    if (!changed.changes) throw new ReadingError(`workspace ${JSON.stringify(workspaceId)} not found`);
    return this.getWorkspace(workspaceId)!;
  }

  deleteWorkspace(workspaceId: string): boolean {
    this.validateId(workspaceId, "workspace");
    return Boolean(
      this.conn()
        .prepare("DELETE FROM reading_workspaces WHERE workspace_id = ?")
        .run(workspaceId).changes,
    );
  }

  addMaterial(workspaceId: string, materialId: string, opts: { make_active?: boolean } = {}): WorkspaceRecord {
    this.validateId(workspaceId, "workspace");
    this.validateId(materialId, "material");
    const now = Date.now() / 1000;
    const conn = this.conn();
    this.requireWorkspace(conn, workspaceId);
    this.requireMaterials(conn, [materialId]);
    const existing = conn
      .prepare(
        `SELECT 1 FROM reading_workspace_materials
         WHERE workspace_id = ? AND material_id = ?`,
      )
      .get(workspaceId, materialId);
    if (!existing) {
      const next = conn
        .prepare(
          `SELECT COALESCE(MAX(tab_order), -1) + 1 AS next
           FROM reading_workspace_materials WHERE workspace_id = ?`,
        )
        .get(workspaceId) as Row;
      conn.prepare(
        `INSERT INTO reading_workspace_materials (workspace_id, material_id, tab_order, added_at)
         VALUES (?, ?, ?, ?)`,
      ).run(workspaceId, materialId, Number(next.next), now);
    }
    const current = conn
      .prepare("SELECT active_material_id FROM reading_workspaces WHERE workspace_id = ?")
      .get(workspaceId) as Row;
    const active = (opts.make_active || current.active_material_id == null
      ? materialId
      : current.active_material_id) as string;
    conn.prepare(
      "UPDATE reading_workspaces SET active_material_id = ?, updated_at = ? WHERE workspace_id = ?",
    ).run(active, now, workspaceId);
    return this.existingWorkspace(workspaceId);
  }

  removeMaterial(workspaceId: string, materialId: string): WorkspaceRecord {
    const conn = this.conn();
    this.requireWorkspace(conn, workspaceId);
    const removed = conn
      .prepare(
        `DELETE FROM reading_workspace_materials
         WHERE workspace_id = ? AND material_id = ?`,
      )
      .run(workspaceId, materialId).changes;
    if (!removed) {
      throw new ReadingError("material does not belong to this reading workspace");
    }
    const rows = conn
      .prepare(
        `SELECT material_id FROM reading_workspace_materials
         WHERE workspace_id = ? ORDER BY tab_order`,
      )
      .all(workspaceId) as Row[];
    conn.prepare(
      "UPDATE reading_workspace_materials SET tab_order = -tab_order - 1 WHERE workspace_id = ?",
    ).run(workspaceId);
    const updateOrder = conn.prepare(
      `UPDATE reading_workspace_materials SET tab_order = ?
       WHERE workspace_id = ? AND material_id = ?`,
    );
    rows.forEach((row, index) => {
      updateOrder.run(index, workspaceId, row.material_id as string);
    });
    const current = conn
      .prepare("SELECT active_material_id FROM reading_workspaces WHERE workspace_id = ?")
      .get(workspaceId) as Row;
    let active: string | null = current.active_material_id == null ? null : String(current.active_material_id);
    if (active === materialId && rows.length) active = String(rows[0]!.material_id);
    if (!rows.length) active = null;
    conn.prepare(
      "UPDATE reading_workspaces SET active_material_id = ?, updated_at = ? WHERE workspace_id = ?",
    ).run(active, Date.now() / 1000, workspaceId);
    return this.existingWorkspace(workspaceId);
  }

  reorderMaterials(workspaceId: string, materialIds: string[]): WorkspaceRecord {
    const ordered = [...materialIds];
    if (new Set(ordered).size !== ordered.length) {
      throw new ReadingError("tab order contains duplicate materials");
    }
    const conn = this.conn();
    const current = (
      conn
        .prepare(
          `SELECT material_id FROM reading_workspace_materials
           WHERE workspace_id = ? ORDER BY tab_order`,
        )
        .all(workspaceId) as Row[]
    ).map((r) => String(r.material_id));
    if (new Set(current).size !== new Set(ordered).size ||
        !current.every((id) => ordered.includes(id))) {
      throw new ReadingError("tab order must include every workspace material exactly once");
    }
    conn.prepare(
      "UPDATE reading_workspace_materials SET tab_order = -tab_order - 1 WHERE workspace_id = ?",
    ).run(workspaceId);
    const updateOrder = conn.prepare(
      `UPDATE reading_workspace_materials SET tab_order = ?
       WHERE workspace_id = ? AND material_id = ?`,
    );
    ordered.forEach((materialId, index) => {
      updateOrder.run(index, workspaceId, materialId);
    });
    conn.prepare("UPDATE reading_workspaces SET updated_at = ? WHERE workspace_id = ?")
      .run(Date.now() / 1000, workspaceId);
    return this.existingWorkspace(workspaceId);
  }

  setActiveMaterial(workspaceId: string, materialId: string): WorkspaceRecord {
    const now = Date.now() / 1000;
    const conn = this.conn();
    const member = conn
      .prepare(
        `SELECT 1 FROM reading_workspace_materials
         WHERE workspace_id = ? AND material_id = ?`,
      )
      .get(workspaceId, materialId);
    if (!member) {
      throw new ReadingError("material does not belong to this reading workspace");
    }
    conn.prepare(
      "UPDATE reading_workspaces SET active_material_id = ?, updated_at = ? WHERE workspace_id = ?",
    ).run(materialId, now, workspaceId);
    conn.prepare("UPDATE reading_materials SET last_opened_at = ? WHERE material_id = ?")
      .run(now, materialId);
    return this.existingWorkspace(workspaceId);
  }

  // -- sessions ---------------------------------------------------------------

  attachSession(
    workspaceId: string,
    sessionId: string,
    opts: { title?: string; active_material_id?: string | null } = {},
  ): ReadingSessionRecord {
    this.validateId(sessionId, "session");
    const now = Date.now() / 1000;
    const conn = this.conn();
    this.requireWorkspace(conn, workspaceId);
    const activeMaterialId = opts.active_material_id ?? null;
    if (
      activeMaterialId &&
      !conn
        .prepare(
          `SELECT 1 FROM reading_workspace_materials
           WHERE workspace_id = ? AND material_id = ?`,
        )
        .get(workspaceId, activeMaterialId)
    ) {
      throw new ReadingError("active material does not belong to this reading workspace");
    }
    const existing = conn
      .prepare("SELECT workspace_id FROM reading_workspace_sessions WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    if (existing && existing.workspace_id !== workspaceId) {
      throw new ReadingError("session already belongs to another reading workspace");
    }
    conn.prepare(
      `INSERT INTO reading_workspace_sessions
         (workspace_id, session_id, title, active_material_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET title = excluded.title,
           active_material_id = excluded.active_material_id,
           updated_at = excluded.updated_at`,
    ).run(
      workspaceId,
      sessionId,
      (opts.title || "New reading conversation").trim().slice(0, 300),
      activeMaterialId,
      now,
      now,
    );
    const row = conn
      .prepare("SELECT * FROM reading_workspace_sessions WHERE session_id = ?")
      .get(sessionId) as Row;
    return this.session(row);
  }

  listSessions(workspaceId: string): ReadingSessionRecord[] {
    const rows = this.conn()
      .prepare(
        `SELECT * FROM reading_workspace_sessions
         WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(workspaceId) as Row[];
    return rows.map((r) => this.session(r));
  }

  renameSession(workspaceId: string, sessionId: string, title: string): ReadingSessionRecord {
    const conn = this.conn();
    const changed = conn
      .prepare(
        `UPDATE reading_workspace_sessions SET title = ?, updated_at = ?
         WHERE workspace_id = ? AND session_id = ?`,
      )
      .run(
        (title || "New reading conversation").trim().slice(0, 300),
        Date.now() / 1000,
        workspaceId,
        sessionId,
      );
    const row = conn
      .prepare(
        `SELECT * FROM reading_workspace_sessions
         WHERE workspace_id = ? AND session_id = ?`,
      )
      .get(workspaceId, sessionId) as Row | undefined;
    if (!changed.changes || !row) {
      throw new ReadingError("reading session not found in this workspace");
    }
    return this.session(row);
  }

  detachSession(workspaceId: string, sessionId: string): boolean {
    return Boolean(
      this.conn()
        .prepare(
          `DELETE FROM reading_workspace_sessions
           WHERE workspace_id = ? AND session_id = ?`,
        )
        .run(workspaceId, sessionId).changes,
    );
  }

  retitleSession(sessionId: string, title: string): void {
    this.conn()
      .prepare(
        `UPDATE reading_workspace_sessions SET title = ?, updated_at = ? WHERE session_id = ?`,
      )
      .run((title || "New reading conversation").trim().slice(0, 300), Date.now() / 1000, sessionId);
  }

  forgetSession(sessionId: string): void {
    this.conn()
      .prepare("DELETE FROM reading_workspace_sessions WHERE session_id = ?")
      .run(sessionId);
  }

  linkSession(workspaceId: string, sourceSessionId: string, targetSessionId: string): void {
    if (sourceSessionId === targetSessionId) {
      throw new ReadingError("a reading session cannot reference itself");
    }
    const conn = this.conn();
    const rows = conn
      .prepare(
        `SELECT session_id FROM reading_workspace_sessions
         WHERE workspace_id = ? AND session_id IN (?, ?)`,
      )
      .all(workspaceId, sourceSessionId, targetSessionId) as Row[];
    const found = new Set(rows.map((r) => String(r.session_id)));
    if (found.size !== 2 || !found.has(sourceSessionId) || !found.has(targetSessionId)) {
      throw new ReadingError("linked sessions must belong to the same reading workspace");
    }
    conn.prepare(
      `INSERT OR IGNORE INTO reading_session_links
         (workspace_id, source_session_id, target_session_id, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(workspaceId, sourceSessionId, targetSessionId, Date.now() / 1000);
  }

  listSessionLinks(workspaceId: string, sourceSessionId: string): string[] {
    const rows = this.conn()
      .prepare(
        `SELECT target_session_id FROM reading_session_links
         WHERE workspace_id = ? AND source_session_id = ? ORDER BY created_at`,
      )
      .all(workspaceId, sourceSessionId) as Row[];
    return rows.map((r) => String(r.target_session_id));
  }

  unlinkSession(workspaceId: string, sourceSessionId: string, targetSessionId: string): boolean {
    return Boolean(
      this.conn()
        .prepare(
          `DELETE FROM reading_session_links
           WHERE workspace_id = ? AND source_session_id = ? AND target_session_id = ?`,
        )
        .run(workspaceId, sourceSessionId, targetSessionId).changes,
    );
  }

  // -- row helpers ---------------------------------------------------------------

  private material(row: Row): MaterialRecord {
    return {
      material_id: String(row.material_id),
      content_id: String(row.content_id),
      filename: String(row.filename ?? ""),
      title: String(row.title ?? ""),
      source_kind: String(row.source_kind) as SourceKind,
      source_url: String(row.source_url ?? ""),
      mime: String(row.mime ?? ""),
      render_mode: String(row.render_mode ?? "text"),
      cover_url: String(row.cover_url ?? ""),
      duration_seconds: Number(row.duration_seconds) || 0,
      status: String(row.status) as IngestionStatus,
      progress: Number(row.progress) || 0,
      error_code: String(row.error_code ?? ""),
      error_detail: String(row.error_detail ?? ""),
      created_at: Number(row.created_at) || 0,
      updated_at: Number(row.updated_at) || 0,
      last_opened_at: Number(row.last_opened_at) || 0,
    };
  }

  private workspace(row: Row, tabs: WorkspaceTab[] = []): WorkspaceRecord {
    return {
      workspace_id: String(row.workspace_id),
      title: String(row.title ?? ""),
      description: String(row.description ?? ""),
      color: String(row.color ?? ""),
      active_material_id: row.active_material_id == null ? null : String(row.active_material_id),
      created_at: Number(row.created_at) || 0,
      updated_at: Number(row.updated_at) || 0,
      tabs,
    };
  }

  private workspaceTabs(conn: DatabaseSync, workspaceId: string): WorkspaceTab[] {
    const rows = conn
      .prepare(
        `SELECT m.*, wm.tab_order, wm.pinned, wm.opened, wm.added_at
         FROM reading_workspace_materials wm JOIN reading_materials m USING (material_id)
         WHERE wm.workspace_id = ? ORDER BY wm.tab_order`,
      )
      .all(workspaceId) as Row[];
    return rows.map((row) => ({
      material: this.material(row),
      tab_order: Number(row.tab_order),
      pinned: Boolean(row.pinned),
      opened: Boolean(row.opened),
      added_at: Number(row.added_at) || 0,
    }));
  }

  private session(row: Row): ReadingSessionRecord {
    return {
      workspace_id: String(row.workspace_id),
      session_id: String(row.session_id),
      title: String(row.title ?? ""),
      active_material_id: row.active_material_id == null ? null : String(row.active_material_id),
      created_at: Number(row.created_at) || 0,
      updated_at: Number(row.updated_at) || 0,
    };
  }

  private existingWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.getWorkspace(workspaceId);
    if (!workspace) throw new ReadingError(`workspace ${JSON.stringify(workspaceId)} not found`);
    return workspace;
  }

  private validateId(value: string, label: string): string {
    if (!SAFE_ID.test(String(value ?? ""))) {
      throw new ReadingError(`invalid ${label} id: ${JSON.stringify(value)}`);
    }
    return String(value);
  }

  private requireWorkspace(conn: DatabaseSync, workspaceId: string): void {
    const row = conn
      .prepare("SELECT 1 FROM reading_workspaces WHERE workspace_id = ?")
      .get(workspaceId);
    if (!row) throw new ReadingError(`workspace ${JSON.stringify(workspaceId)} not found`);
  }

  private requireMaterials(conn: DatabaseSync, materialIds: string[]): void {
    if (!materialIds.length) return;
    const placeholders = materialIds.map(() => "?").join(",");
    const found = new Set(
      (conn
        .prepare(`SELECT material_id FROM reading_materials WHERE material_id IN (${placeholders})`)
        .all(...(materialIds as never[])) as Row[]).map((r) => String(r.material_id)),
    );
    const missing = materialIds.filter((id) => !found.has(id));
    if (missing.length) {
      throw new ReadingError(`unknown reading materials: ${missing.join(", ")}`);
    }
  }
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export { materialToDict as _materialToDict, workspaceToDict, sessionToDict };
export const _catalogSchemaReady = SCHEMA.length > 0;
