// Port of deeptutor/services/auth.py — auth service: settings, JWT (HS256),
// bcrypt password hashing, PocketBase mode, and the user-store facade.
import { sign, verify } from "hono/jwt";
import { hashPassword, verifyPassword } from "./bcrypt.js";
import { beginDeviceSession, validateDeviceToken } from "./device_credentials.js";
import {
  deleteUser as identityDeleteUser,
  getLearnerProfile as identityGetLearnerProfile,
  getUser,
  getUserById,
  listUserInfo as identityListUserInfo,
  loadOrCreateAuthSecret,
  loadUsers,
  registerEnvBootstrapAdmin,
  saveUser,
  setAvatar as identitySetAvatar,
  setLearnerProfile as identitySetLearnerProfile,
  setPassword as identitySetPassword,
  setMustChangePassword,
  setRole as identitySetRole,
} from "./identity.js";
import { loadAuthSettings, loadIntegrationsSettings } from "./settings.js";
import {
  authenticatePb as pbAuthenticate,
  registerPb,
  validatePbToken,
} from "./pocketbase.js";
import { localAdminUser } from "./paths.js";
import type { AccountPreset, Role } from "./paths.js";

export interface TokenPayload {
  username: string;
  role: string;
  user_id: string;
  device_credential_id: string;
  device_session_nonce: string;
}

// ---------------------------------------------------------------------------
// Configuration — resolved once (mirrors upstream module-level constants).
// ---------------------------------------------------------------------------

function resolveConfig() {
  const auth = loadAuthSettings();
  const integrations = loadIntegrationsSettings();
  return {
    authEnabled: auth.enabled,
    authUsername: auth.username,
    authPasswordHash: auth.password_hash,
    tokenExpireHours: auth.token_expire_hours,
    pocketbaseBaseUrl: integrations.pocketbase_url.replace(/\/+$/, ""),
  };
}

const _config = resolveConfig();

export const AUTH_ENABLED = _config.authEnabled;
export const AUTH_USERNAME = _config.authUsername;
export const AUTH_PASSWORD_HASH = _config.authPasswordHash;
export const TOKEN_EXPIRE_HOURS = _config.tokenExpireHours;
export const POCKETBASE_BASE_URL = _config.pocketbaseBaseUrl;
export const POCKETBASE_ENABLED = Boolean(POCKETBASE_BASE_URL) && AUTH_ENABLED;

const ALGORITHM = "HS256";

export let AUTH_SECRET = "";
if (AUTH_ENABLED && !POCKETBASE_ENABLED && !AUTH_SECRET) {
  AUTH_SECRET = loadOrCreateAuthSecret();
}

// identity.save_user consults the env bootstrap admin lazily (avoids a cycle).
registerEnvBootstrapAdmin(() => [AUTH_USERNAME, AUTH_PASSWORD_HASH]);

// ---------------------------------------------------------------------------
// User store facade
// ---------------------------------------------------------------------------

export function hash_password(plain: string): string {
  return hashPassword(plain);
}
export function verify_password(plain: string, hashed: string): boolean {
  return verifyPassword(plain, hashed);
}

export function _load_users(): Record<string, Record<string, unknown>> {
  return loadUsers(AUTH_USERNAME, AUTH_PASSWORD_HASH) as Record<
    string,
    Record<string, unknown>
  >;
}

export function is_first_user(): boolean {
  return Object.keys(_load_users()).length === 0;
}

export function add_user(
  username: string,
  plainPassword: string,
  role: string = "user",
  preset: string = "standard",
): void {
  saveUser(username, hashPassword(plainPassword), role as Role, preset as AccountPreset);
}

export function list_users(): Record<string, unknown>[] {
  return identityListUserInfo(AUTH_USERNAME, AUTH_PASSWORD_HASH);
}

export function delete_user(username: string): boolean {
  return identityDeleteUser(username);
}

export function set_role(username: string, role: string): boolean {
  return identitySetRole(username, role as Role);
}

export function set_avatar(username: string, avatar: string): boolean {
  return identitySetAvatar(username, avatar);
}

export function get_user_info(username: string): Record<string, unknown> | null {
  for (const item of list_users()) {
    if (item["username"] === username) return item;
  }
  return null;
}

export function get_learner_profile(username: string): Record<string, unknown> | null {
  return identityGetLearnerProfile(username);
}

