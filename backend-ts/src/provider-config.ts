// Port of backend/app/provider_config.py — Praxis-owned provider / model
// configuration.
//
// This module is the *only* source of truth for which providers and models the
// Settings UI features and which model a turn actually runs. Nothing here reads
// `~/.vtx` — the vtx SDK is used purely as an execution engine. Callers pass
// the resolved provider / model / base_url / api_key into vtx explicitly (see
// `agent/runtime.py`), so vtx never needs to consult its own config for model
// selection.
//
// Persistence lives in the shared SQLite database (`data/praxis.sqlite3`)
// under the `settings/catalog` and `settings/selection` keys. Older releases
// kept them in `settings-catalog.json` / `settings.json`; those files are
// imported once by `store/database.ts` and are no longer read or written.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Settings } from "./config.js";
import { get_settings as _config_get_settings } from "./config.js";
import * as database from "./store/database.js";
import { lookup_model_metadata } from "./model-metadata.js";

export const SERVICES = [
  "llm",
  "task",
  "embedding",
  "search",
  "tts",
  "stt",
  "imagegen",
  "videogen",
] as const;

const _HEADERS: Record<string, string> = {
  "User-Agent": "Praxis/0.1",
};
const _RECENT_LIMIT = 20;
const _PROBE_TIMEOUT_MS = 20_000;

type AnyDict = Record<string, any>;

// ---------------------------------------------------------------------------
// Built-in presets — loaded from Praxis's own catalog file. No vtx import.
// ---------------------------------------------------------------------------

const _CATALOG_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "provider-catalog.json",
);

/** Normalize provider_catalog.json into the preset shape used below. */
function _load_presets(): Record<string, AnyDict> {
  let entries: AnyDict[] = [];
  try {
    const raw = JSON.parse(readFileSync(_CATALOG_FILE, "utf-8"));
    entries = Array.isArray(raw?.providers) ? raw.providers : [];
  } catch {
    entries = [];
  }
  const presets: Record<string, AnyDict> = {};
  for (const entry of entries) {
    const slug = String(entry?.slug ?? "").trim().toLowerCase();
    if (!slug) continue;
    const family = String(entry?.family ?? "openai_compat");
    const env = entry?.api_key_env ?? "";
    presets[slug] = {
      slug,
      label: String(entry?.display_name ?? slug),
      description: String(entry?.description ?? ""),
      base_url: String(entry?.base_url ?? ""),
      api_format: family === "anthropic" ? "anthropic" : "openai_chat",
      family,
      api_key_env: env ? String(env) : "",
      known_models: (Array.isArray(entry?.known_models) ? entry.known_models : []).map(
        (m: unknown) => String(m),
      ),
      supports_vision: Boolean(entry?.supports_vision ?? false),
      supports_thinking: Boolean(entry?.supports_thinking ?? false),
      api_key_optional: Boolean(entry?.api_key_optional ?? false),
      is_local: Boolean(entry?.is_local ?? false),
      headers: isRecord(entry?.headers) ? { ...entry.headers } : {},
      openmodelendpoint: Boolean(entry?.openmodelendpoint ?? false),
      fetch_models: Boolean(entry?.fetch_models ?? false),
      models_endpoint: String(entry?.models_endpoint ?? "/models"),
      model_parser: isRecord(entry?.model_parser) ? { ...entry.model_parser } : {},
      services: Array.isArray(entry?.services) && entry.services.length
        ? entry.services.map((s: unknown) => String(s))
        : ["llm"],
    };
  }
  return presets;
}

const _BUILTIN = _load_presets();

// Provider slugs whose wire protocol vtx must not infer from the model name.
const _anthropic_slugs = new Set(["anthropic", "aerolink"]);
const _responses_slugs = new Set(["openai-responses", "codex", "openai-codex"]);

export function builtin_preset(slug: string | null | undefined): AnyDict | null {
  if (!slug) return null;
  return _BUILTIN[slug.trim().toLowerCase()] ?? null;
}

export function builtin_presets(): Record<string, AnyDict> {
  return _BUILTIN;
}

export function preset_api_key(slug: string | null | undefined): string {
  // API key for a built-in preset from its conventional env var.
  return _env_key(builtin_preset(slug));
}

