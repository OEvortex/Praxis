// Thin wrapper over node:sqlite shared storage helpers.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { get_settings } from "../config.js";

let db: DatabaseSync | null = null;

// Explicit override wins (PRAXIS_DB), otherwise the canonical settings DB.
function _dbPath(): string {
  const override = (process.env.PRAXIS_DB ?? "").trim();
  return override || get_settings().sessions_db;
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const path = _dbPath();
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

export function query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...(params as never[])) as T[];
}

export function queryOne<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
  const r = getDb().prepare(sql).run(...(params as never[]));
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
}

export function tx<T>(fn: () => T): T {
  getDb().exec("BEGIN");
  try {
    const out = fn();
    getDb().exec("COMMIT");
    return out;
  } catch (e) {
    getDb().exec("ROLLBACK");
    throw e;
  }
}
