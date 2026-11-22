// auth router mounted at /api/auth.
// Hono equivalent of the FastAPI router: login/logout/status/registration,
// profile, device credentials, session handoff, and admin user management.
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

import {
  AUTH_ENABLED,
  POCKETBASE_ENABLED,
  TOKEN_EXPIRE_HOURS,
  authenticate,
  authenticate_device,
  authenticate_pb,
  create_token,
  decode_token,
  delete_user,
  get_user_info,
  get_learner_profile,
  is_first_user,
  list_users,
  register_pb,
  set_avatar,
  set_learner_profile,
  set_role,
  hash_password,
  verify_password,
} from "../services/auth/service.js";
import type { TokenPayload } from "../services/auth/service.js";
import {
  authDir,
  deleteAvatarFile,
  getAvatarFile,
  getUser,
  getUserById,
  saveAvatarFile,
  saveUser,
  setMustChangePassword,
  setPassword,
} from "../services/auth/identity.js";
import {
  heartbeatDeviceCredential,
  issueDeviceCredential,
  listDeviceCredentials,
  revokeDeviceCredential,
} from "../services/auth/device_credentials.js";
import {
  canonicalHost,
  decryptTicketPayload,
  encryptTicketPayload,
  getSessionHandoffStore,
  hashSecret,
  isLoopbackHost,
  publicOrigin,
  HandoffError,
  HandoffRateLimited,
  HandoffRejected,
  CODE_LIFETIME_SECONDS,
  TICKET_LIFETIME_SECONDS,
} from "../services/auth/session_handoff.js";
import { logAdminAction, logUsage } from "../services/auth/audit.js";
import { learningPolicyForUser } from "../services/auth/learning_access.js";
import { learnerGrant, saveGrant } from "../services/auth/grants.js";
import { normalizeProfile } from "../services/auth/learner_profile.js";
import { loadAuthSettings } from "../services/auth/settings.js";
import {
  localAdminUser,
  setCurrentUser,
  resetCurrentUser,
  userFromTokenPayload,
} from "../services/auth/paths.js";

export const authRouter = new Hono();

const COOKIE_NAME = "dt_token";
const COOKIE_MAX_AGE = TOKEN_EXPIRE_HOURS * 3600;
const USER_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
const USER_IMPORT_MAX_ROWS = 500;
const USER_BATCH_MAX_ROWS = 500;
const FRONTEND_HOST_HEADER = "x-deeptutor-frontend-host";

const AUTH_RUNTIME_SETTINGS = loadAuthSettings();
const PRIVATE_LOGIN_HOSTS = new Set(
  (AUTH_RUNTIME_SETTINGS.private_login_hosts ?? []).map((h) =>
    String(h).toLowerCase().replace(/\.+$/, ""),
  ),
);

const SECURE = Boolean(AUTH_RUNTIME_SETTINGS.cookie_secure);
const SAMESITE: "None" | "Lax" = SECURE ? "None" : "Lax";

function trustedProxyIps(): Set<string> {
  const raw = process.env["AUTH_TRUSTED_FRONTEND_PROXY_IPS"] ?? "127.0.0.1,::1";
  const out = new Set<string>();
  for (const item of raw.split(",")) {
    const ip = item.trim();
    if (isIP(ip) !== 0) out.add(ip);
  }
  return out;
}
const TRUSTED_FRONTEND_PROXY_IPS = trustedProxyIps();

function clientIp(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "";
}

function requestFrontendHost(c: Context): string {
  const peer = clientIp(c);
  if (!peer || isIP(peer) === 0 || !TRUSTED_FRONTEND_PROXY_IPS.has(peer)) return "";
  const raw = c.req.header(FRONTEND_HOST_HEADER) ?? "";
  try {
    return canonicalHost(raw);
  } catch {
    return "";
  }
}

function requirePrivateFrontend(c: Context): void {
  if (PRIVATE_LOGIN_HOSTS.size === 0) return;
  const host = requestFrontendHost(c);
  if (isLoopbackHost(host) || PRIVATE_LOGIN_HOSTS.has(host)) return;
  throw new HttpError(403, "Sign-in is only available from a private DeepTutor origin");
}

function noStore(c: Context): void {
  c.header("Cache-Control", "no-store");
}

// ---------------------------------------------------------------------------
// HTTP error helper (FastAPI HTTPException equivalent)
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public headers: Record<string, string> = {},
  ) {
    super(detail);
  }
}

function fail(status: number, detail: string): never {
  throw new HttpError(status, detail);
}

// Install a catch-all that renders HttpError like FastAPI's {"detail": ...}.
authRouter.onError((err, c) => {
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers)) c.header(k, v);
    return c.json({ detail: err.detail }, err.status as never);
  }
  console.error(err);
  return c.json({ detail: "Internal Server Error" }, 500);
});

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

function cookieAttrs() {
  return {
    httpOnly: true,
    sameSite: SAMESITE,
    secure: SECURE,
    path: "/",
  } as const;
}

function setAuthCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, token, { ...cookieAttrs(), maxAge: COOKIE_MAX_AGE });
}

function clearAuthCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, cookieAttrs());
}

// ---------------------------------------------------------------------------
// Token extraction + guards (require_auth / require_admin equivalents)
// ---------------------------------------------------------------------------

