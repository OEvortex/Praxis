// Settings surfaces that have no counterpart in backend-ts provider-config.
// Persistence uses the shared SQLite kv table via store/database.ts.
import type { Settings } from "../../config.js";
import { get_settings as getSettings } from "../../config.js";
import * as database from "../../store/database.js";
import * as providerConfig from "../../provider-config.js";

export type Json = Record<string, any>;
export const isRecord = (v: unknown): v is Json =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export const now = () => Date.now() / 1000;
export const uuid = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);

function state<T = Json>(settings: Settings, key: string, fallback: T): T {
  const v = database.get_state<unknown>(settings, `settings_ext/${key}`, null);
  return (isRecord(v) || Array.isArray(v) ? v : fallback) as T;
}
function saveState(settings: Settings, key: string, value: unknown): void {
  database.put_state(settings, `settings_ext/${key}`, value);
}
export const readState = state;
export const writeState = saveState;
export const deleteState = (settings: Settings, key: string) =>
  database.delete_state(settings, `settings_ext/${key}`);

// ---------------------------------------------------------------------------
// Runtime settings files
// ---------------------------------------------------------------------------

export const DEFAULT_SYSTEM: Json = {
  version: 1,
  version_check_enabled: true,
  backend_port: 8001,
  backend_workers: 1,
  frontend_port: 3782,
  next_public_api_base_external: "",
  next_public_api_base: "",
  cors_origin: "",
  cors_origins: [],
  disable_ssl_verify: false,
  chat_attachment_dir: "",
  sandbox_allow_subprocess: true,
  capability_routing_enabled: false,
  web_fetch_backend: "local",
  web_search_source_filtering: {
    enabled: true,
    blocked_domains: [],
    trusted_domains: [],
    content_filtering: true,
    use_educational_trusted_domains: false,
    use_moderation: false,
  },
  chat_attachment_max_file_mb: 20,
  chat_attachment_max_total_mb: 25,
  chat_attachment_max_chars_per_doc: 200_000,
  chat_attachment_max_chars_total: 150_000,
  chat_prior_image_reinject_max: 4,
  security_guard: {
    enabled: false,
    rate_limit: 300,
    rate_limit_window: 60,
    trusted_proxies: ["127.0.0.1", "::1"],
    exempt_ips: ["127.0.0.1", "::1"],
    whitelist: [],
    blacklist: [],
  },
};

export const DEFAULT_AUTH: Json = {
  version: 1,
  enabled: false,
  username: "admin",
  password_hash: "",
  token_expire_hours: 24,
  cookie_secure: false,
  private_login_hosts: [],
};

export const DEFAULT_INTEGRATIONS: Json = {
  version: 2,
  pocketbase_url: "",
  pocketbase_port: 8090,
  pocketbase_external_url: "",
  pocketbase_admin_email: "",
  pocketbase_admin_password: "",
  turn_coordination: {
    backend: "memory",
    redis_url: "",
    key_prefix: "deeptutor",
    lease_ttl_seconds: 30,
    renew_interval_seconds: 10,
    recovery_interval_seconds: 10,
    stream_retention_seconds: 86_400,
  },
};

export const MINERU_DEFAULT: Json = {
  mode: "local",
  api_base_url: "https://mineru.net",
  api_token: "",
  local_cli_path: "",
  model_download_source: "huggingface",
  model_download_endpoint: "",
  model_version: "pipeline",
  language: "auto",
  enable_formula: true,
  enable_table: true,
  is_ocr: false,
  max_pages_per_part: 180,
  normalize_tiny_scans: false,
  allow_local_model_download: false,
};

export const DOCLING_DEFAULT: Json = {
  mode: "local",
  api_base_url: "http://localhost:5001",
  api_token: "",
  do_ocr: false,
  do_table_structure: true,
  allow_local_model_download: false,
  do_formula_enrichment: false,
  do_picture_classification: false,
  do_picture_description: false,
};

