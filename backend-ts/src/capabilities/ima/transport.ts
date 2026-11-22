// Port of deeptutor/services/rag/pipelines/ima/transport.py + envelope.py —
// the HTTP transport shared by every Tencent IMA OpenAPI call.
//
// All IMA methods are POST https://ima.qq.com/<prefix>/<method> with a JSON
// body and two credential headers. IMA wraps payloads in a status envelope
// and returns HTTP 200 even for business failures, so unwrapping is where all
// error handling happens.

export const API_BASE_URL = "https://ima.qq.com";
export const WIKI_PREFIX = "/openapi/wiki/v1";
export const NOTE_PREFIX = "/openapi/note/v1";

export const DEFAULT_TIMEOUT_MS = 30_000;

// Envelope status codes worth naming (envelope.py).
const CREDENTIAL_CODES = new Set([20004, 200002]);
const RATE_LIMIT_CODES = new Set([20002, 110021]);
const RETRYABLE_CODES = new Set([110010, 100003]);

export class ImaAPIError extends Error {}
export class ImaAuthError extends ImaAPIError {}
export class ImaContentAccessError extends ImaAPIError {}
export class ImaRateLimitError extends ImaAPIError {}
export class ImaNotConfiguredError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const CODE_KEYS = ["retcode", "code"] as const;
const MESSAGE_KEYS = ["errmsg", "msg"] as const;

function firstCode(payload: Record<string, unknown>): number | null {
  for (const key of CODE_KEYS) {
    if (!(key in payload)) continue;
    const n = Number(payload[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function messageOf(payload: Record<string, unknown>): string {
  for (const key of MESSAGE_KEYS) {
    const v = payload[key];
    if (v) return String(v).trim();
  }
  return "";
}

/** Return the envelope's `data` object, or raise the mapped error. */
export function unwrap(payload: unknown, statusCode: number): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new ImaAPIError(`IMA returned an unexpected payload with status ${statusCode}.`);
  }
  const code = firstCode(payload);
  const message = messageOf(payload);
  if (code === 0) {
    const data = payload["data"];
    return isRecord(data) ? data : {};
  }
  if (message.includes("订阅知识库") && message.includes("没有权限")) {
    throw new ImaContentAccessError(
      "IMA permits searching this subscribed library, but its files can only be read in the IMA client.",
    );
  }
  if (code !== null && CREDENTIAL_CODES.has(code)) {
    throw new ImaAuthError(message || "IMA rejected the client ID / API key.");
  }
  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    throw new ImaRateLimitError(message || "IMA rate limit reached.");
  }
  if (code !== null && RETRYABLE_CODES.has(code)) {
    throw new ImaAPIError(
      message || `IMA is temporarily unavailable (code ${code}). Try again.`,
    );
  }
  if (code === null) {
    throw new ImaAPIError(`IMA returned an unrecognized response with status ${statusCode}.`);
  }
  throw new ImaAPIError(message || `IMA request failed with code ${code}.`);
}

export interface ImaCredentials {
  client_id: string;
  api_key: string;
}

export function buildHeaders(config: ImaCredentials): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "ima-openapi-clientid": config.client_id,
    "ima-openapi-apikey": config.api_key,
  };
}

/** POST one IMA method and return its unwrapped `data` object. */
export async function imaPost(
  config: ImaCredentials,
  method: string,
  body: Record<string, unknown>,
  opts: { prefix?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const prefix = opts.prefix ?? WIKI_PREFIX;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const response = await fetch(`${API_BASE_URL}${prefix}/${method}`, {
    method: "POST",
    headers: buildHeaders(config),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ImaAuthError("IMA rejected the credentials or knowledge-base permissions.");
  }
  if (response.status === 429) {
    throw new ImaRateLimitError("IMA rate limit reached. Try again shortly.");
  }
  if (!response.ok) {
    throw new ImaAPIError(
      `IMA returned HTTP ${response.status}. Retry or check the connection.`,
    );
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return unwrap(payload, response.status);
}
