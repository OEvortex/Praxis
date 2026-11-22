// the Mastery Path aggregate shapes.
//
// Upstream these are pydantic models; here the persisted state is plain JSON
// (the store round-trips ``state_json`` verbatim), so the "models" are
// TypeScript interfaces plus the default/fill logic that makes a partially
// populated record behave like the pydantic defaults did.

export type KnowledgeType = "memory" | "concept" | "procedure" | "design";
export const KNOWLEDGE_TYPES: KnowledgeType[] = [
  "memory",
  "concept",
  "procedure",
  "design",
];

const KNOWLEDGE_TYPE_LEGACY: Record<string, KnowledgeType> = {};

export function normalizeKnowledgeType(value: unknown): KnowledgeType {
  const raw = String(value ?? "").trim();
  if ((KNOWLEDGE_TYPES as string[]).includes(raw)) return raw as KnowledgeType;
  return KNOWLEDGE_TYPE_LEGACY[raw] ?? "concept";
}

export type LearningStage =
  | "diagnostic"
  | "explain"
  | "feynman_check"
  | "practice"
  | "error_diagnosis"
  | "review"
  | "completed";

const STAGE_LEGACY: Record<string, LearningStage> = {
  diagnostic_phase1: "diagnostic",
  diagnostic_phase2: "diagnostic",
  metacognitive_intro: "explain",
  plan: "explain",
  pretest: "explain",
  practice_quiz: "practice",
  module_test: "review",
};

export function normalizeStage(value: unknown): LearningStage {
  const raw = String(value ?? "").trim();
  if (
    [
      "diagnostic",
      "explain",
      "feynman_check",
      "practice",
      "error_diagnosis",
      "review",
      "completed",
    ].includes(raw)
  ) {
    return raw as LearningStage;
  }
  return STAGE_LEGACY[raw] ?? "diagnostic";
}

export interface KnowledgePoint {
  id: string;
  name: string;
  type: KnowledgeType;
  module_id: string;
  prerequisite_ids: string[];
  topic_source_ids: string[];
  required_visual_tasks: string[];
  [k: string]: unknown;
}

export interface LearningModule {
  id: string;
  name: string;
  order: number;
  pass_threshold: number;
  objective: string;
  knowledge_points: KnowledgePoint[];
  [k: string]: unknown;
}

export interface DiagnosticResult {
  total_questions: number;
  correct_count: number;
  module_mastery: Record<string, number>;
  [k: string]: unknown;
}

export interface QuizAttempt {
  question_id: string;
  knowledge_point_id: string;
  module_id: string;
  is_correct: boolean;
  result: "correct" | "partial" | "incorrect" | null;
  user_answer: unknown;
  error_type: string | null;
  self_attribution: string;
  mastery_estimate: number;
  timestamp: number;
  voided: boolean;
  void_reason: string;
  independent: boolean;
  visual_context: Record<string, unknown>;
  [k: string]: unknown;
}

export interface RetryAttempt {
  timestamp: number;
  is_correct: boolean;
  attempt_number: number;
  [k: string]: unknown;
}

export interface ErrorRecord {
  id: string;
  question_id: string;
  knowledge_point_id: string;
  module_id: string;
  error_type: string;
  self_attribution: string;
  ai_confirmation: string;
  retry_history: RetryAttempt[];
  status: "active" | "retrying" | "review" | "graduated";
  created_at: number;
  [k: string]: unknown;
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
  [k: string]: unknown;
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
  [k: string]: unknown;
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
  [k: string]: unknown;
}

const REVIEW_INTERVAL_MAX_DAYS = 365;
const REVIEW_INTERVAL_MAX_ROUNDS = 16;
const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{1,63}$/;

export class ValidationError extends Error {}

