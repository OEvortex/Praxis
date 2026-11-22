// Port of deeptutor/learning/review_strategy.py — preset strategy templates.
import {
  KnowledgeType,
  LearningProgress,
  ReviewStrategyTemplate,
  buildReviewStrategyTemplate,
} from "./models.js";
import { INTERVAL_SEQUENCES, SpacedRepetitionScheduler } from "./scheduler.js";

const DAILY_LONG_TERM_INTERVALS: Record<KnowledgeType, number[]> = {
  memory: [...INTERVAL_SEQUENCES.memory],
  concept: [...INTERVAL_SEQUENCES.concept],
  procedure: [...INTERVAL_SEQUENCES.procedure],
  design: [...INTERVAL_SEQUENCES.design],
};

const PRESET_DESCRIPTIONS: Record<string, string> = {
  "preset-daily-long-term":
    "Steady long-term learning: expanding intervals from a same-day first " +
    "round up to two months.",
  "preset-exam-cramming":
    "Exam sprint: dense short intervals and a high recall target, front-loading " +
    "repetition into the days before the exam.",
  "preset-language":
    "Language subjects: vocabulary-grade repetition for memory with moderately " +
    "tight concept rounds.",
  "preset-science":
    "Science subjects: longer reasoning-friendly intervals once an objective is understood.",
};

function preset(
  templateId: string,
  name: string,
  desiredRetention: number,
  intervals: Record<string, number[]>,
): ReviewStrategyTemplate {
  const normalized = {} as Record<KnowledgeType, number[]>;
  for (const [kt, rounds] of Object.entries(intervals)) {
    normalized[kt as KnowledgeType] = [...rounds];
  }
  return {
    template_id: templateId,
    name,
    description: PRESET_DESCRIPTIONS[templateId] ?? "",
    builtin: true,
    desired_retention: desiredRetention,
    intervals: normalized,
    created_at: 0,
    updated_at: 0,
  };
}

export function builtinTemplates(): Record<string, ReviewStrategyTemplate> {
  const list = [
    preset(
      "preset-daily-long-term",
      "Daily Long-term Learning",
      0.9,
      Object.fromEntries(
        Object.entries(DAILY_LONG_TERM_INTERVALS).map(([k, v]) => [k, [...v]]),
      ),
    ),
    preset("preset-exam-cramming", "Exam Cramming", 0.95, {
      memory: [0, 1, 1, 2, 3, 4, 7],
      concept: [1, 2, 3, 5, 7],
      procedure: [1, 2, 3, 5],
      design: [3, 7, 14],
    }),
    preset("preset-language", "Language Subjects", 0.9, {
      memory: [0, 1, 2, 4, 7, 15, 30],
      concept: [2, 4, 8, 15],
      procedure: [2, 4, 8],
      design: [10, 21],
    }),
    preset("preset-science", "Science Subjects", 0.85, {
      memory: [1, 3, 7, 14, 30, 60, 120],
      concept: [5, 12, 25, 50],
      procedure: [5, 12, 25],
      design: [21, 45],
    }),
  ];
  const out: Record<string, ReviewStrategyTemplate> = {};
  for (const t of list) out[t.template_id] = t;
  return out;
}

export const BUILTIN_TEMPLATE_IDS: string[] = Object.keys(builtinTemplates()).sort();

export function schedulerForProgress(progress: LearningProgress): SpacedRepetitionScheduler {
  const binding = progress.review_strategy;
  if (binding === null || binding === undefined) {
    return new SpacedRepetitionScheduler();
  }
  return new SpacedRepetitionScheduler({ interval_sequences: binding.intervals });
}

export function validateStrategyInput(raw: Record<string, unknown>): ReviewStrategyTemplate {
  return buildReviewStrategyTemplate(raw);
}
