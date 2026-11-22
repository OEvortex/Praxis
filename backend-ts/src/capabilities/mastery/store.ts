// Port of deeptutor.learning storage/models, adapted to Praxis's shared
// SQLite database (src/store/database.ts ext_items/kv helpers).
//
// Upstream keeps one SQLAlchemy aggregate per path plus separate interaction
// and lease tables. Praxis has a single generic ``ext_items`` table, so each
// mastery path is ONE JSON document (``collection="mastery_path"``) holding the
// whole LearningProgress aggregate — modules, attempts, evidence, repetition
// state, pending question and a bounded interaction log. Mutations are
// load → apply → save under a ``version`` check, matching upstream's
// optimistic-concurrency aggregate version.
//
// Session ↔ path/mode binding lives in ``collection="mastery_session"`` keyed
// by session id (upstream used session preferences; ext_items persists the
// same fields across restarts without touching the session store).
//
// Simplifications vs upstream LearningStore (documented in the port report):
//  * no per-path leases / turn scoping (single-process agent runtime);
//  * no separate event log / module-revision preview table (previews are kept
//    in ``kv`` under a per-path key);
//  * interactions are embedded in the path document instead of their own
//    table, capped at the most recent 64.

import { get_item, list_items, put_item } from "../../store/database.js";
import { get_settings } from "../../config.js";

export type KnowledgeType = "memory" | "concept" | "procedure" | "design";
export const KNOWLEDGE_TYPES: KnowledgeType[] = ["memory", "concept", "procedure", "design"];

export interface KnowledgePoint {
  id: string;
  name: string;
  type: KnowledgeType;
  module_id: string;
  prerequisite_ids: string[];
  topic_source_ids: string[];
  required_visual_tasks: string[];
}

export interface LearningModule {
  id: string;
  name: string;
  order: number;
  pass_threshold: number;
  objective: string;
  knowledge_points: KnowledgePoint[];
}

export interface QuizAttempt {
  question_id: string;
  knowledge_point_id: string;
  module_id: string;
  is_correct: boolean;
  result: "correct" | "partial" | "incorrect" | null;
  user_answer: unknown;
  error_type: string | null;
  timestamp: number;
  voided: boolean;
  void_reason: string;
  independent: boolean;
  visual_context: Record<string, unknown>;
}

export interface LearningEvidence {
  evidence_id: string;
  question_id: string;
  knowledge_point_id: string;
  timestamp: number;
  source: string;
  assessment_type: "quiz" | "qualitative" | "review";
  result: "correct" | "incorrect" | "partial";
  quality: number | null;
  hints_used: number;
  attempt_count: number;
  confidence: number | null;
  learner_answer: string;
  feedback: string;
  reference_answer: string;
  response_time: number | null;
  session_id: string;
  turn_id: string;
  visual_context: Record<string, unknown>;
}

export interface RepetitionState {
  interval_index: number;
  consecutive_correct: number;
  consecutive_wrong: number;
  next_review_at: number;
  difficulty: number;
  stability: number;
  retrievability: number;
  desired_retention: number;
  review_count: number;
  lapse_count: number;
  last_review_at: number | null;
  last_scheduled_at: number | null;
  scheduled_after_failure: boolean;
}

export interface ReviewTask {
  id: string;
  knowledge_point_id: string;
  knowledge_type: KnowledgeType;
  due_at: number;
  priority: number;
  state: RepetitionState;
  forgetting_risk: number;
  reason: string;
  evidence_source: string;
  evidence_id: string;
}

export interface PendingOption {
  label: string;
  body: string;
}

export interface PendingQuestion {
  question_id: string;
  knowledge_point_id: string;
  module_id: string;
  prompt: string;
  question_type: string; // "choice" | "short" | "open" | "group"
  expected_answer: string;
  options: PendingOption[];
  explanation: string;
  difficulty: string;
  created_at: number;
  visual_context: Record<string, unknown>;
  accepted_answers: string[];
  questions: PendingQuestion[];
  assistance_used?: boolean;
}

export type InteractionStatus =
  | "registered"
  | "awaiting_input"
  | "answered"
  | "graded"
  | "abandoned";

