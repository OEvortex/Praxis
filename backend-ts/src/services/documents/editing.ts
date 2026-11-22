// prompts and operation
// history for Co-Writer AI edits.
//
// Three entry points share one shape: take draft text, ask the configured
// model for a replacement, return clean Markdown. Every operation is appended
// to the shared ``kv`` state so the UI can show what the AI changed.

import { randomBytes } from "node:crypto";

import { get_settings } from "../../config.js";
import { get_state, put_state } from "../../store/database.js";
import { clean_thinking_tags } from "../llm_text.js";

export const MAX_HISTORY = 200;
const _HISTORY_KEY = "documents/history";

const ACTION_VERBS: Record<string, string> = {
  rewrite: "Rewrite",
  shorten: "Shorten",
  expand: "Expand",
  polish: "Polish",
  continue: "Continue",
};

const MODE_INSTRUCTIONS: Record<string, string> = {
  rewrite:
    "Rewrite this markdown snippet while preserving its meaning, structure, and tone.",
  shorten:
    "Shorten this markdown snippet while preserving the key information.",
  expand:
    "Expand this markdown snippet with helpful detail while keeping the original style.",
  none: "Edit this markdown snippet according to the user's request.",
};

const AUTO_MARK_SYSTEM = `\
You are a reading annotation assistant. The result is inserted into an editable Markdown draft, so every annotation must be readable as plain text.

Preserve the original wording, punctuation, paragraphs, and Markdown. Insert only these visible inline markers:
- 【term】 for a short key concept, name, or numerical value.
- 《statement》 for a short definition, finding, or conclusion.

Mark sparingly: at most one term per 100 characters and two statements per paragraph. Do not nest markers or wrap Markdown syntax such as \`**\` and backticks. Never output HTML, XML, CSS, or data attributes. If nothing needs annotation, return the original text unchanged. Output only the marked draft.
`;

const EDIT_SYSTEM = "You are an expert editor and writing assistant.";

export function load_history(): Record<string, unknown>[] {
  const raw = get_state<unknown>(get_settings(), _HISTORY_KEY, []);
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
}

export function append_history(entry: Record<string, unknown>): void {
  const entries = load_history();
  entries.unshift(entry);
  put_state(get_settings(), _HISTORY_KEY, entries.slice(0, MAX_HISTORY));
}

/** time.strftime("%Y%m%d_%H%M%S") + "_" + os.urandom(3).hex() */
export function new_operation_id(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}_${randomBytes(3).toString("hex")}`;
}

export function strip_fence(text: string): string {
  const cleaned = (text || "").trim();
  if (cleaned.startsWith("```") && cleaned.endsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines.length >= 3) {
      return lines.slice(1, -1).join("\n").trim();
    }
  }
  return cleaned;
}

export function clean_output(text: string): string {
  return strip_fence(clean_thinking_tags(text));
}

export function edit_prompt(
  text: string,
  instruction: string,
  action: string,
): [string, string] {
  const verb = ACTION_VERBS[action] ?? "Edit";
  const prompt =
    `${verb} the following text based on the user's instruction.\n\n` +
    `User Instruction: ${instruction || verb}\n\n` +
    `Target Text to Edit:\n${text}\n\n` +
    "Output only the edited text, without quotes or explanations.";
  return [EDIT_SYSTEM, prompt];
}

export function react_edit_prompt(opts: {
  selected_text: string;
  instruction: string;
  mode: string;
  context?: string;
}): [string, string] {
  const { selected_text, instruction, mode } = opts;
  const context = opts.context ?? "";
  const user_instruction =
    instruction.trim() || MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS["none"];
  const context_block = context
    ? `Reference material (use what is relevant, ignore the rest):\n${context}\n\n`
    : "";
  const prompt =
    "You are editing a text selection from a Markdown editor.\n\n" +
    `Edit mode: ${mode}\n` +
    `User request: ${user_instruction}\n\n` +
    `${context_block}` +
    "Selected text to edit:\n" +
    "```markdown\n" +
    `${selected_text}\n` +
    "```\n\n" +
    "Requirements:\n" +
    "1. Output only the edited Markdown snippet for direct replacement.\n" +
    "2. Do not include explanations, headings, prefixes, suffixes, or code fences.\n" +
    "3. Keep the Markdown valid.\n" +
    "4. If reference material is given, weave the relevant facts in naturally " +
      "without mentioning tools or sources.\n";
  return [EDIT_SYSTEM, prompt];
}

export function automark_prompt(text: string): [string, string] {
  return [AUTO_MARK_SYSTEM, `Process the following text:\n${text}`];
}

export function record(opts: {
  operation_id: string;
  action: string;
  model: string;
  original: string;
  edited: string;
  instruction?: string;
  mode?: string;
  tools?: string[] | null;
  kb_name?: string | null;
}): void {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const timestamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  append_history({
    id: opts.operation_id,
    timestamp,
    action: opts.action,
    mode: opts.mode ?? "",
    tools: opts.tools ?? [],
    kb_name: opts.kb_name ?? null,
    input: {
      text: opts.original.slice(0, 4000),
      instruction: opts.instruction ?? "",
    },
    output: { edited_text: opts.edited.slice(0, 4000) },
    model: opts.model,
  });
}