function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(/\s+/, 2);
  // split(None, 1) keeps remainder; emulate: "Bearer <token>"
  const idx = authHeader.indexOf(" ");
  if (idx < 0) return null;
  const scheme = authHeader.slice(0, idx);
  const token = authHeader.slice(idx + 1).trim();
  void parts;
  if (scheme.toLowerCase() === "bearer" && token) return token;
  return null;
}

function extractToken(c: Context): string | null {
  return bearerToken(c.req.header("authorization")) ?? getCookie(c, COOKIE_NAME) ?? null;
}

/**
 * require_auth: returns the TokenPayload, or null when auth is disabled
 * (local admin semantics). Throws 401 when enabled but unauthenticated.
 * Also installs the request-local current user.
 */
async function requireAuth(c: Context): Promise<TokenPayload | null> {
  if (!AUTH_ENABLED) {
    installCurrentUser(null);
    return null;
  }
  const token = extractToken(c);
  if (!token) {
    fail(401, "Not authenticated");
  }
  const payload = await decode_token(token as string);
  if (!payload) {
    throw new HttpError(401, "Invalid or expired token", {
      "WWW-Authenticate": "Bearer",
    });
  }
  installCurrentUser(payload);
  return payload;
}

function installCurrentUser(payload: TokenPayload | null): void {
  const user = payload === null ? localAdminUser() : userFromTokenPayload(payload);
  setCurrentUser(user);
}

/** require_admin: TokenPayload (synthetic local admin when disabled). */
async function requireAdmin(c: Context): Promise<TokenPayload> {
  if (!AUTH_ENABLED) {
    return {
      username: "local",
      role: "admin",
      user_id: "local-admin",
      device_credential_id: "",
      device_session_nonce: "",
    };
  }
  const payload = await requireAuth(c);
  if (payload === null || payload.role !== "admin") {
    fail(403, "Admin access required");
  }
  return payload;
}

/** Optional decode for public endpoints (status/login): never throws. */
async function optionalPayload(c: Context): Promise<TokenPayload | null> {
  if (!AUTH_ENABLED) return null;
  const token = extractToken(c);
  if (!token) return null;
  return decode_token(token);
}

