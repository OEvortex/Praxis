// Port of deeptutor/video_learning/service.py — provider-neutral timed video
// learning for YouTube and Invidious.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { get_settings } from "../../config.js";
import type { Settings } from "../../config.js";

export type ProviderName = "youtube" | "invidious";

export const MAX_TRANSCRIPT_CUES = 20_000;
export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MIN_SEGMENT_SECONDS = 20;
const MAX_SEGMENT_SECONDS = 90;
const YOUTUBE_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
]);
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MATERIAL_ID_RE = /^[0-9a-f]{16,64}$/;
const WEBVTT_TIMING_RE =
  /^\s*(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{2}:\d{2}(?::\d{2})?[.,]\d{3})(?:[ \t]+.*)?$/;

export class TimedMediaError extends Error {}
export class TimedMediaNotFound extends TimedMediaError {}

export interface YouTubeRequest {
  video_id: string;
  canonical_url: string;
  entry_time_seconds: number;
}

export interface ProviderResolution {
  metadata: Record<string, unknown>;
  cues: Array<Record<string, unknown>>;
  transcript_language?: string;
  transcript_source?: string;
  formats?: Array<Record<string, unknown>> | null;
}

export const DEFAULT_VIDEO_LEARNING_SETTINGS: Record<string, unknown> = {
  version: 1,
  default_provider: "youtube",
  youtube: { transcript_provider: "youtube_transcript_api" },
  invidious: { api_base_url: "", public_base_url: "" },
};

export function parseTimestamp(value: unknown): number {
  const raw = String(value ?? "").trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Math.max(0, Number.parseInt(raw, 10));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !m.slice(1).some(Boolean)) return 0;
  const [h, min, s] = [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
  return Math.max(0, h * 3600 + min * 60 + s);
}