function validateReviewIntervals(
  value: unknown,
): Record<KnowledgeType, number[]> {
  const intervals = (value ?? {}) as Record<string, unknown>;
  const missing = KNOWLEDGE_TYPES.filter((kt) => !(kt in intervals));
  if (missing.length) {
    throw new ValidationError(
      `intervals must define every knowledge type; missing: ${missing.join(", ")}`,
    );
  }
  const out = {} as Record<KnowledgeType, number[]>;
  for (const kt of KNOWLEDGE_TYPES) {
    const rounds = intervals[kt];
    if (!Array.isArray(rounds) || rounds.length === 0) {
      throw new ValidationError(
        `intervals[${kt}] must be a non-empty list of round intervals`,
      );
    }
    if (rounds.length > REVIEW_INTERVAL_MAX_ROUNDS) {
      throw new ValidationError(
        `intervals[${kt}] exceeds ${REVIEW_INTERVAL_MAX_ROUNDS} review rounds`,
      );
    }
    const cleaned: number[] = [];
    for (let index = 0; index < rounds.length; index += 1) {
      const days = rounds[index];
      if (typeof days !== "number" || !Number.isInteger(days)) {
        throw new ValidationError(
          `intervals[${kt}][${index}] must be a whole number of days`,
        );
      }
      if (days < 0 || days > REVIEW_INTERVAL_MAX_DAYS) {
        throw new ValidationError(
          `intervals[${kt}][${index}] must be between 0 and ${REVIEW_INTERVAL_MAX_DAYS} days`,
        );
      }
      if (days === 0 && index > 0) {
        throw new ValidationError(
          `intervals[${kt}][${index}]: only the first round may repeat same day`,
        );
      }
      if (index && days < cleaned[index - 1]) {
        throw new ValidationError(
          `intervals[${kt}][${index}]: rounds must not get shorter`,
        );
      }
      cleaned.push(days);
    }
    out[kt] = cleaned;
  }
  return out;
}

