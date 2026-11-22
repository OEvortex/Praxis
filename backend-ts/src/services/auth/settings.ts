// Port of the auth/integrations slices of
// `<data>/user/settings/` plus the same process-env overrides upstream honors.
//
// Upstream resolves the settings dir through the admin PathService
// (`data/user/settings`); the TS backend's `data_dir` plays the role of the
// upstream `data/` root, so the files live at
// `<PRAXIS_DATA_DIR>/user/settings/{auth,integrations}.json`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { get_settings } from "../../config.js";

export function settingsDir(): string {
  return join(get_settings().data_dir, "user", "settings");
}

function settingsPath(name: string): string {
  return join(settingsDir(), `${name}.json`);
}

// -- coercion helpers (mirrors runtime_settings.py) ---------------------------

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function coerceBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  return fallback;
}

function coerceInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function coerceClampedInt(value: unknown, fallback: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, coerceInt(value, fallback)));
}

function coercePort(value: unknown, fallback: number): number {
  const port = coerceInt(value, fallback);
  return port >= 1 && port <= 65535 ? port : fallback;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function hostList(value: unknown): string[] {
  const norm = (raw: unknown) => str(raw).toLowerCase().replace(/\.+$/, "");
  if (Array.isArray(value)) {
    return value.map(norm).filter(Boolean);
  }
  const raw = str(value);
  return raw
    .replace(/;/g, ",")
    .split(",")
    .map((piece) => piece.trim().toLowerCase().replace(/\.+$/, ""))
    .filter(Boolean);
}

function jsonObject(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const loaded: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return loaded !== null && typeof loaded === "object" && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function atomicWriteJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, path);
}

// -- auth settings ------------------------------------------------------------

export const DEFAULT_AUTH_SETTINGS = {
  version: 1,
  enabled: false,
  username: "admin",
  password_hash: "",
  token_expire_hours: 24,
  cookie_secure: false,
  private_login_hosts: [] as string[],
};

export interface AuthSettings {
  version: number;
  enabled: boolean;
  username: string;
  password_hash: string;
  token_expire_hours: number;
  cookie_secure: boolean;
  private_login_hosts: string[];
}

function normalizeAuth(settings: Record<string, unknown>): AuthSettings {
  return {
    version: 1,
    enabled: coerceBool(settings["enabled"], false),
    username: str(settings["username"]) || "admin",
    password_hash: str(settings["password_hash"]),
    token_expire_hours: Math.max(1, coerceInt(settings["token_expire_hours"], 24)),
    cookie_secure: coerceBool(settings["cookie_secure"], false),
    private_login_hosts: hostList(settings["private_login_hosts"]),
  };
}

function applyAuthProcessOverrides(settings: AuthSettings): AuthSettings {
  const env = process.env;
  const payload: Record<string, unknown> = { ...settings };
  const enabled = env["AUTH_ENABLED"] || env["NEXT_PUBLIC_AUTH_ENABLED"];
  if (enabled) payload["enabled"] = enabled;
  if (env["AUTH_USERNAME"]) payload["username"] = env["AUTH_USERNAME"];
  if (env["AUTH_PASSWORD_HASH"]) payload["password_hash"] = env["AUTH_PASSWORD_HASH"];
  if (env["AUTH_TOKEN_EXPIRE_HOURS"]) payload["token_expire_hours"] = env["AUTH_TOKEN_EXPIRE_HOURS"];
  if (env["AUTH_COOKIE_SECURE"]) payload["cookie_secure"] = env["AUTH_COOKIE_SECURE"];
  if (env["AUTH_PRIVATE_LOGIN_HOSTS"]) payload["private_login_hosts"] = env["AUTH_PRIVATE_LOGIN_HOSTS"];
  return normalizeAuth(payload);
}

let _authCache: AuthSettings | null = null;

export function loadAuthSettings(): AuthSettings {
  if (_authCache) return _authCache;
  const path = settingsPath("auth");
  const loaded = jsonObject(path);
  let payload: AuthSettings;
  if (Object.keys(loaded).length > 0) {
    payload = normalizeAuth({ ...DEFAULT_AUTH_SETTINGS, ...loaded });
    // Mirror _load_or_create: rewrite when normalization changed the file.
    if (JSON.stringify(payload) !== JSON.stringify(loaded)) {
      atomicWriteJson(path, payload);
    }
  } else {
    payload = normalizeAuth({ ...DEFAULT_AUTH_SETTINGS });
    atomicWriteJson(path, payload);
  }
  _authCache = applyAuthProcessOverrides(payload);
  return _authCache;
}

/** Test hook: drop the memoized auth settings. */
export function resetAuthSettingsCache(): void {
  _authCache = null;
}