// ---------------------------------------------------------------------------
// Catalog IO — Praxis's own files
// ---------------------------------------------------------------------------

function _read_state(settings: Settings, key: string): AnyDict {
  const data = database.get_state(settings, key, {});
  return isRecord(data) ? data : {};
}

function _write_state(settings: Settings, key: string, data: AnyDict): void {
  database.put_state(settings, key, data);
}

export function default_catalog(): AnyDict {
  return {
    version: 1,
    connections: [],
    recent_models: [],
    llm_selection: null,
    services: Object.fromEntries(
      SERVICES.map((name) => [
        name,
        { active_profile_id: null, profiles: [] },
      ]),
    ),
  };
}

export function load_catalog(settings: Settings): AnyDict {
  const data = _read_state(settings, "settings/catalog");
  const source = Object.keys(data).length ? data : default_catalog();
  // Fill missing top-level keys so old catalogs keep working.
  const defaults = default_catalog();
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in source)) source[key] = value;
  }
  if (!isRecord(source["services"])) source["services"] = {};
  const services = source["services"] as AnyDict;
  for (const [name, svc] of Object.entries(defaults["services"] as AnyDict)) {
    if (!isRecord(services[name])) services[name] = {};
    const bucket = services[name] as AnyDict;
    for (const [key, value] of Object.entries(svc as AnyDict)) {
      if (!(key in bucket)) bucket[key] = value;
    }
  }
  return source;
}

export function save_catalog(settings: Settings, catalog: AnyDict): void {
  _write_state(settings, "settings/catalog", catalog);
}

// ---------------------------------------------------------------------------
// Active LLM selection
// ---------------------------------------------------------------------------

function _clean_selection(value: unknown): AnyDict | null {
  if (!isRecord(value)) return null;
  const profileId = String(value["profile_id"] ?? "").trim();
  const modelId = String(value["model_id"] ?? "").trim();
  if (!profileId || !modelId) return null;
  const sel: AnyDict = { profile_id: profileId, model_id: modelId };
  const effort = value["reasoning_effort"];
  if (effort) sel["reasoning_effort"] = effort;
  return sel;
}

export function get_selection(
  settings: Settings,
  override?: unknown,
): AnyDict | null {
  // Resolve the active selection: explicit override → catalog → legacy file.
  let sel = _clean_selection(override);
  if (sel) return sel;
  const catalog = load_catalog(settings);
  sel = _clean_selection(catalog["llm_selection"]);
  if (sel) return sel;
  sel = _clean_selection(
    _read_state(settings, "settings/selection")["llm_selection"],
  );
  return sel;
}

export function set_selection(
  settings: Settings,
  selection: unknown,
): AnyDict | null {
  // Persist the active selection and update recency.
  const sel = _clean_selection(selection);
  if (sel === null) return null;
  const catalog = load_catalog(settings);
  catalog["llm_selection"] = sel;
  const recentRaw = Array.isArray(catalog["recent_models"])
    ? catalog["recent_models"]
    : [];
  const recent = recentRaw.filter(
    (item) =>
      !(
        isRecord(item) &&
        item["profile_id"] === sel["profile_id"] &&
        item["model_id"] === sel["model_id"]
      ),
  );
  recent.unshift({ ...sel });
  catalog["recent_models"] = recent.slice(0, _RECENT_LIMIT);
  save_catalog(settings, catalog);

  // Keep the selection also under its own key: cheap to read when only the
  // active model is needed, and it survives a catalog reset.
  _write_state(settings, "settings/selection", { llm_selection: sel });
  return sel;
}

// recent_pairs encodes each (profile_id, model_id) tuple as a JSON string so
// ids containing separators round-trip safely.
export function recent_pairs(settings: Settings): Set<string> {
  const catalog = load_catalog(settings);
  const out = new Set<string>();
  const recent = Array.isArray(catalog["recent_models"])
    ? catalog["recent_models"]
    : [];
  for (const item of recent) {
    if (
      isRecord(item) &&
      item["profile_id"] &&
      item["model_id"]
    ) {
      out.add(
        JSON.stringify([String(item["profile_id"]), String(item["model_id"])]),
      );
    }
  }
  return out;
}