// ---------------------------------------------------------------------------
// Validation helpers (pydantic-equivalent)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PLAIN_RE = /^[A-Za-z0-9_\-.]{3,64}$/;
const CJK_RE = /^[\u4e00-\u9fff]{2,64}$/;
const ICON_MARKER_RE = /^icon:[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$/;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VALID_ROLES = new Set(["admin", "teacher", "student", "user"]);
const ACCOUNT_PRESETS = new Set(["standard", "learner", "custom"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await c.req.json();
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") fail(422, `${field}: Field required`);
  return value;
}

function validUsername(username: string): string {
  const v = username.trim();
  if (!v) fail(422, "Username or email cannot be empty");
  if (!(EMAIL_RE.test(v) || PLAIN_RE.test(v) || CJK_RE.test(v))) {
    fail(422, "Enter a valid email address or username");
  }
  return v;
}

function validPassword(password: string): string {
  if (typeof password !== "string" || password.length < 8) {
    fail(422, "Password must be at least 8 characters");
  }
  return password;
}

function validPreset(value: unknown): string {
  const preset = typeof value === "string" && value.trim() ? value.trim() : "standard";
  if (!ACCOUNT_PRESETS.has(preset)) {
    fail(422, "preset: Input should be 'standard', 'learner' or 'custom'");
  }
  return preset;
}

// ---------------------------------------------------------------------------
// Public endpoints
// ---------------------------------------------------------------------------

// TODO(port): upstream proxies this to deeptutor.services.codex_auth — the
// codex OAuth subsystem is not part of the TS backend yet, so the callback
// always reports the controlled failure page.
authRouter.get("/openai-codex/callback", (c) => {
  c.header("Cache-Control", "no-store");
  // TODO(port): upstream delivers the code/state to the codex OAuth service,
  // which is not part of the TS backend yet — always the failure page.
  return c.html(
    "<!doctype html><title>DeepTutor Codex</title>" +
      "<p>Authentication could not be received. Return to DeepTutor and try again.</p>",
    400,
  );
});

authRouter.get("/status", async (c) => {
  if (!AUTH_ENABLED) {
    return c.json({
      enabled: false,
      authenticated: true,
      user_id: "local-admin",
      username: "local",
      role: "admin",
      is_admin: true,
      avatar: "",
      preset: "standard",
      learning_policy: null,
    });
  }

  const payload = await optionalPayload(c);
  let avatar = "";
  let preset: string | null = null;
  let learningPolicy: Record<string, unknown> | null = null;
  if (payload !== null) {
    const info = get_user_info(payload.username);
    if (info) {
      avatar = String(info["avatar"] ?? "");
      const rawPreset = String(info["preset"] ?? "standard");
      preset = rawPreset === "learner" || rawPreset === "custom" ? rawPreset : "standard";
    }
    try {
      learningPolicy = learningPolicyForUser(payload.user_id, payload.role === "admin");
    } catch {
      learningPolicy = null;
    }
    if (learningPolicy !== null && preset !== "learner") preset = "learner";
  }
  return c.json({
    enabled: true,
    authenticated: payload !== null,
    user_id: payload ? payload.user_id : null,
    username: payload ? payload.username : null,
    role: payload ? payload.role : null,
    is_admin: payload ? payload.role === "admin" : false,
    avatar,
    preset,
    learning_policy: learningPolicy,
  });
});

authRouter.post("/login", async (c) => {
  const data = await jsonBody(c);
  if (!AUTH_ENABLED) {
    return c.json({ ok: true, message: "Auth is disabled — no login required." });
  }
  noStore(c);
  requirePrivateFrontend(c);

  const username = String(data["username"] ?? "");
  const password = String(data["password"] ?? "");

  if (POCKETBASE_ENABLED) {
    const pbResult = await authenticate_pb(username, password);
    if (!pbResult) fail(401, "Incorrect email or password");
    const [payload, pbToken] = pbResult;
    setAuthCookie(c, pbToken);
    return c.json({
      ok: true,
      user_id: payload.user_id,
      username: payload.username,
      role: payload.role,
      is_admin: payload.role === "admin",
    });
  }

  const result = authenticate(username, password);
  if (!result) fail(401, "Incorrect username or password");

  const token = await create_token(result.username, result.role, result.user_id);
  setAuthCookie(c, token);
  const info = get_user_info(result.username) ?? {};
  return c.json({
    ok: true,
    user_id: result.user_id,
    username: result.username,
    role: result.role,
    is_admin: result.role === "admin",
    must_change_password: Boolean(info["must_change_password"] ?? false),
  });
});

function requireBuiltinDeviceAuth(): void {
  if (!AUTH_ENABLED) {
    fail(400, "Device credentials require built-in authentication.");
  }
  if (POCKETBASE_ENABLED) {
    fail(400, "Device credentials are not supported in PocketBase mode.");
  }
}

authRouter.post("/device-login", async (c) => {
  const data = await jsonBody(c);
  requireBuiltinDeviceAuth();
  const pairingCode = String(data["pairing_code"] ?? "");
  const pin = String(data["pin"] ?? "");
  if (pairingCode.length < 8 || pairingCode.length > 128 || pin.length !== 6) {
    fail(422, "Invalid device credentials payload");
  }
  const payload = authenticate_device(pairingCode, pin);
  if (payload === null) fail(401, "Incorrect device credentials");

  const token = await create_token(
    payload.username,
    payload.role,
    payload.user_id,
    payload.device_credential_id,
    payload.device_session_nonce,
  );
  setAuthCookie(c, token);
  return c.json({
    ok: true,
    user_id: payload.user_id,
    username: payload.username,
    role: payload.role,
    is_admin: payload.role === "admin",
    device_credential_id: payload.device_credential_id,
  });
});

// -- session handoff -----------------------------------------------------------

authRouter.post("/session-handoff", async (c) => {
  noStore(c);
  const data = await jsonBody(c);
  const payload = await requireAuth(c);
  if (!AUTH_ENABLED || payload === null || PRIVATE_LOGIN_HOSTS.size === 0) {
    fail(
      400,
      "Session handoff requires authentication and configured private login hosts.",
    );
  }
  requirePrivateFrontend(c);

  const publicOriginRaw = String(data["public_origin"] ?? "");
  if (publicOriginRaw.length < 8 || publicOriginRaw.length > 2048) {
    fail(422, "public_origin: String should have at least 8 characters");
  }
  try {
    const targetOrigin = publicOrigin(publicOriginRaw);
    const targetHost = canonicalHost(targetOrigin.replace(/^https:\/\//, ""));
    const now = Math.floor(Date.now() / 1000);
    const ticketClaims: Record<string, unknown> = {
      nonce: randomTokenUrl(24),
      host: targetHost,
      exp: now + CODE_LIFETIME_SECONDS + TICKET_LIFETIME_SECONDS,
    };
    if (POCKETBASE_ENABLED) {
      ticketClaims["mode"] = "pocketbase";
      ticketClaims["token"] = extractToken(c);
    } else {
      ticketClaims["mode"] = "builtin";
      ticketClaims["username"] = payload.username;
      ticketClaims["role"] = payload.role;
      ticketClaims["user_id"] = payload.user_id;
      ticketClaims["device_credential_id"] = payload.device_credential_id;
      ticketClaims["device_session_nonce"] = payload.device_session_nonce;
    }
    const ticket = encryptTicketPayload(ticketClaims);
    const record = getSessionHandoffStore().create({
      encrypted_ticket: ticket,
      ticket_hash: hashSecret(ticket),
      public_host: targetHost,
      rate_key: payload.user_id || payload.username,
    });
    return c.json({
      ok: true,
      code: record.code,
      handoff_url: `${targetOrigin}/handoff?code=${record.code}`,
      expires_at: record.expires_at,
      expires_in: CODE_LIFETIME_SECONDS,
    });
  } catch (e) {
    if (e instanceof HandoffRateLimited) {
      fail(429, "Too many handoff requests. Try again later.");
    }
    if (e instanceof HandoffError) {
      fail(400, "Enter a valid HTTPS public origin");
    }
    throw e;
  }
});

authRouter.post("/session-handoff/exchange", async (c) => {
  noStore(c);
  const data = await jsonBody(c);
  const host = requestFrontendHost(c);
  if (!host) fail(400, "Pairing request has no valid frontend host");
  const code = String(data["code"] ?? "");
  if (code.length < 16 || code.length > 256) fail(422, "code: String should have at least 16 characters");
  try {
    const ticket = getSessionHandoffStore().exchange({ code, public_host: host });
    return c.json({ ok: true, ticket });
  } catch (e) {
    if (e instanceof HandoffRateLimited) {
      fail(429, "Too many handoff requests. Try again later.");
    }
    if (e instanceof HandoffError) {
      fail(400, "Pairing code is invalid, expired, or already used");
    }
    throw e;
  }
});

authRouter.post("/session-handoff/complete", async (c) => {
  noStore(c);
  const data = await jsonBody(c);
  const host = requestFrontendHost(c);
  if (!host) fail(400, "Handoff request has no valid frontend host");
  const ticketInput = String(data["ticket"] ?? "");
  if (ticketInput.length < 32 || ticketInput.length > 8192) {
    fail(422, "ticket: String should have at least 32 characters");
  }
  let token: string;
  try {
    const ticket = getSessionHandoffStore().consumeTicket({
      ticket: ticketInput,
      public_host: host,
    });
    const claims = decryptTicketPayload(ticket);
    if (String(claims["host"] ?? "") !== host) throw new HandoffRejected("Invalid handoff ticket");
    const expiresAt = Number(claims["exp"]);
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      throw new HandoffRejected("Invalid handoff ticket");
    }
    const mode = String(claims["mode"] ?? "");
    if (mode === "pocketbase") {
      const pbToken = String(claims["token"] ?? "");
      if (!pbToken) throw new HandoffRejected("Invalid handoff ticket");
      const decoded = await decode_token(pbToken);
      if (decoded === null) throw new HandoffRejected("Invalid handoff ticket");
      token = pbToken;
    } else if (mode === "builtin") {
      token = await create_token(
        String(claims["username"] ?? ""),
        String(claims["role"] ?? "user"),
        String(claims["user_id"] ?? ""),
        String(claims["device_credential_id"] ?? ""),
        String(claims["device_session_nonce"] ?? ""),
      );
    } else {
      throw new HandoffRejected("Invalid handoff ticket");
    }
  } catch (e) {
    if (e instanceof HandoffRateLimited) {
      fail(429, "Too many handoff requests. Try again later.");
    }
    if (e instanceof HandoffError) {
      fail(400, "Handoff ticket is invalid, expired, or already used");
    }
    throw e;
  }
  setAuthCookie(c, token);
  return c.json({ ok: true });
});

authRouter.post("/device/heartbeat", async (c) => {
  const payload = await requireAuth(c);
  if (!AUTH_ENABLED) {
    fail(400, "Device credentials require built-in authentication.");
  }
  if (payload === null || !payload.device_credential_id || !payload.device_session_nonce) {
    fail(400, "This session does not use a device credential.");
  }
  try {
    const device = heartbeatDeviceCredential(payload.device_credential_id, {
      user_id: payload.user_id,
      session_nonce: payload.device_session_nonce,
    });
    const limitReached = Boolean(device["limit_reached"]);
    delete device["limit_reached"];
    return c.json({ ok: !limitReached, ...device });
  } catch {
    clearAuthCookie(c);
    fail(401, "Device session is no longer active");
  }
});

authRouter.post("/logout", (c) => {
  clearAuthCookie(c);
  return c.json({ ok: true });
});

authRouter.post("/register", async (c) => {
  const data = await jsonBody(c);
  if (!AUTH_ENABLED) {
    fail(400, "Auth is disabled — registration is not available.");
  }
  noStore(c);
  requirePrivateFrontend(c);

  const username = validUsername(String(data["username"] ?? ""));
  const password = validPassword(String(data["password"] ?? ""));

  if (POCKETBASE_ENABLED) {
    if (!is_first_user()) {
      fail(403, "Self-registration is closed. Ask an administrator to create your account.");
    }
    const result = await register_pb(username, username, password);
    if (!result) {
      fail(409, "Registration failed — username or email may already be taken.");
    }
    return c.json(
      {
        ok: true,
        user_id: String(result["id"] ?? ""),
        username,
        role: "user",
        is_first_user: true,
        is_admin: false,
      },
      201,
    );
  }

  if (!is_first_user()) {
    fail(403, "Self-registration is closed. Ask an administrator to create your account.");
  }
  const existing = new Set(list_users().map((u) => String(u["username"])));
  if (existing.has(username)) fail(409, "Username already taken");

  // First user is promoted to admin inside saveUser.
  saveUser(username, hash_password(password), "user", "standard");
  let userId = "";
  let role = "user";
  for (const item of list_users()) {
    if (item["username"] === username) {
      userId = String(item["id"] ?? "");
      role = String(item["role"] ?? "user");
      break;
    }
  }
  return c.json(
    {
      ok: true,
      user_id: userId,
      username,
      role,
      is_first_user: true,
      is_admin: role === "admin",
    },
    201,
  );
});

authRouter.get("/is_first_user", (c) => {
  return c.json({ is_first_user: AUTH_ENABLED ? is_first_user() : false });
});

// ---------------------------------------------------------------------------
// Profile endpoints (any authenticated user, self-service)
// ---------------------------------------------------------------------------

const AVATAR_MAX_BYTES = 1 * 1024 * 1024;
const AVATAR_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

function sniffImage(data: Buffer): string | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "jpg";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

function requireProfileIdentity(payload: TokenPayload | null): TokenPayload {
  if (!AUTH_ENABLED || payload === null) {
    fail(400, "Auth is disabled — profiles are not available.");
  }
  return payload as TokenPayload;
}

function requireLocalPasswordAuth(): void {
  if (!AUTH_ENABLED || POCKETBASE_ENABLED) {
    fail(400, "Password changes are only available for local authenticated accounts.");
  }
}

function userInfoResponse(info: Record<string, unknown>, canChangePassword: boolean) {
  return {
    id: String(info["id"] ?? ""),
    username: String(info["username"] ?? ""),
    role: String(info["role"] ?? ""),
    created_at: String(info["created_at"] ?? ""),
    disabled: Boolean(info["disabled"] ?? false),
    avatar: String(info["avatar"] ?? ""),
    preset: String(info["preset"] ?? "standard"),
    must_change_password: Boolean(info["must_change_password"] ?? false),
    can_change_password: canChangePassword,
  };
}

authRouter.get("/profile", async (c) => {
  const payload = await requireAuth(c);
  const current = requireProfileIdentity(payload);
  const info = get_user_info(current.username);
  if (info === null) {
    return c.json({
      id: current.user_id,
      username: current.username,
      role: current.role,
      created_at: "",
      disabled: false,
      avatar: "",
      preset: "standard",
      must_change_password: false,
      can_change_password: !POCKETBASE_ENABLED,
    });
  }
  return c.json(userInfoResponse(info, !POCKETBASE_ENABLED));
});

authRouter.put("/profile", async (c) => {
  const payload = await requireAuth(c);
  const current = requireProfileIdentity(payload);
  const data = await jsonBody(c);
  const avatar = String(data["avatar"] ?? "").trim();
  if (avatar && !ICON_MARKER_RE.test(avatar)) {
    fail(422, "Avatar must be empty or 'icon:<name>:<color>'");
  }
  if (!set_avatar(current.username, avatar)) fail(404, "User not found");
  if (current.user_id && USER_ID_RE.test(current.user_id)) {
    deleteAvatarFile(current.user_id);
  }
  return c.json({ ok: true, avatar });
});

authRouter.put("/profile/avatar", async (c) => {
  const payload = await requireAuth(c);
  const current = requireProfileIdentity(payload);
  if (POCKETBASE_ENABLED) {
    fail(400, "Avatar upload is not available in PocketBase mode.");
  }
  if (!current.user_id || !USER_ID_RE.test(current.user_id)) {
    fail(400, "Cannot store an avatar for this account.");
  }
  const info = get_user_info(current.username);
  if (info === null) fail(404, "User not found");

  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) fail(422, "file: Field required");
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > AVATAR_MAX_BYTES) {
    fail(413, "Avatar image is too large (max 1 MB).");
  }
  const ext = sniffImage(data);
  if (ext === null) {
    fail(415, "Avatar must be a PNG, JPEG or WebP image.");
  }

  const previous = String(info!["avatar"] ?? "");
  let version = 1;
  if (previous.startsWith("img:")) {
    const parsed = Number.parseInt(previous.split(":", 2)[1] ?? "", 10);
    version = Number.isFinite(parsed) ? parsed + 1 : 1;
  }
  const marker = `img:${version}`;

  saveAvatarFile(current.user_id, data, ext);
  if (!set_avatar(current.username, marker)) fail(404, "User not found");
  return c.json({ ok: true, avatar: marker });
});

authRouter.delete("/profile/avatar", async (c) => {
  const payload = await requireAuth(c);
  const current = requireProfileIdentity(payload);
  if (current.user_id && USER_ID_RE.test(current.user_id)) {
    deleteAvatarFile(current.user_id);
  }
  set_avatar(current.username, "");
  return c.json({ ok: true, avatar: "" });
});

authRouter.get("/avatar/:user_id", async (c) => {
  await requireAuth(c);
  const userId = c.req.param("user_id");
  if (!USER_ID_RE.test(userId)) fail(404, "Avatar not found");
  const target = getAvatarFile(userId);
  if (target === null) fail(404, "Avatar not found");
  const ext = extname(target).slice(1).toLowerCase();
  const mediaType = AVATAR_MEDIA_TYPES[ext] ?? "application/octet-stream";
  const data = readFileSync(target);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": mediaType,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    },
  });
});

