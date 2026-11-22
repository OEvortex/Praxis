// the mastery tools the
// tutor loop mounts while a mastery path is active.
//
// Adaptations to the Praxis runtime (documented in the port report):
//  * Tools are stateless ``BaseTool`` classes; the active path and session
//    mode are resolved per call from the session binding in store.ts
//    (``current_session_id`` context var / ctx.sessionId), instead of the
//    ``_mastery_path_id`` / ``_mastery_session_mode`` kwargs the upstream
//    loop capability injected. ``paramsSchema`` JSON schemas replace the
//    ToolParameter lists; descriptions are verbatim ports.
//  * ``ensure_mode`` gating happens at call time via mode.ts, exactly like
//    upstream — every tool is mounted every turn.
//  * The deterministic engine lives in engine.ts; LLM judgement (semantic
//    grading, qualitative assessment) runs through services/llm_text.ts.
//  * Dropped upstream subsystems: lesson_evidence/source binding, question
//    bank sync, turn-event option recovery, path leases, interaction events.

import { randomUUID } from "node:crypto";
import { BaseTool, ToolResult, type Ctx, type ToolParamsSchema } from "../../shared/vtx.js";
import { current_session_id } from "../../agent/turn_context.js";
import {
  OUTLINE,
  STUDY,
  REVIEW,
  MODES,
  normalizeMode,
  enforcedMode,
  toolIsAllowed,
  admissionError,
  owningModes,
  wrongModeMessage,
} from "./mode.js";
import {
  activePathId,
  getSessionBinding,
  getTopic,
  listPaths,
  loadPath,
  mutatePath,
  pathExists,
  sanitizePathId,
  setSessionMode,
  setSessionPath,
  type LearningProgress,
  type MasteryInteraction,
  type PendingOption,
  type PendingQuestion,
} from "./store.js";
import {
  MasteryInteractionError,
  NoPendingInteractionError,
  StaleInteractionError,
  abandonActiveQuestion,
  assessQualitative,
  attemptNumber,
  buildGradeResult,
  buildQuestionCard,
  canonicalLabels,
  choiceMap,
  deferObjective,
  displayMastery,
  dueReviews,
  findKnowledgePoint,
  gateKind,
  gateThreshold,
  getActiveInteraction,
  getInteraction,
  gradeAnswer,
  gradeInteraction,
  hasOptionBodies,
  isMastered,
  isReadableChoiceAnswer,
  labelledOptions,
  learningStage,
  listPathOverviews,
  mapSummary,
  nextObjective,
  optionLabelIntent,
  parseModulesWithRefs,
  parseOptions,
  pathDisplayName,
  planModuleRevision,
  profileStatus,
  publicPendingQuestion,
  readOptionObjects,
  recordLearnerProfile,
  registerQuestion,
  repairQuestion,
  replaceModulesForPath,
  resolveAnswer,
  resolveChoiceSubmission,
  stripEchoedOptions,
  type NextStep,
} from "./engine.js";
import { modeInstructions } from "./pipeline.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function arr<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export const QUESTION_CARD_KEY = "mastery_question";
export const GRADE_META_KEY = "mastery_grade";

export const MASTERY_TOOL_NAMES: readonly string[] = [
  "mastery_prepare_lesson",
  "mastery_status",
  "mastery_quiz",
  "mastery_note_explained",
  "mastery_grade",
  "mastery_skip_question",
  "mastery_repair_question",
  "mastery_defer_objective",
  "mastery_assess",
  "mastery_build",
  "mastery_mode",
  "mastery_profile",
  "mastery_revise",
  "mastery_paths",
  "mastery_switch",
  "mastery_leave",
];

const QUESTION_TYPES = ["choice", "short", "open"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const ALLOWED_KP_TYPES = ["memory", "concept", "procedure", "design"];

interface TurnRef {
  sessionId: string;
  pathId: string;
  mode: string | null; // raw stored mode; null = unenforced
  turnId: string;
}

function turnRef(params: Record<string, unknown>, ctx?: Ctx): TurnRef {
  const sessionId =
    str(params["__session_id"]) ||
    str(ctx?.sessionId) ||
    current_session_id.get() ||
    "";
  const configured = str(params["__mastery_path_id"]);
  const pathId = configured ? sanitizePathId(configured) : activePathId(sessionId);
  const mode = sessionModeOrNull(sessionId);
  const turnId = str(params["__turn_id"]) || `turn-${Date.now().toString(36)}`;
  return { sessionId, pathId, mode, turnId };
}

function sessionModeOrNull(sessionId: string): string | null {
  const bound = getSessionBinding(sessionId)?.mode;
  return bound && bound.trim() ? bound : null;
}

function noPathResult(): ToolResult {
  const r = new ToolResult(
    false,
    "No mastery path is active on this turn; mastery tools are unavailable.",
  );
  return r;
}

function jsonResult(payload: Record<string, unknown>, metaKey: string, success = true): ToolResult {
  const r = new ToolResult(success, JSON.stringify(payload));
  (r as unknown as Record<string, unknown>)["metadata"] = { [metaKey]: payload };
  return r;
}

function wrongMode(toolName: string, ref: TurnRef): ToolResult | null {
  if (toolIsAllowed(toolName, ref.mode)) return null;
  return new ToolResult(false, wrongModeMessage(toolName, ref.mode));
}

function noBuiltPathResult(tool: string): ToolResult {
  return new ToolResult(
    false,
    `This conversation is not on a built mastery path yet, so ${tool} has ` +
      "nothing to act on. Call mastery_paths to see the learner's existing " +
      "paths (mastery_switch to continue one), or mastery_build to design " +
      "one here.",
  );
}

function hasOutline(progress: LearningProgress | null): boolean {
  return Boolean(
    progress && (progress.modules ?? []).some((m) => (m.knowledge_points ?? []).length > 0),
  );
}

async function unbuiltStatusMessage(pathId: string, progress: LearningProgress | null): Promise<string> {
  const topic = progress ? getTopic(pathId) : null;
  const goal = str(isRecord(topic) ? (topic as unknown as Record<string, unknown>)["goal"] : "").trim();
  if (goal) {
    const name = str(((topic as unknown as Record<string, unknown>)["name"]) ?? "") || pathDisplayName(progress!);
    return (
      `This conversation is on the mastery goal '${name}', which the learner ` +
      "created and which has no outline yet. Designing that outline is what " +
      "this conversation is for — it is a first draft, not an edit of " +
      `something they already agreed to. In their own words they want: ` +
      `'${goal}'. The materials they chose for it are listed under ` +
      "[Topic Materials]; all of them are in play. Do NOT offer to switch to " +
      "another goal and do NOT ask which course they mean — they are already " +
      "in this one. Read the materials, ask what you cannot read off them, " +
      "then call mastery_build."
    );
  }
  const overviews = listPathOverviews().filter(
    (o) => num(o["objectives"]) > 0 && o["path_id"] !== pathId,
  );
  if (!overviews.length) {
    return "No mastery path has been built yet. Design one from the learner's materials and call mastery_build.";
  }
  if (overviews.length === 1) {
    return (
      "This conversation is not on a built path, but the learner has one " +
      "built elsewhere. Call mastery_paths for its id and mastery_switch " +
      "to continue it — only call mastery_build if they want a new path " +
      "here."
    );
  }
  return (
    `This conversation is not on a built path, but the learner already has ` +
    `${overviews.length} built elsewhere. Call mastery_paths, then ask the ` +
    "learner which one they mean and mastery_switch to the one they name — " +
    "do not pick for them. Only call mastery_build if they want a new path " +
    "here."
  );
}

function reviewScopeRefusal(
  ref: TurnRef,
  progress: LearningProgress | null,
  kpId: string,
): ToolResult | null {
  if (enforcedMode(ref.mode) !== REVIEW) return null;
  if (!progress || !kpId) return null;
  const [kp] = findKnowledgePoint(progress, kpId);
  if (!kp || isMastered(progress, kp)) return null;
  return new ToolResult(
    false,
    `'${kp.name}' is not mastered yet, and this conversation is ` +
      "reviewing. Review re-tests what the learner has already proven; " +
      "teaching something new is what 'study' is for. Either pick a " +
      "mastered knowledge point, or call mastery_mode with mode='study' " +
      "and say why you are switching.",
  );
}

function nextDict(progress: LearningProgress, sessionId = ""): Record<string, unknown> {
  return { ...nextObjective(progress, sessionId) };
}

function profilePayload(
  progress: LearningProgress | null,
  kpId?: string,
  includeHistory = false,
): Record<string, unknown> {
  return profileStatus(progress, kpId, includeHistory);
}

// ---------------------------------------------------------------------------
// mastery_status
// ---------------------------------------------------------------------------

const statusSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    include_teaching_history: {
      type: "boolean",
      description:
        "Read all bounded path teaching notes only for explicit inspection/correction or obsolete-note cleanup. Default returns current objective notes only.",
    },
  },
};

