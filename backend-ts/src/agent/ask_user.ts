// The `ask_user` tool: package 1-4 structured questions into one payload that
// the local agent loop interprets as "pause this same turn until the learner
// answers" (see `runtime.ts`). The chat UI reads the same payload off
// `tool_result.metadata.ask_user` and renders a card with clickable options,
// free-form input, and the question tabs.
//
// Faithful TS port of the reference `deeptutor/tools/ask_user.py` and the
// `AskUserTool.get_definition()` schema in `deeptutor/tools/builtin/__init__.py`.
// The schema is a list-of-questions even for the common single-question case —
// every call wraps a list so the frontend has one code path. Each option is a
// `{label, description}` pair; plain-string options are accepted at the
// LLM-facing boundary and normalised, as is the legacy `{question, options}`
// single-question shape.

import { BaseTool, type Ctx, type ToolParamsSchema, type ToolResultLike } from "../shared/vtx.js";

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 8;
export const MAX_OPTION_CHARS = 120;
export const MAX_OPTION_DESC_CHARS = 200;
export const MAX_HEADER_CHARS = 16;
export const MAX_QUESTION_CHARS = 800;
export const MAX_INTRO_CHARS = 400;
export const MAX_PLACEHOLDER_CHARS = 120;

// The card auto-renders a "Other"/free-text row; drop a model-supplied duplicate.
const REDUNDANT_OTHER_LABELS = new Set(["other", "其他", "其它"]);

export interface AskUserOption {
  label: string;
  description?: string | null;
  [k: string]: unknown;
}

export interface AskUserQuestion {
  id: string;
  prompt: string;
  header: string | null;
  multi_select: boolean;
  options: AskUserOption[];
  allow_free_text: boolean;
  placeholder: string | null;
}

export interface AskUserPayload {
  intro: string | null;
  questions: AskUserQuestion[];
}

export interface BuiltAskUser {
  payload: AskUserPayload | null;
  error: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // valid surrogate pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Decode dense JSON-style `\uXXXX` runs models sometimes double-encode. */
const ESCAPED_UNICODE_RUN = /(?:\\u[0-9a-fA-F]{4}){3,}/g;
function decodeEscapedUnicodeForDisplay(value: string): string {
  if (!value.includes("\\u")) return value;
  return value.replace(ESCAPED_UNICODE_RUN, (run) => {
    try {
      const decoded = JSON.parse(`"${run}"`) as string;
      // Only accept runs that actually represent non-ASCII text. A lone
      // surrogate is not text; keep the escapes visible in that case.
      if (hasUnpairedSurrogate(decoded)) return run;
      return /[^\x00-\x7F]/.test(decoded) ? decoded : run;
    } catch {
      return run;
    }
  });
}

function coerceString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return decodeEscapedUnicodeForDisplay(typeof value === "string" ? value : String(value));
}

function clip(value: string, max: number, ellipsis = true): string {
  if (value.length <= max) return value;
  const chars = [...value];
  if (chars.length <= max) return value;
  const cut = chars.slice(0, max).join("").trimEnd();
  return ellipsis ? `${cut}…` : cut;
}

function matchKey(label: string): string {
  return label.split("").filter((c) => c.trim() !== "").join("").toLowerCase();
}

function buildOption(raw: unknown): AskUserOption | null {
  let label: string;
  let description: string | null = null;
  if (isRecord(raw)) {
    label = coerceString(raw.label).trim();
    description = coerceString(raw.description).trim() || null;
  } else {
    label = coerceString(raw).trim();
  }
  if (!label) return null;
  label = clip(label, MAX_OPTION_CHARS);
  if (description) description = clip(description, MAX_OPTION_DESC_CHARS);
  return { label, description };
}

function buildQuestion(raw: unknown, idx: number, usedIds: Set<string>): AskUserQuestion | string {
  if (!isRecord(raw)) return `Question #${idx + 1} must be an object.`;

  const prompt = coerceString(raw.prompt ?? raw.question).trim();
  if (!prompt) return `Question #${idx + 1}: \`prompt\` must be a non-empty string.`;

  const allowFreeTextRaw = raw.allow_free_text;
  const allow_free_text = allowFreeTextRaw === undefined ? true : Boolean(allowFreeTextRaw);

  let options: AskUserOption[] = [];
  const optionsRaw = raw.options;
  if (optionsRaw !== undefined && optionsRaw !== null) {
    if (!Array.isArray(optionsRaw)) return `Question #${idx + 1}: \`options\` must be an array.`;
    const seenLabels = new Set<string>();
    const seenBodies = new Set<string>();
    for (const opt of optionsRaw) {
      // Drop non-object/non-string artefacts of repairing a truncated stream.
      if (!isRecord(opt) && typeof opt !== "string") continue;
      const normalised = buildOption(opt);
      if (normalised === null) continue;
      const key = matchKey(normalised.label);
      if (allow_free_text && REDUNDANT_OTHER_LABELS.has(key)) continue;
      if (seenLabels.has(key)) continue;
      const body = (normalised.description ?? "").trim();
      if (body) {
        const bodyKey = body.split(/\s+/).join(" ").toLowerCase();
        if (seenBodies.has(bodyKey)) continue;
        seenBodies.add(bodyKey);
      }
      seenLabels.add(key);
      options.push(normalised);
      if (options.length >= MAX_OPTIONS) break;
    }
  }

  const multi_select = Boolean(raw.multi_select ?? raw.multiSelect);

  let header: string | null = null;
  if (raw.header !== undefined && raw.header !== null) {
    header = coerceString(raw.header).trim() || null;
    if (header) header = clip(header, MAX_HEADER_CHARS, false);
  }

  let placeholder: string | null = null;
  if (raw.placeholder !== undefined && raw.placeholder !== null) {
    placeholder = coerceString(raw.placeholder).trim() || null;
    if (placeholder) placeholder = clip(placeholder, MAX_PLACEHOLDER_CHARS);
  }

  let id = coerceString(raw.id).trim() || `q${idx + 1}`;
  if (usedIds.has(id)) {
    let suffix = 2;
    while (usedIds.has(`${id}_${suffix}`)) suffix += 1;
    id = `${id}_${suffix}`;
  }

  return {
    id,
    prompt: clip(prompt, MAX_QUESTION_CHARS),
    header,
    multi_select,
    options,
    allow_free_text,
    placeholder,
  };
}

