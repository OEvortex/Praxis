// Port of deeptutor/services/rag/pipelines/ima/{client,notes,media}.py — the
// method table over Tencent IMA's knowledge-base (wiki) and notes OpenAPI.
//
// Reading: get_knowledge_list (browse), get_media_info + get_media_content
// (full source text), notes search. Writing: import_urls, create/append
// notes. Nothing deletes or overwrites.
//
// Media downloads keep upstream's SSRF boundary: the URL arrives inside an
// API response, so it must be HTTPS on a trusted Tencent host, redirects are
// not followed, and size is capped at 20 MB.

import { imaPost, NOTE_PREFIX } from "./transport.js";
import type { ImaConfig } from "./config.js";
import {
  cursorOf,
  linkedNoteId,
  notesFrom,
  parseImportedUrls,
  parseKnowledgePage,
  parseNote,
  parseNotebook,
  type ImaDocument,
  type ImaFolder,
  type ImaImportedUrl,
  type ImaKnowledgePage,
  type ImaNote,
  type ImaNotebook,
  type ImaPageCursor,
} from "./models.js";
import { ImaAPIError } from "./transport.js";
import { docxToMarkdown } from "../../services/documents/docx.js";

export const MAX_PAGE_LIMIT = 50;
export const MAX_IMPORT_URLS = 10;
export const MAX_NOTE_PAGE_LIMIT = 50;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MAX_FULLTEXT_CHARS = 12_000;

const MARKDOWN_FORMAT = 1;
const PLAIN_TEXT_FORMAT = 0;

export const SORT_BY_UPDATED = 0;
export const SORT_BY_CREATED = 1;
export const SORT_BY_TITLE = 2;
export const SORT_BY_SIZE = 3;
export const SORT_TYPES = new Set([SORT_BY_UPDATED, SORT_BY_CREATED, SORT_BY_TITLE, SORT_BY_SIZE]);

export const SEARCH_BY_TITLE = 0;
export const SEARCH_BY_CONTENT = 1;

const NOTEBOOK_FIRST_CURSOR = "0";

function pageLimit(limit: unknown, maximum = MAX_PAGE_LIMIT): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return maximum;
  return Math.max(1, Math.min(Math.trunc(n), maximum));
}

function noteLimit(limit: unknown): number {
  return pageLimit(limit, MAX_NOTE_PAGE_LIMIT);
}

// ---------------------------------------------------------------------------
// Media download (media.py port)
// ---------------------------------------------------------------------------

const ALLOWED_MEDIA_ROOT_DOMAINS = ["myqcloud.com"];
const ALLOWED_MEDIA_HOSTS = new Set(["res-pkb.ima.qq.com"]);
const FORBIDDEN_MEDIA_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/json": ".json",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
};

export interface ImaMediaContent {
  text: string;
  data: Uint8Array;
  filename: string;
}

export function validateMediaUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImaAPIError("IMA media URL must use HTTPS.");
  }
  const hostname = (parsed.hostname || "").replace(/\.$/, "").toLowerCase();
  if (parsed.protocol !== "https:" || !hostname) {
    throw new ImaAPIError("IMA media URL must use HTTPS.");
  }
  const trustedRoot = ALLOWED_MEDIA_ROOT_DOMAINS.some(
    (root) => hostname === root || hostname.endsWith(`.${root}`),
  );
  if (!ALLOWED_MEDIA_HOSTS.has(hostname) && !trustedRoot) {
    throw new ImaAPIError("IMA media URL is outside the trusted Tencent media hosts.");
  }
}

export function mediaHeaders(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (FORBIDDEN_MEDIA_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === "string" || typeof value === "number") {
      out[key] = String(value);
    }
  }
  return out;
}

function mediaFilename(url: string, contentType: string | null): string {
  let name = "";
  try {
    name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").trim();
  } catch {
    name = "";
  }
  if (name.includes(".")) return name;
  const mediaType = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return `${name || "ima-document"}${CONTENT_TYPE_EXTENSIONS[mediaType] ?? ""}`;
}

export async function downloadMedia(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<ImaMediaContent> {
  validateMediaUrl(url);
  const response = await fetch(url, {
    headers: opts.headers ?? {},
    redirect: "manual", // never follow — the API response is untrusted input
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new ImaAPIError("IMA media URL attempted a redirect; refusing to follow.");
  }
  if (!response.ok) {
    throw new ImaAPIError(`IMA media download failed with HTTP ${response.status}.`);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_MEDIA_BYTES) {
    throw new ImaAPIError("IMA media exceeds the 20 MB retrieval limit.");
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.length > MAX_MEDIA_BYTES) {
    throw new ImaAPIError("IMA media exceeds the 20 MB retrieval limit.");
  }
  return {
    text: "",
    data: buf,
    filename: mediaFilename(url, response.headers.get("content-type")),
  };
}

// Text extraction for downloaded bytes. Upstream delegates to a full
// document_extractor (PDF/Office); here we cover the cheap formats natively
// and reuse the dependency-free docx reader.
// TODO(ima): PDF / PPTX / XLSX extraction — port document_extractor or mark
// unsupported (ima_read then reports "no readable text" for those items).

const SUPPORTED_TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".log"]);

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class UnsupportedMediaFormat extends Error {}

