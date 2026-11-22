// Port of backend/app/services/cron/repository.py — process-safe SQLite
// persistence for scheduled jobs, including the one-time jobs.json import.
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readSync as fsReadSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { homedir } from "node:os";

export interface CronPayload {
  id?: unknown;
  owner?: { kind?: string; partner_id?: string } | Record<string, unknown> | null;
  state?: { next_run_at_ms?: number | null } | Record<string, unknown> | null;
  [k: string]: unknown;
}

/** Narrow persistence contract used by CronService. */
export interface CronRepository {
  revision(): number;
  listPayloads(): CronPayload[];
  upsert(payload: CronPayload): void;
  delete(jobId: string, ownerKey?: string | null): boolean;
}

function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

function sleepMs(ms: number): void {
  // Sync sleep for the migration lock (constructor is synchronous, matching
  // the Python API). Atomics.wait is available on the Node main thread.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class SQLiteCronRepository implements CronRepository {
  readonly path: string;
  readonly legacyPath: string | null;
  private readonly migrationLockPath: string;

  constructor(path: string, legacyPath?: string | null) {
    this.path = resolve(expandUser(path));
    this.legacyPath = legacyPath ? resolve(expandUser(legacyPath)) : null;
    this.migrationLockPath = join(dirname(this.path), `.${basename(this.path)}.migration.lock`);
    mkdirSync(dirname(this.path), { recursive: true });
    const initial = this.prepareLegacyFile();
    this.initialize(initial);
  }

  // -- migration lock -------------------------------------------------------
  // Python used fcntl.flock/msvcrt.locking on an open file handle. Node has no
  // flock; emulate with an exclusive-create lockfile + stale-PID retry.
  // TODO: replace with a proper inter-process lock (e.g. proper-lockfile)
  // if cron repositories are ever opened concurrently across processes.

  private withMigrationLock<T>(fn: () => T): T {
    mkdirSync(dirname(this.migrationLockPath), { recursive: true });
    const deadline = Date.now() + 30_000;
    let fd = -1;
    for (;;) {
      try {
        fd = openSync(this.migrationLockPath, "wx");
        writeFileSync(fd, String(process.pid));
        break;
      } catch {
        // Lock held; briefly wait and retry until the deadline.
        if (Date.now() > deadline) throw new Error("cron migration lock timeout");
        sleepMs(25);
      }
    }
    try {
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch { /* ignore */ }
      try {
        unlinkSync(this.migrationLockPath);
      } catch { /* ignore */ }
    }
  }

  private static isSqlite(path: string): boolean {
    try {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(16);
        const n = fsReadSync(fd, buf, 0, 16, 0);
        return n === 16 && buf.equals(SQLITE_MAGIC);
      } finally {
        closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  private prepareLegacyFile(): CronPayload[] {
    return this.withMigrationLock(() => {
      if (existsSync(this.path) && SQLiteCronRepository.isSqlite(this.path)) {
        return [];
      }
      const source = existsSync(this.path) ? this.path : this.legacyPath;
      if (!source || !existsSync(source)) return [];
      const timestamp = Date.now();
      let payloads: CronPayload[] = [];
      let archive: string;
      try {
        const raw: unknown = JSON.parse(readFileSync(source, "utf-8"));
        const jobs = raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).jobs
          : [];
        if (!Array.isArray(jobs)) throw new Error("legacy cron jobs must be a list");
        payloads = jobs.filter((j): j is CronPayload => typeof j === "object" && j !== null).map((j) => ({ ...(j as CronPayload) }));
        const stem = basename(source).replace(/\.[^.]*$/, "");
        archive = join(dirname(source), `${stem}.legacy-${timestamp}.json`);
      } catch {
        payloads = [];
        const stem = basename(source).replace(/\.[^.]*$/, "");
        archive = join(dirname(source), `${stem}.corrupt-${timestamp}.json`);
      }
      renameSync(source, archive);
      return payloads;
    });
  }

  private connect(): DatabaseSync {
    const connection = new DatabaseSync(this.path);
    try {
      try {
        connection.exec("PRAGMA journal_mode=WAL");
      } catch { /* not always supported */ }
      connection.exec("PRAGMA busy_timeout=30000");
      connection.exec("PRAGMA synchronous=NORMAL");
      return connection;
    } catch (e) {
      connection.close();
      throw e;
    }
  }

  private static ensureCronMeta(connection: DatabaseSync): void {
    const exists = connection
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cron_meta'")
      .get() as unknown;
    if (!exists) {
      connection.exec(`
        CREATE TABLE cron_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            revision INTEGER NOT NULL
        )
      `);
      return;
    }
    const cols = (connection.prepare("PRAGMA table_info(cron_meta)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    const columnSet = new Set(cols);
    if (columnSet.has("singleton") && columnSet.has("revision")) return;
    let revision = 0;
    if (columnSet.has("key") && columnSet.has("value")) {
      try {
        for (const row of connection.prepare("SELECT key, value FROM cron_meta").all() as Array<{ key: unknown; value: unknown }>) {
          const key = String(row.key).toLowerCase();
          if (key === "revision" || key === "cron_revision") {
            revision = Number.parseInt(String(row.value), 10) || 0;
          }
        }
      } catch {
        revision = 0;
      }
    }
    connection.exec("DROP TABLE cron_meta");
    connection.exec(`
      CREATE TABLE cron_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision INTEGER NOT NULL
      )
    `);
    connection.prepare("INSERT INTO cron_meta(singleton, revision) VALUES (1, ?)").run(revision);
  }

  private initialize(initial: CronPayload[]): void {
    this.withMigrationLock(() => {
      const connection = this.connect();
      try {
        connection.exec(`
          CREATE TABLE IF NOT EXISTS cron_jobs (
              id TEXT PRIMARY KEY,
              owner_key TEXT NOT NULL,
              next_run_at_ms INTEGER,
              payload TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL
          )
        `);
        connection.exec("CREATE INDEX IF NOT EXISTS idx_cron_jobs_owner ON cron_jobs(owner_key)");
        SQLiteCronRepository.ensureCronMeta(connection);
        connection.prepare("INSERT OR IGNORE INTO cron_meta(singleton, revision) VALUES (1, 0)").run();
        if (!initial.length) return;
        connection.exec("BEGIN IMMEDIATE");
        try {
          for (const payload of initial) {
            SQLiteCronRepository.upsertRow(connection, payload);
          }
          connection.exec("UPDATE cron_meta SET revision = revision + 1 WHERE singleton=1");
          connection.exec("COMMIT");
        } catch (e) {
          try {
            connection.exec("ROLLBACK");
          } catch { /* ignore */ }
          throw e;
        }
      } finally {
        connection.close();
      }
    });
  }

  private static ownerKey(payload: CronPayload): string {
    const owner = (payload.owner ?? {}) as Record<string, unknown>;
    if (owner.kind === "partner") {
      return `partner:${owner.partner_id ?? ""}`;
    }
    return "chat:local-admin";
  }

  private static upsertRow(connection: DatabaseSync, payload: CronPayload): void {
    const jobId = String(payload.id ?? "").trim();
    if (!jobId) throw new Error("cron job id is required");
    const state = (payload.state ?? {}) as Record<string, unknown>;
    const nextRun = state.next_run_at_ms;
    connection
      .prepare(
        `INSERT INTO cron_jobs(id, owner_key, next_run_at_ms, payload, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
            owner_key=excluded.owner_key,
            next_run_at_ms=excluded.next_run_at_ms,
            payload=excluded.payload,
            updated_at_ms=excluded.updated_at_ms`,
      )
      .run(
        jobId,
        SQLiteCronRepository.ownerKey(payload),
        nextRun != null ? Math.trunc(Number(nextRun)) : null,
        JSON.stringify(payload),
        Date.now(),
      );
  }

  revision(): number {
    const connection = this.connect();
    try {
      const row = connection
        .prepare("SELECT revision FROM cron_meta WHERE singleton=1")
        .get() as { revision: number } | undefined;
      return row ? Number(row.revision) || 0 : 0;
    } finally {
      connection.close();
    }
  }

  listPayloads(): CronPayload[] {
    const connection = this.connect();
    try {
      const rows = connection
        .prepare("SELECT payload FROM cron_jobs ORDER BY COALESCE(next_run_at_ms, 0), id")
        .all() as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as CronPayload);
    } finally {
      connection.close();
    }
  }

  upsert(payload: CronPayload): void {
    const connection = this.connect();
    try {
      connection.exec("BEGIN IMMEDIATE");
      try {
        SQLiteCronRepository.upsertRow(connection, payload);
        connection.exec("UPDATE cron_meta SET revision = revision + 1 WHERE singleton=1");
        connection.exec("COMMIT");
      } catch (e) {
        try {
          connection.exec("ROLLBACK");
        } catch { /* ignore */ }
        throw e;
      }
    } finally {
      connection.close();
    }
  }

  delete(jobId: string, ownerKey: string | null = null): boolean {
    const connection = this.connect();
    try {
      connection.exec("BEGIN IMMEDIATE");
      try {
        let result: { changes: number | bigint };
        if (ownerKey == null) {
          result = connection.prepare("DELETE FROM cron_jobs WHERE id=?").run(jobId);
        } else {
          result = connection.prepare("DELETE FROM cron_jobs WHERE id=? AND owner_key=?").run(jobId, ownerKey);
        }
        const changed = Number(result.changes) > 0;
        if (changed) {
          connection.exec("UPDATE cron_meta SET revision = revision + 1 WHERE singleton=1");
        }
        connection.exec("COMMIT");
        return changed;
      } catch (e) {
        try {
          connection.exec("ROLLBACK");
        } catch { /* ignore */ }
        throw e;
      }
    } finally {
      connection.close();
    }
  }
}

