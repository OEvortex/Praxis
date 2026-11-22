// Missing upstream settings endpoints ported from deeptutor/api/routers/settings.py.
// Mounted with absolute /api/settings paths; routes already served by
// handlers.ts are intentionally not duplicated here.
import { Hono } from "hono";
import type { Context } from "hono";
import { get_settings as getSettings, type Settings } from "../config.js";
import * as store from "../services/settings_ext/store.js";
import * as parsing from "../services/settings_ext/parsing.js";
import * as voice from "../services/settings_ext/voice.js";
import { AuthError, getCodexOAuthService, getCodeBuddyAuthService } from "../services/settings_ext/oauth.js";

export const settingsFullRouter = new Hono();
const settings = (): Settings => getSettings();
const S = settings;
const err = (c: Context, status: number, detail: unknown) => c.json({ detail }, status as never);
const body = async (c: Context): Promise<Record<string, any>> => {
  try { const v = await c.req.json(); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
};
const int = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : fallback; };
const str = (v: unknown, fallback = "") => String(v ?? fallback).trim();
const bool = (v: unknown, fallback = false) => (typeof v === "boolean" ? v : fallback);
const normalizeOrigins = (values: unknown): string[] => {
  const out = new Set<string>();
  const push = (v: unknown) => { const s = str(v); if (s) out.add(s); };
  if (Array.isArray(values)) values.forEach(push); else if (typeof values === "string") values.split(",").forEach(push);
  return [...out];
};
const authError = (c: Context, exc: unknown) => {
  if (exc instanceof AuthError) return c.json({ detail: { code: exc.code, message: exc.message } }, exc.httpStatus as never);
  return err(c, 500, exc instanceof Error ? exc.message : String(exc));
};
const webFetchChoices = [
  { value: "local", label: "Local extractor", requires_api_key: false },
  { value: "deepseek", label: "DeepSeek", requires_api_key: true },
];
const FETCH_BACKENDS = new Set(webFetchChoices.map((x) => x.value));