export interface ReviewStrategyTemplate {
  template_id: string;
  name: string;
  description: string;
  builtin: boolean;
  desired_retention: number | null;
  intervals: Record<KnowledgeType, number[]>;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface ReviewStrategyBinding {
  template_id: string;
  name: string;
  builtin: boolean;
  desired_retention: number | null;
  intervals: Record<KnowledgeType, number[]>;
  bound_at: number;
  [k: string]: unknown;
}

export function buildReviewStrategyTemplate(raw: Record<string, unknown>): ReviewStrategyTemplate {
  const templateId = String(raw.template_id ?? "");
  if (!TEMPLATE_ID_PATTERN.test(templateId)) {
    throw new ValidationError(
      "template_id must be a lowercase slug (a-z, 0-9, '-', '_')",
    );
  }
  const name = String(raw.name ?? "").trim();
  if (!name) throw new ValidationError("name must not be blank");
  if (name.length > 120) throw new ValidationError("name is too long");
  const description = String(raw.description ?? "").slice(0, 500);
  let desiredRetention: number | null = null;
  if (raw.desired_retention !== null && raw.desired_retention !== undefined) {
    const value = Number(raw.desired_retention);
    if (!Number.isFinite(value) || value < 0.7 || value > 0.99) {
      throw new ValidationError("desired_retention must be between 0.7 and 0.99");
    }
    desiredRetention = value;
  }
  const now = Date.now() / 1000;
  return {
    ...(raw as Record<string, unknown>),
    template_id: templateId,
    name,
    description,
    builtin: Boolean(raw.builtin ?? false),
    desired_retention: desiredRetention,
    intervals: validateReviewIntervals(raw.intervals),
    created_at: Number(raw.created_at ?? now) || now,
    updated_at: Number(raw.updated_at ?? now) || now,
  } as ReviewStrategyTemplate;
}

export function templateAsBinding(
  template: ReviewStrategyTemplate,
  boundAt?: number,
): ReviewStrategyBinding {
  return {
    template_id: template.template_id,
    name: template.name,
    builtin: template.builtin,
    desired_retention: template.desired_retention,
    intervals: template.intervals,
    bound_at: boundAt ?? Date.now() / 1000,
  };
}

export interface PendingOption {
  label: string;
  body: string;
  [k: string]: unknown;
}

export interface PendingQuestion {
  question_id: string;
  knowledge_point_id: string;
  module_id: string;
  prompt: string;
  question_type: string;
  expected_answer: string;
  options: PendingOption[];
  explanation: string;
  difficulty: string;
  source_evidence: Record<string, unknown>;
  assistance_used: boolean;
  assistance_context: Record<string, string>;
  created_at: number;
  visual_context: Record<string, unknown>;
  accepted_answers: string[];
  questions: PendingQuestion[];
  [k: string]: unknown;
}

export function emptyPendingQuestion(): PendingQuestion {
  return {
    question_id: "",
    knowledge_point_id: "",
    module_id: "",
    prompt: "",
    question_type: "short",
    expected_answer: "",
    options: [],
    explanation: "",
    difficulty: "",
    source_evidence: {},
    assistance_used: false,
    assistance_context: {},
    created_at: Date.now() / 1000,
    visual_context: {},
    accepted_answers: [],
    questions: [],
  };
}

export function normalizePendingQuestion(raw: unknown): PendingQuestion {
  const q = emptyPendingQuestion();
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return q;
  const r = raw as Record<string, unknown>;
  q.question_id = String(r.question_id ?? "");
  q.knowledge_point_id = String(r.knowledge_point_id ?? "");
  q.module_id = String(r.module_id ?? "");
  q.prompt = String(r.prompt ?? "");
  q.question_type = String(r.question_type ?? "short");
  q.expected_answer = String(r.expected_answer ?? "");
  q.explanation = String(r.explanation ?? "");
  q.difficulty = String(r.difficulty ?? "");
  q.source_evidence =
    r.source_evidence !== null && typeof r.source_evidence === "object" && !Array.isArray(r.source_evidence)
      ? (r.source_evidence as Record<string, unknown>)
      : {};
  q.assistance_used = Boolean(r.assistance_used ?? false);
  q.assistance_context =
    r.assistance_context !== null && typeof r.assistance_context === "object" && !Array.isArray(r.assistance_context)
      ? (r.assistance_context as Record<string, string>)
      : {};
  q.created_at = Number(r.created_at ?? Date.now() / 1000) || Date.now() / 1000;
  q.visual_context =
    r.visual_context !== null && typeof r.visual_context === "object" && !Array.isArray(r.visual_context)
      ? (r.visual_context as Record<string, unknown>)
      : {};
  q.accepted_answers = Array.isArray(r.accepted_answers)
    ? r.accepted_answers.map((a) => String(a))
    : [];
  q.options = Array.isArray(r.options)
    ? r.options.map((o) => {
        if (typeof o === "string") {
          const parsed = parseOptions([o]);
          const label = Object.keys(parsed)[0] ?? "";
          return { label, body: parsed[label] ?? o };
        }
        const opt = (o ?? {}) as Record<string, unknown>;
        return { label: String(opt.label ?? ""), body: String(opt.body ?? "") };
      })
    : [];
  q.questions = Array.isArray(r.questions)
    ? r.questions.map(normalizePendingQuestion)
    : [];
  return q;
}

export type InteractionStatus =
  | "registered"
  | "awaiting_input"
  | "answered"
  | "graded"
  | "abandoned";

export const ACTIVE_INTERACTION_STATES: InteractionStatus[] = [
  "registered",
  "awaiting_input",
  "answered",
];

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
  [k: string]: unknown;
}

export interface MasteryEvent {
  id: number;
  path_id: string;
  revision: number;
  event_type: string;
  payload: Record<string, unknown>;
  session_id: string;
  turn_id: string;
  created_at: number;
  [k: string]: unknown;
}

export interface MasteryPathLease {
  path_id: string;
  session_id: string;
  turn_id: string;
  acquired_at: number;
  [k: string]: unknown;
}

export type TopicSourceKind =
  | "goal"
  | "book"
  | "notebook"
  | "knowledge_base"
  | "file"
  | "chat"
  | "question_bank"
  | "cowriter"
  | "partner_group";

export interface TopicSource {
  id: string;
  kind: TopicSourceKind;
  source_id: string;
  label: string;
  excerpt: string;
  position: number;
  available: boolean;
  metadata: Record<string, unknown>;
  created_at: number;
  [k: string]: unknown;
}