export const TIKA_DEFAULT: Json = { server_url: "http://localhost:9998" };

export const DEFAULT_DOCUMENT_PARSING: Json = {
  version: 2,
  engine: "text_only",
  image_caption: false,
  image_description_model: null,
  engines: {
    text_only: {},
    mineru: { ...MINERU_DEFAULT },
    docling: { ...DOCLING_DEFAULT },
    markitdown: { enable_llm_image_description: false },
    pymupdf4llm: { write_images: true, image_format: "png", image_dpi: 150 },
    liteparse: { image_mode: "placeholder", extract_images: true, max_pages: 0 },
    tika: { ...TIKA_DEFAULT },
  },
};

const asJson = (v: unknown, fallback: Json): Json => (isRecord(v) ? { ...v } : { ...fallback });
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function loadSystem(settings: Settings = getSettings(), processOverrides = true): Json {
  const saved = asJson(state(settings, "system", {}), {});
  const out = { ...DEFAULT_SYSTEM, ...saved };
  if (processOverrides) {
    const port = Number(process.env.PRAXIS_BACKEND_PORT ?? process.env.DEEPTUTOR_BACKEND_PORT);
    if (Number.isFinite(port) && port > 0) out.backend_port = port;
    const fetch = (process.env.DEEPTUTOR_FETCH_BACKEND ?? process.env.PRAXIS_FETCH_BACKEND ?? "").trim();
    if (fetch) out.web_fetch_backend = fetch.toLowerCase();
  }
  return out;
}
export function saveSystem(settings: Settings, value: Json): Json {
  const out = { ...DEFAULT_SYSTEM, ...value };
  saveState(settings, "system", out);
  return out;
}
export function loadAuth(settings: Settings = getSettings()): Json {
  return { ...DEFAULT_AUTH, ...asJson(state(settings, "auth", {}), {}) };
}
export function loadIntegrations(settings: Settings = getSettings()): Json {
  return { ...DEFAULT_INTEGRATIONS, ...asJson(state(settings, "integrations", {}), {}) };
}

export function loadDocumentParsing(settings: Settings = getSettings()): Json {
  const raw = asJson(state(settings, "document_parsing", {}), DEFAULT_DOCUMENT_PARSING);
  const enginesRaw = isRecord(raw.engines) ? raw.engines : {};
  const engines: Json = {};
  for (const [name, fallback] of Object.entries(DEFAULT_DOCUMENT_PARSING.engines as Json)) {
    engines[name] = { ...(fallback as Json), ...(isRecord(enginesRaw[name]) ? enginesRaw[name] : {}) };
  }
  for (const [name, value] of Object.entries(enginesRaw)) {
    if (!(name in engines) && isRecord(value)) engines[name] = { ...value };
  }
  return {
    ...DEFAULT_DOCUMENT_PARSING,
    ...raw,
    engine: raw.engine ?? DEFAULT_DOCUMENT_PARSING.engine,
    engines,
  };
}
export function saveDocumentParsing(settings: Settings, value: Json): Json {
  const saved = { ...DEFAULT_DOCUMENT_PARSING, ...value };
  saveState(settings, "document_parsing", saved);
  return loadDocumentParsing(settings);
}
export function loadMineru(settings: Settings = getSettings()): Json {
  const full = loadDocumentParsing(settings);
  return { ...MINERU_DEFAULT, ...((full.engines?.mineru as Json) ?? {}) };
}
export function saveMineru(settings: Settings, value: Json): Json {
  const full = loadDocumentParsing(settings);
  const engines = { ...(full.engines as Json) };
  engines.mineru = { ...MINERU_DEFAULT, ...value };
  saveDocumentParsing(settings, { ...full, engines });
  return loadMineru(settings);
}

// ---------------------------------------------------------------------------
// UI settings / starter settings / page customization
// ---------------------------------------------------------------------------

