// per-owner Invidious account connections (authorize → callback → token store).
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { get_settings } from "../../config.js";
import type { Settings } from "../../config.js";
import {
  TimedMediaError,
  loadVideoLearningSettings,
  normalizeVideoLearningSettings,
} from "./service.js";

export const CALLBACK_PATH = "/api/video-learning/invidious/account/callback";
const FLOW_TIMEOUT_S = 600.0;
const PUBLIC_URL_ENV = "DEEPTUTOR_PUBLIC_URL";
const DEFAULT_PUBLIC_URL = "http://localhost:3782";
export const ACCOUNT_SCOPES = [
  "GET:preferences",
  "POST:tokens/unregister",
  "GET:feed",
  "GET:playlists",
  "GET:playlists/*",
] as const;
const MAX_TOKEN_BYTES = 8192;

// -- storage -------------------------------------------------------------------

interface PendingFlow {
  owner_id: string;
  api_base_url: string;
  callback_url: string;
  expires_at: number;
}

function secretsRoot(ownerId: string, settings: Settings): string {
  const digest = createHash("sha256").update(ownerId, "utf8").digest("hex").slice(0, 24);
  return join(settings.data_dir, "private", "video-learning-invidious", digest);
}

function assetDir(ownerId: string, settings: Settings): string {
  const dir = secretsRoot(ownerId, settings);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function accountPath(ownerId: string, settings: Settings): string {
  return join(assetDir(ownerId, settings), "account.json");
}

function pendingDir(ownerId: string, settings: Settings): string {
  const dir = join(assetDir(ownerId, settings), "pending");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function flowPath(ownerId: string, state: string, settings: Settings): string {
  const digest = createHash("sha256").update(state, "utf8").digest("hex");
  return join(pendingDir(ownerId, settings), `${digest}.json`);
}

function readJson(path: string): Record<string, any> {
  try {
    const payload: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function writePrivateJson(path: string, payload: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = join(path, `..`, `.${path.split("/").pop()}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

function pendingFlowFrom(path: string): PendingFlow | null {
  const p = readJson(path);
  if (
    typeof p.owner_id !== "string" || !p.owner_id ||
    typeof p.api_base_url !== "string" || !p.api_base_url ||
    typeof p.callback_url !== "string" || !p.callback_url ||
    typeof p.expires_at !== "number"
  ) return null;
  return {
    owner_id: p.owner_id,
    api_base_url: p.api_base_url,
    callback_url: p.callback_url,
    expires_at: p.expires_at,
  };
}

function purgeExpired(ownerId: string, settings: Settings, now = Date.now() / 1000): void {
  let names: string[] = [];
  try { names = readdirSync(pendingDir(ownerId, settings)); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(pendingDir(ownerId, settings), name);
    const flow = pendingFlowFrom(path);
    if (!flow || flow.owner_id !== ownerId || flow.expires_at <= now) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }
}

function replacePendingFlow(state: string, flow: PendingFlow, settings: Settings): void {
  let names: string[] = [];
  try { names = readdirSync(pendingDir(flow.owner_id, settings)); } catch { names = []; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(pendingDir(flow.owner_id, settings), name);
    const existing = pendingFlowFrom(path);
    if (
      !existing ||
      existing.owner_id !== flow.owner_id ||
      existing.api_base_url === flow.api_base_url
    ) {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }
  writePrivateJson(flowPath(flow.owner_id, state, settings), { version: 1, ...flow });
}

function consumePendingFlow(ownerId: string, state: string, settings: Settings): PendingFlow | null {
  if (!state) return null;
  const source = flowPath(ownerId, state, settings);
  const claim = join(
    pendingDir(ownerId, settings),
    `.${source.split("/").pop()}.${randomBytes(8).toString("hex")}.claim`,
  );
  try {
    renameSync(source, claim);
  } catch {
    return null;
  }
  try {
    const flow = pendingFlowFrom(claim);
    if (!flow || flow.owner_id !== ownerId || flow.expires_at <= Date.now() / 1000) return null;
    return flow;
  } finally {
    try { rmSync(claim, { force: true }); } catch { /* ignore */ }
  }
}

function readAccount(ownerId: string, settings: Settings): Record<string, any> {
  return readJson(accountPath(ownerId, settings));
}

function writeAccount(ownerId: string, payload: Record<string, unknown>, settings: Settings): void {
  writePrivateJson(accountPath(ownerId, settings), payload);
}

function forgetAccount(ownerId: string, settings: Settings): void {
  try { rmSync(accountPath(ownerId, settings), { force: true }); } catch { /* ignore */ }
}

// -- client ---------------------------------------------------------------------

class InvidiousTransportError extends Error {}

function bearerToken(token: Record<string, unknown>): string {
  return JSON.stringify(token);
}

async function requestPreferences(apiBaseUrl: string, token: Record<string, unknown>): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}/api/v1/auth/preferences`, {
      headers: { Authorization: `Bearer ${bearerToken(token)}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
  } catch (e) {
    throw new TimedMediaError("Invidious account verification request failed.");
  }
  if (res.status !== 200) {
    throw new TimedMediaError(`Invidious account verification failed with HTTP ${res.status}.`);
  }
  let preferences: unknown;
  try {
    preferences = await res.json();
  } catch {
    throw new TimedMediaError("Invidious returned invalid account preferences.");
  }
  if (preferences === null || typeof preferences !== "object" || Array.isArray(preferences)) {
    throw new TimedMediaError("Invidious returned invalid account preferences.");
  }
  return preferences as Record<string, any>;
}

async function revokeToken(apiBaseUrl: string, token: Record<string, unknown>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}/api/v1/auth/tokens/unregister`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken(token)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: token.session }),
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
  } catch {
    throw new InvidiousTransportError("Invidious unreachable");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new TimedMediaError(
      `Invidious account disconnection failed with HTTP ${res.status}.`,
    );
  }
}

async function requestCatalog(
  apiBaseUrl: string,
  path: string,
  params: Record<string, string | number>,
  token: Record<string, unknown> | null,
): Promise<unknown> {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  ).toString();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${bearerToken(token)}`;
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl}${path}${qs ? `?${qs}` : ""}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
  } catch {
    throw new TimedMediaError("Invidious could not load videos. Please retry or check the instance.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new TimedMediaError("Reconnect your Invidious account to browse your videos.");
  }
  if (res.status !== 200) {
    throw new TimedMediaError("Invidious could not load videos. Please retry or check the instance.");
  }
  try {
    return await res.json();
  } catch {
    throw new TimedMediaError("Invidious could not load videos. Please retry or check the instance.");
  }
}

// -- workflow ---------------------------------------------------------------------

function configuredPublicUrl(settings: Settings): string {
  const configured = (process.env[PUBLIC_URL_ENV] ?? "").trim().replace(/\/+$/, "");
  if (configured) {
    const normalized = normalizeVideoLearningSettings({
      version: 1,
      default_provider: "youtube",
      invidious: { api_base_url: "", public_base_url: configured },
    });
    return String((normalized.invidious as Record<string, unknown>).public_base_url ?? "");
  }
  return DEFAULT_PUBLIC_URL;
}

export function invidiousRedirectUri(settings?: Settings): string {
  return `${configuredPublicUrl(settings ?? get_settings())}${CALLBACK_PATH}`;
}

export function beginInvidiousAccountAuthorization(
  args: { owner_id: string; redirect_uri: string },
  settings?: Settings,
): string {
  const s = settings ?? get_settings();
  const vSettings = loadVideoLearningSettings(s);
  const base = String(vSettings.invidious?.api_base_url ?? "");
  if (!base) {
    throw new TimedMediaError("Configure the Invidious API base URL before connecting an account.");
  }
  let parsedRedirect: URL;
  try {
    parsedRedirect = new URL(args.redirect_uri);
  } catch {
    throw new TimedMediaError("Invidious callback URL must be a plain HTTP(S) URL.");
  }
  if (
    (parsedRedirect.protocol !== "http:" && parsedRedirect.protocol !== "https:") ||
    !parsedRedirect.hostname ||
    parsedRedirect.username ||
    parsedRedirect.password ||
    parsedRedirect.hash
  ) {
    throw new TimedMediaError("Invidious callback URL must be a plain HTTP(S) URL.");
  }

  purgeExpired(args.owner_id, s);
  const state = randomBytes(24).toString("base64url");
  const separator = parsedRedirect.search ? "&" : "?";
  const callbackUrl = `${args.redirect_uri}${separator}state=${encodeURIComponent(state)}`;
  const publicBase = String(vSettings.invidious?.public_base_url ?? "") || base;
  const authorizeUrl =
    `${publicBase}/authorize_token?scopes=${encodeURIComponent(ACCOUNT_SCOPES.join(","))}` +
    `&callback_url=${encodeURIComponent(callbackUrl)}`;

  replacePendingFlow(state, {
    owner_id: args.owner_id,
    api_base_url: base,
    callback_url: callbackUrl,
    expires_at: Date.now() / 1000 + FLOW_TIMEOUT_S,
  }, s);
  return authorizeUrl;
}

function parseToken(rawToken: string): Record<string, any> {
  if (!rawToken || Buffer.byteLength(rawToken, "utf-8") > MAX_TOKEN_BYTES) {
    throw new TimedMediaError("Invidious returned an invalid account token.");
  }
  let decoded = rawToken;
  if (!rawToken.trimStart().startsWith("{")) {
    try {
      decoded = decodeURIComponent(rawToken.replace(/\+/g, " "));
    } catch {
      // keep raw
    }
  }
  let token: unknown;
  try {
    token = JSON.parse(decoded);
  } catch {
    throw new TimedMediaError("Invidious returned an invalid account token.");
  }
  if (token === null || typeof token !== "object" || Array.isArray(token)) {
    throw new TimedMediaError("Invidious returned an invalid account token.");
  }
  const t = token as Record<string, any>;
  const session = t.session;
  const scopes = t.scopes;
  const signature = t.signature;
  if (
    typeof session !== "string" || !session ||
    typeof signature !== "string" || !signature ||
    !Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")
  ) {
    throw new TimedMediaError("Invidious returned an incomplete account token.");
  }
  if (!scopesIncludeRequired(scopes)) {
    throw new TimedMediaError("Invidious account token is missing a required scope.");
  }
  const expire = t.expire;
  if (expire !== undefined && expire !== null && (typeof expire !== "number" || expire <= 0)) {
    throw new TimedMediaError("Invidious returned an invalid token expiration.");
  }
  return t;
}

function scopesIncludeRequired(scopes: unknown): boolean {
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) return false;
  const set = new Set(scopes as string[]);
  return ACCOUNT_SCOPES.every((scope) => set.has(scope));
}

function storedTokenIsUsable(token: unknown): boolean {
  if (token === null || typeof token !== "object" || Array.isArray(token)) return false;
  const t = token as Record<string, any>;
  if (typeof t.session !== "string" || !t.session) return false;
  if (typeof t.signature !== "string" || !t.signature) return false;
  const expire = t.expire;
  if (expire !== undefined && expire !== null && (typeof expire !== "number" || expire <= 0)) return false;
  if (typeof expire === "number" && expire <= Date.now() / 1000) return false;
  return true;
}

export async function completeInvidiousAccountAuthorization(
  args: { owner_id: string; state: string; token: string },
  settings?: Settings,
): Promise<Record<string, any>> {
  const s = settings ?? get_settings();
  purgeExpired(args.owner_id, s);
  const flow = consumePendingFlow(args.owner_id, args.state, s);
  if (flow === null) {
    throw new TimedMediaError("Invidious account callback is unknown, expired, or already used.");
  }
  const parsedToken = parseToken(args.token);
  await requestPreferences(flow.api_base_url, parsedToken);
  writeAccount(args.owner_id, {
    version: 1,
    api_base_url: flow.api_base_url,
    scopes: [...ACCOUNT_SCOPES],
    connected_at: new Date().toISOString(),
    token: parsedToken,
  }, s);
  return invidiousAccountStatus(args.owner_id, s);
}

export function invidiousAccountStatus(ownerId: string, settings?: Settings): Record<string, any> {
  const s = settings ?? get_settings();
  const payload = readAccount(ownerId, s);
  const token = payload.token;
  const base = payload.api_base_url;
  const scopes = payload.scopes;
  const connectedAt = payload.connected_at;
  if (!storedTokenIsUsable(token) || typeof base !== "string" || !base) {
    return { connected: false };
  }
  if (!scopesIncludeRequired(scopes)) {
    return { connected: false, needs_reauthorization: true };
  }
  if (base !== String(loadVideoLearningSettings(s).invidious?.api_base_url ?? "")) {
    return { connected: false, needs_reauthorization: true };
  }
  if (typeof connectedAt !== "string" || !connectedAt) {
    return { connected: false };
  }
  return {
    connected: true,
    api_base_url: base,
    scopes: (scopes as unknown[]).map(String),
    connected_at: connectedAt,
  };
}

export async function disconnectInvidiousAccount(
  args: { owner_id: string },
  settings?: Settings,
): Promise<Record<string, any>> {
  const s = settings ?? get_settings();
  const payload = readAccount(args.owner_id, s);
  const token = payload.token;
  const base = payload.api_base_url;
  if (!storedTokenIsUsable(token) || typeof base !== "string" || !base) {
    forgetAccount(args.owner_id, s);
    return { connected: false };
  }
  try {
    await revokeToken(base, token as Record<string, unknown>);
  } catch (e) {
    if (e instanceof InvidiousTransportError) {
      throw new TimedMediaError(
        "Invidious account disconnection request failed. The saved connection was kept so it can be retried.",
      );
    }
    throw e;
  }
  forgetAccount(args.owner_id, s);
  return { connected: false };
}

function catalogPayload(data: unknown, kind: string, publicBase: string): unknown {
  const videoIdRe = /^[A-Za-z0-9_-]{11}$/;
  const toVideo = (raw: unknown): Record<string, any> | null => {
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, any>;
    const vid = String(r.videoId ?? "");
    if (!videoIdRe.test(vid)) return null;
    let thumbnail = `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
    const thumbs = Array.isArray(r.videoThumbnails) ? r.videoThumbnails : [];
    const publicHost = (() => { try { return new URL(publicBase).host; } catch { return ""; } })();
    for (const entry of thumbs) {
      if (entry === null || typeof entry !== "object") continue;
      const candidate = new URL(String((entry as Record<string, unknown>).url ?? ""), `${publicBase}/`).toString();
      try {
        const parsed = new URL(candidate);
        if (
          (parsed.protocol === "http:" || parsed.protocol === "https:") &&
          !parsed.username && !parsed.password &&
          parsed.host === publicHost
        ) {
          thumbnail = candidate;
          break;
        }
      } catch { /* ignore */ }
    }
    const duration = r.lengthSeconds ?? 0;
    return {
      videoId: vid,
      title: String(r.title ?? ""),
      author: String(r.author ?? ""),
      lengthSeconds: typeof duration === "number" && duration > 0 ? Math.trunc(duration) : 0,
      videoThumbnails: [{ url: thumbnail }],
    };
  };

  if (kind === "playlists") {
    return Array.isArray(data)
      ? data
          .filter((item): item is Record<string, any> => item !== null && typeof item === "object")
          .filter((item) => /^[A-Za-z0-9_-]{1,100}$/.test(String(item.playlistId ?? "")))
          .map((item) => ({
            playlistId: item.playlistId,
            title: String(item.title ?? ""),
            videoCount: item.videoCount ?? 0,
            videos: (Array.isArray(item.videos) ? item.videos : [])
              .map(toVideo)
              .filter((v): v is Record<string, any> => v !== null),
          }))
      : [];
  }
  const rows = Array.isArray(data) ? data : (data as Record<string, any>)?.videos;
  return {
    videos: (Array.isArray(rows) ? rows : [])
      .map(toVideo)
      .filter((v): v is Record<string, any> => v !== null),
  };
}

export async function browseInvidious(
  args: { owner_id: string; kind: string; query?: string; page?: number; playlist_id?: string },
  settings?: Settings,
): Promise<unknown> {
  const s = settings ?? get_settings();
  const vSettings = loadVideoLearningSettings(s);
  const base = String(vSettings.invidious?.api_base_url ?? "");
  if (!base) throw new TimedMediaError("Invidious is not configured.");
  const publicBase = String(vSettings.invidious?.public_base_url ?? "") || base;
  const kind = args.kind;
  const query = args.query ?? "";
  const page = args.page ?? 1;
  const playlistId = args.playlist_id ?? "";

  let path: string;
  let params: Record<string, string | number>;
  let token: Record<string, unknown> | null = null;
  if (kind === "search") {
    path = "/api/v1/search";
    params = { q: query, page, type: "video" };
  } else {
    if (!invidiousAccountStatus(args.owner_id, s).connected) {
      throw new TimedMediaError("Reconnect your Invidious account to browse your videos.");
    }
    token = readAccount(args.owner_id, s).token as Record<string, unknown>;
    if (kind === "feed") {
      path = "/api/v1/auth/feed";
      params = { page, max_results: 24 };
    } else if (kind === "playlists") {
      path = "/api/v1/auth/playlists";
      params = {};
    } else if (kind === "playlist") {
      if (!playlistId || playlistId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(playlistId)) {
        throw new TimedMediaError("Invalid playlist identifier.");
      }
      path = `/api/v1/auth/playlists/${encodeURIComponent(playlistId)}`;
      params = { page };
    } else {
      throw new TimedMediaError("Unknown video browser view.");
    }
  }
  const data = await requestCatalog(base, path, params, token);
  return catalogPayload(data, kind, publicBase);
}

export function authorizationFailureCode(error: unknown, hasToken: boolean): string {
  if (!hasToken) return "authorization_cancelled";
  const message = error instanceof TimedMediaError ? String(error.message) : "";
  if (message === "Invidious account callback is unknown, expired, or already used.") {
    return "authorization_expired";
  }
  if (message === "Invidious account token is missing a required scope.") {
    return "authorization_scopes";
  }
  if (message.startsWith("Invidious returned an")) return "authorization_token_invalid";
  if (
    message === "Invidious account verification failed with HTTP 401." ||
    message === "Invidious account verification failed with HTTP 403."
  ) {
    return "authorization_token_rejected";
  }
  if (message.startsWith("Invidious account verification")) return "authorization_unavailable";
  return "authorization_failed";
}

// snake_case aliases
export const invidious_redirect_uri = invidiousRedirectUri;
export const begin_invidious_account_authorization = beginInvidiousAccountAuthorization;
export const complete_invidious_account_authorization = completeInvidiousAccountAuthorization;
export const invidious_account_status = invidiousAccountStatus;
export const disconnect_invidious_account = disconnectInvidiousAccount;
export const browse_invidious = browseInvidious;
export const authorization_failure_code = authorizationFailureCode;
