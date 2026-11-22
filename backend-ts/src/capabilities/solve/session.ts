// Port of deeptutor/capabilities/solve/session.py — SolveSession: single-turn,
// in-memory state for the solve loop capability. A solve turn is one-shot, so
// the session lives only for the turn, keyed by the id the pipeline injects
// as ``_solve_session_id`` (see capability.ts ``resolve_solve_session_id``).
//
// Like upstream this store is a bounded, process-local map: a solve turn runs
// in one process, sessions are small and short-lived, and the bound stops a
// long-running server from leaking.

import { ContextVar } from "../../agent/turn_context.js";

export const DEFAULT_MAX_REPLANS = 2;
const MAX_STEPS = 12;
const MAX_SESSIONS = 256;

export interface SolveStepData {
  id: string;
  goal: string;
  done: boolean;
  summary?: string;
}

export class SolveStep {
  id: string;
  goal: string;
  done = false;
  summary = "";

  constructor(id: string, goal: string) {
    this.id = id;
    this.goal = goal;
  }

  to_dict(): SolveStepData {
    return { id: this.id, goal: this.goal, done: this.done };
  }
}

export class SolveSession {
  session_id: string;
  analysis = "";
  steps: SolveStep[] = [];
  replans = 0;
  max_replans = DEFAULT_MAX_REPLANS;

  constructor(session_id: string) {
    this.session_id = session_id;
  }

  set_plan(analysis: string, steps: [string, string][]): void {
    this.analysis = analysis;
    this.steps = steps
      .slice(0, MAX_STEPS)
      .map(([sid, goal]) => new SolveStep(sid, goal));
  }

  /** Replace the plan, bumping the replan counter. Returns false (and leaves
   * the plan untouched) once the budget is spent. */
  replan(analysis: string, steps: [string, string][]): boolean {
    if (this.replans >= this.max_replans) return false;
    this.replans += 1;
    this.set_plan(analysis, steps);
    return true;
  }

  mark_done(step_id: string, summary: string): SolveStep | null {
    for (const step of this.steps) {
      if (step.id === step_id) {
        step.done = true;
        step.summary = summary.trim();
        return step;
      }
    }
    return null;
  }

  next_step(): SolveStep | null {
    return this.steps.find((step) => !step.done) ?? null;
  }

  map(): SolveStepData[] {
    return this.steps.map((step) => step.to_dict());
  }

  all_done(): boolean {
    return this.steps.length > 0 && this.steps.every((step) => step.done);
  }

  progress_text(): string {
    const nxt = this.next_step();
    const lines = ["[Solve plan]"];
    for (const step of this.steps) {
      const mark = step.done ? "done" : step === nxt ? "next" : "todo";
      lines.push(`- ${step.id} [${mark}] ${step.goal}`);
    }
    lines.push(
      nxt === null
        ? "All steps are done: write the final answer now."
        : `Work ${nxt.id} now, then call solve_finish_step.`,
    );
    return lines.join("\n");
  }
}

// JS Map preserves insertion order → OrderedDict equivalent.
const _SESSIONS = new Map<string, SolveSession>();

/** Fetch (or lazily create) the turn's session, evicting oldest past cap. */
export function get_session(session_id: string): SolveSession {
  const sid = (session_id || "").trim() || "default";
  let session = _SESSIONS.get(sid);
  if (session === undefined) {
    session = new SolveSession(sid);
    _SESSIONS.set(sid, session);
    while (_SESSIONS.size > MAX_SESSIONS) {
      const oldest = _SESSIONS.keys().next().value;
      if (oldest === undefined) break;
      _SESSIONS.delete(oldest);
    }
  }
  return session;
}

// ---------------------------------------------------------------------------
// Server-side session-id injection (upstream kwargs augmenter)
// ---------------------------------------------------------------------------

/** Turn-scoped solve session id, published by the turn runtime. */
export const current_solve_session_id = new ContextVar<string>("");

export function set_solve_session(session_id: string, max_replans?: number): void {
  current_solve_session_id.set(session_id || "");
  if (max_replans !== undefined) {
    get_session(session_id).max_replans = max_replans;
  }
}

export function resolve_solve_session_id_from_params(
  params: Record<string, unknown>,
): string {
  const injected = params["_solve_session_id"];
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  return current_solve_session_id.get().trim();
}