export function parseYoutubeUrl(value: string): YouTubeRequest {
  let parsed: URL;
  try {
    parsed = new URL((value ?? "").trim().replace(/^[`"']+|[`"']+$/g, ""));
  } catch {
    throw new TimedMediaError("YouTube URL must use HTTP or HTTPS.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TimedMediaError("YouTube URL must use HTTP or HTTPS.");
  }
  const host = (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  const query = parsed.searchParams;
  let videoId = "";
  if (host === "youtu.be") {
    videoId = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (parsed.pathname === "/watch") {
      videoId = query.get("v") ?? "";
    } else if (["/shorts/", "/live/", "/embed/"].some((p) => parsed.pathname.startsWith(p))) {
      videoId = parsed.pathname.split("/").slice(2).join("/").split("/")[0] ?? "";
    }
  }
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new TimedMediaError("Unsupported or invalid YouTube URL.");
  }
  const tRaw = query.get("t") ?? query.get("start") ?? "0";
  const entry = parseTimestamp(tRaw);
  const canonicalQuery = entry ? `?t=${entry}` : "";
  return {
    video_id: videoId,
    canonical_url: `https://youtu.be/${videoId}${canonicalQuery}`,
    entry_time_seconds: entry,
  };
}

function isLocalHost(host: string): boolean {
  if (host === "localhost" || host === "invidious" || host === "host.docker.internal") return true;
  if (host.endsWith(".local") || host.endsWith(".ts.net")) return true;
  // IPv4 private/loopback/link-local + RFC 6598 shared space (100.64/10).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function validateOrigin(value: unknown): string {
  const raw = String(value ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TimedMediaError("Invidious URL contains an invalid port.");
  }
  const host = (parsed.hostname || "").toLowerCase().replace(/\.$/, "");
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !host ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TimedMediaError(
      "Invidious URL must be a plain HTTP(S) origin without credentials.",
    );
  }
  if (parsed.protocol === "http:" && !isLocalHost(host)) {
    throw new TimedMediaError("A public Invidious instance must use HTTPS.");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function normalizeVideoLearningSettings(payload: unknown): Record<string, unknown> {
  const raw = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  const provider = String(raw.default_provider ?? "youtube").trim().toLowerCase();
  if (provider !== "youtube" && provider !== "invidious") {
    throw new TimedMediaError("Video learning provider must be 'youtube' or 'invidious'.");
  }
  const youtube = raw.youtube !== null && typeof raw.youtube === "object" && !Array.isArray(raw.youtube)
    ? (raw.youtube as Record<string, unknown>)
    : {};
  const transcriptProvider = String(youtube.transcript_provider ?? "youtube_transcript_api");
  if (transcriptProvider !== "youtube_transcript_api" && transcriptProvider !== "none") {
    throw new TimedMediaError("Unsupported YouTube transcript provider.");
  }
  const invidious = raw.invidious !== null && typeof raw.invidious === "object" && !Array.isArray(raw.invidious)
    ? (raw.invidious as Record<string, unknown>)
    : {};
  const apiBase = validateOrigin(invidious.api_base_url);
  const publicBase = validateOrigin(invidious.public_base_url);
  if (provider === "invidious" && !apiBase) {
    throw new TimedMediaError("Configure the Invidious API base URL before selecting it.");
  }
  return {
    version: 1,
    default_provider: provider,
    youtube: { transcript_provider: transcriptProvider },
    invidious: { api_base_url: apiBase, public_base_url: publicBase },
  };
}

export function videoLearningSettingsPath(settings?: Settings): string {
  const s = settings ?? get_settings();
  return join(s.data_dir, "settings", "video_learning.json");
}

export function loadVideoLearningSettings(settings?: Settings): Record<string, any> {
  const path = videoLearningSettingsPath(settings);
  if (!existsSync(path)) {
    return JSON.parse(JSON.stringify(DEFAULT_VIDEO_LEARNING_SETTINGS));
  }
  try {
    const payload = JSON.parse(readFileSync(path, "utf-8"));
    return normalizeVideoLearningSettings(payload);
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_VIDEO_LEARNING_SETTINGS));
  }
}

export function saveVideoLearningSettings(payload: unknown, settings?: Settings): Record<string, unknown> {
  const normalized = normalizeVideoLearningSettings(payload);
  const path = videoLearningSettingsPath(settings);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf-8");
    renameSync(tmp, path);
  } finally {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
  }
  return normalized;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function cleanTranscriptText(value: unknown): string {
  return decodeEntities(String(value ?? "")).replace(/\s+/g, " ").trim();
}

export function normalizeCues(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return [];
  const result: Array<Record<string, unknown>> = [];
  let totalBytes = 0;
  for (const row of rows.slice(0, MAX_TRANSCRIPT_CUES)) {
    const merged: Record<string, unknown> =
      row !== null && typeof row === "object" ? (row as Record<string, unknown>) : {};
    const text = cleanTranscriptText(merged.text ?? merged.content ?? "");
    if (!text) continue;
    const encoded = Buffer.byteLength(text, "utf-8");
    if (totalBytes + encoded > MAX_TRANSCRIPT_BYTES) break;
    let start = 0;
    let end = 0;
    try {
      start = Math.max(0, Number(merged.start ?? merged.from ?? 0) || 0);
      end = Number(merged.end ?? merged.to ?? 0) || 0;
      if (end <= start) end = start + Math.max(0, Number(merged.duration ?? 0) || 0);
    } catch {
      continue;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    result.push({ start, end: Math.max(start, end), text });
    totalBytes += encoded;
  }
  return result;
}

export function buildSegments(cues: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const segments: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;
  for (const cue of cues) {
    if (current === null) {
      current = { ...cue };
      continue;
    }
    const gap = Math.max(0, Number(cue.start ?? 0) - Number(current.end ?? 0));
    const length = Number(cue.end ?? 0) - Number(current.start ?? 0);
    const sentenceEnd = String(current.text ?? "").trimEnd().match(/[.!?。！？]$/) !== null;
    if (
      length < MAX_SEGMENT_SECONDS &&
      gap <= 4 &&
      !(length >= MIN_SEGMENT_SECONDS && sentenceEnd)
    ) {
      current.end = cue.end;
      current.text = `${current.text ?? ""} ${cue.text ?? ""}`.trim();
    } else {
      segments.push(current);
      current = { ...cue };
    }
  }
  if (current !== null) segments.push(current);
  segments.forEach((segment, i) => {
    segment.locator = i + 1;
  });
  return segments;
}

function vttTime(value: string): number {
  const parts = value.replace(",", ".").split(":");
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
  return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
}

export function parseWebvtt(text: string): Array<Record<string, unknown>> {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const result: Array<Record<string, unknown>> = [];
  let index = 0;
  while (index < lines.length) {
    const match = WEBVTT_TIMING_RE.exec(lines[index]);
    if (!match) {
      index += 1;
      continue;
    }
    index += 1;
    const bodyLines: string[] = [];
    while (index < lines.length) {
      const line = lines[index];
      if (WEBVTT_TIMING_RE.test(line)) break;
      if (!line.trim()) {
        index += 1;
        if (bodyLines.length) break;
        continue;
      }
      bodyLines.push(line);
      index += 1;
    }
    const body = bodyLines
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (body) {
      result.push({ start: vttTime(match[1]), end: vttTime(match[2]), text: body });
    }
  }
  return result;
}

// -- store -------------------------------------------------------------------

export class TimedMediaStore {
  readonly root: string;
  private readonly settings: Settings;

  constructor(root?: string, settings?: Settings) {
    this.settings = settings ?? get_settings();
    this.root = (root ?? join(this.settings.data_dir, "timed_media")).replace(/\/+$/, "");
    mkdirSync(this.root, { recursive: true });
  }

  private pathFor(materialId: string): string {
    if (!MATERIAL_ID_RE.test(materialId ?? "")) {
      throw new TimedMediaNotFound("Timed media material was not found.");
    }
    return join(this.root, `${materialId}.json`);
  }

  private load(materialId: string): Record<string, any> {
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(this.pathFor(materialId), "utf-8"));
    } catch {
      throw new TimedMediaNotFound("Timed media material was not found.");
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TimedMediaNotFound("Timed media material was not found.");
    }
    const obj = payload as Record<string, any>;
    if (obj.type !== "timed_media") {
      throw new TimedMediaNotFound("Timed media material was not found.");
    }
    return obj;
  }

  peek(materialId: string): Record<string, any> {
    return this.load(materialId);
  }

  private static repairTranscriptText(material: Record<string, any>): boolean {
    if (material._caption_text_version === 1) return false;
    const transcript = material.transcript;
    if (transcript === null || typeof transcript !== "object") return false;
    const fix = (rows: unknown) => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (row !== null && typeof row === "object" && typeof (row as Record<string, unknown>).text === "string") {
          const r = row as Record<string, unknown>;
          const text = cleanTranscriptText(r.text);
          if (text !== r.text) r.text = text;
        }
      }
    };
    fix(transcript.cues);
    fix(material.segments);
    material._caption_text_version = 1;
    return true;
  }

  get(materialId: string): Record<string, any> {
    const payload = this.load(materialId);
    if (!TimedMediaStore.repairTranscriptText(payload)) return payload;
    return this.save(payload);
  }

  save(material: Record<string, any>): Record<string, any> {
    const payload = { ...material };
    delete payload.playback;
    payload.updated_at = new Date().toISOString();
    const id = String(payload.material_id ?? "");
    const path = this.pathFor(id);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
      renameSync(tmp, path);
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    }
    return payload;
  }

  /** Upstream uses an flock per material; Node is single-threaded for these
   *  synchronous fs operations, so callers can invoke save() directly. */
  async withLock<T>(materialId: string, fn: () => T | Promise<T>): Promise<T> {
    if (!MATERIAL_ID_RE.test(materialId ?? "")) {
      throw new TimedMediaNotFound("Timed media material was not found.");
    }
    return await fn();
  }
}

