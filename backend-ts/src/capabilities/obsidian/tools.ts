// Port of deeptutor/capabilities/obsidian/tools.py — nine agent tools over a
// connected Obsidian vault: six read (search, read, list, backlinks, links,
// tags) and three write additively (create / append / set property).
//
// Vault root resolution differs from upstream: instead of a per-turn injected
// `_vault_path`, the root comes from the configured vault directory — the
// `PRAXIS_OBSIDIAN_VAULT` env var or the `obsidian_vault_path` key in the
// SQLite kv store. The model never supplies a path, and every vault op is
// jailed to that root by vault.ts's safeJoin.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { get_settings, type Settings } from "../../config.js";
import { get_state } from "../../store/database.js";
import { BaseTool, type Ctx, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import * as vault from "./vault.js";

export const OBSIDIAN_TOOL_NAMES = [
  "obsidian_search",
  "obsidian_read",
  "obsidian_list",
  "obsidian_backlinks",
  "obsidian_links",
  "obsidian_tags",
  "obsidian_create_note",
  "obsidian_append",
  "obsidian_set_property",
] as const;

const VAULT_PATH_STATE_KEY = "obsidian_vault_path";

/** The configured vault root, or null when none is set / not a directory. */
export function vaultRoot(settings: Settings = get_settings()): string | null {
  const env = (process.env.PRAXIS_OBSIDIAN_VAULT ?? "").trim();
  const raw =
    env ||
    String(get_state<unknown>(settings, VAULT_PATH_STATE_KEY, "") ?? "").trim();
  if (!raw) return null;
  const root = resolve(raw);
  try {
    return statSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

function noVault(): ToolResult {
  return fail(
    "No Obsidian vault is configured. Set the 'obsidian_vault_path' setting " +
      "(or PRAXIS_OBSIDIAN_VAULT) to the vault directory first.",
  );
}

function asInt(value: unknown, dflt: number, lo: number, hi: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

abstract class ObsidianToolBase<P> extends BaseTool<P> {
  name = "";
  description = "";
  declare params?: ToolParamsSchema;
  mutating = false;

  async execute(params: P, _ctx?: Ctx): Promise<ToolResult> {
    const root = vaultRoot();
    if (root === null || !existsSync(root)) return noVault();
    try {
      return await this.run(root, params);
    } catch (exc) {
      if (exc instanceof vault.VaultError) return fail(exc.message);
      return fail(
        `${this.name} failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }

  protected abstract run(root: string, params: P): Promise<ToolResult>;
}

// --- read tools -------------------------------------------------------------

export interface SearchParams { query: string; limit?: number }
export const obsidianSearchParams: ToolParamsSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "Text to search for." },
    limit: { type: "integer", description: "Max results (default 20).", default: 20 },
  },
};
export class ObsidianSearchTool extends ObsidianToolBase<SearchParams> {
  name = "obsidian_search";
  toolIcon = "🔍";
  params = obsidianSearchParams;
  description =
    "Search the user's Obsidian vault for notes whose title or body contains " +
    "the query (case-insensitive). Returns matching note paths with a short " +
    "snippet. Use this first to find where something lives, then " +
    "obsidian_read the promising notes.";
  protected async run(root: string, p: SearchParams): Promise<ToolResult> {
    const query = String(p.query ?? "").trim();
    if (!query) return fail("obsidian_search needs a non-empty 'query'.");
    const limit = asInt(p.limit, 20, 1, 100);
    const hits = await vault.searchNotes(root, query, limit);
    return ok(JSON.stringify({ query, count: hits.length, results: hits }));
  }
}

export interface ReadParams { note: string }
export const obsidianReadParams: ToolParamsSchema = {
  type: "object",
  required: ["note"],
  properties: {
    note: {
      type: "string",
      description: "Note name (e.g. 'Project Plan') or path (e.g. 'work/Plan.md').",
    },
  },
};
export class ObsidianReadTool extends ObsidianToolBase<ReadParams> {
  name = "obsidian_read";
  toolIcon = "📄";
  params = obsidianReadParams;
  description =
    "Read a note from the vault. Accepts a bare note name (resolved like a " +
    "[[wikilink]]) or a vault-relative path. Returns the note's frontmatter " +
    "properties and Markdown body.";
  protected async run(root: string, p: ReadParams): Promise<ToolResult> {
    const ref = String(p.note ?? "").trim();
    if (!ref) return fail("obsidian_read needs a 'note' name or path.");
    return ok(JSON.stringify(await vault.readNote(root, ref)));
  }
}

export interface ListParams { folder?: string; limit?: number }
export const obsidianListParams: ToolParamsSchema = {
  type: "object",
  properties: {
    folder: {
      type: "string",
      description: "Vault-relative folder to list (empty = whole vault).",
      default: "",
    },
    limit: { type: "integer", description: "Max paths (default 200).", default: 200 },
  },
};
export class ObsidianListTool extends ObsidianToolBase<ListParams> {
  name = "obsidian_list";
  toolIcon = "📁";
  params = obsidianListParams;
  description =
    "List note paths in the vault, optionally restricted to a folder. Use to " +
    "discover structure when you don't have a search term.";
  protected async run(root: string, p: ListParams): Promise<ToolResult> {
    const folder = String(p.folder ?? "").trim();
    const limit = asInt(p.limit, 200, 1, 1000);
    const paths = await vault.listNotes(root, folder, limit);
    return ok(JSON.stringify({ folder, count: paths.length, notes: paths }));
  }
}

export interface NoteRefParams { note: string }
export const obsidianNoteRefParams: ToolParamsSchema = {
  type: "object",
  required: ["note"],
  properties: {
    note: { type: "string", description: "Note name or path." },
  },
};
export class ObsidianBacklinksTool extends ObsidianToolBase<NoteRefParams> {
  name = "obsidian_backlinks";
  toolIcon = "🔗";
  params = obsidianNoteRefParams;
  description =
    "Find notes that link TO the given note via [[wikilink]]. The backbone of " +
    "vault navigation — follow backlinks to discover how ideas connect.";
  protected async run(root: string, p: NoteRefParams): Promise<ToolResult> {
    const ref = String(p.note ?? "").trim();
    if (!ref) return fail("obsidian_backlinks needs a 'note' name or path.");
    const links = await vault.backlinks(root, ref);
    return ok(JSON.stringify({ note: ref, count: links.length, backlinks: links }));
  }
}

export class ObsidianLinksTool extends ObsidianToolBase<NoteRefParams> {
  name = "obsidian_links";
  toolIcon = "↗️";
  params = obsidianNoteRefParams;
  description =
    "List the notes a given note links OUT to via [[wikilink]], in order. " +
    "Pair with obsidian_backlinks to traverse the graph both ways.";
  protected async run(root: string, p: NoteRefParams): Promise<ToolResult> {
    const ref = String(p.note ?? "").trim();
    if (!ref) return fail("obsidian_links needs a 'note' name or path.");
    const links = await vault.outgoingLinks(root, ref);
    return ok(JSON.stringify({ note: ref, count: links.length, links }));
  }
}

export interface TagsParams { limit?: number }
export const obsidianTagsParams: ToolParamsSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", description: "Max tags (default 200).", default: 200 },
  },
};
export class ObsidianTagsTool extends ObsidianToolBase<TagsParams> {
  name = "obsidian_tags";
  toolIcon = "#️⃣";
  params = obsidianTagsParams;
  description =
    "List all tags used across the vault (inline #tags and frontmatter " +
    "tags), ranked by how many notes use each. Use to map the vault's topics " +
    "before drilling in.";
  protected async run(root: string, p: TagsParams): Promise<ToolResult> {
    const limit = asInt(p.limit, 200, 1, 1000);
    const tags = await vault.collectTags(root, limit);
    return ok(JSON.stringify({ count: tags.length, tags }));
  }
}

// --- write tools (additive only) --------------------------------------------

export interface CreateNoteParams {
  path: string;
  content: string;
  properties?: Record<string, unknown>;
}
export const obsidianCreateNoteParams: ToolParamsSchema = {
  type: "object",
  required: ["path", "content"],
  properties: {
    path: {
      type: "string",
      description: "Vault-relative path, e.g. 'Summaries/Photosynthesis.md'.",
    },
    content: {
      type: "string",
      description:
        "Markdown body. Must be non-empty — write the complete note text in " +
        "this call; extend an existing note later with obsidian_append.",
    },
    properties: {
      type: "object",
      description: "Optional frontmatter properties (tags, aliases, …).",
    },
  },
};
export class ObsidianCreateNoteTool extends ObsidianToolBase<CreateNoteParams> {
  name = "obsidian_create_note";
  toolIcon = "📝";
  params = obsidianCreateNoteParams;
  mutating = true;
  description =
    "Create a NEW note in the vault. Fails if the path already exists (use " +
    "obsidian_append for existing notes). Write valid Obsidian Flavored " +
    "Markdown: [[wikilinks]] for vault notes, > [!note] callouts, " +
    "![[embeds]]. Pass structured metadata as 'properties' (frontmatter), " +
    "not inline.";
  protected async run(root: string, p: CreateNoteParams): Promise<ToolResult> {
    const path = String(p.path ?? "").trim();
    if (!path) return fail("obsidian_create_note needs a 'path'.");
    const frontmatter = isRecord(p.properties) ? p.properties : null;
    const created = await vault.createNote(root, path, String(p.content ?? ""), frontmatter);
    return ok(JSON.stringify({ status: "created", path: created }));
  }
}

export interface AppendParams { note: string; content: string }
export const obsidianAppendParams: ToolParamsSchema = {
  type: "object",
  required: ["note", "content"],
  properties: {
    note: { type: "string", description: "Note name or path." },
    content: { type: "string", description: "Markdown to append." },
  },
};
export class ObsidianAppendTool extends ObsidianToolBase<AppendParams> {
  name = "obsidian_append";
  toolIcon = "📎";
  params = obsidianAppendParams;
  mutating = true;
  description =
    "Append Markdown to the end of an existing note. Use for adding to a " +
    "daily note, log, or running document without rewriting it.";
  protected async run(root: string, p: AppendParams): Promise<ToolResult> {
    const ref = String(p.note ?? "").trim();
    if (!ref) return fail("obsidian_append needs a 'note' name or path.");
    const updated = await vault.appendNote(root, ref, String(p.content ?? ""));
    return ok(JSON.stringify({ status: "appended", path: updated }));
  }
}

export interface SetPropertyParams { note: string; key: string; value: unknown }
export const obsidianSetPropertyParams: ToolParamsSchema = {
  type: "object",
  required: ["note", "key", "value"],
  properties: {
    note: { type: "string", description: "Note name or path." },
    key: { type: "string", description: "Property name." },
    value: { type: "string", description: "Property value (string scalar)." },
  },
};
export class ObsidianSetPropertyTool extends ObsidianToolBase<SetPropertyParams> {
  name = "obsidian_set_property";
  toolIcon = "🏷️";
  params = obsidianSetPropertyParams;
  mutating = true;
  description =
    "Set a single frontmatter property (key/value) on an existing note, e.g. " +
    "status, due date, or a tag list. Creates the frontmatter block if " +
    "absent; leaves the body untouched.";
  protected async run(root: string, p: SetPropertyParams): Promise<ToolResult> {
    const ref = String(p.note ?? "").trim();
    const key = String(p.key ?? "").trim();
    if (!ref || !key) return fail("obsidian_set_property needs 'note' and 'key'.");
    const updated = await vault.setProperty(root, ref, key, p.value);
    return ok(JSON.stringify({ status: "updated", path: updated, key }));
  }
}

export const OBSIDIAN_TOOLS = [
  new ObsidianSearchTool(),
  new ObsidianReadTool(),
  new ObsidianListTool(),
  new ObsidianBacklinksTool(),
  new ObsidianLinksTool(),
  new ObsidianTagsTool(),
  new ObsidianCreateNoteTool(),
  new ObsidianAppendTool(),
  new ObsidianSetPropertyTool(),
];

export const OBSIDIAN_TOOL_TYPES = [
  ObsidianSearchTool,
  ObsidianReadTool,
  ObsidianListTool,
  ObsidianBacklinksTool,
  ObsidianLinksTool,
  ObsidianTagsTool,
  ObsidianCreateNoteTool,
  ObsidianAppendTool,
  ObsidianSetPropertyTool,
];
