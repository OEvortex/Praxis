// Port of deeptutor/services/voice (config resolution + OpenAI-compatible and
// Edge adapters) used by api/routers/voice.py.
//
// TTS providers supported here:
//   * openai-compatible `/audio/speech` (bearer or api-key header auth) —
//     covers OpenAI, Groq, SiliconFlow, OpenRouter, Azure, local vLLM/LM Studio.
//   * edge — the local `msedge-tts` engine (same package narration.ts uses).
// STT providers: OpenAI-compatible `/audio/transcriptions` multipart, plus
// base64-JSON request style for OpenRouter-style endpoints. Audio is normalised
// to 16 kHz mono WAV via ffmpeg when available (browser webm/opus input).
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { get_settings } from "../../config.js";
import { load_catalog } from "../../provider-config.js";

const execFileAsync = promisify(execFile);
const MAX_INPUT_CHARS = 4096;

type AnyDict = Record<string, any>;

export class VoiceProviderError extends Error {}
export class VoiceProviderTimeout extends Error {}

// ---------------------------------------------------------------------------
// Catalog resolution (services.tts / services.stt active profile+model)
// ---------------------------------------------------------------------------

function activeProfileAndModel(service: string): {
  profile: AnyDict | null;
  model: AnyDict | null;
} {
  const catalog = load_catalog(get_settings());
  const svc = ((catalog["services"] as AnyDict) ?? {})[service] as AnyDict;
  if (!svc) return { profile: null, model: null };
  const profiles = Array.isArray(svc["profiles"]) ? svc["profiles"] : [];
  const profileId = svc["active_profile_id"];
  const profile =
    profiles.find((p: AnyDict) => p?.id === profileId) ?? profiles[0] ?? null;
  const models = Array.isArray(profile?.["models"]) ? profile["models"] : [];
  const modelId = svc["active_model_id"];
  const model =
    models.find((m: AnyDict) => m?.id === modelId) ?? models[0] ?? null;
  return { profile, model };
}

function asStr(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

const VOICE_PROVIDER_DEFAULTS: Record<string, { api_base: string; local?: boolean }> = {
  openai: { api_base: "https://api.openai.com/v1" },
  azure: { api_base: "" },
  groq: { api_base: "https://api.groq.com/openai/v1" },
  siliconflow: { api_base: "https://api.siliconflow.cn/v1" },
  openrouter: { api_base: "https://openrouter.ai/api/v1" },
  edge: { api_base: "", local: true },
  "edge-tts": { api_base: "", local: true },
};

function resolveVoiceConfig(service: "tts" | "stt"): AnyDict {
  const { profile, model } = activeProfileAndModel(service);
  const resolvedModel = asStr(model?.["model"]);
  if (!resolvedModel) {
    throw new VoiceProviderError(
      `No active ${service === "tts" ? "TTS" : "STT"} model is configured. Set it in Settings > Voice.`,
    );
  }
  const provider = asStr(profile?.["binding"]) || "openai";
  const defaults = VOICE_PROVIDER_DEFAULTS[provider] ?? { api_base: "" };
  const apiKey = asStr(profile?.["api_key"]);
  return {
    service,
    model: resolvedModel,
    provider,
    adapter: provider === "edge" || provider === "edge-tts" ? "edge" : "openai_compat",
    api_key: apiKey || (defaults.local ? "sk-no-key-required" : apiKey),
    base_url: asStr(profile?.["base_url"]) || defaults.api_base,
    voice: asStr(model?.["voice"]),
    response_format: asStr(model?.["response_format"]) || "mp3",
    speed: model?.["speed"] ?? null,
    language: asStr(model?.["language"]) || null,
    request_timeout: Number(model?.["request_timeout"] ?? (service === "tts" ? 60 : 120)) || (service === "tts" ? 60 : 120),
    model_entry: model ?? {},
    profile: profile ?? {},
  };
}

// ---------------------------------------------------------------------------
// msedge-tts (Edge read-aloud) — same lazy-require pattern as narration.ts
// ---------------------------------------------------------------------------

interface EdgeTtsInstance {
  setMetadata(voiceName: string, outputFormat: string): Promise<void>;
  toStream(input: string): { audioStream: NodeJS.ReadableStream; metadataStream: NodeJS.ReadableStream | null };
  close(): void;
}
interface EdgeTtsModule {
  MsEdgeTTS: new () => EdgeTtsInstance;
  OUTPUT_FORMAT: Record<string, string>;
}

function edgeTtsModule(): EdgeTtsModule {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("msedge-tts") as EdgeTtsModule;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readStream(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      (stream as { destroy?: () => void }).destroy?.();
      finish(() => reject(new VoiceProviderTimeout("TTS stream timed out")));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => finish(() => resolvePromise(Buffer.concat(chunks))));
    stream.on("close", () => finish(() => resolvePromise(Buffer.concat(chunks))));
    stream.on("error", (err) => finish(() => reject(err)));
  });
}