let _store: TimedMediaStore | null = null;
export function getTimedMediaStore(settings?: Settings): TimedMediaStore {
  if (_store === null) _store = new TimedMediaStore(undefined, settings);
  return _store;
}

export function materialIdFor(videoId: string): string {
  return createHash("sha256").update(`youtube-resolve-${videoId}`, "utf8").digest("hex").slice(0, 32);
}

function languagePreferences(language: string | string[]): string[] {
  if (typeof language === "string") {
    return language ? [language] : ["zh-CN", "zh-Hans", "zh", "en"];
  }
  return language.map((v) => String(v).trim()).filter(Boolean);
}

// -- YouTube transcript -------------------------------------------------------
// Upstream uses the youtube_transcript_api package. The TS backend has no such
// dependency, so this is a best-effort implementation over YouTube's public
// timedtext endpoints; failures degrade to transcript status "unavailable".

interface TimedTextTrack {
  lang: string;
  kind: string;
  url: string;
}

async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Praxis/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function parseTrackList(xml: string): TimedTextTrack[] {
  const tracks: TimedTextTrack[] = [];
  const re = /<track\b[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0];
    const attr = (name: string) => {
      const am = new RegExp(`${name}="([^"]*)"`).exec(tag);
      return am ? decodeEntities(am[1]) : "";
    };
    tracks.push({ lang: attr("lang_code") || attr("lang"), kind: attr("kind"), url: attr("url") });
  }
  return tracks;
}