export class MasteryStatusTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_status";
  toolIcon = "🎯";
  mutating = false;
  description =
    "Read the learner's mastery path: the next objective to work on " +
    "(decided by a hard mastery gate), any question awaiting an " +
    "answer, due reviews, and a map of every objective's status " +
    "(new / learning / mastered). Use the current-turn runtime snapshot " +
    "when supplied; otherwise call this FIRST. Refresh after changing " +
    "the path, mode, outline, or progress when updated state is needed. " +
    "Never guess the next objective or reuse an earlier turn's snapshot. " +
    "The automatic working brief omits unrelated outline details; call this tool " +
    "for the full map before selecting another lesson or editing the outline.";
  params = statusSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    if (!pathExists(ref.pathId)) return noPathResult();
    const includeHistory = p["include_teaching_history"] === true;
    const progress = loadPath(ref.pathId);
    const topic = progress ? getTopic(ref.pathId) : null;
    const topicRec: Record<string, unknown> = topic ? (topic as unknown as Record<string, unknown>) : {};
    const identity = {
      path_id: ref.pathId,
      path_name: progress ? pathDisplayName(progress) : "",
      goal: str(topicRec["goal"] ?? ""),
      sources: arr(topicRec["sources"]).map((s) => {
        const sr = isRecord(s) ? s : {};
        return {
          id: sr["id"],
          kind: sr["kind"],
          label: sr["label"],
          available: sr["available"],
        };
      }),
    };
    if (!progress || !hasOutline(progress)) {
      return jsonResult(
        {
          status: "empty",
          path_revision: progress?.version ?? 0,
          ...identity,
          message: await unbuiltStatusMessage(ref.pathId, progress),
          ...profilePayload(progress, undefined, includeHistory),
        },
        "mastery_status",
      );
    }
    const payload: Record<string, unknown> = {
      status: "active",
      path_revision: progress.version,
      ...identity,
      mode: normalizeMode(ref.mode),
      next: nextDict(progress, ref.sessionId),
      map: mapSummary(progress),
      ...profilePayload(progress, undefined, includeHistory),
      learning_stages: Object.fromEntries(
        (progress.modules ?? []).flatMap((m) =>
          (m.knowledge_points ?? []).map((kp) => [kp.id, learningStage(progress, kp.id)]),
        ),
      ),
      visual_requirements: Object.fromEntries(
        (progress.modules ?? []).flatMap((m) =>
          (m.knowledge_points ?? []).map((kp) => [
            kp.id,
            {
              required: kp.required_visual_tasks ?? [],
              demonstrated: [],
            },
          ]),
        ),
      ),
      due_review_ids: dueReviews(progress).slice(0, 3).map((t) => t.knowledge_point_id),
    };
    const interaction = getActiveInteraction(progress);
    if (interaction) {
      const pendingInteraction: Record<string, unknown> = {
        question_id: interaction.interaction_id,
        status: interaction.status,
      };
      const q = interaction.question;
      if (q.questions?.length) {
        const gradedIds = new Set(
          arr<Record<string, unknown>>(interaction.result["results"]).map((r) => r["question_id"]),
        );
        pendingInteraction["answers"] = { ...interaction.answers };
        pendingInteraction["remaining_question_ids"] = q.questions
          .map((leaf) => leaf.question_id)
          .filter((id) => !gradedIds.has(id));
        pendingInteraction["instruction"] =
          "Keep committed child replies verbatim. Grade only actual replies; " +
          "unanswered children remain open and earn no score. Continue at the requested " +
          "pace; explain reported gaps, but never infer confusion from an unanswered " +
          "item or invent a missing reply.";
      } else if (interaction.status === "answered") {
        pendingInteraction["learner_answer"] = interaction.user_answer;
      } else {
        pendingInteraction["instruction"] =
          "A question is already open. If the learner has answered it " +
          "anywhere in this conversation — on the card or in an ordinary " +
          "message — call mastery_grade with their answer and this " +
          "question_id. If they asked you something instead, answer that " +
          "first and leave the question open; re-posing it over their " +
          "question is how the same card came back four times while it " +
          "went unanswered. Call mastery_quiz to put it back in front of " +
          "them once they are ready — the engine holds the original and " +
          "re-poses it verbatim, so what you pass is ignored, and that " +
          "call ends the turn.";
      }
      pendingInteraction["session_id"] = interaction.session_id;
      if (
        ref.sessionId &&
        interaction.session_id &&
        interaction.session_id !== ref.sessionId
      ) {
        pendingInteraction["instruction"] =
          "This pending card belongs to an earlier conversation. For fresh practice " +
          "in this conversation, submit a new source-supported mastery_quiz with " +
          "pending_action='retain'; once it validates the old card is archived. " +
          "Use resume only when the learner requests that previous card. " +
          "Previously committed answers must be assessed before archiving. " +
          "Never grade an unanswered question or copy its answer key as a reply.";
      }
      payload["pending_interaction"] = pendingInteraction;
    }
    return jsonResult(payload, "mastery_status");
  }
}

// ---------------------------------------------------------------------------
// mastery_mode
// ---------------------------------------------------------------------------

const modeSchema: ToolParamsSchema = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: [...MODES], description: "outline | study | review" },
    reason: {
      type: "string",
      description: "One short phrase for why, in the learner's language. Shown with the mode change.",
    },
  },
};

export class MasteryModeTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_mode";
  toolIcon = "🔀";
  mutating = true;
  description =
    "Switch what this conversation is doing: 'outline' to design " +
    "or change the outline, 'study' to work it forward, 'review' to " +
    "re-test what is already mastered. Call it when the learner " +
    "asks for something the current mode's tools cannot do — a " +
    "refused tool names the mode it needs. Say what you are " +
    "switching to and why: the learner sees the mode above the " +
    "conversation and can change it themselves.";
  params = modeSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    if (!pathExists(ref.pathId)) return noPathResult();
    const requested = str(p["mode"]).trim().toLowerCase();
    if (!MODES.includes(requested)) {
      return new ToolResult(
        false,
        `'${requested}' is not a mode. Use one of: ${MODES.map((m) => `'${m}'`).join(", ")}.`,
      );
    }
    const current = normalizeMode(ref.mode);
    const progress = loadPath(ref.pathId);
    const refusal = admissionError(requested, hasOutline(progress));
    if (refusal) return new ToolResult(false, refusal);
    if (ref.sessionId) setSessionMode(ref.sessionId, requested);
    return jsonResult(
      {
        status: requested === current ? "unchanged" : "switched",
        previous_mode: current,
        mode: requested,
        instructions: modeInstructions(requested),
        reason: str(p["reason"]).trim().slice(0, 200),
      },
      "mastery_mode",
    );
  }
}

// ---------------------------------------------------------------------------
// mastery_quiz
// ---------------------------------------------------------------------------

function decodeJsonOptions(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const text = raw.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const decoded = JSON.parse(text);
      if (Array.isArray(decoded) || isRecord(decoded)) return decoded;
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    "mastery_quiz.options must be an array, not a string — send " +
      "[{'label': 'A', 'body': 'first answer'}, …] directly instead of " +
      "encoding it as text.",
  );
}

function readChoiceOptions(raw: unknown): { label: string; body: string }[] {
  if (raw === null || raw === undefined) return [];
  const value = typeof raw === "string" ? decodeJsonOptions(raw) : raw;
  const read = readOptionObjects(value);
  if (read !== null) {
    const { options, unreadable } = read;
    if (unreadable.length) {
      throw new Error(
        "mastery_quiz.options entries must each be an option — " +
          "{'label': 'A', 'body': 'first answer'} or the string " +
          `'A: first answer'; got ${JSON.stringify(unreadable[0])}.`,
      );
    }
    return labelledOptions(options);
  }
  if (!Array.isArray(value)) {
    throw new Error("mastery_quiz.options must be an array of non-empty strings.");
  }
  if (value.some((o) => !String(o ?? "").trim())) {
    throw new Error("mastery_quiz.options must contain only non-empty strings.");
  }
  const texts = value.map((o) => String(o).trim());
  const intended = optionLabelIntent(texts);
  if (intended !== null) {
    const canon = canonicalLabels(intended.length);
    if (new Set(intended).size !== intended.length || intended.some((l) => !canon.has(l))) {
      throw new Error(
        `Choice option labels must run A, B, C… with one option each; got ` +
          `${JSON.stringify(intended)}. Retry mastery_quiz with one full body per label.`,
      );
    }
  }
  return Object.entries(parseOptions(texts)).map(([label, body]) => ({ label, body }));
}