const EDGE_VOICE_FALLBACK = "en-US-AvaNeural";

async function edgeSpeak(text: string, voice: string, format: string): Promise<{ audio: Buffer; contentType: string }> {
  const mod = edgeTtsModule();
  const tts = new mod.MsEdgeTTS();
  const timeoutMs = 60_000;
  try {
    const outFormat =
      mod.OUTPUT_FORMAT?.[String(format).toUpperCase()] ??
      mod.OUTPUT_FORMAT?.AUDIO_24KHZ_48KBITRATE_MONO_MP3 ??
      "audio-24khz-48kbitrate-mono-mp3";
    await tts.setMetadata(voice || EDGE_VOICE_FALLBACK, outFormat);
    const { audioStream } = tts.toStream(escapeXml(text));
    const audio = await readStream(audioStream, timeoutMs);
    if (!audio.length) throw new VoiceProviderError("edge-tts returned no audio");
    const fmt = String(format || "mp3").toLowerCase();
    const contentType =
      fmt === "wav" ? "audio/wav" : fmt === "ogg" ? "audio/ogg" : "audio/mpeg";
    return { audio, contentType };
  } finally {
    tts.close();
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible TTS
// ---------------------------------------------------------------------------

const TTS_CONTENT_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  pcm: "audio/pcm",
};

async function openaiCompatSpeech(
  cfg: AnyDict,
  text: string,
  voice: string | null | undefined,
  responseFormat: string | null | undefined,
): Promise<{ audio: Buffer; contentType: string }> {
  const base = String(cfg.base_url ?? "").replace(/\/+$/, "");
  if (!base) throw new VoiceProviderError("TTS provider has no base URL configured");
  const fmt = String(responseFormat || cfg.response_format || "mp3");
  const body: Record<string, unknown> = {
    model: cfg.model,
    input: text,
    voice: voice || cfg.voice || "alloy",
    response_format: fmt,
  };
  if (cfg.speed != null && Number.isFinite(Number(cfg.speed))) {
    body.speed = Number(cfg.speed);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = String(cfg.api_key ?? "");
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const timeout = Math.min(Math.max(Number(cfg.request_timeout) || 60, 5), 600);
  const res = await fetch(`${base}/audio/speech`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout * 1000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    throw new VoiceProviderError(`TTS provider error (${res.status}): ${detail}`);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new VoiceProviderError("TTS provider returned no audio");
  const contentType =
    res.headers.get("content-type")?.split(";")[0]?.trim() ||
    TTS_CONTENT_TYPES[fmt] ||
    "application/octet-stream";
  return { audio, contentType };
}

// ---------------------------------------------------------------------------
// Audio helpers (WAV wrap + ffmpeg normalisation)
// ---------------------------------------------------------------------------

function u32le(view: DataView, off: number): number {
  return view.getUint32(off, true) >>> 0;
}

/** Wrap raw PCM16 bytes in a WAV container. */
export function pcm16ToWav(audio: Buffer, sampleRate: number, channels: number): Buffer {
  const dataSize = audio.length;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(dataSize, 40);
  audio.copy(out, 44);
  return out;
}

export function parsePcmContentType(contentType: string): { sampleRate: number; channels: number } | null {
  const [mediaType, ...params] = String(contentType || "").split(";");
  if (!["audio/pcm", "audio/x-pcm", "audio/l16"].includes(mediaType.trim().toLowerCase())) {
    return null;
  }
  let sampleRate = 24000;
  let channels = 1;
  for (const item of params) {
    const [key, ...rest] = item.split("=");
    const value = rest.join("=").trim().replace(/^"|"$/g, "");
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    const k = key.trim().toLowerCase();
    if (["rate", "sample-rate", "samplerate"].includes(k)) sampleRate = parsed;
    else if (["channels", "channel"].includes(k)) channels = parsed;
  }
  return { sampleRate, channels };
}

let ffmpegAvailable: Promise<boolean> | null = null;
function hasFfmpeg(): Promise<boolean> {
  ffmpegAvailable ??= execFileAsync("ffmpeg", ["-version"], { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  return ffmpegAvailable;
}

/** Normalise browser audio (webm/opus/wav/...) to 16 kHz mono PCM WAV. */
export async function normalizeWav(audio: Buffer): Promise<Buffer> {
  // Already 16 kHz mono 16-bit PCM WAV? Parse the fmt chunk.
  try {
    if (
      audio.length > 44 &&
      audio.toString("ascii", 0, 4) === "RIFF" &&
      audio.toString("ascii", 8, 12) === "WAVE"
    ) {
      const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
      let off = 12;
      let channels = 0;
      let bits = 0;
      let rate = 0;
      let audioFormat = 0;
      while (off + 8 <= audio.length) {
        const id = audio.toString("ascii", off, off + 4);
        const size = view.getUint32(off + 4, true);
        if (id === "fmt ") {
          audioFormat = view.getUint16(off + 8, true);
          channels = view.getUint16(off + 10, true);
          rate = view.getUint32(off + 12, true);
          bits = view.getUint16(off + 22, true);
        }
        off += 8 + size + (size % 2);
      }
      if (audioFormat === 1 && channels === 1 && bits === 16 && rate === 16000) {
        return audio;
      }
    }
  } catch {
    /* fall through to ffmpeg */
  }
  if (!(await hasFfmpeg())) {
    // Without ffmpeg we can only pass through WAV-ish input; try anyway and let
    // the provider decide.
    return audio;
  }
  const dir = await mkdtemp(join(tmpdir(), "deeptutor-voice-"));
  const source = join(dir, "input");
  const target = join(dir, "output.wav");
  try {
    await writeFile(source, audio);
    await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-i", source, "-vn",
       "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", target],
      { timeout: 60_000 },
    );
    return await readFile(target);
  } catch (exc) {
    throw new VoiceProviderError(
      `Audio conversion failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Public API — synthesize_speech / transcribe_audio
// ---------------------------------------------------------------------------

export async function synthesizeSpeech(
  text: string,
  opts: { voice?: string | null; responseFormat?: string | null; catalog?: unknown } = {},
): Promise<{ audio: Buffer; contentType: string }> {
  const input = String(text ?? "").trim();
  if (!input) throw new VoiceProviderError("Text is required.");
  if (input.length > MAX_INPUT_CHARS) {
    throw new VoiceProviderError(`Text exceeds the ${MAX_INPUT_CHARS}-character limit.`);
  }
  let cfg: AnyDict;
  try {
    cfg = resolveVoiceConfig("tts");
  } catch (exc) {
    // No catalog TTS configured — fall back to the local Edge engine, which is
    // what the video-lesson narration path already does.
    try {
      return await edgeSpeak(input, opts.voice || EDGE_VOICE_FALLBACK, opts.responseFormat || "mp3");
    } catch {
      throw exc instanceof VoiceProviderError ? exc : new VoiceProviderError(String(exc));
    }
  }
  if (cfg.adapter === "edge") {
    // Edge voice names look like "en-US-AvaNeural"; catalog model id may be the
    // voice itself or a friendly alias.
    const voice = opts.voice || asStr(cfg.voice) || asStr(cfg.model) || EDGE_VOICE_FALLBACK;
    return edgeSpeak(input, voice, opts.responseFormat || cfg.response_format);
  }
  return openaiCompatSpeech(cfg, input, opts.voice, opts.responseFormat);
}

export async function transcribeAudio(
  audio: Buffer,
  opts: { filename?: string; contentType?: string; language?: string | null } = {},
): Promise<string> {
  const cfg = resolveVoiceConfig("stt");
  const normalized = await normalizeWav(audio);
  const base = String(cfg.base_url ?? "").replace(/\/+$/, "");
  if (!base) throw new VoiceProviderError("STT provider has no base URL configured");
  const key = String(cfg.api_key ?? "");
  const timeout = Math.min(Math.max(Number(cfg.request_timeout) || 120, 5), 600);
  const requestStyle =
    asStr(cfg.profile?.["request_style"]) ||
    (cfg.provider === "openrouter" ? "base64_json" : "multipart");

  let res: Response;
  if (requestStyle === "base64_json") {
    const format = extToAudioFormat(opts.filename || "audio.webm");
    res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        input_audio: { data: normalized.toString("base64"), format },
        ...(opts.language || cfg.language ? { language: opts.language || cfg.language } : {}),
      }),
      signal: AbortSignal.timeout(timeout * 1000),
    });
  } else {
    const form = new FormData();
    const ext = extFromName(opts.filename || "audio.webm", opts.contentType);
    form.append("file", new Blob([new Uint8Array(normalized)], { type: "audio/wav" }), `audio.${ext}`);
    form.append("model", String(cfg.model));
    const language = opts.language || cfg.language;
    if (language) form.append("language", String(language));
    form.append("response_format", "json");
    res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: AbortSignal.timeout(timeout * 1000),
    });
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    throw new VoiceProviderError(`STT provider error (${res.status}): ${detail}`);
  }
  const payload = (await res.json().catch(() => ({}))) as AnyDict;
  const text = asStr(payload["text"]);
  if (!text) throw new VoiceProviderError("STT provider returned no transcript");
  return text;
}

function extFromName(filename: string, contentType?: string): string {
  const m = String(filename).toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  if (m) return m[1] === "jpeg" ? "jpg" : m[1];
  const ct = String(contentType || "");
  if (ct.includes("wav")) return "wav";
  if (ct.includes("mp4") || ct.includes("m4a")) return "m4a";
  if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
  if (ct.includes("ogg")) return "ogg";
  if (ct.includes("webm")) return "webm";
  return "webm";
}

function extToAudioFormat(filename: string): string {
  const ext = extFromName(filename);
  return ext === "jpg" ? "webm" : ext;
}

export const synthesize_speech = synthesizeSpeech;
export const transcribe_audio = transcribeAudio;
export const pcm_to_wav = pcm16ToWav;
