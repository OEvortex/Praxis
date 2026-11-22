// Port of deeptutor/services/cli_apps/{catalog,state}.py,
// deeptutor/plugins/registry.py (sqlite-backed record store),
// deeptutor/api/routers/{capabilities,capabilities_settings,tools,agent_config}.py
// service halves, and the vendored CLI-app catalog loader.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { get_settings, type Settings } from "../../config.js";
import * as database from "../../store/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ==========================================================================
// CLI apps (space_cli_apps.py backing)
// ==========================================================================

export const TOOL_PREFIX = "cli_";

export interface CliAppEntry {
  id: string;
  display_name: string;
  description: string;
  category: string;
  origin: string;
  trust: string;
  requires: string;
  homepage: string;
  source_url: string;
  entry_point: string;
  runtime: string;
  install_kind: string;
  install_target: string;
  installable: boolean;
  pinned: boolean;
  unsupported_reason: string;
  install_notes: string;
}

export interface InstalledApp {
  id: string;
  entry_point: string;
  runtime: string;
  installed_at: number;
  version: string;
  pin: string;
}

const INSTALLED_KEY = "cli_apps_installed";
const DISABLED_KEY = "cli_apps_disabled";

let _catalog: CliAppEntry[] | null = null;

export function load_cli_catalog(): CliAppEntry[] {
  if (_catalog !== null) return _catalog;
  const out: CliAppEntry[] = [];
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, "data", "cli-apps.json"), "utf8")) as {
      apps?: Array<Record<string, unknown>>;
    };
    for (const row of raw.apps ?? []) {
      const name = String(row["name"] ?? "").trim();
      if (!name) continue;
      const install = isRecord(row["install"]) ? row["install"] : {};
      out.push({
        id: name,
        display_name: String(row["display_name"] ?? name),
        description: String(row["description"] ?? ""),
        category: String(row["category"] ?? ""),
        origin: String(row["origin"] ?? ""),
        trust: String(row["trust"] ?? "third-party"),
        requires: String(row["requires"] ?? ""),
        homepage: String(row["homepage"] ?? ""),
        source_url: String(row["source_url"] ?? row["install_cmd"] ?? ""),
        entry_point: String(row["entry_point"] ?? name),
        runtime: String(install["runtime"] ?? row["runtime"] ?? "subprocess"),
        install_kind: String(install["kind"] ?? "pip"),
        install_target: String(install["target"] ?? ""),
        installable: install["installable"] !== false,
        pinned: Boolean(install["pinned"]),
        unsupported_reason: String(install["reason"] ?? ""),
        install_notes: String(row["install_notes"] ?? ""),
      });
    }
  } catch { /* missing catalog → empty */ }
  _catalog = out;
  return out;
}

export function get_cli_entry(appId: string): CliAppEntry | null {
  return load_cli_catalog().find((e) => e.id === appId) ?? null;
}

export function catalog_pin(): string {
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, "data", "cli-apps.json"), "utf8")) as {
      meta?: { commit?: string };
    };
    return String(raw.meta?.commit ?? "");
  } catch {
    return "";
  }
}

function _kv<T>(key: string, fallback: T, settings?: Settings): T {
  const s = settings ?? get_settings();
  return database.get_state<T>(s, key, fallback) ?? fallback;
}

export function load_installed(settings?: Settings): Record<string, InstalledApp> {
  const raw = _kv<Record<string, unknown>>(INSTALLED_KEY, {}, settings);
  const out: Record<string, InstalledApp> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue;
    out[id] = {
      id,
      entry_point: String(v["entry_point"] ?? id),
      runtime: String(v["runtime"] ?? "subprocess"),
      installed_at: Number(v["installed_at"] ?? 0),
      version: String(v["version"] ?? ""),
      pin: String(v["pin"] ?? ""),
    };
  }
  return out;
}

export function save_installed(apps: Record<string, InstalledApp>, settings?: Settings): void {
  const s = settings ?? get_settings();
  database.put_state(s, INSTALLED_KEY, apps as unknown as Record<string, unknown>);
}