function normalizeQuizContract(
  rawQuestionType: unknown,
  rawOptions: unknown,
  expectedAnswer: string,
): { questionType: string; options: { label: string; body: string }[]; expected: string } {
  const options = readChoiceOptions(rawOptions);
  const supplied = str(rawQuestionType).trim().toLowerCase();
  if (supplied && !QUESTION_TYPES.includes(supplied)) {
    throw new Error(`mastery_quiz.question_type must be one of: ${QUESTION_TYPES.join(", ")}.`);
  }
  const questionType = supplied || (options.length ? "choice" : "short");
  if (questionType !== "choice") {
    if (options.length) {
      throw new Error(
        `mastery_quiz.options cannot be used with question_type='${questionType}'; ` +
          "omit options or use question_type='choice'.",
      );
    }
    return { questionType, options: [], expected: expectedAnswer };
  }
  const labels = options.map((o) => o.label);
  const canon = canonicalLabels(labels.length);
  if (new Set(labels).size !== labels.length || labels.some((l) => !canon.has(l))) {
    throw new Error(
      `Choice option labels must run A, B, C… with one option each; got ` +
        `${JSON.stringify(labels)}. Retry mastery_quiz with one full body per label.`,
    );
  }
  const choiceOptions: Record<string, string> = {};
  for (const o of options) choiceOptions[o.label] = o.body;
  const bodies = Object.values(choiceOptions).map((b) => b.replace(/\s+/g, "").toLowerCase());
  if (new Set(bodies).size !== bodies.length) {
    throw new Error(
      "Choice option bodies must be unique; retry mastery_quiz with " +
        "distinct answer text for every option.",
    );
  }
  if (!hasOptionBodies(choiceOptions)) {
    throw new Error(
      "Choice questions need full option bodies in mastery_quiz.options " +
        "(for example {'label': 'A', 'body': 'first answer'}), not only " +
        "the labels A/B/C/D — the card renders the label itself, so a bare " +
        "label leaves the learner with nothing to read.",
    );
  }
  const resolved = resolveAnswer(expectedAnswer, choiceOptions);
  if (!resolved) {
    throw new Error(
      "Choice expected_answer must be an option label such as A/B/C/D, " +
        "or uniquely match one full option body. Retry mastery_quiz with " +
        "the correct label.",
    );
  }
  return { questionType, options, expected: resolved };
}

function shuffleChoiceOptions(
  options: { label: string; body: string }[],
  expected: string,
): { options: { label: string; body: string }[]; expected: string } {
  if (options.length < 2) return { options, expected };
  const expectedBody = options.find((o) => o.label === expected)?.body ?? "";
  const shuffled = [...options];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const remapped = shuffled.map((o, i) => ({ label: positionalLabelLocal(i), body: o.body }));
  const newExpected = remapped.find((o) => o.body === expectedBody)?.label ?? expected;
  return { options: remapped, expected: newExpected };
}
function positionalLabelLocal(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

function normalizeDifficulty(raw: unknown): string {
  const v = str(raw).trim().toLowerCase();
  return DIFFICULTIES.includes(v) ? v : "";
}

const LEAF_FIELDS = new Set([
  "knowledge_point_id",
  "question",
  "expected_answer",
  "question_type",
  "options",
  "explanation",
  "difficulty",
  "visual",
]);

const quizSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    knowledge_point_id: { type: "string", description: "Objective id from mastery_status (verbatim)." },
    question: {
      type: "string",
      description:
        "The question stem shown to the learner — the ask only. For a choice question do NOT list the options here.",
    },
    expected_answer: {
      type: "string",
      description:
        "The correct answer, used only server-side for grading. For choice questions, pass the exact full body text of the correct option, never its letter.",
    },
    question_type: { type: "string", enum: QUESTION_TYPES, description: "choice | short | open" },
    options: {
      type: "array",
      description:
        "The choices in label order, as {'label': 'A', 'body': 'the full answer text'} objects; passing options infers question_type='choice'.",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "A, B, C… in order, one per option." },
          body: { type: "string", description: "The answer text this choice offers." },
        },
      },
    },
    explanation: {
      type: "string",
      description:
        "Why the expected answer is right, in one or two sentences. Held server-side; shown on the card once graded.",
    },
    difficulty: { type: "string", enum: DIFFICULTIES, description: "How hard this question is right now." },
    visual: { type: "object", description: "Optional source-grounded visual task (advisory in this port)." },
    questions: {
      type: "array",
      description: "Two to four independently answered single-question contracts.",
      items: { type: "object" },
    },
    pending_action: {
      type: "string",
      enum: ["retain", "replace", "resume"],
      description: "Retain by default; replace only on an explicit learner request; resume re-presents the exact existing card.",
    },
    resume_question_id: { type: "string", description: "Exact CURRENT pending parent question_id, only with pending_action='resume'." },
    replace_question_id: { type: "string", description: "Exact currently pending parent question_id when replacing." },
    replacement_request: { type: "string", description: "Literal quote from the current learner message requesting replacement." },
  },
};

export class MasteryQuizTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_quiz";
  toolIcon = "❓";
  mutating = true;
  description =
    "Pose practice cards for all objective types: MEMORY, PROCEDURE, " +
    "CONCEPT, or DESIGN, singly or as a questions group. This one " +
    "call registers the expected answer with the engine for exact or " +
    "semantic grading (you never re-state the answer later) AND " +
    "puts the question in front of the learner on its own answer " +
    "card. THE TURN ENDS HERE: call it last and plan nothing after it. " +
    "Their answer arrives as the next message and you grade it on the " +
    "next turn with mastery_grade. CONCEPT / DESIGN cards are practice " +
    "only: their qualitative gate still requires mastery_assess.";
  params = quizSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();

    const pendingAction = str(p["pending_action"] || "retain").trim() || "retain";
    let resumeId = str(p["resume_question_id"]).trim();
    if (!resumeId) resumeId = "";
    const contractFields = [
      "knowledge_point_id", "question", "expected_answer", "question_type", "options",
      "explanation", "difficulty", "visual", "questions", "replace_question_id", "replacement_request",
    ];
    if (pendingAction === "resume") {
      if (
        !resumeId ||
        contractFields.some((f) => p[f] !== undefined && p[f] !== null && p[f] !== "")
      ) {
        return new ToolResult(
          false,
          "Resume needs only pending_action='resume' and the exact pending parent resume_question_id; omit new-question and replacement arguments.",
        );
      }
    } else if (resumeId) {
      return new ToolResult(false, "resume_question_id requires pending_action='resume'.");
    }
    if (pendingAction === "replace") {
      const request = str(p["replacement_request"]).trim();
      const learnerMessage = str(p["__learner_message"]);
      if (!request || !learnerMessage.includes(request)) {
        const progress = loadPath(ref.pathId);
        const active = progress ? getActiveInteraction(progress) : null;
        if (!(active && active.session_id && ref.sessionId && active.session_id !== ref.sessionId)) {
          return new ToolResult(
            false,
            "Replacement needs a literal request from the current learner message.",
          );
        }
      }
    }

    let pending: PendingQuestion | null = null;
    let echoedOptions = false;
    let rawQuestions = p["questions"];
    if (Array.isArray(rawQuestions) && !rawQuestions.length) rawQuestions = null;

    if (pendingAction === "resume") {
      pending = null;
    } else if (rawQuestions === null || rawQuestions === undefined) {
      const built = await this.buildQuestion(p, ref);
      if (built instanceof ToolResult) return built;
      pending = built.pending;
      echoedOptions = built.echoed;
    } else {
      if (!Array.isArray(rawQuestions) || rawQuestions.length < 2 || rawQuestions.length > 4) {
        return new ToolResult(false, "questions must contain two to four independent questions.");
      }
      const leaves: PendingQuestion[] = [];
      for (const raw of rawQuestions) {
        if (!isRecord(raw) || Object.keys(raw).some((k) => !LEAF_FIELDS.has(k))) {
          return new ToolResult(
            false,
            "Group leaves must use the single-question contract, without nested groups.",
          );
        }
        if (!["knowledge_point_id", "question", "expected_answer"].every((k) => raw[k] !== undefined)) {
          return new ToolResult(
            false,
            "Group leaves must use the single-question contract, without nested groups.",
          );
        }
        const leafParams = { ...p, ...raw };
        const built = await this.buildQuestion(leafParams, ref);
        if (built instanceof ToolResult) return built;
        leaves.push(built.pending);
        echoedOptions = echoedOptions || built.echoed;
      }
      pending = {
        question_id: randomUUID().replace(/-/g, ""),
        knowledge_point_id: leaves[0].knowledge_point_id,
        module_id: leaves[0].module_id,
        prompt: str(p["question"]),
        question_type: "group",
        expected_answer: "",
        options: [],
        explanation: "",
        difficulty: "",
        created_at: Date.now() / 1000,
        visual_context: {},
        accepted_answers: [],
        questions: leaves,
      };
    }

    try {
      const outcome = mutatePath<{
        progress: LearningProgress;
        interaction: MasteryInteraction;
        created: boolean;
      }>(ref.pathId, (progress) => {
        const res = registerQuestion(progress, ref.pathId, pending, {
          pending_action: pendingAction,
          replace_question_id: str(p["replace_question_id"]),
          resume_question_id: resumeId,
          session_id: ref.sessionId,
          turn_id: ref.turnId,
        });
        return { progress: res.progress, result: res };
      });
      const { progress, interaction, created } = outcome;
      const q = interaction.question;
      const [kp] = findKnowledgePoint(progress, q.knowledge_point_id);
      const card = buildQuestionCard(
        q,
        kp?.name ?? "",
        attemptNumber(progress, q.knowledge_point_id),
      );
      if (q.questions?.length) {
        const cards = arr<Record<string, unknown>>(card["questions"]);
        q.questions.forEach((leaf, i) => {
          const [obj] = findKnowledgePoint(progress, leaf.knowledge_point_id);
          if (cards[i] && isRecord(cards[i])) {
            cards[i]["objective"] = { id: leaf.knowledge_point_id, name: obj?.name ?? "" };
            cards[i]["attempt"] = attemptNumber(progress, leaf.knowledge_point_id);
          }
        });
      }
      const payload: Record<string, unknown> = {
        status: created ? "registered" : "already_pending",
        path_revision: progress.version,
        knowledge_point_id: q.knowledge_point_id,
        question_id: q.question_id,
        pending_question: publicPendingQuestion(q),
      };
      let notice = created
        ? "The question is on the learner's answer card and this turn ends " +
          "here. Their answer arrives as the next message; grade it then " +
          "with mastery_grade."
        : "No new question was posed: the learner already has an open " +
          "question on their card, and this call re-presented that same " +
          "one. Its parameters were ignored. The turn ends here — their " +
          "answer arrives as the next message. Posing a question ends the " +
          "turn, so do not call any further tools after mastery_quiz in " +
          "the same round; nothing you plan after it will run.";
      if (echoedOptions) {
        notice +=
          " Note: your question text also listed the options, so the card " +
          "would have shown each choice twice — once as prose, once as a " +
          "button. That list was removed from the stem. Pass the ask in " +
          "'question' and the choices only in 'options'.";
      }
      const qualitativePractice = (q.questions?.length ? q.questions : [q]).some((leaf) => {
        const [point] = findKnowledgePoint(progress, leaf.knowledge_point_id);
        return point !== null && ["concept", "design"].includes(point.type);
      });
      if (qualitativePractice) {
        notice +=
          " The CONCEPT / DESIGN objectives in this practice are gated qualitatively: " +
          "grading their answers will not open their qualitative gate, however right " +
          "the answers are. Use the cards to probe, then have the learner explain the idea in " +
          "their own words and record that with mastery_assess.";
      }
      const r = new ToolResult(true, notice);
      (r as unknown as Record<string, unknown>)["metadata"] = {
        mastery_quiz: payload,
        [QUESTION_CARD_KEY]: card,
      };
      return r;
    } catch (exc) {
      if (exc instanceof MasteryInteractionError || exc instanceof StaleInteractionError) {
        return new ToolResult(false, String(exc.message ?? exc));
      }
      throw exc;
    }
  }

  private async buildQuestion(
    params: Record<string, unknown>,
    ref: TurnRef,
  ): Promise<{ pending: PendingQuestion; echoed: boolean } | ToolResult> {
    const kpId = str(params["knowledge_point_id"]).trim();
    let question = str(params["question"]).trim();
    const expected = str(params["expected_answer"]).trim();
    if (!kpId || !question || !expected) {
      return new ToolResult(
        false,
        "mastery_quiz needs knowledge_point_id, question, and expected_answer.",
      );
    }
    const progress = loadPath(ref.pathId);
    if (!progress) return noBuiltPathResult("mastery_quiz");
    let contract: { questionType: string; options: { label: string; body: string }[]; expected: string };
    try {
      contract = normalizeQuizContract(params["question_type"], params["options"], expected);
    } catch (exc) {
      return new ToolResult(false, String(exc instanceof Error ? exc.message : exc));
    }
    const [stripped, echoed] = stripEchoedOptions(
      question,
      Object.fromEntries(contract.options.map((o) => [o.label, o.body])),
    );
    question = stripped;
    let finalOptions = contract.options;
    let finalExpected = contract.expected;
    if (contract.questionType === "choice") {
      const shuffled = shuffleChoiceOptions(contract.options, contract.expected);
      finalOptions = shuffled.options;
      finalExpected = shuffled.expected;
    }
    const scope = reviewScopeRefusal(ref, progress, kpId);
    if (scope) return scope;
    const [kp, moduleId] = findKnowledgePoint(progress, kpId);
    if (!kp) {
      return new ToolResult(
        false,
        `Unknown objective '${kpId}'; call mastery_status for valid ids.`,
      );
    }
    const pending: PendingQuestion = {
      question_id: randomUUID().replace(/-/g, ""),
      knowledge_point_id: kpId,
      module_id: moduleId,
      prompt: question,
      question_type: contract.questionType,
      expected_answer: finalExpected,
      options: finalOptions as PendingOption[],
      explanation: str(params["explanation"]).trim().slice(0, 2000),
      difficulty: normalizeDifficulty(params["difficulty"]),
      created_at: Date.now() / 1000,
      visual_context: {},
      accepted_answers: [],
      questions: [],
    };
    return { pending, echoed };
  }
}

