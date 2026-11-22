// parse the
// video-lesson writer's reply and build its system prompt.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NarrationLine } from "./narration.js";
import { ASSETS_DIR } from "./runtime.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(MODULE_DIR, "prompts");

const JSON_BLOCK = /```json[ \t]*\n([\s\S]*?)\n```/g;
const TSX_BLOCK = /```(?:tsx|typescript|ts|jsx)[ \t]*\n([\s\S]*?)\n```/g;

export interface LessonDraft {
  title: string;
  summary: string;
  code: string;
  raw: string;
  narration: NarrationLine[];
}

export class DraftParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftParseError";
  }
}

function* findAll(re: RegExp, text: string): Generator<string> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    yield m[1];
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

export function parseDraft(reply: string): LessonDraft {
  /** Extract the JSON metadata and the complete Lesson.tsx from a writer reply. */
  const tsxBlocks = [...findAll(TSX_BLOCK, reply ?? "")];
  if (tsxBlocks.length === 0) {
    throw new DraftParseError("no ```tsx block with a complete Lesson.tsx");
  }
  const code = tsxBlocks.reduce((a, b) => (b.length > a.length ? b : a)).trim();

  let meta: Record<string, unknown> | null = null;
  for (const raw of findAll(JSON_BLOCK, reply ?? "")) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      "narration" in (value as Record<string, unknown>)
    ) {
      meta = value as Record<string, unknown>;
      break;
    }
  }
  if (!meta) {
    throw new DraftParseError("no ```json block with title, summary and narration");
  }

  const narration: NarrationLine[] = [];
  const items = Array.isArray(meta.narration) ? meta.narration : [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const ident = String(rec.id ?? "").trim();
    const text = String(rec.text ?? "").trim();
    if (ident && text) narration.push({ id: ident, text });
  }
  if (narration.length === 0) {
    throw new DraftParseError("the json block has no narration entries with an id and text");
  }

  return {
    title: String(meta.title ?? "").trim(),
    summary: String(meta.summary ?? "").trim(),
    code,
    raw: reply ?? "",
    narration,
  };
}

export function loadInstructions(): string {
  /**
   * The writer's system prompt, with the kit source spliced in.
   *
   * `str.format` cannot be used here: the kit is TypeScript full of braces —
   * likewise a plain `replace` of the `{kit_source}` token is used.
   */
  const template = readFileSync(join(PROMPTS_DIR, "lesson_writer.txt"), "utf-8");
  const kit = readFileSync(join(ASSETS_DIR, "kit.tsx"), "utf-8");
  return template.replace("{kit_source}", kit);
}

// Python __all__ parity: LessonDraft, NarrationLine, load_instructions, parse_draft.
export type { NarrationLine };
