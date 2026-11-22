import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Settings } from "../../config.js";
import { get_settings as getSettings } from "../../config.js";
import { backgroundJobManager, mineruCliProbe, pythonImport, resolveDoclingDownloader, resolveMineruDownloader, which } from "./jobs.js";
import { loadDocumentParsing, loadMineru, saveDocumentParsing, isRecord, type Json } from "./store.js";

const ENGINE_META: Record<string, Json> = {
  text_only: { name: "Text-only", description: "Built-in plain text extraction. No optional parser package or model download.", needs_local_models: false },
  mineru: { name: "MinerU", description: "High-fidelity multimodal parsing via local CLI or hosted cloud API.", needs_local_models: true },
  docling: { name: "Docling", description: "Structured conversion locally or against Docling Serve.", needs_local_models: true },
  markitdown: { name: "markitdown", description: "Microsoft MarkItDown format conversion with optional VLM image descriptions.", needs_local_models: false },
  pymupdf4llm: { name: "PyMuPDF4LLM", description: "CPU-only PDF conversion with optional image extraction.", needs_local_models: false },
  liteparse: { name: "LiteParse", description: "Rust-backed parsing for PDF and office formats.", needs_local_models: false },
  tika: { name: "Tika", description: "Remote Apache Tika 4 server for broad content detection.", needs_local_models: false },
};
const normalizeEngine = (name: string) => name.trim().toLowerCase().replace(/[- ]/g, "_");
const str = (v: unknown, fallback = "") => String(v ?? fallback).trim();
const bool = (v: unknown, fallback = false) => (typeof v === "boolean" ? v : fallback);