// ---------------------------------------------------------------------------
// mastery_grade
// ---------------------------------------------------------------------------

const gradeSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    answer: { type: "string", description: "The learner's answer, verbatim." },
    answers: {
      type: "object",
      description:
        "For a group only: one or more exact child question_id to actual learner answer strings.",
    },
    question_id: {
      type: "string",
      description:
        "Stable question_id from mastery_status. Pass it whenever you have it.",
    },
  },
};

function assessNextMove(mastered: boolean, nextStep: Record<string, unknown>): string {
  if (!mastered) {
    return (
      "The gate is not cleared. Explain the gap this explanation left " +
      "(for a partial result, name the missing part), then ask the " +
      "learner to explain it again and record that with mastery_assess."
    );
  }
  if (nextStep["action"] === "complete") {
    return (
      "This cleared the objective's gate and the path is complete. " +
      "Say what the explanation showed and tell the learner the path is done."
    );
  }
  return (
    "This cleared the objective's gate. Say briefly what the explanation " +
    "showed, then continue with `next` in this same reply: start its " +
    "lesson or ask its first question. Do not end the turn on an " +
    "announcement of what comes next."
  );
}

export class MasteryGradeTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_grade";
  toolIcon = "✅";
  mutating = true;
  description =
    "Grade the learner's answer to the question you registered with " +
    "mastery_quiz. Exact answers use the stored key and other answers receive semantic assessment against the stored " +
    "expected answer; this updates mastery, advances spaced " +
    "repetition, and tells you whether the objective's gate is now " +
    "cleared. Then give the learner feedback.";
  params = gradeSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    let answer = str(p["__learner_message"] ?? p["answer"] ?? "");
    const submittedQuestionId = str(p["question_id"]).trim();

    const before = loadPath(ref.pathId);
    if (!before) return noBuiltPathResult("mastery_grade");
    let interaction = submittedQuestionId
      ? getInteraction(before, submittedQuestionId)
      : getActiveInteraction(before);
    if (interaction && interaction.status === "answered") {
      // The committed reply is authoritative unless it was an unreadable
      // clarifying prose on a choice card.
      const stored = String(interaction.user_answer ?? "");
      const question = interaction.question;
      const superseded =
        str(p["__learner_message"]) &&
        question.question_type !== "choice" &&
        !(question.questions ?? []).length &&
        stored &&
        answer.trim() &&
        answer.trim() !== stored.trim()
          ? answer.trim()
          : null;
      if (superseded !== null) {
        try {
          mutatePath(ref.pathId, (prog) => {
            const it = getInteraction(prog, interaction!.interaction_id);
            if (it) {
              it.user_answer = superseded;
              it.status = "answered";
              it.updated_at = Date.now() / 1000;
            }
            return prog;
          });
          interaction = getInteraction(loadPath(ref.pathId)!, interaction.interaction_id);
        } catch {
          /* keep stored */
        }
      }
      const readable =
        question.question_type !== "choice" ||
        isReadableChoiceAnswer(String(interaction?.user_answer ?? stored), choiceMap(question));
      if (readable) answer = String(interaction?.user_answer ?? stored);
    }
    const pending = interaction?.question ?? before.pending_question;
    if (pending && (pending.questions ?? []).length && !(p["answers"] !== undefined)) {
      // Group needs `answers`; fall through to single-answer grading which
      // will treat the parent as ungradeable — handled inside gradeInteraction.
    }

    try {
      const out = await mutatePathAsync(ref.pathId, async (progress) => {
        const graded = await gradeInteraction(progress, ref.pathId, {
          answer,
          answers: isRecord(p["answers"]) ? (p["answers"] as Record<string, string>) : undefined,
          question_id: submittedQuestionId,
          session_id: ref.sessionId,
          turn_id: ref.turnId,
        });
        return { progress: graded.progress, result: graded };
      });
      const { progress, interaction: gradedInteraction, replayed } = out.result;
      const q = gradedInteraction.question;
      const groupResult = gradedInteraction.result ?? {};
      const isGroup = Boolean((q.questions ?? []).length);

      if (isGroup) {
        const results = arr<Record<string, unknown>>(groupResult["results"]).map((r) => ({
          ...r,
          mastery: (() => {
            const [kp] = findKnowledgePoint(progress, str(r["knowledge_point_id"]));
            return kp ? Math.round(displayMastery(progress, kp) * 1000) / 1000 : 0;
          })(),
        }));
        return jsonResult(
          {
            question_id: q.question_id,
            question_type: "group",
            is_correct: groupResult["is_correct"] ?? null,
            complete: groupResult["complete"] ?? true,
            remaining_question_ids: groupResult["remaining_question_ids"] ?? [],
            replayed,
            path_revision: progress.version,
            result: { ...groupResult, results },
            next: nextDict(progress, ref.sessionId),
            instruction:
              "Give explanatory feedback only for answered questions. Preserve independent results; the parent grants no extra mastery. If complete=false, unanswered children remain open. Continue at the requested pace and explain reported gaps; do not infer confusion from an unanswered item, invent replies or regrade committed answers. Keep qualitative gates and adapt teaching to the learner's needs.",
          },
          GRADE_META_KEY,
        );
      }

      const [kp] = findKnowledgePoint(progress, q.knowledge_point_id);
      const isCorrect = groupResult["is_correct"] ?? null;
      const mastered = kp ? isMastered(progress, kp) : false;
      const gate = kp ? gateKind(kp) : "";
      let nextMove: string;
      if (mastered) {
        nextMove = "going: this objective is mastered, so continue with mastery_status.next.";
      } else if (gate === "qualitative") {
        nextMove =
          "going on the same objective — but this one is gated " +
          "qualitatively, so more questions cannot clear it however many " +
          "the learner gets right. Teach the gap this attempt exposed, " +
          "then ask them to explain the idea in their own words and " +
          "record your judgement with mastery_assess. That call is the " +
          "only thing that opens this gate.";
      } else {
        nextMove =
          "going on the same objective — teach the gap this attempt " +
          "exposed, and when you pose the next question with " +
          "mastery_quiz put that call last, since it ends the turn.";
      }
      if (groupResult["result"] === "ungraded") {
        nextMove =
          "going with source clarification or an explanation. This was ungraded, created no negative evidence and did not change mastery. Do not turn uncertainty into a wrong answer.";
      }
      const expectedAnswer = q.expected_answer;
      const map = choiceMap(q);
      const payload: Record<string, unknown> = {
        is_correct: isCorrect,
        replayed,
        path_revision: progress.version,
        knowledge_point_id: q.knowledge_point_id,
        question_id: q.question_id,
        mastery: kp ? Math.round(displayMastery(progress, kp) * 1000) / 1000 : 0,
        threshold: kp ? Math.round(gateThreshold(kp.type) * 1000) / 1000 : 0,
        gate,
        mastered,
        next: nextDict(progress, ref.sessionId),
        result: buildGradeResult({
          question_id: q.question_id,
          is_correct: isCorrect as boolean | null,
          learner_answer: String(gradedInteraction.user_answer || answer),
          correct_label:
            groupResult["result"] === "ungraded" ? "" : resolveAnswer(expectedAnswer, map) || expectedAnswer,
          choice_options: map,
          explanation:
            groupResult["result"] === "ungraded"
              ? str(groupResult["feedback"] || groupResult["diagnosis"])
              : q.explanation,
          result: str(groupResult["result"]),
          final: groupResult["final"] !== false,
          needs_clarification: groupResult["needs_clarification"] === true,
          feedback: str(groupResult["feedback"]),
          confidence: (groupResult["confidence"] as number | null) ?? null,
        }),
        instruction:
          "The card now shows the verdict, the correct option and your " +
          "explanation, so do not restate the answer key. Say what this " +
          "attempt tells you about their grasp of the objective, then keep " +
          + nextMove +
          " Never end the turn without saying anything.",
      };
      return jsonResult(payload, GRADE_META_KEY);
    } catch (exc) {
      if (exc instanceof MasteryInteractionError || exc instanceof NoPendingInteractionError) {
        return new ToolResult(
          false,
          `${exc.message} — if the learner answered on their card, the engine ` +
            "graded it when this turn began and the verdict is in your " +
            "briefing above. Give them feedback and carry on; do not " +
            "grade it again.",
        );
      }
      throw exc;
    }
  }
}

