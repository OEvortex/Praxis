// voice-over for video
// lessons: time each scene's captions, and speak them when a TTS engine is
// available.
//
// TTS fallback chain (first engine that produces audio wins):
//   1. `msedge-tts` — npm port of the Python `edge-tts` package; streams mp3
//      audio plus sentence-boundary metadata from the Edge read-aloud service.
//   2. System TTS CLIs detected at runtime: espeak-ng/espeak, flite,
//      text2wave (festival), pico2wave, `say` (macOS). These emit WAV.
//   3. If every engine fails, `narrate` falls back to `estimate` — silent
//      captions timed from an estimated speaking rate, exactly as before.
//
// Every engine attempt is best-effort and time-bounded; nothing here may crash
// the lesson pipeline.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FPS = 30;
export const VOICE = "en-US-AvaNeural";
const SPEAK_TIMEOUT_S = 60;
const CHARS_PER_SECOND = 15.0; // English speech runs about 2.5 words per second
const MP3_BYTES_PER_SECOND = 48_000 / 8; // edge-tts streams 24 kHz, 48 kbit/s mono mp3
const TICKS_PER_SECOND = 10_000_000; // edge-tts boundary offsets are in 100 ns units
const PARALLEL = 4;
const SENTENCE_END = /(?<=[.;!?])\s+|(?<=[!?])/;

export interface NarrationLine {
  id: string;
  text: string;
}

export interface Clip {
  text: string;
  frames: number;
  captions: [number, string][];
  audio?: Uint8Array;
  /** MIME type for the `data:` URI emitted by `voiceModule` (default audio/mpeg). */
  mime?: string;
  /** Name of the TTS engine that produced `audio` (e.g. "edge-tts", "espeak-ng"). */
  engine?: string;
}

export function estimate(text: string): Clip {
  /** Silent clip: captions spaced by an average speaking rate. */
  const rate = CHARS_PER_SECOND;
  let at = 0.0;
  const captions: [number, string][] = [];
  for (const raw of text.split(SENTENCE_END)) {
    const sentence = raw.trim();
    if (sentence) {
      captions.push([Math.round(at * FPS), sentence]);
      at += sentence.length / rate;
    }
  }
  return {
    text,
    frames: Math.max(1, Math.ceil(at * FPS)),
    captions: captions.length ? captions : [[0, text]],
  };
}

// ---------------------------------------------------------------------------
// Engine 1: msedge-tts (Edge read-aloud, same protocol as Python edge-tts)
// ---------------------------------------------------------------------------

// Minimal structural typing for the `msedge-tts` CommonJS module — we require
// it lazily so a missing/broken install degrades to the next engine.
interface EdgeTtsInstance {
  setMetadata(
    voiceName: string,
    outputFormat: string,
    metadataOptions?: {
      sentenceBoundaryEnabled?: boolean;
      wordBoundaryEnabled?: boolean;
    },
  ): Promise<void>;
  toStream(input: string): {
    audioStream: Readable;
    metadataStream: Readable | null;
  };
  close(): void;
}
interface EdgeTtsModule {
  MsEdgeTTS: new () => EdgeTtsInstance;
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: string };
}

function edgeTtsModule(): EdgeTtsModule {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("msedge-tts") as EdgeTtsModule;
}

function edgeTtsAvailable(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve("msedge-tts");
    return true;
  } catch {
    return false;
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface SynthResult {
  audio: Uint8Array;
  mime: string;
  /** SentenceBoundary captions as [frame, text]; empty when unavailable. */
  captions: [number, string][];
}

/** Read a stream to a single Buffer; resolves on 'end' or 'close', whichever first. */
function readStream(stream: Readable, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish(() => reject(new Error("tts stream timed out")));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => finish(() => resolvePromise(Buffer.concat(chunks))));
    stream.on("close", () =>
      finish(() => resolvePromise(Buffer.concat(chunks))),
    );
    stream.on("error", (err) => finish(() => reject(err)));
  });
}

