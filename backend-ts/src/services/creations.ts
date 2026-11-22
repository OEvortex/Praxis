// Port of deeptutor/services/creations/{drafts,kinds}.py — user-scoped creation
// drafts (Skill/Persona) produced by create mode, approved via /api/creations.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { get_settings } from "../config.js";
import * as database from "../store/database.js";
import { PersonaService, PersonaExistsError, PersonaNotFoundError, getPersonaService, adminPersonaService } from "./persona.js";

type AnyDict = Record<string, any>;

export interface CreationDraft {
  draft_id: string;
  owner_id: string;
  kind: string;
  session_id: string;
  name: string;
  description: string;
  content: string;
  tags: string[];
  references: AnyDict[];
  status: string;
  created_name: string;
  replaced: boolean;
  created_at: string;
  approved_at: string;
  version: number;
}

const SAFE_ID = /^[a-f0-9]{32}$/;
const OWNER = "local";

function draftsRoot(): string {
  const dir = join(resolve(get_settings().workspace_dir), "creation_drafts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function draftPath(draftId: string): string {
  const id = String(draftId || "").trim().toLowerCase();
  if (!SAFE_ID.test(id)) throw new Error("Invalid creation draft id.");
  return join(draftsRoot(), `${id}.json`);
}

function iterDrafts(): CreationDraft[] {
  const root = draftsRoot();
  if (!existsSync(root)) return [];
  const out: CreationDraft[] = [];
  for (const file of readdirSync(root)) {
    if (!file.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(root, file), "utf8")) as CreationDraft;
      if (d.owner_id === OWNER) out.push(d);
    } catch { /* skip corrupt */ }
  }
  return out;
}

export class CreationDraftStore {
  create(opts: {
    kind: string; session_id: string; name: string; description: string;
    content: string; tags?: string[]; references?: AnyDict[];
  }): CreationDraft {
    const draft: CreationDraft = {
      draft_id: randomBytes(16).toString("hex"),
      owner_id: OWNER,
      kind: String(opts.kind || ""),
      session_id: String(opts.session_id || ""),
      name: String(opts.name || ""),
      description: String(opts.description || ""),
      content: String(opts.content || ""),
      tags: [...(opts.tags ?? [])],
      references: [...(opts.references ?? [])],
      status: "pending",
      created_name: "",
      replaced: false,
      created_at: new Date().toISOString(),
      approved_at: "",
      version: 1,
    };
    if (!draft.kind || !draft.name) throw new Error("A creation draft needs a kind and a name.");
    this.save(draft);
    return draft;
  }

  get(draftId: string): CreationDraft | null {
    try {
      const path = draftPath(draftId);
      if (!existsSync(path)) return null;
      const d = JSON.parse(readFileSync(path, "utf8")) as CreationDraft;
      return d.owner_id === OWNER ? d : null;
    } catch {
      return null;
    }
  }

  save(draft: CreationDraft): void {
    if (draft.owner_id !== OWNER) throw new Error("Creation draft belongs to another user.");
    const path = draftPath(draft.draft_id);
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(draft, null, 2));
    renameSync(tmp, path);
  }

  markCreated(draft: CreationDraft, createdName: string, replaced: boolean): CreationDraft {
    draft.status = "created";
    draft.created_name = createdName;
    draft.replaced = replaced;
    draft.approved_at = new Date().toISOString();
    this.save(draft);
    return draft;
  }

  createdBySession(sessionId: string, kind: string, name: string): boolean {
    const slug = String(name || "").trim().toLowerCase();
    return iterDrafts().some(
      (d) => d.status === "created" && d.kind === kind &&
        d.session_id === sessionId && d.created_name.trim().toLowerCase() === slug,
    );
  }

  toDict(draft: CreationDraft): AnyDict {
    const data: AnyDict = { ...draft };
    data.references = (draft.references ?? []).map((ref) => ({
      path: String(ref?.path ?? ""),
      size: String(ref?.content ?? "").length,
    }));
    return data;
  }
}

// -- kinds --------------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9\- _]{0,31}$/;
const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n?/;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_CONTENT_CHARS = 60_000;
const MAX_TAGS = 6;
const MAX_REFERENCE_FILES = 12;
const MAX_REFERENCE_FILE_BYTES = 200_000;
const MAX_REFERENCE_TOTAL_BYTES = 1_000_000;
const IMPORT_ALLOWED_SUFFIXES = new Set([
  ".md", ".txt", ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
  ".toml", ".ini", ".cfg", ".csv", ".tsv", ".html", ".css", ".svg",
]);

function slugifyName(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function normalizeCommon(fields: AnyDict): { name: string; description: string; content: string } {
  const name = slugifyName(fields.name);
  if (!name || !NAME_RE.test(name)) {
    throw new Error("name must be a lowercase slug (letters, digits, hyphens; spaces and underscores are folded into hyphens).");
  }
  const description = String(fields.description ?? "").trim();
  if (!description) throw new Error("description is required.");
  if (description.includes("\n")) throw new Error("description must be a single line.");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new Error(`description must be at most ${MAX_DESCRIPTION_CHARS} characters.`);
  }
  const content = String(fields.content ?? "").trim();
  if (!content) throw new Error("content is required.");
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`content must be at most ${MAX_CONTENT_CHARS} characters.`);
  }
  return { name, description, content };
}

