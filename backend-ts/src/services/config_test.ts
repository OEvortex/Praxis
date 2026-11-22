// Port of backend/app/services/config_test.py — live configuration diagnostics
// for the Settings "Test this model" action. The settings editor sends a
// *draft* catalog; this resolves the addressed profile/model (including
// `provider_ref` connections), performs a small bounded completion against the
// provider, and streams progress events back to the browser over SSE.
//
// Depends on src/provider-config.ts (port of app/provider_config.py).
// `_find_profile` / `_find_connection` / `_vtx_provider_slug` are private in
// that module, so faithful local copies live below.
// The vtx `context_length_manager` lookup is served by the vendored
// models.dev table in src/model-metadata.ts (via provider-config's
// `vtx_model_metadata`); its last-resort UI default is 200000.
import { randomBytes } from "node:crypto";
import { builtin_preset, preset_api_key, SERVICES, vtx_model_metadata } from "../provider-config.js";
import { cleanThinkingTags } from "./llm_text.js";

const PROBE_SYSTEM = "This is a connection test. Respond briefly.";
const PROBE_PROMPT = "Reply with OK.";
// vtx's own last-resort UI default (vtx.core.config agent.default_context_window).
const VTX_DEFAULT_CONTEXT_WINDOW = 200_000;

function redact(value: string): string {
  if (!value) return "(empty)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function headers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v != null) out[String(k)] = String(v);
  }
  return out;
}