export function set_learner_profile(
  username: string,
  profile: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return identitySetLearnerProfile(username, profile);
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

export async function create_token(
  username: string,
  role = "user",
  userId: string | null = null,
  deviceCredentialId = "",
  deviceSessionNonce = "",
): Promise<string> {
  let uid = userId ?? "";
  if (!uid) {
    const record = _load_users()[username] ?? {};
    uid = String(record["id"] ?? "");
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: username,
    role,
    uid,
    dcid: deviceCredentialId,
    dcs: deviceSessionNonce,
    exp: now + TOKEN_EXPIRE_HOURS * 3600,
    iat: now,
  };
  return sign(payload, AUTH_SECRET, ALGORITHM);
}

export async function decode_token(token: string): Promise<TokenPayload | null> {
  if (!token) return null;

  if (POCKETBASE_ENABLED) {
    const payload = await validatePbToken(token);
    if (payload === null) return null;
    return {
      username: String(payload["username"] ?? ""),
      role: String(payload["role"] ?? "user"),
      user_id: String(payload["id"] ?? payload["uid"] ?? payload["user_id"] ?? ""),
      device_credential_id: "",
      device_session_nonce: "",
    };
  }

  if (!AUTH_SECRET) return null;
  try {
    const payload = (await verify(token, AUTH_SECRET, {
      alg: ALGORITHM,
      iat: false,
    })) as Record<string, unknown>;
    const username = payload["sub"];
    if (!username) return null;
    let userId = String(payload["uid"] ?? "");
    if (!userId) {
      const record = _load_users()[String(username)] ?? {};
      userId = String(record["id"] ?? "");
    }
    const deviceCredentialId = String(payload["dcid"] ?? "");
    const deviceSessionNonce = String(payload["dcs"] ?? "");
    if (deviceCredentialId) {
      if (!validateDeviceToken(userId, deviceCredentialId, deviceSessionNonce)) {
        return null;
      }
    }
    return {
      username: String(username),
      role: String(payload["role"] ?? "user"),
      user_id: userId,
      device_credential_id: deviceCredentialId,
      device_session_nonce: deviceSessionNonce,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PocketBase auth helpers
// ---------------------------------------------------------------------------

export async function authenticate_pb(
  username: string,
  password: string,
): Promise<[TokenPayload, string] | null> {
  const result = await pbAuthenticate(username, password);
  if (result === null) return null;
  const [payload, token] = result;
  return [
    {
      username: String(payload["username"] ?? ""),
      role: String(payload["role"] ?? "user"),
      user_id: String(payload["id"] ?? ""),
      device_credential_id: "",
      device_session_nonce: "",
    },
    token,
  ];
}

export async function register_pb(
  username: string,
  email: string,
  password: string,
): Promise<Record<string, unknown> | null> {
  return registerPb(username, email, password);
}

// ---------------------------------------------------------------------------
// Main auth entry point
// ---------------------------------------------------------------------------

export function authenticate(username: string, password: string): TokenPayload | null {
  if (!AUTH_ENABLED) {
    return {
      username: username || "local",
      role: "admin",
      user_id: "local-admin",
      device_credential_id: "",
      device_session_nonce: "",
    };
  }

  const users = _load_users();
  if (Object.keys(users).length === 0) return null;

  const record = users[username];
  if (!record) return null;

  const hashed = String(record["hash"] ?? "");
  if (!verifyPassword(password, hashed)) return null;

  const role = String(record["role"] ?? "user");
  const userId = String(record["id"] ?? "");
  return {
    username,
    role,
    user_id: userId,
    device_credential_id: "",
    device_session_nonce: "",
  };
}

export function authenticate_device(pairingCode: string, pin: string): TokenPayload | null {
  if (!AUTH_ENABLED || POCKETBASE_ENABLED) return null;
  const session = beginDeviceSession(pairingCode, pin);
  if (session === null) return null;
  const [view, username, role, userId, sessionNonce] = session;
  return {
    username,
    role,
    user_id: userId,
    device_credential_id: String(view["id"] ?? ""),
    device_session_nonce: sessionNonce,
  };
}

// Convenience re-exports used by the router.
export {
  getUser,
  getUserById,
  identityGetLearnerProfile,
  identitySetLearnerProfile,
  identitySetPassword,
  setMustChangePassword,
  localAdminUser,
};
