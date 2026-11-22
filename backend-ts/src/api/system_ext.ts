// system endpoints not already in
// handlers.ts: /api/system/memory, /api/system/test/{llm,embeddings,search}
// and the self-update surface (/api/system/update*).
import { Hono } from "hono";
import type { Context } from "hono";
import { get_settings } from "../config.js";
import { load_catalog } from "../provider-config.js";
import { completeText } from "../services/llm_text.js";
import {
  detect_installation,
  get_update_job_store,
  get_version_check_service,
  jobPayload,
  launcher_available,
  load_system_settings,
  running_under_systemd_service,
  save_system_settings,
  storedJob,
  SYSTEMD_UPDATE_REASON,
  updatePayload,
  VersionCheckService,
} from "../services/system/update.js";
import type { VersionCheckResult } from "../services/system/update.js";

export const systemExtRouter = new Hono();

type AnyDict = Record<string, any>;

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

async function body(c: Context): Promise<AnyDict> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as AnyDict)
      : {};
  } catch {
    return {};
  }
}

function testResponse(
  success: boolean,
  message: string,
  opts: { model?: string | null; response_time_ms?: number | null; error?: string | null } = {},
) {
  return {
    success,
    message,
    model: opts.model ?? null,
    response_time_ms: opts.response_time_ms ?? null,
    error: opts.error ?? null,
  };
}

// -- GET /api/system/memory ----------------------------------------------------

systemExtRouter.get("/api/system/memory", async (c) => {
  const mem = process.memoryUsage();
  const rss = mem.rss;
  const total = (await import("node:os")).totalmem();
  const free = (await import("node:os")).freemem();
  const available = Math.max(0, free);
  return c.json({
    available: true,
    total_rss_bytes: rss,
    limit_bytes: total,
    available_bytes: available,
    limit_source: "system",
    usage_ratio: total > 0 ? rss / total : 0,
    partial: false,
    processes: [{ label: "backend", count: 1, rss_bytes: rss }],
  });
});

// -- POST /api/system/test/llm -------------------------------------------------

systemExtRouter.post("/api/system/test/llm", async (c) => {
  const start = Date.now();
  try {
    const settings = get_settings();
    const text = await completeText(settings, {
      system: "You are a helpful assistant. Respond briefly.",
      prompt: "Say 'OK' to confirm you are working. Do not produce long output.",
    });
    const elapsed = Date.now() - start;
    const model = String(
      (await import("../provider-config.js")).resolve_runtime_model(settings).model ?? "",
    );
    if (text && text.trim().length > 0) {
      return c.json(testResponse(true, "LLM connection successful", { model, response_time_ms: Math.round(elapsed * 100) / 100 }));
    }
    return c.json(testResponse(false, "LLM connection failed: Empty response", { model, error: "Empty response from API" }));
  } catch (exc) {
    const elapsed = Date.now() - start;
    const msg = exc instanceof Error ? exc.message : String(exc);
    return c.json(testResponse(false, `LLM connection failed: ${msg}`, { response_time_ms: Math.round(elapsed * 100) / 100, error: msg }));
  }
});

// -- POST /api/system/test/embeddings ------------------------------------------

systemExtRouter.post("/api/system/test/embeddings", async (c) => {
  const start = Date.now();
  try {
    const settings = get_settings();
    const catalog = load_catalog(settings);
    const svc = (catalog["services"] as AnyDict)?.["embedding"] as AnyDict | undefined;
    const profiles = Array.isArray(svc?.profiles) ? svc.profiles : [];
    const profile = profiles.find((p: AnyDict) => p?.id === svc?.active_profile_id) ?? profiles[0];
    const models = Array.isArray(profile?.models) ? profile.models : [];
    const model = models.find((m: AnyDict) => m?.id === svc?.active_model_id) ?? models[0];
    const resolvedModel = String(model?.model ?? "").trim();
    if (!resolvedModel) {
      return c.json(testResponse(false, "Embeddings configuration error: No active embedding model is configured.", { error: "No active embedding model is configured. Set it in Settings > Embedding models." }));
    }
    const baseUrl = String(profile?.base_url ?? "").trim().replace(/\/+$/, "");
    const apiKey = String(profile?.api_key ?? "").trim();
    if (!baseUrl) {
      return c.json(testResponse(false, "Embeddings configuration error: no base URL", { model: resolvedModel, error: "Embedding provider has no base URL" }));
    }
    const res = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: resolvedModel, input: ["test", "retrieval batch probe"] }),
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      return c.json(testResponse(false, `Embeddings connection failed: HTTP ${res.status}`, { model: resolvedModel, response_time_ms: Math.round(elapsed * 100) / 100, error: detail }));
    }
    const payload = (await res.json()) as AnyDict;
    const embeddings = payload?.data as AnyDict[] | undefined;
    const vectors = (embeddings ?? []).map((d) => (d?.embedding as number[] | undefined) ?? []);
    const ok = vectors.length === 2 && vectors.every((v) => v.length > 0) &&
      new Set(vectors.map((v) => v.length)).size === 1;
    if (ok) {
      return c.json(testResponse(true, "Embeddings connection successful (openai provider)", { model: resolvedModel, response_time_ms: Math.round(elapsed * 100) / 100 }));
    }
    return c.json(testResponse(false, "Embeddings connection failed: Invalid response", { model: resolvedModel, error: "Embedding response must contain one non-empty vector per input" }));
  } catch (exc) {
    const elapsed = Date.now() - start;
    const msg = exc instanceof Error ? exc.message : String(exc);
    return c.json(testResponse(false, `Embeddings connection failed: ${msg}`, { response_time_ms: Math.round(elapsed * 100) / 100, error: msg }));
  }
});

