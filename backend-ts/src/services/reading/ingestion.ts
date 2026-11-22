// Port of deeptutor/reading/ingestion.py — URL/media ingestion. The web path
// (safe page → markdown → units) is implemented with plain fetch + tag strip;
// YouTube/Bilibili caption loaders, ffmpeg media chunking and speech-to-text
// are NOT ported (no equivalents in this backend) — those materials are
// queued, then marked failed with a clear error, matching the durable-state
// contract.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { ReadingCatalogStore, MaterialRecord, SourceKind } from "./catalog.js";
import { IngestionStatus } from "./catalog.js";
import { ReadingError } from "./models.js";
import { ReadingStore, contentHash } from "./store.js";
import { splitMarkdownByHeadings } from "./extract.js";
import type { OutlineEntry, UnitReference } from "./models.js";

export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const MEDIA_PENDING_TEXT = "[Transcribing this media…]";
export const MEDIA_COVER_ASSET = "cover.jpg";
export const TRANSCRIPT_UNAVAILABLE_TEXT = "[Transcript unavailable for this video.]";

const AUDIO_SUFFIXES = new Set([".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".webm"]);
const MEDIA_MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
  ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
};

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const BILIBILI_HOSTS = new Set(["bilibili.com", "www.bilibili.com", "m.bilibili.com", "player.bilibili.com", "b23.tv"]);
const BILIBILI_ID = /^BV[0-9A-Za-z]{10}$/i;

export interface TranscriptSegment {
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export function urlMaterialId(url: string): string {
  return createHash("sha256").update(normalizeUrl(url), "utf8").digest("hex").slice(0, 16);
}

export function normalizeUrl(url: string): string {
  let value = String(url ?? "").trim().replace(/^[`"']+|[`"']+$/g, "");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReadingError("URL must use http:// or https:// and include a host");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new ReadingError("URL must use http:// or https:// and include a host");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (YOUTUBE_HOSTS.has(host)) return parseYouTubeUrl(value).canonical_url;
  if (BILIBILI_HOSTS.has(host)) return parseBilibiliUrl(value).canonical_url;
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = "";
  if (!parsed.pathname) parsed.pathname = "/";
  return parsed.toString();
}

export function youtubeVideoId(url: string): string | null {
  try {
    return parseYouTubeUrl(url).video_id;
  } catch {
    return null;
  }
}

export function bilibiliVideoId(url: string): string | null {
  try {
    return parseBilibiliUrl(url).bvid;
  } catch {
    return null;
  }
}

function parseTimestamp(value: unknown): number {
  const raw = String(value ?? "").trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !m.slice(1).some(Boolean)) return 0;
  return Math.max(0, Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}

export function parseYouTubeUrl(value: string): { video_id: string; canonical_url: string; entry_time_seconds: number } {
  const parsed = new URL(String(value ?? "").trim().replace(/^[`"']+|[`"']+$/g, ""));
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ReadingError("YouTube URL must use HTTP or HTTPS");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  let candidate = "";
  if (host === "youtu.be") {
    candidate = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (parsed.pathname === "/watch") {
      candidate = parsed.searchParams.get("v") ?? "";
    } else if (/^\/(shorts|live|embed)\//.test(parsed.pathname)) {
      candidate = parsed.pathname.split("/")[2]?.split("/")[0] ?? "";
    }
  }
  if (!YOUTUBE_ID.test(candidate)) throw new ReadingError("Unsupported or invalid YouTube URL");
  const entry = parseTimestamp(parsed.searchParams.get("t") ?? parsed.searchParams.get("start") ?? "0");
  const canonical = new URL(`https://youtu.be/${candidate}`);
  if (entry) canonical.searchParams.set("t", String(entry));
  return { video_id: candidate, canonical_url: canonical.toString(), entry_time_seconds: entry };
}

export function parseBilibiliUrl(value: string): { bvid: string; canonical_url: string; page_number: number; entry_time_seconds: number } {
  const parsed = new URL(String(value ?? "").trim().replace(/^[`"']+|[`"']+$/g, ""));
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ReadingError("Bilibili URL must use HTTP or HTTPS");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!BILIBILI_HOSTS.has(host)) throw new ReadingError("Unsupported or invalid Bilibili URL");
  let candidate = "";
  if (host === "player.bilibili.com" && parsed.pathname.replace(/\/+$/, "") === "/player.html") {
    candidate = parsed.searchParams.get("bvid") ?? "";
  } else if (host === "b23.tv") {
    candidate = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  } else {
    const m = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(parsed.pathname);
    candidate = m?.[1] ?? "";
  }
  if (!BILIBILI_ID.test(candidate)) throw new ReadingError("Unsupported or invalid Bilibili URL");
  candidate = `BV${candidate.slice(2)}`;
  let page = 1;
  try {
    page = Math.max(1, Number(parsed.searchParams.get("p") ?? parsed.searchParams.get("page") ?? "1") || 1);
  } catch { page = 1; }
  const entry = parseTimestamp(parsed.searchParams.get("t") ?? parsed.searchParams.get("start") ?? "0");
  const canonical = new URL(`https://www.bilibili.com/video/${candidate}/`);
  if (page > 1) canonical.searchParams.set("p", String(page));
  if (entry) canonical.searchParams.set("t", String(entry));
  return { bvid: candidate, canonical_url: canonical.toString(), page_number: page, entry_time_seconds: entry };
}

function clock(seconds: number): string {
  const value = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  return hours ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

function mediaIdentity(displayName: string): { kind: SourceKind; render_mode: string; mime: string } {
  const suffix = extname(displayName).toLowerCase();
  const isAudio = AUDIO_SUFFIXES.has(suffix) && suffix !== ".webm";
  return {
    kind: isAudio ? "audio" : "video",
    render_mode: isAudio ? "audio" : "video",
    mime: MEDIA_MIME[suffix] ?? "application/octet-stream",
  };
}

// -- crude HTML → markdown (TODO: port services/web_source fetch+markdown) ------

async function fetchUrlAsMarkdown(url: string): Promise<{ ok: boolean; url?: string; title?: string; markdown?: string; error?: string }> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "DeepTutor-Reading/1.0 (+https://github.com)" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    if (html.length > 2_000_000) return { ok: false, error: "page too large" };
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleMatch ? decodeEntities(titleMatch[1]!.replace(/<[^>]+>/g, "").trim()) : "";
    const markdown = htmlToMarkdown(html);
    return { ok: true, url: res.url || url, title, markdown };
  } catch (exc) {
    return { ok: false, error: String((exc as Error).message ?? exc) };
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToMarkdown(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Block-level tags → paragraph breaks; headings → markdown headings.
  text = text
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n\n${"#".repeat(Number(level))} ${stripTags(inner)}\n\n`)
    .replace(/<\/(p|div|section|article|header|footer|main|aside|nav|ul|ol|li|blockquote|pre|table|tr|figure|figcaption)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(ul|ol)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
      const label = stripTags(inner).trim();
      return label ? `[${label}](${href})` : "";
    })
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = stripTags(text);
  return decodeEntities(text)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripTags(s: string): string {
  return String(s).replace(/<[^>]+>/g, "");
}

// -- service ---------------------------------------------------------------------

export class ReadingIngestionService {
  readonly catalog: ReadingCatalogStore;
  readonly readingStore: ReadingStore;

  constructor(readingStore?: ReadingStore | null, catalog?: ReadingCatalogStore | null) {
    // The caller (router) supplies roots; catalog is required for the catalog db.
    this.catalog = catalog as ReadingCatalogStore;
    this.readingStore = readingStore ?? new ReadingStore("");
  }

  queueUrl(url: string, opts: { title?: string } = {}): MaterialRecord {
    const normalized = normalizeUrl(url);
    const kind: SourceKind = youtubeVideoId(normalized)
      ? "youtube"
      : bilibiliVideoId(normalized)
        ? "bilibili"
        : "web";
    const materialId = urlMaterialId(normalized);
    const fallbackTitle = String(opts.title ?? "").trim() ||
      new URL(normalized).hostname || "Web source";
    return this.catalog.upsertMaterial({
      content_id: materialId,
      material_id: materialId,
      filename: `${materialId}.url`,
      title: fallbackTitle,
      source_kind: kind,
      source_url: normalized,
      mime: kind === "web" ? "text/html" : "text/vtt",
      render_mode: kind === "youtube" || kind === "bilibili" ? "video" : "text",
      status: "queued",
    });
  }

  async processUrl(materialId: string): Promise<MaterialRecord> {
    const record = this.catalog.getMaterial(materialId);
    if (!record || !record.source_url) {
      throw new ReadingError(`queued URL material ${JSON.stringify(materialId)} not found`);
    }
    this.catalog.updateMaterialStatus(materialId, "processing", { progress: 10 });
    try {
      if (record.source_kind === "youtube" || record.source_kind === "bilibili") {
        // No caption provider in this backend (yt-dlp / bilibili API not ported).
        throw new ReadingError(
          `${record.source_kind} caption import is not yet supported by the TypeScript backend.`,
        );
      }
      return await this.processWeb(record);
    } catch (exc) {
      const code = record.source_kind === "youtube"
        ? "youtube_transcript_failed"
        : record.source_kind === "bilibili"
          ? "bilibili_metadata_failed"
          : "web_fetch_failed";
      return this.catalog.updateMaterialStatus(materialId, "failed", {
        error_code: code,
        error_detail: String((exc as Error).message ?? exc),
      });
    }
  }

  private async processWeb(record: MaterialRecord): Promise<MaterialRecord> {
    const outcome = await fetchUrlAsMarkdown(record.source_url);
    if (!outcome.ok || !outcome.markdown) {
      throw new ReadingError(outcome.error || "web source could not be fetched");
    }
    const sourceUrl = outcome.url || record.source_url;
    const [units, outline] = splitMarkdownByHeadings(outcome.markdown);
    if (!units.length) throw new ReadingError("web source contained no readable article text");
    this.readingStore.ingestUnits(record.material_id, {
      filename: `${record.material_id}.md`,
      units,
      unit: "section",
      title: outcome.title || record.title,
      mime: "text/markdown",
      extractor: "safe-web-fetch",
      content_format: "web_markdown",
      source_type: "url_snapshot",
      source_url: sourceUrl,
      outline: outline.length ? outline : null,
    });
    return this.catalog.upsertMaterial({
      content_id: record.content_id,
      material_id: record.material_id,
      filename: `${record.material_id}.md`,
      title: outcome.title || record.title,
      source_kind: "web",
      source_url: sourceUrl,
      mime: "text/markdown",
      render_mode: "text",
      status: "ready",
    });
  }

  async retry(materialId: string): Promise<MaterialRecord> {
    const record = this.catalog.getMaterial(materialId);
    if (!record) throw new ReadingError(`material ${JSON.stringify(materialId)} not found`);
    if (["web", "youtube", "bilibili"].includes(record.source_kind)) {
      return this.processUrl(materialId);
    }
    if (["video", "audio"].includes(record.source_kind)) {
      return this.processMedia(materialId);
    }
    throw new ReadingError("this material cannot be re-imported; upload it again");
  }

  async queueMedia(sourcePath: string, opts: { filename?: string } = {}): Promise<MaterialRecord> {
    const path = sourcePath;
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (exc) {
      throw new ReadingError(`${basename(path)}: could not be read (${(exc as Error).message})`);
    }
    if (!raw.length) throw new ReadingError(`${basename(path)} is empty`);
    const displayName = (opts.filename ?? basename(path)).trim() || basename(path);
    const materialId = contentHash(raw);
    const { kind, render_mode, mime } = mediaIdentity(displayName);

    this.readingStore.ingestUnits(materialId, {
      filename: displayName,
      units: [MEDIA_PENDING_TEXT],
      unit: "segment",
      title: basename(displayName).replace(/\.[^.]+$/, ""),
      mime,
      extractor: "media-pending",
      render_mode,
      raw_data: raw,
      outline: [{ locator: 1, title: clock(0), level: 1, synthesised: false, source_href: "", source_anchor: "" }],
      unit_refs: [{ locator: 1, source_href: "#t=0", title: clock(0) }],
    });
    return this.catalog.upsertMaterial({
      content_id: materialId,
      material_id: materialId,
      filename: displayName,
      title: basename(displayName).replace(/\.[^.]+$/, ""),
      source_kind: kind,
      mime,
      render_mode,
      status: "processing",
      progress: 5,
    });
  }

  async processMedia(materialId: string): Promise<MaterialRecord> {
    // No speech-to-text provider exists in this backend (ffmpeg/whisper not
    // ported). Mark the material failed with an honest error so the library
    // does not sit in "processing" forever.
    try {
      const record = this.catalog.getMaterial(materialId);
      if (!record) throw new ReadingError(`queued media material ${JSON.stringify(materialId)} not found`);
      return this.catalog.updateMaterialStatus(materialId, "failed", {
        error_code: "stt_unavailable",
        error_detail: "Speech-to-text transcription is not yet supported by the TypeScript backend.",
      });
    } catch (exc) {
      const record = this.catalog.getMaterial(materialId);
      if (record) return record;
      throw exc;
    }
  }
}

export function _testHooks() {
  return { htmlToMarkdown, decodeEntities, mediaIdentity, clock };
}