export interface TopicMetadata {
  path_id: string;
  goal: string;
  description: string;
  emoji: string;
  map_seed: number;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface MasteryTopic {
  metadata: TopicMetadata;
  sources: TopicSource[];
  [k: string]: unknown;
}

export interface LearnerMasteryOverride {
  knowledge_point_id: string;
  note: string;
  created_at: number;
  [k: string]: unknown;
}

export interface DeferredObjective {
  knowledge_point_id: string;
  note: string;
  created_at: number;
  [k: string]: unknown;
}

export interface TeachingPreference {
  text: string;
  evidence: string;
  session_id: string;
  turn_id: string;
  updated_at: number;
  [k: string]: unknown;
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
  [k: string]: unknown;
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
  [k: string]: unknown;
}

export function emptyLearnerProfile(): LearnerProfile {
  return {
    prior_knowledge: "",
    target_level: "",
    time_budget: "",
    preferences: "",
    teaching_strategy: "probe_first",
    notes: "",
    teaching_preferences: {},
    teaching_observations: {},
    updated_at: Date.now() / 1000,
  };
}

export function normalizeLearnerProfile(raw: unknown): LearnerProfile | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const base = emptyLearnerProfile();
  const r = raw as Record<string, unknown>;
  for (const key of [
    "prior_knowledge",
    "target_level",
    "time_budget",
    "preferences",
    "notes",
  ] as const) {
    base[key] = String(r[key] ?? "");
  }
  base.teaching_strategy =
    r.teaching_strategy === "teach_first" ? "teach_first" : "probe_first";
  base.teaching_preferences =
    r.teaching_preferences !== null &&
    typeof r.teaching_preferences === "object" &&
    !Array.isArray(r.teaching_preferences)
      ? (r.teaching_preferences as Record<string, TeachingPreference>)
      : {};
  base.teaching_observations =
    r.teaching_observations !== null &&
    typeof r.teaching_observations === "object" &&
    !Array.isArray(r.teaching_observations)
      ? (r.teaching_observations as Record<string, TeachingObservation>)
      : {};
  base.updated_at = Number(r.updated_at ?? base.updated_at) || base.updated_at;
  return base;
}

export function learnerProfileIsEmpty(profile: LearnerProfile | null): boolean {
  if (profile === null) return true;
  return !(
    profile.prior_knowledge.trim() ||
    profile.target_level.trim() ||
    profile.time_budget.trim() ||
    profile.preferences.trim() ||
    profile.teaching_strategy !== "probe_first" ||
    profile.notes.trim() ||
    Object.keys(profile.teaching_preferences ?? {}).length > 0
  );
}