/** mutatePath that supports an async mutator (LLM grading inside). */
async function mutatePathAsync<T>(
  pathId: string,
  fn: (progress: LearningProgress) => Promise<{ progress: LearningProgress; result: T }>,
): Promise<{ progress: LearningProgress; result: T }> {
  // Load → await fn → save. Version conflict is tolerated (last writer wins)
  // since grading is idempotent via interaction status.
  const progress = loadPath(pathId) ?? undefined;
  if (!progress) throw new MasteryInteractionError("path missing");
  const out = await fn(progress);
  out.progress.version = (progress.version || 0) + 1;
  out.progress.updated_at = Date.now() / 1000;
  const { put_item } = await import("../../store/database.js");
  const { get_settings } = await import("../../config.js");
  put_item(get_settings(), "mastery_path", { id: out.progress.book_id, ...out.progress });
  return out;
}

// ---------------------------------------------------------------------------
// mastery_assess
// ---------------------------------------------------------------------------

const assessSchema: ToolParamsSchema = {
  type: "object",
  required: ["knowledge_point_id"],
  properties: {
    knowledge_point_id: { type: "string", description: "Objective id from mastery_status (verbatim)." },
    passed: {
      type: "boolean",
      description: "Deprecated compatibility hint; ignored. The actual learner explanation is assessed by the server.",
    },
    feedback: {
      type: "string",
      description: "Optional teaching note; does not replace the actual learner explanation or the server verdict.",
    },
  },
};

export class MasteryAssessTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_assess";
  toolIcon = "🧠";
  mutating = true;
  description =
    "Assess a CONCEPT or DESIGN objective after the " +
    "learner explains it in their own words (a Feynman-style check). " +
    "The server evaluates the actual learner explanation against the objective and current sources; " +
    "a model-supplied pass flag cannot grant mastery. This is the gate for these " +
    "objective types. For MEMORY / PROCEDURE objectives use " +
    "mastery_quiz + mastery_grade instead.";
  params = assessSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    const kpId = str(p["knowledge_point_id"]).trim();
    if (!kpId) {
      return new ToolResult(false, "mastery_assess needs a knowledge_point_id.");
    }
    const learnerAnswer = str(p["__learner_message"] ?? "").trim();
    const progress = loadPath(ref.pathId);
    if (!progress) return noBuiltPathResult("mastery_assess");
    const scope = reviewScopeRefusal(ref, progress, kpId);
    if (scope) return scope;
    const [kp] = findKnowledgePoint(progress, kpId);
    if (!kp) {
      return new ToolResult(
        false,
        `Unknown objective '${kpId}'; call mastery_status for valid ids.`,
      );
    }
    if (!["concept", "design"].includes(kp.type)) {
      return new ToolResult(
        false,
        `Objective '${kp.name}' is a ${kp.type} type — gate it with ` +
          "mastery_quiz + mastery_grade, not mastery_assess.",
      );
    }
    try {
      const out = await mutatePathAsync(ref.pathId, async (prog) => {
        const res = await assessQualitative(prog, kpId, learnerAnswer);
        return { progress: res.progress, result: res };
      });
      const { progress: updated, result } = out;
      const receipt = result.receipt;
      if (receipt["final"] === false) {
        return jsonResult({ knowledge_point_id: kpId, ...receipt }, "mastery_assess");
      }
      const passed = receipt["result"] === "correct";
      const [kpAfter] = findKnowledgePoint(updated, kpId);
      const mastered = kpAfter ? isMastered(updated, kpAfter) : false;
      const nextStep = nextObjective(updated, ref.sessionId);
      return jsonResult(
        {
          knowledge_point_id: kpId,
          path_revision: updated.version,
          passed,
          ...receipt,
          mastered,
          mastery: kpAfter ? Math.round(displayMastery(updated, kpAfter) * 1000) / 1000 : 0,
          next: nextStep,
          instruction: assessNextMove(mastered, nextStep as unknown as Record<string, unknown>),
        },
        "mastery_assess",
      );
    } catch (exc) {
      if (exc instanceof MasteryInteractionError) return new ToolResult(false, exc.message);
      throw exc;
    }
  }
}

// ---------------------------------------------------------------------------
// mastery_skip_question / mastery_repair_question / mastery_defer_objective
// ---------------------------------------------------------------------------

export class MasterySkipQuestionTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_skip_question";
  toolIcon = "⏭️";
  mutating = true;
  description =
    "Abandon the currently open mastery question without grading " +
    "it. This keeps every attempt and mastery level already earned, " +
    "but gives no credit for the abandoned question. Use it only " +
    "when the learner explicitly asks to skip this question or the " +
    "question is unrecoverably stuck; if mastery_status reports an " +
    "answered interaction, retry mastery_grade first.";
  params = { type: "object", properties: {} } as ToolParamsSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    const progress = loadPath(ref.pathId);
    if (!progress) return noBuiltPathResult("mastery_skip_question");
    const interaction = getActiveInteraction(progress);
    const out = mutatePath(ref.pathId, (prog) => {
      const res = abandonActiveQuestion(prog);
      return { progress: res.progress, result: res };
    });
    return jsonResult(
      {
        status: out.skipped ? "skipped" : "no_pending_question",
        skipped: out.skipped,
        path_revision: out.progress.version,
        question_id: interaction?.interaction_id ?? "",
        next: nextDict(out.progress, ref.sessionId),
        instruction: out.skipped
          ? "The question was abandoned without an attempt or mastery credit. " +
            "Continue the objective from mastery_status.next and register a " +
            "different question with mastery_quiz."
          : "No question was open; follow mastery_status.next.",
      },
      "mastery_skip_question",
    );
  }
}