authRouter.put("/profile/password", async (c) => {
  const payload = await requireAuth(c);
  const current = requireProfileIdentity(payload);
  requireLocalPasswordAuth();
  const data = await jsonBody(c);
  const currentPassword = String(data["current_password"] ?? "");
  const newPassword = String(data["new_password"] ?? "");
  if (newPassword.length < 8) fail(422, "Password must be at least 8 characters");

  const record = getUser(current.username);
  if (record === null) fail(404, "User not found");
  if (!verify_password(currentPassword, String(record!["hash"] ?? ""))) {
    fail(400, "Current password is incorrect");
  }
  if (currentPassword === newPassword) {
    fail(400, "New password must differ from the current password");
  }
  if (setPassword(current.username, hash_password(newPassword)) === null) {
    fail(404, "User not found");
  }
  setMustChangePassword(current.username, false);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Device credentials (admin)
// ---------------------------------------------------------------------------

authRouter.get("/devices", async (c) => {
  await requireAdmin(c);
  requireBuiltinDeviceAuth();
  const userId = c.req.query("user_id") || null;
  const includeRevoked = c.req.query("include_revoked") === "true";
  const credentials = listDeviceCredentials({ user_id: userId, include_revoked: includeRevoked });
  const users = new Map(
    list_users().map((u) => [String(u["id"] ?? ""), String(u["username"] ?? "")]),
  );
  return c.json({
    devices: credentials.map((device) => ({
      ...device,
      username: users.get(String(device["user_id"] ?? "")) ?? "",
    })),
  });
});

authRouter.post("/devices", async (c) => {
  const current = await requireAdmin(c);
  requireBuiltinDeviceAuth();
  const data = await jsonBody(c);
  const userId = String(data["user_id"] ?? "");
  const deviceName = String(data["device_name"] ?? "");
  const expiresInDays = Number(data["expires_in_days"]);
  const dailyLimit = Number(data["daily_limit_minutes"]);
  if (!userId || userId.length > 64) fail(422, "user_id: String should have at least 1 character");
  if (!deviceName || deviceName.length > 80) fail(422, "device_name: String should have at least 1 character");
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
    fail(422, "expires_in_days: Input should be greater than or equal to 1");
  }
  if (!Number.isInteger(dailyLimit) || dailyLimit < 5 || dailyLimit > 1440) {
    fail(422, "daily_limit_minutes: Input should be greater than or equal to 5");
  }
  if (getUserById(userId) === null) fail(404, "User not found");
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 3600 * 1000);
  let issued: [Record<string, unknown>, string, string];
  try {
    issued = issueDeviceCredential({
      user_id: userId,
      device_name: deviceName,
      expires_at: expiresAt,
      daily_limit_minutes: dailyLimit,
    });
  } catch (e) {
    fail(400, (e as Error).message);
  }
  const [device, pairingCode, pin] = issued;
  logAdminAction("device_credential_issue", userId, {
    device_credential_id: device["id"],
    device_name: device["device_name"],
    expires_at: device["expires_at"],
    daily_limit_minutes: device["daily_limit_minutes"],
  });
  return c.json({ device, pairing_code: pairingCode, pin }, 201);
});