export async function extractText(
  media: ImaMediaContent | null,
  titleCandidates: string[],
  maxChars = MAX_FULLTEXT_CHARS,
): Promise<string> {
  if (media === null) return "";
  if (media.text) return media.text.slice(0, maxChars).trim();
  if (!media.data.length) return "";

  const filename = extractableFilename(media.filename, ...titleCandidates);
  if (!filename) throw new UnsupportedMediaFormat();
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".")).toLowerCase()
    : "";

  if (SUPPORTED_TEXT_EXTENSIONS.has(ext)) {
    return new TextDecoder("utf-8", { fatal: false })
      .decode(media.data)
      .slice(0, maxChars)
      .trim();
  }
  if (ext === ".html" || ext === ".htm") {
    return stripHtml(new TextDecoder("utf-8", { fatal: false }).decode(media.data))
      .slice(0, maxChars)
      .trim();
  }
  if (ext === ".docx") {
    const md = docxToMarkdown(media.data, filename);
    return md.slice(0, maxChars).trim();
  }
  throw new UnsupportedMediaFormat();
}

function extractableFilename(...candidates: string[]): string {
  const known = new Set([
    ...SUPPORTED_TEXT_EXTENSIONS,
    ".html",
    ".htm",
    ".docx",
    ".pdf",
    ".pptx",
    ".xlsx",
  ]);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = candidate.split(/[\\/]/).pop() ?? candidate;
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
    if (known.has(ext)) return base;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ImaClient {
  readonly config: ImaConfig;

  constructor(config: ImaConfig) {
    this.config = config;
  }

  get knowledgeBaseId(): string {
    return this.config.knowledge_base_id;
  }

  private post(method: string, body: Record<string, unknown>, prefix?: string) {
    return imaPost(this.config, method, body, { prefix });
  }

  // ----- reading ----------------------------------------------------------

  async getKnowledgeList(opts: {
    folder_id?: string;
    cursor?: string;
    limit?: number;
  } = {}): Promise<ImaKnowledgePage> {
    const body: Record<string, unknown> = {
      knowledge_base_id: this.config.knowledge_base_id,
      cursor: String(opts.cursor ?? ""),
      limit: pageLimit(opts.limit),
    };
    const folder = String(opts.folder_id ?? "").trim();
    // The root folder id equals the knowledge base id; sending it is
    // equivalent to omitting the field.
    if (folder && folder !== this.config.knowledge_base_id) {
      body["folder_id"] = folder;
    }
    return parseKnowledgePage(await this.post("get_knowledge_list", body));
  }

  async getMediaInfo(mediaId: string): Promise<Record<string, unknown>> {
    const id = String(mediaId ?? "").trim();
    if (!id) return {};
    return this.post("get_media_info", { media_id: id });
  }

  async getMediaContent(mediaId: string): Promise<ImaMediaContent | null> {
    const info = await this.getMediaInfo(mediaId);
    if (!Object.keys(info).length) return null;

    const noteId = linkedNoteId(info);
    if (noteId) {
      const content = await this.getNoteContent(noteId);
      return content ? { text: content, data: new Uint8Array(), filename: "" } : null;
    }

    const urlInfo = info["url_info"];
    if (urlInfo === null || typeof urlInfo !== "object" || Array.isArray(urlInfo)) {
      return null;
    }
    const url = String((urlInfo as Record<string, unknown>)["url"] ?? "").trim();
    if (!url) return null;
    return downloadMedia(url, {
      headers: mediaHeaders((urlInfo as Record<string, unknown>)["headers"]),
    });
  }

  // ----- writing ----------------------------------------------------------

  async importUrls(urls: string[], opts: { folder_id?: string } = {}): Promise<ImaImportedUrl[]> {
    const cleaned: string[] = [];
    for (const raw of urls) {
      const url = String(raw ?? "").trim();
      if (url && !cleaned.includes(url)) cleaned.push(url);
    }
    if (!cleaned.length) throw new Error("At least one URL is required.");
    if (cleaned.length > MAX_IMPORT_URLS) {
      throw new Error(`IMA accepts at most ${MAX_IMPORT_URLS} URLs per call.`);
    }
    const target = String(opts.folder_id ?? "").trim() || this.config.knowledge_base_id;
    const data = await this.post("import_urls", {
      urls: cleaned,
      knowledge_base_id: this.config.knowledge_base_id,
      folder_id: target,
    });
    const results = parseImportedUrls(data);
    if (results.length) return results;
    // Some responses acknowledge the batch without echoing per-URL rows.
    return cleaned.map((url) => ({ url, ok: true, media_id: "", code: 0 }));
  }

  // ----- notes (IMA notes OpenAPI, /openapi/note/v1) -----------------------

  private notePost(method: string, body: Record<string, unknown>) {
    return imaPost(this.config, method, body, { prefix: NOTE_PREFIX });
  }

  async searchNotes(opts: {
    query?: string;
    by_content?: boolean;
    sort_type?: number;
    limit?: number;
    start?: number;
  } = {}): Promise<{ notes: ImaNote[]; is_end: boolean }> {
    const size = noteLimit(opts.limit);
    const text = String(opts.query ?? "").trim();
    const byContent = Boolean(opts.by_content);
    const sortType = SORT_TYPES.has(Number(opts.sort_type))
      ? Number(opts.sort_type)
      : SORT_BY_UPDATED;
    const start = Math.max(0, Math.trunc(Number(opts.start ?? 0)) || 0);
    const data = await this.notePost("search_note_book", {
      search_type: byContent ? SEARCH_BY_CONTENT : SEARCH_BY_TITLE,
      sort_type: sortType,
      query_info: byContent ? { content: text } : { title: text },
      start,
      end: start + size,
    });
    const notes = notesFrom(data, ["docs", "note_book_list"]).slice(0, size);
    return { notes, is_end: Boolean(data["is_end"]) };
  }

  async listNotes(opts: { folder_id?: string; cursor?: string; limit?: number } = {}): Promise<{
    notes: ImaNote[];
    cursor: ImaPageCursor;
  }> {
    const body: Record<string, unknown> = {
      cursor: String(opts.cursor ?? ""),
      limit: noteLimit(opts.limit),
    };
    const folder = String(opts.folder_id ?? "").trim();
    if (folder) body["folder_id"] = folder;
    const data = await this.notePost("list_note_by_folder_id", body);
    return { notes: notesFrom(data, ["note_book_list", "docs"]), cursor: cursorOf(data) };
  }

  async listNotebooks(opts: { cursor?: string; limit?: number } = {}): Promise<{
    notebooks: ImaNotebook[];
    cursor: ImaPageCursor;
  }> {
    const data = await this.notePost("list_note_folder_by_cursor", {
      cursor: String(opts.cursor ?? NOTEBOOK_FIRST_CURSOR),
      limit: noteLimit(opts.limit),
    });
    const rawList = data["note_book_folders"];
    const notebooks = Array.isArray(rawList)
      ? rawList.map(parseNotebook).filter((n): n is ImaNotebook => n !== null)
      : [];
    return { notebooks, cursor: cursorOf(data) };
  }

  async getNoteContent(noteId: string, opts: { as_markdown?: boolean } = {}): Promise<string> {
    const id = String(noteId ?? "").trim();
    if (!id) return "";
    const data = await this.notePost("get_doc_content", {
      doc_id: id,
      note_id: id,
      target_content_format: opts.as_markdown ? MARKDOWN_FORMAT : PLAIN_TEXT_FORMAT,
    });
    return String(data["content"] ?? "").trim();
  }

  async createNote(content: string, opts: { folder_id?: string } = {}): Promise<string> {
    const bodyText = String(content ?? "").trim();
    if (!bodyText) throw new Error("Note content is required.");
    const body: Record<string, unknown> = {
      content_format: MARKDOWN_FORMAT,
      content: bodyText,
    };
    const folder = String(opts.folder_id ?? "").trim();
    if (folder) body["folder_id"] = folder;
    const data = await this.notePost("import_doc", body);
    return String(data["doc_id"] ?? data["note_id"] ?? "").trim();
  }

  async appendNote(noteId: string, content: string): Promise<string> {
    const id = String(noteId ?? "").trim();
    if (!id) throw new Error("A target note id is required.");
    const bodyText = String(content ?? "").trim();
    if (!bodyText) throw new Error("Content to append is required.");
    const data = await this.notePost("append_doc", {
      doc_id: id,
      note_id: id,
      content_format: MARKDOWN_FORMAT,
      content: bodyText,
    });
    return String(data["doc_id"] ?? data["note_id"] ?? id).trim();
  }
}

export type { ImaDocument, ImaFolder, ImaNote, ImaPageCursor };