export interface LearningProgress {
  book_id: string;
  learner_profile: LearnerProfile | null;
  name: string;
  diagnostic: DiagnosticResult | null;
  modules: LearningModule[];
  current_module_id: string;
  current_stage: LearningStage;
  current_kp_index: number;
  mastery_levels: Record<string, number>;
  qualitative_mastery: Record<string, boolean>;
  knowledge_types: Record<string, KnowledgeType>;
  lesson_evidence: Record<string, Record<string, unknown>>;
  assessment_evidence: Record<string, Record<string, unknown>>;
  source_grounded: boolean;
  source_exposures: Record<string, unknown>[];
  quiz_attempts: QuizAttempt[];
  error_records: ErrorRecord[];
  learning_evidence: LearningEvidence[];
  desired_retention: number;
  review_strategy: ReviewStrategyBinding | null;
  repetition_states: Record<string, RepetitionState>;
  review_queue: ReviewTask[];
  learner_mastery_overrides: Record<string, LearnerMasteryOverride>;
  deferred_objectives: Record<string, DeferredObjective>;
  explained_objectives: Record<string, Record<string, unknown>>;
  pending_question: PendingQuestion | null;
  feynman_retries: Record<string, number>;
  feynman_explanations: Record<string, string>;
  stage_failure_counts: Record<string, number>;
  stage_failure_notes: Record<string, string>;
  version: number;
  created_at: number;
  updated_at: number;
  owner_session_id?: string;
  [k: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strRecord(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) {
      const n = Number(val);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  return out;
}

function boolRecord(v: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (isRecord(v)) {
    for (const [k, val] of Object.entries(v)) out[k] = Boolean(val);
  }
  return out;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export function normalizeKnowledgePoint(raw: unknown, moduleId = ""): KnowledgePoint {
  const r = isRecord(raw) ? raw : {};
  return {
    ...(r as Record<string, unknown>),
    id: String(r.id ?? ""),
    name: String(r.name ?? ""),
    type: normalizeKnowledgeType(r.type ?? "concept"),
    module_id: String(r.module_id ?? moduleId),
    prerequisite_ids: strList(r.prerequisite_ids),
    topic_source_ids: strList(r.topic_source_ids),
    required_visual_tasks: strList(r.required_visual_tasks),
  } as KnowledgePoint;
}

export function normalizeModule(raw: unknown, index = 0): LearningModule {
  const r = isRecord(raw) ? raw : {};
  const id = String(r.id ?? "");
  return {
    ...(r as Record<string, unknown>),
    id,
    name: String(r.name ?? ""),
    order: Number.isFinite(Number(r.order)) ? Number(r.order) : index,
    pass_threshold:
      typeof r.pass_threshold === "number" && Number.isFinite(r.pass_threshold)
        ? r.pass_threshold
        : 0.7,
    objective: String(r.objective ?? ""),
    knowledge_points: Array.isArray(r.knowledge_points)
      ? r.knowledge_points.map((kp) => normalizeKnowledgePoint(kp, id))
      : [],
  } as LearningModule;
}

export function normalizeRepetitionState(raw: unknown): RepetitionState {
  const r = isRecord(raw) ? raw : {};
  return {
    interval_index: Math.trunc(Number(r.interval_index ?? 0)) || 0,
    consecutive_correct: Math.trunc(Number(r.consecutive_correct ?? 0)) || 0,
    consecutive_wrong: Math.trunc(Number(r.consecutive_wrong ?? 0)) || 0,
    next_review_at: Number(r.next_review_at ?? 0) || 0,
    difficulty: Number(r.difficulty ?? 0.3) || 0.3,
    stability: Number(r.stability ?? 0) || 0,
    retrievability: Number(r.retrievability ?? 1) || 0,
    desired_retention: Number(r.desired_retention ?? 0.9) || 0.9,
    review_count: Math.trunc(Number(r.review_count ?? 0)) || 0,
    lapse_count: Math.trunc(Number(r.lapse_count ?? 0)) || 0,
    last_review_at: r.last_review_at === null || r.last_review_at === undefined ? null : Number(r.last_review_at) || null,
    last_scheduled_at:
      r.last_scheduled_at === null || r.last_scheduled_at === undefined
        ? null
        : Number(r.last_scheduled_at) || null,
    scheduled_after_failure: Boolean(r.scheduled_after_failure ?? false),
  } as RepetitionState;
}

export function normalizeProgress(raw: unknown): LearningProgress {
  const r = isRecord(raw) ? raw : {};
  const now = Date.now() / 1000;
  const retention = Number(r.desired_retention ?? 0.9);
  const progress: LearningProgress = {
    ...(r as Record<string, unknown>),
    book_id: String(r.book_id ?? ""),
    learner_profile: normalizeLearnerProfile(r.learner_profile),
    name: String(r.name ?? ""),
    diagnostic: isRecord(r.diagnostic) ? (r.diagnostic as DiagnosticResult) : null,
    modules: Array.isArray(r.modules)
      ? r.modules.map((m, i) => normalizeModule(m, i))
      : [],
    current_module_id: String(r.current_module_id ?? ""),
    current_stage: normalizeStage(r.current_stage),
    current_kp_index: Math.trunc(Number(r.current_kp_index ?? 0)) || 0,
    mastery_levels: numRecord(r.mastery_levels),
    qualitative_mastery: boolRecord(r.qualitative_mastery),
    knowledge_types: Object.fromEntries(
      Object.entries(isRecord(r.knowledge_types) ? r.knowledge_types : {}).map(
        ([k, v]) => [k, normalizeKnowledgeType(v)],
      ),
    ) as Record<string, KnowledgeType>,
    lesson_evidence: strRecord(r.lesson_evidence) as Record<string, Record<string, unknown>>,
    assessment_evidence: strRecord(r.assessment_evidence) as Record<
      string,
      Record<string, unknown>
    >,
    source_grounded: Boolean(r.source_grounded ?? false),
    source_exposures: Array.isArray(r.source_exposures)
      ? (r.source_exposures as Record<string, unknown>[])
      : [],
    quiz_attempts: Array.isArray(r.quiz_attempts)
      ? (r.quiz_attempts as QuizAttempt[])
      : [],
    error_records: Array.isArray(r.error_records)
      ? (r.error_records as ErrorRecord[])
      : [],
    learning_evidence: Array.isArray(r.learning_evidence)
      ? (r.learning_evidence as LearningEvidence[])
      : [],
    desired_retention:
      Number.isFinite(retention) && retention >= 0.7 && retention <= 0.99 ? retention : 0.9,
    review_strategy: isRecord(r.review_strategy)
      ? (r.review_strategy as ReviewStrategyBinding)
      : null,
    repetition_states: Object.fromEntries(
      Object.entries(isRecord(r.repetition_states) ? r.repetition_states : {}).map(
        ([k, v]) => [k, normalizeRepetitionState(v)],
      ),
    ) as Record<string, RepetitionState>,
    review_queue: Array.isArray(r.review_queue)
      ? (r.review_queue as ReviewTask[])
      : [],
    learner_mastery_overrides: strRecord(r.learner_mastery_overrides) as Record<
      string,
      LearnerMasteryOverride
    >,
    deferred_objectives: strRecord(r.deferred_objectives) as Record<
      string,
      DeferredObjective
    >,
    explained_objectives: strRecord(r.explained_objectives) as Record<
      string,
      Record<string, unknown>
    >,
    pending_question:
      r.pending_question === null || r.pending_question === undefined
        ? null
        : normalizePendingQuestion(r.pending_question),
    feynman_retries: numRecord(r.feynman_retries),
    feynman_explanations: Object.fromEntries(
      Object.entries(isRecord(r.feynman_explanations) ? r.feynman_explanations : {}).map(
        ([k, v]) => [k, String(v)],
      ),
    ) as Record<string, string>,
    stage_failure_counts: numRecord(r.stage_failure_counts),
    stage_failure_notes: Object.fromEntries(
      Object.entries(isRecord(r.stage_failure_notes) ? r.stage_failure_notes : {}).map(
        ([k, v]) => [k, String(v)],
      ),
    ) as Record<string, string>,
    version: Math.trunc(Number(r.version ?? 0)) || 0,
    created_at: Number(r.created_at ?? now) || now,
    updated_at: Number(r.updated_at ?? now) || now,
    owner_session_id: String(r.owner_session_id ?? ""),
  };
  return progress;
}

// ---- mastery.py — recency-weighted mastery score -------------------------

const RECENCY_WEIGHTS = [0.5, 0.7, 0.85, 0.95, 1.0];
const CONFIDENCE_CAP: Record<number, number> = { 1: 0.5, 2: 0.8 };

export function compute_mastery(correctness: Array<boolean | number>): number {
  if (!correctness.length) return 0.0;
  const recent = correctness.slice(-RECENCY_WEIGHTS.length);
  const weights = RECENCY_WEIGHTS.slice(-recent.length);
  const score =
    recent.reduce<number>(
      (sum, c, i) => sum + weights[i] * Math.max(0, Math.min(1, Number(c) || 0)),
      0,
    ) / weights.reduce((a, b) => a + b, 0);
  return Math.min(score, CONFIDENCE_CAP[recent.length] ?? 1.0);
}

// ---- pending.ts — public projection ---------------------------------------

const OPTION_PREFIX_RE = /^\s*([A-Z])\s*[.:：、)）-]\s*(.+)$/i;
const OPTION_PREFIX_RE_DOTALL = /^\s*([A-Z])\s*[.:：、)）-]\s*([\s\S]+)$/i;

export function positionalLabel(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
}

function optionTexts(options: string[]): string[] {
  return options.map((o) => String(o ?? "").trim()).filter(Boolean);
}

function splitLabelled(texts: string[]): [string[], string[]] | null {
  const labels: string[] = [];
  const bodies: string[] = [];
  for (const text of texts) {
    if (text.length === 1 && /[0-9A-Za-z]/.test(text)) {
      labels.push(text.toUpperCase());
      bodies.push(text);
      continue;
    }
    const match = OPTION_PREFIX_RE_DOTALL.exec(text);
    if (!match) return null;
    labels.push(match[1].toUpperCase());
    bodies.push(match[2].trim());
  }
  return [labels, bodies];
}

export function canonicalLabels(count: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < count; i += 1) out.add(positionalLabel(i));
  return out;
}