export function disabled_apps(owner: string, settings?: Settings): Set<string> {
  const raw = _kv<Record<string, string[]>>(DISABLED_KEY, {}, settings);
  return new Set(raw[owner] ?? []);
}

export function set_app_enabled(owner: string, appId: string, enabled: boolean, settings?: Settings): void {
  const s = settings ?? get_settings();
  const raw = _kv<Record<string, string[]>>(DISABLED_KEY, {}, s);
  const set = new Set(raw[owner] ?? []);
  if (enabled) set.delete(appId);
  else set.add(appId);
  raw[owner] = [...set];
  database.put_state(s, DISABLED_KEY, raw);
}

export interface CatalogQuery {
  q?: string;
  category?: string;
  installable_only?: boolean;
  cursor?: string;
  limit?: number;
}

export function search_cli_catalog(query: CatalogQuery = {}): { entries: CliAppEntry[]; next_cursor: string; total: number } {
  const needle = (query.q ?? "").trim().toLowerCase();
  const matches = load_cli_catalog().filter((entry) => {
    if (query.category && entry.category !== query.category) return false;
    if (query.installable_only !== false && !entry.installable) return false;
    if (needle) {
      const hay = [entry.id, entry.display_name, entry.description, entry.category].join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const size = Math.max(1, Math.min(query.limit ?? 24, 100));
  let start = 0;
  if (query.cursor) {
    const n = Number.parseInt(query.cursor, 10);
    if (Number.isFinite(n)) start = Math.max(0, n);
  }
  const page = matches.slice(start, start + size);
  const end = start + page.length;
  return { entries: page, next_cursor: end < matches.length ? String(end) : "", total: matches.length };
}

export function cli_category_counts(query: { q?: string; installable_only?: boolean } = {}): Record<string, number> {
  const needle = (query.q ?? "").trim().toLowerCase();
  const counts: Record<string, number> = {};
  for (const entry of load_cli_catalog()) {
    if (query.installable_only !== false && !entry.installable) continue;
    if (needle) {
      const hay = [entry.id, entry.display_name, entry.description, entry.category].join(" ").toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  }
  return counts;
}

// ==========================================================================
// Plugins (plugins.py backing — sqlite-backed registry)
// ==========================================================================

export interface PluginExtension {
  id: string;
  type: string;
  path?: string;
  methods?: string[];
  auth?: string;
  manifest?: string;
  [k: string]: unknown;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  status: string; // enabled | disabled | pending_approval | ...
  distribution: string; // managed | local | catalog
  manifest: { extensions?: PluginExtension[]; [k: string]: unknown } | null;
  installation: { package_path?: string; [k: string]: unknown } | null;
  snapshot_digest?: string;
  [k: string]: unknown;
}

const PLUGINS_COLLECTION = "plugins";

export function list_plugins(settings?: Settings): PluginRecord[] {
  const s = settings ?? get_settings();
  return database.list_items(s, PLUGINS_COLLECTION) as unknown as PluginRecord[];
}

export function get_plugin(pluginId: string, settings?: Settings): PluginRecord | null {
  const s = settings ?? get_settings();
  return (database.get_item(s, PLUGINS_COLLECTION, pluginId) as unknown as PluginRecord) ?? null;
}

export function save_plugin(record: PluginRecord, settings?: Settings): void {
  const s = settings ?? get_settings();
  database.put_item(s, PLUGINS_COLLECTION, record as unknown as Record<string, unknown>);
}

export function delete_plugin(pluginId: string, settings?: Settings): boolean {
  const s = settings ?? get_settings();
  return database.delete_item(s, PLUGINS_COLLECTION, pluginId);
}

export function set_plugin_enabled(pluginId: string, enabled: boolean, settings?: Settings): PluginRecord {
  const record = get_plugin(pluginId, settings);
  if (!record) throw new Error(`Plugin not found: ${pluginId}`);
  record.status = enabled ? "enabled" : "disabled";
  save_plugin(record, settings);
  return record;
}

// ==========================================================================
// Capabilities (capabilities.py + capabilities_settings.py backing)
// ==========================================================================

const CAPABILITIES_KEY = "capabilities_settings";

/** Turn capabilities this deployment can execute (registry manifests). */
export function registered_capabilities(): Array<Record<string, unknown>> {
  const defs: Array<{ id: string; manifest: Record<string, unknown>; config_schema?: Record<string, unknown> }> = [
    { id: "chat", manifest: { name: "chat", description: "General tutoring conversation", version: "1.0.0" } },
    { id: "deep_question", manifest: { name: "deep_question", description: "Step-by-step problem solving", version: "1.0.0" } },
    { id: "research", manifest: { name: "research", description: "Deep research report generation", version: "1.0.0" } },
    { id: "co_writer", manifest: { name: "co_writer", description: "Document co-writing", version: "1.0.0" } },
    { id: "visualize", manifest: { name: "visualize", description: "Interactive visualizations", version: "1.0.0" } },
    { id: "practice", manifest: { name: "practice", description: "Practice exercises", version: "1.0.0" } },
    { id: "mastery", manifest: { name: "mastery", description: "Mastery learning path", version: "1.0.0" } },
    { id: "reading", manifest: { name: "reading", description: "Immersive reading workspace", version: "1.0.0" } },
    { id: "video_learning", manifest: { name: "video_learning", description: "Video lesson learning", version: "1.0.0" } },
    { id: "notebook", manifest: { name: "notebook", description: "Co-writer notebook agent", version: "1.0.0" } },
  ];
  return defs
    .map((d) => ({
      id: d.id,
      kind: "turn",
      available: true,
      manifest: d.manifest,
      config_schema: d.config_schema ?? { type: "object", properties: {} },
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

const CAPABILITY_DEFAULTS: Record<string, unknown> = {
  deep_question: { temperature: 0.3, max_tokens: 4096, max_iterations: 8 },
  research: { temperature: 0.4, max_tokens: 8192, max_iterations: 12 },
  co_writer: { temperature: 0.5, max_tokens: 4096 },
  chat: { temperature: 0.7, max_tokens: 2048 },
};

export function capabilities_settings_dict(settings?: Settings): Record<string, unknown> {
  const s = settings ?? get_settings();
  const saved = database.get_state<Record<string, unknown>>(s, CAPABILITIES_KEY, {}) ?? {};
  return { ...CAPABILITY_DEFAULTS, ...saved };
}

export function save_capabilities_settings(payload: unknown, settings?: Settings): Record<string, unknown> {
  const s = settings ?? get_settings();
  const current = capabilities_settings_dict(s);
  const merged = isRecord(payload) ? { ...current, ...payload } : current;
  database.put_state(s, CAPABILITIES_KEY, merged);
  return merged;
}

// ==========================================================================
// Tools listing (tools.py backing)
// ==========================================================================

const TOOLS_STATE_KEY = "tools_enabled_optional";

export function get_enabled_optional_tools(settings?: Settings): string[] {
  const s = settings ?? get_settings();
  const saved = database.get_state<unknown>(s, TOOLS_STATE_KEY, null);
  if (Array.isArray(saved)) return saved.map((x) => String(x));
  // Default: the optional tools this deployment actually registers.
  return ["web_search", "paper_search"];
}

export function set_enabled_optional_tools(names: string[], settings?: Settings): void {
  const s = settings ?? get_settings();
  database.put_state(s, TOOLS_STATE_KEY, names);
}

export const USER_TOGGLEABLE_TOOLS = new Set(["web_search", "paper_search"]);
export const AGENT_REGISTRY: Record<string, { icon: string; color: string; label_key: string }> = {
  solve: { icon: "HelpCircle", color: "blue", label_key: "Problem Solved" },
  question: { icon: "FileText", color: "purple", label_key: "Question Generated" },
  research: { icon: "Search", color: "emerald", label_key: "Research Report" },
  co_writer: { icon: "PenTool", color: "amber", label_key: "Co-Writer" },
};
