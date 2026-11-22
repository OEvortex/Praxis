// Port of deeptutor/capabilities/mastery/mode.py — what a mastery
// conversation is doing right now.

export const OUTLINE = "outline";
export const STUDY = "study";
export const REVIEW = "review";

export const MODES: string[] = [OUTLINE, STUDY, REVIEW];

export const DEFAULT_MODE = STUDY;

export const TOOL_MODES: Record<string, string[]> = {
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

export function normalizeMode(value: unknown): string {
  const candidate = String(value ?? "").trim().toLowerCase();
  return MODES.includes(candidate) ? candidate : DEFAULT_MODE;
}

export function enforcedMode(value: unknown): string | null {
  const candidate = String(value ?? "").trim().toLowerCase();
  return MODES.includes(candidate) ? candidate : null;
}

export function toolIsAllowed(toolName: string, mode: unknown): boolean {
  const allowed = TOOL_MODES[toolName];
  if (allowed === undefined) return true;
  const current = enforcedMode(mode);
  return current === null ? true : allowed.includes(current);
}

export function admissionError(mode: unknown, hasOutline: boolean): string {
  if (normalizeMode(mode) === STUDY && !hasOutline) {
    return (
      "There is no outline to study yet. Stay in 'outline' and design " +
      "one with the learner first."
    );
  }
  return "";
}

export function owningModes(toolName: string): string[] {
  const allowed = TOOL_MODES[toolName];
  return allowed ? MODES.filter((m) => allowed.includes(m)) : [];
}

export function wrongModeMessage(toolName: string, mode: unknown): string {
  const targets = owningModes(toolName);
  const current = normalizeMode(mode);
  const listed = targets.length
    ? targets.map((t) => `'${t}'`).join(" or ")
    : "another mode";
  if (targets.length) {
    return (
      `${toolName} belongs to the ${listed} mode, and this conversation is ` +
      `in '${current}'. Call mastery_mode with mode='${targets[0]}' first — ` +
      "tell the learner what you are switching to and why, because the mode " +
      "is shown to them above the conversation."
    );
  }
  return `${toolName} cannot run in '${current}'.`;
}
