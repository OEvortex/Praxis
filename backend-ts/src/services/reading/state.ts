// Port of the reading-quiz / assessment persistence that upstream keeps in
// services/session/sqlite_store.py (reading_quiz_pending,
// reading_quiz_help_events, reading_quiz_rewards, assessment_attempts) plus
// LearningStore.record_reading_position / record_reading_activity.
//
// These tables live in the shared praxis database (shared/db.ts) so they
// survive alongside sessions, matching the single-store deployment here.

import { getDb, tx } from "../../shared/db.js";

let ready = false;
function ensure(): void {
  if (ready) return;
  getDb().exec(`
CREATE TABLE IF NOT EXISTS reading_quiz_pending (
    material_id TEXT NOT NULL,
    locator INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    question_json TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (material_id, locator, question_id)
);
CREATE TABLE IF NOT EXISTS reading_quiz_help_events (
    material_id TEXT NOT NULL,
    locator INTEGER NOT NULL,
    question_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    help_kind TEXT NOT NULL,
    question TEXT NOT NULL,
    created_at REAL NOT NULL,
    PRIMARY KEY (material_id, locator, question_id, request_id)
);
CREATE TABLE IF NOT EXISTS reading_quiz_rewards (
    material_id TEXT NOT NULL,
    locator INTEGER NOT NULL,
    stars INTEGER NOT NULL,
    updated_at REAL NOT NULL,
    PRIMARY KEY (material_id, locator)
);
CREATE TABLE IF NOT EXISTS reading_assessment_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL DEFAULT '',
    origin_type TEXT NOT NULL DEFAULT '',
    origin_ref TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    question_id TEXT NOT NULL DEFAULT '',
    assessment_json TEXT NOT NULL,
    occurred_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_assess_qid ON reading_assessment_attempts(question_id);
CREATE TABLE IF NOT EXISTS reading_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    material_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reading_activity_material ON reading_activity(material_id, created_at DESC);
`);
  ready = true;
}

// -- pending quiz ------------------------------------------------------------

