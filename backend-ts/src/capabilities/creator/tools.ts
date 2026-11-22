// propose_creation: publish
// a reviewable Skill/Persona draft from the chat loop. Never writes the
// Skill/Persona itself — only the user's Approve does that.

import { BaseTool, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import {
  CreationDraftStore,
  draft_to_dict,
  get_creation_kind,
} from "./drafts.js";
import type { Dict } from "../../shared/types.js";

export const CREATOR_TOOL_NAMES = ["propose", "propose_creation"] as const;

export const proposeCreationParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "content"],
  properties: {
    name: {
      type: "string",
      description: "Lowercase slug (letters, digits, hyphens).",
    },
    description: {
      type: "string",
      description: "One-line summary: what it does and when to use it.",
    },
    content: {
      type: "string",
      description: "Complete Markdown body. Do not include frontmatter.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Up to 6 short tags. Skills only; ignored for personas.",
    },
    references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            description: "Relative path starting with references/.",
          },
          content: { type: "string" },
        },
        required: ["path", "content"] as unknown as boolean,
      },
      description:
        "Up to 12 supporting files under references/. Skills only; ignored " +
        "for personas.",
    },
  },
} as ToolParamsSchema;

/** Per-turn creation context (upstream ``_creation_context`` kwarg). */
export interface CreationTurnContext {
  session_id?: string;
  metadata?: Dict | null;
  /** Where the draft id lands once proposed (upstream
   * ``context.extension("creator")["draft_id"]``). */
  set_draft_id?: (draft_id: string) => void;
}

const _CONTEXTS = new Map<string, CreationTurnContext>();

/** Publish the turn's creation context for propose_creation (augment_kwargs). */
export function set_creation_context(
  key: string,
  ctx: CreationTurnContext,
): void {
  _CONTEXTS.set(key, ctx);
}

export function clear_creation_context(key: string): void {
  _CONTEXTS.delete(key);
}

export class ProposeCreationTool extends BaseTool<Record<string, unknown>> {
  name = "propose_creation";
  toolIcon = "✨";
  params = proposeCreationParamsSchema as never;
  mutating = true;
  description =
    "Publish a complete, editable draft of the Skill or Persona being " +
    "authored in this conversation, shown to the user as a review card. " +
    "This never writes the Skill/Persona itself — only the user's Approve " +
    "does that. Call it again with the full revised package (same name) " +
    "after each round of changes the user asks for.";

  async execute(p: Record<string, unknown>): Promise<ToolResult> {
    // Upstream receives the UnifiedContext via the ``_creation_context``
    // kwarg injected by CreatorCapability.augment_kwargs.
    const injected = p["_creation_context"];
    let context: CreationTurnContext | null = null;
    if (injected !== null && typeof injected === "object" && !Array.isArray(injected)) {
      context = injected as CreationTurnContext;
    } else {
      const key = String(p["_creation_context_key"] ?? "");
      if (key) context = _CONTEXTS.get(key) ?? null;
    }
    if (context === null) {
      return fail("No active creation context for this turn.");
    }

    const metadata = context.metadata ?? {};
    const kind = get_creation_kind(metadata["create_target"]);
    if (kind === null) {
      return fail("Create mode is not active for this turn.");
    }

    let normalized: Dict;
    try {
      normalized = kind.normalize(p);
    } catch (exc) {
      return fail(exc instanceof Error ? exc.message : String(exc));
    }

    const store = new CreationDraftStore();
    const sessionId = String(context.session_id ?? "");
    const name = String(normalized["name"]);
    if (
      kind.name_in_use(name) &&
      !store.created_by_session(sessionId, kind.key, name)
    ) {
      return fail(
        `A ${kind.label.toLowerCase()} named \`${name}\` already exists. ` +
          "Choose a different name, or reuse the name of a draft this " +
          "conversation already created to update it.",
      );
    }

    const draft = store.create({
      kind: kind.key,
      session_id: sessionId,
      name,
      description: String(normalized["description"]),
      content: String(normalized["content"]),
      tags: (normalized["tags"] as string[] | undefined) ?? [],
      references:
        (normalized["references"] as { path: string; content: string }[] | undefined) ?? [],
    });
    context.set_draft_id?.(draft.draft_id);
    return {
      success: true,
      result: JSON.stringify({
        status: "draft_ready",
        draft_id: draft.draft_id,
        kind: kind.key,
        name: draft.name,
        message:
          "Shown to the user as a draft card. Nothing is saved until they approve it.",
      }),
      metadata: { creation_draft: draft_to_dict(draft) },
    };
  }
}
export const propose_creation = new ProposeCreationTool();
export const CREATOR_TOOLS = [propose_creation];