function networkPayload() {
  const system = store.loadSystem(S(), false);
  const effective = store.loadSystem(S(), true);
  const auth = store.loadAuth(S());
  const backend = `http://localhost:${int(effective.backend_port, 8001)}`;
  const browserBase = str(effective.next_public_api_base_external) || str(effective.next_public_api_base) || backend;
  const authEnabled = bool(auth.enabled);
  const cookieSecure = bool(auth.cookie_secure);
  return {
    settings: { backend_port: int(system.backend_port, 8001), frontend_port: int(system.frontend_port, 3782), public_api_base: str(system.next_public_api_base_external), cors_origins: normalizeOrigins([system.cors_origin, system.cors_origins]) },
    effective: { backend_url: backend, frontend_url: `http://localhost:${int(effective.frontend_port, 3782)}`, browser_api_base: browserBase, api_base_source: effective.next_public_api_base_external ? "next_public_api_base_external" : effective.next_public_api_base ? "next_public_api_base" : "default_backend_url", cors_mode: authEnabled ? "explicit" : "permissive", cors_origins: normalizeOrigins([effective.cors_origin, effective.cors_origins]), allow_remote_http_origins: !authEnabled },
    auth: { enabled: authEnabled, cookie_secure: cookieSecure, cookie_samesite: cookieSecure ? "none" : "lax", cross_site_cookie_ready: authEnabled && cookieSecure },
    restart_required: true,
  };
}
function webFetchPayload() {
  const stored = str(store.loadSystem(S(), false).web_fetch_backend, "local") || "local";
  const effective = str(store.loadSystem(S(), true).web_fetch_backend, "local") || "local";
  return { settings: { backend: stored }, effective: { backend: effective }, choices: webFetchChoices };
}
const CHAT_FILE_MB = [1, 1024] as const;
const CHAT_TOTAL_MB = [1, 2048] as const;
const CHAT_CHARS = [10_000, 5_000_000] as const;
function attachmentsPayload() {
  const stored = store.loadSystem(S(), false);
  const effective = store.loadSystem(S(), true);
  const totalBytes = int(effective.chat_attachment_max_total_mb, 25) * 1024 * 1024;
  return {
    settings: { max_file_mb: int(stored.chat_attachment_max_file_mb, 20), max_total_mb: int(stored.chat_attachment_max_total_mb, 25), max_chars_per_doc: int(stored.chat_attachment_max_chars_per_doc, 200000), max_chars_total: int(stored.chat_attachment_max_chars_total, 150000) },
    effective: { max_file_bytes: int(effective.chat_attachment_max_file_mb, 20) * 1024 * 1024, max_total_bytes: totalBytes, max_chars_per_doc: int(effective.chat_attachment_max_chars_per_doc, 200000), max_chars_total: int(effective.chat_attachment_max_chars_total, 150000), ws_max_size: Math.ceil(totalBytes * 1.4) },
    bounds: { max_file_mb: [...CHAT_FILE_MB], max_total_mb: [...CHAT_TOTAL_MB], chars: [...CHAT_CHARS] },
    restart_required_for_larger_uploads: true,
  };
}
function presets() {
  const base = (id: string, label: string, parser: string, tools: string[], features: string[], cost = "medium", creds = ["llm"]) => ({ id, label, description: label, parser, resource_cost: cost, credentials: creds, prerequisites: ["llm_profile"], unlocked_features: features, tools });
  return [
    base("basic_text", "settings.presets.basic_text.name", "text_only", ["brainstorm", "reason"], ["core_chat", "reasoning"], "low"),
    base("local_multimodal", "settings.presets.local_multimodal.name", "markitdown", ["brainstorm", "reason", "imagegen", "videogen"], ["document_parsing", "image_generation", "video_generation"], "medium", ["llm", "imagegen", "videogen"]),
    base("university_study", "settings.presets.university_study.name", "markitdown", ["brainstorm", "web_search", "paper_search", "reason"], ["document_parsing", "web_search", "paper_search", "reasoning"], "medium", ["llm", "search"]),
    base("full_generation", "settings.presets.full_generation.name", "markitdown", ["brainstorm", "web_search", "paper_search", "reason", "imagegen", "videogen"], ["document_parsing", "web_search", "paper_search", "image_generation", "video_generation"], "high", ["llm", "imagegen", "videogen", "search"]),
  ];
}
const presetDraft = (preset: ReturnType<typeof presets>[number]) => ({ "document-parsing": { engine: preset.parser, engines: {} }, tools: { enabled_tools: preset.tools } });
async function stagePreset(c: Context, presetId: string) {
  const preset = presets().find((p) => p.id === presetId);
  if (!preset) return err(c, 404, `Unknown preset '${presetId}'.`);
  const b = await body(c);
  const stored = store.loadDraft(S());
  const incoming = { ...b, extensions: { ...(store.isRecord(stored.extensions) ? stored.extensions : {}), ...(store.isRecord(b.extensions) ? b.extensions : {}) } };
  const merged = store.mergeDraftSecrets(incoming, stored, store.loadCatalog(S()));
  const draftExtensions = presetDraft(preset);
  const tools = (draftExtensions.tools.enabled_tools as string[]).filter((x) => ["brainstorm", "web_search", "paper_search", "reason", "imagegen", "videogen"].includes(x));
  merged.extensions = { ...(store.isRecord(merged.extensions) ? merged.extensions : {}), ...draftExtensions, tools: { enabled_tools: tools } };
  const saved = store.saveDraft(S(), merged);
  return c.json({ preset: { id: preset.id, label: preset.label, description: preset.description, parser: preset.parser, resource_cost: preset.resource_cost, credentials: preset.credentials, prerequisites: preset.prerequisites, unlocked_features: preset.unlocked_features }, draft: store.redactDraft(saved) });
}