export function is_recent_option(
  recent: Set<string>,
  profile_id: string,
  model_id: string,
  provider: string,
  wire_model: string,
): boolean {
  // A recent entry may predate the catalog's generated ids.
  if (recent.has(JSON.stringify([profile_id, model_id]))) return true;
  for (const entry of recent) {
    let pair: unknown;
    try {
      pair = JSON.parse(entry);
    } catch {
      continue;
    }
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [entryProvider, entryModel] = pair.map(String);
    if (
      entryProvider === provider &&
      (entryModel === model_id || entryModel === wire_model)
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Runtime resolution — what actually gets sent to vtx
// ---------------------------------------------------------------------------

function _find_profile(catalog: AnyDict, profile_id: string): AnyDict | null {
  const services = isRecord(catalog["services"]) ? catalog["services"] : {};
  for (const service of SERVICES) {
    const svc = isRecord(services[service]) ? services[service] : {};
    const profiles = Array.isArray(svc["profiles"]) ? svc["profiles"] : [];
    for (const profile of profiles) {
      if (isRecord(profile) && profile["id"] === profile_id) {
        return profile;
      }
    }
  }
  return null;
}

function _find_connection(
  catalog: AnyDict,
  connection_id: unknown,
): AnyDict | null {
  if (!connection_id) return null;
  const connections = Array.isArray(catalog["connections"])
    ? catalog["connections"]
    : [];
  for (const conn of connections) {
    if (isRecord(conn) && conn["id"] === connection_id) {
      return conn;
    }
  }
  return null;
}

function _connection_for_provider(
  catalog: AnyDict,
  provider: string,
): AnyDict | null {
  const connections = Array.isArray(catalog["connections"])
    ? catalog["connections"]
    : [];
  for (const conn of connections) {
    if (isRecord(conn) && conn["provider"] === provider) {
      return conn;
    }
  }
  return null;
}

function _env_key(preset: AnyDict | null | undefined): string {
  if (!preset) return "";
  const name = preset["api_key_env"] ?? "";
  return name ? String(process.env[String(name)] ?? "").trim() : "";
}

function _vtx_provider_slug(provider: string, api_format: unknown): string {
  // Pick the provider label vtx uses to choose a wire protocol.
  //
  // Known slugs stay as-is; unknown custom endpoints are mapped from the
  // declared API format so vtx does not guess the wrong SDK.
  const slug = (provider ?? "").trim() || "openai";
  const fmt = String(api_format ?? "auto").trim().toLowerCase();
  if (fmt === "anthropic" && !_anthropic_slugs.has(slug)) {
    return "anthropic";
  }
  if (fmt === "openai_responses" && !_responses_slugs.has(slug)) {
    return "openai-responses";
  }
  return slug;
}

export function resolve_runtime_model(
  settings: Settings,
  command?: AnyDict | null,
): AnyDict {
  // Return everything needed to build a vtx runtime, from Praxis data.
  //
  // Keys: provider, model, base_url, api_key, thinking_level, profile_id,
  // model_id, source. `provider` is a vtx-compatible label; `model` is the
  // wire model id. Never reads ~/.vtx.
  const cmd = command ?? {};
  const selection = get_selection(settings, cmd["llm_selection"]);
  const catalog = load_catalog(settings);

  const profileId = String(selection?.["profile_id"] ?? "") || "";
  const modelId = String(selection?.["model_id"] ?? "") || "";
  // Legacy/raw commands can still carry model_provider + model directly.
  const providerHint = String(cmd["model_provider"] ?? "").trim();
  const modelHint = String(cmd["model"] ?? "").trim();

  let preset = builtin_preset(profileId);
  let thinking =
    String(selection?.["reasoning_effort"] ?? "").trim() || null;

  let providerRaw: string;
  let baseUrl: string;
  let apiKey: string;
  let apiFormat: unknown;
  let model: string;
  let source: string;

  if (profileId) {
    const profile = _find_profile(catalog, profileId);
    if (profile) {
      let modelEntry: AnyDict = {};
      const models = Array.isArray(profile["models"]) ? profile["models"] : [];
      for (const m of models) {
        if (isRecord(m) && String(m["id"]) === modelId) {
          modelEntry = m;
          break;
        }
      }
      // Connections can be linked at the profile level (provider_ref, which
      // also carries default_base_url) or from the model's provider_ref (the
      // settings UI uses the latter for synced models). First non-empty wins,
      // matching resolveDraftConfig's refRaw rule.
      const modelRef = isRecord(modelEntry["provider_ref"])
        ? modelEntry["provider_ref"]
        : {};
      const profileRef = isRecord(profile["provider_ref"])
        ? profile["provider_ref"]
        : {};
      const refRaw =
        Object.keys(modelRef).length > 0 ? modelRef : profileRef;
      const conn =
        _find_connection(catalog, profile["connection_id"]) ??
        _find_connection(catalog, refRaw["connection_id"]);
      // Empty strings are "unset" here: a profile linked to a connection via
      // provider_ref inherits base_url/api_key/api_format from it, and `??`
      // would keep the profile's "" instead of falling through.
      providerRaw = String(
        profile["binding"] ||
          profile["provider"] ||
          conn?.["provider"] ||
          "openai",
      );
      baseUrl = String(
        profile["base_url"] ||
          conn?.["base_url"] ||
          refRaw["default_base_url"] ||
          "",
      ).trim();
      apiKey = String(
        profile["api_key"] || conn?.["api_key"] || "",
      ).trim();
      apiFormat =
        profile["api_format"] || conn?.["api_format"] || refRaw["api_format"];
      model = String(modelEntry["model"] || modelHint || modelId);
      thinking =
        thinking ??
        (String(modelEntry["reasoning_effort"] ?? "").trim() || null);
      source = `profile:${profileId}`;
    } else if (preset !== null) {
      presetBranch();
    } else if (providerHint) {
      providerHintBranch();
    } else {
      defaultBranch();
    }
  } else if (preset !== null) {
    presetBranch();
  } else if (providerHint) {
    providerHintBranch();
  } else {
    defaultBranch();
  }

  function presetBranch(): void {
    // A model chosen from the built-in preset list (e.g. env-key usage).
    const conn = _connection_for_provider(catalog, profileId);
    providerRaw = profileId;
    baseUrl = String(conn?.["base_url"] || preset?.["base_url"] || "").trim();
    apiKey = String(conn?.["api_key"] || _env_key(preset) || "").trim();
    apiFormat = preset?.["api_format"];
    model = modelHint || modelId;
    source = `preset:${profileId}`;
  }

  function providerHintBranch(): void {
    const conn = _connection_for_provider(catalog, providerHint);
    preset = builtin_preset(providerHint);
    providerRaw = providerHint;
    baseUrl = String(
      conn?.["base_url"] || preset?.["base_url"] || "",
    ).trim();
    apiKey = String(conn?.["api_key"] || _env_key(preset) || "").trim();
    apiFormat = preset?.["api_format"];
    model = modelHint || modelId || String(settings.default_model ?? "");
    source = "command";
  }

  function defaultBranch(): void {
    providerRaw = "openai";
    baseUrl = "";
    apiKey = "";
    apiFormat = null;
    model = modelHint || modelId || String(settings.default_model ?? "");
    source = "default";
  }

  // TS definite-assignment: every branch above assigns all five.
  return {
    provider: _vtx_provider_slug(providerRaw!, apiFormat),
    model: model!,
    base_url: baseUrl! || null,
    api_key: apiKey! || null,
    thinking_level: thinking,
    profile_id: profileId,
    model_id: modelId,
    source: source!,
  };
}

// ---------------------------------------------------------------------------
// UI-facing option builders
// ---------------------------------------------------------------------------

interface OptionArgs {
  profile_name: string;
  provider_label: string;
  model_name?: string | null;
  model?: string | null;
  provider?: string | null;
  supports_vision?: boolean;
  supports_thinking?: boolean;
  context_window?: unknown;
  reasoning_efforts?: unknown;
  declared_reasoning?: boolean;
  is_active_default?: boolean;
  is_recent?: boolean;
}

function _option(profile_id: string, model_id: string, args: OptionArgs): AnyDict {
  const opt: AnyDict = {
    profile_id,
    model_id,
    profile_name: args.profile_name,
    model_name: args.model_name ?? args.model ?? model_id,
    model: args.model ?? model_id,
    provider: args.provider ?? profile_id,
    provider_label: args.provider_label,
    supports_vision: Boolean(args.supports_vision),
    supports_thinking: Boolean(args.supports_thinking),
    is_active_default: Boolean(args.is_active_default),
  };
  const contextWindow = args.context_window;
  if (typeof contextWindow === "number" && contextWindow) {
    opt["context_window"] = Math.trunc(contextWindow);
  } else if (
    typeof contextWindow === "string" &&
    /^\d+$/.test(contextWindow.trim())
  ) {
    opt["context_window"] = Number.parseInt(contextWindow.trim(), 10);
  }
  if (Array.isArray(args.reasoning_efforts) && args.reasoning_efforts.length) {
    opt["supported_reasoning_efforts"] = args.reasoning_efforts.map((x) =>
      String(x),
    );
  }
  if (args.declared_reasoning) {
    opt["declared_reasoning"] = true;
  }
  if (args.is_recent) {
    opt["is_recent"] = true;
  }

  // vtx's models.dev metadata is authoritative for limits and effort levels.
  // Keep it under distinct keys so the UI can prefer it while a manually
  // entered catalog value remains an explicit override.
  const vtx = vtx_model_metadata(String(args.model ?? model_id));
  if (vtx) {
    opt["vtx_context_window"] = vtx["context_window"];
    opt["vtx_max_tokens"] = vtx["max_tokens"];
    opt["vtx_supported_reasoning_efforts"] =
      vtx["supported_reasoning_efforts"];
    opt["vtx_capabilities"] = {
      reasoning: vtx["supports_reasoning"],
      vision: vtx["supports_vision"],
      tools: vtx["supports_tools"],
      audio: vtx["supports_audio"],
    };
    if (!opt["context_window"]) {
      opt["context_window"] = vtx["context_window"];
    }
    if (!opt["supported_reasoning_efforts"]) {
      opt["supported_reasoning_efforts"] =
        vtx["supported_reasoning_efforts"];
    }
  }
  return opt;
}

export function model_options(settings: Settings): AnyDict[] {
  // Every model the Settings/composer UI should feature, from our catalog.
  //
  // Saved profiles win; built-in presets fill in when a profile has no saved
  // models so a fresh install can still pick a model.
  const catalog = load_catalog(settings);
  const selection = get_selection(settings);
  const recent = recent_pairs(settings);
  let activeKey = "";
  if (selection) {
    activeKey = `${selection["profile_id"]}:${selection["model_id"]}`;
  }
  const options: AnyDict[] = [];
  const seen = new Set<string>();

  const services = isRecord(catalog["services"]) ? catalog["services"] : {};
  const llm = isRecord(services["llm"]) ? services["llm"] : {};
  const profiles = Array.isArray(llm["profiles"]) ? llm["profiles"] : [];
  for (const profile of profiles) {
    if (!isRecord(profile)) continue;
    const pid = String(profile["id"] ?? "");
    if (!pid) continue;
    let conn = _find_connection(catalog, profile["connection_id"]);
    if (conn === null) {
      const models = Array.isArray(profile["models"])
        ? profile["models"]
        : [];
      for (const m of models) {
        conn = _find_connection(
          catalog,
          isRecord(m) && isRecord(m["provider_ref"])
            ? m["provider_ref"]["connection_id"]
            : undefined,
        );
        if (conn !== null) break;
      }
    }
    const providerSlug = String(
      profile["binding"] ?? profile["provider"] ?? conn?.["provider"] ?? "",
    );
    const preset = builtin_preset(providerSlug);
    const label = String(
      profile["display_name"] ??
        profile["name"] ??
        preset?.["label"] ??
        pid,
    );
    const models = Array.isArray(profile["models"]) ? profile["models"] : [];
    for (const m of models) {
      if (!isRecord(m)) continue;
      const mid = String(m["id"] ?? "");
      if (!mid) continue;
      const key = JSON.stringify([pid, mid]);
      if (seen.has(key)) continue;
      seen.add(key);
      const caps = isRecord(m["capabilities"]) ? m["capabilities"] : {};
      const efforts =
        m["supported_reasoning_efforts"] ??
        m["codex_supported_reasoning_levels"];
      const wireModel = String(m["model"] ?? m["name"] ?? mid);
      options.push(
        _option(pid, mid, {
          profile_name: label,
          provider_label: label,
          model_name: String(m["name"] ?? wireModel),
          model: wireModel,
          provider: providerSlug || pid,
          supports_vision: Boolean(
            caps["vision"] ?? preset?.["supports_vision"],
          ),
          supports_thinking: Boolean(
            caps["reasoning"] ?? preset?.["supports_thinking"],
          ),
          context_window:
            m["context_window_tokens"] ?? m["context_window"],
          reasoning_efforts: efforts,
          declared_reasoning: Boolean(caps["reasoning"]),
          is_active_default: `${pid}:${mid}` === activeKey,
          is_recent: is_recent_option(recent, pid, mid, providerSlug, wireModel),
        }),
      );
    }
  }

  // Preset fallback for slugs with no saved profile (env-key usage). Only
  // models the learner has actually picked are surfaced — an unconfigured
  // built-in preset must not fill the composer with OpenAI/Gemini/xAI rows.
  for (const [slug, preset] of Object.entries(_BUILTIN)) {
    const conn = _connection_for_provider(catalog, slug);
    if (
      conn &&
      profiles.some(
        (p) =>
          isRecord(p) &&
          String(p["binding"] ?? p["provider"] ?? "").toLowerCase() === slug,
      )
    ) {
      continue;
    }
    const knownModels = Array.isArray(preset["known_models"])
      ? preset["known_models"]
      : [];
    for (const midRaw of knownModels) {
      const mid = String(midRaw);
      const key = JSON.stringify([slug, mid]);
      if (seen.has(key)) continue;
      const isRecent = is_recent_option(recent, slug, mid, slug, mid);
      if (!isRecent) continue;
      seen.add(key);
      options.push(
        _option(slug, mid, {
          profile_name: String(preset["label"] ?? slug),
          provider_label: String(preset["label"] ?? slug),
          supports_vision: Boolean(preset["supports_vision"]),
          supports_thinking: Boolean(preset["supports_thinking"]),
          is_active_default: `${slug}:${mid}` === activeKey,
          is_recent: true,
        }),
      );
    }
  }
  return options;
}

export function provider_options(settings: Settings): AnyDict[] {
  // Provider rows for the Connections page — our presets + saved ones.
  const catalog = load_catalog(settings);
  const options: AnyDict[] = [];
  const seen = new Set<string>();

  function add(
    slug: string,
    label: string,
    base_url: string,
    default_model: string | null,
    vision = false,
    thinking = false,
  ): void {
    if (seen.has(slug)) return;
    seen.add(slug);
    options.push({
      value: slug,
      label,
      base_url,
      default_model,
      auth_mode: "api_key",
      api_key_env: builtin_preset(slug)?.["api_key_env"],
      supports_vision: Boolean(vision),
      supports_thinking: Boolean(thinking),
      status: "supported",
    });
  }

  const connections = Array.isArray(catalog["connections"])
    ? catalog["connections"]
    : [];
  for (const conn of connections) {
    if (!isRecord(conn)) continue;
    const slug = String(conn["provider"] ?? "").trim();
    if (!slug) continue;
    const preset = builtin_preset(slug) ?? {};
    add(
      slug,
      String(conn["name"] ?? preset["label"] ?? slug),
      String(conn["base_url"] ?? ""),
      null,
      Boolean(preset["supports_vision"]),
      Boolean(preset["supports_thinking"]),
    );
  }

  for (const [slug, preset] of Object.entries(_BUILTIN)) {
    const known = Array.isArray(preset["known_models"])
      ? preset["known_models"]
      : [];
    add(
      slug,
      String(preset["label"] ?? slug),
      String(preset["base_url"] ?? ""),
      known.length ? String(known[0]) : null,
      Boolean(preset["supports_vision"]),
      Boolean(preset["supports_thinking"]),
    );
  }
  return options;
}

export function connection_targets(settings: Settings): AnyDict[] {
  // Per-provider prefills for the Connections page.
  const catalog = load_catalog(settings);
  const targets: AnyDict[] = [];
  const seen = new Set<string>();

  function add(
    slug: string,
    label: string,
    base_url: string,
    models: unknown[],
    services: readonly string[],
  ): void {
    if (seen.has(slug)) return;
    seen.add(slug);
    targets.push({
      provider: slug,
      label,
      default_base_url: base_url,
      services: Object.fromEntries(
        services.map((service) => [
          service,
          {
            provider: slug,
            base_url,
            default_model: models.length ? String(models[0]) : "",
          },
        ]),
      ),
    });
  }

  const connections = Array.isArray(catalog["connections"])
    ? catalog["connections"]
    : [];
  for (const conn of connections) {
    if (!isRecord(conn)) continue;
    const slug = String(conn["provider"] ?? "").trim();
    if (!slug) continue;
    const preset = builtin_preset(slug) ?? {};
    add(
      slug,
      String(conn["name"] ?? preset["label"] ?? slug),
      String(conn["base_url"] ?? ""),
      Array.isArray(preset["known_models"]) ? preset["known_models"] : [],
      Array.isArray(preset["services"]) && preset["services"].length
        ? preset["services"].map(String)
        : ["llm"],
    );
  }

  for (const [slug, preset] of Object.entries(_BUILTIN)) {
    add(
      slug,
      String(preset["label"] ?? slug),
      String(preset["base_url"] ?? ""),
      Array.isArray(preset["known_models"]) ? preset["known_models"] : [],
      Array.isArray(preset["services"]) && preset["services"].length
        ? preset["services"].map(String)
        : ["llm"],
    );
  }
  return targets;
}

export function vtx_model_metadata(
  model_id: string,
): AnyDict | null {
  // Authoritative model limits/efforts from models.dev metadata — the same
  // table vtx's `context_length_manager` serves (vendored as
  // src/model-metadata.json; see src/model-metadata.ts).
  //
  // Returns `null` when there are no verified limits for this id. Local
  // catalog values remain explicit user overrides; everything else comes
  // from models.dev.
  if (!model_id) return null;
  return lookup_model_metadata(model_id);
}

export function context_window_for(
  profile_id: string,
  model_id: string,
): number {
  // Context window for the composer's token bar, from our own catalog.
  const settings = _config_get_settings();
  const catalog = load_catalog(settings);
  const profile = _find_profile(catalog, profile_id);
  if (profile) {
    const models = Array.isArray(profile["models"]) ? profile["models"] : [];
    for (const m of models) {
      if (isRecord(m) && String(m["id"]) === model_id) {
        const value = m["context_window_tokens"] ?? m["context_window"];
        const n = Number.parseInt(String(value ?? "").trim(), 10);
        return Number.isFinite(n) ? n : 0;
      }
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Live model discovery (no vtx fetchers, no ~/.vtx caches)
// ---------------------------------------------------------------------------

/**
 * Parse a provider's /models payload into normalized model rows.
 *
 * Supports the catalog's `model_parser` options: `array_path`,
 * `flatten_field`, `id_field`, `name_field`, `context_field` and
 * `output_field`. Defaults match the OpenAI shape.
 */
function _extract_models(payload: unknown, parser?: AnyDict | null): AnyDict[] {
  const p = parser ?? {};
  const arrayPath = String(p["array_path"] ?? "data");
  const flattenField = p["flatten_field"];
  const idField = String(p["id_field"] ?? "id");
  const nameField = String(p["name_field"] ?? "name");
  const contextField = String(p["context_field"] ?? "context_length");
  const outputField = String(p["output_field"] ?? "max_completion_tokens");

  let items: unknown = payload;
  if (isRecord(payload)) {
    if (flattenField) {
      items = payload[String(flattenField)];
      if (items === undefined || items === null) {
        const root = payload["data"] ?? payload["models"] ?? {};
        items = isRecord(root) ? root[String(flattenField)] : undefined;
      }
    } else {
      items =
        payload[arrayPath] ?? payload["models"] ?? payload["data"];
    }
  }
  if (!Array.isArray(items)) return [];

  const out: AnyDict[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    let mid: string;
    let name: string;
    let raw: AnyDict = {};
    if (typeof item === "string") {
      mid = item.trim();
      name = item.trim();
    } else if (isRecord(item)) {
      mid = String(
        item[idField] ?? item["id"] ?? item["model_id"] ?? "",
      ).trim();
      name = String(item[nameField] ?? item["name"] ?? mid);
      raw = item;
    } else {
      continue;
    }
    if (!mid || seen.has(mid)) continue;
    seen.add(mid);
    const row: AnyDict = { id: mid, name };
    for (const [key, field] of [
      ["context_window", contextField],
      ["max_tokens", outputField],
    ] as const) {
      const value = isRecord(raw) ? raw[field] : undefined;
      if (typeof value === "number" && value > 0) {
        row[key] = Math.trunc(value);
      }
    }
    out.push(row);
  }
  return out;
}

export async function probe_models(
  base_url: string,
  api_key?: string | null,
  api_format?: string | null,
  preset?: AnyDict | null,
): Promise<AnyDict> {
  // GET the provider's models endpoint directly (no vtx fetchers/caches).
  const base = (base_url ?? "").trim().replace(/\/+$/, "");
  if (!base) {
    return { status: "unreachable", models: [], http_status: null };
  }
  if (!/^https?:\/\//i.test(base)) {
    return { status: "invalid_url", models: [], http_status: null };
  }

  const p = preset ?? {};
  const headers: Record<string, string> = { ..._HEADERS };
  const presetHeaders = isRecord(p["headers"]) ? p["headers"] : {};
  for (const [key, value] of Object.entries(presetHeaders)) {
    headers[String(key)] = String(value);
  }
  const fmt = String(api_format ?? p["api_format"] ?? "").trim().toLowerCase();
  if (api_key) {
    if (fmt === "anthropic") {
      headers["x-api-key"] = api_key;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${api_key}`;
    }
  }

  let endpoint = String(p["models_endpoint"] ?? "");
  if (!endpoint) {
    endpoint = fmt === "anthropic" ? "/v1/models" : "/models";
  }
  const url = `${base}/${endpoint.replace(/^\/+/, "")}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(_PROBE_TIMEOUT_MS),
    });
  } catch {
    return { status: "unreachable", models: [], http_status: null };
  }

  if (response.status >= 400) {
    return {
      status: "unavailable",
      models: [],
      http_status: response.status,
    };
  }
  let models: AnyDict[] = [];
  try {
    models = _extract_models(await response.json(), p["model_parser"]);
  } catch {
    models = [];
  }
  return {
    status: models.length ? "connected" : "unavailable",
    // Return the provider's full catalog. A hard cap here (previously 200)
    // silently dropped valid models from gateways that publish large lists
    // (e.g. Kilo), so the settings UI reported a truncated count.
    models,
    http_status: response.status,
  };
}

export function store_discovered_models(
  settings: Settings,
  provider: string,
  models: unknown[],
  connection_id?: string | null,
): void {
  // Persist discovered models (ids or full rows) into the Praxis catalog.
  if (!provider || !models || !models.length) return;
  const rows: AnyDict[] = [];
  for (const model of models) {
    if (isRecord(model) && model["id"]) {
      rows.push({ ...model });
    } else if (typeof model === "string" && model.trim()) {
      rows.push({ id: model.trim(), name: model.trim() });
    }
  }
  if (!rows.length) return;
  const catalog = load_catalog(settings);
  let changed = false;
  const connections = Array.isArray(catalog["connections"])
    ? catalog["connections"]
    : [];
  for (const conn of connections) {
    if (!isRecord(conn)) continue;
    const match =
      (connection_id && conn["id"] === connection_id) ||
      (!connection_id && conn["provider"] === provider);
    if (!match) continue;
    if (!isRecord(conn["discovery"])) conn["discovery"] = {};
    conn["discovery"]["models"] = rows;
    conn["discovery"]["status"] = "connected";
    conn["discovery"]["checked_at"] = Date.now() / 1000;
    changed = true;
  }
  if (changed) {
    save_catalog(settings, catalog);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Imported lazily at call sites that need a fresh Settings instance.
export function get_settings(): Settings {
  return _config_get_settings();
}