/** Collect SentenceBoundary captions from the msedge-tts metadata stream. */
async function readCaptions(
  stream: Readable,
  timeoutMs: number,
): Promise<[number, string][]> {
  const raw = await readStream(stream, timeoutMs);
  const captions: [number, string][] = [];
  for (const line of raw.toString("utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        Metadata?: {
          Type?: string;
          Data?: { Offset?: string; text?: { Text?: string } };
        }[];
      };
      for (const meta of parsed.Metadata ?? []) {
        if (meta.Type !== "SentenceBoundary") continue;
        const offset = Number(meta.Data?.Offset ?? 0);
        const text = meta.Data?.text?.Text;
        if (!Number.isFinite(offset) || text == null) continue;
        captions.push([
          Math.round((offset / TICKS_PER_SECOND) * FPS),
          unescapeXml(text),
        ]);
      }
    } catch {
      // malformed metadata chunk — skip it, audio still counts
    }
  }
  return captions;
}

async function edgeTtsSpeak(text: string, voice: string): Promise<SynthResult> {
  const mod = edgeTtsModule(); // throws when the package is absent
  const tts = new mod.MsEdgeTTS();
  try {
    const attempt = (async (): Promise<SynthResult> => {
      await tts.setMetadata(
        voice,
        mod.OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3,
        { sentenceBoundaryEnabled: true },
      );
      // toStream embeds the input in an SSML template without escaping — do it.
      const { audioStream, metadataStream } = tts.toStream(escapeXml(text));
      const timeoutMs = SPEAK_TIMEOUT_S * 1000;
      const audioP = readStream(audioStream, timeoutMs);
      const captionsP = metadataStream
        ? readCaptions(metadataStream, timeoutMs)
        : Promise.resolve([] as [number, string][]);
      const [audio, captions] = await Promise.all([audioP, captionsP]);
      if (!audio.length) {
        throw new Error("edge-tts returned no audio");
      }
      return { audio: new Uint8Array(audio), mime: "audio/mpeg", captions };
    })();
    // If the outer timeout wins, keep the abandoned attempt from surfacing as
    // an unhandled rejection once tts.close() tears the streams down.
    attempt.catch(() => {});
    return await withTimeout(attempt, SPEAK_TIMEOUT_S * 1000);
  } finally {
    tts.close();
  }
}

// ---------------------------------------------------------------------------
// Engine 2: system TTS CLIs (espeak-ng, flite, text2wave, pico2wave, say)
// ---------------------------------------------------------------------------

interface SystemEngine {
  name: string;
  cmd: string;
  args: (text: string, outPath: string, voice: string) => string[];
  /** Text is piped to stdin instead of passed as an argument. */
  stdin?: boolean;
  /** Platform gate; undefined means all platforms. */
  platform?: NodeJS.Platform;
}

/** Map an Edge voice name ("en-US-AvaNeural") to a lang tag for pico2wave etc. */
function voiceLang(voice: string): string {
  return voice.split("-").slice(0, 2).join("-");
}

