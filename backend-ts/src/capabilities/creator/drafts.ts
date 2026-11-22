// its propose_creation tool need: the two creation kinds (skill, persona),
// input normalization, and the per-session draft store.
//
// TS port notes / TODOs:
//  - Upstream persists drafts on disk (CreationDraftStore) and lists existing
//    skill/persona names from the skills/personas services. Neither service
//    exists in this backend yet, so drafts live in the shared kv store under
//    ``creator/drafts`` keyed by session, and ``list_names`` reads the
//    ``skills`` / ``personas`` ext_items collections (empty until those
//    surfaces are ported — TODO(creations-service)).

import { randomBytes } from "node:crypto";
import { get_settings } from "../../config.js";
import { get_state, put_state } from "../../store/database.js";
import { list_items } from "../../store/database.js";
import type { Dict } from "../../shared/types.js";

const DRAFTS_KEY = "creator/drafts";
const MAX_DRAFTS = 200;

// ---------------------------------------------------------------------------
// Kind adapters
// ---------------------------------------------------------------------------

export interface CreationKind {
  key: string;
  label: string;
  normalize: (kwargs: Dict) => Dict;
  name_in_use: (name: string) => boolean;
  list_names: (limit?: number) => string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function _slug(name: string): string {
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function _normalize_common(kwargs: Dict, kind: CreationKind): Dict {
  const name = _slug(String(kwargs["name"] ?? ""));
  if (!name || name.length > 64 || !NAME_RE.test(name)) {
    throw new Error(
      `Invalid ${kind.label.toLowerCase()} name — use a lowercase slug ` +
        "(letters, digits, hyphens).",
    );
  }
  const description = String(kwargs["description"] ?? "").trim();
  if (!description) throw new Error(`${kind.label} needs a description.`);
  const content = String(kwargs["content"] ?? "");
  if (!content.trim()) throw new Error(`${kind.label} needs content.`);
  if (content.length > 200000) throw new Error(`${kind.label} content is too long.`);
  return { name, description, content };
}

function _normalize_skill(kwargs: Dict): Dict {
  const out = _normalize_common(kwargs, SKILL_KIND);
  const tags = Array.isArray(kwargs["tags"])
    ? (kwargs["tags"] as unknown[]).map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
    : [];
  const references = Array.isArray(kwargs["references"])
    ? (kwargs["references"] as unknown[])
        .filter(
          (r): r is Dict =>
            r !== null &&
            typeof r === "object" &&
            !Array.isArray(r) &&
            typeof (r as Dict)["path"] === "string" &&
            typeof (r as Dict)["content"] === "string",
        )
        .map((r) => ({ path: String(r["path"]), content: String(r["content"]) }))
        .filter((r) => r.path.startsWith("references/"))
        .slice(0, 12)
    : [];
  return { ...out, tags, references };
}

function _normalize_persona(kwargs: Dict): Dict {
  // Tags and references are a Skill-only concept; ignored for personas.
  return _normalize_common(kwargs, PERSONA_KIND);
}

function _collection_names(collection: string, limit = 60): string[] {
  try {
    return list_items(get_settings(), collection)
      .map((item) => String(item["name"] ?? item["id"] ?? ""))
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

function _name_in_use(collection: string, name: string): boolean {
  try {
    return list_items(get_settings(), collection).some(
      (item) => String(item["name"] ?? "") === name,
    );
  } catch {
    return false;
  }
}

export const SKILL_KIND: CreationKind = {
  key: "skill",
  label: "Skill",
  normalize: _normalize_skill,
  name_in_use: (name) => _name_in_use("skills", name),
  list_names: (limit = 60) => _collection_names("skills", limit),
};

export const PERSONA_KIND: CreationKind = {
  key: "persona",
  label: "Persona",
  normalize: _normalize_persona,
  name_in_use: (name) => _name_in_use("personas", name),
  list_names: (limit = 60) => _collection_names("personas", limit),
};

const KINDS: Record<string, CreationKind> = {
  skill: SKILL_KIND,
  persona: PERSONA_KIND,
};

export function get_creation_kind(create_target: unknown): CreationKind | null {
  const raw = String(create_target ?? "").trim().toLowerCase();
  if (!raw) return null;
  // Accept "skill" / "persona" and upstream-style "create:skill" targets.
  const key = raw.includes(":") ? raw.split(":").pop()! : raw;
  return KINDS[key] ?? null;
}

// ---------------------------------------------------------------------------
// Draft store
// ---------------------------------------------------------------------------

export interface CreationDraft {
  draft_id: string;
  kind: string;
  session_id: string;
  name: string;
  description: string;
  content: string;
  tags: string[];
  references: { path: string; content: string }[];
  status: "draft" | "created";
  created_name?: string;
  created_at: number;
  updated_at: number;
}

interface DraftsState {
  drafts: CreationDraft[];
}

function _load(): DraftsState {
  const data = get_state<DraftsState>(get_settings(), DRAFTS_KEY, { drafts: [] });
  return data && Array.isArray(data.drafts) ? data : { drafts: [] };
}

function _save(state: DraftsState): void {
  put_state(get_settings(), DRAFTS_KEY, state);
}

export class CreationDraftStore {
  create(opts: {
    kind: string;
    session_id: string;
    name: string;
    description: string;
    content: string;
    tags?: string[];
    references?: { path: string; content: string }[];
  }): CreationDraft {
    const state = _load();
    const now = Date.now() / 1000;
    const draft: CreationDraft = {
      draft_id: randomBytes(12).toString("hex"),
      kind: opts.kind,
      session_id: opts.session_id,
      name: opts.name,
      description: opts.description,
      content: opts.content,
      tags: opts.tags ?? [],
      references: opts.references ?? [],
      status: "draft",
      created_at: now,
      updated_at: now,
    };
    state.drafts.push(draft);
    if (state.drafts.length > MAX_DRAFTS) {
      state.drafts = state.drafts.slice(-MAX_DRAFTS);
    }
    _save(state);
    return draft;
  }

  /** Latest draft for this session+kind (upstream latest_for_session). */
  latest_for_session(session_id: string, kind: string): CreationDraft | null {
    const state = _load();
    for (let i = state.drafts.length - 1; i >= 0; i--) {
      const d = state.drafts[i];
      if (d.session_id === session_id && d.kind === kind) return d;
    }
    return null;
  }

  /** Whether this session already produced a draft with this name — the
   * "reuse to update" escape hatch upstream checks before name_in_use. */
  created_by_session(session_id: string, kind: string, name: string): boolean {
    const state = _load();
    return state.drafts.some(
      (d) =>
        d.session_id === session_id &&
        d.kind === kind &&
        d.name === name &&
        d.status === "created",
    );
  }

  /** Mark a draft approved/saved (called by the review UI when it lands). */
  mark_created(draft_id: string, created_name: string): void {
    const state = _load();
    const draft = state.drafts.find((d) => d.draft_id === draft_id);
    if (draft) {
      draft.status = "created";
      draft.created_name = created_name;
      draft.updated_at = Date.now() / 1000;
      _save(state);
    }
  }

  get(draft_id: string): CreationDraft | null {
    return _load().drafts.find((d) => d.draft_id === draft_id) ?? null;
  }
}

export function draft_to_dict(draft: CreationDraft): Dict {
  return { ...draft };
}
