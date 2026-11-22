// five agent tools over the
// configured Tencent IMA libraries: browse (ima_list), read full text
// (ima_read), search/list notes (ima_note_search), and the two additive
// writes (ima_add_url, ima_write_note).
//
// Bindings resolve from the kv store per call (see ./config.js); the model
// supplies at most a `kb_name` to pick between configured libraries.

import { get_settings, type Settings } from "../../config.js";
import { BaseTool, type Ctx, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import {
  imaBindings,
  resolveConfig,
  selectBinding,
  type ImaBinding,
  type ImaConfig,
} from "./config.js";
import {
  ImaAPIError,
  ImaAuthError,
  ImaRateLimitError,
} from "./transport.js";
import {
  ImaClient,
  MAX_FULLTEXT_CHARS,
  SORT_BY_CREATED,
  SORT_BY_TITLE,
  SORT_BY_UPDATED,
} from "./client.js";
import { UnsupportedMediaFormat } from "./client.js";

export const IMA_TOOL_NAMES = [
  "ima_list",
  "ima_read",
  "ima_note_search",
  "ima_add_url",
  "ima_write_note",
] as const;

const KB_NAME_PARAM = {
  type: "string",
  description:
    "Which attached IMA knowledge base to use. Optional when only one is attached.",
} as const;

function noteSort(name: unknown): number {
  return {
    updated: SORT_BY_UPDATED,
    created: SORT_BY_CREATED,
    title: SORT_BY_TITLE,
  }[String(name ?? "updated")] ?? SORT_BY_UPDATED;
}

function noBindingMessage(bindings: ImaBinding[]): string {
  if (!bindings.length) {
    return "No Tencent IMA knowledge base is configured; IMA tools are unavailable.";
  }
  const names = bindings.map((b) => b.name).join(", ");
  return `Specify which IMA knowledge base to use with kb_name. Configured: ${names}.`;
}

function isSupportedUrl(url: string): boolean {
  const lowered = url.toLowerCase();
  if (!lowered.startsWith("http://") && !lowered.startsWith("https://")) {
    return false;
  }
  return !(
    lowered.includes("bilibili.com/video/") ||
    lowered.includes("youtube.com/watch") ||
    lowered.includes("youtu.be/")
  );
}

function stringList(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value.map((v) => String(v))
    : typeof value === "string"
      ? [value]
      : null;
  if (candidates === null) throw new Error("urls must be a list of strings.");
  return candidates.map((s) => s.trim()).filter(Boolean);
}

interface ToolParams {
  kb_name?: string;
  [k: string]: unknown;
}

abstract class ImaToolBase<P extends ToolParams> extends BaseTool<P> {
  name = "";
  description = "";
  declare params?: ToolParamsSchema;
  /** Writes re-check nothing extra here (single-user backend), kept for parity. */
  protected writes = false;
  mutating = false;

  async execute(params: P, _ctx?: Ctx): Promise<ToolResult> {
    const settings = get_settings();
    try {
      return await this.runWithClient(settings, params);
    } catch (exc) {
      if (exc instanceof ImaAuthError) {
        return fail("Tencent IMA rejected the credentials for this knowledge base.");
      }
      if (exc instanceof ImaRateLimitError) {
        return fail("Tencent IMA is rate-limiting requests. Try again shortly.");
      }
      if (exc instanceof ImaAPIError || exc instanceof Error) {
        return fail(exc.message);
      }
      return fail(String(exc));
    }
  }

  private async runWithClient(settings: Settings, params: P): Promise<ToolResult> {
    const bindings = imaBindings(settings);
    const binding = selectBinding(bindings, params.kb_name);
    if (binding === null) return fail(noBindingMessage(bindings));
    let config: ImaConfig;
    try {
      config = resolveConfig(settings, binding, this.writes);
    } catch (exc) {
      return fail(exc instanceof Error ? exc.message : String(exc));
    }
    const client = new ImaClient(config);
    return this.run(client, binding, params);
  }

  protected abstract run(
    client: ImaClient,
    binding: ImaBinding,
    params: P,
  ): Promise<ToolResult>;
}

// --- tools -------------------------------------------------------------------

export interface ImaListParams extends ToolParams {
  folder_id?: string;
  limit?: number;
  cursor?: string;
}
export const imaListParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    kb_name: KB_NAME_PARAM,
    folder_id: {
      type: "string",
      description: "Folder to open, from an earlier listing. Omit for the top level.",
      default: "",
    },
    limit: { type: "integer", description: "Max entries to return (1-50, default 50).", default: 50 },
    cursor: {
      type: "string",
      description: "Continuation cursor from an earlier call's next_cursor.",
      default: "",
    },
  },
};
export class ImaListTool extends ImaToolBase<ImaListParams> {
  name = "ima_list";
  toolIcon = "📚";
  params = imaListParamsSchema;
  description =
    "List what a configured Tencent IMA knowledge base actually holds: its " +
    "documents and folders. Use this for inventory questions ('what is in " +
    "here', 'is document X present', 'show me folder Y') — retrieval only " +
    "reports what a query matched. Pass a folder_id from a previous call to " +
    "look inside that folder.";
  protected async run(client: ImaClient, binding: ImaBinding, p: ImaListParams) {
    const page = await client.getKnowledgeList({
      folder_id: String(p.folder_id ?? ""),
      cursor: String(p.cursor ?? ""),
      limit: Number(p.limit) || 50,
    });
    return ok(
      JSON.stringify({
        knowledge_base: binding.name,
        path: page.path,
        folders: page.folders.map((f) => ({
          folder_id: f.folder_id,
          name: f.name,
          documents: f.file_number,
          subfolders: f.folder_number,
        })),
        documents: page.documents.map((d) => ({
          media_id: d.media_id,
          title: d.title,
        })),
        next_cursor: page.next_cursor,
        is_end: page.is_end,
      }),
    );
  }
}