export const UI_DEFAULTS: Json = {
  theme: "system",
  content_font_scale: 100,
  content_line_spacing: "normal",
  sidebar_description: "Data Intelligence Lab",
  sidebar_nav_order: {
    start: ["/", "/history", "/knowledge-bases", "/notebooks"],
    learnResearch: ["/question", "/solver", "/research", "/co_writer"],
  },
  code_block_theme: null,
  code_block_show_line_numbers: null,
  code_block_wrap_long_lines: null,
  enabled_optional_tools: ["brainstorm", "web_search", "paper_search", "reason"],
  voice_autoplay: false,
  voice_math_speak: true,
  chat_response_timeout: 180,
  page_customization: { chat: {}, learning: {} },
};

export function loadUi(settings: Settings = getSettings()): Json {
  return { ...UI_DEFAULTS, ...asJson(state(settings, "ui", {}), {}) };
}
export function patchUi(settings: Settings, fields: Json): Json {
  const current = asJson(state(settings, "ui", {}), {});
  const next = { ...current, ...fields };
  saveState(settings, "ui", next);
  return loadUi(settings);
}
export function saveUi(settings: Settings, value: Json): Json {
  saveState(settings, "ui", value);
  return loadUi(settings);
}

const STARTER_DEFAULTS: Json = { version: 1, trace_count: 20, ask_hint_enabled: true };
export function loadStarters(settings: Settings = getSettings()): Json {
  const raw = asJson(state(settings, "starters", {}), {});
  const trace = Number(raw.trace_count);
  return {
    version: 1,
    trace_count: Number.isFinite(trace) ? Math.max(3, Math.min(100, Math.trunc(trace))) : 20,
    ask_hint_enabled: typeof raw.ask_hint_enabled === "boolean" ? raw.ask_hint_enabled : true,
  };
}
/** Whether the composer's predicted-next-line (Tab-to-complete) is enabled. */
export function askHintsEnabled(settings: Settings = getSettings()): boolean {
  return loadStarters(settings).ask_hint_enabled === true;
}

export function saveStarters(settings: Settings, value: Json): Json {
  const current = loadStarters(settings);
  const patch = { ...value };
  if (patch.ask_hint_enabled === undefined || patch.ask_hint_enabled === null) {
    patch.ask_hint_enabled = current.ask_hint_enabled;
  }
  const out = { ...STARTER_DEFAULTS, ...patch };
  saveState(settings, "starters", out);
  return loadStarters(settings);
}

export function pageCustomization(settings: Settings = getSettings()): Json {
  const stored = loadUi(settings).page_customization;
  return isRecord(stored) ? stored : { chat: {}, learning: {} };
}
export function savePageSection(settings: Settings, section: "chat" | "learning", value: Json): Json {
  const current = pageCustomization(settings);
  const next = { ...current, [section]: value };
  patchUi(settings, { page_customization: next });
  return pageCustomization(settings);
}

// ---------------------------------------------------------------------------
// Catalog draft / apply helpers
// ---------------------------------------------------------------------------

export function loadCatalog(settings: Settings = getSettings()): Json {
  return providerConfig.load_catalog(settings) as Json;
}
export function saveCatalog(settings: Settings, catalog: Json): Json {
  providerConfig.save_catalog(settings, catalog);
  return loadCatalog(settings);
}

export function loadDraft(settings: Settings = getSettings()): Json {
  const draft = state<Json>(settings, "settings_draft", {
    version: 1,
    updated_at: "",
    catalog: null,
    extensions: {},
  });
  return {
    version: 1,
    updated_at: String(draft.updated_at ?? ""),
    catalog: isRecord(draft.catalog) ? draft.catalog : null,
    extensions: isRecord(draft.extensions) ? draft.extensions : {},
  };
}
export function saveDraft(settings: Settings, draft: Json): Json | null {
  const normalized = {
    version: 1,
    updated_at: new Date().toISOString(),
    catalog: isRecord(draft.catalog) ? draft.catalog : null,
    extensions: isRecord(draft.extensions) ? draft.extensions : {},
  };
  if (normalized.catalog === null && Object.keys(normalized.extensions).length === 0) {
    database.delete_state(settings, "settings_ext/settings_draft");
    return null;
  }
  saveState(settings, "settings_draft", normalized);
  return normalized;
}
export function clearDraft(settings: Settings): void {
  database.delete_state(settings, "settings_ext/settings_draft");
}
export function isEmptyDraft(draft: Json | null | undefined): boolean {
  return !draft || (!draft.catalog && Object.keys(draft.extensions ?? {}).length === 0);
}

