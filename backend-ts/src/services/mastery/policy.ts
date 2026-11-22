// Port of deeptutor/learning/policy.py — pure decisions over a progress
// aggregate. No I/O, no LLM calls.
import {
  KnowledgePoint,
  KnowledgeType,
  LearningEvidence,
  LearningProgress,
  LearningModule,
  PublicPendingQuestion,
  publicPendingQuestion,
} from "./models.js";
import { schedulerForProgress } from "./review_strategy.js";
import { reviewSortKey, SpacedRepetitionScheduler } from "./scheduler.js";

export const QUANTITATIVE_GATE: Partial<Record<KnowledgeType, number>> = {
  memory: 0.9,
  procedure: 0.9,
};

export const QUALITATIVE_TYPES: KnowledgeType[] = ["concept", "design"];
const QUALITATIVE_SET = new Set<KnowledgeType>(QUALITATIVE_TYPES);
const QUALITATIVE_PASS_DISPLAY = 1.0;

export function pathDisplayName(progress: LearningProgress): string {
  const named = String(progress.name ?? "").trim();
  if (named) return named;
  const firstModule = progress.modules?.length
    ? String(progress.modules[0].name ?? "").trim()
    : "";
  return firstModule || progress.book_id;
}

export function gateThreshold(kpType: KnowledgeType): number {
  if (QUALITATIVE_SET.has(kpType)) return QUALITATIVE_PASS_DISPLAY;
  return QUANTITATIVE_GATE[kpType] ?? 0.9;
}

export function visualAchievements(progress: LearningProgress, kpId: string): string[] {
  const tasks = new Set<string>();
  for (const event of progress.learning_evidence ?? []) {
    if (
      event.knowledge_point_id === kpId &&
      event.result === "correct" &&
      event.visual_context?.task &&
      event.visual_context?.key_status === "verified" &&
      !(event.hints_used ?? 0)
    ) {
      tasks.add(String(event.visual_context.task));
    }
  }
  return [...tasks].sort();
}

export function isAssessedMastered(
  progress: LearningProgress,
  kp: KnowledgePoint,
): boolean {
  const required = new Set(kp.required_visual_tasks ?? []);
  const achieved = new Set(visualAchievements(progress, kp.id));
  for (const task of required) {
    if (!achieved.has(task)) return false;
  }
  if (QUALITATIVE_SET.has(kp.type)) {
    return Boolean(progress.qualitative_mastery?.[kp.id]);
  }
  return (progress.mastery_levels?.[kp.id] ?? 0) >= gateThreshold(kp.type);
}

export function learningStage(progress: LearningProgress, kpId: string): string {
  const attempts = (progress.quiz_attempts ?? []).filter(
    (a) => a.knowledge_point_id === kpId && !a.voided,
  );
  const evidence = (progress.learning_evidence ?? []).filter(
    (e) => e.knowledge_point_id === kpId,
  );
  if (
    attempts.some((a) => a.independent && a.is_correct) ||
    evidence.some(
      (e) =>
        e.assessment_type === "qualitative" &&
        e.result === "correct" &&
        !(e.hints_used ?? 0),
    )
  ) {
    return "independently_demonstrated";
  }
  if (
    attempts.some((a) => !a.independent) ||
    evidence.some((e) => (e.hints_used ?? 0) > 0)
  ) {
    return "practiced_with_help";
  }
  if (attempts.length || evidence.length) return "practiced_not_demonstrated";
  const explained = progress.explained_objectives?.[kpId];
  if (!explained) return "not_yet_covered";
  if (
    explained.coverage === "partial" &&
    explained.explanation_quote &&
    (explained.delivery as { turn_id?: unknown } | null | undefined)?.turn_id
  ) {
    return "partially_explained";
  }
  return "teaching_record_unverified";
}

export function masterySource(
  progress: LearningProgress,
  kp: KnowledgePoint,
): "system" | "learner" | "" {
  if (isAssessedMastered(progress, kp)) return "system";
  if (kp.id in (progress.learner_mastery_overrides ?? {})) return "learner";
  return "";
}

export function isMastered(progress: LearningProgress, kp: KnowledgePoint): boolean {
  return Boolean(masterySource(progress, kp));
}

