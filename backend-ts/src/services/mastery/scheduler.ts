// Port of deeptutor/learning/scheduler.py — the retention scheduler.
import {
  KnowledgeType,
  LearningEvidence,
  LearningProgress,
  RepetitionState,
  ReviewTask,
  normalizeRepetitionState,
} from "./models.js";

export const INTERVAL_SEQUENCES: Record<KnowledgeType, number[]> = {
  memory: [0, 1, 3, 7, 14, 30, 60],
  concept: [3, 7, 14, 30],
  procedure: [3, 7, 14],
  design: [14, 28],
};

const TYPE_PRIORITY: Record<KnowledgeType, number> = {
  memory: 2,
  concept: 3,
  procedure: 4,
  design: 5,
};

const TYPE_DIFFICULTY: Record<KnowledgeType, number> = {
  memory: 0.3,
  concept: 0.4,
  procedure: 0.5,
  design: 0.6,
};

export const DEFAULT_DESIRED_RETENTION = 0.9;
export const MIN_DESIRED_RETENTION = 0.7;
export const MAX_DESIRED_RETENTION = 0.99;
const MIN_STABILITY_DAYS = 0.5;
const FAIL_QUALITY = 0.5;
const EPS = 1e-6;
const SAME_SESSION_DAYS = 0.25;
const EVIDENCE_SOURCE_LABELS: Record<string, string> = {
  deep_question: "Question Bank",
  immersive_reading: "Reading",
  book: "Book",
  partner_chat: "Study Partner",
  import: "Imported",
};

export function validateDesiredRetention(value: number): number {
  const desired = Number(value);
  if (
    !Number.isFinite(desired) ||
    desired < MIN_DESIRED_RETENTION ||
    desired > MAX_DESIRED_RETENTION
  ) {
    throw new Error(
      `desired_retention must be between ${MIN_DESIRED_RETENTION} and ${MAX_DESIRED_RETENTION}`,
    );
  }
  return desired;
}

function errorKpIds(progress: LearningProgress): Set<string> {
  return new Set(
    progress.error_records
      .filter((r) => r.status === "active" || r.status === "retrying")
      .map((r) => r.knowledge_point_id),
  );
}

export function reviewSortKey(
  task: { forgetting_risk: number; due_at: number; priority: number },
  now: number,
): [number, number, number] {
  const overdue = Math.max(0, now - task.due_at);
  return [-task.forgetting_risk, -overdue, task.priority];
}