/** Map to an espeak-style voice id ("en-us"). */
function espeakVoice(voice: string): string {
  const parts = voice.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1].toLowerCase()}` : "en";
}

const SYSTEM_ENGINES: SystemEngine[] = [
  {
    name: "espeak-ng",
    cmd: "espeak-ng",
    args: (t, o, v) => ["-v", espeakVoice(v), "-s", "170", "-w", o, t],
  },
  {
    name: "espeak",
    cmd: "espeak",
    args: (t, o, v) => ["-v", espeakVoice(v), "-s", "170", "-w", o, t],
  },
  {
    name: "flite",
    cmd: "flite",
    args: (t, o) => ["-t", t, "-o", o],
  },
  {
    name: "text2wave",
    cmd: "text2wave",
    args: (_t, o) => ["-o", o],
    stdin: true,
  },
  {
    name: "pico2wave",
    cmd: "pico2wave",
    args: (t, o, v) => [`--wav=${o}`, `--lang=${voiceLang(v)}`, t],
  },
  {
    name: "say",
    cmd: "say",
    args: (t, o) => ["-o", o, "--data-format=LEI16@22050", t],
    platform: "darwin",
  },
];

function runProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs: number },
): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`${cmd} exited ${code}: ${stderr.slice(0, 200).trim()}`),
        );
    });
    if (opts.input != null) {
      child.stdin?.write(opts.input);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ["--version"], { timeout: 5000 });
    return true;
  } catch (exc) {
    // ENOENT → not installed. Any other failure (bad flag, non-zero exit,
    // timeout) still means the binary exists; synthesis will decide.
    const code = (exc as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }
}

async function systemTtsSpeak(
  engine: SystemEngine,
  text: string,
  voice: string,
): Promise<SynthResult> {
  const dir = await mkdtemp(join(tmpdir(), "narration-"));
  const outPath = join(dir, "speech.wav");
  try {
    const args = engine.args(text, outPath, voice);
    await runProcess(engine.cmd, args, {
      input: engine.stdin ? text : undefined,
      timeoutMs: SPEAK_TIMEOUT_S * 1000,
    });
    const audio = new Uint8Array(await readFile(outPath));
    if (!audio.length) {
      throw new Error(`${engine.name} produced no audio`);
    }
    return { audio, mime: "audio/wav", captions: [] };
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Engine registry
// ---------------------------------------------------------------------------

interface TtsEngine {
  name: string;
  synthesize(text: string, voice: string): Promise<SynthResult>;
}

let enginesPromise: Promise<TtsEngine[]> | null = null;

function detectEngines(): Promise<TtsEngine[]> {
  enginesPromise ??= (async () => {
    const engines: TtsEngine[] = [];
    if (edgeTtsAvailable()) {
      engines.push({ name: "edge-tts", synthesize: edgeTtsSpeak });
    }
    for (const se of SYSTEM_ENGINES) {
      if (se.platform && process.platform !== se.platform) continue;
      if (await commandExists(se.cmd)) {
        engines.push({
          name: se.name,
          synthesize: (text, voice) => systemTtsSpeak(se, text, voice),
        });
      }
    }
    return engines;
  })();
  return enginesPromise;
}

// ---------------------------------------------------------------------------
// Duration probing
// ---------------------------------------------------------------------------

function u32le(b: Uint8Array, off: number): number {
  return (
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>>
    0
  );
}

function ascii(b: Uint8Array, off: number, len: number): string {
  return String.fromCharCode(...b.subarray(off, off + len));
}

/** Duration of a PCM WAV from its RIFF chunks; null when unparseable. */
function wavDurationSeconds(audio: Uint8Array): number | null {
  if (audio.length < 44 || ascii(audio, 0, 4) !== "RIFF") return null;
  if (ascii(audio, 8, 4) !== "WAVE") return null;
  let off = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (off + 8 <= audio.length) {
    const id = ascii(audio, off, 4);
    const size = u32le(audio, off + 4);
    const body = off + 8;
    if (id === "fmt " && body + 12 <= audio.length) {
      byteRate = u32le(audio, body + 8);
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    off = body + size + (size % 2);
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
}

let ffprobePromise: Promise<boolean> | null = null;
function hasFfprobe(): Promise<boolean> {
  ffprobePromise ??= execFileAsync("ffprobe", ["-version"], { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  return ffprobePromise;
}

interface ProbeResult {
  seconds: number;
  mime?: string;
}

/** Honest duration via ffprobe; returns null when unavailable/failing. */
async function ffprobeAudio(
  audio: Uint8Array,
  ext: string,
): Promise<ProbeResult | null> {
  if (!(await hasFfprobe())) return null;
  const dir = await mkdtemp(join(tmpdir(), "narration-probe-"));
  const file = join(dir, `audio.${ext}`);
  try {
    await writeFile(file, audio);
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=format_name,duration",
        "-of",
        "json",
        file,
      ],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      format?: { format_name?: string; duration?: string };
    };
    const seconds = Number(parsed.format?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const fmt = parsed.format?.format_name ?? "";
    let mime: string | undefined;
    if (fmt.includes("wav")) mime = "audio/wav";
    else if (fmt.includes("mp3")) mime = "audio/mpeg";
    else if (fmt.includes("ogg")) mime = "audio/ogg";
    else if (fmt.includes("webm")) mime = "audio/webm";
    else if (fmt.includes("aiff") || fmt.includes("aif")) mime = "audio/aiff";
    return { seconds, mime };
  } catch {
    return null;
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Resolve clip duration in seconds: header parse → ffprobe → bitrate estimate. */
async function audioSeconds(audio: Uint8Array, mime: string): Promise<number> {
  if (mime === "audio/wav") {
    const wav = wavDurationSeconds(audio);
    if (wav != null) return wav;
  }
  const probed = await ffprobeAudio(audio, mime === "audio/wav" ? "wav" : "mp3");
  if (probed) return probed.seconds;
  // Last resort: edge-tts mp3 is CBR 48 kbit/s; WAV 16-bit mono ~32 kB/s.
  const bytesPerSecond =
    mime === "audio/wav" ? 32_000 : MP3_BYTES_PER_SECOND;
  return audio.length / bytesPerSecond;
}

// ---------------------------------------------------------------------------
// speak / narrate
// ---------------------------------------------------------------------------

function scaledCaptions(text: string, frames: number): [number, string][] {
  /** Sentence captions from `estimate`, rescaled to the real clip length. */
  const est = estimate(text);
  if (!est.captions.length || est.frames <= 0) return [[0, text]];
  const ratio = frames / est.frames;
  return est.captions.map(([at, cap]) => [
    Math.max(0, Math.min(frames - 1, Math.round(at * ratio))),
    cap,
  ]);
}

export async function speak(text: string, voice: string): Promise<Clip> {
  /** Try each detected engine in order; throw only when all of them fail. */
  const engines = await detectEngines();
  let lastErr: unknown = new Error("no TTS engine available");
  for (const engine of engines) {
    try {
      const result = await engine.synthesize(text, voice);
      if (!result.audio.length) {
        throw new Error(`${engine.name} returned no audio`);
      }
      const seconds = await audioSeconds(result.audio, result.mime);
      const frames = Math.max(1, Math.ceil(seconds * FPS));
      return {
        text,
        frames,
        captions: result.captions.length
          ? result.captions
          : scaledCaptions(text, frames),
        audio: result.audio,
        mime: result.mime,
        engine: engine.name,
      };
    } catch (exc) {
      lastErr = exc;
      console.warn(`video lesson narration: ${engine.name} failed: ${exc}`);
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr));
}

class Semaphore {
  private permits: number;
  private queue: (() => void)[] = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolvePromise) => this.queue.push(resolvePromise));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.permits++;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function narrate(
  lines: NarrationLine[],
  cache?: Map<string, Clip>,
): Promise<Map<string, Clip>> {
  /** Time every line; `cache` keeps clips across retries of the same lesson. */
  const clips = cache ?? new Map<string, Clip>();
  const voiced = (await detectEngines()).length > 0;
  const gate = new Semaphore(PARALLEL);

  const one = async (text: string): Promise<Clip> => {
    let clip = clips.get(text);
    if (!clip) {
      let spoken: Clip | null = null;
      if (voiced) {
        try {
          spoken = await gate.run(() =>
            withTimeout(speak(text, VOICE), SPEAK_TIMEOUT_S * 1000),
          );
        } catch (exc) {
          // best effort; captions remain
          console.warn(`video lesson narration failed: ${exc}`);
        }
      }
      clip = spoken ?? estimate(text);
      clips.set(text, clip);
    }
    return clip;
  };

  const results = await Promise.all(lines.map((line) => one(line.text)));
  const out = new Map<string, Clip>();
  lines.forEach((line, i) => out.set(line.id, results[i]));
  return out;
}

export function voiceModule(clips: Map<string, Clip>): string {
  /** The `voice.ts` the kit imports: text, length, captions and inline audio per scene. */
  const data: Record<string, unknown> = {};
  for (const [key, clip] of clips) {
    const entry: Record<string, unknown> = {
      text: clip.text,
      frames: clip.frames,
      captions: clip.captions.map(([at, text]) => ({ at, text })),
    };
    if (clip.audio && clip.audio.length) {
      const mime = clip.mime ?? "audio/mpeg";
      entry.src =
        `data:${mime};base64,` + Buffer.from(clip.audio).toString("base64");
    }
    data[key] = entry;
  }
  return "export const VOICE = " + JSON.stringify(data) + ";\n";
}

// Python __all__ parity: Clip, NarrationLine, VOICE, estimate, narrate, speak, voice_module.