// -- integrations settings -----------------------------------------------------

export const DEFAULT_INTEGRATIONS_SETTINGS = {
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

export interface IntegrationsSettings {
  version: number;
  pocketbase_url: string;
  pocketbase_port: number;
  pocketbase_external_url: string;
  pocketbase_admin_email: string;
  pocketbase_admin_password: string;
  turn_coordination: Record<string, unknown>;
}

function normalizeIntegrations(settings: Record<string, unknown>): IntegrationsSettings {
  const rawCoordination = settings["turn_coordination"];
  const coordination =
    rawCoordination !== null && typeof rawCoordination === "object" && !Array.isArray(rawCoordination)
      ? (rawCoordination as Record<string, unknown>)
      : {};
  const backendRaw = str(coordination["backend"]).toLowerCase();
  const backend = backendRaw === "redis" ? "redis" : "memory";
  const keyPrefix = str(coordination["key_prefix"]).replace(/^:+|:+$/g, "") || "deeptutor";
  return {
    version: 2,
    pocketbase_url: str(settings["pocketbase_url"]).replace(/\/+$/, ""),
    pocketbase_port: coercePort(settings["pocketbase_port"], 8090),
    pocketbase_external_url: str(settings["pocketbase_external_url"]).replace(/\/+$/, ""),
    pocketbase_admin_email: str(settings["pocketbase_admin_email"]),
    pocketbase_admin_password: str(settings["pocketbase_admin_password"]),
    turn_coordination: {
      backend,
      redis_url: str(coordination["redis_url"]),
      key_prefix: keyPrefix,
      lease_ttl_seconds: coerceClampedInt(coordination["lease_ttl_seconds"], 30, 10, 300),
      renew_interval_seconds: coerceClampedInt(coordination["renew_interval_seconds"], 10, 1, 100),
      recovery_interval_seconds: coerceClampedInt(
        coordination["recovery_interval_seconds"],
        10,
        1,
        300,
      ),
      stream_retention_seconds: coerceClampedInt(
        coordination["stream_retention_seconds"],
        86_400,
        60,
        2_592_000,
      ),
    },
  };
}

function applyIntegrationsProcessOverrides(settings: IntegrationsSettings): IntegrationsSettings {
  const env = process.env;
  const payload: Record<string, unknown> = { ...settings };
  if (env["POCKETBASE_URL"]) payload["pocketbase_url"] = env["POCKETBASE_URL"];
  if (env["POCKETBASE_PORT"]) payload["pocketbase_port"] = env["POCKETBASE_PORT"];
  if (env["POCKETBASE_EXTERNAL_URL"]) payload["pocketbase_external_url"] = env["POCKETBASE_EXTERNAL_URL"];
  if (env["POCKETBASE_ADMIN_EMAIL"]) payload["pocketbase_admin_email"] = env["POCKETBASE_ADMIN_EMAIL"];
  if (env["POCKETBASE_ADMIN_PASSWORD"]) payload["pocketbase_admin_password"] = env["POCKETBASE_ADMIN_PASSWORD"];
  const coordination = { ...(settings.turn_coordination as Record<string, unknown>) };
  if (env["DEEPTUTOR_TURN_COORDINATION_BACKEND"]) coordination["backend"] = env["DEEPTUTOR_TURN_COORDINATION_BACKEND"];
  if (env["DEEPTUTOR_REDIS_URL"]) coordination["redis_url"] = env["DEEPTUTOR_REDIS_URL"];
  if (env["DEEPTUTOR_REDIS_KEY_PREFIX"]) coordination["key_prefix"] = env["DEEPTUTOR_REDIS_KEY_PREFIX"];
  payload["turn_coordination"] = coordination;
  return normalizeIntegrations(payload);
}

let _integrationsCache: IntegrationsSettings | null = null;

export function loadIntegrationsSettings(): IntegrationsSettings {
  if (_integrationsCache) return _integrationsCache;
  const path = settingsPath("integrations");
  const loaded = jsonObject(path);
  let payload: IntegrationsSettings;
  if (Object.keys(loaded).length > 0) {
    payload = normalizeIntegrations({ ...DEFAULT_INTEGRATIONS_SETTINGS, ...loaded });
    if (JSON.stringify(payload) !== JSON.stringify(loaded)) {
      atomicWriteJson(path, payload);
    }
  } else {
    payload = normalizeIntegrations({ ...DEFAULT_INTEGRATIONS_SETTINGS });
    atomicWriteJson(path, payload);
  }
  _integrationsCache = applyIntegrationsProcessOverrides(payload);
  return _integrationsCache;
}

export function resetIntegrationsSettingsCache(): void {
  _integrationsCache = null;
}