authRouter.delete("/devices/:device_credential_id", async (c) => {
  const current = await requireAdmin(c);
  requireBuiltinDeviceAuth();
  const device = revokeDeviceCredential(c.req.param("device_credential_id"), {
    revoked_by: String(current.user_id ?? ""),
  });
  if (device === null) fail(404, "Device credential not found");
  logAdminAction("device_credential_revoke", String(device["user_id"] ?? ""), {
    device_credential_id: device["id"],
  });
  return c.json({ device, ok: true });
});

// ---------------------------------------------------------------------------
// Admin user management
// ---------------------------------------------------------------------------

authRouter.get("/users", async (c) => {
  await requireAdmin(c);
  return c.json(
    list_users().map((info) => ({
      id: String(info["id"] ?? ""),
      username: String(info["username"] ?? ""),
      role: String(info["role"] ?? ""),
      created_at: String(info["created_at"] ?? ""),
      disabled: Boolean(info["disabled"] ?? false),
      avatar: String(info["avatar"] ?? ""),
      preset: String(info["preset"] ?? "standard"),
      must_change_password: Boolean(info["must_change_password"] ?? false),
      can_change_password: !POCKETBASE_ENABLED,
    })),
  );
});

function requireLocalLearner(current: TokenPayload): [string, Record<string, unknown>] {
  if (current.role === "admin") fail(403, "Learner profile required");
  const account = getUserById(current.user_id);
  if (account === null || account[0] !== current.username) fail(404, "User not found");
  if (String(account[1]["preset"] ?? "standard") !== "learner") {
    fail(403, "Learner profile required");
  }
  return account;
}