export function parseOptions(options: string[]): Record<string, string> {
  const texts = optionTexts(options);
  const split = splitLabelled(texts);
  if (split) {
    const [labels, bodies] = split;
    const canonical = canonicalLabels(labels.length);
    if (labels[0] === "A" && labels.every((l) => canonical.has(l)) && new Set(labels).size === labels.length) {
      const out: Record<string, string> = {};
      labels.forEach((l, i) => {
        out[l] = bodies[i];
      });
      return out;
    }
  }
  const out: Record<string, string> = {};
  texts.forEach((text, i) => {
    out[positionalLabel(i)] = text;
  });
  return out;
}

export function hasOptionBodies(options: Record<string, string>): boolean {
  const entries = Object.entries(options);
  return (
    entries.length >= 2 &&
    entries.every(([k, v]) => v.trim() && v.trim().toUpperCase() !== k.toUpperCase())
  );
}

export function resolveAnswer(answer: string, options: Record<string, string>): string {
  const candidate = String(answer ?? "").trim();
  if (!candidate) return "";
  const key = candidate.toUpperCase();
  if (key in options) return key;
  const prefixMatch = OPTION_PREFIX_RE.exec(candidate);
  if (prefixMatch && prefixMatch[1].toUpperCase() in options) {
    return prefixMatch[1].toUpperCase();
  }
  const needle = candidate.toLowerCase();
  const exact = Object.keys(options).filter((l) => options[l].toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const contained = Object.keys(options).filter((l) => options[l].toLowerCase().includes(needle));
  return contained.length === 1 ? contained[0] : "";
}

export interface PublicPendingOption {
  id: string;
  label: string;
  body: string;
}

export interface PublicPendingQuestion {
  question_id: string;
  prompt: string;
  question_type: string;
  options: PublicPendingOption[];
  questions?: PublicPendingQuestion[];
  [k: string]: unknown;
}

// decode_escaped_unicode_for_display: unescape \uXXXX sequences for display.
export function decodeEscapedUnicode(text: string): string {
  return String(text ?? "").replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

export function publicPendingQuestion(pending: PendingQuestion): PublicPendingQuestion {
  const options: PublicPendingOption[] =
    pending.question_type === "choice"
      ? pending.options.map((o) => ({
          id: o.label,
          label: decodeEscapedUnicode(o.label),
          body: decodeEscapedUnicode(o.body),
        }))
      : [];
  const result: PublicPendingQuestion = {
    question_id: pending.question_id,
    prompt: decodeEscapedUnicode(pending.prompt),
    question_type: pending.question_type,
    options,
  };
  if (pending.questions.length) {
    result.questions = pending.questions.map(publicPendingQuestion);
  }
  return result;
}

// ---- reading records --------------------------------------------------------

export interface ReadingProgressRecord {
  material_id: string;
  latest_locator: number;
  latest_percentage: number;
  furthest_locator: number;
  furthest_percentage: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface ReadingActivityRecord {
  activity_id: string;
  material_id: string;
  extension_id: string;
  action: string;
  locator: number;
  result_type: string;
  created_at: number;
  [k: string]: unknown;
}

export interface ReadingLearningRecords {
  progress: ReadingProgressRecord[];
  activities: ReadingActivityRecord[];
}

export const __testing = { REVIEW_INTERVAL_MAX_DAYS };
