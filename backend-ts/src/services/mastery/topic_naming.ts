// name a mastery goal from what
// the learner asked for. Never blocks creation; "" means "use the fallback".
import { completeText } from "../llm_text.js";
import type { Settings } from "../../config.js";

const MAX_TITLE_CHARS = 48;
const MAX_GOAL_CHARS = 1200;
const MAX_SOURCE_LABELS = 6;

const SYSTEM_EN =
  "You name learning goals. Output the name only — no explanation, no " +
  "quotes, no trailing punctuation.\n" +
  "A name is the short label the learner will recognise in a list months " +
  "from now, not a restatement of what they said: name the subject " +
  "('Time-series neural networks'), never 'I want to learn...' or " +
  "'Everything about...'.\n" +
  `At most ${MAX_TITLE_CHARS} characters, shorter is better. Use English.`;

const WRAPPING_QUOTES = ['"', "'"];

function fit(text: string): string {
  const limit = MAX_TITLE_CHARS;
  if (text.length <= limit) return text;
  const clipped = text.slice(0, limit);
  if (clipped.includes(" ")) {
    const head = clipped.slice(0, clipped.lastIndexOf(" ")).trim();
    if (head) return head;
  }
  return clipped.trim();
}

function clean(raw: string): string {
  let text = String(raw ?? "").trim();
  if (!text || text.includes("\n")) return "";
  for (const q of WRAPPING_QUOTES) text = text.split(q).join("");
  text = text.trim().replace(/[.!?:;,]+$/u, "").trim();
  if (!text) return "";
  return fit(text);
}

function render(goal: string, sourceLabels: string[]): string {
  const lines: string[] = [
    "Learning goal:",
    goal.trim().slice(0, MAX_GOAL_CHARS),
  ];
  const labels = sourceLabels.map((l) => l.trim()).filter(Boolean);
  if (labels.length) {
    lines.push("");
    lines.push("Materials:");
    for (const label of labels.slice(0, MAX_SOURCE_LABELS)) lines.push(`- ${label}`);
  }
  return lines.join("\n");
}

export async function suggestTopicName(
  settings: Settings,
  goal: string,
  opts?: { source_labels?: string[]; language?: string },
): Promise<string> {
  const cleanedGoal = String(goal ?? "").trim();
  if (!cleanedGoal) return "";
  const language = opts?.language ?? "en";
    try {
    const raw = await Promise.race([
      completeText(settings, {
        system: SYSTEM_EN,
        prompt: render(cleanedGoal, opts?.source_labels ?? []),
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("topic naming timed out")), 8000),
      ),
    ]);
    return clean(raw);
  } catch {
    return "";
  }
}