const SECRET_HINTS = ["api_key", "apikey", "token", "secret", "password"];
const isSecretField = (name: string) => SECRET_HINTS.some((h) => name.toLowerCase().includes(h));
const MASK = "***";
function redactValue(v: unknown): unknown {
  if (typeof v === "string") return v ? MASK : v;
  if (Array.isArray(v)) return v.map(redactValue);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x)]));
  return v;
}
function restoreValue(proposed: unknown, current: unknown): unknown {
  if (proposed === MASK) return current;
  if (isRecord(proposed) && isRecord(current)) {
    return Object.fromEntries(Object.entries(proposed).map(([k, v]) => [k, restoreValue(v, current[k])]));
  }
  if (Array.isArray(proposed) && Array.isArray(current)) {
    return proposed.map((v, i) => restoreValue(v, current[i]));
  }
  return proposed;
}
function redactProfile(profile: Json): void {
  for (const [key, value] of Object.entries(profile)) {
    if (key === "extra_headers" || isSecretField(key)) profile[key] = redactValue(value);
  }
}
export function redactCatalog(catalog: Json): Json {
  const out = JSON.parse(JSON.stringify(catalog)) as Json;
  for (const conn of arr(out.connections)) if (isRecord(conn)) redactProfile(conn);
  const services = isRecord(out.services) ? out.services : {};
  for (const svc of Object.values(services)) {
    if (!isRecord(svc)) continue;
    for (const profile of arr(svc.profiles)) if (isRecord(profile)) redactProfile(profile);
  }
  return out;
}
export function restoreCatalogSecrets(proposed: Json, current: Json): Json {
  const out = JSON.parse(JSON.stringify(proposed)) as Json;
  const currentConnections = new Map<string, Json>();
  for (const conn of arr(current.connections)) if (isRecord(conn) && conn.id) currentConnections.set(String(conn.id), conn);
  for (const conn of arr(out.connections)) {
    if (!isRecord(conn)) continue;
    const cur = currentConnections.get(String(conn.id));
    if (cur) {
      for (const [key, value] of Object.entries(conn)) {
        if (key === "extra_headers" || isSecretField(key)) conn[key] = restoreValue(value, cur[key]);
      }
    }
  }
  const currentServices = isRecord(current.services) ? current.services : {};
  for (const [service, svcRaw] of Object.entries(isRecord(out.services) ? out.services : {})) {
    if (!isRecord(svcRaw)) continue;
    const curSvc = isRecord(currentServices[service]) ? currentServices[service] : {};
    const profiles = new Map<string, Json>();
    for (const p of arr(curSvc.profiles)) if (isRecord(p) && p.id) profiles.set(String(p.id), p);
    for (const profile of arr(svcRaw.profiles)) {
      if (!isRecord(profile)) continue;
      const cur = profiles.get(String(profile.id));
      if (!cur) continue;
      for (const [key, value] of Object.entries(profile)) {
        if (key === "extra_headers" || isSecretField(key)) profile[key] = restoreValue(value, cur[key]);
      }
    }
  }
  return out;
}
export function redactDraft(draft: Json | null): Json | null {
  if (!draft) return null;
  const out = { ...draft };
  if (isRecord(out.catalog)) out.catalog = redactCatalog(out.catalog);
  return out;
}
export function mergeDraftSecrets(proposed: Json, stored: Json, live: Json): Json {
  const merged = JSON.parse(JSON.stringify(proposed)) as Json;
  if (!isRecord(merged.catalog)) return merged;
  let catalog = merged.catalog;
  if (isRecord(stored.catalog)) catalog = restoreCatalogSecrets(catalog, stored.catalog);
  merged.catalog = restoreCatalogSecrets(catalog, live);
  return merged;
}

