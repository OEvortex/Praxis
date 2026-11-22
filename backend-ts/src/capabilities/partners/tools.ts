// Port of capabilities/partner_authoring + capabilities/partner_group tools.
// Exposes ``propose_partner`` and ``invoke_other`` as vtx-style tool objects
// built with the shared ``tool`` decorator (agent/toolkit.ts), backed by the
// sqlite draft store and the Partner Group invocation machinery.
import { tool } from "../../agent/toolkit.js";
import type { FunctionTool } from "../../agent/toolkit.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import { PartnerDraftStore } from "../../services/partners_ext/manager.js";
import { getPartnerGroupManager } from "../../services/partners_ext/groups.js";
import { currentUser } from "../../services/partners_ext/multiuser.js";

export const PARTNER_AUTHORING_TOOL_NAMES = ["propose_partner"] as const;
export const PARTNER_GROUP_TOOL_NAMES = ["invoke_other"] as const;

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

// ── partner_authoring: propose_partner ─────────────────────────
// Creates a reviewable draft only; promotion happens via
// POST /api/partners/drafts/{id}/confirm.
export const propose_partner: FunctionTool = tool({
  mutating: true,
  tool_icon: "🤝",
})(async function propose_partner(params: Record<string, unknown>) {
  const user = currentUser();
  try {
    const draft = new PartnerDraftStore().create(
      {
        name: params["name"],
        description: params["description"],
        soul: params["soul"],
        language: params["language"],
        emoji: params["emoji"],
        color: params["color"],
      },
      user.id,
    );
    const payload = { ...draft } as Record<string, unknown>;
    delete payload["id"];
    return JSON.stringify({
      success: true,
      result: JSON.stringify({
        status: "draft_ready",
        draft_id: draft.draft_id,
        message: "The profile is ready for the user to review and confirm.",
      }),
      partner_draft: payload,
    });
  } catch (e) {
    return JSON.stringify({ success: false, result: String(e instanceof Error ? e.message : e) });
  }
}) as FunctionTool;

(propose_partner as any).paramsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", description: "Short memorable display name." },
    description: { type: "string", description: "One-sentence learner-facing summary." },
    soul: {
      type: "string",
      description:
        "Complete Markdown system profile: identity, educational role, goals, teaching style, interaction rules, boundaries, and routines.",
    },
    language: { type: "string", description: "Preferred response language, normally en." },
    emoji: { type: "string", description: "One representative emoji." },
    color: {
      type: "string",
      pattern: "^#[0-9A-Fa-f]{6}$",
      description: "Accessible six-digit hex accent color.",
    },
  },
  required: ["name", "description", "soul", "language", "emoji", "color"],
};
(propose_partner as any).description =
  "Create a complete but non-binding Partner profile draft for the user to review and confirm in the UI. Infer sensible details from the request. This never creates or starts a Partner by itself.";

// ── partner_group: invoke_other ────────────────────────────────
// Records a proposal only; approval flows through the Group API.
// params._partner_group_context may carry {group, state} when invoked inside
// a group turn; without it the tool refuses (same contract as upstream).
export const invoke_other: FunctionTool = tool({
  mutating: true,
  tool_icon: "🔁",
})(async function invoke_other(params: Record<string, unknown>) {
  const ctx = (params["__partner_group_context"] ?? params["_partner_group_context"]) as
    | { group?: Record<string, unknown>; state?: Record<string, unknown> }
    | undefined;
  const group = ctx?.group;
  const state = ctx?.state ?? {};
  if (!group) {
    return JSON.stringify({ success: false, result: "invoke_other is available only inside a Partner Group." });
  }
  if (group["allow_invoke_other"] === false) {
    state["disallowed_invocation_attempted"] = true;
    state["invocation_decided"] = true;
    return JSON.stringify({
      success: false,
      terminate_turn: Boolean(state["formal_answer"]),
      result:
        "This invoked reply cannot create another Partner proposal. Complete the current user-facing answer once and end the turn; do not call invoke_other.",
    });
  }
  if (!state["formal_answer"]) {
    if (state["invocation_decided"]) {
      return JSON.stringify({
        success: false,
        terminate_turn: true,
        result:
          "The collaboration decision was already consumed. End this turn immediately; do not call invoke_other or rewrite an answer.",
      });
    }
    state["invocation_decided"] = true;
    return JSON.stringify({
      success: false,
      result:
        "This collaboration decision is consumed. Write the complete user-facing answer exactly once, then end the turn. Do not call invoke_other again.",
    });
  }
  if (state["invocation_decided"]) {
    return JSON.stringify({
      success: false,
      terminate_turn: true,
      result:
        "The collaboration decision was already consumed. End this turn immediately; do not rewrite the answer.",
    });
  }
  state["invocation_decided"] = true;
  if (state["invocation_proposal"]) {
    return JSON.stringify({
      success: false,
      terminate_turn: true,
      result: "A proposal is already recorded. End this turn immediately; do not rewrite the answer.",
    });
  }
  const targetId = str(params["target_partner_id"]).trim().replace(/^@/, "");
  const question = str(params["question"]).trim();
  const selfId = str(group["self_id"]);
  const members = new Map<string, string>();
  for (const item of (group["members"] as Record<string, unknown>[]) ?? []) {
    const pid = str(item?.["partner_id"]).trim();
    if (pid) members.set(pid, str(item?.["name"]) || pid);
  }
  const reject = (result: string) =>
    JSON.stringify({ success: false, terminate_turn: true, result });
  if (!targetId || !members.has(targetId)) {
    return reject("No proposal was recorded because the target is not eligible. End this turn immediately; do not rewrite the answer.");
  }
  if (targetId === selfId) {
    return reject("No proposal was recorded because you cannot invoke yourself. End this turn immediately; do not rewrite the answer.");
  }
  if (!question) {
    return reject("No proposal was recorded because the question is empty. End this turn immediately; do not rewrite the answer.");
  }
  if (question.length > 2000) {
    return reject("No proposal was recorded because the question is too long. End this turn immediately; do not rewrite the answer.");
  }
  const proposal = { target_partner_id: targetId, target_partner_name: members.get(targetId), question };
  state["invocation_proposal"] = proposal;
  return JSON.stringify({
    success: true,
    terminate_turn: true,
    result: JSON.stringify({
      status: "pending_user_approval",
      target_partner_id: targetId,
      message: "The proposal is recorded. End this turn immediately and do not rewrite the saved answer.",
    }),
    partner_invocation: proposal,
  });
}) as FunctionTool;

