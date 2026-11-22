// Port of deeptutor/learning/storage.py — transactional persistence for
// Mastery Path state, backed by node:sqlite in <data_dir>/mastery.sqlite3.
// Mirrors the upstream schema subset the REST surface needs.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

import type { Settings } from "../../config.js";
import {
  LearningProgress,
  MasteryEvent,
  MasteryInteraction,
  MasteryPathLease,
  MasteryTopic,
  ReadingActivityRecord,
  ReadingLearningRecords,
  ReadingProgressRecord,
  ReviewStrategyTemplate,
  TopicMetadata,
  TopicSource,
  normalizeProgress,
  normalizePendingQuestion,
  ACTIVE_INTERACTION_STATES,
} from "./models.js";
import { publishTopicSignal } from "./event_hub.js";

export class LearningStoreError extends Error {}
export class LearningConflictError extends LearningStoreError {
  constructor(
    public pathId: string,
    public expected: number,
    public actual: number,
  ) {
    super(
      `Mastery path ${pathId} changed concurrently ` +
        `(expected revision ${expected}, current revision ${actual})`,
    );
    this.name = "LearningConflictError";
  }
}
export class PathLeaseConflictError extends LearningStoreError {
  constructor(public lease: MasteryPathLease) {
    super(
      `Mastery path ${lease.path_id} is active in session ${lease.session_id} ` +
        `(turn ${lease.turn_id})`,
    );
    this.name = "PathLeaseConflictError";
  }
}
export class KeyError extends Error {
  constructor(public key: unknown) {
    super(`Key not found: ${String(key)}`);
    this.name = "KeyError";
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mastery_paths (
    path_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    owner_session_id TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS mastery_path_sessions (
    path_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at REAL NOT NULL,
    last_seen_at REAL NOT NULL,
    PRIMARY KEY (path_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_mastery_sessions_session ON mastery_path_sessions(session_id);
CREATE TABLE IF NOT EXISTS mastery_interactions (
    interaction_id TEXT PRIMARY KEY,
    path_id TEXT NOT NULL,
    status TEXT NOT NULL,
    question_json TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    user_answer TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mastery_interactions_path ON mastery_interactions(path_id);
CREATE TABLE IF NOT EXISTS mastery_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mastery_events_path_revision ON mastery_events(path_id, revision);
CREATE TABLE IF NOT EXISTS mastery_path_leases (
    path_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    acquired_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS mastery_topic_meta (
    path_id TEXT PRIMARY KEY,
    goal TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    emoji TEXT NOT NULL DEFAULT '🧭',
    map_seed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS mastery_topic_sources (
    source_id TEXT NOT NULL,
    path_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    excerpt TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at REAL NOT NULL,
    PRIMARY KEY (path_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_mastery_topic_sources_path ON mastery_topic_sources(path_id);
CREATE TABLE IF NOT EXISTS reading_progress (
    material_id TEXT PRIMARY KEY,
    latest_locator INTEGER NOT NULL,
    latest_percentage REAL NOT NULL,
    furthest_locator INTEGER NOT NULL,
    furthest_percentage REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS reading_activities (
    activity_id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    extension_id TEXT NOT NULL,
    action TEXT NOT NULL,
    locator INTEGER NOT NULL,
    result_type TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_activities_recent ON reading_activities(created_at DESC);
CREATE TABLE IF NOT EXISTS mastery_review_strategies (
    template_id TEXT PRIMARY KEY,
    strategy_json TEXT NOT NULL,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
`;

const _initialized = new Set<string>();

export function defaultDbPath(settings: Settings): string {
  return join(settings.data_dir, "mastery.sqlite3");
}

export function validateId(value: unknown): string {
  const id = String(value ?? "");
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes(":")) {
    throw new Error("Invalid id");
  }
  return id;
}

export function defaultMapSeed(pathId: string): number {
  return createHash("sha256")
    .update(pathId, "utf-8")
    .digest()
    .readUInt32BE(0);
}

interface Tx {
  conn: DatabaseSync;
  progress: LearningProgress;
  baseRevision: number;
  changed: boolean;
  created: boolean;
  events: Array<{ type: string; payload: Record<string, unknown>; sessionId: string; turnId: string }>;
}

function interactionFromRow(row: Record<string, unknown> | undefined): MasteryInteraction | null {
  if (!row) return null;
  let question: unknown;
  try {
    question = JSON.parse(String(row.question_json ?? "{}"));
  } catch {
    question = {};
  }
  const q = normalizePendingQuestion(question);
  const grouped = q.question_type === "group";
  let answers: Record<string, string> = {};
  let userAnswer = String(row.user_answer ?? "");
  if (grouped) {
    try {
      const parsed = JSON.parse(userAnswer || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        answers = parsed as Record<string, string>;
      }
    } catch {
      answers = {};
    }
    userAnswer = "";
  }
  let result: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(row.result_json ?? "{}"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
  } catch {
    result = {};
  }
  return {
    interaction_id: String(row.interaction_id),
    path_id: String(row.path_id),
    question: q,
    status: String(row.status) as MasteryInteraction["status"],
    session_id: String(row.session_id ?? ""),
    turn_id: String(row.turn_id ?? ""),
    user_answer: userAnswer,
    answers,
    result,
    created_at: Number(row.created_at) || 0,
    updated_at: Number(row.updated_at) || 0,
  } as MasteryInteraction;
}

const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  registered: new Set(["registered", "awaiting_input", "answered", "graded", "abandoned"]),
  awaiting_input: new Set(["awaiting_input", "answered", "graded", "abandoned"]),
  answered: new Set(["answered", "graded", "abandoned"]),
  graded: new Set(["graded"]),
  abandoned: new Set(["abandoned"]),
};

export class LearningTransaction {
  constructor(
    private conn: DatabaseSync,
    public progress: LearningProgress,
    public baseRevision: number,
    public created: boolean,
  ) {
    this.changed = created;
    this.events = [];
    if (created) this.emit("path.created", {});
  }
  changed: boolean;
  events: Tx["events"];

  touch(): void {
    this.changed = true;
  }

  emit(
    eventType: string,
    payload: Record<string, unknown> | null = null,
    sessionId = "",
    turnId = "",
  ): void {
    const name = String(eventType ?? "").trim();
    if (!name) throw new Error("event_type must not be empty");
    this.changed = true;
    this.events.push({
      type: name,
      payload: { ...(payload ?? {}) },
      sessionId: String(sessionId ?? ""),
      turnId: String(turnId ?? ""),
    });
  }

  getInteraction(interactionId: string): MasteryInteraction | null {
    const row = this.conn
      .prepare(
        "SELECT * FROM mastery_interactions WHERE interaction_id = ? AND path_id = ?",
      )
      .get(String(interactionId), this.progress.book_id) as Record<string, unknown> | undefined;
    return interactionFromRow(row);
  }

  activeInteraction(): MasteryInteraction | null {
    const placeholders = ACTIVE_INTERACTION_STATES.map(() => "?").join(",");
    const row = this.conn
      .prepare(
        `SELECT * FROM mastery_interactions WHERE path_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
      )
      .get(this.progress.book_id, ...ACTIVE_INTERACTION_STATES) as
      | Record<string, unknown>
      | undefined;
    return interactionFromRow(row);
  }

  putInteraction(interaction: MasteryInteraction): void {
    if (interaction.path_id !== this.progress.book_id) {
      throw new Error("interaction path_id does not match transaction path");
    }
    const existing = this.conn
      .prepare("SELECT path_id, status FROM mastery_interactions WHERE interaction_id = ?")
      .get(interaction.interaction_id) as Record<string, unknown> | undefined;
    if (existing && String(existing.path_id) !== interaction.path_id) {
      throw new Error(
        `interaction_id ${interaction.interaction_id} already belongs to another path`,
      );
    }
    if (existing) {
      const current = String(existing.status);
      const allowed = ALLOWED_TRANSITIONS[current];
      if (allowed && !allowed.has(interaction.status)) {
        throw new LearningStoreError(
          `Invalid mastery interaction transition: ${current} -> ${interaction.status}`,
        );
      }
    }
    const now = Date.now() / 1000;
    interaction.updated_at = now;
    const grouped = interaction.question.question_type === "group";
    this.conn
      .prepare(
        `INSERT INTO mastery_interactions (
          interaction_id, path_id, status, question_json, session_id,
          turn_id, user_answer, result_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(interaction_id) DO UPDATE SET
          status = excluded.status,
          question_json = excluded.question_json,
          session_id = excluded.session_id,
          turn_id = excluded.turn_id,
          user_answer = excluded.user_answer,
          result_json = excluded.result_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        interaction.interaction_id,
        interaction.path_id,
        interaction.status,
        JSON.stringify(interaction.question),
        interaction.session_id ?? "",
        interaction.turn_id ?? "",
        grouped ? JSON.stringify(interaction.answers ?? {}) : interaction.user_answer ?? "",
        JSON.stringify(interaction.result ?? {}),
        interaction.created_at,
        now,
      );
    this.touch();
  }

  abandonActiveInteractions(): number {
    const placeholders = ACTIVE_INTERACTION_STATES.map(() => "?").join(",");
    const now = Date.now() / 1000;
    const result = this.conn
      .prepare(
        `UPDATE mastery_interactions SET status = ?, updated_at = ?
         WHERE path_id = ? AND status IN (${placeholders})`,
      )
      .run("abandoned", now, this.progress.book_id, ...ACTIVE_INTERACTION_STATES);
    const count = Number(result.changes) || 0;
    if (count) this.touch();
    return count;
  }

  putTopic(metadata: TopicMetadata, sources: TopicSource[]): void {
    if (metadata.path_id !== this.progress.book_id) {
      throw new Error("topic metadata path_id does not match transaction path");
    }
    const now = Date.now() / 1000;
    metadata.updated_at = now;
    this.conn
      .prepare(
        `INSERT INTO mastery_topic_meta (
          path_id, goal, description, emoji, map_seed, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path_id) DO UPDATE SET
          goal = excluded.goal,
          description = excluded.description,
          emoji = excluded.emoji,
          map_seed = excluded.map_seed,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      )
      .run(
        metadata.path_id,
        metadata.goal,
        metadata.description,
        metadata.emoji,
        Math.trunc(Number(metadata.map_seed) || 0),
        metadata.status,
        metadata.created_at,
        now,
      );
    this.conn
      .prepare("DELETE FROM mastery_topic_sources WHERE path_id = ?")
      .run(metadata.path_id);
    const ordered = [...sources].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const insert = this.conn.prepare(
      `INSERT INTO mastery_topic_sources (
        source_id, path_id, kind, external_id, label, excerpt,
        position, available, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ordered.forEach((source, position) => {
      insert.run(
        source.id,
        metadata.path_id,
        source.kind,
        source.source_id ?? "",
        source.label,
        source.excerpt ?? "",
        position,
        source.available === false ? 0 : 1,
        JSON.stringify(source.metadata ?? {}),
        source.created_at,
      );
    });
    this.touch();
    this.emit("topic.updated", {
      source_count: sources.length,
      status: metadata.status,
    });
  }

  topicSources(): TopicSource[] {
    const rows = this.conn
      .prepare(
        "SELECT * FROM mastery_topic_sources WHERE path_id = ? ORDER BY position ASC, created_at ASC",
      )
      .all(this.progress.book_id) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.source_id),
      kind: String(row.kind) as TopicSource["kind"],
      source_id: String(row.external_id ?? ""),
      label: String(row.label ?? ""),
      excerpt: String(row.excerpt ?? ""),
      position: Number(row.position) || 0,
      available: Boolean(row.available),
      metadata: safeJson(row.metadata_json, {}),
      created_at: Number(row.created_at) || 0,
    }));
  }
}

function safeJson(raw: unknown, fallback: unknown): any {
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    return fallback;
  }
}

function progressPayload(progress: LearningProgress, revision: number, updatedAt: number): string {
  const copy = { ...progress, version: revision, updated_at: updatedAt };
  return JSON.stringify(copy);
}

export class LearningStore {
  readonly root: string;
  private conn: DatabaseSync | null = null;
  readonly eventScope: string;

  constructor(settings: Settings, root?: string) {
    this.root = root ?? defaultDbPath(settings);
    mkdirSync(dirname(this.root), { recursive: true });
    this.eventScope = this.root;
    if (!_initialized.has(this.root)) {
      const conn = this._connect();
      conn.exec(SCHEMA);
      conn.close();
      _initialized.add(this.root);
    }
  }

  private _connect(): DatabaseSync {
    if (this.conn === null || this.conn.isOpen === false) {
      this.conn = new DatabaseSync(this.root);
      this.conn.exec("PRAGMA journal_mode=WAL");
      this.conn.exec("PRAGMA busy_timeout=30000");
      this.conn.exec("PRAGMA synchronous=NORMAL");
      this.conn.exec("PRAGMA foreign_keys=ON");
    }
    return this.conn;
  }

  private _progressFromState(stateJson: unknown, revision: number): LearningProgress {
    const state = typeof stateJson === "string" ? safeJson(stateJson, {}) : stateJson;
    const progress = normalizeProgress(state);
    progress.version = revision;
    return progress;
  }

  load(bookId: string): LearningProgress | null {
    const pathId = validateId(bookId);
    const row = this._connect()
      .prepare("SELECT * FROM mastery_paths WHERE path_id = ?")
      .get(pathId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const owner = String(row.owner_session_id ?? "");
    const progress = this._progressFromState(row.state_json, Number(row.revision) || 0);
    if (owner) progress.owner_session_id = owner;
    return progress;
  }

  exists(bookId: string): boolean {
    const pathId = validateId(bookId);
    const row = this._connect()
      .prepare("SELECT 1 FROM mastery_paths WHERE path_id = ?")
      .get(pathId);
    return row !== undefined;
  }

  listAll(): string[] {
    const rows = this._connect()
      .prepare("SELECT path_id FROM mastery_paths ORDER BY path_id")
      .all() as Record<string, unknown>[];
    return rows.map((r) => String(r.path_id));
  }

  delete(bookId: string): void {
    const pathId = validateId(bookId);
    const conn = this._connect();
    conn.exec("BEGIN IMMEDIATE");
    try {
      conn.prepare("DELETE FROM mastery_paths WHERE path_id = ?").run(pathId);
      conn.exec("COMMIT");
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
    publishTopicSignal(pathId, 0, "topic.deleted", this.eventScope);
  }

  save(progress: LearningProgress): void {
    const pathId = validateId(progress.book_id);
    const conn = this._connect();
    const now = Date.now() / 1000;
    let revision = 0;
    let row: Record<string, unknown> | undefined;
    conn.exec("BEGIN IMMEDIATE");
    try {
      row = conn
        .prepare("SELECT revision FROM mastery_paths WHERE path_id = ?")
        .get(pathId) as Record<string, unknown> | undefined;
      if (!row) {
        if (Number(progress.version) !== 0) {
          throw new LearningConflictError(pathId, Number(progress.version), 0);
        }
        revision = 1;
        conn
          .prepare(
            `INSERT INTO mastery_paths (path_id, state_json, revision, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(pathId, progressPayload(progress, revision, now), revision, progress.created_at, now);
      } else {
        const actual = Number(row.revision);
        const expected = Number(progress.version);
        if (actual !== expected) {
          throw new LearningConflictError(pathId, expected, actual);
        }
        revision = actual + 1;
        const result = conn
          .prepare(
            `UPDATE mastery_paths SET state_json = ?, revision = ?, updated_at = ?
             WHERE path_id = ? AND revision = ?`,
          )
          .run(progressPayload(progress, revision, now), revision, now, pathId, expected);
        if (Number(result.changes) !== 1) {
          const current = conn
            .prepare("SELECT revision FROM mastery_paths WHERE path_id = ?")
            .get(pathId) as Record<string, unknown> | undefined;
          throw new LearningConflictError(pathId, expected, current ? Number(current.revision) : 0);
        }
      }
      conn
        .prepare(
          `INSERT INTO mastery_events (path_id, revision, event_type, payload_json, created_at)
           VALUES (?, ?, ?, '{}', ?)`,
        )
        .run(pathId, revision, row ? "path.saved" : "path.created", now);
      conn.exec("COMMIT");
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
    progress.version = revision;
    progress.updated_at = now;
    publishTopicSignal(pathId, revision, row ? "path.saved" : "path.created", this.eventScope);
  }

  /** Run a unit of work over one path aggregate; commits one revision. */
  mutate<T>(
    bookId: string,
    mutation: (tx: LearningTransaction) => T,
    opts?: { create?: boolean },
  ): { progress: LearningProgress; result: T } {
    const pathId = validateId(bookId);
    const conn = this._connect();
    let committedRevision: number | null = null;
    let committedReason = "topic.changed";
    conn.exec("BEGIN IMMEDIATE");
    let tx: LearningTransaction | null = null;
    let result: T;
    try {
      const row = conn
        .prepare("SELECT * FROM mastery_paths WHERE path_id = ?")
        .get(pathId) as Record<string, unknown> | undefined;
      const created = row === undefined;
      let progress: LearningProgress;
      let baseRevision: number;
      if (created) {
        if (!opts?.create) throw new KeyError(pathId);
        progress = normalizeProgress({ book_id: pathId });
        baseRevision = 0;
        const now = Date.now() / 1000;
        conn
          .prepare(
            `INSERT INTO mastery_paths (path_id, state_json, revision, created_at, updated_at)
             VALUES (?, ?, 0, ?, ?)`,
          )
          .run(pathId, progressPayload(progress, 0, progress.updated_at), progress.created_at, now);
      } else {
        baseRevision = Number(row.revision) || 0;
        progress = this._progressFromState(row.state_json, baseRevision);
        const owner = String(row.owner_session_id ?? "");
        if (owner) progress.owner_session_id = owner;
      }
      tx = new LearningTransaction(conn, progress, baseRevision, created);
      result = mutation(tx);
      if (tx.changed) {
        const now = Date.now() / 1000;
        const revision = tx.baseRevision + 1;
        const write = conn
          .prepare(
            `UPDATE mastery_paths SET state_json = ?, revision = ?, updated_at = ?
             WHERE path_id = ? AND revision = ?`,
          )
          .run(
            progressPayload(tx.progress, revision, now),
            revision,
            now,
            pathId,
            tx.baseRevision,
          );
        if (Number(write.changes) !== 1) {
          const current = conn
            .prepare("SELECT revision FROM mastery_paths WHERE path_id = ?")
            .get(pathId) as Record<string, unknown> | undefined;
          throw new LearningConflictError(
            pathId,
            tx.baseRevision,
            current ? Number(current.revision) : 0,
          );
        }
        const insertEvent = conn.prepare(
          `INSERT INTO mastery_events (path_id, revision, event_type, payload_json, session_id, turn_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const ev of tx.events) {
          insertEvent.run(
            pathId,
            revision,
            ev.type,
            JSON.stringify(ev.payload),
            ev.sessionId,
            ev.turnId,
            now,
          );
        }
        committedRevision = revision;
        if (tx.events.length) committedReason = tx.events[tx.events.length - 1].type;
        tx.progress.version = revision;
        tx.progress.updated_at = now;
      }
      conn.exec("COMMIT");
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
    if (committedRevision !== null && tx) {
      publishTopicSignal(pathId, committedRevision, committedReason, this.eventScope);
    }
    return { progress: tx!.progress, result: result! };
  }

  transaction<T>(bookId: string, opts?: { create?: boolean }): { progress: LearningProgress; result: T } {
    return this.mutate(bookId, (tx) => {
      // mutate's callback must return T; this overload is unused — kept for parity.
      return undefined as T;
    }, opts) as never;
  }

  // ---- review strategies ---------------------------------------------------

  private _strategyFromRow(row: Record<string, unknown>): ReviewStrategyTemplate {
    const parsed = safeJson(row.strategy_json, {}) as Record<string, unknown>;
    return { ...parsed, builtin: false } as ReviewStrategyTemplate;
  }

  listReviewStrategies(): ReviewStrategyTemplate[] {
    const rows = this._connect()
      .prepare(
        "SELECT * FROM mastery_review_strategies ORDER BY created_at DESC, template_id",
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this._strategyFromRow(r));
  }

  getReviewStrategy(templateId: string): ReviewStrategyTemplate | null {
    const id = validateId(templateId);
    const row = this._connect()
      .prepare("SELECT * FROM mastery_review_strategies WHERE template_id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this._strategyFromRow(row) : null;
  }

  saveReviewStrategy(template: ReviewStrategyTemplate): ReviewStrategyTemplate {
    if (template.builtin) {
      throw new Error(`template_id ${template.template_id} is reserved for a built-in preset`);
    }
    const now = Date.now() / 1000;
    const stored = { ...template, builtin: false, updated_at: now };
    this._connect()
      .prepare(
        `INSERT INTO mastery_review_strategies (template_id, strategy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(template_id) DO UPDATE SET
           strategy_json = excluded.strategy_json,
           updated_at = excluded.updated_at`,
      )
      .run(stored.template_id, JSON.stringify(stored), stored.created_at, now);
    return stored;
  }

  deleteReviewStrategy(templateId: string): boolean {
    const id = validateId(templateId);
    const result = this._connect()
      .prepare("DELETE FROM mastery_review_strategies WHERE template_id = ?")
      .run(id);
    return Number(result.changes) === 1;
  }

  // ---- reading records ------------------------------------------------------

  recordReadingPosition(
    materialId: string,
    opts: { locator: number; percentage: number },
  ): ReadingProgressRecord {
    const id = validateId(materialId);
    const locator = Math.trunc(Number(opts.locator));
    const percentage = Number(opts.percentage);
    const now = Date.now() / 1000;
    const conn = this._connect();
    conn.exec("BEGIN IMMEDIATE");
    try {
      const row = conn
        .prepare("SELECT furthest_locator, furthest_percentage FROM reading_progress WHERE material_id = ?")
        .get(id) as Record<string, unknown> | undefined;
      let record: ReadingProgressRecord;
      if (!row) {
        record = {
          material_id: id,
          latest_locator: locator,
          latest_percentage: percentage,
          furthest_locator: locator,
          furthest_percentage: percentage,
          updated_at: now,
        };
        conn
          .prepare(
            `INSERT INTO reading_progress (material_id, latest_locator, latest_percentage, furthest_locator, furthest_percentage, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, locator, percentage, locator, percentage, now);
      } else {
        const furthestLocator = Math.max(locator, Number(row.furthest_locator) || 0);
        const furthestPct = Math.max(percentage, Number(row.furthest_percentage) || 0);
        record = {
          material_id: id,
          latest_locator: locator,
          latest_percentage: percentage,
          furthest_locator: furthestLocator,
          furthest_percentage: furthestPct,
          updated_at: now,
        };
        conn
          .prepare(
            `UPDATE reading_progress SET latest_locator = ?, latest_percentage = ?,
             furthest_locator = ?, furthest_percentage = ?, updated_at = ?
             WHERE material_id = ?`,
          )
          .run(locator, percentage, furthestLocator, furthestPct, now, id);
      }
      conn.exec("COMMIT");
      return record;
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
  }

  recordReadingActivity(
    materialId: string,
    opts: { extension_id: string; action: string; locator: number; result_type: string },
  ): ReadingActivityRecord {
    const id = validateId(materialId);
    const extensionId = String(opts.extension_id ?? "").trim();
    const action = String(opts.action ?? "").trim();
    if (!extensionId || extensionId.length > 64) {
      throw new Error("extension_id must contain 1 to 64 characters");
    }
    if (!action || action.length > 64) {
      throw new Error("action must contain 1 to 64 characters");
    }
    const record: ReadingActivityRecord = {
      activity_id: `racc_${randomUUID().replace(/-/g, "")}`,
      material_id: id,
      extension_id: extensionId,
      action,
      locator: Math.trunc(Number(opts.locator)),
      result_type: String(opts.result_type),
      created_at: Date.now() / 1000,
    };
    this._connect()
      .prepare(
        `INSERT INTO reading_activities (activity_id, material_id, extension_id, action, locator, result_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.activity_id,
        record.material_id,
        record.extension_id,
        record.action,
        record.locator,
        record.result_type,
        record.created_at,
      );
    return record;
  }

  listReadingRecords(activityLimit = 200): ReadingLearningRecords {
    const limit = Math.max(1, Math.min(Math.trunc(Number(activityLimit) || 200), 500));
    const conn = this._connect();
    const progressRows = conn
      .prepare("SELECT * FROM reading_progress ORDER BY updated_at DESC, material_id ASC")
      .all() as Record<string, unknown>[];
    const activityRows = conn
      .prepare(
        "SELECT * FROM reading_activities ORDER BY created_at DESC, activity_id DESC LIMIT ?",
      )
      .all(limit) as Record<string, unknown>[];
    return {
      progress: progressRows.map((row) => ({
        material_id: String(row.material_id),
        latest_locator: Number(row.latest_locator) || 0,
        latest_percentage: Number(row.latest_percentage) || 0,
        furthest_locator: Number(row.furthest_locator) || 0,
        furthest_percentage: Number(row.furthest_percentage) || 0,
        updated_at: Number(row.updated_at) || 0,
      })),
      activities: activityRows.map((row) => ({
        activity_id: String(row.activity_id),
        material_id: String(row.material_id),
        extension_id: String(row.extension_id),
        action: String(row.action),
        locator: Number(row.locator) || 0,
        result_type: String(row.result_type),
        created_at: Number(row.created_at) || 0,
      })),
    } as ReadingLearningRecords;
  }

  // ---- topic metadata --------------------------------------------------------

  putTopic(metadata: TopicMetadata, sources: TopicSource[]): MasteryTopic {
    const pathId = validateId(metadata.path_id);
    const normalized: TopicMetadata = {
      ...metadata,
      path_id: pathId,
      map_seed: metadata.map_seed || defaultMapSeed(pathId),
    };
    const ordered = sources.map((s, i) => ({ ...s, position: i }));
    this.mutate(pathId, (tx) => {
      tx.putTopic(normalized, ordered);
    });
    return this.getTopic(pathId) as MasteryTopic;
  }

  private _topicFromRows(
    pathId: string,
    progress: LearningProgress | null,
    metaRow: Record<string, unknown> | undefined,
    sourceRows: Record<string, unknown>[],
  ): MasteryTopic | null {
    if (!progress) return null;
    let metadata: TopicMetadata;
    if (!metaRow) {
      metadata = {
        path_id: pathId,
        goal: "",
        description: "",
        emoji: "🧭",
        map_seed: defaultMapSeed(pathId),
        status: "active",
        created_at: progress.created_at,
        updated_at: progress.updated_at,
      };
    } else {
      metadata = {
        path_id: pathId,
        goal: String(metaRow.goal ?? ""),
        description: String(metaRow.description ?? ""),
        emoji: String(metaRow.emoji ?? "🧭"),
        map_seed: Number(metaRow.map_seed) || defaultMapSeed(pathId),
        status: (String(metaRow.status ?? "active") === "archived" ? "archived" : "active") as "active" | "archived",
        created_at: Number(metaRow.created_at) || 0,
        updated_at: Number(metaRow.updated_at) || 0,
      };
    }
    const sources: TopicSource[] = sourceRows.map((row) => ({
      id: String(row.source_id),
      kind: String(row.kind) as TopicSource["kind"],
      source_id: String(row.external_id ?? ""),
      label: String(row.label ?? ""),
      excerpt: String(row.excerpt ?? ""),
      position: Number(row.position) || 0,
      available: Boolean(row.available),
      metadata: safeJson(row.metadata_json, {}),
      created_at: Number(row.created_at) || 0,
    }));
    return { metadata, sources } as MasteryTopic;
  }

  getTopic(pathIdRaw: string, progress?: LearningProgress | null): MasteryTopic | null {
    const pathId = validateId(pathIdRaw);
    const prog = progress === undefined ? this.load(pathId) : progress;
    if (prog === null) return null;
    const conn = this._connect();
    const metaRow = conn
      .prepare("SELECT * FROM mastery_topic_meta WHERE path_id = ?")
      .get(pathId) as Record<string, unknown> | undefined;
    const sourceRows = conn
      .prepare(
        "SELECT * FROM mastery_topic_sources WHERE path_id = ? ORDER BY position ASC, created_at ASC",
      )
      .all(pathId) as Record<string, unknown>[];
    return this._topicFromRows(pathId, prog, metaRow, sourceRows);
  }

  listTopicSnapshots(status = "active"): Array<{
    progress: LearningProgress;
    topic: MasteryTopic;
    sessionCount: number;
    activeInteraction: MasteryInteraction | null;
  }> {
    const conn = this._connect();
    const progressRows = conn
      .prepare(
        `SELECT p.* FROM mastery_paths p
         JOIN mastery_topic_meta m ON m.path_id = p.path_id
         WHERE m.status = ?
         ORDER BY p.updated_at DESC`,
      )
      .all(status) as Record<string, unknown>[];
    const metaRows = new Map<string, Record<string, unknown>>();
    for (const row of conn
      .prepare("SELECT * FROM mastery_topic_meta WHERE status = ?")
      .all(status) as Record<string, unknown>[]) {
      metaRows.set(String(row.path_id), row);
    }
    const sourceRows = new Map<string, Record<string, unknown>[]>();
    for (const row of conn
      .prepare(
        `SELECT s.* FROM mastery_topic_sources s
         JOIN mastery_topic_meta m ON m.path_id = s.path_id
         WHERE m.status = ?
         ORDER BY s.path_id, s.position ASC, s.created_at ASC`,
      )
      .all(status) as Record<string, unknown>[]) {
      const key = String(row.path_id);
      const list = sourceRows.get(key) ?? [];
      list.push(row);
      sourceRows.set(key, list);
    }
    const sessionCounts = new Map<string, number>();
    for (const row of conn
      .prepare(
        `SELECT b.path_id, COUNT(*) AS session_count
         FROM mastery_path_sessions b
         JOIN mastery_topic_meta m ON m.path_id = b.path_id
         WHERE m.status = ?
         GROUP BY b.path_id`,
      )
      .all(status) as Record<string, unknown>[]) {
      sessionCounts.set(String(row.path_id), Number(row.session_count) || 0);
    }
    const placeholders = ACTIVE_INTERACTION_STATES.map(() => "?").join(",");
    const activeRows = new Map<string, Record<string, unknown>>();
    for (const row of conn
      .prepare(
        `SELECT i.* FROM mastery_interactions i
         JOIN mastery_topic_meta m ON m.path_id = i.path_id
         WHERE m.status = ? AND i.status IN (${placeholders})`,
      )
      .all(status, ...ACTIVE_INTERACTION_STATES) as Record<string, unknown>[]) {
      activeRows.set(String(row.path_id), row);
    }

    const snapshots: Array<{
      progress: LearningProgress;
      topic: MasteryTopic;
      sessionCount: number;
      activeInteraction: MasteryInteraction | null;
    }> = [];
    for (const progressRow of progressRows) {
      const pathId = String(progressRow.path_id);
      const progress = this._progressFromState(progressRow.state_json, Number(progressRow.revision) || 0);
      const owner = String(progressRow.owner_session_id ?? "");
      if (owner) progress.owner_session_id = owner;
      const topic = this._topicFromRows(
        pathId,
        progress,
        metaRows.get(pathId),
        sourceRows.get(pathId) ?? [],
      );
      if (topic === null) continue;
      snapshots.push({
        progress,
        topic,
        sessionCount: sessionCounts.get(pathId) ?? 0,
        activeInteraction: interactionFromRow(activeRows.get(pathId)),
      });
    }
    return snapshots;
  }

  hasActiveTopics(): boolean {
    const row = this._connect()
      .prepare("SELECT 1 FROM mastery_topic_meta WHERE status = 'active' LIMIT 1")
      .get();
    return row !== undefined;
  }

  // ---- sessions / leases / interactions / events ----------------------------

  bindSession(pathIdRaw: string, sessionId: string, ownsPath = false): void {
    const pathId = validateId(pathIdRaw);
    const sid = String(sessionId ?? "").trim();
    if (!sid) throw new Error("session_id must not be empty");
    const now = Date.now() / 1000;
    const conn = this._connect();
    let releasedPathId = "";
    let releasedRevision = 0;
    conn.exec("BEGIN IMMEDIATE");
    try {
      const previous = conn
        .prepare("SELECT path_id FROM mastery_path_sessions WHERE session_id = ?")
        .get(sid) as Record<string, unknown> | undefined;
      if (previous && String(previous.path_id) !== pathId) {
        releasedPathId = String(previous.path_id);
        conn.prepare("DELETE FROM mastery_path_sessions WHERE session_id = ?").run(sid);
        const releasedRow = conn
          .prepare("SELECT revision FROM mastery_paths WHERE path_id = ?")
          .get(releasedPathId) as Record<string, unknown> | undefined;
        releasedRevision = releasedRow ? Number(releasedRow.revision) || 0 : 0;
      }
      const exists = conn
        .prepare("SELECT 1 FROM mastery_paths WHERE path_id = ?")
        .get(pathId);
      if (!exists) {
        const progress = normalizeProgress({ book_id: pathId });
        progress.version = 1;
        progress.updated_at = now;
        conn
          .prepare(
            `INSERT INTO mastery_paths (path_id, state_json, revision, created_at, updated_at)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(pathId, JSON.stringify(progress), progress.created_at, now);
        conn
          .prepare(
            `INSERT INTO mastery_events (path_id, revision, event_type, payload_json, created_at)
             VALUES (?, 1, 'path.created', '{}', ?)`,
          )
          .run(pathId, now);
      }
      conn
        .prepare(
          `INSERT INTO mastery_path_sessions (path_id, session_id, created_at, last_seen_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(path_id, session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        )
        .run(pathId, sid, now, now);
      if (ownsPath) {
        conn
          .prepare(
            "UPDATE mastery_paths SET owner_session_id = ? WHERE path_id = ? AND owner_session_id = ''",
          )
          .run(sid, pathId);
      }
      conn.exec("COMMIT");
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
    const currentRow = conn
      .prepare("SELECT revision FROM mastery_paths WHERE path_id = ?")
      .get(pathId) as Record<string, unknown> | undefined;
    publishTopicSignal(pathId, currentRow ? Number(currentRow.revision) || 0 : 0, "session.bound", this.eventScope);
    if (releasedPathId) {
      publishTopicSignal(releasedPathId, releasedRevision, "session.released", this.eventScope);
    }
  }

  listSessionIds(pathIdRaw: string): string[] {
    const pathId = validateId(pathIdRaw);
    const rows = this._connect()
      .prepare("SELECT session_id FROM mastery_path_sessions WHERE path_id = ? ORDER BY last_seen_at DESC")
      .all(pathId) as Record<string, unknown>[];
    return rows.map((r) => String(r.session_id));
  }

  pathIdForSession(sessionId: string): string {
    const row = this._connect()
      .prepare("SELECT path_id FROM mastery_path_sessions WHERE session_id = ?")
      .get(String(sessionId)) as Record<string, unknown> | undefined;
    return row ? String(row.path_id) : "";
  }

  detachSession(sessionId: string): string[] {
    const sid = String(sessionId ?? "");
    const conn = this._connect();
    const rows = conn
      .prepare("SELECT path_id FROM mastery_path_sessions WHERE session_id = ?")
      .all(sid) as Record<string, unknown>[];
    const pathIds = rows.map((r) => String(r.path_id));
    if (pathIds.length) {
      conn.prepare("DELETE FROM mastery_path_sessions WHERE session_id = ?").run(sid);
    }
    conn.prepare("DELETE FROM mastery_path_leases WHERE session_id = ?").run(sid);
    return pathIds;
  }

  private _leaseFromRow(row: Record<string, unknown> | undefined): MasteryPathLease | null {
    if (!row) return null;
    return {
      path_id: String(row.path_id),
      session_id: String(row.session_id),
      turn_id: String(row.turn_id),
      acquired_at: Number(row.acquired_at) || 0,
    };
  }

  getPathLease(pathIdRaw: string): MasteryPathLease | null {
    const pathId = validateId(pathIdRaw);
    const row = this._connect()
      .prepare("SELECT * FROM mastery_path_leases WHERE path_id = ?")
      .get(pathId) as Record<string, unknown> | undefined;
    return this._leaseFromRow(row);
  }

  acquirePathLease(
    pathIdRaw: string,
    sessionId: string,
    turnId: string,
    opts?: { bindSession?: boolean },
  ): MasteryPathLease {
    const pathId = validateId(pathIdRaw);
    const sid = String(sessionId ?? "");
    const tid = String(turnId ?? "");
    const conn = this._connect();
    conn.exec("BEGIN IMMEDIATE");
    try {
      const existing = conn
        .prepare("SELECT * FROM mastery_path_leases WHERE path_id = ?")
        .get(pathId) as Record<string, unknown> | undefined;
      const lease = this._leaseFromRow(existing);
      if (lease && !(lease.session_id === sid && lease.turn_id === tid)) {
        throw new PathLeaseConflictError(lease);
      }
      const now = Date.now() / 1000;
      conn
        .prepare(
          `INSERT INTO mastery_path_leases (path_id, session_id, turn_id, acquired_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(path_id) DO UPDATE SET
             session_id = excluded.session_id,
             turn_id = excluded.turn_id,
             acquired_at = excluded.acquired_at`,
        )
        .run(pathId, sid, tid, now);
      if (opts?.bindSession !== false && sid) {
        conn
          .prepare(
            `INSERT INTO mastery_path_sessions (path_id, session_id, created_at, last_seen_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(path_id, session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
          )
          .run(pathId, sid, now, now);
      }
      conn.exec("COMMIT");
      return { path_id: pathId, session_id: sid, turn_id: tid, acquired_at: now };
    } catch (e) {
      conn.exec("ROLLBACK");
      throw e;
    }
  }

  releasePathLease(pathIdRaw: string, turnId?: string): boolean {
    const pathId = validateId(pathIdRaw);
    const conn = this._connect();
    let result;
    if (turnId !== undefined) {
      result = conn
        .prepare("DELETE FROM mastery_path_leases WHERE path_id = ? AND turn_id = ?")
        .run(pathId, String(turnId));
    } else {
      result = conn.prepare("DELETE FROM mastery_path_leases WHERE path_id = ?").run(pathId);
    }
    return Number(result.changes) > 0;
  }

  releaseLeasesForTurn(turnId: string): string {
    const conn = this._connect();
    const rows = conn
      .prepare("SELECT path_id FROM mastery_path_leases WHERE turn_id = ?")
      .all(String(turnId)) as Record<string, unknown>[];
    conn.prepare("DELETE FROM mastery_path_leases WHERE turn_id = ?").run(String(turnId));
    return rows.length ? String(rows[0].path_id) : "";
  }

  getInteraction(pathIdRaw: string, interactionId: string): MasteryInteraction | null {
    const pathId = validateId(pathIdRaw);
    const row = this._connect()
      .prepare("SELECT * FROM mastery_interactions WHERE path_id = ? AND interaction_id = ?")
      .get(pathId, String(interactionId)) as Record<string, unknown> | undefined;
    return interactionFromRow(row);
  }

  getActiveInteraction(pathIdRaw: string): MasteryInteraction | null {
    const pathId = validateId(pathIdRaw);
    const placeholders = ACTIVE_INTERACTION_STATES.map(() => "?").join(",");
    const row = this._connect()
      .prepare(
        `SELECT * FROM mastery_interactions WHERE path_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`,
      )
      .get(pathId, ...ACTIVE_INTERACTION_STATES) as Record<string, unknown> | undefined;
    return interactionFromRow(row);
  }

  listInteractions(pathIdRaw: string, limit = 200): MasteryInteraction[] {
    const pathId = validateId(pathIdRaw);
    const rows = this._connect()
      .prepare(
        `SELECT * FROM mastery_interactions WHERE path_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(pathId, Math.max(1, Math.trunc(Number(limit) || 200))) as Record<string, unknown>[];
    return rows.map(interactionFromRow).filter((i): i is MasteryInteraction => i !== null);
  }

  listEvents(pathIdRaw: string, afterRevision = 0): MasteryEvent[] {
    const pathId = validateId(pathIdRaw);
    const rows = this._connect()
      .prepare(
        `SELECT * FROM mastery_events WHERE path_id = ? AND revision > ?
         ORDER BY revision ASC, id ASC`,
      )
      .all(pathId, Math.max(0, Math.trunc(Number(afterRevision) || 0))) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: Number(row.id) || 0,
      path_id: String(row.path_id),
      revision: Number(row.revision) || 0,
      event_type: String(row.event_type),
      payload: safeJson(row.payload_json, {}),
      session_id: String(row.session_id ?? ""),
      turn_id: String(row.turn_id ?? ""),
      created_at: Number(row.created_at) || 0,
    }));
  }

  // ---- learning evidence projection ------------------------------------------

  listLearningEvidence(
    bookId: string,
    knowledgePointId?: string,
    limit?: number,
  ) {
    const progress = this.load(bookId);
    if (!progress) return [];
    let events = (progress.learning_evidence ?? []).filter(
      (e) => !knowledgePointId || e.knowledge_point_id === knowledgePointId,
    );
    // Ordinal DESC = reverse insertion order, matching the upstream index.
    events = [...events].reverse();
    if (limit !== undefined) events = events.slice(0, Math.max(1, Math.min(limit, 1000)));
    return events;
  }

  loadWithLearningEvidence(
    bookId: string,
    knowledgePointId: string,
    limit = 20,
  ): { progress: LearningProgress | null; evidence: unknown[]; evidenceCount: number } {
    const progress = this.load(bookId);
    if (!progress) return { progress: null, evidence: [], evidenceCount: 0 };
    const all = (progress.learning_evidence ?? []).filter(
      (e) => e.knowledge_point_id === knowledgePointId,
    );
    const bounded = Math.max(1, Math.min(Math.trunc(Number(limit) || 20), 1000));
    return {
      progress,
      evidence: [...all].reverse().slice(0, bounded),
      evidenceCount: all.length,
    };
  }

  countLearningEvidence(bookId: string, knowledgePointId?: string): number {
    const progress = this.load(bookId);
    if (!progress) return 0;
    return (progress.learning_evidence ?? []).filter(
      (e) => !knowledgePointId || e.knowledge_point_id === knowledgePointId,
    ).length;
  }
}

export function createLearningStore(settings: Settings): LearningStore {
  return new LearningStore(settings);
}