authRouter.get("/profile/learner-profile", async (c) => {
  const current = await requireAuth(c);
  if (current === null) fail(400, "Auth is disabled");
  requireLocalLearner(current as TokenPayload);
  const profile = get_learner_profile((current as TokenPayload).username);
  return c.json({ learner_profile: profile });
});

function learnerProfileBody(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const age = data["age"];
  if (age !== null && age !== undefined) {
    if (typeof age !== "number" || !Number.isInteger(age) || age < 3 || age > 120) {
      fail(422, "age: Input should be greater than or equal to 3");
    }
    out["age"] = age;
  }
  for (const field of ["grade_level", "curriculum", "language", "reading_level", "explanation_style"]) {
    const raw = data[field];
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== "string" || raw.length > 80) {
        fail(422, `${field}: String should have at most 80 characters`);
      }
      out[field] = raw;
    }
  }
  return out;
}

authRouter.put("/profile/learner-profile", async (c) => {
  const current = (await requireAuth(c)) as TokenPayload;
  if (current === null) fail(400, "Auth is disabled");
  requireLocalLearner(current);
  const data = await jsonBody(c);
  let profile: Record<string, unknown> | null;
  try {
    profile = normalizeProfile(learnerProfileBody(data));
  } catch (e) {
    fail(422, (e as Error).message);
  }
  const updated = set_learner_profile(current.username, profile);
  logUsage("learner_profile", current.user_id, "self_update", {
    fields: Object.keys(profile ?? {}).sort(),
  });
  return c.json({ learner_profile: updated });
});