(invoke_other as any).paramsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    target_partner_id: { type: "string", description: "Exact @id of one eligible peer Partner." },
    question: {
      type: "string",
      description:
        "A standalone, specific question for the target. Do not include an answer on the target's behalf.",
    },
  },
  required: ["target_partner_id", "question"],
};
(invoke_other as any).description =
  "After your complete formal answer has been saved, propose asking exactly one other Partner one focused follow-up question. This only creates a user approval request; it never invokes the target by itself. Use selectively and at most once.";

// Capability metadata + the pure intent gate (port of binding.py).
export const PARTNER_AUTHORING_CAPABILITY_NAME = "partner_authoring";

const EN_ACTION =
  "(?:\\b(?:create|make|build|design|generate|add|set\\s+up)\\b(?:\\s+(?:me|us))?|\\b(?:want|need)\\b)";
const EN_DETERMINER = "\\s+(?:a|an|another|one|my\\s+own|our\\s+own|a\\s+new|new)\\b";
const EN_GAP = "(?:\\s+(?!(?:about|with|for|of|from|in|on|to|that|which)\\b)[\\w'-]+){0,3}?";
const EN_OBJECT =
  "\\s+(?:partners?|companions?|tutors?|mentors?|coach(?:es)?|study\\s+budd(?:y|ies))(?![\\w-])";

const AUTHORING_REQUEST = new RegExp(
  `${EN_ACTION}${EN_DETERMINER}${EN_GAP}${EN_OBJECT}`,
  "i",
);
const QUOTED_OR_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~|(?m:^>[^\n]*)|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|(?<!\w)'[^'\n]+'(?!\w)/g;
const CLAUSE_END = /[!?;,\n]/g;
const NEGATED_ACTION =
  /(?:\b(?:don't|do\s+not|never|not|can't|cannot)\s*(?:want|need)?(?:\s+(?:you\s+)?to)?\s*)$/i;
const MENTION_QUESTION = /^\s*(?:(?:explain\s+)?(?:why|how|what)\b)/i;
const NON_PARTNER_TARGET =
  /^\s+(?:issue|bug|report|checklist|style|tone|feature|setting|ticket)\b/i;

/** "explicit" | "heuristic" | null — port of partner_authoring_trigger. */
export function partnerAuthoringTrigger(input: {
  user_message?: string;
  active_capability?: string;
  metadata?: Record<string, unknown>;
}): string | null {
  if (input.metadata?.["source"] === "partner") return null;
  if (input.active_capability === PARTNER_AUTHORING_CAPABILITY_NAME) return "explicit";
  const text = String(input.user_message || "");
  const quoted = [...text.matchAll(QUOTED_OR_CODE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  for (const m of text.matchAll(new RegExp(AUTHORING_REQUEST.source, "gi"))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (quoted.some(([s, e]) => start >= s && end <= e)) continue;
    let clauseStart = 0;
    for (const b of text.slice(0, start).matchAll(CLAUSE_END)) {
      clauseStart = (b.index ?? 0) + b[0].length;
    }
    if (NEGATED_ACTION.test(text.slice(clauseStart, start))) continue;
    if (MENTION_QUESTION.test(text.slice(clauseStart, start))) continue;
    if (NON_PARTNER_TARGET.test(text.slice(end))) continue;
    return "heuristic";
  }
  return null;
}

export const partnerAuthoringTools: FunctionTool[] = [propose_partner];
export const partnerGroupTools: FunctionTool[] = [invoke_other];
export { ok, fail };
export type { ToolResult };
