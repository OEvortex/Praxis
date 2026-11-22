// Port of deeptutor/capabilities/mastery/mode.py — what a mastery
// conversation is doing right now, and which tools each mode may run.
//
// Faithful port: three modes (outline / study / review) are mutable state on
// the session, toggled mid-turn by the ``mastery_mode`` tool. Every mastery
// tool is mounted every turn and checks ``toolIsAllowed`` at call time —
// see the upstream module docstring for why enforcement moved from mount
// time to call time (a turn's tool schemas are assembled once).

export const OUTLINE = "outline";
export const STUDY = "study";
export const REVIEW = "review";

export const MODES: readonly string[] = [OUTLINE, STUDY, REVIEW];

/** Mode a conversation is assumed to be in when nothing was recorded. */
export const DEFAULT_MODE = STUDY;

/**
 * Which mode owns each mode-exclusive tool. Everything absent is shared by
 * all three modes. Mirrors upstream ``TOOL_MODES``.
 */
export const TOOL_MODES: Record<string, readonly string[]> = {
  mastery_build: [OUTLINE],
  mastery_revise: [OUTLINE],
  mastery_quiz: [STUDY, REVIEW],
  mastery_grade: [STUDY, REVIEW],
  mastery_assess: [STUDY, REVIEW],
  mastery_skip_question: [STUDY, REVIEW],
  mastery_repair_question: [STUDY, REVIEW],
  mastery_defer_objective: [STUDY, REVIEW],
  mastery_note_explained: [STUDY, REVIEW],
};

/** The mode to *show and frame with*; unrecognised values fall back. */
export function normalizeMode(value: unknown): string {
  const candidate = String(value ?? "").trim().toLowerCase();
  return MODES.includes(candidate) ? candidate : DEFAULT_MODE;
}

/**
 * The mode to *enforce against*, or null when none was recorded. Deliberately
 * different from normalizeMode: conversations that predate modes (and turns
 * that never recorded one) enforce nothing.
 */
export function enforcedMode(value: unknown): string | null {
  const candidate = String(value ?? "").trim().toLowerCase();
  return MODES.includes(candidate) ? candidate : null;
}

/** Whether ``toolName`` may run in ``mode``. Unlisted tools are shared. */
export function toolIsAllowed(toolName: string, mode: unknown): boolean {
  const allowed = TOOL_MODES[toolName];
  if (allowed === undefined) return true;
  const current = enforcedMode(mode);
  return current === null ? true : allowed.includes(current);
}

/** Why this mode cannot be entered, or "". Shared by tool and REST surface. */
export function admissionError(mode: unknown, hasOutline: boolean): string {
  if (normalizeMode(mode) === STUDY && !hasOutline) {
    return (
      "There is no outline to study yet. Stay in 'outline' and design " +
      "one with the learner first."
    );
  }
  return "";
}

/** The modes ``toolName`` belongs to, or [] when it is shared. */
export function owningModes(toolName: string): string[] {
  const allowed = TOOL_MODES[toolName];
  return allowed ? MODES.filter((m) => allowed.includes(m)) : [];
}

/** Why a call was refused, and the one move that fixes it. */
export function wrongModeMessage(toolName: string, mode: unknown): string {
  const targets = owningModes(toolName);
  const current = normalizeMode(mode);
  const listed = targets.map((t) => `'${t}'`).join(" or ") || "another mode";
  return targets.length
    ? `${toolName} belongs to the ${listed} mode, and this conversation is ` +
      `in '${current}'. Call mastery_mode with mode='${targets[0]}' first — ` +
      "tell the learner what you are switching to and why, because the mode " +
      "is shown to them above the conversation."
    : `${toolName} cannot run in '${current}'.`;
}