export function putReadingQuizPending(materialId: string, locator: number, questions: unknown[]): number {
  ensure();
  const material = String(materialId ?? "").trim();
  if (!material) return 0;
  const now = Date.now() / 1000;
  const db = getDb();
  tx(() => {
    db.prepare("DELETE FROM reading_quiz_pending WHERE material_id = ? AND locator = ?")
      .run(material, Math.trunc(locator));
    const insert = db.prepare(
      `INSERT INTO reading_quiz_pending (material_id, locator, question_id, question_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let index = 0;
    for (const question of questions ?? []) {
      index += 1;
      if (!question || typeof question !== "object" || Array.isArray(question)) continue;
      const rec = { ...(question as Record<string, unknown>) };
      delete rec._help_requests;
      delete rec._help_count;
      const questionId = String(rec.id ?? `q_${index}`).trim();
      if (!questionId) continue;
      insert.run(material, Math.trunc(locator), questionId, JSON.stringify(rec), now);
    }
  });
  return questions?.length ?? 0;
}

export function getReadingQuizPending(
  materialId: string,
  locator: number,
  questionIds?: string[] | null,
): Record<string, Record<string, unknown>> {
  ensure();
  const material = String(materialId ?? "").trim();
  let sql = `SELECT question_id, question_json FROM reading_quiz_pending
             WHERE material_id = ? AND locator = ?`;
  const params: unknown[] = [material, Math.trunc(locator)];
  if (questionIds != null) {
    const wanted = questionIds.map((q) => String(q).trim()).filter(Boolean);
    if (!wanted.length) return {};
    sql += ` AND question_id IN (${wanted.map(() => "?").join(",")})`;
    params.push(...wanted);
  }
  const rows = getDb().prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
  const pending: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.question_json));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        pending[String(row.question_id)] = parsed as Record<string, unknown>;
      }
    } catch {
      // skip corrupt rows
    }
  }
  return pending;
}

// -- quiz help (claim / complete / abort) --------------------------------------

export class QuizHelpConflict extends Error {}

export function readingQuizHelp(
  materialId: string,
  locator: number,
  questionId: string,
  requestId: string,
  fingerprint: string,
  token: string,
  operation: "claim" | "complete" | "abort",
  result: Record<string, unknown> | null,
  leaseSeconds = 150,
  helpKind = "",
): Record<string, unknown> | null {
  ensure();
  const db = getDb();
  const out = tx(() => {
    const row = db
      .prepare(
        `SELECT question_json FROM reading_quiz_pending
         WHERE material_id = ? AND locator = ? AND question_id = ?`,
      )
      .get(materialId, Math.trunc(locator), questionId) as Record<string, unknown> | undefined;
    if (!row) {
      if (operation === "abort") return null;
      throw new QuizHelpConflict("This reading quiz has expired.");
    }
    const question = JSON.parse(String(row.question_json)) as Record<string, unknown>;
    const receipts = (question._help_requests ??= {}) as Record<string, Record<string, unknown>>;
    const receipt = receipts[requestId];
    const now = Date.now() / 1000;
    if (operation === "claim") {
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new QuizHelpConflict("This help request was already used for different content.");
        }
        if (receipt.state === "complete") return receipt.result as Record<string, unknown>;
        if (receipt.state === "pending" && Number(receipt.expires_at) > now) {
          throw new QuizHelpConflict("This help request is still running. Retry shortly.");
        }
      } else if (Object.keys(receipts).length >= 50) {
        throw new QuizHelpConflict("This question has reached its help request limit.");
      }
      receipts[requestId] = {
        fingerprint,
        help_kind: helpKind,
        token,
        state: "pending",
        expires_at: now + leaseSeconds,
      };
    } else if (operation === "complete") {
      if (!receipt || receipt.token !== token || receipt.state !== "pending" || Number(receipt.expires_at) <= now) {
        throw new QuizHelpConflict("This help request has expired. Retry the request.");
      }
      if (result == null) throw new Error("A completed help request requires a result.");
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > 262_144) {
        throw new Error("The help result is too large to record.");
      }
      question._help_count = Number(question._help_count ?? 0) + 1;
      const completed = {
        ...result,
        quiz_help: { question_id: questionId, hints_used: question._help_count },
      };
      receipt.state = "complete";
      receipt.result = completed;
      db.prepare(
        `INSERT INTO reading_quiz_help_events
         (material_id, locator, question_id, request_id, help_kind, question, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        materialId,
        Math.trunc(locator),
        questionId,
        requestId,
        String(receipt.help_kind ?? helpKind),
        String(question.prompt ?? "").slice(0, 10000),
        now,
      );
      result = completed;
    } else if (operation === "abort") {
      if (!receipt || receipt.token !== token || receipt.state !== "pending") return null;
      receipt.state = "failed";
    }
    db.prepare(
      `UPDATE reading_quiz_pending SET question_json = ?
       WHERE material_id = ? AND locator = ? AND question_id = ?`,
    ).run(JSON.stringify(question), materialId, Math.trunc(locator), questionId);
    return operation === "complete" ? result : null;
  });
  return out as Record<string, unknown> | null;
}

// -- rewards --------------------------------------------------------------------

export function upsertReadingQuizReward(materialId: string, locator: number, stars: number): Record<string, unknown> {
  ensure();
  const material = String(materialId ?? "").trim();
  const loc = Math.trunc(locator);
  const normalizedStars = Math.max(1, Math.trunc(stars));
  if (!material) throw new Error("material_id is required");
  const now = Date.now() / 1000;
  const db = getDb();
  const previousRow = db
    .prepare("SELECT stars FROM reading_quiz_rewards WHERE material_id = ? AND locator = ?")
    .get(material, loc) as Record<string, unknown> | undefined;
  const previous = previousRow ? Number(previousRow.stars) : 0;
  const awarded = normalizedStars > previous;
  tx(() => {
    db.prepare(
      `INSERT INTO reading_quiz_rewards (material_id, locator, stars, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(material_id, locator) DO UPDATE SET
           stars = excluded.stars, updated_at = excluded.updated_at
       WHERE excluded.stars > reading_quiz_rewards.stars`,
    ).run(material, loc, normalizedStars, now);
  });
  return {
    locator: loc,
    stars: Math.max(normalizedStars, previous),
    updated_at: now,
    awarded,
  };
}