// Codex OAuth
settingsFullRouter.post("/api/settings/providers/openai-codex/oauth/start", async (c) => { try { return c.json(await getCodexOAuthService(S()).startLogin()); } catch (e) { return authError(c, e); } });
settingsFullRouter.get("/api/settings/providers/openai-codex/oauth/status", (c) => c.json(getCodexOAuthService(S()).publicStatus()));
settingsFullRouter.post("/api/settings/providers/openai-codex/oauth/complete", async (c) => { try { return c.json(await getCodexOAuthService(S()).completeLoginWithCallbackUrl(str((await body(c)).callback_url))); } catch (e) { return authError(c, e); } });
settingsFullRouter.post("/api/settings/providers/openai-codex/oauth/cancel", async (c) => { try { return c.json(await getCodexOAuthService(S()).cancelLogin()); } catch (e) { return authError(c, e); } });
settingsFullRouter.post("/api/settings/providers/openai-codex/oauth/logout", async (c) => { try { return c.json(await getCodexOAuthService(S()).logout()); } catch (e) { return authError(c, e); } });
settingsFullRouter.post("/api/settings/providers/openai-codex/models/refresh", async (c) => { try { return c.json(await getCodexOAuthService(S()).refreshModels()); } catch (e) { return authError(c, e); } });
settingsFullRouter.post("/api/settings/providers/openai-codex/models/reasoning-effort", async (c) => {
  const b = await body(c); const before = store.loadCatalog(S());
  try { const out = await getCodexOAuthService(S()).setReasoningEffort(str(b.model), b.reasoning_effort == null ? null : str(b.reasoning_effort)); return c.json(out); } catch (e) { return authError(c, e); }
  finally { void before; }
});
settingsFullRouter.get("/api/settings/providers/codebuddy/auth/status", async (c) => c.json(await getCodeBuddyAuthService().status()));
settingsFullRouter.post("/api/settings/providers/codebuddy/auth/start", async (c) => c.json(await getCodeBuddyAuthService().startLogin()));
settingsFullRouter.post("/api/settings/providers/codebuddy/auth/cancel", async (c) => c.json(await getCodeBuddyAuthService().cancelLogin()));
settingsFullRouter.post("/api/settings/providers/codebuddy/auth/logout", async (c) => c.json(await getCodeBuddyAuthService().logout()));

// Catalog / network / web fetch / runtime settings
settingsFullRouter.get("/api/settings/catalog", (c) => c.json({ catalog: store.redactCatalog(store.loadCatalog(S())) }));
settingsFullRouter.put("/api/settings/catalog", async (c) => {
  const b = await body(c); const current = store.loadCatalog(S());
  const restored = store.restoreCatalogSecrets(store.isRecord(b.catalog) ? b.catalog : {}, current);
  store.saveCatalog(S(), restored);
  return c.json({ catalog: store.redactCatalog(store.loadCatalog(S())) });
});
settingsFullRouter.get("/api/settings/network", (c) => c.json(networkPayload()));
settingsFullRouter.put("/api/settings/network", async (c) => {
  const b = await body(c);
  const current = store.loadSystem(S(), false);
  const port = int(b.backend_port, 0); const frontend = int(b.frontend_port, 0);
  if (port < 1 || port > 65535 || frontend < 1 || frontend > 65535) return err(c, 422, "Ports must be between 1 and 65535.");
  store.saveSystem(S(), { ...current, backend_port: port, frontend_port: frontend, next_public_api_base_external: str(b.public_api_base), cors_origin: "", cors_origins: normalizeOrigins(b.cors_origins) });
  return c.json(networkPayload());
});
settingsFullRouter.get("/api/settings/web-fetch", (c) => c.json(webFetchPayload()));
settingsFullRouter.put("/api/settings/web-fetch", async (c) => {
  const backend = str((await body(c)).backend).toLowerCase();
  if (!FETCH_BACKENDS.has(backend)) return err(c, 400, `Unknown web fetch backend: ${backend || "(empty)"} (expected one of: ${[...FETCH_BACKENDS].join(", ")}).`);
  store.saveSystem(S(), { ...store.loadSystem(S(), false), web_fetch_backend: backend });
  return c.json(webFetchPayload());
});
settingsFullRouter.get("/api/settings/chat-attachments", (c) => c.json(attachmentsPayload()));
settingsFullRouter.put("/api/settings/chat-attachments", async (c) => {
  const b = await body(c); const clamp = (v: unknown, [lo, hi]: readonly number[], fallback: number) => Math.max(lo, Math.min(hi, int(v, fallback)));
  const current = store.loadSystem(S(), false);
  store.saveSystem(S(), { ...current, chat_attachment_max_file_mb: clamp(b.max_file_mb, CHAT_FILE_MB, 20), chat_attachment_max_total_mb: clamp(b.max_total_mb, CHAT_TOTAL_MB, 25), chat_attachment_max_chars_per_doc: clamp(b.max_chars_per_doc, CHAT_CHARS, 200000), chat_attachment_max_chars_total: clamp(b.max_chars_total, CHAT_CHARS, 150000) });
  return c.json(attachmentsPayload());
});
settingsFullRouter.get("/api/settings/chat-starters", (c) => c.json({ settings: store.loadStarters(S()), bounds: { trace_count: [3, 100] } }));
settingsFullRouter.put("/api/settings/chat-starters", async (c) => {
  const b = await body(c); const trace = int(b.trace_count, 20);
  if (trace < 3 || trace > 100) return err(c, 422, "trace_count must be between 3 and 100.");
  const saved = store.saveStarters(S(), { trace_count: trace, ask_hint_enabled: b.ask_hint_enabled });
  return c.json({ settings: saved, bounds: { trace_count: [3, 100] } });
});

