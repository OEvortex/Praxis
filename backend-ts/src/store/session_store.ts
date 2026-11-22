// SQLite-backed session index.
//
// Sessions live in one WAL-mode SQLite database (``data/praxis.sqlite3``):
//
// * ``sessions`` — record-level fields (title, status, preferences, the vtx
//   header/entries).
// * ``messages`` / ``turns`` — the UI-facing rows: chat messages with their
//   streamed events, and per-turn event logs used for WS replay after reconnects.
// * ``vtx_items`` — legacy raw input-item dicts kept for old session records.
// * ``session_fts`` — an FTS5 index over message text used by the REST search
//   endpoint.
//
// Legacy ``data/sessions/*.json`` records are imported on first open and moved to
// ``data/sessions-legacy/``; the files are not read after that.

import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Settings } from "../config.js";
import * as database from "./database.js";

export type SessionDict = Record<string, any>;

// Sentinel for ``append_user_message``: the wire may omit ``parent_message_id``
// entirely, which means "continue from the latest persisted row" rather than
// the explicit root edit signalled by ``null``.
export const AUTO_PARENT_MESSAGE: unique symbol = Symbol("AUTO_PARENT_MESSAGE");

// excluding underscore. JS ``\w`` is ASCII-only, so use unicode property
// escapes for a close semantic match.
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

const INITIALIZED = new Set<string>();

function now(): number {
  return Date.now() / 1000;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function dumps(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v === undefined ? null : typeof v === "bigint" ? v.toString() : v,
  );
}

function loads(raw: unknown, fallback: unknown): any {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return fallback;
  }
}