// ---------------------------------------------------------------------------
// Readiness / profile
// ---------------------------------------------------------------------------

const SERVICE_LABELS: Record<string, string> = {
  llm: "Chat model", task: "Task model", embedding: "Embedding model",
  search: "Web search", tts: "Text to speech", stt: "Speech to text",
  imagegen: "Image generation", videogen: "Video generation",
};
function row(id: string, section: string, label: string, state: string, detail: string, enabled = false, available = false, configured = false, verified = false, required = false) {
  return { id, section, label, state, detail_code: detail, enabled, available, configured, verified, required };
}
export function buildReadiness(settings: Settings = getSettings()): Json {
  const catalog = loadCatalog(settings);
  const services = isRecord(catalog.services) ? catalog.services : {};
  const rows: Json[] = [];
  for (const [name, label] of Object.entries(SERVICE_LABELS)) {
    const svc = isRecord(services[name]) ? services[name] : {};
    const profiles = arr(svc.profiles);
    const activeId = svc.active_profile_id;
    if (!activeId) {
      rows.push(row(`catalog.${name}`, "catalog", label, "not_selected", "active_profile_not_selected", false, profiles.length > 0, false, false, name === "llm"));
      continue;
    }
    const profile = profiles.find((p) => isRecord(p) && p.id === activeId);
    if (!profile) {
      rows.push(row(`catalog.${name}`, "catalog", label, "misconfigured", "active_profile_missing", true, false, false, false, name === "llm"));
      continue;
    }
    const models = arr(isRecord(profile) ? profile.models : []);
    const modelId = svc.active_model_id ?? catalog.llm_selection?.model_id;
    const model = models.find((m) => isRecord(m) && (m.id === modelId || m.model === modelId));
    const configured = Boolean(isRecord(profile) && (profile.api_key || profile.connection_id));
    const verified = Boolean(model);
    rows.push(row(`catalog.${name}`, "catalog", label, verified ? "enabled_verified" : configured ? "available_disabled" : "misconfigured", verified ? "configuration_verified" : modelId ? "active_model_missing" : "active_model_not_selected", true, true, configured, verified, name === "llm"));
  }
  const dp = loadDocumentParsing(settings);
  const engine = String(dp.engine ?? "text_only");
  rows.push(row("parser.selected", "documents", "Selected parser", engine === "text_only" ? "enabled_verified" : "available_disabled", engine === "text_only" ? "configuration_verified" : "not_configured", true, true, engine === "text_only", engine === "text_only", true));
  const kbRows = database.list_items(settings, "knowledge-bases");
  rows.push(row("knowledge", "knowledge", "Knowledge bases", kbRows.length ? "enabled_verified" : "not_selected", kbRows.length ? "knowledge_base_ready" : "no_knowledge_base", kbRows.length > 0, true, kbRows.length > 0, kbRows.length > 0, false));
  return { schema_version: "deeptutor.settings-readiness/v2", generated_at: new Date().toISOString(), rows, summary: { blockers: rows.filter((r) => r.required && !r.verified).length, warnings: rows.filter((r) => !r.required && r.enabled && !r.verified).length, suggestions: 0 } };
}

function publicValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(publicValue);
  if (isRecord(v)) {
    const out: Json = {};
    for (const [k, x] of Object.entries(v)) {
      const key = k.toLowerCase();
      if (["api_key", "apikey", "api_token", "extra_headers", "password", "secret", "token", "proxy"].some((h) => key.includes(h) || key === "token" || key.endsWith("_token"))) {
        out[k] = { present: Boolean(x) };
      } else if (["url", "endpoint", "path", "host", "origin", "port", "dir"].some((h) => key === h || key.endsWith(`_${h}`)) || key.startsWith("cors_")) {
        out[k] = null;
      } else out[k] = publicValue(x);
    }
    return out;
  }
  return v;
}
export function exportProfile(settings: Settings = getSettings()): Json {
  const catalog = loadCatalog(settings);
  const services = isRecord(catalog.services) ? catalog.services : {};
  const publicServices: Json = {};
  for (const [name, svcRaw] of Object.entries(services)) {
    if (!isRecord(svcRaw)) continue;
    publicServices[name] = {
      active_profile_id: svcRaw.active_profile_id ?? null,
      active_model_id: svcRaw.active_model_id ?? null,
      profiles: arr(svcRaw.profiles).filter(isRecord).map((p) => {
        const out: Json = {};
        for (const key of ["id", "name", "binding", "provider", "connection_id", "api_format", "wire_api", "api_version", "provider_only"]) if (p[key] !== undefined) out[key] = p[key];
        for (const key of ["api_key", "token", "proxy", "extra_headers"]) if (p[key] !== undefined) out[key] = { present: Boolean(p[key]) };
        if (Array.isArray(p.models)) out.models = p.models.filter(isRecord).map((m) => ({ id: m.id, name: m.name, model: m.model, dimension: m.dimension, capabilities: m.capabilities, voice: m.voice }));
        return out;
      }),
    };
  }
  return { schema_version: "deeptutor.settings-profile/v1", generated_at: new Date().toISOString(), profile: { settings: { system: publicValue(loadSystem(settings)), auth: publicValue(loadAuth(settings)), integrations: publicValue(loadIntegrations(settings)), document_parsing: publicValue(loadDocumentParsing(settings)), catalog: { services: publicServices } } } };
}
export function reviewProfileImport(payload: Json): Json {
  const profile = isRecord(payload.profile) ? payload.profile : {};
  const settings = isRecord(profile.settings) ? profile.settings : {};
  const current = exportProfile().profile.settings as Json;
  const changes: Json[] = [];
  const unsupported: Json[] = [];
  function diff(proposed: unknown, currentValue: unknown, path: string) {
    if (isRecord(proposed)) {
      if (!isRecord(currentValue)) { unsupported.push({ path, reason: "type_mismatch" }); return; }
      for (const [k, v] of Object.entries(proposed)) {
        const p = path ? `${path}.${k}` : k;
        const key = k.toLowerCase();
        if (["api_key", "apikey", "api_token", "extra_headers", "password", "secret", "token", "proxy"].some((h) => key.includes(h))) {
          if (isRecord(v) && typeof v.present === "boolean" && isRecord(currentValue[k])) continue;
          unsupported.push({ path: p, reason: "secret_not_exported" }); continue;
        }
        if (["url", "endpoint", "path", "host", "origin", "port", "dir"].some((h) => key === h || key.endsWith(`_${h}`)) || key.startsWith("cors_")) {
          unsupported.push({ path: p, reason: "deployment_value_not_exported" }); continue;
        }
        if (!(k in currentValue)) { unsupported.push({ path: p, reason: "unknown_field" }); continue; }
        diff(v, currentValue[k], p);
      }
    } else if (Array.isArray(proposed)) {
      if (!Array.isArray(currentValue)) unsupported.push({ path, reason: "type_mismatch" });
      else if (JSON.stringify(proposed) !== JSON.stringify(currentValue)) changes.push({ path, proposed: publicValue(proposed), current: publicValue(currentValue) });
    } else if (JSON.stringify(proposed) !== JSON.stringify(currentValue)) {
      changes.push({ path, proposed: publicValue(proposed), current: publicValue(currentValue) });
    }
  }
  for (const [section, value] of Object.entries(settings)) diff(value, (current as Json)[section], section);
  return { schema_version: payload.schema_version ?? "deeptutor.settings-profile/v1", changes, unsupported, review_only: true };
}

// Keep TypeScript from considering arr unused in some builds.
void arr;