export function listReadingQuizRewards(materialId: string): Array<{ locator: number; stars: number; updated_at: number }> {
  ensure();
  const material = String(materialId ?? "").trim();
  if (!material) return [];
  const rows = getDb()
    .prepare("SELECT locator, stars, updated_at FROM reading_quiz_rewards WHERE material_id = ? ORDER BY locator")
    .all(material) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    locator: Number(r.locator),
    stars: Number(r.stars),
    updated_at: Number(r.updated_at),
  }));
}

export function readingQuizRewardTotals(materialIds: string[]): Record<string, number> {
  ensure();
  const wanted = [...new Set(materialIds.map((m) => String(m).trim()).filter(Boolean))];
  if (!wanted.length) return {};
  const placeholders = wanted.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT material_id, SUM(stars) AS stars FROM reading_quiz_rewards
       WHERE material_id IN (${placeholders}) GROUP BY material_id`,
    )
    .all(...(wanted as never[])) as Array<Record<string, unknown>>;
  const out: Record<string, number> = {};
  for (const row of rows) out[String(row.material_id)] = Number(row.stars) || 0;
  return out;
}

// -- assessments (best quiz results) ----------------------------------------------

export interface AssessmentRecord {
  session_id?: string;
  origin_type?: string;
  origin_ref?: string;
  turn_id?: string;
  question_id?: string;
  question?: string;
  question_type?: string;
  options?: Record<string, string>;
  user_answer?: string;
  correct_answer?: string;
  is_correct?: boolean;
  result?: string;
  source?: string;
  assessment_type?: string;
  material_id?: string;
  material_title?: string;
  section_id?: string;
  section_title?: string;
  mastery_path_id?: string;
  knowledge_point_id?: string;
  attempt_id?: string;
  hints_used?: number;
  [k: string]: unknown;
}

export function recordAssessment(record: AssessmentRecord): void {
  ensure();
  getDb()
    .prepare(
      `INSERT INTO reading_assessment_attempts
       (session_id, origin_type, origin_ref, turn_id, question_id, assessment_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(record.session_id ?? ""),
      String(record.origin_type ?? ""),
      String(record.origin_ref ?? ""),
      String(record.turn_id ?? ""),
      String(record.question_id ?? ""),
      JSON.stringify(record),
      Date.now() / 1000,
    );
}

export function bestReadingQuizResults(
  materialId: string,
  locator: number,
  questionIds: string[],
): Record<string, { attempted: boolean; correct: boolean }> {
  ensure();
  const wanted = [...new Set(questionIds.map((q) => String(q).trim()).filter(Boolean))];
  if (!wanted.length) return {};
  const wantedSet = new Set(wanted);
  const section = String(Math.trunc(locator));
  const rows = getDb()
    .prepare(`SELECT question_id, assessment_json FROM reading_assessment_attempts`)
    .all() as Array<Record<string, unknown>>;
  const results: Record<string, { attempted: boolean; correct: boolean }> = {};
  for (const row of rows) {
    const qid = String(row.question_id ?? "");
    if (!wantedSet.has(qid)) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(String(row.assessment_json)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (String(value.source ?? "") !== "immersive_reading") continue;
    if (String(value.material_id ?? "") !== materialId) continue;
    if (String(value.section_id ?? "") !== section) continue;
    const correct = String(value.result ?? "") === "correct";
    const current = results[qid] ??= { attempted: true, correct: false };
    current.correct = current.correct || correct;
  }
  return results;
}

// -- activity ---------------------------------------------------------------------

export function recordReadingPosition(materialId: string, locator: number, percentage: number): void {
  ensure();
  getDb()
    .prepare("INSERT INTO reading_activity (kind, material_id, payload, created_at) VALUES ('position', ?, ?, ?)")
    .run(String(materialId), JSON.stringify({ locator, percentage }), Date.now() / 1000);
}

export function recordReadingActivity(
  materialId: string,
  opts: { extension_id?: string; action?: string; locator?: number; result_type?: string },
): void {
  ensure();
  getDb()
    .prepare("INSERT INTO reading_activity (kind, material_id, payload, created_at) VALUES ('activity', ?, ?, ?)")
    .run(String(materialId), JSON.stringify(opts), Date.now() / 1000);
}
