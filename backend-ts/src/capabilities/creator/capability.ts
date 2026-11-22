// Create mode: teach
// the loop to author a Skill/Persona. Never replaces the ordinary chat tool
// surface — it only adds propose_creation and a kind-specific system prompt.

import { readFileSync } from "node:fs";
import {
  CreationDraftStore,
  get_creation_kind,
} from "./drafts.js";
import { CREATOR_TOOL_NAMES } from "./tools.js";
import type { Dict } from "../../shared/types.js";

export { CREATOR_TOOL_NAMES };

const _PROMPT_CACHE = new Map<string, string>();

function _load_prompt(lang: string, kindKey: string): string {
  const cacheKey = `${lang}/${kindKey}`;
  const cached = _PROMPT_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const url = new URL(`./prompts/${lang}/${kindKey}.txt`, import.meta.url);
  const text = readFileSync(url, "utf-8").trim();
  _PROMPT_CACHE.set(cacheKey, text);
  return text;
}

export interface PromptBlock {
  name: string;
  content: string;
}

export function name(): string {
  return "creator";
}

export function is_active(metadata: Dict | null | undefined): boolean {
  // A partner turn runs inside a synthetic workspace with no review UI to
  // show a draft card in, so create mode never activates there.
  if (metadata?.["source"] === "partner") return false;
  return get_creation_kind(metadata?.["create_target"]) !== null;
}

export function system_block(
  metadata: Dict,
  opts: { language?: string; session_id?: string } = {},
): PromptBlock | null {
  const kind = get_creation_kind(metadata["create_target"]);
  if (kind === null) return null;
  const lang = "en";
  let text = _load_prompt(lang, kind.key);

  const tail: string[] = [];
  const existing = kind.list_names(60);
  if (existing.length) {
    const names = existing.map((n) => `\`${n}\``).join(", ");
    tail.push(
      `Names already in use for this kind (avoid colliding): ${names}`,
    );
  }
  const latest = new CreationDraftStore().latest_for_session(
    opts.session_id ?? "",
    kind.key,
  );
  if (latest !== null) {
    if (latest.status === "created") {
      tail.push(
        `The latest draft was approved and saved as \`${latest.created_name ?? latest.name}\`; ` +
          "to change it, propose again with the same name — approval will update it instead of conflicting.",
      );
    } else {
      tail.push(
        `The latest draft is named \`${latest.name}\` and has not been approved yet.`,
      );
    }
  }
  if (tail.length) text = text + "\n\n" + tail.join("\n");
  return { name: "creator", content: text };
}

/**
 * Upstream augment_kwargs: hand propose_creation the turn's creation context.
 * In TS the tool resolves it from the injected ``_creation_context`` param or
 * the per-turn context published via ``set_creation_context``.
 */
export function augment_kwargs(
  tool_name: string,
  kwargs: Record<string, unknown>,
  metadata: Dict,
  session_id = "",
): Record<string, unknown> {
  if (tool_name === "propose_creation") {
    return {
      ...kwargs,
      _creation_context: {
        session_id,
        metadata,
        set_draft_id: (draft_id: string) => {
          const ext = (metadata["_creator_extension"] ??= {}) as Dict;
          ext["draft_id"] = draft_id;
        },
      },
    };
  }
  return kwargs;
}

export function pre_loop_seed(_metadata?: Dict): string {
  // Create mode never seeds the conversation with extra text.
  return "";
}