authRouter.get("/users/:username/learner-profile", async (c) => {
  await requireAdmin(c);
  const username = c.req.param("username");
  const user = getUser(username);
  if (
    user === null ||
    String(user["role"] ?? "user") === "admin" ||
    String(user["preset"] ?? "standard") !== "learner"
  ) {
    fail(404, "User not found");
  }
  return c.json({ learner_profile: user["learner_profile"] ?? null });
});

authRouter.put("/users/:username/learner-profile", async (c) => {
  const current = await requireAdmin(c);
  const username = c.req.param("username");
  const user = getUser(username);
  if (
    user === null ||
    String(user["role"] ?? "user") === "admin" ||
    String(user["preset"] ?? "standard") !== "learner"
  ) {
    fail(404, "User not found");
  }
  const data = await jsonBody(c);
  let profile: Record<string, unknown> | null;
  try {
    profile = normalizeProfile(learnerProfileBody(data));
  } catch (e) {
    fail(422, (e as Error).message);
  }
  const updated = set_learner_profile(username, profile);
  logAdminAction("learner_profile_update", String(user["id"] ?? ""), {
    fields: Object.keys(profile ?? {}).sort(),
  });
  return c.json({ learner_profile: updated });
});

// -- admin user creation --------------------------------------------------------

async function createAdminUser(
  data: Record<string, unknown>,
  current: TokenPayload,
): Promise<Record<string, unknown>> {
  const username = validUsername(String(data["username"] ?? ""));
  const password = validPassword(String(data["password"] ?? ""));
  const preset = validPreset(data["preset"]);

  if (POCKETBASE_ENABLED) {
    if (preset !== "standard") {
      fail(400, "Only the standard preset is available in PocketBase mode.");
    }
    const result = await register_pb(username, username, password);
    if (!result) {
      fail(409, "Failed to create user — username may already be taken.");
    }
    return {
      ok: true,
      user_id: String(result!["id"] ?? ""),
      username,
      role: "user",
      is_admin: false,
      preset: "standard",
    };
  }

  const existing = list_users().some((u) => u["username"] === username);
  if (existing) fail(409, "Username already taken");

  saveUser(username, hash_password(password), "user", preset as never);
  const created = list_users().find((u) => u["username"] === username) ?? null;
  const userId = String(created?.["id"] ?? "");
  const role = String(created?.["role"] ?? "user");
  const createdPreset = String(created?.["preset"] ?? "standard");

  if (role !== "user") {
    delete_user(username);
    fail(500, "Only non-admin users can be provisioned by this endpoint.");
  }

  if (createdPreset === "learner") {
    try {
      saveGrant(userId, learnerGrant(userId));
    } catch {
      let rolledBack = false;
      try {
        rolledBack = delete_user(username);
      } catch {
        rolledBack = false;
      }
      if (!rolledBack) {
        // upstream logs the possibly-orphaned account
      }
      fail(500, "The learner preset could not be initialized.");
    }
  }

  setMustChangePassword(username, true);
  void current;
  return {
    ok: true,
    user_id: userId,
    username,
    role,
    is_admin: false,
    preset: createdPreset,
    must_change_password: true,
  };
}

authRouter.post("/users", async (c) => {
  if (!AUTH_ENABLED) {
    fail(400, "Auth is disabled — user creation is not available.");
  }
  const current = await requireAdmin(c);
  const data = await jsonBody(c);
  const created = await createAdminUser(data, current as TokenPayload);
  return c.json(created, 201);
});

// -- CSV user import ------------------------------------------------------------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function validationMessage(errors: string[]): string {
  return errors.join("; ");
}

