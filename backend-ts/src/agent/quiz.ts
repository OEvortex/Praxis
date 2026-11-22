// quiz judging helpers for embedded quiz
// blocks (books/reading/notes).
//
// The emitter contract matches web/lib/quiz-types.ts: the frontend posts the
// learner's answer plus the question metadata, and ``judge_answer`` returns the
// grader's feedback text.

import { get_settings } from "../config.js";
import { complete_text } from "../services/llm_text.js";
import type { Settings } from "../config.js";

function _completeText(settings: unknown, opts: { system: string; prompt: string }): Promise<string> {
  return complete_text(settings as Settings, opts);
}

function _str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * One completion through Praxis's selected model.
 *
 * provider/model and streamed TextDeltaEvents. The TS port uses the shared
 * one-shot LLM helper until agent/runtime.ts exposes an equivalent runner.
 */
async function _llm_text(prompt: string, _cancelEvent?: AbortSignal): Promise<string> {
  const settings = get_settings();
  return (await _completeText(settings, { system: "", prompt })).trim();
}

/** Grade a learner's answer with the configured model (AI Judge button). */
export async function judge_answer(
  message: Record<string, unknown>,
  cancelEvent?: AbortSignal,
): Promise<string> {
  const question = _str(message["question"]);
  const questionType = _str(message["question_type"]);
  const options = message["options"];
  const correct = _str(message["correct_answer"]);
  const explanation = _str(message["explanation"]);
  const answer = _str(message["user_answer"]);
  const prompt =
    "You are grading a learner's quiz answer. Start with ✅ Correct, " +
    "⚠️ Partially correct, or ❌ Incorrect, then give short itemized feedback.\n\n" +
    `Question type: ${questionType}\nQuestion: ${question}\n` +
    (options ? `Options: ${JSON.stringify(options)}\n` : "") +
    `Reference answer: ${correct}\nReference explanation: ${explanation}\n` +
    `Learner's answer: ${answer}\n`;
  return _llm_text(prompt, cancelEvent);
}