// -- POST /api/system/test/search ----------------------------------------------

systemExtRouter.post("/api/system/test/search", async (c) => {
  const start = Date.now();
  try {
    const settings = get_settings();
    const catalog = load_catalog(settings);
    const svc = (catalog["services"] as AnyDict)?.["search"] as AnyDict | undefined;
    const profiles = Array.isArray(svc?.profiles) ? svc.profiles : [];
    const profile = profiles.find((p: AnyDict) => p?.id === svc?.active_profile_id) ?? profiles[0];
    const models = Array.isArray(profile?.models) ? profile.models : [];
    const model = models.find((m: AnyDict) => m?.id === svc?.active_model_id) ?? models[0];
    const provider = String(profile?.binding ?? "none");
    const apiKey = String(profile?.api_key ?? "").trim();
    const baseUrl = String(profile?.base_url ?? "").trim().replace(/\/+$/, "");
    if (!provider || provider === "none") {
      return c.json(testResponse(false, "Search is disabled", { error: "Set a Search provider in Settings > Search." }));
    }
    if (provider !== "none" && !apiKey && !baseUrl.includes("localhost") && !baseUrl.includes("127.0.0.1")) {
      return c.json(testResponse(false, `Search provider \`${provider}\` missing credentials.`, { error: "Set profile.api_key in Settings > Search." }));
    }
    // Probe via the OpenAI-compatible chat/completions search-style call.
    const wireModel = String(model?.model ?? provider);
    const url = baseUrl ? `${baseUrl}/chat/completions` : "https://api.openai.com/v1/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: wireModel,
        messages: [{ role: "user", content: "DeepTutor health check" }],
        max_tokens: 16,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 400);
      return c.json(testResponse(false, `Search connection check failed: HTTP ${res.status}`, { model: provider, response_time_ms: Math.round(elapsed * 100) / 100, error: detail }));
    }
    return c.json(testResponse(true, "Search connection successful", { model: provider, response_time_ms: Math.round(elapsed * 100) / 100 }));
  } catch (exc) {
    const elapsed = Date.now() - start;
    const msg = exc instanceof Error ? exc.message : String(exc);
    return c.json(testResponse(false, `Search connection check failed: ${msg}`, { response_time_ms: Math.round(elapsed * 100) / 100, error: msg }));
  }
});

// -- update surface ------------------------------------------------------------

async function checkedUpdatePayload(force = false): Promise<Record<string, unknown>> {
  const settings = load_system_settings();
  const enabled = settings.version_check_enabled !== false;
  const installation = detect_installation();
  const service = get_version_check_service();
  if (!enabled) {
    return updatePayload({ result: service.cached(), installation, check_enabled: false });
  }
  try {
    const result: VersionCheckResult = await service.check(force);
    return updatePayload({ result, installation, check_enabled: true });
  } catch (exc) {
    if (force) throw exc;
    return updatePayload({
      result: service.cached(),
      installation,
      check_enabled: true,
      check_error: exc instanceof Error ? exc.message : String(exc),
    });
  }
}

systemExtRouter.get("/api/system/update", async (c) => {
  try {
    return c.json(await checkedUpdatePayload());
  } catch (exc) {
    return httpError(c, 503, exc instanceof Error ? exc.message : String(exc));
  }
});

systemExtRouter.post("/api/system/update/check", async (c) => {
  try {
    return c.json(await checkedUpdatePayload(true));
  } catch (exc) {
    return httpError(c, 503, exc instanceof Error ? exc.message : String(exc));
  }
});

systemExtRouter.put("/api/system/update/settings", async (c) => {
  const payload = await body(c);
  const enabled = payload.enabled === true || payload.enabled === "true" || payload.enabled === 1;
  save_system_settings({ version_check_enabled: enabled });
  try {
    return c.json(await checkedUpdatePayload());
  } catch (exc) {
    return httpError(c, 503, exc instanceof Error ? exc.message : String(exc));
  }
});

systemExtRouter.get("/api/system/update/job", (c) => {
  return c.json(jobPayload(storedJob()));
});

systemExtRouter.post("/api/system/update", async (c) => {
  const payload = await body(c);
  if (payload.confirmation !== "update-and-restart") {
    return httpError(c, 422, "confirmation must be 'update-and-restart'");
  }
  const settings = load_system_settings();
  if (settings.version_check_enabled === false) {
    return httpError(c, 409, "Version checks are disabled");
  }
  if (running_under_systemd_service()) {
    return httpError(c, 409, SYSTEMD_UPDATE_REASON);
  }
  if (!launcher_available()) {
    return httpError(c, 409, "Web updates require DeepTutor to be running under `deeptutor start`.");
  }
  const installation = detect_installation();
  if (installation.mode !== "pypi" || !installation.automatic_update) {
    return httpError(c, 409, installation.reason || "This installation cannot update itself safely.");
  }
  // Unreachable in this backend (launcher_available() === false above), kept
  // for parity with upstream's fail-closed ordering.
  try {
    const result = await get_version_check_service().check();
    if (!result.release || result.release.version <= (result.current_version ?? "0")) {
      return httpError(c, 409, "No newer DeepTutor release is available");
    }
    const store = get_update_job_store();
    const job = store.create(result.current_version, result.release.version);
    return c.json(jobPayload(job) ?? {}, 202);
  } catch (exc) {
    return httpError(c, 409, exc instanceof Error ? exc.message : String(exc));
  }
});

export { VersionCheckService };
