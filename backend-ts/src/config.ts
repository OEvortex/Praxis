// Port of backend/app/config.py — env-driven runtime configuration.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function _env(name: string, defaultValue = ""): string {
  return (process.env[name] ?? defaultValue).trim();
}

function intEnv(name: string, fallback: number): number {
  const raw = _env(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface Settings {
  // Root for all persisted state (sessions, uploads, logs).
  data_dir: string;
  // Model used when a turn carries no llm_selection.
  default_model: string;
  // Cap on agentic model turns per user turn.
  max_turns: number;
  // Directory tools (read_file/write_file/...) are jailed to this path.
  workspace_dir: string;
  // Chat-title generation endpoint (chatjimmy.ai-compatible /api/chat).
  // Set PRAXIS_TITLE_API_URL=off to keep the truncated-first-message titles.
  title_api_url: string;
  cors_origins: string[];
  // Legacy JSON import source only; sessions live in praxis.sqlite3.
  sessions_dir: string;
  sessions_db: string;
  files_dir: string;
}

function makeSettings(): Settings {
  const dataDir = resolve(_env("PRAXIS_DATA_DIR") || "./data");
  const s: Settings = {
    data_dir: dataDir,
    default_model: _env("PRAXIS_DEFAULT_MODEL"),
    max_turns: intEnv("PRAXIS_MAX_TURNS", 25),
    workspace_dir: resolve(_env("PRAXIS_WORKSPACE_DIR") || "./data/workspace"),
    title_api_url:
      _env("PRAXIS_TITLE_API_URL") || "https://chatjimmy.ai/api/chat",
    cors_origins: (
      _env("PRAXIS_CORS_ORIGINS") ||
      "http://localhost:3782,http://127.0.0.1:3782,http://localhost:3000,http://127.0.0.1:3000"
    )
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    sessions_dir: "",
    sessions_db: "",
    files_dir: "",
  };
  s.sessions_dir = `${dataDir}/sessions`;
  s.sessions_db = `${dataDir}/praxis.sqlite3`;
  s.files_dir = `${dataDir}/files`;
  return s;
}

// ---------------------------------------------------------------------------
// Runtime overrides — the setup capability's apply_setting persists whitelisted
// changes to <data_dir>/settings-overrides.json; get_settings() merges them on
// top of the env-derived values so they take effect without a restart.
// ---------------------------------------------------------------------------

/** spec key → Settings field, for the settings the agent may change at runtime. */
export const OVERRIDABLE_SETTINGS: Record<string, keyof Settings> = {
  "workspace.dir": "workspace_dir",
  "runtime.max_turns": "max_turns",
  "titles.api_url": "title_api_url",
};

function overridesPath(dataDir: string): string {
  return join(dataDir, "settings-overrides.json");
}

export function read_overrides(dataDir?: string): Record<string, unknown> {
  const dir = dataDir ?? resolve(_env("PRAXIS_DATA_DIR") || "./data");
  try {
    const raw = JSON.parse(readFileSync(overridesPath(dir), "utf-8")) as unknown;
    return raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function write_override(specKey: string, value: unknown): void {
  const dataDir = resolve(_env("PRAXIS_DATA_DIR") || "./data");
  const path = overridesPath(dataDir);
  const overrides = read_overrides(dataDir);
  if (value === null || value === undefined || value === "") {
    delete overrides[specKey];
  } else {
    overrides[specKey] = value;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(overrides, null, 2), "utf-8");
}

function applyOverrides(s: Settings): void {
  const overrides = read_overrides(s.data_dir);
  for (const [specKey, field] of Object.entries(OVERRIDABLE_SETTINGS)) {
    if (!(specKey in overrides)) continue;
    const value = overrides[specKey];
    if (field === "max_turns") {
      const n = Number(value);
      if (Number.isFinite(n)) s.max_turns = Math.max(1, Math.min(200, Math.trunc(n)));
    } else if (field === "workspace_dir" || field === "title_api_url") {
      const v = String(value ?? "").trim();
      if (v) s[field] = field === "workspace_dir" ? resolve(v) : v;
    }
  }
}

export function get_settings(): Settings {
  const s = makeSettings();
  applyOverrides(s);
  return s;
}

export const getSettings = get_settings;
