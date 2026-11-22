// the seam between the
// chat-loop solver and the SolveSession: solve_plan / solve_finish_step /
// solve_replan. Auto-mounted only when a solve turn is active.
//
// The active session id is injected server-side (upstream
// ``_solve_session_id`` kwarg; here ``_solve_session_id`` param or the
// ``current_solve_session_id`` context var); the model never supplies it.
// ``solve_finish_step`` emits a ``_context_checkpoint`` in its result metadata
// so the loop folds the just-finished step's tool chatter into a one-line
// summary.

import { BaseTool, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import { get_session, resolve_solve_session_id_from_params } from "./session.js";
import type { Dict } from "../../shared/types.js";

export const SOLVE_TOOL_NAMES = [
  "solve_plan",
  "solve_finish_step",
  "solve_replan",
] as const;

function _json_result(
  payload: Dict,
  meta_key: string,
  extra_meta?: Dict,
): ToolResult {
  const metadata: Dict = { [meta_key]: payload };
  if (extra_meta) Object.assign(metadata, extra_meta);
  return {
    success: true,
    result: JSON.stringify(payload),
    metadata,
  };
}

function _no_session_result(): ToolResult {
  return fail(
    "No solve session is active on this turn; solve tools are unavailable.",
  );
}

function _parse_steps(raw: unknown): [string, string][] {
  /** Validate the model-authored step list into ``(id, goal)`` pairs.
   * Ids are server-generated (``S1``, ``S2``, …); steps without a goal are
   * dropped. */
  if (!Array.isArray(raw)) return [];
  const steps: [string, string][] = [];
  for (const item of raw) {
    let goal = "";
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      goal = String((item as Dict)["goal"] ?? "").trim();
    } else {
      goal = String(item ?? "").trim();
    }
    if (!goal) continue;
    steps.push([`S${steps.length + 1}`, goal]);
  }
  return steps;
}

const _STEPS_SCHEMA = {
  type: "array",
  description: "Ordered steps, each {goal}. Goals are short imperative phrases.",
  items: {
    type: "object",
    properties: { goal: { type: "string" } },
    required: ["goal"] as unknown as boolean,
  },
};

// ---------------------------------------------------------------------------
// solve_plan
// ---------------------------------------------------------------------------

export interface SolvePlanParams { analysis?: string; steps?: unknown }
export const solvePlanParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["analysis", "steps"],
  properties: {
    analysis: {
      type: "string",
      description:
        "One or two sentences: what the problem asks and your approach.",
    },
    steps: _STEPS_SCHEMA,
  },
};

export class SolvePlanTool extends BaseTool<SolvePlanParams> {
  name = "solve_plan";
  toolIcon = "🧭";
  params = solvePlanParamsSchema;
  mutating = true;
  description =
    "Lay out your plan for solving the problem: a short analysis plus an " +
    "ordered list of steps. Call this FIRST, before doing any work. Then " +
    "work the steps one at a time with the available tools, calling " +
    "solve_finish_step after each. Keep the plan tight (2-6 steps); for a " +
    "trivial problem a single step is fine.";

  async execute(p: SolvePlanParams): Promise<ToolResult> {
    const raw = p as unknown as Record<string, unknown>;
    const sessionId = resolve_solve_session_id_from_params(raw);
    if (!sessionId) return _no_session_result();
    const steps = _parse_steps(p.steps);
    if (!steps.length) {
      return fail("solve_plan needs a non-empty 'steps' array, each with a 'goal'.");
    }
    const analysis = String(p.analysis ?? "").trim();
    const session = get_session(sessionId);
    if (session.steps.length) {
      // A second solve_plan would wipe progress and skip the replan budget.
      return {
        success: false,
        result: JSON.stringify({
          status: "plan_exists",
          plan: session.progress_text(),
          instruction:
            "A plan is already set. Continue it; call solve_replan " +
            "only if the approach has genuinely failed.",
        }),
        metadata: { solve_plan: { status: "plan_exists" } },
      };
    }
    session.set_plan(analysis, steps);
    const first = session.next_step();
    return _json_result(
      {
        status: "planned",
        analysis,
        steps: session.map(),
        next: first ? first.to_dict() : null,
        instruction:
          "Work the first step now using the available tools, then call " +
          "solve_finish_step with a short summary of its result. Do not " +
          "skip steps.",
      },
      "solve_plan",
    );
  }
}
export const solve_plan = new SolvePlanTool();

// ---------------------------------------------------------------------------
// solve_finish_step
// ---------------------------------------------------------------------------

