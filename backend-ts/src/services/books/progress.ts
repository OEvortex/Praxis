// Port of deeptutor/book/progress.py — pure functions over Progress.
import type { Progress, QuizAttempt } from "./models.js";
import { now } from "./models.js";

function questionKey(a: QuizAttempt): string {
  return `${a.block_id}${a.question_id ?? ""}`;
}

/** The most recent attempt per question, keyed by (block, question). */
export function latest_attempts(progress: Progress): Map<string, QuizAttempt> {
  const latest = new Map<string, QuizAttempt>();
  for (const attempt of progress.quiz_attempts ?? []) {
    const key = questionKey(attempt);
    const current = latest.get(key);
    if (current === undefined || (attempt.timestamp ?? 0) >= (current.timestamp ?? 0)) {
      latest.set(key, attempt);
    }
  }
  return latest;
}

/** Number of distinct questions currently answered correctly. */
export function recompute_score(progress: Progress): number {
  let score = 0;
  for (const a of latest_attempts(progress).values()) {
    if (a.is_correct === true) score += 1;
  }
  return score;
}

/** Chapters holding at least one question whose latest answer was wrong. */
export function recompute_weak_chapters(
  progress: Progress,
  page_to_chapter: Record<string, string>,
): string[] {
  const weak = new Set<string>();
  for (const attempt of latest_attempts(progress).values()) {
    if (attempt.is_correct !== false) continue;
    const chapter_id = page_to_chapter[attempt.page_id] ?? "";
    if (chapter_id) weak.add(chapter_id);
  }
  return [...weak].sort();
}

export function record_attempt(
  progress: Progress,
  args: {
    page_id: string;
    block_id: string;
    question_id?: string;
    user_answer?: string;
    is_correct?: boolean | null;
    page_to_chapter: Record<string, string>;
    submission_id?: string;
  },
): Progress {
  const submission_id = (args.submission_id ?? "").trim();
  if (submission_id) {
    for (const existing of progress.quiz_attempts ?? []) {
      if (existing.submission_id !== submission_id) continue;
      if (
        existing.page_id !== args.page_id ||
        existing.block_id !== args.block_id ||
        (existing.question_id ?? "") !== (args.question_id ?? "") ||
        (existing.user_answer ?? "") !== (args.user_answer ?? "") ||
        existing.is_correct !== (args.is_correct ?? null)
      ) {
        throw new ValueError("Submission id was reused for a different quiz answer");
      }
      return progress;
    }
  }
  progress.quiz_attempts = progress.quiz_attempts ?? [];
  progress.quiz_attempts.push({
    block_id: args.block_id,
    page_id: args.page_id,
    question_id: args.question_id ?? "",
    user_answer: args.user_answer ?? "",
    is_correct: args.is_correct ?? null,
    submission_id,
    timestamp: now(),
  });
  progress.score = recompute_score(progress);
  progress.weak_chapters = recompute_weak_chapters(progress, args.page_to_chapter);
  return progress;
}

/** Record that the reader opened page_id. True when anything changed. */
export function mark_visited(progress: Progress, page_id: string): boolean {
  let changed = false;
  if ((progress.current_page_id ?? "") !== page_id) {
    progress.current_page_id = page_id;
    changed = true;
  }
  progress.visited_page_ids = progress.visited_page_ids ?? [];
  if (!progress.visited_page_ids.includes(page_id)) {
    progress.visited_page_ids.push(page_id);
    changed = true;
  }
  return changed;
}

/** Flip page_id's bookmark. Returns whether it is bookmarked now. */
export function toggle_bookmark(progress: Progress, page_id: string): boolean {
  progress.bookmarked_page_ids = progress.bookmarked_page_ids ?? [];
  const idx = progress.bookmarked_page_ids.indexOf(page_id);
  if (idx >= 0) {
    progress.bookmarked_page_ids.splice(idx, 1);
    return false;
  }
  progress.bookmarked_page_ids.push(page_id);
  return true;
}

export function completion_ratio(progress: Progress, total_pages: number): number {
  if (total_pages <= 0) return 0;
  const seen = new Set(progress.visited_page_ids ?? []).size;
  return Math.min(1, seen / total_pages);
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}