function coerceQuestions(args: Record<string, unknown>): unknown[] | string {
  if (Array.isArray(args.questions)) return args.questions;
  if (args.questions !== undefined && args.questions !== null) return "`questions` must be an array.";
  if (args.question !== undefined && args.question !== null) {
    return [{ prompt: args.question, options: args.options }];
  }
  return [];
}

function normaliseIntro(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  return coerceString(raw).trim() || null;
}

/** Validate + normalise the LLM-provided arguments into a frontend payload. */
export function buildAskUserPayload(args: unknown): BuiltAskUser {
  const arg = isRecord(args) ? args : {};
  const rawQuestions = coerceQuestions(arg);
  if (typeof rawQuestions === "string") return { payload: null, error: rawQuestions };
  if (rawQuestions.length === 0) {
    return { payload: null, error: "`questions` must contain at least one question." };
  }

  const questions: AskUserQuestion[] = [];
  const usedIds = new Set<string>();
  for (let i = 0; i < Math.min(rawQuestions.length, MAX_QUESTIONS); i += 1) {
    const built = buildQuestion(rawQuestions[i], i, usedIds);
    if (typeof built === "string") return { payload: null, error: built };
    questions.push(built);
    usedIds.add(built.id);
  }

  const introRaw = normaliseIntro(arg.intro);
  const intro = introRaw ? clip(introRaw, MAX_INTRO_CHARS) : null;
  return { payload: { intro, questions }, error: null };
}

// -- model-facing tool -------------------------------------------------------

export const askUserParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      description:
        "1-4 questions to ask in one card. Bundle ALL clarifications into this single call — never emit a second ask_user in the same message. Give each question 2-4 distinct, mutually exclusive options (set multi_select: true when choices can combine, and phrase the question accordingly). Option labels are short (1-5 words); put what picking it implies in the description. If you recommend an option, place it FIRST and append ' (Recommended)' to its label. Never add your own 'Other' option — the card offers free-form input automatically.",
      items: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The complete question text." },
          id: { type: "string" },
          header: {
            type: "string",
            description: "Very short tab label (max 12 chars), e.g. 'Scope', 'Depth'.",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Concise display text (1-5 words)." },
                description: {
                  type: "string",
                  description: "What this choice means or implies, trade-offs included.",
                },
              },
              required: ["label"] as unknown as boolean,
            },
          },
          multi_select: {
            type: "boolean",
            description: "true = the user may pick several options.",
          },
          allow_free_text: { type: "boolean" },
          placeholder: {
            type: "string",
            description: "Hint shown in the free-form input.",
          },
        },
        required: ["prompt"] as unknown as boolean,
      },
    },
    intro: {
      type: "string",
      description:
        "Optional one-line lead-in shown above the questions (e.g. 'To tailor the answer, please clarify:').",
    },
  },
};

export interface AskUserToolParams {
  questions?: unknown[];
  intro?: unknown;
  // Legacy single-question shape, accepted but not advertised in the schema.
  question?: unknown;
  options?: unknown;
}

export class AskUserTool extends BaseTool<AskUserToolParams> {
  name = "ask_user";
  toolIcon = "❓";
  params = askUserParamsSchema;
  description =
    "Pause the conversation to ask the user 1-4 clarifying questions in one batch, rendered as a card with clickable options and free-form input. Use ONLY when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the conversation, the attached material, or sensible defaults. Never use it to ask 'should I proceed?', to confirm what the user already said, or for choices with an obvious conventional answer — pick that answer, mention it, and proceed. Bundle every clarification into one call; at most one ask_user per assistant message. The turn does NOT end: when the answers arrive the loop resumes with them as this tool's result, and you must then complete the user's original request.";

  async execute(params: AskUserToolParams, _ctx?: Ctx): Promise<ToolResultLike> {
    const { payload, error } = buildAskUserPayload(params ?? {});
    if (payload === null) {
      return { success: false, result: error ?? "Invalid ask_user arguments.", is_error: true };
    }
    const prompts = payload.questions.map((q) => q.prompt).join(", ");
    // The placeholder is overwritten by the loop once the reply arrives; it
    // only surfaces if the runtime crashes mid-pause.
    return {
      success: true,
      result: `[awaiting user reply to: ${prompts}]`,
      metadata: { ask_user: payload },
      pause_for_user: payload,
    };
  }
}

export const ask_user = new AskUserTool();