export interface MasteryInteraction {
  interaction_id: string;
  path_id: string;
  question: PendingQuestion;
  status: InteractionStatus;
  session_id: string;
  turn_id: string;
  user_answer: string;
  answers: Record<string, string>;
  result: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export interface TeachingPreference {
  text: string;
  evidence: string;
  session_id: string;
  turn_id: string;
  updated_at: number;
}

export interface TeachingObservation {
  knowledge_point_id: string;
  text: string;
  basis: "learner_report" | "tentative";
  strategy: string;
  outcome: "unknown" | "helped" | "not_helped";
  evidence: string;
  session_id: string;
  turn_id: string;
  updated_at: number;
}

export interface LearnerProfile {
  prior_knowledge: string;
  target_level: string;
  time_budget: string;
  preferences: string;
  teaching_strategy: "probe_first" | "teach_first";
  notes: string;
  teaching_preferences: Record<string, TeachingPreference>;
  teaching_observations: Record<string, TeachingObservation>;
  updated_at: number;
}

export interface LearnerMasteryOverride {
  knowledge_point_id: string;
  note: string;
  created_at: number;
}

export interface DeferredObjective {
  knowledge_point_id: string;
  note: string;
  created_at: number;
}

export interface LearningProgress {
  book_id: string;
  name: string;
  learner_profile: LearnerProfile | null;
  modules: LearningModule[];
  mastery_levels: Record<string, number>;
  qualitative_mastery: Record<string, boolean>;
  knowledge_types: Record<string, KnowledgeType>;
  lesson_evidence: Record<string, Record<string, unknown>>;
  quiz_attempts: QuizAttempt[];
  learning_evidence: LearningEvidence[];
  desired_retention: number;
  repetition_states: Record<string, RepetitionState>;
  review_queue: ReviewTask[];
  learner_mastery_overrides: Record<string, LearnerMasteryOverride>;
  deferred_objectives: Record<string, DeferredObjective>;
  explained_objectives: Record<string, Record<string, unknown>>;
  pending_question: PendingQuestion | null;
  interactions: MasteryInteraction[];
  version: number;
  created_at: number;
  updated_at: number;
}

export interface TopicSource {
  id: string;
  kind: string;
  source_id: string;
  label: string;
  excerpt: string;
  position: number;
  available: boolean;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface MasteryTopic {
  path_id: string;
  goal: string;
  description: string;
  emoji: string;
  sources: TopicSource[];
  created_at: number;
  updated_at: number;
}

export interface SessionBinding {
  path_id: string;
  mode: string | null; // raw stored mode; null = never recorded (no enforcement)
  turn_id?: string;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

const PATH_COLLECTION = "mastery_path";
const TOPIC_COLLECTION = "mastery_topic";
const SESSION_COLLECTION = "mastery_session";

const MAX_INTERACTIONS = 64;

function now(): number {
  return Date.now() / 1000;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function arr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function newProgress(pathId: string): LearningProgress {
  const t = now();
  return {
    book_id: pathId,
    name: "",
    learner_profile: null,
    modules: [],
    mastery_levels: {},
    qualitative_mastery: {},
    knowledge_types: {},
    lesson_evidence: {},
    quiz_attempts: [],
    learning_evidence: [],
    desired_retention: 0.9,
    repetition_states: {},
    review_queue: [],
    learner_mastery_overrides: {},
    deferred_objectives: {},
    explained_objectives: {},
    pending_question: null,
    interactions: [],
    version: 0,
    created_at: t,
    updated_at: t,
  };
}

// ---------------------------------------------------------------------------
// Path persistence
// ---------------------------------------------------------------------------

/** Read a path, or null when it does not exist. Never creates (upstream #909). */
export function loadPath(pathId: string): LearningProgress | null {
  const raw = get_item(get_settings(), PATH_COLLECTION, sanitizePathId(pathId));
  if (!raw) return null;
  return hydrateProgress(rec(raw));
}

function hydrateProgress(raw: Record<string, unknown>): LearningProgress {
  const base = newProgress(String(raw["book_id"] ?? ""));
  const out: LearningProgress = {
    ...base,
    ...raw,
    modules: arr<LearningModule>(raw["modules"]),
    quiz_attempts: arr<QuizAttempt>(raw["quiz_attempts"]),
    learning_evidence: arr<LearningEvidence>(raw["learning_evidence"]),
    review_queue: arr<ReviewTask>(raw["review_queue"]),
    interactions: arr<MasteryInteraction>(raw["interactions"]),
    mastery_levels: rec(raw["mastery_levels"]) as Record<string, number>,
    qualitative_mastery: rec(raw["qualitative_mastery"]) as Record<string, boolean>,
    knowledge_types: rec(raw["knowledge_types"]) as Record<string, KnowledgeType>,
    lesson_evidence: rec(raw["lesson_evidence"]) as Record<string, Record<string, unknown>>,
    repetition_states: rec(raw["repetition_states"]) as Record<string, RepetitionState>,
    learner_mastery_overrides: rec(raw["learner_mastery_overrides"]) as Record<
      string,
      LearnerMasteryOverride
    >,
    deferred_objectives: rec(raw["deferred_objectives"]) as Record<string, DeferredObjective>,
    explained_objectives: rec(raw["explained_objectives"]) as Record<
      string,
      Record<string, unknown>
    >,
    learner_profile: (raw["learner_profile"] as LearnerProfile | null) ?? null,
    pending_question: (raw["pending_question"] as PendingQuestion | null) ?? null,
  };
  for (const mod of out.modules) {
    mod.knowledge_points = arr<KnowledgePoint>(mod.knowledge_points);
    mod.pass_threshold = Number(mod.pass_threshold ?? 0.7) || 0.7;
    mod.objective = String(mod.objective ?? "");
  }
  return out;
}

/**
 * Mutate a path under its optimistic version. ``fn`` returns the mutated
 * progress (or null to abort without saving). Throws on version conflict.
 */
export function mutatePath<T>(
  pathId: string,
  fn: (progress: LearningProgress) => { progress: LearningProgress; result: T } | T | null,
): T {
  const id = sanitizePathId(pathId);
  const existing = loadPath(id);
  const progress = existing ?? newProgress(id);
  const applied = fn(progress);
  if (applied === null) {
    return undefined as T;
  }
  const isWrapped =
    typeof applied === "object" &&
    applied !== null &&
    "progress" in (applied as Record<string, unknown>) &&
    "result" in (applied as Record<string, unknown>);
  const next = isWrapped ? (applied as { progress: LearningProgress }).progress : progress;
  const result = isWrapped ? (applied as { result: T }).result : (applied as T);
  next.book_id = id;
  next.version = (progress.version || 0) + 1;
  next.updated_at = now();
  // Bound the embedded interaction log: terminal rows are audit, keep the newest.
  if (next.interactions.length > MAX_INTERACTIONS) {
    next.interactions = next.interactions.slice(-MAX_INTERACTIONS);
  }
  put_item(get_settings(), PATH_COLLECTION, { id, ...next });
  return result;
}

export function savePath(progress: LearningProgress): void {
  const id = sanitizePathId(progress.book_id);
  progress.book_id = id;
  progress.version = (progress.version || 0) + 1;
  progress.updated_at = now();
  put_item(get_settings(), PATH_COLLECTION, { id, ...progress });
}

export function pathExists(pathId: string): boolean {
  return get_item(get_settings(), PATH_COLLECTION, sanitizePathId(pathId)) !== null;
}

export function listPaths(): LearningProgress[] {
  const items = list_items(get_settings(), PATH_COLLECTION);
  return items
    .map((raw) => hydrateProgress(raw))
    .filter((p) => (p.modules ?? []).some((m) => (m.knowledge_points ?? []).length > 0) || p.name);
}

// ---------------------------------------------------------------------------
// Topic metadata (goal, sources)
// ---------------------------------------------------------------------------

export function getTopic(pathId: string): MasteryTopic | null {
  const raw = get_item(get_settings(), TOPIC_COLLECTION, sanitizePathId(pathId));
  return raw ? (raw as unknown as MasteryTopic) : null;
}

export function putTopic(topic: MasteryTopic): void {
  put_item(get_settings(), TOPIC_COLLECTION, {
    id: sanitizePathId(topic.path_id),
    ...topic,
  });
}

// ---------------------------------------------------------------------------
// Session binding (path + mode), upstream binding.py equivalent
// ---------------------------------------------------------------------------

export function getSessionBinding(sessionId: string): SessionBinding | null {
  if (!sessionId) return null;
  const raw = get_item(get_settings(), SESSION_COLLECTION, sessionId);
  return raw ? (raw as unknown as SessionBinding) : null;
}

export function setSessionPath(sessionId: string, pathId: string): void {
  if (!sessionId) return;
  const prev = getSessionBinding(sessionId);
  put_item(get_settings(), SESSION_COLLECTION, {
    id: sessionId,
    path_id: pathId,
    mode: prev?.mode ?? null,
    turn_id: prev?.turn_id,
    updated_at: now(),
  });
}

export function setSessionMode(sessionId: string, mode: string): void {
  if (!sessionId || !mode) return;
  const prev = getSessionBinding(sessionId);
  put_item(get_settings(), SESSION_COLLECTION, {
    id: sessionId,
    path_id: prev?.path_id ?? "",
    mode,
    turn_id: prev?.turn_id,
    updated_at: now(),
  });
}

/**
 * The path this conversation is on: the remembered binding, else the
 * conversation's own scratch path (upstream identity.resolve binding).
 */
export function activePathId(sessionId: string, configuredPathId = ""): string {
  const configured = sanitizePathId(configuredPathId);
  if (configured) return configured;
  const bound = getSessionBinding(sessionId)?.path_id;
  if (bound) return sanitizePathId(bound);
  return sanitizePathId(sessionId || "default");
}

/** The raw stored mode for this conversation (null = never recorded). */
export function sessionMode(sessionId: string): string | null {
  const bound = getSessionBinding(sessionId)?.mode;
  return bound && bound.trim() ? bound : null;
}

/**
 * Sanitize a path id. Upstream ``learning.identity.sanitize_mastery_path_id``
 * is stricter (slug rules); this keeps the id filesystem/JSON safe and
 * bounded, which is all ext_items needs.
 */
export function sanitizePathId(raw: string): string {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return cleaned || "default";
}