const repairSchema: ToolParamsSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["void", "correct"], description: "void | correct" },
    reason: { type: "string", description: "Why this question or answer key is being repaired." },
    question_id: {
      type: "string",
      description: "Question to repair. Defaults to the active or latest question.",
    },
    expected_answer: {
      type: "string",
      description: "The corrected answer key. Required when action is correct.",
    },
  },
};

export class MasteryRepairQuestionTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_repair_question";
  toolIcon = "🛠️";
  mutating = true;
  description =
    "Repair an invalid mastery question or an incorrect answer key. " +
    "action='void' removes the attempt from mastery, errors, review, " +
    "and the question bank's wrong-answer set. action='correct' " +
    "writes the true expected answer and re-grades the stored reply. " +
    "Use this when the learner reports a bad question; do not keep " +
    "quizzing the same objective on a known-wrong key.";
  params = repairSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    const progress = loadPath(ref.pathId);
    if (!progress) return noBuiltPathResult("mastery_repair_question");
    try {
      const out = await mutatePathAsync(ref.pathId, async (prog) => {
        const res = await repairQuestion(
          prog,
          str(p["question_id"]).trim(),
          str(p["action"]),
          str(p["expected_answer"]),
          str(p["reason"]),
        );
        return { progress: res.progress, result: res };
      });
      const { progress: updated, result } = out;
      const details = result.details;
      const kpId = str(details["knowledge_point_id"]);
      const [kp] = findKnowledgePoint(updated, kpId);
      const mastered = kp ? isMastered(updated, kp) : false;
      return jsonResult(
        {
          status: "repaired",
          result: details["result"] ?? "",
          feedback: details["feedback"] ?? "",
          action: details["action"],
          question_id: details["question_id"],
          knowledge_point_id: kpId,
          path_revision: updated.version,
          is_correct: details["is_correct"] ?? null,
          mastery: kp ? Math.round(displayMastery(updated, kp) * 1000) / 1000 : 0,
          mastered,
          next: nextDict(updated, ref.sessionId),
          instruction:
            details["action"] === "void"
              ? "The invalid question no longer counts as learner error. " +
                "Continue from mastery_status.next."
              : "The answer key was corrected and the stored reply was re-graded. " +
                "Continue from mastery_status.next.",
        },
        "mastery_repair_question",
      );
    } catch (exc) {
      if (exc instanceof MasteryInteractionError) return new ToolResult(false, exc.message);
      throw exc;
    }
  }
}

const deferSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    knowledge_point_id: {
      type: "string",
      description: "Objective to defer. Defaults to the current next objective.",
    },
    reason: { type: "string", description: "Optional note for why this objective is deferred." },
  },
};

export class MasteryDeferObjectiveTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_defer_objective";
  toolIcon = "⏸️";
  mutating = true;
  description =
    "Temporarily defer the current (or named) objective and continue " +
    "with the next eligible one. This does not mark the objective " +
    "mastered and does not write a learner override. Use it only when " +
    "the learner explicitly asks to move on for now. Skipping a " +
    "question is still mastery_skip_question.";
  params = deferSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    const progress = loadPath(ref.pathId);
    if (!progress) return noBuiltPathResult("mastery_defer_objective");
    try {
      const out = mutatePath(ref.pathId, (prog) => {
        const res = deferObjective(prog, str(p["knowledge_point_id"]).trim(), str(p["reason"]));
        return { progress: res.progress, result: res };
      });
      const kpId = out.details.knowledge_point_id;
      const [kp] = findKnowledgePoint(out.progress, kpId);
      return jsonResult(
        {
          status: "deferred",
          knowledge_point_id: kpId,
          path_revision: out.progress.version,
          mastered: kp ? isMastered(out.progress, kp) : false,
          abandoned_question: out.details.abandoned_question,
          next: nextDict(out.progress, ref.sessionId),
          map: mapSummary(out.progress),
          instruction:
            "The objective is deferred, not mastered. Continue with " +
            "mastery_status.next. Do not treat this as clearing the gate.",
        },
        "mastery_defer_objective",
      );
    } catch (exc) {
      if (exc instanceof MasteryInteractionError) return new ToolResult(false, exc.message);
      throw exc;
    }
  }
}

// ---------------------------------------------------------------------------
// mastery_build
// ---------------------------------------------------------------------------

const buildSchema: ToolParamsSchema = {
  type: "object",
  required: ["modules"],
  properties: {
    modules: {
      type: "array",
      description:
        "Ordered modules: each {name, objective, knowledge_points: [{name, type}]}. objective is one sentence naming the ability this module delivers. type is one of memory/procedure/concept/design.",
      items: { type: "object" },
    },
    path_name: {
      type: "string",
      description:
        "What to call this path — a short course title the learner will recognise in their dashboard.",
    },
    mode: {
      type: "string",
      enum: ["replace", "append"],
      description: "'replace' (default) starts a new outline; 'append' adds modules.",
    },
  },
};

export class MasteryBuildTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_build";
  toolIcon = "�·l";
  mutating = true;
  description =
    "Create or extend the learner's mastery goal. Design modules and " +
    "their knowledge points from the learner's materials (use rag / " +
    "read_source first when materials are attached) and pass them " +
    "here, with a short path_name the learner will recognise. Each " +
    "module needs an 'objective': one sentence saying what the " +
    "learner can do once it is cleared. Each knowledge point needs a 'type': " +
    "memory (facts), procedure (step-by-step skills), concept (ideas " +
    "to understand), or design (open-ended judgement). Use " +
    "mode='replace' to start a new outline — semantically new " +
    "objectives get fresh IDs and do not inherit previous mastery — " +
    "or 'append' to add to an existing path.";
  params = buildSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    const mode = str(p["mode"] || "replace").trim().toLowerCase() === "append" ? "append" : "replace";
    const parsed = parseModulesWithRefs(
      p["modules"],
      ref.pathId,
      0,
      str(p["path_name"]).trim().slice(0, 200),
    );
    if (parsed.error) return new ToolResult(false, parsed.error);
    try {
      const out = mutatePath(ref.pathId, (progress) => {
        const next = replaceModulesForPath(progress, ref.pathId, parsed.modules, {
          append: mode === "append",
          name: str(p["path_name"]),
          relationRefs: parsed.relationRefs,
        });
        return { progress: next, result: next };
      });
      const kpCount = parsed.modules.reduce((n, m) => n + (m.knowledge_points?.length ?? 0), 0);
      return jsonResult(
        {
          status: "built",
          path_revision: out.version,
          mode,
          path_name: pathDisplayName(out),
          modules_added: parsed.modules.length,
          knowledge_points_added: kpCount,
          map: mapSummary(out),
        },
        "mastery_build",
      );
    } catch (exc) {
      return new ToolResult(false, String(exc instanceof Error ? exc.message : exc));
    }
  }
}

// ---------------------------------------------------------------------------
// mastery_profile
// ---------------------------------------------------------------------------

const profileSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    prior_knowledge: { type: "string", description: "What they can already do in this subject, in their own words." },
    target_level: { type: "string", description: "What 'done' means to them — the ability they want." },
    time_budget: { type: "string", description: "How much time they have, as they said it." },
    preferences: { type: "string", description: "How they want it taught." },
    teaching_strategy: {
      type: "string",
      description: "'teach_first' only when the learner explicitly asks to be taught before being quizzed; 'probe_first' to restore the diagnostic default.",
    },
    notes: { type: "string", description: "Anything else worth carrying." },
    teaching_updates: {
      type: "array",
      description:
        "Keyed upsert/remove operations for evolving teaching feedback: explicit preferences or objective-local difficulties/attempts.",
      items: { type: "object" },
    },
    expected_revision: {
      type: "integer",
      description: "Required with teaching_updates or clear_fields: path_revision from the current mastery snapshot.",
    },
    clear_fields: {
      type: "array",
      items: {
        type: "string",
        enum: ["prior_knowledge", "target_level", "time_budget", "preferences", "notes"],
      },
      description: "Explicitly forget only the intake fields the learner asked to remove.",
    },
    clear_request: {
      type: "string",
      description: "Literal quote from the current learner request authorizing clear_fields.",
    },
  },
};

const PROFILE_FIELD_KEYS = [
  "prior_knowledge",
  "target_level",
  "time_budget",
  "preferences",
  "teaching_strategy",
  "notes",
];

