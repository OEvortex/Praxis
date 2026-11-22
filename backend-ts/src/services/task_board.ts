// one account store of task cards
// in SQLite, read as per-workspace boards with conversation links.
// Backed by its own database file: <data_dir>/task-board/tasks.sqlite.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { get_settings } from "../config.js";

export type TaskStatus = "todo" | "doing" | "done";

export interface StatusColors { todo: string; doing: string; done: string }
export interface TaskCard {
  id: string; title: string; note: string; status: TaskStatus;
  archived: boolean; created_at: string; updated_at: string;
  workspace_id?: string | null; due_date?: string | null;
}
export interface SessionTaskLinks {
  workspace_id: string; session_id: string;
  task_ids: string[]; status_link_enabled: boolean;
}
export interface TaskBoard {
  cards: TaskCard[]; colors: StatusColors;
  session_links: SessionTaskLinks[]; revision: number;
}

const DEFAULT_COLORS: StatusColors = { todo: "#2563eb", doing: "#a16207", done: "#15803d" };

let _db: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (_db) return _db;
  const path = join(get_settings().data_dir, "task-board", "tasks.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  _db = new DatabaseSync(path);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('todo','doing','done')),
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, workspace_id TEXT,
      due_date TEXT
    );
    CREATE TABLE IF NOT EXISTS board_state (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, colors TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_task_status (
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(workspace_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS session_tasks (
      association_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES cards(id),
      UNIQUE(workspace_id, session_id, task_id)
    );
  `);
  for (const column of ["workspace_id", "due_date"]) {
    const cols = (_db.prepare(`PRAGMA table_info(cards)`).all() as { name: string }[]).map((r) => r.name);
    if (!cols.includes(column)) {
      try { _db.exec(`ALTER TABLE cards ADD COLUMN ${column} TEXT`); } catch { /* raced */ }
    }
  }
  _db.prepare("INSERT OR IGNORE INTO board_state (id, revision, colors) VALUES (1, 0, ?)").run(JSON.stringify(DEFAULT_COLORS));
  return _db;
}

function nowIso(): string {
  return new Date().toISOString();
}

function snapshot(conn: DatabaseSync): TaskBoard {
  const cardRows = conn.prepare("SELECT * FROM cards ORDER BY created_at, id").all() as Record<string, unknown>[];
  const cards: TaskCard[] = cardRows.map((r) => ({
    id: String(r.id), title: String(r.title), note: String(r.note ?? ""),
    status: String(r.status) as TaskStatus,
    archived: !!Number(r.archived),
    created_at: String(r.created_at), updated_at: String(r.updated_at),
    workspace_id: (r.workspace_id as string) ?? null,
    due_date: (r.due_date as string) ?? null,
  }));
  const linkRows = conn.prepare(
    `SELECT t.workspace_id, t.session_id, t.task_id, s.enabled
     FROM session_tasks t
     LEFT JOIN session_task_status s ON s.workspace_id = t.workspace_id AND s.session_id = t.session_id
     ORDER BY t.association_id`,
  ).all() as Record<string, unknown>[];
  const links = new Map<string, SessionTaskLinks>();
  for (const row of linkRows) {
    const key = `${row.workspace_id}${row.session_id}`;
    let link = links.get(key);
    if (!link) {
      link = {
        workspace_id: String(row.workspace_id),
        session_id: String(row.session_id),
        task_ids: [],
        status_link_enabled: row.enabled == null ? true : !!Number(row.enabled),
      };
      links.set(key, link);
    }
    link.task_ids.push(String(row.task_id));
  }
  const state = conn.prepare("SELECT * FROM board_state WHERE id=1").get() as Record<string, unknown> | undefined;
  let colors = DEFAULT_COLORS;
  try { colors = { ...DEFAULT_COLORS, ...(JSON.parse(String(state?.colors ?? "{}")) as Partial<StatusColors>) }; } catch { /* ignore */ }
  return { cards, colors, session_links: [...links.values()], revision: Number(state?.revision ?? 0) };
}

function changed(conn: DatabaseSync): void {
  conn.prepare("UPDATE board_state SET revision = revision + 1 WHERE id = 1").run();
}

export function boardRevision(): number {
  try {
    const row = db().prepare("SELECT revision FROM board_state WHERE id=1").get() as { revision: number } | undefined;
    return row ? Number(row.revision) : 0;
  } catch {
    return 0;
  }
}

export function readBoard(): TaskBoard {
  const conn = db();
  conn.exec("BEGIN");
  try {
    const out = snapshot(conn);
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

export function workspaceBoard(board: TaskBoard, workspaceId: string): TaskBoard {
  const cards = board.cards.filter((c) => (c.workspace_id || "") === workspaceId);
  const cardIds = new Set(cards.map((c) => c.id));
  return {
    ...board,
    cards,
    session_links: board.session_links
      .filter((l) => l.workspace_id === workspaceId)
      .map((l) => ({ ...l, task_ids: l.task_ids.filter((id) => cardIds.has(id)) })),
  };
}

export function createCard(payload: { title: string; note?: string; due_date?: string | null }, workspaceId: string | null): TaskBoard {
  const conn = db();
  const now = nowIso();
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.prepare(
      "INSERT INTO cards (id,title,note,status,archived,created_at,updated_at,workspace_id,due_date) VALUES (?,?,?,'todo',0,?,?,?,?)",
    ).run(randomUUID().replace(/-/g, ""), payload.title, payload.note ?? "", now, now, workspaceId, payload.due_date ?? null);
    changed(conn);
    const out = snapshot(conn);
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

export function updateCard(cardId: string, changes: Record<string, unknown>, workspaceId = ""): TaskBoard {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const row = conn.prepare("SELECT * FROM cards WHERE id=?").get(cardId) as Record<string, unknown> | undefined;
    if (!row || String(row.workspace_id ?? "") !== workspaceId) {
      throw new Error(`KeyError:${cardId}`);
    }
    const merged: Record<string, unknown> = { ...row, ...changes };
    conn.prepare(
      "UPDATE cards SET title=?,note=?,status=?,archived=?,workspace_id=?,due_date=?,updated_at=? WHERE id=?",
    ).run(
      String(merged.title), String(merged.note ?? ""), String(merged.status),
      merged.archived ? 1 : 0, (merged.workspace_id as string) ?? null,
      (merged.due_date as string) ?? null, nowIso(), cardId,
    );
    conn.prepare("DELETE FROM session_tasks WHERE task_id=? AND workspace_id!=?")
      .run(cardId, String(merged.workspace_id ?? ""));
    changed(conn);
    const out = snapshot(conn);
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

export function setColors(colors: StatusColors): TaskBoard {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.prepare("UPDATE board_state SET colors=? WHERE id=1").run(JSON.stringify(colors));
    changed(conn);
    const out = snapshot(conn);
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

export function linkTasks(sessionId: string, workspaceId: string, taskIds: string[]): TaskBoard {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const existing = new Set(
      (conn.prepare("SELECT task_id FROM session_tasks WHERE workspace_id=? AND session_id=?")
        .all(workspaceId, sessionId) as { task_id: string }[]).map((r) => r.task_id),
    );
    for (const taskId of taskIds) {
      const row = conn.prepare("SELECT archived, workspace_id FROM cards WHERE id=?").get(taskId) as
        | Record<string, unknown> | undefined;
      if (!row || String(row.workspace_id ?? "") !== workspaceId || (Number(row.archived) && !existing.has(taskId))) {
        throw new Error(`KeyError:${taskId}`);
      }
    }
    for (const taskId of existing) {
      if (!taskIds.includes(taskId)) {
        conn.prepare("DELETE FROM session_tasks WHERE workspace_id=? AND session_id=? AND task_id=?")
          .run(workspaceId, sessionId, taskId);
      }
    }
    for (const taskId of taskIds) {
      if (!existing.has(taskId)) {
        conn.prepare("INSERT INTO session_tasks (workspace_id,session_id,task_id) VALUES (?,?,?)")
          .run(workspaceId, sessionId, taskId);
      }
    }
    const added = taskIds.some((id) => !existing.has(id));
    if (added) {
      conn.prepare(
        `INSERT INTO session_task_status VALUES (?,?,1)
         ON CONFLICT(workspace_id,session_id) DO UPDATE SET enabled=1`,
      ).run(workspaceId, sessionId);
    }
    changed(conn);
    const out = snapshot(conn);
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

export function linkStatus(sessionId: string, workspaceId: string, enabled: boolean): TaskBoard {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.prepare(
      `INSERT INTO session_task_status VALUES (?,?,?)
       ON CONFLICT(workspace_id,session_id) DO UPDATE SET enabled=excluded.enabled`,
    ).run(workspaceId, sessionId, enabled ? 1 : 0);
    changed(conn);
    const out = snapshot(conn);
    conn.exec("COMMIT");
    return out;
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}