export interface SolveFinishStepParams { step_id?: string; summary?: string }
export const solveFinishStepParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["step_id", "summary"],
  properties: {
    step_id: {
      type: "string",
      description: "The step id from solve_plan (e.g. 'S1').",
    },
    summary: {
      type: "string",
      description:
        "Short summary of the step's result, kept as its record.",
    },
  },
};

export class SolveFinishStepTool extends BaseTool<SolveFinishStepParams> {
  name = "solve_finish_step";
  toolIcon = "✅";
  params = solveFinishStepParamsSchema;
  mutating = true;
  description =
    "Mark the current step done and move on. Pass a short summary of what " +
    "the step established (the key result / value / conclusion) — this is " +
    "kept as the step's record while its intermediate tool output is folded " +
    "away to save context. Returns the next step to work on, or signals " +
    "that all steps are done.";

  async execute(p: SolveFinishStepParams): Promise<ToolResult> {
    const raw = p as unknown as Record<string, unknown>;
    const sessionId = resolve_solve_session_id_from_params(raw);
    if (!sessionId) return _no_session_result();
    const stepId = String(p.step_id ?? "").trim();
    const summary = String(p.summary ?? "").trim();
    const session = get_session(sessionId);
    if (!session.steps.length) {
      return fail("No plan yet. Call solve_plan before solve_finish_step.");
    }
    const step = session.mark_done(stepId, summary);
    if (step === null) {
      return fail(
        `Unknown step ${JSON.stringify(stepId)}; valid ids: ${JSON.stringify(session.steps.map((s) => s.id))}.`,
      );
    }
    const nxt = session.next_step();
    const payload: Dict = {
      status: "step_done",
      completed: stepId,
      next: nxt ? nxt.to_dict() : null,
      all_done: session.all_done(),
      instruction: nxt === null
        ? "Write the final answer now."
        : "Work the next step, then call solve_finish_step again.",
    };
    // The checkpoint summary persists this step's outcome while the loop
    // folds its intermediate tool messages away. The fold also drops this
    // result and the solve_plan one, so the plan rides along as checkpoint
    // state: the loop keeps only its latest copy.
    const checkpoint = `[${step.id}] ${step.goal} — done. ${summary}`.trim();
    return _json_result(payload, "solve_finish_step", {
      _context_checkpoint: {
        summary: checkpoint,
        state: session.progress_text(),
      },
    });
  }
}
export const solve_finish_step = new SolveFinishStepTool();

// ---------------------------------------------------------------------------
// solve_replan
// ---------------------------------------------------------------------------

export interface SolveReplanParams { reason?: string; steps?: unknown }
export const solveReplanParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["reason", "steps"],
  properties: {
    reason: {
      type: "string",
      description: "Why the current plan failed and what changes.",
    },
    steps: {
      ..._STEPS_SCHEMA,
      description: "The new ordered steps, each {goal}.",
    },
  },
};

export class SolveReplanTool extends BaseTool<SolveReplanParams> {
  name = "solve_replan";
  toolIcon = "🔄";
  params = solveReplanParamsSchema;
  mutating = true;
  description =
    "Replace the plan when the current approach has stalled or proved " +
    "wrong. Give the reason and a fresh ordered list of steps. This is " +
    "budget-limited — use it only for a genuine course correction, not " +
    "minor tweaks. If the budget is spent, finish with what you have.";

  async execute(p: SolveReplanParams): Promise<ToolResult> {
    const raw = p as unknown as Record<string, unknown>;
    const sessionId = resolve_solve_session_id_from_params(raw);
    if (!sessionId) return _no_session_result();
    const steps = _parse_steps(p.steps);
    if (!steps.length) {
      return fail("solve_replan needs a non-empty 'steps' array, each with a 'goal'.");
    }
    const reason = String(p.reason ?? "").trim();
    const session = get_session(sessionId);
    if (!session.replan(reason, steps)) {
      return {
        success: false,
        result: JSON.stringify({
          status: "budget_exhausted",
          instruction:
            "Replan budget is spent. Do not replan again — finish " +
            "the problem with the best of what you have.",
        }),
        metadata: { solve_replan: { status: "budget_exhausted" } },
      };
    }
    const first = session.next_step();
    return _json_result(
      {
        status: "replanned",
        reason,
        replans_used: session.replans,
        replans_max: session.max_replans,
        steps: session.map(),
        next: first ? first.to_dict() : null,
      },
      "solve_replan",
    );
  }
}
export const solve_replan = new SolveReplanTool();

export const SOLVE_TOOLS = [solve_plan, solve_finish_step, solve_replan];