function mineruEngine(settings: Settings): Json {
  const full = loadDocumentParsing(settings);
  return { ...loadMineru(settings), ...((full.engines as Json)?.mineru as Json ?? {}) };
}
function engineSlice(settings: Settings, name: string): Json {
  const full = loadDocumentParsing(settings);
  return isRecord((full.engines as Json)?.[name]) ? ((full.engines as Json)[name] as Json) : {};
}
function hasToken(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => str(x));
  return Boolean(str(v));
}
export function localCliProbe(configuredPath = "") {
  return mineruCliProbe(configuredPath);
}
export function listEngines(settings: Settings = getSettings()): Json[] {
  return Object.entries(ENGINE_META).map(([id, meta]) => ({ ...meta, id, available: isEngineAvailable(settings, id) }));
}
export function isEngineAvailable(settings: Settings, name: string): boolean {
  const id = normalizeEngine(name);
  if (id === "text_only") return true;
  if (id === "mineru") return mineruCliProbe(engineSlice(settings, "mineru").local_cli_path as string).found || hasToken(engineSlice(settings, "mineru").api_token);
  if (id === "docling") return engineSlice(settings, "docling").mode === "remote" || pythonImport("docling");
  if (id === "markitdown") return pythonImport("markitdown");
  if (id === "pymupdf4llm") return pythonImport("pymupdf4llm");
  if (id === "liteparse") return pythonImport("liteparse");
  if (id === "tika") return Boolean(str(engineSlice(settings, "tika").server_url));
  return false;
}
function readinessFor(settings: Settings, id: string): Json {
  if (id === "text_only") return { ready: true, reason: "configuration_verified", message: "Ready to parse." };
  if (id === "mineru") {
    const cfg = mineruEngine(settings);
    if (cfg.mode === "cloud") return hasToken(cfg.api_token) ? { ready: true, reason: "configuration_verified", message: "MinerU cloud credentials are configured." } : { ready: false, reason: "not_configured", message: "Add a MinerU API token or switch to local mode." };
    const probe = mineruCliProbe(str(cfg.local_cli_path));
    return probe.found ? { ready: true, reason: "configuration_verified", message: `MinerU CLI detected: ${probe.command}.` } : { ready: false, reason: "cli_missing", message: "MinerU CLI not found; install MinerU or use cloud mode." };
  }
  if (id === "tika") {
    const url = str(engineSlice(settings, "tika").server_url);
    return url ? { ready: true, reason: "configuration_verified", message: "Tika server URL is configured." } : { ready: false, reason: "not_configured", message: "Set a Tika server URL." };
  }
  if (id === "docling") {
    const cfg = engineSlice(settings, "docling");
    if (cfg.mode === "remote") return str(cfg.api_base_url) ? { ready: true, reason: "configuration_verified", message: "Docling remote server is configured." } : { ready: false, reason: "not_configured", message: "Set a Docling server URL." };
    return pythonImport("docling") ? { ready: true, reason: "configuration_verified", message: "Docling package is available." } : { ready: false, reason: "package_missing", message: "Install the Docling parser package or use remote mode." };
  }
  const module = { markitdown: "markitdown", pymupdf4llm: "pymupdf4llm", liteparse: "liteparse" }[id];
  if (module) return pythonImport(module) ? { ready: true, reason: "configuration_verified", message: "Parser package is available." } : { ready: false, reason: "package_missing", message: "Install the optional parser package." };
  return { ready: false, reason: "unknown", message: "Unknown parser." };
}
export function documentParsingPayload(settings: Settings = getSettings()): Json {
  const full = loadDocumentParsing(settings);
  const engines = isRecord(full.engines) ? full.engines : {};
  const redacted: Json = {};
  for (const [name, slice] of Object.entries(engines)) {
    const clean = { ...(slice as Json) };
    delete clean.api_token;
    redacted[name] = clean;
  }
  const readiness: Json = {};
  for (const engine of listEngines(settings)) readiness[String(engine.id)] = readinessFor(settings, String(engine.id));
  const mineru = isRecord(engines.mineru) ? engines.mineru : {};
  const docling = isRecord(engines.docling) ? engines.docling : {};
  return {
    engine: full.engine,
    image_caption: bool(full.image_caption),
    image_description_model: full.image_description_model ?? null,
    engines: redacted,
    available_engines: listEngines(settings),
    readiness,
    installable: ["docling", "markitdown", "pymupdf4llm", "liteparse"],
    model_downloadable: ["docling"],
    mineru: { api_token_set: hasToken(mineru.api_token), local_cli: localCliProbe(str(mineru.local_cli_path)) },
    docling: { api_token_set: hasToken(docling.api_token) },
  };
}
export function mineruPayload(settings: Settings = getSettings()): Json {
  const cfg = loadMineru(settings);
  const publicCfg = { ...cfg };
  delete publicCfg.api_token;
  return { settings: publicCfg, api_token_set: hasToken(cfg.api_token), local_cli: localCliProbe(str(cfg.local_cli_path)) };
}
function normalizeToken(token: unknown): string | string[] {
  if (Array.isArray(token)) return token.map((v) => str(v)).filter(Boolean);
  return str(token);
}
export function updateMineru(settings: Settings, body: Json): Json {
  const current = loadMineru(settings);
  const token = body.api_token === undefined || body.api_token === null ? current.api_token : normalizeToken(body.api_token);
  const next = {
    mode: body.mode === "cloud" ? "cloud" : "local",
    api_base_url: str(body.api_base_url, "https://mineru.net") || "https://mineru.net",
    api_token: token,
    local_cli_path: str(body.local_cli_path),
    model_download_source: body.model_download_source === "modelscope" ? "modelscope" : "huggingface",
    model_download_endpoint: str(body.model_download_endpoint),
    model_version: body.model_version === "vlm" ? "vlm" : "pipeline",
    language: str(body.language, "auto") || "auto",
    enable_formula: bool(body.enable_formula, true),
    enable_table: bool(body.enable_table, true),
    is_ocr: bool(body.is_ocr),
    max_pages_per_part: current.max_pages_per_part ?? 180,
    normalize_tiny_scans: current.normalize_tiny_scans ?? false,
    allow_local_model_download: bool(body.allow_local_model_download),
  };
  return mineruPayloadAfter(settings, next);
}
function mineruPayloadAfter(settings: Settings, cfg: Json): Json {
  const full = loadDocumentParsing(settings);
  const engines = { ...(full.engines as Json) };
  engines.mineru = { ...MINERU_DEFAULT_FOR_UPDATE, ...cfg };
  const saved = loadDocumentParsing(settings);
  // Save through the document-parsing writer so legacy /mineru state stays a slice.
  saveDocumentParsing(settings, { ...saved, engines });
  return mineruPayload(settings);
}
const MINERU_DEFAULT_FOR_UPDATE = {
  mode: "local", api_base_url: "https://mineru.net", api_token: "", local_cli_path: "",
  model_download_source: "huggingface", model_download_endpoint: "", model_version: "pipeline",
  language: "auto", enable_formula: true, enable_table: true, is_ocr: false,
  max_pages_per_part: 180, normalize_tiny_scans: false, allow_local_model_download: false,
};
export function updateDocumentParsing(settings: Settings, body: Json): Json {
  const full = loadDocumentParsing(settings);
  const engines = { ...(full.engines as Json) };
  const updates = isRecord(body.engines) ? body.engines : {};
  for (const [name, updateRaw] of Object.entries(updates)) {
    if (!(name in engines) || !isRecord(updateRaw)) continue;
    const merged = { ...(updateRaw as Json) };
    const existing = engines[name] as Json;
    if ("api_token" in existing && merged.api_token === null) delete merged.api_token;
    engines[name] = { ...existing, ...merged };
  }
  const imageModel = "image_description_model" in body ? body.image_description_model : full.image_description_model;
  const saved = loadDocumentParsing(settings);
  saveDocumentParsing(settings, { ...saved, engine: str(body.engine) || saved.engine, image_caption: body.image_caption === undefined ? saved.image_caption : bool(body.image_caption), image_description_model: imageModel ?? null, engines });
  return documentParsingPayload(settings);
}
export async function testDocumentParsing(settings: Settings, engineName?: string): Promise<Json> {
  const engine = normalizeEngine(engineName || String(loadDocumentParsing(settings).engine || ""));
  if (!isEngineAvailable(settings, engine)) return { ok: false, message: `The '${engine}' parsing engine isn't installed.` };
  try {
    const readiness = readinessFor(settings, engine);
    if (engine === "docling" && readiness.ready) {
      const verified = await verifyDocling(engineSlice(settings, "docling"));
      if (verified) return { ok: verified.ok, message: verified.message };
    }
    if (engine === "tika" && readiness.ready) {
      const verified = await verifyTika(engineSlice(settings, "tika"));
      if (verified) return { ok: verified.ok, message: verified.message };
    }
    return { ok: Boolean(readiness.ready), message: String(readiness.message || (readiness.ready ? "Ready to parse." : "Not ready.")) };
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : String(exc) };
  }
}
async function fetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 8000): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 500) };
  } catch (exc) {
    return { ok: false, status: 0, text: exc instanceof Error ? exc.message : String(exc) };
  }
}
export async function verifyDocling(cfg: Json): Promise<{ ok: boolean; message: string } | null> {
  if (cfg.mode !== "remote") return null;
  const base = str(cfg.api_base_url, "http://localhost:5001").replace(/\/+$/, "") || "http://localhost:5001";
  const headers: Record<string, string> = {};
  const token = str(cfg.api_token);
  if (token) headers["X-Api-Key"] = token;
  const health = await fetchText(`${base}/health`, headers);
  const version = await fetchText(`${base}/version`, headers);
  if (!health.ok || !version.ok) return { ok: false, message: `Docling server request failed (${health.status || version.status}).` };
  return { ok: true, message: `${health.text || "reachable"} · ${version.text || "reachable"}` };
}
export async function verifyTika(cfg: Json): Promise<{ ok: boolean; message: string } | null> {
  const base = str(cfg.server_url, "http://localhost:9998").replace(/\/+$/, "") || "http://localhost:9998";
  const res = await fetchText(`${base}/version`);
  if (!res.ok) return { ok: false, message: `Tika server request failed (${res.status || res.text}).` };
  return { ok: true, message: res.text || "reachable" };
}
export async function verifyMineruCloud(settings: Settings, body: Json): Promise<Json> {
  const stored = loadMineru(settings);
  const token = body.api_token === undefined || body.api_token === null ? stored.api_token : normalizeToken(body.api_token);
  const keys = Array.isArray(token) ? token.map((t) => str(t)).filter(Boolean) : [str(token)].filter(Boolean);
  if (!keys.length) return { ok: false, message: "No API token configured." };
  const base = str(body.api_base_url, "https://mineru.net").replace(/\/+$/, "") || "https://mineru.net";
  try {
    const res = await fetch(`${base}/api/v4/file-urls/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${keys[0]}` },
      body: JSON.stringify({ files: [{ name: "connectivity-check.pdf", is_ocr: false }], model_version: body.model_version ?? "pipeline", enable_formula: body.enable_formula ?? true, enable_table: body.enable_table ?? true, ...(body.language && body.language !== "auto" ? { language: body.language } : {}) }),
      signal: AbortSignal.timeout(30000),
    });
    const payload = await res.json().catch(() => ({}));
    const code = (payload as Json)?.code;
    if (!res.ok || (code !== undefined && ![0, "0", "", "success", "ok"].includes(code))) return { ok: false, message: `MinerU API rejected the token (HTTP ${res.status}).` };
    return { ok: true, message: "MinerU API token is valid." };
  } catch (exc) {
    return { ok: false, message: exc instanceof Error ? exc.message : String(exc) };
  }
}
export async function testMineru(settings: Settings, body: Json): Promise<Json> {
  if ((body.mode ?? loadMineru(settings).mode) === "local") {
    const path = str(body.local_cli_path, str(loadMineru(settings).local_cli_path));
    const probe = mineruCliProbe(path);
    if (!probe.found) {
      return probe.source === "configured"
        ? { ok: false, message: `Configured CLI path is not an executable file: ${probe.path}. Fix the path or clear it to auto-detect from PATH.` }
        : { ok: false, message: "MinerU CLI not found on the server PATH. Install current MinerU, set an explicit CLI path, or switch to cloud mode." };
    }
    const target = probe.source === "configured" ? probe.path : probe.command;
    const versionProbe = await new Promise<string>((resolve) => {
      const p = spawn(target, ["--version"], { timeout: 60000 });
      let out = "";
      p.stdout?.on("data", (d) => { out += String(d); });
      p.stderr?.on("data", (d) => { out += String(d); });
      p.on("close", () => resolve(out.split(/\r?\n/).find((x) => x.trim()) ?? ""));
      p.on("error", () => resolve(""));
    });
    const version = versionProbe.trim();
    const current = /([0-9]+\.[0-9]+\.[0-9]+)/.exec(version)?.[1];
    const [major, minor, patch] = (current ?? "0.0.0").split(".").map(Number);
    const ok = major > 3 || (major === 3 && (minor > 4 || (minor === 4 && patch >= 5)));
    return ok ? { ok: true, message: `Local MinerU CLI detected: ${probe.command} (${version || "unknown"})` } : { ok: false, message: `Local MinerU CLI reported ${version || "an unknown version"}. DeepTutor needs MinerU >= 3.4.5.` };
  }
  return verifyMineruCloud(settings, body);
}
export function startDocumentParsingInstall(engineName: string): Json {
  const engine = normalizeEngine(engineName);
  const specs: Record<string, string[]> = {
    docling: ["docling"],
    markitdown: ["markitdown[all]"],
    pymupdf4llm: ["pymupdf4llm"],
    liteparse: ["llama-index-readers-litem[all]"],
  };
  const spec = specs[engine];
  if (!spec) return { ok: false, message: `No installable package for engine '${engine}'.` };
  return { ok: false, message: `Live package installation is disabled. Stop DeepTutor, install ${spec.join(", ")} in the server environment, then restart. Docker deployments should add the corresponding parser extra and recreate the service.` };
}
export function startDocumentParsingModelDownload(engineName: string): Json {
  const engine = normalizeEngine(engineName);
  if (engine !== "docling") return { ok: false, message: `No model download for engine '${engine}'.` };
  const cmd = resolveDoclingDownloader();
  if (!cmd) return { ok: false, message: "The docling model downloader wasn't found. Reinstall the engine so docling-tools is on PATH." };
  return backgroundJobManager.start("models", engine, cmd);
}
export function startMineruModelDownload(settings: Settings, body: Json): Json {
  const resolved = resolveMineruDownloader(str(body.local_cli_path, str(loadMineru(settings).local_cli_path)));
  if (!resolved.found) return { ok: false, message: resolved.path ? `mineru-models-download not found next to the configured CLI (expected ${resolved.path}).` : "mineru-models-download not found on the server PATH. Install current MinerU first or set the CLI path." };
  const args = [resolved.path, "download", "--model-type", body.model_type === "vlm" || body.model_type === "all" ? String(body.model_type) : "pipeline"];
  if (body.source === "modelscope") args.push("--source", "modelscope");
  if (str(body.endpoint)) args.push("--endpoint", str(body.endpoint));
  return backgroundJobManager.start("models", "mineru", args);
}
export { backgroundJobManager, which };