authRouter.post("/users/import", async (c) => {
  if (!AUTH_ENABLED) {
    fail(400, "Auth is disabled — user import is not available.");
  }
  const current = await requireAdmin(c);

  const bodyData = await c.req.parseBody();
  const file = bodyData["file"];
  if (!(file instanceof File)) fail(422, "file: Field required");
  const content = Buffer.from(await file.arrayBuffer());
  if (content.length > USER_IMPORT_MAX_BYTES) {
    fail(413, "User import file exceeds 2 MB.");
  }
  let text: string;
  try {
    // utf-8-sig: strip BOM
    text = content.toString("utf-8").replace(/^﻿/, "");
  } catch {
    fail(400, "User import must be a UTF-8 CSV file.");
  }

  const allRows = parseCsv(text);
  // Drop a single trailing empty row produced by a final newline.
  if (allRows.length > 0) {
    const last = allRows[allRows.length - 1];
    if (last.length === 1 && last[0] === "") allRows.pop();
  }
  if (allRows.length === 0) {
    fail(422, "User import file contains no user rows.");
  }
  const header = allRows[0].map((h) => h.trim().toLowerCase());
  const expected = ["username", "password", "preset"];
  if (JSON.stringify(header) !== JSON.stringify(expected)) {
    fail(422, "CSV header must be exactly: username,password,preset");
  }
  const dataRows = allRows.slice(1);
  if (dataRows.length === 0) {
    fail(422, "User import file contains no user rows.");
  }
  if (dataRows.length > USER_IMPORT_MAX_ROWS) {
    fail(413, `User import cannot exceed ${USER_IMPORT_MAX_ROWS} rows.`);
  }

  interface ParsedRow {
    rowNumber: number;
    username: string;
    password: string;
    preset: string;
  }
  const parsed: ParsedRow[] = [];
  const results: Record<string, unknown>[] = [];

  dataRows.forEach((cols, idx) => {
    const rowNumber = idx + 2;
    const username = (cols[0] ?? "").trim();
    const hasExtra = cols.length > expected.length;
    if (hasExtra) {
      results.push({
        row: rowNumber,
        username: username.slice(0, 100),
        ok: false,
        error: "Row has more values than the CSV header.",
      });
      return;
    }
    const password = cols[1] ?? "";
    const preset = (cols[2] ?? "").trim() || "standard";
    const errors: string[] = [];
    let validName = username;
    try {
      validName = validUsername(username);
    } catch (e) {
      errors.push((e as HttpError).detail ?? "Invalid username");
    }
    if (password.length < 8) errors.push("password: Password must be at least 8 characters");
    if (!ACCOUNT_PRESETS.has(preset)) errors.push("preset: Input should be 'standard', 'learner' or 'custom'");
    if (errors.length > 0) {
      results.push({
        row: rowNumber,
        username: username.slice(0, 100),
        ok: false,
        error: validationMessage(errors),
      });
      return;
    }
    parsed.push({ rowNumber, username: validName, password, preset });
  });

  for (const row of parsed) {
    try {
      const created = await createAdminUser(
        { username: row.username, password: row.password, preset: row.preset },
        current as TokenPayload,
      );
      results.push({ row: row.rowNumber, username: row.username.slice(0, 100), ok: true, user: created });
    } catch (e) {
      const detail = e instanceof HttpError ? e.detail : "Failed to create user.";
      results.push({
        row: row.rowNumber,
        username: row.username.slice(0, 100),
        ok: false,
        error: detail,
      });
    }
  }

  results.sort((a, b) => Number(a["row"]) - Number(b["row"]));
  const createdCount = results.filter((r) => r["ok"] === true).length;
  const failedCount = results.length - createdCount;
  return c.json({
    ok: failedCount === 0,
    created_count: createdCount,
    failed_count: failedCount,
    results,
  });
});

function deleteAdminUser(username: string, current: TokenPayload | null): [number, string] {
  if (current && username === current.username) {
    return [400, "You cannot delete your own account"];
  }
  const info = get_user_info(username);
  const removed = delete_user(username);
  if (!removed) return [404, "User not found"];
  const userId = info ? String(info["id"] ?? "") : "";
  if (userId && USER_ID_RE.test(userId)) {
    deleteAvatarFile(userId);
  }
  return [200, ""];
}

authRouter.delete("/users/:username", async (c) => {
  const current = await requireAdmin(c);
  const username = c.req.param("username");
  const [statusCode, detail] = deleteAdminUser(username, current);
  if (statusCode !== 200) fail(statusCode, detail);
  return c.json({ ok: true });
});

authRouter.post("/users/batch-delete", async (c) => {
  const current = await requireAdmin(c);
  const data = await jsonBody(c);
  const rawUsernames = data["usernames"];
  if (!Array.isArray(rawUsernames) || rawUsernames.length === 0 || rawUsernames.length > USER_BATCH_MAX_ROWS) {
    fail(422, "usernames: List should have at least 1 item");
  }
  const usernames: string[] = [];
  for (const raw of rawUsernames) {
    const username = String(raw ?? "").trim();
    if (!username) fail(422, "Usernames cannot be empty");
    if (!usernames.includes(username)) usernames.push(username);
  }
  const results = usernames.map((username) => {
    const [statusCode, detail] = deleteAdminUser(username, current);
    void statusCode;
    return { username, ok: !detail, error: detail || null };
  });
  const deletedCount = results.filter((r) => r["ok"]).length;
  return c.json({
    ok: results.length - deletedCount === 0,
    deleted_count: deletedCount,
    failed_count: results.length - deletedCount,
    results,
  });
});

authRouter.put("/users/:username/role", async (c) => {
  const current = await requireAdmin(c);
  const username = c.req.param("username");
  const data = await jsonBody(c);
  const role = String(data["role"] ?? "");
  if (!VALID_ROLES.has(role)) {
    fail(422, `Role must be one of ${[...VALID_ROLES].sort().join(", ")}`);
  }
  if (current && username === current.username) {
    fail(400, "You cannot change your own role");
  }
  let updated = false;
  try {
    updated = set_role(username, role);
  } catch (e) {
    fail(422, (e as Error).message);
  }
  if (!updated) fail(404, "User not found");
  return c.json({ ok: true, username, role });
});

authRouter.put("/users/:username/password", async (c) => {
  const current = await requireAdmin(c);
  requireLocalPasswordAuth();
  const username = c.req.param("username");
  const data = await jsonBody(c);
  const newPassword = String(data["new_password"] ?? "");
  if (newPassword.length < 8) fail(422, "Password must be at least 8 characters");
  if (setPassword(username, hash_password(newPassword)) === null) {
    fail(404, "User not found");
  }
  setMustChangePassword(username, true);
  return c.json({ ok: true, username });
});

// ---------------------------------------------------------------------------
// Helpers exported for other routers / future wiring
// ---------------------------------------------------------------------------

export { requireAuth, requireAdmin, extractToken, optionalPayload };
export type { TokenPayload };

function randomTokenUrl(n: number): string {
  // secrets.token_urlsafe(n)
  return randomBytes(n).toString("base64url");
}