// MinerU / document parsing
settingsFullRouter.get("/api/settings/mineru", (c) => c.json(parsing.mineruPayload(S())));
settingsFullRouter.put("/api/settings/mineru", async (c) => c.json(parsing.updateMineru(S(), await body(c))));
settingsFullRouter.get("/api/settings/document-parsing", (c) => c.json(parsing.documentParsingPayload(S())));
settingsFullRouter.put("/api/settings/document-parsing", async (c) => c.json(parsing.updateDocumentParsing(S(), await body(c))));
settingsFullRouter.post("/api/settings/document-parsing/test", async (c) => c.json(await parsing.testDocumentParsing(S(), str((await body(c)).engine) || undefined)));
settingsFullRouter.post("/api/settings/document-parsing/docling/test", async (c) => { const r = await parsing.verifyDocling((await body(c)) as any); return c.json(r ?? { ok: false, message: "Docling remote mode is not selected." }); });
settingsFullRouter.post("/api/settings/document-parsing/tika/test", async (c) => { const r = await parsing.verifyTika((await body(c)) as any); return c.json(r ?? { ok: false, message: "Tika remote URL is not configured." }); });
settingsFullRouter.post("/api/settings/document-parsing/install", async (c) => c.json(parsing.startDocumentParsingInstall(str((await body(c)).engine))));
settingsFullRouter.post("/api/settings/document-parsing/models/download", async (c) => c.json(parsing.startDocumentParsingModelDownload(str((await body(c)).engine))));
settingsFullRouter.get("/api/settings/document-parsing/job/status", (c) => c.json(parsing.backgroundJobManager.status(int(c.req.query("cursor"), 0))));
settingsFullRouter.post("/api/settings/document-parsing/job/cancel", (c) => c.json(parsing.backgroundJobManager.cancel()));
settingsFullRouter.post("/api/settings/mineru/models/download", async (c) => c.json(parsing.startMineruModelDownload(S(), await body(c))));
settingsFullRouter.get("/api/settings/mineru/models/download/status", (c) => c.json(parsing.backgroundJobManager.status(int(c.req.query("cursor"), 0))));
settingsFullRouter.post("/api/settings/mineru/models/download/cancel", (c) => c.json(parsing.backgroundJobManager.cancel()));
settingsFullRouter.post("/api/settings/mineru/test", async (c) => c.json(await parsing.testMineru(S(), await body(c))));