function cmpTuple(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function normalizeIntervalSequences(
  intervalSequences?: Partial<Record<KnowledgeType, number[]>> | null,
): Record<KnowledgeType, number[]> {
  const sequences = {} as Record<KnowledgeType, number[]>;
  for (const kt of Object.keys(INTERVAL_SEQUENCES) as KnowledgeType[]) {
    sequences[kt] = INTERVAL_SEQUENCES[kt].map((d) => Number(d));
  }
  if (intervalSequences) {
    for (const [kt, rounds] of Object.entries(intervalSequences)) {
      if (rounds) sequences[kt as KnowledgeType] = rounds.map((d) => Number(d));
    }
  }
  return sequences;
}

export class SpacedRepetitionScheduler {
  readonly DEBUG_MODE: boolean;
  desired_retention: number;
  private readonly _intervalSequences: Record<KnowledgeType, number[]>;

  constructor(opts?: {
    desired_retention?: number;
    interval_sequences?: Partial<Record<KnowledgeType, number[]>> | null;
  }) {
    const debug = (process.env.LEARNING_DEBUG ?? "").toLowerCase();
    this.DEBUG_MODE = debug === "1" || debug === "true" || debug === "yes";
    this.desired_retention = validateDesiredRetention(
      opts?.desired_retention ?? DEFAULT_DESIRED_RETENTION,
    );
    this._intervalSequences = normalizeIntervalSequences(opts?.interval_sequences);
  }

  get intervalSequences(): Record<KnowledgeType, number[]> {
    const out = {} as Record<KnowledgeType, number[]>;
    for (const kt of Object.keys(this._intervalSequences) as KnowledgeType[]) {
      out[kt] = [...this._intervalSequences[kt]];
    }
    return out;
  }

  private _rounds(knowledgeType: KnowledgeType): number[] {
    return this._intervalSequences[knowledgeType] ?? INTERVAL_SEQUENCES.memory;
  }

  private _usesCustomIntervals(knowledgeType: KnowledgeType): boolean {
    const rounds = this._rounds(knowledgeType);
    const base = INTERVAL_SEQUENCES[knowledgeType] ?? [];
    return (
      rounds.length !== base.length ||
      rounds.some((d, i) => d !== Number(base[i]))
    );
  }

  private _secondsPerUnit(): number {
    return this.DEBUG_MODE ? 1.0 : 86400.0;
  }

  private static _stabilityFromInterval(
    intervalDays: number,
    desiredRetention: number,
  ): number {
    const retention = Math.min(Math.max(desiredRetention, EPS), 1.0 - EPS);
    if (intervalDays <= 0) return MIN_STABILITY_DAYS;
    return Math.max(MIN_STABILITY_DAYS, intervalDays / -Math.log(retention));
  }

  private static _intervalFromStability(
    stability: number,
    desiredRetention: number,
  ): number {
    const retention = Math.min(Math.max(desiredRetention, EPS), 1.0 - EPS);
    return Math.max(EPS, Math.max(stability, EPS) * -Math.log(retention));
  }

  private _scheduledIntervalDays(
    state: RepetitionState,
    knowledgeType: KnowledgeType,
  ): number {
    const rounds = this._rounds(knowledgeType);
    if (state.review_count === 0 && rounds[0] === 0) return 0.0;
    let intervalDays = SpacedRepetitionScheduler._intervalFromStability(
      state.stability,
      state.desired_retention,
    );
    if (this._usesCustomIntervals(knowledgeType)) {
      const configured = Number(
        rounds[Math.min(state.review_count, rounds.length - 1)],
      );
      const target = SpacedRepetitionScheduler._intervalFromStability(
        SpacedRepetitionScheduler._stabilityFromInterval(
          configured,
          DEFAULT_DESIRED_RETENTION,
        ),
        state.desired_retention,
      );
      if (!state.scheduled_after_failure) return target;
      intervalDays = Math.min(intervalDays, target);
    }
    if (state.scheduled_after_failure) {
      intervalDays = Math.min(
        intervalDays,
        Math.max(intervalDays * 0.5, MIN_STABILITY_DAYS * 0.2),
      );
    }
    return intervalDays;
  }

  hydrate(state: RepetitionState, knowledgeType: KnowledgeType): RepetitionState {
    const s = normalizeRepetitionState(state);
    Object.assign(state, s);
    if (state.stability > 0) {
      if (state.difficulty <= 0) {
        state.difficulty = TYPE_DIFFICULTY[knowledgeType] ?? 0.3;
      }
      return state;
    }
    const intervals = this._rounds(knowledgeType);
    const maxIndex = intervals.length - 1;
    state.interval_index = Math.max(0, Math.min(state.interval_index, maxIndex));
    state.desired_retention = state.desired_retention || DEFAULT_DESIRED_RETENTION;
    state.stability = SpacedRepetitionScheduler._stabilityFromInterval(
      Number(intervals[state.interval_index] ?? intervals[0]),
      state.desired_retention,
    );
    state.difficulty = TYPE_DIFFICULTY[knowledgeType] ?? 0.3;
    if (state.retrievability <= 0) state.retrievability = 1.0;
    return state;
  }

  getInitialState(
    knowledgeType: KnowledgeType,
    opts?: { now?: number; desired_retention?: number | null },
  ): RepetitionState {
    const intervals = this._rounds(knowledgeType);
    const firstInterval = Number(intervals[0]);
    const moment = opts?.now ?? Date.now() / 1000;
    const desired =
      opts?.desired_retention === null || opts?.desired_retention === undefined
        ? this.desired_retention
        : validateDesiredRetention(opts.desired_retention);
    const stability = SpacedRepetitionScheduler._stabilityFromInterval(
      firstInterval,
      DEFAULT_DESIRED_RETENTION,
    );
    const initialInterval =
      firstInterval === 0
        ? firstInterval
        : SpacedRepetitionScheduler._intervalFromStability(stability, desired);
    return {
      interval_index: 0,
      consecutive_correct: 0,
      consecutive_wrong: 0,
      next_review_at: moment + initialInterval * this._secondsPerUnit(),
      difficulty: TYPE_DIFFICULTY[knowledgeType] ?? 0.3,
      stability,
      retrievability: 1.0,
      desired_retention: desired,
      review_count: 0,
      lapse_count: 0,
      last_review_at: null,
      last_scheduled_at: moment,
      scheduled_after_failure: false,
    };
  }

  scheduleNext(
    state: RepetitionState,
    knowledgeType: KnowledgeType,
    isCorrect: boolean,
  ): RepetitionState {
    const evidence: LearningEvidence = {
      evidence_id: "",
      question_id: "",
      knowledge_point_id: "",
      timestamp: Date.now() / 1000,
      source: "mastery_path",
      assessment_type: "review",
      result: isCorrect ? "correct" : "incorrect",
      quality: isCorrect ? 1.0 : 0.0,
      hints_used: 0,
      attempt_count: 1,
      confidence: null,
      learner_answer: "",
      feedback: "",
      reference_answer: "",
      response_time: null,
      session_id: "",
      turn_id: "",
      visual_context: {},
    } as LearningEvidence;
    return this.scheduleReview(state, knowledgeType, evidence);
  }

  scheduleReview(
    state: RepetitionState,
    knowledgeType: KnowledgeType,
    evidence: LearningEvidence,
    opts?: { now?: number },
  ): RepetitionState {
    this.hydrate(state, knowledgeType);
    const eventMoment = opts?.now ?? evidence.timestamp ?? Date.now() / 1000;
    const moment =
      state.last_review_at !== null && state.last_review_at !== undefined
        ? Math.max(eventMoment, state.last_review_at)
        : eventMoment;
    const quality = resolvedQuality(evidence);
    const intervals = this._rounds(knowledgeType);
    const maxIndex = intervals.length - 1;

    const previousStability = Math.max(state.stability, EPS);
    const previousRetrievability = this.retrievability(state, moment);
    const elapsedDays =
      state.last_review_at !== null && state.last_review_at !== undefined
        ? Math.max(0, moment - state.last_review_at) / this._secondsPerUnit()
        : 0.0;
    const sameSessionDays = Math.min(
      SAME_SESSION_DAYS,
      SpacedRepetitionScheduler._intervalFromStability(
        previousStability,
        DEFAULT_DESIRED_RETENTION,
      ) * 0.5,
    );
    if (
      state.last_review_at !== null &&
      state.last_review_at !== undefined &&
      elapsedDays < sameSessionDays
    ) {
      if (quality >= FAIL_QUALITY) {
        state.review_count += 1;
        state.last_review_at = moment;
        state.retrievability = 1.0;
        state.consecutive_wrong = 0;
        return state;
      }
      if (
        state.scheduled_after_failure &&
        (evidence.result === "partial" || evidence.assessment_type === "qualitative")
      ) {
        state.review_count += 1;
        state.last_review_at = moment;
        state.retrievability = Math.max(quality, 0.2);
        return state;
      }
    }
    const spacingRatio = Math.min(elapsedDays / previousStability, 4.0);

    const outcomeError = 1.0 - quality - state.difficulty;
    const surprise = previousRetrievability - quality;
    state.difficulty = Math.min(
      0.95,
      Math.max(0.05, state.difficulty + 0.12 * outcomeError + 0.08 * surprise),
    );

    if (quality < FAIL_QUALITY) {
      state.consecutive_wrong += 1;
      state.consecutive_correct = 0;
      state.lapse_count += 1;
      const retentionFactor = 0.55 - 0.25 * previousRetrievability;
      const difficultyFactor = 1.0 - 0.25 * state.difficulty;
      state.stability = Math.max(
        MIN_STABILITY_DAYS * 0.1,
        previousStability * retentionFactor * difficultyFactor,
      );
      state.retrievability = Math.max(quality, 0.2);
      if (state.consecutive_wrong >= 2) state.consecutive_wrong = 0;
    } else {
      state.consecutive_wrong = 0;
      state.consecutive_correct += 1;
      const retrievalEffort = 1.0 + (1.0 - previousRetrievability) * 1.5;
      const spacingBonus = 1.0 + spacingRatio * 0.15;
      const learnability = 1.35 - 0.6 * state.difficulty;
      const qualityStrength = Math.max(
        0,
        (quality - FAIL_QUALITY) / (1.0 - FAIL_QUALITY),
      );
      let growth =
        1.0 + qualityStrength * learnability * retrievalEffort * spacingBonus;
      if (quality >= 0.8 && state.consecutive_correct >= 2) growth *= 1.15;
      state.stability = Math.max(MIN_STABILITY_DAYS, previousStability * growth);
      state.retrievability = 1.0;
      if (state.consecutive_correct >= 2) state.consecutive_correct = 0;
    }

    state.review_count += 1;
    state.last_review_at = moment;
    state.last_scheduled_at = moment;
    state.scheduled_after_failure = quality < FAIL_QUALITY;
    const intervalDays = this._scheduledIntervalDays(state, knowledgeType);
    state.next_review_at = moment + intervalDays * this._secondsPerUnit();
    state.interval_index = snapIntervalIndex(intervals, intervalDays, maxIndex);
    return state;
  }

  retrievability(state: RepetitionState, now?: number): number {
    const moment = now ?? Date.now() / 1000;
    const stability = Math.max(state.stability, EPS);
    const anchor =
      state.last_review_at !== null && state.last_review_at !== undefined
        ? state.last_review_at
        : state.next_review_at;
    const elapsedDays = Math.max(0, moment - anchor) / this._secondsPerUnit();
    return Math.min(1.0, Math.max(0.0, Math.exp(-elapsedDays / stability)));
  }

  forgettingRisk(
    state: RepetitionState,
    progress: LearningProgress,
    kpId: string,
    now?: number,
  ): number {
    const moment = now ?? Date.now() / 1000;
    const recall = this.retrievability(state, moment);
    let risk = 1.0 - recall;
    if (moment > state.next_review_at) {
      const overdueDays = (moment - state.next_review_at) / this._secondsPerUnit();
      risk += Math.min(overdueDays / 7.0, 0.25);
    }
    if (errorKpIds(progress).has(kpId)) risk += 0.2;
    if (state.lapse_count) risk += Math.min(0.1 * state.lapse_count, 0.2);
    return Math.min(1.0, Math.max(0.0, risk));
  }

  reviewReason(
    state: RepetitionState,
    progress: LearningProgress,
    kpId: string,
    opts?: { now?: number; latest_evidence?: LearningEvidence | null },
  ): string {
    const moment = opts?.now ?? Date.now() / 1000;
    const unit = this._secondsPerUnit();
    const recall = this.retrievability(state, moment);
    const parts: string[] = [];
    const delta = moment - state.next_review_at;
    if (delta >= unit) parts.push(`due ${formatSpan(delta / unit)} ago`);
    else if (delta >= 0) parts.push("due now");
    else parts.push(`due in ${formatSpan(-delta / unit)}`);
    const desired = state.desired_retention || DEFAULT_DESIRED_RETENTION;
    if (recall + 1e-9 < desired) {
      parts.push(`retrievability ${(recall * 100).toFixed(0)}% below ${(desired * 100).toFixed(0)}% target`);
    } else {
      parts.push(`retrievability ${(recall * 100).toFixed(0)}%`);
    }
    const failures =
      state.consecutive_wrong + (errorKpIds(progress).has(kpId) ? 1 : 0);
    if (state.lapse_count) {
      parts.push(`${state.lapse_count} lapse${state.lapse_count !== 1 ? "s" : ""}`);
    } else if (failures) {
      parts.push("recent failure");
    }
    const latest = opts?.latest_evidence;
    if (latest) {
      const source = EVIDENCE_SOURCE_LABELS[latest.source];
      if (source) parts.push(`latest ${source} assessment: ${latest.result}`);
    }
    return parts.join("; ") + ".";
  }

  getDueTasks(progress: LearningProgress, maxTasks = 5): ReviewTask[] {
    const now = Date.now() / 1000;
    const due = progress.review_queue.filter((t) => t.due_at <= now);
    due.sort((a, b) => cmpTuple(reviewSortKey(a, now), reviewSortKey(b, now)));
    return due.slice(0, maxTasks);
  }

  buildReviewQueue(progress: LearningProgress, now?: number): ReviewTask[] {
    const moment = now ?? Date.now() / 1000;
    const errors = errorKpIds(progress);
    const latestEvidence = new Map<string, LearningEvidence>();
    for (const event of progress.learning_evidence) {
      latestEvidence.set(event.knowledge_point_id, event);
    }
    const tasks: ReviewTask[] = [];
    for (const [kpId, rawState] of Object.entries(progress.repetition_states)) {
      const kpType = progress.knowledge_types[kpId] ?? "memory";
      const state = this.hydrate(normalizeRepetitionState(rawState), kpType);
      progress.repetition_states[kpId] = state;
      const priority = errors.has(kpId) ? 1 : TYPE_PRIORITY[kpType] ?? 3;
      const risk = this.forgettingRisk(state, progress, kpId, moment);
      const evidence = latestEvidence.get(kpId);
      tasks.push({
        id: `review_${kpId}`,
        knowledge_point_id: kpId,
        knowledge_type: kpType,
        due_at: state.next_review_at,
        priority,
        state,
        forgetting_risk: Math.round(risk * 10000) / 10000,
        reason: this.reviewReason(state, progress, kpId, {
          now: moment,
          latest_evidence: evidence ?? null,
        }),
        evidence_source: evidence?.source ?? "",
        evidence_id: evidence?.evidence_id ?? "",
      } as ReviewTask);
    }
    tasks.sort((a, b) => cmpTuple(reviewSortKey(a, moment), reviewSortKey(b, moment)));
    return tasks;
  }

  setDesiredRetention(
    progress: LearningProgress,
    desiredRetention: number,
    now?: number,
  ): void {
    const desired = validateDesiredRetention(desiredRetention);
    const moment = now ?? Date.now() / 1000;
    for (const [kpId, rawState] of Object.entries(progress.repetition_states)) {
      const kpType = progress.knowledge_types[kpId] ?? "memory";
      const state = this.hydrate(normalizeRepetitionState(rawState), kpType);
      const oldDesired = validateDesiredRetention(state.desired_retention);
      const anchor = state.last_scheduled_at;
      state.desired_retention = desired;
      if (anchor !== null && anchor !== undefined) {
        const interval = this._scheduledIntervalDays(state, kpType);
        state.next_review_at = anchor + interval * this._secondsPerUnit();
        const snapped = (state.next_review_at - anchor) / this._secondsPerUnit();
        const rounds = this._rounds(kpType);
        state.interval_index = snapIntervalIndex(rounds, snapped, rounds.length - 1);
      } else if (state.last_review_at !== null && state.last_review_at !== undefined) {
        const ratio = -Math.log(desired) / -Math.log(oldDesired);
        state.next_review_at =
          state.last_review_at + (state.next_review_at - state.last_review_at) * ratio;
      } else if (state.next_review_at > moment) {
        const ratio = -Math.log(desired) / -Math.log(oldDesired);
        state.next_review_at = moment + (state.next_review_at - moment) * ratio;
      }
      progress.repetition_states[kpId] = state;
    }
    progress.desired_retention = desired;
    progress.review_queue = this.buildReviewQueue(progress, moment);
  }

  rebuildFromEvidence(progress: LearningProgress, now?: number): void {
    const moment = now ?? Date.now() / 1000;
    const desired = validateDesiredRetention(progress.desired_retention);
    const evidenceByKp = new Map<string, LearningEvidence[]>();
    for (const evidence of progress.learning_evidence) {
      const list = evidenceByKp.get(evidence.knowledge_point_id) ?? [];
      list.push(evidence);
      evidenceByKp.set(evidence.knowledge_point_id, list);
    }
    for (const kpId of Object.keys(progress.repetition_states)) {
      const knowledgeType = progress.knowledge_types[kpId] ?? "memory";
      const kpEvidence = evidenceByKp.get(kpId) ?? [];
      if (kpEvidence.length) {
        progress.repetition_states[kpId] = this.replay(knowledgeType, kpEvidence, {
          now: moment,
          desired_retention: desired,
        });
      } else {
        const state = this.hydrate(
          normalizeRepetitionState(progress.repetition_states[kpId]),
          knowledgeType,
        );
        state.desired_retention = desired;
        const anchor = state.last_scheduled_at ?? state.last_review_at;
        if (anchor !== null && anchor !== undefined) {
          const interval = this._scheduledIntervalDays(state, knowledgeType);
          state.next_review_at = anchor + interval * this._secondsPerUnit();
          const rounds = this._rounds(knowledgeType);
          state.interval_index = snapIntervalIndex(rounds, interval, rounds.length - 1);
        }
        progress.repetition_states[kpId] = state;
      }
    }
    progress.review_queue = this.buildReviewQueue(progress, moment);
  }

  replay(
    knowledgeType: KnowledgeType,
    evidence: LearningEvidence[],
    opts?: {
      now?: number;
      desired_retention?: number | null;
      initial_state?: RepetitionState | null;
    },
  ): RepetitionState {
    if (opts?.initial_state) {
      if (opts.desired_retention !== null && opts.desired_retention !== undefined) {
        throw new Error("initial_state already contains desired_retention");
      }
      const state = JSON.parse(JSON.stringify(opts.initial_state)) as RepetitionState;
      for (const event of evidence) {
        this.scheduleReview(state, knowledgeType, event, { now: event.timestamp });
      }
      return state;
    }
    if (!evidence.length) {
      return this.getInitialState(knowledgeType, {
        now: opts?.now,
        desired_retention: opts?.desired_retention,
      });
    }
    const state = this.getInitialState(knowledgeType, {
      now: evidence[0].timestamp,
      desired_retention: opts?.desired_retention,
    });
    for (const event of evidence) {
      this.scheduleReview(state, knowledgeType, event, { now: event.timestamp });
    }
    return state;
  }
}

export const BaselineRetentionScheduler = SpacedRepetitionScheduler;

function resolvedQuality(evidence: LearningEvidence): number {
  let quality: number;
  if (evidence.quality !== null && evidence.quality !== undefined) {
    quality = Number(evidence.quality);
  } else if (evidence.result === "correct") {
    quality = 1.0;
  } else if (evidence.result === "partial") {
    quality = 0.4;
  } else {
    quality = 0.0;
  }
  if (evidence.quality === null || evidence.quality === undefined) {
    quality -= Math.min(0.25, (evidence.hints_used ?? 0) * 0.08);
    quality -= Math.min(0.2, Math.max(0, (evidence.attempt_count ?? 1) - 1) * 0.05);
  }
  return Math.max(0.0, Math.min(1.0, quality));
}

function snapIntervalIndex(
  intervals: number[],
  intervalDays: number,
  maxIndex: number,
): number {
  let nearest = 0;
  let best = Infinity;
  intervals.forEach((days, i) => {
    const d = Math.abs(Number(days) - intervalDays);
    if (d < best) {
      best = d;
      nearest = i;
    }
  });
  return Math.max(0, Math.min(nearest, maxIndex));
}

function formatSpan(days: number): string {
  if (days < 1.0 / 24.0) return "moments";
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours} hour${hours !== 1 ? "s" : ""}`;
  }
  if (days < 1.5) return "1 day";
  return `${Math.round(days)} days`;
}
