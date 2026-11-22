import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import type { Settings } from "../../config.js";
import { get_settings as getSettings } from "../../config.js";
import { isRecord, loadCatalog, loadDraft, restoreCatalogSecrets, type Json } from "./store.js";

const SERVICES = ["llm", "task", "embedding", "search", "tts", "stt", "imagegen", "videogen"];
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function rec(v: unknown): Json { return isRecord(v) ? v : {}; }
function findProfile(catalog: Json, service: string, profileId: string): Json | null {
  const profiles = arr(rec(rec(catalog.services)[service]).profiles);
  return profiles.find((p) => rec(p).id === profileId) as Json | null;
}
function findModel(profile: Json, modelId: string | null): Json | null {
  return arr(profile.models).find((m) => rec(m).id === modelId) as Json | null;
}
function selected(catalog: Json, service: string, profileId: string, modelId: string | null): Json {
  const bucket = rec(rec(catalog.services)[service]);
  const profile = findProfile(catalog, service, profileId);
  if (!profile || (service !== "search" && modelId && !findModel(profile, modelId))) throw new Error("The selected service configuration no longer exists.");
  return { ...catalog, services: { ...rec(catalog.services), [service]: { ...bucket, active_profile_id: profileId, active_model_id: modelId } } };
}
function resolveTts(catalog: Json): Json {
  const svc = rec(rec(catalog.services).tts);
  const profile = findProfile(catalog, "tts", String(svc.active_profile_id ?? ""));
  const model = profile ? findModel(profile, String(svc.active_model_id ?? "")) : null;
  const conn = profile?.connection_id ? arr(catalog.connections).map(rec).find((c) => c.id === profile.connection_id) : null;
  const provider = String(profile?.binding ?? profile?.provider ?? conn?.provider ?? "openai");
  return {
    provider, model: String(model?.model ?? model?.name ?? svc.active_model_id ?? ""),
    voice: String(model?.voice ?? profile?.voice ?? "alloy"),
    base_url: String(profile?.base_url ?? conn?.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
    api_key: String(profile?.api_key ?? conn?.api_key ?? ""),
    format: String(model?.response_format ?? profile?.response_format ?? "mp3"),
    speed: model?.speed ?? profile?.speed ?? null,
    language: model?.language ?? profile?.language ?? null,
    extra_headers: rec(profile?.extra_headers ?? conn?.extra_headers),
  };
}
export async function discoverVoices(settings: Settings, payload: Json): Promise<Json> {
  const live = loadCatalog(settings);
  const draft = loadDraft(settings);
  const source = isRecord(draft.catalog) ? restoreCatalogSecrets(draft.catalog, live) : live;
  const catalog = restoreCatalogSecrets(rec(payload.catalog), source);
  const chosen = selected(catalog, "tts", String(payload.profile_id ?? ""), payload.model_id == null ? null : String(payload.model_id));
  const cfg = resolveTts(chosen);
  if (cfg.provider === "edge") {
    try {
      const tts = new MsEdgeTTS();
      const voices = await tts.getVoices();
      tts.close();
      return { status: "ready", scope: "public", voices: voices.map((v) => ({ id: v.ShortName, label: v.FriendlyName || v.ShortName, languages: [v.Locale] })) };
    } catch {
      return { status: "error", voices: [], scope: "none" };
    }
  }
  if (cfg.provider !== "minimax" && cfg.provider !== "dashscope") return { status: "unsupported", voices: [], scope: "none" };
  if (!cfg.api_key || cfg.api_key === "***") throw new Error("Enter provider credentials before fetching voices.");
  const base = String(cfg.base_url).replace(/\/+$/, "");
  let url: string;
  if (cfg.provider === "minimax") {
    url = `${base.replace(/\/t2a_v2$/i, "")}/get_voice`;
  } else {
    const suffixes = [
      "/services/aigc/multimodal-generation/generation",
      "/services/audio/tts/SpeechSynthesizer",
      "/compatible-mode/v1",
    ];
    let trimmed = base;
    for (const suffix of suffixes) {
      if (trimmed.toLowerCase().endsWith(suffix.toLowerCase())) trimmed = trimmed.slice(0, -suffix.length);
    }
    url = `${trimmed}/services/audio/tts/customization`;
  }
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` }, body: JSON.stringify(cfg.provider === "minimax" ? { voice_type: "all" } : { model: "voice-enrollment", input: { action: "list_voice", page_index: 0, page_size: 100 } }), signal: AbortSignal.timeout(25000) });
    if (!res.ok) return { status: "error", voices: [], scope: "none" };
    const data = await res.json() as Json;
    const voices: Json[] = [];
    if (cfg.provider === "minimax") {
      for (const group of ["system_voice", "voice_cloning", "voice_generation"]) for (const row of arr(data[group])) { const r = rec(row); if (r.voice_id) voices.push({ id: r.voice_id, label: r.voice_name || r.voice_id }); }
    } else {
      for (const row of arr(rec(data.output).voice_list)) { const r = rec(row); const id = r.voice_id ?? r.voice; if (typeof id === "string") voices.push({ id, label: id, ...(typeof r.language === "string" ? { languages: [r.language] } : {}) }); }
    }
    return { status: "ready", scope: cfg.provider === "minimax" ? "account" : "custom", voices };
  } catch {
    return { status: "error", voices: [], scope: "none" };
  }
}
export async function synthesizePreview(settings: Settings, payload: Json): Promise<{ audio: Uint8Array; contentType: string }> {
  const text = String(payload.text ?? "").trim();
  if (!text || text.length > 500) throw new Error("Enter between 1 and 500 characters of preview text.");
  const live = loadCatalog(settings);
  const draft = loadDraft(settings);
  const source = isRecord(draft.catalog) ? restoreCatalogSecrets(draft.catalog, live) : live;
  const catalog = restoreCatalogSecrets(rec(payload.catalog), source);
  const chosen = selected(catalog, "tts", String(payload.profile_id ?? ""), payload.model_id == null ? null : String(payload.model_id));
  const cfg = resolveTts(chosen);
  if (cfg.api_key === "***") throw new Error("Saved speech credentials were not found. Enter them again.");
  if (cfg.provider === "edge") {
    const dir = mkdtempSync(join(tmpdir(), "praxis-tts-"));
    try {
      const tts = new MsEdgeTTS({ connectionTimeoutMs: 10000, synthesisTimeoutMs: 60000 });
      await tts.setMetadata(String(cfg.voice || "en-US-AriaNeural"), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const out = await tts.toFile(dir, text);
      tts.close();
      return { audio: readFileSync(out.audioFilePath), contentType: "audio/mpeg" };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(rec(cfg.extra_headers) as Record<string, string>) };
  if (cfg.api_key) headers.Authorization = `Bearer ${cfg.api_key}`;
  const res = await fetch(`${cfg.base_url}/audio/speech`, { method: "POST", headers, body: JSON.stringify({ model: cfg.model, input: text, voice: cfg.voice || "alloy", response_format: cfg.format || "mp3", ...(cfg.speed ? { speed: cfg.speed } : {}), ...(cfg.language ? { language: cfg.language } : {}) }), signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    const err = new Error(`Provider returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return { audio: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") || `audio/${cfg.format || "mpeg"}` };
}
export function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}