// Profile / presets / readiness
settingsFullRouter.get("/api/settings/readiness", (c) => c.json(store.buildReadiness(S())));
settingsFullRouter.get("/api/settings/profile", (c) => c.json(store.exportProfile(S())));
settingsFullRouter.post("/api/settings/profile/diff", async (c) => { try { return c.json(store.reviewProfileImport(await body(c))); } catch (e) { return err(c, 422, e instanceof Error ? e.message : String(e)); } });
settingsFullRouter.post("/api/settings/model-capabilities", async (c) => {
  const b = await body(c); const binding = str(b.binding, "openai").toLowerCase() || "openai"; const model = str(b.model).toLowerCase();
  const vision = /gpt-4o|gpt-4\.1|o[134](?:-|$)|claude-(?:3|sonnet|opus|haiku)|gemini|qwen-vl|qwen2\.5-vl|llava|vision|pixtral|ministral-3b|grok-4/.test(model);
  const reasoning = /o[134](?:-|$)|deepseek-r|qwen.*reason|claude.*thinking|gpt-5|gemini.*thinking|reason/.test(model);
  const tools = !/embedding|whisper|tts|stable-diffusion|dall-e/.test(model);
  const json = !/whisper|tts|embedding/.test(model);
  return c.json({ binding, model: str(b.model), defaults: { tools, vision, json_output: json, reasoning } });
});
settingsFullRouter.get("/api/settings/presets", (c) => c.json({ schema_version: "deeptutor.settings-presets/v1", presets: presets().map(({ tools: _tools, ...p }) => p) }));

// UI and display settings
const UI_FIELDS = new Set(["theme", "sidebar_description", "sidebar_nav_order", "code_block_theme", "code_block_show_line_numbers", "code_block_wrap_long_lines", "content_font_scale", "content_line_spacing", "enabled_optional_tools", "voice_autoplay", "voice_math_speak", "chat_response_timeout", "page_customization"]);
settingsFullRouter.get("/api/settings/ui", (c) => { const ui = store.loadUi(S()); return c.json({ theme: ui.theme }); });
settingsFullRouter.put("/api/settings/ui", async (c) => {
  const b = await body(c); const patch: Record<string, any> = {};
  for (const [k, v] of Object.entries(b)) if (UI_FIELDS.has(k) && v !== undefined) patch[k] = v;
  if (patch.content_font_scale !== undefined && ![90, 100, 110, 125, 150].includes(Number(patch.content_font_scale))) return err(c, 422, "content_font_scale must be one of 90, 100, 110, 125, 150.");
  if (patch.content_line_spacing !== undefined && !["compact", "normal", "relaxed"].includes(String(patch.content_line_spacing))) return err(c, 422, "Invalid content_line_spacing.");
  store.patchUi(S(), patch);
  return c.json(store.loadUi(S()));
});
settingsFullRouter.put("/api/settings/theme", async (c) => { const theme = str((await body(c)).theme); if (!["system", "light", "dark", "glass", "snow"].includes(theme)) return err(c, 422, "Invalid theme."); store.patchUi(S(), { theme }); return c.json({ theme }); });
settingsFullRouter.put("/api/settings/voice-autoplay", async (c) => { const v = bool((await body(c)).voice_autoplay); store.patchUi(S(), { voice_autoplay: v }); return c.json({ voice_autoplay: v }); });
settingsFullRouter.put("/api/settings/voice-math-speak", async (c) => { const v = bool((await body(c)).voice_math_speak); store.patchUi(S(), { voice_math_speak: v }); return c.json({ voice_math_speak: v }); });
settingsFullRouter.put("/api/settings/chat-response-timeout", async (c) => { const v = int((await body(c)).chat_response_timeout, 0); if (v < 30 || v > 1800) return err(c, 422, "chat_response_timeout must be between 30 and 1800."); store.patchUi(S(), { chat_response_timeout: v }); return c.json({ chat_response_timeout: v }); });
settingsFullRouter.put("/api/settings/page-customization/chat", async (c) => c.json(store.savePageSection(S(), "chat", await body(c))));
settingsFullRouter.put("/api/settings/page-customization/learning", async (c) => c.json(store.savePageSection(S(), "learning", await body(c))));
settingsFullRouter.post("/api/settings/reset", (c) => { store.saveUi(S(), { ...store.UI_DEFAULTS }); return c.json(store.UI_DEFAULTS); });
settingsFullRouter.get("/api/settings/themes", (c) => c.json({ themes: [{ id: "system", name: "System" }, { id: "snow", name: "Default" }, { id: "light", name: "Cream" }, { id: "dark", name: "Dark" }, { id: "glass", name: "Glass" }] }));
settingsFullRouter.get("/api/settings/sidebar", (c) => { const ui = store.loadUi(S()); return c.json({ description: ui.sidebar_description, nav_order: ui.sidebar_nav_order }); });
settingsFullRouter.put("/api/settings/sidebar/description", async (c) => { const description = str((await body(c)).description); store.patchUi(S(), { sidebar_description: description }); return c.json({ description }); });
settingsFullRouter.put("/api/settings/sidebar/nav-order", async (c) => { const nav = (await body(c)).nav_order; if (!store.isRecord(nav)) return err(c, 422, "Invalid nav_order."); store.patchUi(S(), { sidebar_nav_order: nav }); return c.json({ nav_order: nav }); });
settingsFullRouter.put("/api/settings/enabled-tools", async (c) => {
  const allowed = new Set(["brainstorm", "web_search", "paper_search", "zotero_search", "reason", "geogebra_analysis", "imagegen", "videogen"]);
  const input = Array.isArray((await body(c)).enabled_tools) ? (await body(c)).enabled_tools as unknown[] : [];
  const sanitized = [...new Set(input.filter((x): x is string => typeof x === "string" && allowed.has(x)))];
  store.patchUi(S(), { enabled_optional_tools: sanitized });
  return c.json({ enabled_optional_tools: sanitized });
});