export function displayMastery(progress: LearningProgress, kp: KnowledgePoint): number {
  if (QUALITATIVE_SET.has(kp.type) && progress.qualitative_mastery?.[kp.id]) {
    return QUALITATIVE_PASS_DISPLAY;
  }
  return Number(progress.mastery_levels?.[kp.id] ?? 0) || 0;
}

export function objectiveStatus(
  progress: LearningProgress,
  kp: KnowledgePoint,
): "mastered" | "learning" | "new" {
  if (isMastered(progress, kp)) return "mastered";
  const seen =
    (progress.quiz_attempts ?? []).some((a) => a.knowledge_point_id === kp.id) ||
    kp.id in (progress.qualitative_mastery ?? {});
  return seen ? "learning" : "new";
}

export function reviewableTasks(progress: LearningProgress) {
  const masteredIds = new Set<string>();
  for (const module of progress.modules ?? []) {
    for (const kp of module.knowledge_points ?? []) {
      if (isMastered(progress, kp)) masteredIds.add(kp.id);
    }
  }
  return (progress.review_queue ?? []).filter((t) =>
    masteredIds.has(t.knowledge_point_id),
  );
}

function cmpReviewKey(a: { forgetting_risk: number; due_at: number; priority: number }, b: { forgetting_risk: number; due_at: number; priority: number }, now: number): number {
  const ka = reviewSortKey(a, now);
  const kb = reviewSortKey(b, now);
  return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
}

export function dueReviews(progress: LearningProgress, now?: number) {
  const moment = now ?? Date.now() / 1000;
  const due = reviewableTasks(progress).filter((t) => t.due_at <= moment);
  due.sort((a, b) => cmpReviewKey(a, b, moment));
  return due;
}

export interface NextStep {
  action: string;
  module_id: string;
  module_name: string;
  knowledge_point_id: string;
  knowledge_point_name: string;
  knowledge_point_type: string;
  status: string;
  gate: string;
  mastery: number;
  threshold: number;
  reason: string;
  forgetting_risk: number;
  pending_prompt: string;
  pending_question: PublicPendingQuestion | null;
  session_id: string;
  [k: string]: unknown;
}

function nextStepToDict(step: NextStep): Record<string, unknown> {
  return {
    action: step.action,
    module_id: step.module_id,
    module_name: step.module_name,
    knowledge_point_id: step.knowledge_point_id,
    knowledge_point_name: step.knowledge_point_name,
    knowledge_point_type: step.knowledge_point_type,
    status: step.status,
    gate: step.gate,
    mastery: Math.round(step.mastery * 1000) / 1000,
    threshold: Math.round(step.threshold * 1000) / 1000,
    reason: step.reason,
    forgetting_risk: Math.round(step.forgetting_risk * 1000) / 1000,
    pending_prompt: step.pending_prompt,
    pending_question:
      step.pending_question !== null ? step.pending_question : null,
    session_id: step.session_id,
  };
}

export function findKnowledgePoint(
  progress: LearningProgress,
  kpId: string,
): { kp: KnowledgePoint | null; moduleId: string; moduleName: string } {
  for (const module of progress.modules ?? []) {
    for (const kp of module.knowledge_points ?? []) {
      if (kp.id === kpId) return { kp, moduleId: module.id, moduleName: module.name };
    }
  }
  return { kp: null, moduleId: "", moduleName: "" };
}

export function gateKind(kp: KnowledgePoint | null): string {
  return kp !== null && QUALITATIVE_SET.has(kp.type) ? "qualitative" : "quantitative";
}

