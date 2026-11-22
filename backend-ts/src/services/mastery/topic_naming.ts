// Port of deeptutor/learning/topic_naming.py — name a mastery goal from what
// the learner asked for. Never blocks creation; "" means "use the fallback".
import { isChinese } from "./prompts.js";
import { completeText } from "../llm_text.js";
import type { Settings } from "../../config.js";

const MAX_TITLE_CHARS = 24;
const MAX_TITLE_CHARS_LATIN = 48;
const MAX_GOAL_CHARS = 1200;
const MAX_SOURCE_LABELS = 6;

const SYSTEM_ZH =
  "你为学习目标起名字。只输出一个名字，不要解释、不要引号、不要标点结尾。\n" +
  "名字是学习者几个月后在列表里一眼认出这门课的短标签，不是把他的话复述一遍：\n" +
  "写主题本身（「时间序列神经网络」），不要写「我想学……」「关于……的一切」这类话。\n" +
  `最多 ${MAX_TITLE_CHARS} 个字，越短越好。用学习者使用的语言。`;

const SYSTEM_EN =
  "You name learning goals. Output the name only — no explanation, no " +
  "quotes, no trailing punctuation.\n" +
  "A name is the short label the learner will recognise in a list months " +
  "from now, not a restatement of what they said: name the subject " +
  "('Time-series neural networks'), never 'I want to learn...' or " +
  "'Everything about...'.\n" +
  `At most ${MAX_TITLE_CHARS_LATIN} characters, shorter is better. Use the ` +
  "learner's own language.";

const WRAPPING_QUOTES = ['"', "'", "「", "」", "『", "』", "“", "”", "‘", "’", "《", "》"];

function isCjkDominant(text: string): boolean {
  const cjk = [...text].filter((ch) => ch >= "一" && ch <= "鿿").length;
  const nonSpace = [...text].filter((ch) => !/\s/.test(ch)).length;
  return cjk * 2 >= nonSpace;
}

function fit(text: string): string {
  const limit = isCjkDominant(text) ? MAX_TITLE_CHARS : MAX_TITLE_CHARS_LATIN;
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
  text = text.trim().replace(/[。．.!！?？:：;；,，、]+$/u, "").trim();
  if (!text) return "";
  return fit(text);
}

function render(goal: string, sourceLabels: string[], zh: boolean): string {
  const lines: string[] = [
    zh ? "学习目标：" : "Learning goal:",
    goal.trim().slice(0, MAX_GOAL_CHARS),
  ];
  const labels = sourceLabels.map((l) => l.trim()).filter(Boolean);
  if (labels.length) {
    lines.push("");
    lines.push(zh ? "学习资料：" : "Materials:");
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
  const zh = isChinese(language);
  try {
    const raw = await Promise.race([
      completeText(settings, {
        system: zh ? SYSTEM_ZH : SYSTEM_EN,
        prompt: render(cleanedGoal, opts?.source_labels ?? [], zh),
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