// Voice preview/discovery
settingsFullRouter.post("/api/settings/voice/voices", async (c) => {
  try { return c.json(await voice.discoverVoices(S(), await body(c))); } catch (e) { return err(c, 400, e instanceof Error ? e.message : String(e)); }
});
settingsFullRouter.post("/api/settings/voice/preview", async (c) => {
  try {
    const out = await voice.synthesizePreview(S(), await body(c));
    return new Response(out.audio as unknown as BodyInit, { headers: { "Content-Type": out.contentType, "Cache-Control": "no-store" } });
  } catch (e) {
    const status = (e as { status?: number }).status === 401 ? 401 : (e as { status?: number }).status === 403 ? 403 : (e as { status?: number }).status === 404 ? 404 : (e as { status?: number }).status === 429 ? 429 : 502;
    return err(c, status, e instanceof Error ? e.message : String(e));
  }
});

// Tour
settingsFullRouter.get("/api/settings/tour/status", (c) => {
  const cache = store.readState<Record<string, any>>(S(), "tour_cache", {});
  return c.json(cache && Object.keys(cache).length ? { active: true, status: cache.status ?? "unknown", launch_at: cache.launch_at ?? null, redirect_at: cache.redirect_at ?? null } : { active: false, status: "none", launch_at: null, redirect_at: null });
});
settingsFullRouter.post("/api/settings/tour/complete", async (c) => {
  const b = await body(c); const now = Math.floor(Date.now() / 1000);
  const cache = { ...(store.readState<Record<string, any>>(S(), "tour_cache", {}) ?? {}), status: "completed", launch_at: now + 3, redirect_at: now + 5, ...(store.isRecord(b.test_results) ? { test_results: b.test_results } : {}) };
  store.writeState(S(), "tour_cache", cache);
  const catalog = store.isRecord(b.catalog) ? store.restoreCatalogSecrets(b.catalog, store.loadCatalog(S())) : store.loadCatalog(S());
  store.saveCatalog(S(), catalog);
  store.clearDraft(S());
  return c.json({ status: "completed", message: "Configuration saved. DeepTutor will restart shortly.", launch_at: cache.launch_at, redirect_at: cache.redirect_at, runtime: { applied: true } });
});
settingsFullRouter.post("/api/settings/tour/reopen", (c) => c.json({ message: "Run the terminal setup guide from the project root to re-open the guided setup.", command: "deeptutor init" }));