function validateTags(raw: unknown): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("tags must be a list of strings.");
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const candidate = String(item ?? "").trim().toLowerCase();
    if (!candidate || !TAG_RE.test(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    cleaned.push(candidate);
  }
  if (cleaned.length > MAX_TAGS) throw new Error(`A skill may have at most ${MAX_TAGS} tags.`);
  return cleaned;
}

function validateReferences(raw: unknown): AnyDict[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("references must be a list of {path, content} objects.");
  if (raw.length > MAX_REFERENCE_FILES) throw new Error(`At most ${MAX_REFERENCE_FILES} reference files are allowed.`);
  const cleaned: AnyDict[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("Each reference must be an object with path and content.");
    const rec = item as AnyDict;
    const path = String(rec.path ?? "").trim();
    const content = String(rec.content ?? "");
    if (!path.startsWith("references/")) throw new Error(`Reference path must start with 'references/': ${path}`);
    if (path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error(`Reference path must be a relative path with no '..': ${path}`);
    }
    if (seen.has(path)) throw new Error(`Duplicate reference path: ${path}`);
    const suffix = (path.match(/\.[A-Za-z0-9]+$/) ?? [""])[0].toLowerCase();
    if (!IMPORT_ALLOWED_SUFFIXES.has(suffix)) throw new Error(`Reference file type not allowed: ${path}`);
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_REFERENCE_FILE_BYTES) throw new Error(`Reference file too large: ${path}`);
    total += size;
    if (total > MAX_REFERENCE_TOTAL_BYTES) throw new Error("Reference files exceed the total size limit.");
    seen.add(path);
    cleaned.push({ path, content });
  }
  return cleaned;
}

function skillExists(name: string): boolean {
  const settings = get_settings();
  const item = database.get_item(settings, "skills", name) ??
    database.list_items(settings, "skills").find((s) => String(s.name ?? s.id) === name);
  return !!item;
}

function skillNames(limit = 60): string[] {
  return database
    .list_items(get_settings(), "skills")
    .map((s) => String(s.name ?? s.id ?? ""))
    .filter(Boolean)
    .slice(0, limit);
}

function personaNameInUse(name: string): boolean {
  const service = getPersonaService();
  try { service.getDetail(name); return true; } catch (e) {
    if (!(e instanceof PersonaNotFoundError)) throw e;
  }
  const adminRoot = join(get_settings().data_dir, "admin", "workspace", "personas");
  if (resolve(adminRoot) === service.root) return false;
  try { new PersonaService(adminRoot, "admin").getDetail(name); return true; } catch (e) {
    if (e instanceof PersonaNotFoundError) return false;
    throw e;
  }
}

export interface CreationKind {
  key: string;
  label: string;
  href: string;
  normalize(fields: AnyDict): AnyDict;
  nameInUse(name: string): boolean;
  listNames(limit?: number): string[];
  publish(draft: CreationDraft, replace: boolean): string;
}

const SkillKind: CreationKind = {
  key: "skill",
  label: "Skill",
  href: "/space/skills",
  normalize(fields) {
    const { name, description, content } = normalizeCommon(fields);
    return { name, description, content, tags: validateTags(fields.tags), references: validateReferences(fields.references) };
  },
  nameInUse: skillExists,
  listNames: skillNames,
  publish(draft, replace) {
    const settings = get_settings();
    const existing = database.get_item(settings, "skills", draft.name);
    if (existing && !replace) throw new Error(`A skill named "${draft.name}" already exists.`);
    const item: AnyDict = {
      id: draft.name,
      name: draft.name,
      description: draft.description,
      content: draft.content,
      tags: draft.tags ?? [],
      references: draft.references ?? [],
      created_at: (existing?.created_at as number) ?? Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    database.put_item(settings, "skills", item);
    return draft.name;
  },
};

const PersonaKind: CreationKind = {
  key: "persona",
  label: "Persona",
  href: "/space/personas",
  normalize(fields) {
    const { name, description, content } = normalizeCommon(fields);
    return { name, description, content, tags: [], references: [] };
  },
  nameInUse: personaNameInUse,
  listNames(limit = 60) {
    return getPersonaService().listPersonas().map((p) => p.name).slice(0, limit);
  },
  publish(draft, replace) {
    const service = getPersonaService();
    const info = replace
      ? service.update(draft.name, { description: draft.description, content: draft.content })
      : service.create(draft.name, draft.description, draft.content);
    return info.name;
  },
};

const CREATION_KINDS: Record<string, CreationKind> = { skill: SkillKind, persona: PersonaKind };

export function getCreationKind(key: unknown): CreationKind | null {
  return CREATION_KINDS[String(key ?? "")] ?? null;
}

export function publishErrorStatus(exc: unknown): number | null {
  if (exc instanceof PersonaExistsError) return 409;
  if (
    exc instanceof PersonaNotFoundError ||
    exc instanceof Error // ValueError-equivalent validation messages
  ) {
    return 400;
  }
  return null;
}

export { adminPersonaService };
