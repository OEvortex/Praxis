// Port of deeptutor/services/pocketbase_client.py — minimal PocketBase HTTP
// client (no SDK dependency). Active only when integrations.pocketbase_url is
// set and auth is enabled.
import { loadIntegrationsSettings } from "./settings.js";

function pocketbaseSettings(): {
  url: string;
  admin_email: string;
  admin_password: string;
} {
  const settings = loadIntegrationsSettings();
  return {
    url: settings.pocketbase_url.replace(/\/+$/, ""),
    admin_email: settings.pocketbase_admin_email,
    admin_password: settings.pocketbase_admin_password,
  };
}

export function isPocketbaseEnabled(): boolean {
  return Boolean(pocketbaseSettings().url);
}

export function pocketbaseBaseUrl(): string {
  return pocketbaseSettings().url;
}

// -- token validation cache (60 s TTL, mirrors upstream) ----------------------

const TOKEN_CACHE = new Map<string, { payload: Record<string, unknown>; expiresAt: number }>();
const TOKEN_CACHE_TTL_MS = 60_000;

function cacheGet(token: string): Record<string, unknown> | null {
  const entry = TOKEN_CACHE.get(token);
  if (!entry) return null;
  if (Date.now() < entry.expiresAt) return entry.payload;
  TOKEN_CACHE.delete(token);
  return null;
}

function cacheSet(token: string, payload: Record<string, unknown>): void {
  TOKEN_CACHE.set(token, { payload, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
}

async function pbPost(
  path: string,
  body: Record<string, unknown>,
  token?: string,
): Promise<Record<string, unknown>> {
  const url = pocketbaseSettings().url;
  if (!url) throw new Error("PocketBase is not configured.");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token;
  const resp = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`PocketBase request failed: HTTP ${resp.status}`);
  }
  const data: unknown = await resp.json();
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function recordOf(data: Record<string, unknown>): Record<string, unknown> {
  const record = data["record"];
  return record !== null && typeof record === "object" && !Array.isArray(record)
    ? (record as Record<string, unknown>)
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/**
 * Validate a PocketBase user token via /api/collections/users/auth-refresh.
 * Returns {username, role} or null.
 */
export async function validatePbToken(token: string): Promise<Record<string, unknown> | null> {
  if (!pocketbaseSettings().url) return null;
  const cached = cacheGet(token);
  if (cached) return cached;
  try {
    const data = await pbPost("/api/collections/users/auth-refresh", {}, token);
    const record = recordOf(data);
    const username =
      firstString(record, ["email", "name", "username"]) ||
      firstString(record, ["id"]) ||
      "unknown";
    const payload = { username, role: String(record["role"] ?? "user") || "user" };
    cacheSet(token, payload);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Authenticate against PocketBase (users collection, password auth).
 * Returns (payload, raw_token) or null.
 */
export async function authenticatePb(
  username: string,
  password: string,
): Promise<[Record<string, unknown>, string] | null> {
  try {
    const data = await pbPost("/api/collections/users/auth-with-password", {
      identity: username,
      password,
    });
    const token = String(data["token"] ?? "");
    if (!token) return null;
    const record = recordOf(data);
    const name =
      firstString(record, ["email", "name", "username", "id"]) || "unknown";
    const payload = {
      username: name,
      role: String(record["role"] ?? "user") || "user",
      id: firstString(record, ["id"]),
    };
    return [payload, token];
  } catch {
    return null;
  }
}

/** Create a new user in PocketBase. Returns record dict or null. */
export async function registerPb(
  username: string,
  email: string,
  password: string,
): Promise<Record<string, unknown> | null> {
  try {
    const data = await pbPost("/api/collections/users/records", {
      username,
      email,
      password,
      passwordConfirm: password,
    });
    return {
      id: String(data["id"] ?? ""),
      username,
      email,
    };
  } catch {
    return null;
  }
}

/** Async health check (lifespan equivalent). */
export async function pingPocketbase(): Promise<boolean> {
  const url = pocketbaseSettings().url;
  if (!url) return false;
  try {
    const resp = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    return resp.status === 200;
  } catch {
    return false;
  }
}