function asInt(value: unknown): number {
  const n = parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

type Catalog = Record<string, unknown>;

export interface TestRun {
  id: string;
  service: string;
  status: string; // "running" | "completed" | "failed"
  events: Array<Record<string, unknown>>;
  cancelled: boolean;
  emit(kind: string, message: string, extra?: Record<string, unknown>): void;
  snapshot(start: number): Array<Record<string, unknown>>;
  isTerminal(): boolean;
}

function makeTestRun(id: string, service: string): TestRun {
  const run: TestRun = {
    id,
    service,
    status: "running",
    events: [],
    cancelled: false,
    emit(kind, message, extra = {}) {
      run.events.push({ type: kind, message, timestamp: Date.now() / 1000, ...extra });
    },
    snapshot(start) {
      return run.events.slice(start);
    },
    isTerminal() {
      return run.status === "completed" || run.status === "failed";
    },
  };
  return run;
}

export interface ResolvedDraftConfig {
  provider: string;
  binding: string;
  wire_model: string;
  base_url: string;
  api_key: string;
  api_format: unknown;
  api_version: string;
  extra_headers: Record<string, string>;
  reasoning_effort: string | null;
  context_window: number;
  profile_name: string;
  [k: string]: unknown;
}

/** In-memory registry of diagnostic runs (one per `start` call). */
export class ConfigTestRunner {
  private static instance: ConfigTestRunner | null = null;
  private runs = new Map<string, TestRun>();

  static getInstance(): ConfigTestRunner {
    if (!ConfigTestRunner.instance) ConfigTestRunner.instance = new ConfigTestRunner();
    return ConfigTestRunner.instance;
  }

  start(service: string, catalog: Catalog): TestRun {
    const run = makeTestRun(`${service}-${randomBytes(5).toString("hex")}`, service);
    this.runs.set(run.id, run);
    // Python spawned a daemon thread running asyncio.run(...); here the probe
    // is just an async task — fire and forget, errors are captured in events.
    void this.runAsync(run, catalog);
    return run;
  }

  get(runId: string): TestRun | null {
    return this.runs.get(runId) ?? null;
  }

  cancel(runId: string): boolean {
    const run = this.get(runId);
    if (!run) return false;
    run.cancelled = true;
    return true;
  }

  private async runAsync(run: TestRun, catalog: Catalog): Promise<void> {
    try {
      const resolved = resolveDraftConfig(catalog, run.service);
      run.emit("info", "Preparing configuration snapshot.");
      run.emit("config", "Using active profile.", {
        profile: {
          name: resolved.profile_name ?? "",
          base_url: resolved.base_url ?? "",
          binding: resolved.binding ?? "",
          api_key: redact(String(resolved.api_key ?? "")),
        },
        model: resolved.wire_model,
      });
      run.emit("info", `Resolved model \`${resolved.wire_model}\`.`);
      run.emit("info", `Request target: ${resolved.base_url}`);

      if (run.service === "llm" || run.service === "task") {
        await this.testText(run, resolved);
      } else {
        throw new Error(`Model tests are not available for service '${run.service}' yet.`);
      }
      if (!run.cancelled && run.status === "running") {
        run.status = "completed";
        run.emit("completed", `${run.service.toUpperCase()} test completed successfully.`);
      }
    } catch (exc) {
      // surfaced to the UI as a `failed` SSE event
      run.status = "failed";
      run.emit("failed", exc instanceof Error ? exc.message || exc.name : String(exc));
    }
  }

  private async testText(run: TestRun, resolved: ResolvedDraftConfig): Promise<void> {
    const maxTokens = run.service === "task" ? 32 : 64;
    run.emit("info", "Sending a short completion probe.");
    const reply = await completeWithConfig(resolved, {
      system: PROBE_SYSTEM,
      prompt: PROBE_PROMPT,
      max_tokens: maxTokens,
      cancelled: () => run.cancelled,
    });
    const snippet = (reply ?? "").trim();
    run.emit("response", "Received model response.", { snippet: snippet.slice(0, 400) });
    if (!snippet) throw new Error("Model returned an empty response.");
    if (run.service !== "llm" || run.cancelled) return;

    run.emit("info", "Checking the model's context window.");
    const detection = contextWindowFor(resolved);
    run.emit(
      "context_window",
      detection.source === "default"
        ? `Context capacity unknown; conservative budget ${detection.context_window} tokens.`
        : `Detected context window ${detection.context_window} tokens (${detection.source}).`,
      {
        context_window: detection.context_window,
        source: detection.source,
        detail: detection.detail,
        detected_at: detection.detected_at,
      },
    );
    run.emit(
      "info",
      "Context window detection is read-only here; nothing was written to your settings.",
    );
  }
}

export function getConfigTestRunner(): ConfigTestRunner {
  return ConfigTestRunner.getInstance();
}

export const get_config_test_runner = getConfigTestRunner;

// -- draft catalog resolution -------------------------------------------------

// LOCAL PORT of provider_config._find_profile (private there).
function findProfile(catalog: Catalog, profileId: string): Record<string, unknown> | null {
  const services = asRecord(catalog.services);
  for (const service of SERVICES as unknown as string[]) {
    const svc = asRecord(services[service]);
    for (const profile of (svc.profiles as unknown[]) ?? []) {
      const rec = asRecord(profile);
      if (rec.id === profileId) return rec;
    }
  }
  return null;
}

// LOCAL PORT of provider_config._find_connection (private there).
function findConnection(catalog: Catalog, connectionId: unknown): Record<string, unknown> | null {
  if (!connectionId) return null;
  for (const conn of (catalog.connections as unknown[]) ?? []) {
    const rec = asRecord(conn);
    if (rec.id === connectionId) return rec;
  }
  return null;
}

// LOCAL PORT of provider_config._vtx_provider_slug (private there).
const ANTHROPIC_SLUGS = new Set(["anthropic", "aerolink"]);
const RESPONSES_SLUGS = new Set(["openai-responses", "codex", "openai-codex"]);
function vtxProviderSlug(provider: string, apiFormat: unknown): string {
  const slug = (provider ?? "").trim() || "openai";
  const fmt = String(apiFormat ?? "auto").trim().toLowerCase();
  if (fmt === "anthropic" && !ANTHROPIC_SLUGS.has(slug)) return "anthropic";
  if (fmt === "openai_responses" && !RESPONSES_SLUGS.has(slug)) return "openai-responses";
  return slug;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstStr(...values: unknown[]): string {
  for (const v of values) {
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

/**
 * Resolve the profile/model the settings editor is currently configuring.
 * Unlike `resolveRuntimeModel` (which reads the saved selection), this works
 * from the supplied draft so unsaved edits are tested.
 */
export function resolveDraftConfig(catalog: Catalog, service: string): ResolvedDraftConfig {
  const services = asRecord(catalog.services);
  const bucket = asRecord(services[service]);
  const savedSelection = asRecord(catalog.llm_selection);

  let profileId = String(bucket.active_profile_id ?? "");
  let modelId = String(bucket.active_model_id ?? "");
  if (service === "llm") {
    profileId = profileId || String(savedSelection.profile_id ?? "");
    modelId = modelId || String(savedSelection.model_id ?? "");
  }

  const profile = profileId
    ? ((findProfile(catalog, profileId) as Record<string, unknown> | null) ?? null)
    : null;
  let modelEntry: Record<string, unknown> = {};
  if (profile) {
    for (const item of (profile.models as unknown[]) ?? []) {
      const rec = asRecord(item);
      if (String(rec.id) === modelId) {
        modelEntry = rec;
        break;
      }
    }
  }

  let conn = profile
    ? ((findConnection(catalog, profile.connection_id) as Record<string, unknown> | null) ?? null)
    : null;
  conn =
    conn ??
    ((findConnection(catalog, asRecord(modelEntry.provider_ref).connection_id) as Record<string, unknown> | null) ?? null);
  // Python: ref = model_entry.provider_ref or profile.provider_ref or {}
  // (first non-empty wins).
  const refRaw =
    (modelEntry.provider_ref && typeof modelEntry.provider_ref === "object" && Object.keys(modelEntry.provider_ref as object).length
      ? modelEntry.provider_ref
      : profile?.provider_ref) ?? {};
  const refObj = asRecord(refRaw);

  const binding = firstStr(
    asRecord(profile).binding,
    asRecord(profile).provider,
    conn?.provider,
    refObj.binding,
    "openai",
  );
  const preset = (builtin_preset(binding) as Record<string, unknown> | null) ?? {};

  const baseUrl = firstStr(
    asRecord(profile).base_url,
    conn?.base_url,
    refObj.default_base_url,
    preset.base_url,
  );
  let apiKey = firstStr(asRecord(profile).api_key, conn?.api_key);
  if (!apiKey) apiKey = String(preset_api_key(binding) ?? "").trim();
  const apiFormat =
    asRecord(profile).api_format ?? conn?.api_format ?? preset.api_format;
  const apiVersion = firstStr(asRecord(profile).api_version, conn?.api_version);

  const extraHeaders: Record<string, string> = {
    ...headers(preset.headers),
    ...headers(conn?.extra_headers),
    ...headers(asRecord(profile).extra_headers),
  };

  const wireModel = firstStr(modelEntry.model, modelEntry.name, modelId);
  if (!wireModel) throw new Error("No model is selected for this test.");

  return {
    provider: vtxProviderSlug(binding, apiFormat == null ? null : String(apiFormat)),
    binding,
    wire_model: wireModel,
    base_url: baseUrl,
    api_key: apiKey,
    api_format: apiFormat ?? null,
    api_version: apiVersion,
    extra_headers: extraHeaders,
    reasoning_effort:
      firstStr(modelEntry.reasoning_effort, asRecord(profile).reasoning_effort) || null,
    context_window: asInt(modelEntry.context_window_tokens ?? modelEntry.context_window),
    profile_name: firstStr(asRecord(profile).name),
  };
}

// -- provider call -----------------------------------------------------------

function requestParts(
  config: Record<string, unknown>,
  args: { system: string; prompt: string; max_tokens: number },
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const base = String(config.base_url ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("This model has no base URL configured.");
  if (!base.toLowerCase().startsWith("http://") && !base.toLowerCase().startsWith("https://")) {
    throw new Error(`Unsupported base URL: ${base}`);
  }

  const requestHeaders: Record<string, string> = { "Content-Type": "application/json" };
  const key = String(config.api_key ?? "");
  const provider = String(config.provider ?? "");
  Object.assign(requestHeaders, headers(config.extra_headers));

  if (provider === "anthropic") {
    const body: Record<string, unknown> = {
      model: config.wire_model,
      max_tokens: args.max_tokens,
      messages: [{ role: "user", content: args.prompt }],
    };
    if (args.system) body.system = args.system;
    if (key) requestHeaders["x-api-key"] = key;
    requestHeaders["anthropic-version"] ??= "2023-06-01";
    return { url: `${base}/messages`, headers: requestHeaders, body };
  }

  if (key) requestHeaders["Authorization"] = `Bearer ${key}`;
  if (provider === "openai-responses") {
    const body: Record<string, unknown> = {
      model: config.wire_model,
      input: [
        ...(args.system ? [{ role: "system", content: args.system }] : []),
        { role: "user", content: args.prompt },
      ],
      max_output_tokens: args.max_tokens,
    };
    return { url: `${base}/responses`, headers: requestHeaders, body };
  }

  const messages: Array<Record<string, string>> = [];
  if (args.system) messages.push({ role: "system", content: args.system });
  messages.push({ role: "user", content: args.prompt });
  const body: Record<string, unknown> = {
    model: config.wire_model,
    messages,
    max_tokens: args.max_tokens,
    temperature: 0.1,
  };
  if (config.reasoning_effort) body.reasoning_effort = config.reasoning_effort;
  return { url: `${base}/chat/completions`, headers: requestHeaders, body };
}

function responseText(data: unknown, provider: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const obj = data as Record<string, unknown>;
  if (provider === "anthropic") {
    const parts = (obj.content ?? []) as unknown[];
    return parts
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
      .filter((p) => p.type === "text")
      .map((p) => String(p.text ?? ""))
      .join("");
  }
  if (provider === "openai-responses") {
    const text = obj.output_text;
    if (typeof text === "string" && text) return text;
    const parts: string[] = [];
    for (const item of (obj.output ?? []) as unknown[]) {
      const contents =
        item && typeof item === "object" && !Array.isArray(item)
          ? ((item as Record<string, unknown>).content ?? [])
          : [];
      for (const content of contents as unknown[]) {
        if (
          content &&
          typeof content === "object" &&
          typeof (content as Record<string, unknown>).text === "string"
        ) {
          parts.push((content as Record<string, string>).text);
        }
      }
    }
    return parts.join("");
  }
  const choices = (obj.choices ?? []) as unknown[];
  if (choices.length && choices[0] && typeof choices[0] === "object") {
    const message = ((choices[0] as Record<string, unknown>).message ?? {}) as Record<string, unknown>;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .map((p) => String(p.text ?? ""))
        .join("");
    }
  }
  return "";
}

/** Send one bounded, non-streaming completion and return its text. */
export async function completeWithConfig(
  config: Record<string, unknown>,
  args: {
    system: string;
    prompt: string;
    max_tokens?: number;
    cancelled?: (() => boolean) | null;
  },
): Promise<string> {
  const { url, headers: reqHeaders, body } = requestParts(config, {
    system: args.system,
    prompt: args.prompt,
    max_tokens: args.max_tokens ?? 64,
  });
  if (args.cancelled?.()) throw new Error("Test cancelled.");
  const response = await fetch(url, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300).replace(/\n/g, " ");
    throw new Error(`Provider returned HTTP ${response.status}: ${detail}`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Provider returned an invalid JSON response.");
  }
  return cleanThinkingTags(responseText(data, String(config.provider ?? "")));
}

export interface ContextWindowDetection {
  context_window: number;
  source: string;
  detail: string;
  detected_at: number;
}

/** Report a context window from draft metadata, vtx metadata, or a default. */
export function contextWindowFor(config: Record<string, unknown>): ContextWindowDetection {
  let window = asInt(config.context_window);
  let detail = "";
  let source = "catalog";
  if (!window) {
    // vtx's context_length_manager resolves limits from models.dev metadata;
    // the TS backend serves the same table via vtx_model_metadata.
    const metaWindow = asInt(vtx_model_metadata(String(config.wire_model ?? ""))?.context_window);
    if (metaWindow) {
      window = metaWindow;
      source = "metadata";
      detail = "Resolved from models.dev model metadata.";
    } else {
      detail = "No models.dev metadata for this model.";
    }
  }
  if (!window) {
    source = "default";
    window = VTX_DEFAULT_CONTEXT_WINDOW;
    detail = detail || "No declared context window; using the vtx default.";
  }
  return {
    context_window: window,
    source,
    detail,
    detected_at: Date.now() / 1000,
  };
}