const EMPTY_SESSION: SessionDict = {
  id: "",
  title: "",
  created_at: 0.0,
  updated_at: 0.0,
  status: "idle",
  preferences: {},
  messages: [],
  turns: {},
  vtx_items: [],
  next_message_id: 1,
  last_input: null,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'idle',
    preferences TEXT NOT NULL DEFAULT '{}',
    next_message_id INTEGER NOT NULL DEFAULT 1,
    last_input TEXT,
    title_auto INTEGER NOT NULL DEFAULT 0,
    last_output TEXT NOT NULL DEFAULT '',
    page_id TEXT NOT NULL DEFAULT '',
    vtx_header TEXT,
    vtx_entries TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_page ON sessions(page_id);

CREATE TABLE IF NOT EXISTS messages (
    session_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    capability TEXT,
    events TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL DEFAULT 0,
    parent_message_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

CREATE TABLE IF NOT EXISTS turns (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'running',
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL DEFAULT 0,
    finished_at REAL,
    PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);

CREATE TABLE IF NOT EXISTS vtx_items (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    item TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_vtx_items_session ON vtx_items(session_id, seq);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
    session_id UNINDEXED,
    message_id UNINDEXED,
    role UNINDEXED,
    title,
    content,
    tokenize = 'porter unicode61'
);
`;

// sqlite3 module would have produced (None -> NULL, bool -> 0/1).
function normParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

function execSql(db: DatabaseSync, sql: string, params: unknown[] = []): void {
  db.prepare(sql).run(...(params.map(normParam) as never[]));
}

function allSql(db: DatabaseSync, sql: string, params: unknown[] = []): any[] {
  return db.prepare(sql).all(...(params.map(normParam) as never[])) as any[];
}

function oneSql(db: DatabaseSync, sql: string, params: unknown[] = []): any {
  return db.prepare(sql).get(...(params.map(normParam) as never[]));
}

export class SessionStore {
  /** SQLite-backed session index shared by the API, runtime and agent tools. */
  private readonly _settings: Settings;
  private readonly _dbPath: string;
  private readonly _sessionsDir: string;
  private _fts = true;
  private _lastTotal = 0;

  constructor(settings: Settings) {
    this._settings = settings;
    mkdirSync(settings.data_dir, { recursive: true });
    this._dbPath = settings.sessions_db;
    this._sessionsDir = settings.sessions_dir;
    // Tools construct a store per call (session search, calendar layers).
    // Schema creation and the one-shot JSON import only need to run once
    // per database per process. (JS is single-threaded and the constructor is
    if (INITIALIZED.has(this._dbPath) && existsSync(this._dbPath)) {
      return;
    }
    this._bootLock(() => {
      // The data directory can be removed while the server is running
      // (reset, container remount, user cleanup); a missing database is
      // rebuilt on the next store access.
      if (!INITIALIZED.has(this._dbPath) || !existsSync(this._dbPath)) {
        this._initialize();
        this._migrateLegacyJson();
        INITIALIZED.add(this._dbPath);
      }
    });
  }

  // -- connection / schema ----------------------------------------------

  // Mirrors ``database.connect``: a fresh connection per operation
  // with WAL and sane concurrency defaults.
  private _connect<T>(fn: (db: DatabaseSync) => T): T {
    const db = database.connect(this._settings);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  private _initialize(): void {
    // The database module owns the shared schema and the one-shot import of
    // pre-SQLite stores; session tables are added on top of it.
    database.ensure_schema(this._settings);
    this._connect((db) => {
      // exec manages its own transaction; the schema is
      // idempotent, so a retry after a crash is always safe.
      db.exec(SCHEMA);
      SessionStore._migrateMessagesTable(db);
      try {
        db.exec(FTS_SCHEMA);
      } catch {
        // Some SQLite builds omit FTS5. Search degrades to LIKE.
        this._fts = false;
      }
    });
  }

  private static _migrateMessagesTable(db: DatabaseSync): void {
    /** Drop the old unique (session_id, id) constraint.

     * Legacy transcripts can contain duplicate message ids (they are repaired
     * on read), so storage must accept them rather than reject the save.
     */
    const row = oneSql(
      db,
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
    );
    if (row === undefined || !String(row.sql ?? "").includes("PRIMARY KEY")) {
      return;
    }
    execSql(db, "BEGIN IMMEDIATE");
    try {
      // The old index keeps its name across the rename, which would make
      // CREATE INDEX below a no-op and leave the new table unindexed.
      const statements = [
        "DROP TABLE IF EXISTS messages_old",
        "DROP INDEX IF EXISTS idx_messages_session",
        "ALTER TABLE messages RENAME TO messages_old",
        `
        CREATE TABLE messages (
            session_id TEXT NOT NULL,
            id INTEGER NOT NULL,
            role TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            capability TEXT,
            events TEXT NOT NULL DEFAULT '[]',
            attachments TEXT NOT NULL DEFAULT '[]',
            metadata TEXT NOT NULL DEFAULT '{}',
            created_at REAL NOT NULL DEFAULT 0,
            parent_message_id INTEGER
        )
        `,
        "INSERT INTO messages SELECT * FROM messages_old",
        "DROP TABLE messages_old",
        "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id)",
      ];
      for (const statement of statements) {
        execSql(db, statement);
      }
      execSql(db, "COMMIT");
    } catch (e) {
      execSql(db, "ROLLBACK");
      throw e;
    }
  }

  // TODO(port): The original used a `.boot.lock` file for cross-process boot locking.
  // Node has no flock builtin in the standard library; the critical section is
  // synchronous so it is already serialised within one process, and the lock
  // file is still created/appended for parity and future cross-process use.
  private _bootLock<T>(fn: () => T): T {
    const lockPath = join(
      dirname(this._dbPath),
      `.${basename(this._dbPath)}.boot.lock`,
    );
    mkdirSync(dirname(lockPath), { recursive: true });
    const fd = openSync(lockPath, "a");
    try {
      if (statSync(lockPath).size === 0) {
        writeSync(fd, Buffer.from("\0"));
      }
      return fn();
    } finally {
      closeSync(fd);
    }
  }

  private _migrateLegacyJson(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this._sessionsDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(this._sessionsDir, name));
    } catch {
      return;
    }
    if (files.length === 0) return;
    const archive = join(this._settings.data_dir, "sessions-legacy");
    mkdirSync(archive, { recursive: true });
    for (const path of files) {
      let record: unknown;
      try {
        record = JSON.parse(readFileSync(path, "utf-8"));
      } catch {
        continue;
      }
      if (
        record === null ||
        typeof record !== "object" ||
        !(record as SessionDict).id
      ) {
        continue;
      }
      const sessionId = String((record as SessionDict).id);
      const exists = this._connect((db) =>
        oneSql(db, "SELECT 1 FROM sessions WHERE id = ?", [sessionId]),
      );
      if (!exists) {
        try {
          // ``_write`` (not ``save``) keeps the original updated_at,
          // so imported history keeps its place in the sidebar.
          this._write(record as SessionDict);
        } catch {
          // a bad row must not block boot
          continue;
        }
      }
      try {
        renameSync(path, join(archive, basename(path)));
      } catch {
        // ignore
      }
    }
  }

  // -- row encoding ------------------------------------------------------

  private static _encodeMessage(message: SessionDict): unknown[] {
    return [
      String(message.session_id ?? ""),
      Number(message.id ?? 0),
      String(message.role ?? ""),
      String(message.content ?? ""),
      message.capability ?? null,
      dumps(message.events ?? []),
      dumps(message.attachments ?? []),
      dumps(message.metadata ?? {}),
      Number(message.created_at ?? 0),
      message.parent_message_id ?? null,
    ];
  }

  private static _decodeMessage(row: SessionDict): SessionDict {
    return {
      id: row.id,
      session_id: row.session_id,
      role: row.role,
      content: row.content,
      capability: row.capability,
      events: loads(row.events, []),
      attachments: loads(row.attachments, []),
      metadata: loads(row.metadata, {}),
      created_at: row.created_at,
      parent_message_id: row.parent_message_id,
    };
  }

  private static _pageId(session: SessionDict): string {
    const preferences = session.preferences;
    if (preferences === null || typeof preferences !== "object") return "";
    return String(preferences.note_document_id ?? "");
  }

  private _writeRows(db: DatabaseSync, session: SessionDict): void {
    const sessionId = String(session.id);
    execSql(
      db,
      `
      INSERT INTO sessions (
          id, title, created_at, updated_at, status, preferences,
          next_message_id, last_input, title_auto, last_output, page_id,
          vtx_header, vtx_entries
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          status = excluded.status,
          preferences = excluded.preferences,
          next_message_id = excluded.next_message_id,
          last_input = excluded.last_input,
          title_auto = excluded.title_auto,
          last_output = excluded.last_output,
          page_id = excluded.page_id,
          vtx_header = excluded.vtx_header,
          vtx_entries = excluded.vtx_entries
      `,
      [
        sessionId,
        String(session.title ?? ""),
        Number(session.created_at ?? 0),
        Number(session.updated_at ?? 0),
        String(session.status ?? "idle"),
        dumps(session.preferences ?? {}),
        Number(session.next_message_id ?? 1),
        session.last_input === null || session.last_input === undefined
          ? null
          : dumps(session.last_input),
        session.title_auto ? 1 : 0,
        String(session.last_output ?? ""),
        SessionStore._pageId(session),
        session.vtx_header === null || session.vtx_header === undefined
          ? null
          : dumps(session.vtx_header),
        dumps(session.vtx_entries ?? []),
      ],
    );

    for (const table of ["messages", "turns", "vtx_items"]) {
      execSql(db, `DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
    }
    if (this._fts) {
      execSql(db, "DELETE FROM session_fts WHERE session_id = ?", [sessionId]);
    }

    const title = String(session.title ?? "");
    const messages = (session.messages ?? []).filter(
      (m: unknown) => m !== null && typeof m === "object",
    ) as SessionDict[];
    for (const message of messages) {
      // The record owns its rows; a stale ``session_id`` left on a dict
      // copied between records must never orphan the row.
      message.session_id = sessionId;
      execSql(
        db,
        `
        INSERT INTO messages (
            session_id, id, role, content, capability, events,
            attachments, metadata, created_at, parent_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        SessionStore._encodeMessage(message),
      );
      if (
        this._fts &&
        ["user", "assistant"].includes(message.role) &&
        String(message.content ?? "").trim()
      ) {
        execSql(
          db,
          `
          INSERT INTO session_fts (session_id, message_id, role, title, content)
          VALUES (?, ?, ?, ?, ?)
          `,
          [
            sessionId,
            Number(message.id ?? 0),
            String(message.role ?? ""),
            title,
            String(message.content ?? ""),
          ],
        );
      }
    }

    const turns = session.turns ?? {};
    if (turns !== null && typeof turns === "object" && !Array.isArray(turns)) {
      for (const [turnId, turn] of Object.entries(turns as SessionDict)) {
        if (turn === null || typeof turn !== "object") continue;
        const t = turn as SessionDict;
        execSql(
          db,
          `
          INSERT INTO turns (
              session_id, turn_id, events, status, last_seq,
              created_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [
            sessionId,
            String(turnId),
            dumps(t.events ?? []),
            String(t.status ?? "running"),
            Number(t.last_seq ?? 0),
            Number(t.created_at ?? 0),
            t.finished_at ?? null,
          ],
        );
      }
    }

    const vtxItems = session.vtx_items ?? [];
    (vtxItems as unknown[]).forEach((item, seq) => {
      execSql(
        db,
        "INSERT INTO vtx_items (session_id, seq, item) VALUES (?, ?, ?)",
        [sessionId, seq, dumps(item)],
      );
    });
  }

  // -- CRUD -------------------------------------------------------------

  create(preferences?: SessionDict | null): SessionDict {
    const session: SessionDict = JSON.parse(JSON.stringify(EMPTY_SESSION));
    session.id = newId("sess");
    session.created_at = session.updated_at = now();
    session.preferences = { ...(preferences ?? {}) };
    this._write(session);
    return session;
  }

  get(sessionId: string): SessionDict | null {
    const sid = String(sessionId);
    return this._connect((db) => {
      const row = oneSql(db, "SELECT * FROM sessions WHERE id = ?", [sid]);
      if (row === undefined) return null;
      const messages = allSql(
        db,
        "SELECT * FROM messages WHERE session_id = ? ORDER BY rowid",
        [sid],
      ).map((item) => SessionStore._decodeMessage(item));
      const turns: SessionDict = {};
      for (const turn of allSql(
        db,
        "SELECT * FROM turns WHERE session_id = ?",
        [sid],
      )) {
        turns[String(turn.turn_id)] = {
          events: loads(turn.events, []),
          status: turn.status,
          last_seq: turn.last_seq,
          created_at: turn.created_at,
          finished_at: turn.finished_at,
        };
      }
      const vtxItems = allSql(
        db,
        "SELECT item FROM vtx_items WHERE session_id = ? ORDER BY seq",
        [sid],
      ).map((item) => loads(item.item, {}));
      const session: SessionDict = {
        id: row.id,
        title: row.title,
        created_at: row.created_at,
        updated_at: row.updated_at,
        status: row.status,
        preferences: loads(row.preferences, {}),
        messages,
        turns,
        vtx_items: vtxItems,
        next_message_id: row.next_message_id,
        last_input: loads(row.last_input, null),
        title_auto: Boolean(row.title_auto),
        last_output: row.last_output,
        vtx_header: loads(row.vtx_header, null),
        vtx_entries: loads(row.vtx_entries, []),
      };
      this._repairLegacyMessageTree(session);
      return session;
    });
  }

  private static _resolveParentMessageId(
    session: SessionDict,
    parentMessageId: unknown,
  ): number | null {
    const messages = (session.messages ?? []) as SessionDict[];
    const latestId = messages.length
      ? (messages[messages.length - 1].id ?? null)
      : null;
    if (parentMessageId === AUTO_PARENT_MESSAGE) {
      return latestId;
    }
    if (parentMessageId === null || parentMessageId === undefined) {
      return null;
    }
    if (
      typeof parentMessageId === "number" &&
      Number.isInteger(parentMessageId) &&
      parentMessageId > 0 &&
      messages.some((m) => m.id === parentMessageId)
    ) {
      return parentMessageId;
    }
    return latestId;
  }

  /** Rebuild parent links for sessions written before branching existed.

   * Legacy rows all carry ``parent_message_id: null``, which the web client
   * interprets as competing root branches and collapses to a single visible
   * message. A leading run of null-parent rows is therefore a flat
   * transcript: chain it in storage order. Later null rows are left alone —
   * they can be legitimate root siblings created by editing the first
   * message.
   */
  private _repairLegacyMessageTree(session: SessionDict): boolean {
    const messages = session.messages;
    if (!Array.isArray(messages) || messages.length < 2) return false;
    if (
      !messages.every(
        (m) => m !== null && typeof m === "object" && !Array.isArray(m),
      )
    ) {
      return false;
    }

    let changed = false;
    const oldIds = messages.map((m: SessionDict) => m.id);
    const idValues = oldIds.filter(
      (v) => typeof v === "number" && Number.isInteger(v),
    ) as number[];
    const needsReid =
      idValues.length !== oldIds.length ||
      new Set(idValues).size !== idValues.length ||
      idValues.some((v) => v <= 0);
    if (needsReid) {
      const oldToLatest = new Map<unknown, number>();
      oldIds.forEach((oldId, index) => {
        if (oldId !== null && oldId !== undefined) {
          oldToLatest.set(oldId, index + 1);
        }
      });
      messages.forEach((message: SessionDict, index: number) => {
        message.id = index + 1;
      });
      messages.forEach((message: SessionDict, index: number) => {
        const parent = message.parent_message_id;
        if (parent === null || parent === undefined) return;
        let newParent: number | null = null;
        for (let candidate = index - 1; candidate >= 0; candidate--) {
          if (oldIds[candidate] === parent) {
            newParent = candidate + 1;
            break;
          }
        }
        message.parent_message_id = newParent;
      });
      const preferences = session.preferences;
      const selections =
        preferences !== null && typeof preferences === "object"
          ? (preferences as SessionDict).selected_branches
          : null;
      if (
        preferences !== null &&
        typeof preferences === "object" &&
        selections !== null &&
        typeof selections === "object" &&
        !Array.isArray(selections)
      ) {
        const remapped: SessionDict = {};
        for (const [parentKey, childId] of Object.entries(
          selections as SessionDict,
        )) {
          let newParentKey: string;
          if (parentKey === "null") {
            newParentKey = "null";
          } else {
            const trimmed = parentKey.trim();
            if (!/^[+-]?\d+$/.test(trimmed)) continue; // int() ValueError
            const oldParent = parseInt(trimmed, 10);
            newParentKey = String(oldToLatest.get(oldParent) ?? parentKey);
          }
          const newChild = oldToLatest.get(childId);
          if (newChild !== undefined) {
            remapped[newParentKey] = newChild;
          }
        }
        (preferences as SessionDict).selected_branches = remapped;
      }
      session.next_message_id = messages.length + 1;
      changed = true;
    } else {
      const maxId = Math.max(...idValues);
      if (Number(session.next_message_id ?? 0) <= maxId) {
        session.next_message_id = maxId + 1;
        changed = true;
      }
    }

    // ``first_linked`` is the index of the first message with a parent link,
    // or ``messages.length`` when the whole session is flat. ``legacy_run``
    const firstLinkedIndex = messages.findIndex(
      (m: SessionDict) =>
        m.parent_message_id !== null && m.parent_message_id !== undefined,
    );
    const firstLinked = firstLinkedIndex === -1 ? messages.length : firstLinkedIndex;
    const legacyRun = firstLinked;
    if (legacyRun < 2) {
      return changed;
    }

    // Assistant rows always continue a user turn, so a null-parent
    // assistant is unambiguous legacy-flat evidence. A prefix containing
    // only user rows may instead be deliberate root-edit siblings; only
    // collapse it when the entire session is flat.
    const hasFlatAssistant = messages
      .slice(0, legacyRun)
      .some(
        (m: SessionDict) =>
          m.role === "assistant" &&
          (m.parent_message_id === null || m.parent_message_id === undefined),
      );
    if (!hasFlatAssistant && firstLinked !== messages.length) {
      return changed;
    }

    for (let index = 1; index < legacyRun; index++) {
      const expectedParent = messages[index - 1].id;
      if (messages[index].parent_message_id !== expectedParent) {
        messages[index].parent_message_id = expectedParent;
        changed = true;
      }
    }
    return changed;
  }

  save(session: SessionDict): void {
    session.updated_at = now();
    this._write(session);
  }

  private _write(session: SessionDict): void {
    this._connect((db) => {
      execSql(db, "BEGIN IMMEDIATE");
      try {
        this._writeRows(db, session);
        execSql(db, "COMMIT");
      } catch (e) {
        execSql(db, "ROLLBACK");
        throw e;
      }
    });
  }

  delete(sessionId: string): boolean {
    const sid = String(sessionId);
    return this._connect((db) => {
      execSql(db, "BEGIN IMMEDIATE");
      try {
        const exists = oneSql(db, "SELECT 1 FROM sessions WHERE id = ?", [sid]);
        if (exists === undefined) {
          execSql(db, "ROLLBACK");
          return false;
        }
        for (const table of ["messages", "turns", "vtx_items"]) {
          execSql(db, `DELETE FROM ${table} WHERE session_id = ?`, [sid]);
        }
        execSql(db, "DELETE FROM sessions WHERE id = ?", [sid]);
        if (this._fts) {
          execSql(db, "DELETE FROM session_fts WHERE session_id = ?", [sid]);
        }
        execSql(db, "COMMIT");
        return true;
      } catch (e) {
        execSql(db, "ROLLBACK");
        throw e;
      }
    });
  }

  /** Every stored session, newest first. */
  all(): SessionDict[] {
    const ids = this._connect((db) =>
      allSql(db, "SELECT id FROM sessions ORDER BY updated_at DESC").map((row) =>
        String(row.id),
      ),
    );
    return ids
      .map((sessionId) => this.get(sessionId))
      .filter((s): s is SessionDict => s !== null);
  }

  list(limit = 50, offset = 0): SessionDict[] {
    const ids = this._connect((db) =>
      allSql(
        db,
        "SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?",
        [Math.trunc(limit), Math.trunc(offset)],
      ).map((row) => String(row.id)),
    );
    return ids
      .map((sessionId) => this.get(sessionId))
      .filter((s): s is SessionDict => s !== null);
  }

  // -- search ------------------------------------------------------------

  private static _queryTerms(query: string): string[] {
    const operators = new Set(["and", "or", "not", "near"]);
    return ((query ?? "").match(WORD) ?? [])
      .filter((token) => !operators.has(token.toLowerCase()))
      .slice(0, 24);
  }

  /** Quote user words into an FTS5 prefix query.

   * Bare words would let FTS5 operators (OR, NOT, NEAR) or syntax
   * characters in a learner's question raise ``OperationalError``; quoting
   * every token keeps the query literal.
   */
  private static _ftsQuery(query: string): string {
    return SessionStore._queryTerms(query)
      .map((token) => `"${token}"*`)
      .join(" OR ");
  }

  /** Ranked message hits grouped by session (best hit per session).

   * Uses the FTS5 index when available and falls back to a token LIKE scan.
   */
  search_hits(
    query: string,
    opts: { limit?: number; page_id?: string } = {},
  ): SessionDict[] {
    const { limit: rawLimit = 5, page_id: pageId = "" } = opts;
    const needle = (query ?? "").trim();
    this._lastTotal = 0;
    if (!needle) return [];
    const limit = Math.max(1, Math.min(Math.trunc(rawLimit || 5), 500));
    const raw: SessionDict[] = [];
    const titleRows = this._connect((db) => {
      if (this._fts) {
        const match = SessionStore._ftsQuery(needle);
        if (match) {
          let rows: any[] = [];
          try {
            rows = allSql(
              db,
              `
              SELECT session_fts.session_id AS session_id,
                     session_fts.message_id AS message_id,
                     session_fts.role AS role,
                     session_fts.content AS content,
                     sessions.title AS title,
                     sessions.updated_at AS updated_at,
                     sessions.page_id AS page_id,
                     bm25(session_fts) AS rank
              FROM session_fts
              JOIN sessions ON sessions.id = session_fts.session_id
              WHERE session_fts MATCH ?
                AND (? = '' OR sessions.page_id = ?)
              ORDER BY rank
              LIMIT ?
              `,
              [match, pageId, pageId, Math.max(limit * 8, 40)],
            );
          } catch {
            rows = [];
          }
          for (const row of rows) {
            raw.push({
              session_id: row.session_id,
              message_id: row.message_id,
              role: row.role,
              content: row.content,
              title: row.title,
              updated_at: row.updated_at,
              page_id: row.page_id,
              rank: Number(row.rank),
            });
          }
        }
      }
      if (raw.length === 0) {
        // No FTS5 in this SQLite build (or the index is empty): fall
        // back to a token LIKE scan with the same OR semantics.
        const terms =
          SessionStore._queryTerms(needle).length > 0
            ? SessionStore._queryTerms(needle)
            : [needle];
        const clauses = terms.map(() => "m.content LIKE ?").join(" OR ");
        const rows = allSql(
          db,
          `
          SELECT m.session_id AS session_id, m.id AS message_id,
                 m.role AS role, m.content AS content,
                 s.title AS title, s.updated_at AS updated_at,
                 s.page_id AS page_id
          FROM messages m
          JOIN sessions s ON s.id = m.session_id
          WHERE (${clauses})
            AND (? = '' OR s.page_id = ?)
          ORDER BY s.updated_at DESC, m.id
          LIMIT ?
          `,
          [
            ...terms.map((t) => `%${t}%`),
            pageId,
            pageId,
            Math.max(limit * 8, 40),
          ],
        );
        rows.forEach((row, position) => {
          raw.push({
            session_id: row.session_id,
            message_id: row.message_id,
            role: row.role,
            content: row.content,
            title: row.title,
            updated_at: row.updated_at,
            page_id: row.page_id,
            rank: Number(position),
          });
        });
      }
      // Title-only matches keep the old search behaviour (a session can be
      // found before its first message exists).
      const titleTerms =
        SessionStore._queryTerms(needle).length > 0
          ? SessionStore._queryTerms(needle)
          : [needle];
      const titleClauses = titleTerms.map(() => "title LIKE ?").join(" OR ");
      const titles = allSql(
        db,
        `
        SELECT id AS session_id, title, updated_at, page_id
        FROM sessions
        WHERE (${titleClauses}) AND (? = '' OR page_id = ?)
        ORDER BY updated_at DESC
        LIMIT ?
        `,
        [...titleTerms.map((t) => `%${t}%`), pageId, pageId, limit],
      );
      const total = this._countMatches(db, needle, pageId);
      this._lastTotal = total;
      return { titles, total };
    });

    const seen = new Set<string>();
    const results: SessionDict[] = [];
    for (const hit of raw) {
      if (seen.has(hit.session_id)) continue;
      seen.add(hit.session_id);
      results.push(this._enrichHit(hit, needle));
      if (results.length >= limit) break;
    }
    for (const row of titleRows.titles) {
      if (results.length >= limit) break;
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      results.push({
        session_id: row.session_id,
        title: row.title || "Untitled conversation",
        updated_at: Number(row.updated_at ?? 0),
        page_id: row.page_id || "",
        score: 0.1,
        question: "",
        answer: "",
        excerpt: "",
        message_id: 0,
        role: "",
      });
    }
    return results;
  }

  /** Match count for the most recent :meth:`search_hits` call. */
  last_total(): number {
    return this._lastTotal;
  }

  private _countMatches(db: DatabaseSync, needle: string, pageId: string): number {
    const ids = new Set<string>();
    if (this._fts) {
      const match = SessionStore._ftsQuery(needle);
      if (match) {
        try {
          const rows = allSql(
            db,
            `
            SELECT DISTINCT session_fts.session_id AS session_id
            FROM session_fts
            JOIN sessions ON sessions.id = session_fts.session_id
            WHERE session_fts MATCH ?
              AND (? = '' OR sessions.page_id = ?)
            `,
            [match, pageId, pageId],
          );
          for (const row of rows) ids.add(String(row.session_id));
        } catch {
          // ignore
        }
      }
    }
    if (ids.size === 0) {
      const terms =
        SessionStore._queryTerms(needle).length > 0
          ? SessionStore._queryTerms(needle)
          : [needle];
      const clauses = terms.map(() => "m.content LIKE ?").join(" OR ");
      const rows = allSql(
        db,
        `
        SELECT DISTINCT m.session_id AS session_id
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE (${clauses}) AND (? = '' OR s.page_id = ?)
        `,
        [...terms.map((t) => `%${t}%`), pageId, pageId],
      );
      for (const row of rows) ids.add(String(row.session_id));
    }
    const titleTerms =
      SessionStore._queryTerms(needle).length > 0
        ? SessionStore._queryTerms(needle)
        : [needle];
    const titleClauses = titleTerms.map(() => "title LIKE ?").join(" OR ");
    const rows = allSql(
      db,
      `
      SELECT id AS session_id FROM sessions
      WHERE (${titleClauses}) AND (? = '' OR page_id = ?)
      `,
      [...titleTerms.map((t) => `%${t}%`), pageId, pageId],
    );
    for (const row of rows) ids.add(String(row.session_id));
    return ids.size;
  }

  private _enrichHit(hit: SessionDict, needle: string): SessionDict {
    const session = this.get(hit.session_id) ?? {};
    const messages = ((session.messages ?? []) as SessionDict[]).filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    const index = messages.findIndex((m) => m.id === hit.message_id);
    let question = "";
    let answer = "";
    if (index >= 0) {
      const message = messages[index];
      if (message.role === "user") {
        question = String(message.content ?? "");
        if (
          index + 1 < messages.length &&
          messages[index + 1].role === "assistant"
        ) {
          answer = String(messages[index + 1].content ?? "");
        }
      } else {
        answer = String(message.content ?? "");
        if (index > 0 && messages[index - 1].role === "user") {
          question = String(messages[index - 1].content ?? "");
        }
      }
    }
    const excerpt = SessionStore._snippet(
      (question + "\n" + answer).trim() || String(hit.content ?? ""),
      needle,
    );
    return {
      session_id: hit.session_id,
      title: hit.title || "Untitled conversation",
      updated_at: Number(hit.updated_at ?? session.updated_at ?? 0),
      page_id: hit.page_id || "",
      score: Math.round(-Number(hit.rank ?? 0.0) * 10000) / 10000,
      question: question ? SessionStore._snippet(question, needle) : "",
      answer: answer ? SessionStore._snippet(answer, needle, 900) : "",
      excerpt,
      message_id: hit.message_id,
      role: hit.role,
    };
  }

  private static _snippet(text: string, query: string, width = 260): string {
    const lowered = text.toLowerCase();
    let index = lowered.indexOf((query ?? "").toLowerCase());
    if (index < 0) {
      for (const match of (query ?? "").match(WORD) ?? []) {
        index = lowered.indexOf(match.toLowerCase());
        if (index >= 0) break;
      }
    }
    const start = index >= 0 ? Math.max(0, index - Math.floor(width / 3)) : 0;
    return text
      .slice(start, start + width)
      .replace(/\n/g, " ")
      .trim();
  }

  /** Sessions matching ``query`` plus the total match count. */
  search(
    query: string,
    limit = 50,
    offset = 0,
  ): [SessionDict[], number] {
    const q = (query ?? "").trim();
    if (!q) return [[], 0];
    const hits = this.search_hits(q, { limit: offset + limit });
    const total = this.last_total();
    const page = hits.slice(offset, offset + limit);
    const sessions: SessionDict[] = [];
    for (const hit of page) {
      const session = this.get(hit.session_id);
      if (session === null) continue;
      session._match_excerpt = hit.excerpt ?? "";
      sessions.push(session);
    }
    return [sessions, total];
  }

  // -- turn / message helpers -------------------------------------------

  append_user_message(
    session: SessionDict,
    content: string,
    opts: {
      attachments?: SessionDict[] | null;
      metadata?: SessionDict | null;
      parent_message_id?: unknown;
    } = {},
  ): SessionDict {
    const { parent_message_id: parentMessageId = AUTO_PARENT_MESSAGE } = opts;
    const message: SessionDict = {
      id: session.next_message_id,
      session_id: session.id,
      role: "user",
      content,
      capability: null,
      events: [],
      attachments: [...(opts.attachments ?? [])],
      metadata: { ...(opts.metadata ?? {}) },
      created_at: now(),
      parent_message_id: SessionStore._resolveParentMessageId(
        session,
        parentMessageId,
      ),
    };
    session.next_message_id += 1;
    (session.messages as SessionDict[]).push(message);
    if (!session.title) {
      session.title = deriveTitle(content);
      // Marks the placeholder so the runtime can replace it with a
      // generated title once the first turn completes.
      session.title_auto = true;
    }
    return message;
  }

  append_assistant_message(
    session: SessionDict,
    content: string,
    opts: {
      events: SessionDict[];
      turn_id: string;
      capability?: string | null;
      metadata?: SessionDict | null;
      parent_message_id?: unknown;
    },
  ): SessionDict {
    const { parent_message_id: parentMessageId = AUTO_PARENT_MESSAGE } = opts;
    const message: SessionDict = {
      id: session.next_message_id,
      session_id: session.id,
      role: "assistant",
      content,
      capability: opts.capability ?? null,
      events: opts.events,
      attachments: [],
      metadata: { turn_id: opts.turn_id, ...(opts.metadata ?? {}) },
      created_at: now(),
      parent_message_id: SessionStore._resolveParentMessageId(
        session,
        parentMessageId,
      ),
    };
    session.next_message_id += 1;
    (session.messages as SessionDict[]).push(message);
    return message;
  }

  record_turn_event(
    session: SessionDict,
    turnId: string,
    event: SessionDict,
  ): void {
    const turns = (session.turns ??= {}) as SessionDict;
    const turn = (turns[turnId] ??= {
      events: [],
      status: "running",
      last_seq: 0,
      created_at: now(),
    }) as SessionDict;
    (turn.events as SessionDict[]).push(event);
    turn.last_seq =
      "seq" in event ? event.seq : turn.last_seq;
  }

  /** Persisted event log for a finished turn (WS replay after restart). */
  turn_events(turnId: string, afterSeq = 0): SessionDict[] {
    return this._connect((db) => {
      const rows = allSql(
        db,
        "SELECT events FROM turns WHERE turn_id = ?",
        [String(turnId)],
      );
      for (const row of rows) {
        const events = (loads(row.events, []) as unknown[]).filter(
          (event): event is SessionDict =>
            event !== null &&
            typeof event === "object" &&
            !Array.isArray(event) &&
            Number((event as SessionDict).seq ?? 0) > afterSeq,
        );
        if (events.length > 0) return events;
      }
      return [] as SessionDict[];
    });
  }
}

function deriveTitle(content: string): string {
  const text = content.split(/\s+/).filter(Boolean).join(" ");
  return text.slice(0, 60) + (text.length > 60 ? "…" : "");
}