function pickTrack(tracks: TimedTextTrack[], language: string | string[]): TimedTextTrack | null {
  const priorities = languagePreferences(language);
  for (const preferred of priorities) {
    const found = tracks.find((t) => t.lang === preferred);
    if (found) return found;
  }
  // Base-language match (en vs en-US) then any manual track.
  for (const preferred of priorities) {
    const base = preferred.split("-")[0];
    const found = tracks.find((t) => t.lang === preferred || t.lang.split("-")[0] === base);
    if (found) return found;
  }
  return tracks.find((t) => t.kind !== "asr") ?? tracks[0] ?? null;
}

function parseSrv3(xml: string): Array<Record<string, unknown>> {
  const cues: Array<Record<string, unknown>> = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const start = /start="([\d.]+)"/.exec(attrs);
    const dur = /dur="([\d.]+)"/.exec(attrs);
    if (!start) continue;
    const s = Number(start[1]) / 1000;
    const d = dur ? Number(dur[1]) / 1000 : 0;
    const body = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (body) cues.push({ start: s, end: s + d, text: body });
  }
  return cues;
}

async function youtubeTranscript(
  videoId: string,
  language: string | string[],
): Promise<[Array<Record<string, unknown>>, string, string]> {
  const settings = loadVideoLearningSettings();
  if (settings.youtube?.transcript_provider === "none") return [[], "", "disabled"];
  try {
    const listXml = await fetchText(
      `https://video.google.com/timedtext?type=list&v=${encodeURIComponent(videoId)}`,
    );
    const tracks = parseTrackList(listXml);
    const track = pickTrack(tracks, language);
    if (!track) return [[], "", "unavailable"];
    const trackUrl = track.url
      ? (track.url.startsWith("http") ? track.url : `https://video.google.com${track.url}`)
      : `https://video.google.com/timedtext?lang=${encodeURIComponent(track.lang)}&v=${encodeURIComponent(videoId)}`;
    const sep = trackUrl.includes("?") ? "&" : "?";
    const xml = await fetchText(`${trackUrl}${sep}fmt=srv3`);
    const cues = normalizeCues(parseSrv3(xml));
    return [cues, track.lang, cues.length ? "youtube_transcript_api" : "unavailable"];
  } catch {
    return [[], "", "unavailable"];
  }
}

async function youtubeMetadata(request: YouTubeRequest): Promise<Record<string, unknown>> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(request.canonical_url)}&format=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Praxis/1.0)" },
    });
    if (res.status !== 200) return {};
    const payload: unknown = await res.json();
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function captionChoice(rows: unknown, language: string | string[]): Record<string, unknown> | null {
  const captions = Array.isArray(rows)
    ? rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
    : [];
  const priorities = languagePreferences(language);
  for (const preferred of priorities) {
    const found = captions.find(
      (row) => String(row.languageCode ?? row.language_code ?? "") === preferred,
    );
    if (found) return found;
  }
  return (
    captions.find((row) => !(row.autoGenerated ?? row.auto_generated)) ??
    captions[0] ??
    null
  );
}

async function invidiousMetadata(
  base: string,
  videoId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/api/v1/videos/${encodeURIComponent(videoId)}`, {
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (res.status >= 400) {
    throw new TimedMediaError(`Invidious request failed with HTTP ${res.status}.`);
  }
  let metadata: unknown;
  try {
    metadata = await res.json();
  } catch {
    throw new TimedMediaError("Invidious returned invalid video metadata.");
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TimedMediaError("Invidious returned invalid video metadata.");
  }
  return metadata as Record<string, unknown>;
}

async function invidiousTranscript(
  base: string,
  videoId: string,
  captions: unknown,
  language: string | string[],
  opts: { raiseOnFailure?: boolean } = {},
): Promise<[Array<Record<string, unknown>>, string, string]> {
  const caption = captionChoice(captions, language);
  if (!caption) return [[], "", "unavailable"];
  const label = String(caption.label ?? "");
  const priorities = languagePreferences(language);
  const fallbackLanguage = priorities[0] ?? "";
  const transcriptLanguage = String(
    caption.languageCode ?? caption.language_code ?? fallbackLanguage,
  );
  const url = `${base}/api/v1/captions/${encodeURIComponent(videoId)}${label ? `?label=${encodeURIComponent(label)}` : ""}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (res.status >= 400) {
    if (opts.raiseOnFailure) {
      throw new TimedMediaError(`Invidious captions request failed with HTTP ${res.status}.`);
    }
    return [[], transcriptLanguage, "unavailable"];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TRANSCRIPT_BYTES) {
    if (opts.raiseOnFailure) {
      throw new TimedMediaError("Invidious captions exceeded the safety limit.");
    }
    return [[], transcriptLanguage, "unavailable"];
  }
  const cues = normalizeCues(parseWebvtt(buf.toString("utf-8")));
  return [cues, transcriptLanguage, cues.length ? "invidious" : "unavailable"];
}

