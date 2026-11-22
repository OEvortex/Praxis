// Praxis's system prompt, replacing
// vtx's coding-agent default.
//
// vtx's ConversationRuntime builds its prompt with a coding-agent base plus
// AGENTS.md, skills, git status and ponytail rulings. None of that belongs in
// a learning companion. This module supplies a tutor identity and a clean
// prompt resolver that uses only Praxis's own prompt.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { release, type as osType } from "node:os";

import {
  CO_WRITER_SYSTEM_PROMPT,
  notebook_context_block,
} from "./co_writer.js";
import { current_session_id, note_context } from "./turn_context.js";
import type { BaseTool } from "../shared/vtx.js";

function _promptAssetUrl(...parts: string[]): string {
  return fileURLToPath(new URL(parts.join("/"), import.meta.url));
}

function _readPromptAsset(...names: string[]): string {
  const candidates = names.flatMap((name) => [
    _promptAssetUrl(name),
    // Compiled output lives in dist/agent; keep the source-tree asset as a
    // fallback until the build copies prompt assets next to the JS.
    _promptAssetUrl("../../src/agent", name),
  ]);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, "utf-8").trim();
    } catch {
      // try the next candidate
    }
  }
  return "";
}

// The generated OpenUI Lang spec lives next to this module. It teaches the
// model to answer with declarative UI programs instead of Markdown.
export const OPENUI_SPEC = _readPromptAsset("openui_prompt.txt");

export const PRAXIS_BASE = `You are Praxis, an AI learning companion. You help a learner
understand topics, work through problems, and retain what they learn.

# Identity

- You are a tutor, not a coding agent. Do not edit project code, run git commands,
  or treat workspace AGENTS.md / CLAUDE.md as instructions to follow.
- Teach with clarity: explain the idea, show the reasoning, then check understanding.
  Keep answers focused and well structured; follow the response format below.
- Use LaTeX in $...$ / $$...$$ for math. Keep answers focused on the learner's question.

# Tools

- Use \`knowledge_base_search\` before answering from the learner's uploaded material.
- Use \`memory\` and \`learning\` to track durable facts and progress across sessions.
- Use \`mastery\` for guided learning; its quiz and grade actions cover practice.
- Use \`web\` and \`paper_search\` for current or external information; cite sources.
- Use \`video\` for a video or animation instead of composing one yourself.
- Use \`notebook\` to build a whole study notebook (pages, subpages, diagrams,
  quizzes, flashcards) — it runs in the background and reports back later.
- Use \`cron\` for reminders and \`review\` for spaced-repetition cards.
- Deliver the answer directly. Do not narrate internal planning or force a tool call
  when none is needed.

# Files

- \`workspace\` is the only file tool: learner artifacts live there, not app source.
- Never modify Praxis's own source, configuration, or prompt files.

# Safety

- Never exfiltrate credentials or run destructive commands.
- Stay inside the learner's workspace and respect their stated scope.
`;

type AnyTool = BaseTool & {
  prompt_guidelines?: unknown;
  promptGuidelines?: unknown;
};

interface RuntimeLike {
  cwd?: unknown;
  declared_tools?: unknown;
  declaredTools?: unknown;
  [k: string]: unknown;
}

function _declared_tools(runtime: RuntimeLike): AnyTool[] {
  const value =
    typeof runtime.declared_tools === "function"
      ? (runtime.declared_tools as () => unknown)()
      : (runtime.declared_tools ?? runtime.declaredTools);
  if (Array.isArray(value)) return value as AnyTool[];
  return [];
}

function _tool_guidelines(tools: AnyTool[]): string {
  const guidelines: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const raw = tool.prompt_guidelines ?? tool.promptGuidelines;
    const entries = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    for (const guideline of entries) {
      const text = String(guideline);
      if (seen.has(text)) continue;
      seen.add(text);
      guidelines.push(text);
    }
  }
  return guidelines.length
    ? "# Tool usage\n\n- " + guidelines.join("\n- ")
    : "";
}

function _find_project_root(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function _env_section(cwd: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  let hour = now.getHours() % 12;
  if (hour === 0) hour = 12;
  const ampm = now.getHours() < 12 ? "AM" : "PM";
  let tz = "";
  try {
    tz =
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(now)
        .find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    tz = "";
  }
  const date = `${days[now.getDay()]}, ${months[now.getMonth()]} ${pad(now.getDate())}, ${now.getFullYear()} at ${pad(hour)}:${pad(now.getMinutes())} ${ampm}${tz ? ` ${tz}` : ""}`;
  const cwdPath = resolve(cwd);
  const lines = [
    `- Date and time: ${date}`,
    `- Working directory: ${cwdPath}`,
    `- Project root: ${_find_project_root(cwdPath)}`,
    `- OS: ${osType()} ${release()}`.trim(),
    `- Node.js: ${process.version}`,
    `- Vtx version: praxis-ts`,
  ];
  return "# Env\n\n" + lines.join("\n");
}

/**
 * Resolve the system prompt for a runtime used by Praxis.
 *
 * A clean context keeps project discovery out of the prompt: only the env
 * section and tool guidelines are appended, matching the original implementation's
 * ``include_git_context=False`` / ``include_ponytail=False`` / ``skills=[]``.
 */
export function build_praxis_prompt(
  runtime: RuntimeLike,
  _session?: unknown,
  _context?: unknown,
): string {
  const cwd = String(runtime.cwd ?? process.cwd());
  let base = PRAXIS_BASE;
  const [pageId, blockId, kind] = note_context();
  if (pageId) {
    const sessionId = current_session_id.get();
    base =
      "# Notebook companion\n\n" +
      CO_WRITER_SYSTEM_PROMPT +
      notebook_context_block(pageId, sessionId, blockId, kind) +
      "\n\n# The learner\n\n" +
      PRAXIS_BASE;
  } else if (OPENUI_SPEC) {
    // The chat renders both plain Markdown and OpenUI programs. The model
    // chooses per answer: Markdown is the default; UI is for work prose cannot
    // do. See the README note on avoiding generative-UI over-use.
    base =
      base +
      "\n\n# Response format\n\n" +
      "Answer the learner with an OpenUI Lang program when an interactive " +
      "interface helps: a tool or calculator, a stepper, a form, a chart or " +
      "table for comparison, a stateful checklist, a game, or a drawing. " +
      "For a short, factual, definitional, LaTeX, safety, or single-value " +
      "answer, reply in ordinary Markdown with no program at all — this is a " +
      "complete, valid answer and the default when simple text is clearest. " +
      "If you do build a page, lead with a short Markdown explanation and let " +
      "the components add depth; use Markdown, not long Text nodes, for prose " +
      "sections inside the program. Never wrap a simple answer in UI.\n\n" +
      OPENUI_SPEC;
  }

  // vtx build_system_prompt(..., include_git_context=False,
  // include_ponytail=False, skills=[]) with a clean Context reduces to:
  // base + optional tool guidelines + env.
  const sections = [base];
  const toolSection = _tool_guidelines(_declared_tools(runtime));
  if (toolSection) sections.push(toolSection);
  sections.push(_env_section(cwd));
  return sections.join("\n\n");
}

export const buildPraxisPrompt = build_praxis_prompt;