export interface ImaReadParams extends ToolParams {
  media_id: string;
}
export const imaReadParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["media_id"],
  properties: {
    media_id: { type: "string", description: "Item id from ima_list or a retrieval result." },
    kb_name: KB_NAME_PARAM,
  },
};
export class ImaReadTool extends ImaToolBase<ImaReadParams> {
  name = "ima_read";
  toolIcon = "📖";
  params = imaReadParamsSchema;
  description =
    "Read the full text of one item in a configured Tencent IMA knowledge " +
    "base, identified by the media_id from ima_list or a retrieval citation. " +
    "Use it when a retrieved snippet is too short to answer from.";
  protected async run(client: ImaClient, binding: ImaBinding, p: ImaReadParams) {
    const mediaId = String(p.media_id ?? "").trim();
    if (!mediaId) return fail("media_id is required.");
    const media = await client.getMediaContent(mediaId);
    let text = "";
    try {
      text = await extractImaText(media, mediaId);
    } catch (exc) {
      if (exc instanceof UnsupportedMediaFormat) {
        return fail(
          "That item has no readable text — it may be an image, an audio file, " +
            "or a format Tencent IMA does not expose over the API.",
        );
      }
      throw exc;
    }
    if (!text) {
      return fail(
        "That item has no readable text — it may be an image, an audio file, " +
          "or a format Tencent IMA does not expose over the API.",
      );
    }
    return ok(
      JSON.stringify({
        knowledge_base: binding.name,
        media_id: mediaId,
        truncated: text.length >= MAX_FULLTEXT_CHARS,
        content: text,
      }),
    );
  }
}

async function extractImaText(
  media: import("./client.js").ImaMediaContent | null,
  title: string,
): Promise<string> {
  const { extractText } = await import("./client.js");
  return extractText(media, [title], MAX_FULLTEXT_CHARS);
}

export interface ImaNoteSearchParams extends ToolParams {
  query?: string;
  in_content?: boolean;
  sort?: string;
  limit?: number;
}
export const imaNoteSearchParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Text to match. Omit to list notes in sort order.",
      default: "",
    },
    in_content: {
      type: "boolean",
      description: "Search note bodies instead of titles (default false).",
      default: false,
    },
    sort: {
      type: "string",
      description: "Order: updated (default), created, or title.",
      enum: ["updated", "created", "title"],
      default: "updated",
    },
    limit: { type: "integer", description: "Max notes to return (1-50, default 20).", default: 20 },
    kb_name: KB_NAME_PARAM,
  },
};
export class ImaNoteSearchTool extends ImaToolBase<ImaNoteSearchParams> {
  name = "ima_note_search";
  toolIcon = "🗒️";
  params = imaNoteSearchParamsSchema;
  description =
    "Search the user's Tencent IMA notes, or list them newest-first when no " +
    "query is given. Notes are the only IMA objects with timestamps, so this " +
    "is how to answer 'my latest notes' or 'what did I write about X'.";
  protected async run(client: ImaClient, _binding: ImaBinding, p: ImaNoteSearchParams) {
    const { notes, is_end } = await client.searchNotes({
      query: String(p.query ?? ""),
      by_content: Boolean(p.in_content),
      sort_type: noteSort(p.sort),
      limit: Number(p.limit) || 20,
    });
    return ok(
      JSON.stringify({
        notes: notes.map((n) => ({
          note_id: n.note_id,
          title: n.title,
          summary: n.summary,
          notebook: n.folder_name,
          created_at: n.created_at,
          updated_at: n.updated_at,
        })),
        is_end,
      }),
    );
  }
}