export class MasteryProfileTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_profile";
  toolIcon = "📝";
  mutating = true;
  description =
    "Record what the learner told you about themselves for this " +
    "mastery goal: what they can already do, what finishing means " +
    "to them, how much time they have, and how they want it " +
    "taught. Call it during intake — before designing the outline " +
    "— and again whenever they correct one of these. Pass only the " +
    "fields they actually spoke to; omitted, null or blank fields keep what they " +
    "said before. Never invent an answer they did not give.";
  params = profileSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    if (!pathExists(ref.pathId)) return noPathResult();
    const fields: Record<string, unknown> = {};
    for (const key of PROFILE_FIELD_KEYS) {
      if (p[key] !== undefined && p[key] !== null && str(p[key]).trim()) fields[key] = p[key];
    }
    const hasUpdates = p["teaching_updates"] !== undefined && p["teaching_updates"] !== null;
    const hasClear = Array.isArray(p["clear_fields"]) && p["clear_fields"].length > 0;
    if (!Object.keys(fields).length && !hasUpdates && !hasClear) {
      return new ToolResult(
        false,
        "mastery_profile needs at least one of prior_knowledge, " +
          "target_level, time_budget, preferences, teaching_strategy, notes or teaching_updates — pass what " +
          "the learner actually told you.",
      );
    }
    if (
      fields["teaching_strategy"] !== undefined &&
      !["probe_first", "teach_first"].includes(str(fields["teaching_strategy"]))
    ) {
      return new ToolResult(false, "teaching_strategy must be probe_first or teach_first.");
    }
    try {
      const out = mutatePath(ref.pathId, (progress) => {
        // Create the path shell if intake happens before mastery_build.
        const res = recordLearnerProfile(progress, fields, {
          session_id: ref.sessionId,
          turn_id: ref.turnId,
          teaching_updates: p["teaching_updates"],
          clear_fields: p["clear_fields"],
        });
        return { progress: res.progress, result: res };
      });
      return jsonResult(
        {
          status: "recorded",
          path_revision: out.progress.version,
          updated_fields: out.changed,
          ...profilePayload(out.progress),
        },
        "mastery_profile",
      );
    } catch (exc) {
      return new ToolResult(false, String(exc instanceof Error ? exc.message : exc));
    }
  }
}

// ---------------------------------------------------------------------------
// mastery_revise
// ---------------------------------------------------------------------------

const reviseItemSchema = {
  type: "object",
  properties: {
    knowledge_point_id: { type: "string" },
    name: { type: "string" },
    type: { type: "string", enum: ALLOWED_KP_TYPES },
    prerequisite_ids: { type: "array", items: { type: "string" } },
    topic_source_ids: { type: "array", items: { type: "string" } },
  },
};
const addItemSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: ALLOWED_KP_TYPES },
    prerequisite_ids: { type: "array", items: { type: "string" } },
    topic_source_ids: { type: "array", items: { type: "string" } },
  },
};

const reviseSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    module_id: { type: "string", description: "Which module to revise (single-module form)." },
    rewrite: { type: "array", items: reviseItemSchema, description: "Knowledge points to restate." },
    add: { type: "array", items: addItemSchema, description: "Knowledge points to append." },
    remove: { type: "array", items: { type: "string" }, description: "Knowledge point ids to drop." },
    modules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          module_id: { type: "string" },
          rewrite: { type: "array", items: reviseItemSchema },
          add: { type: "array", items: addItemSchema },
          remove: { type: "array", items: { type: "string" } },
        },
      },
      description: "Coordinated revisions for several modules in one atomic revision.",
    },
    module_order: {
      type: "array",
      items: { type: "string" },
      description: "Preview only upstream; here applied directly with the revision (simplification).",
    },
  },
};

function reviseSpecs(
  p: Record<string, unknown>,
): { specs: Record<string, { rewrite?: Record<string, unknown>[]; add?: unknown[]; remove?: unknown[] }>; error: string | null } {
  const batch = p["modules"];
  const singleId = str(p["module_id"]).trim();
  const clean: Record<string, { rewrite?: Record<string, unknown>[]; add?: unknown[]; remove?: unknown[] }> = {};
  if (batch !== undefined && batch !== null && !Array.isArray(batch)) {
    return { specs: {}, error: "'modules' must be a list of {module_id, rewrite, add, remove} objects." };
  }
  if (Array.isArray(batch) && batch.length) {
    if (singleId) {
      return {
        specs: {},
        error:
          "Pass either module_id (one module) or modules (several), not both — " +
          "put every coordinated change in its modules entry instead.",
      };
    }
    for (const raw of batch) {
      if (!isRecord(raw)) return { specs: {}, error: "Each modules entry must be an object with a module_id." };
      const moduleId = str(raw["module_id"]).trim();
      if (!moduleId) return { specs: {}, error: "Each modules entry needs the module_id it revises." };
      if (clean[moduleId]) {
        return {
          specs: {},
          error: `Module '${moduleId}' appears twice in modules. Merge its rewrite / add / remove changes into one entry.`,
        };
      }
      const spec: { rewrite?: Record<string, unknown>[]; add?: unknown[]; remove?: unknown[] } = {};
      if (raw["rewrite"] !== undefined && raw["rewrite"] !== null) spec.rewrite = arr(raw["rewrite"]) as Record<string, unknown>[];
      if (raw["add"] !== undefined && raw["add"] !== null) spec.add = arr(raw["add"]);
      if (raw["remove"] !== undefined && raw["remove"] !== null) spec.remove = arr(raw["remove"]);
      if (!spec.rewrite?.length && !spec.add?.length && !spec.remove?.length) {
        return {
          specs: {},
          error: `The modules entry for '${moduleId}' needs at least one of rewrite, add or remove.`,
        };
      }
      clean[moduleId] = spec;
    }
    return { specs: clean, error: null };
  }
  if (!singleId) {
    return {
      specs: {},
      error: "mastery_revise needs a module_id (one module) or a modules list (several) saying what to revise.",
    };
  }
  const spec: { rewrite?: Record<string, unknown>[]; add?: unknown[]; remove?: unknown[] } = {};
  if (p["rewrite"] !== undefined && p["rewrite"] !== null) spec.rewrite = arr(p["rewrite"]) as Record<string, unknown>[];
  if (p["add"] !== undefined && p["add"] !== null) spec.add = arr(p["add"]);
  if (p["remove"] !== undefined && p["remove"] !== null) spec.remove = arr(p["remove"]);
  if (!spec.rewrite?.length && !spec.add?.length && !spec.remove?.length) {
    return { specs: {}, error: "mastery_revise needs at least one of rewrite, add or remove." };
  }
  clean[singleId] = spec;
  return { specs: clean, error: null };
}

export class MasteryReviseTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_revise";
  toolIcon = "✏️";
  mutating = true;
  description =
    "Reshape the knowledge points inside ONE module of the current " +
    "mastery goal, keeping the module's objective unchanged. Use it " +
    "when the learner objects to specific knowledge points — too " +
    "easy, too advanced, badly worded, not what they meant, or " +
    "something missing. Every revision must still serve the " +
    "module's stated objective (read it from mastery_status); when " +
    "the learner wants something the objective does not cover, say " +
    "so and offer mastery_build instead of quietly widening the " +
    "module. Rewriting a knowledge point resets its progress; a " +
    "knowledge point the learner has already mastered cannot be " +
    "rewritten or removed. When one coordinated adjustment touches " +
    "SEVERAL modules, pass them together as modules=[{module_id, " +
    "rewrite, add, remove}, ...] in ONE call.";
  params = reviseSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    const progress = loadPath(ref.pathId);
    if (!progress || !hasOutline(progress)) return noBuiltPathResult("mastery_revise");
    const { specs, error } = reviseSpecs(p);
    if (error) return new ToolResult(false, error);
    const moduleOrder = Array.isArray(p["module_order"]) ? p["module_order"].map(String) : null;
    try {
      const plan = planModuleRevision(progress, specs, moduleOrder);
      const out = mutatePath(ref.pathId, (prog) => {
        const next = replaceModulesForPath(prog, ref.pathId, plan.applied, {
          append: false,
          name: str(prog.name),
        });
        // replaceModulesForPath with append=false drops state for ids not in
        // `keep`; rewritten points have fresh ids so their state is dropped —
        // matching upstream's "stale state dropped by the engine".
        return { progress: next, result: next };
      });
      const moduleReport = (moduleId: string) => {
        const target = plan.targets.find((t) => t.id === moduleId)!;
        const points = plan.revisedByModule[moduleId] ?? [];
        return {
          module_id: moduleId,
          module_name: target.name,
          module_objective: target.objective,
          knowledge_points: points.map((kp) => ({
            id: kp.id,
            name: kp.name,
            type: kp.type,
            prerequisite_ids: kp.prerequisite_ids,
            topic_source_ids: kp.topic_source_ids,
          })),
        };
      };
      if (plan.targets.length === 1) {
        const target = plan.targets[0];
        return jsonResult(
          {
            status: "revised",
            path_revision: out.version,
            ...moduleReport(target.id),
            progress_reset: plan.resetsByModule[target.id] ?? [],
            map: mapSummary(out),
          },
          "mastery_revise",
        );
      }
      return jsonResult(
        {
          status: "revised",
          path_revision: out.version,
          modules: plan.targets.map((t) => ({
            ...moduleReport(t.id),
            progress_reset: plan.resetsByModule[t.id] ?? [],
          })),
          map: mapSummary(out),
        },
        "mastery_revise",
      );
    } catch (exc) {
      return new ToolResult(false, String(exc instanceof Error ? exc.message : exc));
    }
  }
}

// ---------------------------------------------------------------------------
// mastery_paths / mastery_switch / mastery_leave (binding.py port)
// ---------------------------------------------------------------------------