export function nextObjective(
  progress: LearningProgress,
  opts?: { now?: number; pending_session_id?: string },
): NextStep {
  const pending = progress.pending_question;
  if (pending !== null && pending !== undefined) {
    const { kp, moduleId, moduleName } = findKnowledgePoint(
      progress,
      pending.knowledge_point_id,
    );
    return {
      action: "answer_pending",
      module_id: moduleId || pending.module_id || "",
      module_name: moduleName,
      knowledge_point_id: pending.knowledge_point_id,
      knowledge_point_name: kp?.name ?? "",
      knowledge_point_type: kp?.type ?? "",
      status: kp ? objectiveStatus(progress, kp) : "learning",
      gate: kp ? gateKind(kp) : "",
      mastery: kp ? displayMastery(progress, kp) : 0,
      threshold: kp ? gateThreshold(kp.type) : 0,
      reason:
        "A posed question is awaiting the learner's answer; grade it with mastery_grade.",
      forgetting_risk: 0,
      pending_prompt: pending.prompt ?? "",
      pending_question: publicPendingQuestion(pending),
      session_id: String(opts?.pending_session_id ?? ""),
    };
  }

  const deferredIds = new Set(Object.keys(progress.deferred_objectives ?? {}));
  const due = dueReviews(progress, opts?.now).filter(
    (t) => !deferredIds.has(t.knowledge_point_id),
  );
  if (due.length) {
    const { kp, moduleId, moduleName } = findKnowledgePoint(
      progress,
      due[0].knowledge_point_id,
    );
    if (kp) {
      const task = due[0];
      return {
        action: "review",
        module_id: moduleId,
        module_name: moduleName,
        knowledge_point_id: kp.id,
        knowledge_point_name: kp.name,
        knowledge_point_type: kp.type,
        status: objectiveStatus(progress, kp),
        gate: gateKind(kp),
        mastery: displayMastery(progress, kp),
        threshold: gateThreshold(kp.type),
        reason: task.reason || "This objective is due for spaced-repetition review.",
        forgetting_risk: task.forgetting_risk,
        pending_prompt: "",
        pending_question: null,
        session_id: "",
      };
    }
  }

  const teachFirst = progress.learner_profile?.teaching_strategy === "teach_first";
  let deferredFallback: NextStep | null = null;
  const modules = [...(progress.modules ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  for (const module of modules) {
    for (const kp of module.knowledge_points ?? []) {
      if (isMastered(progress, kp)) continue;
      const status = objectiveStatus(progress, kp);
      const gate = gateKind(kp);
      let action: string;
      if (status === "new") {
        action = teachFirst ? "teach" : "probe";
      } else if (gate === "qualitative") {
        action = "assess";
      } else {
        action = "practice";
      }
      const step: NextStep = {
        action,
        module_id: module.id,
        module_name: module.name,
        knowledge_point_id: kp.id,
        knowledge_point_name: kp.name,
        knowledge_point_type: kp.type,
        status,
        gate,
        mastery: displayMastery(progress, kp),
        threshold: gateThreshold(kp.type),
        reason:
          status === "new"
            ? action === "teach"
              ? "Untouched objective — teach before assessing, as the learner requested."
              : "Untouched objective — probe first to let the learner test out."
            : "Objective is below its mastery gate; keep working it until it clears.",
        forgetting_risk: 0,
        pending_prompt: "",
        pending_question: null,
        session_id: "",
      };
      if (deferredIds.has(kp.id)) {
        if (deferredFallback === null) deferredFallback = step;
        continue;
      }
      return step;
    }
  }
  if (deferredFallback !== null) return deferredFallback;
  return {
    action: "complete",
    module_id: "",
    module_name: "",
    knowledge_point_id: "",
    knowledge_point_name: "",
    knowledge_point_type: "",
    status: "",
    gate: "",
    mastery: 0,
    threshold: 0,
    reason: "All objectives are mastered and no reviews are due.",
    forgetting_risk: 0,
    pending_prompt: "",
    pending_question: null,
    session_id: "",
  };
}

export function mapSummary(progress: LearningProgress, now?: number): Record<string, unknown> {
  const counts = { mastered: 0, learning: 0, new: 0, total: 0 };
  const modulesOut: Record<string, unknown>[] = [];
  const modules = [...(progress.modules ?? [])].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );
  for (const module of modules) {
    const kpsOut: Record<string, unknown>[] = [];
    let mastered = 0;
    for (const kp of module.knowledge_points ?? []) {
      const status = objectiveStatus(progress, kp);
      counts[status] += 1;
      counts.total += 1;
      if (status === "mastered") mastered += 1;
      const override = progress.learner_mastery_overrides?.[kp.id];
      kpsOut.push({
        id: kp.id,
        name: kp.name,
        type: kp.type,
        prerequisite_ids: [...(kp.prerequisite_ids ?? [])],
        topic_source_ids: [...(kp.topic_source_ids ?? [])],
        status,
        mastery: Math.round(displayMastery(progress, kp) * 1000) / 1000,
        mastery_source: masterySource(progress, kp),
        override_note: override?.note ?? "",
        deferred: kp.id in (progress.deferred_objectives ?? {}),
      });
    }
    modulesOut.push({
      id: module.id,
      name: module.name,
      objective: module.objective ?? "",
      order: module.order,
      mastered,
      total: (module.knowledge_points ?? []).length,
      knowledge_points: kpsOut,
    });
  }
  return {
    name: pathDisplayName(progress),
    counts,
    due_reviews: dueReviews(progress, now).length,
    complete: counts.total > 0 && counts.mastered === counts.total,
    modules: modulesOut,
  };
}

function reviewReport(
  progress: LearningProgress,
  kpId: string,
  state: import("./models.js").RepetitionState | undefined,
  dueAt: number | null,
  now: number,
): Record<string, unknown> | null {
  if (!state) return null;
  const task = (progress.review_queue ?? []).find(
    (t) => t.knowledge_point_id === kpId,
  );
  const scheduler = schedulerForProgress(progress);
  const recall = scheduler.retrievability(state, now);
  const risk =
    task?.forgetting_risk ??
    scheduler.forgettingRisk(state, progress, kpId, now);
  const reason =
    task?.reason ??
    scheduler.reviewReason(state, progress, kpId, { now });
  return {
    due_at: dueAt,
    interval_index: state.interval_index,
    consecutive_correct: state.consecutive_correct,
    consecutive_wrong: state.consecutive_wrong,
    stability: Math.round(state.stability * 1000) / 1000,
    retrievability: Math.round(recall * 1000) / 1000,
    desired_retention: state.desired_retention,
    lapse_count: state.lapse_count,
    forgetting_risk: Math.round(risk * 1000) / 1000,
    reason,
    recent_failure: Boolean(
      state.consecutive_wrong ||
        (progress.error_records ?? []).some(
          (r) =>
            r.knowledge_point_id === kpId &&
            (r.status === "active" || r.status === "retrying"),
        ),
    ),
  };
}

export function objectiveReport(
  progress: LearningProgress,
  kpId: string,
  now?: number,
): Record<string, unknown> | null {
  const { kp, moduleId, moduleName } = findKnowledgePoint(progress, kpId);
  if (!kp) return null;
  const attempts = (progress.quiz_attempts ?? [])
    .filter((a) => a.knowledge_point_id === kpId)
    .map((a) => ({
      question_id: a.question_id,
      is_correct: a.is_correct,
      independent: a.independent,
      answer: String(a.user_answer ?? ""),
      error_type: a.error_type ?? "",
      at: a.timestamp,
    }));
  const state = progress.repetition_states?.[kpId];
  const dueAt =
    (progress.review_queue ?? []).find((t) => t.knowledge_point_id === kpId)
      ?.due_at ?? null;
  const moment = now ?? Date.now() / 1000;
  const override = progress.learner_mastery_overrides?.[kpId];
  return {
    id: kp.id,
    name: kp.name,
    type: kp.type,
    module_id: moduleId,
    module_name: moduleName,
    status: objectiveStatus(progress, kp),
    gate: gateKind(kp),
    mastered: isMastered(progress, kp),
    assessed_mastered: isAssessedMastered(progress, kp),
    mastery_source: masterySource(progress, kp),
    override_note: override?.note ?? "",
    mastery: Math.round(displayMastery(progress, kp) * 1000) / 1000,
    threshold: Math.round(gateThreshold(kp.type) * 1000) / 1000,
    attempts,
    correct_count: attempts.filter((a) => a.is_correct).length,
    explanation: progress.feynman_explanations?.[kpId] ?? "",
    explained: progress.explained_objectives?.[kpId] ?? null,
    required_visual_tasks: [...(kp.required_visual_tasks ?? [])],
    demonstrated_visual_tasks: visualAchievements(progress, kpId),
    review: reviewReport(progress, kpId, state, dueAt, moment),
    errors: (progress.error_records ?? [])
      .filter((r) => r.knowledge_point_id === kpId)
      .map((r) => ({
        id: r.id,
        error_type: r.error_type,
        status: r.status,
        self_attribution: r.self_attribution,
        retries: (r.retry_history ?? []).length,
        created_at: r.created_at,
      })),
  };
}

export { nextStepToDict };
export type { LearningModule, LearningEvidence };