export interface ImaAddUrlParams extends ToolParams {
  urls: string[];
  folder_id?: string;
}
export const imaAddUrlParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["urls"],
  properties: {
    urls: { type: "array", description: "1-10 http(s) URLs to add.", items: { type: "string" } },
    folder_id: {
      type: "string",
      description: "Target folder from ima_list. Omit for the library root.",
      default: "",
    },
    kb_name: KB_NAME_PARAM,
  },
};
export class ImaAddUrlTool extends ImaToolBase<ImaAddUrlParams> {
  name = "ima_add_url";
  toolIcon = "➕";
  params = imaAddUrlParamsSchema;
  mutating = true;
  protected override writes = true;
  description =
    "Add web pages or WeChat articles (up to 10 URLs) to a configured Tencent " +
    "IMA knowledge base, so IMA indexes them for later retrieval. Only call " +
    "this when the user asked to save or collect something — it modifies " +
    "their library. Video pages (Bilibili / YouTube) and local files are not " +
    "supported by IMA's API.";
  protected async run(client: ImaClient, binding: ImaBinding, p: ImaAddUrlParams) {
    let urls: string[];
    try {
      urls = stringList(p.urls);
    } catch (exc) {
      return fail(exc instanceof Error ? exc.message : String(exc));
    }
    const unsupported = urls.filter((u) => !isSupportedUrl(u));
    if (unsupported.length) {
      return fail(
        "Tencent IMA cannot add these over its API (video pages and local " +
          `files must be added in the IMA desktop app): ${unsupported.join(", ")}`,
      );
    }
    const results = await client.importUrls(urls, {
      folder_id: String(p.folder_id ?? ""),
    });
    const added = results.filter((r) => r.ok);
    const failedResults = results.filter((r) => !r.ok);
    return {
      success: added.length > 0,
      result: JSON.stringify({
        knowledge_base: binding.name,
        added: added.map((item) => ({ url: item.url, media_id: item.media_id })),
        failed: failedResults.map((item) => ({ url: item.url, code: item.code })),
      }),
    };
  }
}

export interface ImaWriteNoteParams extends ToolParams {
  content: string;
  note_id?: string;
  notebook_id?: string;
}
export const imaWriteNoteParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["content"],
  properties: {
    content: {
      type: "string",
      description: "Markdown body. Start with a '# Heading' to title a new note.",
    },
    note_id: {
      type: "string",
      description:
        "Append to this note (from ima_note_search) instead of creating one.",
      default: "",
    },
    notebook_id: {
      type: "string",
      description: "Notebook for a new note. Omit for the default location.",
      default: "",
    },
    kb_name: KB_NAME_PARAM,
  },
};
export class ImaWriteNoteTool extends ImaToolBase<ImaWriteNoteParams> {
  name = "ima_write_note";
  toolIcon = "✍️";
  params = imaWriteNoteParamsSchema;
  mutating = true;
  protected override writes = true;
  description =
    "Write a Markdown note into the user's Tencent IMA account. Creates a " +
    "new note by default; pass note_id to append to that note instead. " +
    "Appending cannot be undone, so only append to a note the user " +
    "explicitly named — otherwise create a new one. Only call this when the " +
    "user asked to save something.";
  protected async run(client: ImaClient, _binding: ImaBinding, p: ImaWriteNoteParams) {
    const content = String(p.content ?? "").trim();
    const noteId = String(p.note_id ?? "").trim();
    if (noteId) {
      const written = await client.appendNote(noteId, content);
      return ok(JSON.stringify({ note_id: written, action: "appended" }));
    }
    const written = await client.createNote(content, {
      folder_id: String(p.notebook_id ?? ""),
    });
    if (!written) {
      return fail("Tencent IMA did not return a note id; the note may not have been saved.");
    }
    return ok(JSON.stringify({ note_id: written, action: "created" }));
  }
}

export const IMA_TOOLS = [
  new ImaListTool(),
  new ImaReadTool(),
  new ImaNoteSearchTool(),
  new ImaAddUrlTool(),
  new ImaWriteNoteTool(),
];

export const IMA_TOOL_TYPES = [
  ImaListTool,
  ImaReadTool,
  ImaNoteSearchTool,
  ImaAddUrlTool,
  ImaWriteNoteTool,
];