async function invidiousResolution(
  request: YouTubeRequest,
  language: string | string[],
): Promise<ProviderResolution> {
  const settings = loadVideoLearningSettings();
  const base = String(settings.invidious?.api_base_url ?? "");
  if (!base) throw new TimedMediaError("Invidious is not configured.");
  const metadata = await invidiousMetadata(base, request.video_id);
  const [cues, transcriptLanguage, transcriptSource] = await invidiousTranscript(
    base, request.video_id, metadata.captions, language,
  );
  const formats: Array<Record<string, unknown>> = [];
  for (const row of Array.isArray(metadata.formatStreams) ? metadata.formatStreams : []) {
    if (row === null || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const mime = String(r.type ?? "").split(";", 1)[0];
    const itag = String(r.itag ?? "");
    if (mime !== "video/mp4" || !/^[0-9]{1,6}$/.test(itag)) continue;
    formats.push({
      format_id: itag,
      mime_type: mime,
      quality: String(r.qualityLabel ?? r.quality ?? ""),
    });
  }
  if (!formats.length) {
    throw new TimedMediaError("Invidious returned no compatible MP4 stream.");
  }
  return {
    metadata,
    cues,
    transcript_language: transcriptLanguage,
    transcript_source: transcriptSource,
    formats,
  };
}

async function youtubeResolution(
  request: YouTubeRequest,
  language: string | string[],
): Promise<ProviderResolution> {
  const metadata = await youtubeMetadata(request);
  const [cues, transcriptLanguage, transcriptSource] = await youtubeTranscript(
    request.video_id, language,
  );
  return {
    metadata,
    cues,
    transcript_language: transcriptLanguage,
    transcript_source: transcriptSource,
    formats: [],
  };
}

const PROVIDER_RESOLVERS: Record<
  ProviderName,
  (request: YouTubeRequest, language: string | string[]) => Promise<ProviderResolution>
> = {
  youtube: youtubeResolution,
  invidious: invidiousResolution,
};

export { PROVIDER_RESOLVERS };

export async function resolveYoutubeCaptions(
  url: string,
  language: string | string[] = ["zh-CN", "zh-Hans", "zh", "en"],
): Promise<ProviderResolution> {
  const request = parseYoutubeUrl(url);
  const settings = loadVideoLearningSettings();
  if (settings.default_provider === "invidious") {
    const base = String(settings.invidious?.api_base_url ?? "");
    const metadata = await invidiousMetadata(base, request.video_id);
    const [cues, transcriptLanguage, transcriptSource] = await invidiousTranscript(
      base, request.video_id, metadata.captions, language,
    );
    return { metadata, cues, transcript_language: transcriptLanguage, transcript_source: transcriptSource, formats: [] };
  }
  return await youtubeResolution(request, language);
}

export async function resolveMaterial(
  url: string,
  language = "",
  providerOverride: ProviderName | null = null,
  settings?: Settings,
): Promise<Record<string, any>> {
  const request = parseYoutubeUrl(url);
  const s = settings ?? get_settings();
  const store = getTimedMediaStore(s);
  const mid = materialIdFor(request.video_id);
  const vSettings = loadVideoLearningSettings(s);
  const provider = providerOverride ?? String(vSettings.default_provider ?? "youtube") as ProviderName;
  const resolution = await PROVIDER_RESOLVERS[provider](request, language);
  const metadata = resolution.metadata;
  const cues = resolution.cues;
  const transcriptLanguage = resolution.transcript_language ?? "";
  const transcriptSource = resolution.transcript_source ?? "";
  const formats = resolution.formats ?? [];
  let existing: Record<string, any> = {};
  try {
    existing = store.get(mid);
  } catch (e) {
    if (!(e instanceof TimedMediaNotFound)) throw e;
  }
  const duration = Math.trunc(
    Number(metadata.lengthSeconds ?? (existing.metadata?.duration_seconds ?? 0)) || 0,
  );
  const learning: Record<string, any> =
    existing.learning !== null && typeof existing.learning === "object"
      ? { ...existing.learning }
      : { last_position: request.entry_time_seconds };
  if (learning.last_position === undefined) learning.last_position = request.entry_time_seconds;
  const material: Record<string, any> = {
    version: 1,
    type: "timed_media",
    material_id: mid,
    created_at: existing.created_at ?? new Date().toISOString(),
    source: {
      provider: "youtube",
      video_id: request.video_id,
      url: `https://youtu.be/${request.video_id}`,
      entry_time_seconds: request.entry_time_seconds,
    },
    metadata: {
      title: String(metadata.title ?? existing.metadata?.title ?? request.video_id),
      author: String(metadata.author_name ?? metadata.author ?? existing.metadata?.author ?? ""),
      duration_seconds: duration,
      thumbnail_url: String(metadata.thumbnail_url ?? ""),
    },
    transcript: {
      status: cues.length ? "ready" : "unavailable",
      reason: cues.length ? "" : transcriptSource,
      language: transcriptLanguage,
      source: transcriptSource,
      cues,
    },
    segments: buildSegments(cues),
    learning,
    provider_cache: formats.length ? { invidious_formats: formats } : {},
    _caption_text_version: 1,
  };
  let latest: Record<string, any> = {};
  try {
    latest = store.get(mid);
  } catch (e) {
    if (!(e instanceof TimedMediaNotFound)) throw e;
  }
  if (latest.learning !== null && typeof latest.learning === "object") {
    material.learning = latest.learning;
  }
  store.save(material);
  return publicMaterial(material, provider);
}

export async function materialWithPlayback(
  materialId: string,
  settings?: Settings,
): Promise<Record<string, any>> {
  const s = settings ?? get_settings();
  const store = getTimedMediaStore(s);
  let material = store.get(materialId);
  const vSettings = loadVideoLearningSettings(s);
  const provider = String(vSettings.default_provider ?? "youtube");
  if (
    provider === "invidious" &&
    !(material.provider_cache?.invidious_formats?.length)
  ) {
    const source = material.source !== null && typeof material.source === "object"
      ? (material.source as Record<string, unknown>)
      : {};
    const request = parseYoutubeUrl(String(source.url ?? ""));
    const resolution = await invidiousResolution(request, "");
    const metadata = resolution.metadata;
    const cues = resolution.cues;
    const transcriptLanguage = resolution.transcript_language ?? "";
    const formats = resolution.formats ?? [];
    material.metadata = {
      ...(material.metadata ?? {}),
      title: String(metadata.title ?? material.metadata?.title ?? request.video_id),
      author: String(metadata.author ?? material.metadata?.author ?? ""),
      duration_seconds: Math.trunc(
        Number(metadata.lengthSeconds ?? material.metadata?.duration_seconds ?? 0) || 0,
      ),
    };
    if (cues.length) {
      material.transcript = {
        status: "ready",
        reason: "",
        language: transcriptLanguage,
        source: "invidious",
        cues,
      };
      material.segments = buildSegments(cues);
    }
    material.provider_cache = { invidious_formats: formats };
    let latest: Record<string, any> = {};
    try {
      latest = store.get(materialId);
    } catch (e) {
      if (!(e instanceof TimedMediaNotFound)) throw e;
    }
    if (latest.learning !== null && typeof latest.learning === "object") {
      material.learning = latest.learning;
    }
    material = store.save(material);
  }
  return publicMaterial(material, provider);
}

export async function refreshInvidiousTranscript(
  materialId: string,
  settings?: Settings,
): Promise<Record<string, any>> {
  const s = settings ?? get_settings();
  const store = getTimedMediaStore(s);
  const material = store.get(materialId);
  const source = material.source !== null && typeof material.source === "object"
    ? (material.source as Record<string, unknown>)
    : {};
  const videoId = String(source.video_id ?? "");
  if (!VIDEO_ID_RE.test(videoId)) {
    throw new TimedMediaNotFound("Timed media material was not found.");
  }
  if (!material.provider_cache?.invidious_formats?.length) {
    throw new TimedMediaError("Invidious playback is not available for this material.");
  }
  const vSettings = loadVideoLearningSettings(s);
  const base = String(vSettings.invidious?.api_base_url ?? "");
  if (!base) throw new TimedMediaError("Invidious is not configured.");
  const transcript = material.transcript !== null && typeof material.transcript === "object"
    ? (material.transcript as Record<string, unknown>)
    : {};
  const language = String(transcript.language ?? "");
  const metadata = await invidiousMetadata(base, videoId);
  const [cues, transcriptLanguage, transcriptSource] = await invidiousTranscript(
    base, videoId, metadata.captions, language, { raiseOnFailure: true },
  );
  const refreshedTranscript = {
    status: cues.length ? "ready" : "unavailable",
    reason: cues.length ? "" : transcriptSource,
    language: transcriptLanguage,
    source: transcriptSource,
    cues,
  };
  const latest = store.get(materialId);
  latest.transcript = refreshedTranscript;
  latest.segments = buildSegments(cues);
  const saved = store.save(latest);
  return publicMaterial(saved, "invidious");
}

export function publicMaterial(material: Record<string, any>, provider: string): Record<string, any> {
  const payload: Record<string, any> = {};
  for (const [key, value] of Object.entries(material)) {
    if (key !== "provider_cache" && key !== "_caption_text_version") payload[key] = value;
  }
  const source = payload.source !== null && typeof payload.source === "object"
    ? (payload.source as Record<string, unknown>)
    : {};
  const learning = payload.learning !== null && typeof payload.learning === "object"
    ? (payload.learning as Record<string, unknown>)
    : {};
  const start = Number(learning.last_position ?? source.entry_time_seconds ?? 0) || 0;
  const videoId = String(source.video_id ?? "");
  if (provider === "invidious") {
    const formats = material.provider_cache?.invidious_formats ?? [];
    const best = formats[0] ?? {};
    const revision = String(material.updated_at ?? "");
    const subtitlesUrl = `/api/video-learning/materials/${payload.material_id}/subtitles.vtt` +
      (revision ? `?revision=${encodeURIComponent(revision)}` : "");
    const formatId = String(best.format_id ?? "");
    payload.playback = {
      provider: "invidious",
      kind: "html5",
      format_id: formatId,
      mime_type: String(best.mime_type ?? "video/mp4"),
      stream_url: `/api/video-learning/materials/${payload.material_id}/stream/${formatId}`,
      subtitles_url: subtitlesUrl,
      start_seconds: start,
    };
  } else {
    payload.playback = {
      provider: "youtube",
      kind: "youtube_iframe",
      video_id: videoId,
      start_seconds: start,
    };
  }
  return payload;
}

export async function testInvidiousConnection(
  settingsPayload?: unknown,
  settings?: Settings,
): Promise<{ ok: boolean; message: string }> {
  const payload = normalizeVideoLearningSettings(settingsPayload ?? loadVideoLearningSettings(settings));
  const inv = payload.invidious as Record<string, unknown>;
  const base = String(inv.api_base_url ?? "");
  if (!base) {
    return { ok: false, message: "Invidious API base URL is not configured." };
  }
  try {
    const res = await fetch(`${base}/api/v1/stats`, {
      signal: AbortSignal.timeout(8_000),
      redirect: "manual",
    });
    return { ok: res.status === 200, message: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// snake_case aliases mirroring the Python module surface.
export const parse_timestamp = parseTimestamp;
export const parse_youtube_url = parseYoutubeUrl;
export const normalize_cues = normalizeCues;
export const build_segments = buildSegments;
export const parse_webvtt = parseWebvtt;
export const get_timed_media_store = getTimedMediaStore;
export const load_video_learning_settings = loadVideoLearningSettings;
export const save_video_learning_settings = saveVideoLearningSettings;
export const material_with_playback = materialWithPlayback;
export const refresh_invidious_transcript = refreshInvidiousTranscript;
export const resolve_material = resolveMaterial;
export const test_invidious_connection = testInvidiousConnection;
export const public_material = publicMaterial;
