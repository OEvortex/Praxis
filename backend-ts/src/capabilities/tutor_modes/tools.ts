// Mode-owned tools for the five composer tutor modes.
//
// DeepTutor mounts a mode's `owned_tools` only while that mode is active and
// injects private kwargs through `augment_kwargs`. Praxis does the same here:
// one small deterministic tool per mode, never callable from plain chat.

import { BaseTool, type ToolParamsSchema } from "../../shared/vtx.js";
import { fail, ok, type Dict, type ToolResult } from "../../shared/types.js";
import { append_item, get_state } from "./state.js";
import type { TutorMode } from "./capability.js";

const STATE_ID_PARAM = "_tutor_state_id";

type Params = Record<string, unknown>;

/** Text schema helper — every owned tool takes short model-authored strings. */
function strings(...names: string[]): Record<string, unknown> {
  return Object.fromEntries(
    names.map((name) => [name, { type: "string", description: name }]),
  );
}

function schema(properties: Record<string, unknown>, required: string[]): ToolParamsSchema {
  return { type: "object", required, properties } as ToolParamsSchema;
}

function makeTool(
  name: string,
  mode: TutorMode,
  description: string,
  params: ToolParamsSchema,
  buildItem: (p: Params) => Dict,
  summary: (index: number, item: Dict) => string,
): BaseTool {
  class TutorModeTool extends BaseTool<Params> {
    name = name;
    toolIcon = "🎓";
    params = params;
    mutating = true;
    description = description;

    async execute(p: Params): Promise<ToolResult> {
      const stateId = String(p[STATE_ID_PARAM] ?? "").trim();
      const state = get_state(stateId);
      if (!state) {
        return fail("No tutor-mode turn is active; this tool is unavailable.");
      }
      const item = buildItem(p);
      const index = append_item(stateId, item);
      if (index === null) return fail("Tutor-mode turn state is missing.");
      return ok(
        JSON.stringify({
          mode,
          status: "recorded",
          index,
          item,
          note: summary(index, item),
        }),
      );
    }
  }
  return new TutorModeTool();
}

/** Explain: record the three-part structure of a longer explanation. */
export const explainOutline = makeTool(
  "explain_outline",
  "explain",
  "Record the analogy, precise definition and common misconception you will use to explain a concept. Call once before writing a longer explanation.",
  schema(strings("analogy", "definition", "misconception"), [
    "analogy",
    "definition",
    "misconception",
  ]),
  (p) => ({
    analogy: String(p.analogy ?? ""),
    definition: String(p.definition ?? ""),
    misconception: String(p.misconception ?? ""),
  }),
  () => "Write the explanation in that order, then check understanding.",
);

/** Solve: hand the learner one hint at a time. */
export const solveHint = makeTool(
  "solve_hint",
  "solve",
  "Record the hint for the current step before revealing the working. Use one hint per step and let the learner try first.",
  schema(strings("step", "hint"), ["step", "hint"]),
  (p) => ({ step: String(p.step ?? ""), hint: String(p.hint ?? "") }),
  (n, item) => `Hint ${n} for ${String(item.step || "this step")} recorded. Wait for the learner.`,
);

/** Practice: register one question; keeps a quiz to one-at-a-time. */
export const practiceItem = makeTool(
  "practice_item",
  "practice",
  "Record one practice question (with its kind and difficulty) before showing it. Ask one question at a time.",
  schema(strings("question", "kind", "difficulty"), ["question"]),
  (p) => ({
    question: String(p.question ?? ""),
    kind: String(p.kind ?? "short_answer"),
    difficulty: String(p.difficulty ?? "medium"),
  }),
  (n) => `Question ${n} registered. Show it and wait for the answer before marking.`,
);

/** Plan: record a milestone with its tasks and review point. */
export const planMilestone = makeTool(
  "plan_milestone",
  "plan",
  "Record one milestone of the study plan: its title, small tasks and a review point. Call per milestone before presenting the plan.",
  schema({ ...strings("title", "review"), tasks: { type: "array", items: { type: "string" } } }, [
    "title",
  ]),
  (p) => ({
    title: String(p.title ?? ""),
    tasks: Array.isArray(p.tasks) ? p.tasks.map((task) => String(task)) : [],
    review: String(p.review ?? ""),
  }),
  (n, item) => `Milestone ${n}: ${String(item.title || "untitled")} recorded.`,
);

/** Research: register a source actually read, for a numbered citation. */
export const researchSource = makeTool(
  "research_source",
  "research",
  "Record a source you actually read before citing it. Returns the citation number to use in the answer.",
  schema(strings("title", "url", "claim"), ["title", "claim"]),
  (p) => ({
    title: String(p.title ?? ""),
    url: String(p.url ?? ""),
    claim: String(p.claim ?? ""),
  }),
  (n, item) => `Cite this as [CIT-${n}] — ${String(item.title || "untitled")}.`,
);

export const TUTOR_MODE_TOOLS: Record<TutorMode, BaseTool> = {
  explain: explainOutline,
  solve: solveHint,
  practice: practiceItem,
  plan: planMilestone,
  research: researchSource,
};

export const TUTOR_MODE_TOOL_NAMES: Record<TutorMode, string> = {
  explain: explainOutline.name,
  solve: solveHint.name,
  practice: practiceItem.name,
  plan: planMilestone.name,
  research: researchSource.name,
};

/** The single mode-owned tool exposed for a selected tutor mode. */
export function ownedToolsForMode(mode: TutorMode): BaseTool[] {
  return [TUTOR_MODE_TOOLS[mode]];
}
