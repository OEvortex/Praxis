import type { AnyRecord } from "./types.js";
import type { Settings } from "../../config.js";
import * as database from "../../store/database.js";

export const LIGHTRAG_SERVER_SUPPORTED_MODES = ["naive", "local", "global", "hybrid", "mix"];
export const LIGHTRAG_SERVER_DEFAULT_MODE = "mix";

const SETTINGS_KEY = "runtime_settings/lightrag_server";

export function normalizeLightRagServerBaseUrl(url: unknown): string {
  return String(url ?? "").trim().replace(/\/+$/, "");
}

export function loadLightRagServerSettings(settings: Settings): AnyRecord {
  const data = database.get_state<AnyRecord>(settings, SETTINGS_KEY);
  return {
    version: 1,
    server_url: String(data?.["server_url"] ?? "").trim().replace(/\/+$/, ""),
    api_key: String(data?.["api_key"] ?? ""),
  };
}

export class LightRagServerAPIError extends Error {}

async function lrsFetch(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: AnyRecord,
): Promise<{ status: number; data: AnyRecord | null }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  let data: AnyRecord | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as AnyRecord;
    }
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

async function authStatus(baseUrl: string, apiKey: string): Promise<AnyRecord> {
  const { status, data } = await lrsFetch(baseUrl, apiKey, "GET", "/auth-status");
  if (status >= 400 || data === null) {
    throw new LightRagServerAPIError(
      `LightRAG server returned ${status}: unexpected response`,
    );
  }
  return data;
}

async function verifyKey(baseUrl: string, apiKey: string): Promise<boolean> {
  const { status } = await lrsFetch(baseUrl, apiKey, "GET", "/documents/pipeline_status");
  if (status === 401 || status === 403) return false;
  if (status >= 400) {
    throw new LightRagServerAPIError(`LightRAG server returned ${status}`);
  }
  return true;
}

export interface ServerProbe {
  base_url: string;
  ok: boolean;
  reachable: boolean;
  auth_required: boolean;
  auth_ok: boolean;
  core_version: string | null;
  api_version: string | null;
  error: string | null;
}

function optStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t || null;
}

/** probe_server — never throws; ``ok`` is the gate boolean. */
export async function probeServer(serverUrl: string, apiKey = ""): Promise<ServerProbe> {
  const baseUrl = normalizeLightRagServerBaseUrl(serverUrl);
  const probe: ServerProbe = {
    base_url: baseUrl,
    ok: false,
    reachable: false,
    auth_required: false,
    auth_ok: false,
    core_version: null,
    api_version: null,
    error: null,
  };
  if (!baseUrl) {
    probe.error = "Server URL is required.";
    return probe;
  }
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
    probe.error = "Server URL must start with http:// or https://.";
    return probe;
  }
  let status: AnyRecord;
  try {
    status = await authStatus(baseUrl, String(apiKey ?? "").trim());
  } catch (exc) {
    probe.error = `Could not reach a LightRAG server at ${baseUrl}: ${exc instanceof Error ? exc.message : exc}`;
    return probe;
  }
  if (!("auth_configured" in status)) {
    probe.error = `${baseUrl} responded but does not look like a LightRAG server.`;
    return probe;
  }
  probe.reachable = true;
  probe.core_version = optStr(status["core_version"]);
  probe.api_version = optStr(status["api_version"]);
  probe.auth_required = Boolean(status["auth_configured"]);
  if (!probe.auth_required) {
    probe.auth_ok = true;
    probe.ok = true;
    return probe;
  }
  try {
    probe.auth_ok = await verifyKey(baseUrl, String(apiKey ?? "").trim());
  } catch (exc) {
    probe.error = `Reached the server but could not validate the API key: ${exc instanceof Error ? exc.message : exc}`;
    return probe;
  }
  if (!probe.auth_ok) {
    probe.error = apiKey
      ? "This server requires an API key and the one provided was rejected."
      : "This server requires an API key. Provide one to connect.";
    return probe;
  }
  probe.ok = true;
  return probe;
}