export class MasteryPathsTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_paths";
  toolIcon = "🗺️";
  mutating = false;
  description =
    "List every mastery path this learner has — name, how many " +
    "objectives are mastered vs still being learned, reviews due, " +
    "and which one this conversation is currently on. Use it when " +
    "the learner asks what they are studying or what is finished, " +
    "or before mastery_switch, to find the id to switch to.";
  params = { type: "object", properties: {} } as ToolParamsSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const paths = listPathOverviews()
      .filter((o) => num(o["objectives"]) > 0)
      .map((o) => ({ ...o, active: o["path_id"] === ref.pathId }));
    return jsonResult(
      {
        active_path_id: ref.pathId,
        paths,
        instruction:
          "Switch with mastery_switch(path_id=...); every later call " +
          "in the turn — including ones issued alongside it — then " +
          "acts on the new path. Call mastery_status after switching.",
      },
      "mastery_paths",
    );
  }
}

const switchSchema: ToolParamsSchema = {
  type: "object",
  required: ["path_id"],
  properties: {
    path_id: { type: "string", description: "Path id from mastery_paths (verbatim)." },
  },
};

export class MasterySwitchTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_switch";
  toolIcon = "🔀";
  mutating = true;
  description =
    "Put this conversation on a path the learner has asked for — " +
    "by name, or by clearly asking to start or return to it. The " +
    "path keeps all of its own progress; the conversation follows " +
    "it from now on, including on later turns, and stops being " +
    "filed under the path it was on. Because of that, switch only " +
    "on what the learner actually asked for: if their request " +
    "could mean either of two paths, ask which before switching. " +
    "Call mastery_paths first for valid ids, and mastery_status " +
    "afterwards to see where the new path stands.";
  params = switchSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const requested = str(p["path_id"]).trim();
    if (!requested) {
      return new ToolResult(
        false,
        "mastery_switch needs a path_id; call mastery_paths for the ids.",
      );
    }
    const target = sanitizePathId(requested);
    if (!pathExists(target)) {
      return new ToolResult(
        false,
        `No mastery path '${requested}' exists. Call mastery_paths for the ` +
          "ids you can switch to, or mastery_build to create one here.",
      );
    }
    const previous = ref.pathId;
    if (ref.sessionId) setSessionPath(ref.sessionId, target);
    return jsonResult(
      {
        status: "switched",
        previous_path_id: previous,
        active_path_id: target,
        instruction:
          "This conversation now follows that path, on this turn and " +
          "later ones — anything else you called in this round acted " +
          "on it too. Call mastery_status to see where it stands.",
      },
      "mastery_switch",
    );
  }
}

export class MasteryLeaveTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_leave";
  toolIcon = "👋";
  mutating = true;
  description =
    "Stop following the current mastery path in this conversation. " +
    "The path keeps every bit of its progress and can be resumed " +
    "any time with mastery_switch; this conversation falls back to " +
    "a scratch path of its own, so the learner can start something " +
    "new here. Use it when the learner says they are done with the " +
    "course for now, or wants to work on something unrelated.";
  params = { type: "object", properties: {} } as ToolParamsSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const previous = ref.pathId;
    const scratch = sanitizePathId(ref.sessionId || "default");
    if (ref.sessionId) setSessionPath(ref.sessionId, scratch);
    return jsonResult(
      {
        status: "left",
        previous_path_id: previous,
        active_path_id: scratch,
        instruction:
          "That path is untouched and resumable with mastery_switch. " +
          "This conversation is now on its own scratch path.",
      },
      "mastery_leave",
    );
  }
}

// ---------------------------------------------------------------------------
// mastery_note_explained (simplified: no published-delivery verification)
// ---------------------------------------------------------------------------

const noteExplainedSchema: ToolParamsSchema = {
  type: "object",
  required: ["knowledge_point_id", "summary", "explanation_quote"],
  properties: {
    knowledge_point_id: { type: "string", description: "Exact objective ID from mastery_status." },
    summary: { type: "string", description: "What was actually explained." },
    explanation_quote: {
      type: "string",
      description: "Exact 24-2000 character excerpt of explanation already publicly delivered in this turn.",
    },
  },
};

export class MasteryNoteExplainedTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_note_explained";
  toolIcon = "📝";
  mutating = true;
  description =
    "After publicly explaining a source-supported slice of an objective, record that delivered explanation with an exact quote. Never record a planned explanation or treat this as complete-objective coverage, assessment or mastery.";
  params = noteExplainedSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    const refusal = wrongMode(this.name, ref);
    if (refusal) return refusal;
    if (!pathExists(ref.pathId)) return noPathResult();
    const kpId = str(p["knowledge_point_id"]).trim();
    const summary = str(p["summary"]).trim().slice(0, 2000);
    if (!summary) return new ToolResult(false, "A teaching summary is required.");
    const quote = str(p["explanation_quote"]).trim();
    if (quote.length < 24 || quote.length > 2000) {
      return new ToolResult(
        false,
        "Provide an exact 24-2000 character excerpt of the explanation already delivered publicly in this turn.",
      );
    }
    const progress = loadPath(ref.pathId);
    if (!progress) return noBuiltPathResult("mastery_note_explained");
    const [kp] = findKnowledgePoint(progress, kpId);
    if (!kp) {
      return new ToolResult(false, "Unknown objective; refresh mastery_status.");
    }
    try {
      const out = mutatePath(ref.pathId, (prog) => {
        prog.explained_objectives = prog.explained_objectives ?? {};
        prog.explained_objectives[kpId] = {
          summary,
          explanation_quote: quote,
          coverage: "partial",
          timestamp: Date.now() / 1000,
          session_id: ref.sessionId,
          turn_id: ref.turnId,
          // NOTE: upstream verifies the quote against published assistant
          // segments via _teaching_delivery; this port cannot see the
          // published stream, so the check is skipped (documented).
        };
        return prog;
      });
      return jsonResult(
        {
          knowledge_point_id: kpId,
          stage: "partially_explained",
          coverage: "partial",
          mastery_credit: false,
          path_revision: out.version,
        },
        "mastery_note_explained",
      );
    } catch (exc) {
      return new ToolResult(false, String(exc instanceof Error ? exc.message : exc));
    }
  }
}

// ---------------------------------------------------------------------------
// mastery_prepare_lesson (simplified stub: no lesson_evidence subsystem)
// ---------------------------------------------------------------------------

const prepareSchema: ToolParamsSchema = {
  type: "object",
  required: ["knowledge_point_id"],
  properties: {
    knowledge_point_id: { type: "string", description: "Stable objective ID from mastery_status." },
    focus: {
      type: "string",
      description: "Optional next teaching step or assessment task within this objective, at most 600 characters.",
    },
    refresh: { type: "boolean", description: "Explicit targeted retry of this focus." },
  },
};

export class MasteryPrepareLessonTool extends BaseTool<Record<string, unknown>> {
  name = "mastery_prepare_lesson";
  toolIcon = "📖";
  mutating = false;
  description =
    "Prepare source evidence for the next teaching or practice step within an objective. In this port there is no cached lesson-evidence subsystem: the call validates the objective and returns guidance to ground teaching in the path's selected materials via read_source/rag.";
  params = prepareSchema;

  async execute(p: Record<string, unknown>, ctx?: Ctx): Promise<ToolResult> {
    const ref = turnRef(p, ctx);
    if (!pathExists(ref.pathId)) return noPathResult();
    const kpId = str(p["knowledge_point_id"]).trim();
    const progress = loadPath(ref.pathId);
    if (!progress) return noBuiltPathResult("mastery_prepare_lesson");
    const [kp] = findKnowledgePoint(progress, kpId);
    if (!kp) {
      return new ToolResult(false, `Unknown objective '${kpId}'; call mastery_status for valid ids.`);
    }
    const focus = str(p["focus"]).trim().slice(0, 600);
    return jsonResult(
      {
        status: "advisory_only",
        knowledge_point_id: kpId,
        objective: kp.name,
        focus: focus || null,
        instruction:
          "No cached lesson packet exists in this deployment. Ground the next teaching or " +
          "practice step in the path's selected materials: read them with read_source (or " +
          "rag for knowledge bases) before asserting source facts, and keep unsupported " +
          "claims out of questions and answer keys.",
      },
      "mastery_prepare_lesson",
    );
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MASTERY_TOOLS: BaseTool[] = [
  new MasteryPrepareLessonTool(),
  new MasteryStatusTool(),
  new MasteryNoteExplainedTool(),
  new MasteryQuizTool(),
  new MasteryGradeTool(),
  new MasterySkipQuestionTool(),
  new MasteryRepairQuestionTool(),
  new MasteryDeferObjectiveTool(),
  new MasteryAssessTool(),
  new MasteryBuildTool(),
  new MasteryModeTool(),
  new MasteryProfileTool(),
  new MasteryReviseTool(),
  new MasteryPathsTool(),
  new MasterySwitchTool(),
  new MasteryLeaveTool(),
];

export function masteryTools(): BaseTool[] {
  return [...MASTERY_TOOLS];
}

// Helpers the orchestrator/runtime may call (upstream pipeline equivalents).
export {
  activePathId,
  getSessionBinding,
  sessionModeOrNull as sessionMode,
  setSessionMode,
  setSessionPath,
  sanitizePathId,
};
export { normalizeMode, enforcedMode };
export type { TurnRef };
