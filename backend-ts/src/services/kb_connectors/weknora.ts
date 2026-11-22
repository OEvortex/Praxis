// Port of deeptutor/services/rag/pipelines/weknora/{config,client,probe}.py
import type { AnyRecord } from "./types.js";

export class WeKnoraAPIError extends Error {}

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function normalizeWeKnoraBaseUrl(url: unknown): string {
  const normalized = String(url ?? "").trim().replace(/\/+$/, "");
  if (!normalized) return "";
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return "";
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return normalized;
}

/** validate_mcp_url_async subset: reject obviously unsafe targets. */
function isSafeUrl(baseUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal" ||
    host === "169.254.169.254" ||
    host.startsWith("[fe80:") ||
    host === "::1"
  ) {
    // Loopback/private LAN is allowed for self-hosted deployments upstream;
    // only link-local/metadata/malformed are forbidden. So allow private ranges
    // but block link-local + metadata + weird schemes (already constrained).
    if (host === "169.254.169.254" || host === "metadata.google.internal" || host.startsWith("[fe80:")) {
      return false;
    }
  }
  return true;
}

async function requestJson(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: AnyRecord,
): Promise<AnyRecord> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "X-API-Key": apiKey,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.length > MAX_RESPONSE_BYTES) {
    throw new WeKnoraAPIError("WeKnora response exceeds the 4 MiB limit.");
  }
  if (response.status >= 400) {
    const preview = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, 300));
    throw new WeKnoraAPIError(`WeKnora returned ${response.status}: ${preview}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(buf));
  } catch (exc) {
    throw new WeKnoraAPIError(`WeKnora returned a non-JSON response: ${exc}`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new WeKnoraAPIError(`WeKnora returned unexpected payload: ${JSON.stringify(data)}`);
  }
  return data as AnyRecord;
}

export async function listKnowledgeBases(
  baseUrl: string,
  apiKey: string,
): Promise<AnyRecord[]> {
  if (!isSafeUrl(baseUrl)) {
    throw new WeKnoraAPIError(`Unsafe WeKnora server URL: ${baseUrl}`);
  }
  const data = (await requestJson(baseUrl, apiKey, "GET", "/api/v1/knowledge-bases"))["data"];
  if (!Array.isArray(data) || !data.every((i) => i !== null && typeof i === "object" && !Array.isArray(i))) {
    throw new WeKnoraAPIError("WeKnora returned an unexpected knowledge-base list.");
  }
  return data as AnyRecord[];
}

// -- probe (weknora/probe.py) ---------------------------------------------------------

export interface WeKnoraProbe {
  base_url: string;
  knowledge_base_id: string;
  ok: boolean;
  reachable: boolean;
  credentials_ok: boolean;
  knowledge_base_found: boolean;
  knowledge_base_name: string | null;
  error: string | null;
}

export async function probeWeKnora(
  serverUrl: string,
  apiKey: string,
  knowledgeBaseId: string,
): Promise<WeKnoraProbe> {
  const baseUrl = normalizeWeKnoraBaseUrl(serverUrl);
  const kbId = String(knowledgeBaseId ?? "").trim();
  const key = String(apiKey ?? "").trim();
  const probe: WeKnoraProbe = {
    base_url: baseUrl,
    knowledge_base_id: kbId,
    ok: false,
    reachable: false,
    credentials_ok: false,
    knowledge_base_found: false,
    knowledge_base_name: null,
    error: null,
  };
  if (!baseUrl || !kbId || !key) {
    probe.error = "Server URL, API key, and knowledge base ID are required.";
    return probe;
  }
  if (!isSafeUrl(baseUrl)) {
    probe.error = `Unsafe WeKnora server URL: ${baseUrl}`;
    return probe;
  }
  let knowledgeBases: AnyRecord[];
  try {
    knowledgeBases = await listKnowledgeBases(baseUrl, key);
  } catch (exc) {
    probe.error = `Could not validate the WeKnora connection: ${exc instanceof Error ? exc.message : exc}`;
    return probe;
  }
  probe.reachable = true;
  probe.credentials_ok = true;
  const matches = knowledgeBases.filter((item) => String(item["id"] ?? "") === kbId);
  if (!matches.length) {
    probe.error = `Knowledge base ${kbId} is not visible to this WeKnora API key.`;
    return probe;
  }
  probe.knowledge_base_found = true;
  const name = String(matches[0]["name"] ?? "").trim();
  probe.knowledge_base_name = name || null;
  probe.ok = true;
  return probe;
}
