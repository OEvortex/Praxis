// Port of deeptutor/multi_user/identity.py — canonical identity store.
// Users live in <data>/system/auth/users.json; avatar images beside it.
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalBookPermission, normalizeBookPermission, publicPermissionDict } from "./book_permission.js";
import { normalizeProfile } from "./learner_profile.js";
import {
  ACCOUNT_PRESETS,
  LOCAL_ADMIN_ID,
  migrateLegacyMultiUserTree,
  SYSTEM_ROOT,
  normalizeRole,
} from "./paths.js";
import type { AccountPreset, Role } from "./paths.js";

export function authDir(): string {
  return join(SYSTEM_ROOT(), "auth");
}
export function usersFile(): string {
  return join(authDir(), "users.json");
}
export function secretFile(): string {
  return join(authDir(), "auth_secret");
}
// Upstream legacy locations: <runtime-home>/data/user/{auth_users.json,auth_secret}
function legacyUsersFile(): string {
  return join(SYSTEM_ROOT(), "..", "user", "auth_users.json");
}
function legacySecretFile(): string {
  return join(SYSTEM_ROOT(), "..", "user", "auth_secret");
}

export function newUserId(): string {
  return `u_${randomUUID().replace(/-/g, "")}`;
}

export function utcNow(): string {
  return new Date().toISOString();
}

export type UserRecord = Record<string, unknown>;

// Node is single-threaded and every mutation below is synchronous, so the
// Python threading.Lock collapses to nothing — read-modify-write cannot
// interleave within one process.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalRecord(
  username: string,
  value: unknown,
  defaultRole: Role = "user",
): UserRecord | null {
  if (typeof value === "string") {
    return {
      id: newUserId(),
      hash: value,
      role: defaultRole,
      created_at: utcNow(),
      disabled: false,
      avatar: "",
      must_change_password: false,
    };
  }
  if (!isRecord(value)) return null;
  const hashed = String(value["hash"] ?? value["password_hash"] ?? "");
  if (!hashed) return null;
  const role = normalizeRole(
    String(value["role"] ?? defaultRole),
    defaultRole,
  ) as Role;
  let preset = String(value["preset"] ?? "standard");
  if (!ACCOUNT_PRESETS.has(preset)) preset = "standard";
  const record: UserRecord = {
    id: String(value["id"] ?? newUserId()),
    hash: hashed,
    role,
    created_at: String(value["created_at"] ?? utcNow()),
    disabled: Boolean(value["disabled"] ?? false),
    avatar: String(value["avatar"] ?? ""),
    preset,
    must_change_password: Boolean(value["must_change_password"] ?? false),
  };
  if ("book_permission" in value) {
    record["book_permission"] = canonicalBookPermission(value["book_permission"]);
  }
  if ("learner_profile" in value) {
    try {
      record["learner_profile"] = normalizeProfile(value["learner_profile"]);
    } catch {
      record["learner_profile"] = null;
    }
  }
  return record;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const loaded: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isRecord(loaded) ? loaded : {};
  } catch {
    return {};
  }
}

function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

function writeUsers(users: Record<string, UserRecord>): void {
  mkdirSync(authDir(), { recursive: true });
  atomicWriteText(usersFile(), JSON.stringify(users, null, 2));
}

function migrateLegacyUsers(): Record<string, UserRecord> | null {
  if (existsSync(usersFile()) || !existsSync(legacyUsersFile())) return null;
  const legacy = readJson(legacyUsersFile());
  const users: Record<string, UserRecord> = {};
  let index = 0;
  for (const [username, value] of Object.entries(legacy)) {
    let role: Role = index === 0 ? "admin" : "user";
    if (isRecord(value)) {
      role = normalizeRole(String(value["role"] ?? ""), role) as Role;
    }
    const record = canonicalRecord(username, value, role);
    if (record !== null) users[username] = record;
    index += 1;
  }
  if (Object.keys(users).length > 0) {
    writeUsers(users);
    return users;
  }
  return null;
}

function migrateSecret(): void {
  if (existsSync(secretFile()) || !existsSync(legacySecretFile())) return;
  try {
    const secret = readFileSync(legacySecretFile(), "utf-8").trim();
    if (secret) {
      writeSecretText(secretFile(), secret);
    }
  } catch {
    // best-effort migration
  }
}

// Registered by service.ts to avoid a static import cycle (service imports
// identity; identity needs the resolved auth.json bootstrap credentials).
let _envBootstrapAdmin: () => [string, string] = () => ["", ""];
export function registerEnvBootstrapAdmin(fn: () => [string, string]): void {
  _envBootstrapAdmin = fn;
}

function envBootstrapAdmin(): [string, string] {
  return _envBootstrapAdmin();
}

function envAdminRecord(passwordHash: string): UserRecord {
  return {
    id: "env-admin",
    hash: passwordHash,
    role: "admin",
    created_at: "",
    disabled: false,
    avatar: "",
    preset: "standard",
  };
}

export function loadUsers(
  envUsername = "",
  envPasswordHash = "",
): Record<string, UserRecord> {
  migrateLegacyMultiUserTree();
  let users: Record<string, UserRecord> | null = null;
  if (existsSync(usersFile())) {
    users = readJson(usersFile()) as Record<string, UserRecord>;
  } else {
    users = migrateLegacyUsers();
  }
  if (users === null) users = {};

  const canonical: Record<string, UserRecord> = {};
  let changed = false;
  let index = 0;
  for (const [username, value] of Object.entries(users)) {
    let role: Role = index === 0 ? "admin" : "user";
    if (isRecord(value)) {
      role = normalizeRole(String(value["role"] ?? ""), role) as Role;
    }
    const record = canonicalRecord(String(username), value, role);
    if (record === null) {
      changed = true;
      continue;
    }
    canonical[String(username)] = record;
    if (JSON.stringify(record) !== JSON.stringify(value)) changed = true;
    index += 1;
  }

  if (existsSync(usersFile()) && changed) {
    writeUsers(canonical);
  }

  // In-memory env bootstrap admin overlay (never persisted).
  if (envUsername && envPasswordHash && !(envUsername in canonical)) {
    const merged: Record<string, UserRecord> = {
      [envUsername]: envAdminRecord(envPasswordHash),
    };
    Object.assign(merged, canonical);
    return merged;
  }
  return canonical;
}

export function saveUser(
  username: string,
  hashedPassword: string,
  role: Role = "user",
  preset: AccountPreset = "standard",
): UserRecord {
  mkdirSync(authDir(), { recursive: true });
  // NOTE: deliberately called without env args — users is written back to
  // disk, and the bootstrap admin must stay an in-memory overlay.
  const users = loadUsers();
  const [envUsername] = envBootstrapAdmin();
  const accountExists = Object.keys(users).length > 0 || (envUsername !== "" && envUsername !== username);
  const effectiveRole: Role = accountExists ? role : "admin";
  const existing = users[username] ?? {};
  let effectivePreset = String(existing["preset"] ?? preset ?? "standard");
  if (!ACCOUNT_PRESETS.has(effectivePreset)) effectivePreset = preset;
  const record: UserRecord = {
    id: String(existing["id"] ?? newUserId()),
    hash: hashedPassword,
    role: effectiveRole,
    created_at: String(existing["created_at"] ?? utcNow()),
    disabled: Boolean(existing["disabled"] ?? false),
    avatar: String(existing["avatar"] ?? ""),
    preset: effectivePreset,
    book_permission: canonicalBookPermission(existing["book_permission"]),
    learner_profile: normalizeProfile(existing["learner_profile"]),
  };
  users[username] = record;
  writeUsers(users);
  return record;
}

export function listUserInfo(envUsername = "", envPasswordHash = ""): Record<string, unknown>[] {
  return Object.entries(loadUsers(envUsername, envPasswordHash)).map(([username, record]) => ({
    id: record["id"] ?? "",
    username,
    role: record["role"] ?? "user",
    created_at: record["created_at"] ?? "",
    disabled: Boolean(record["disabled"] ?? false),
    avatar: String(record["avatar"] ?? ""),
    preset: String(record["preset"] ?? "standard"),
    must_change_password: Boolean(record["must_change_password"] ?? false),
    book_permission: publicPermissionDict(
      normalizeBookPermission(record["book_permission"]),
    ),
  }));
}

export function getUser(username: string): UserRecord | null {
  return loadUsers()[username] ?? null;
}

export function getUserById(userId: string): [string, UserRecord] | null {
  for (const [username, record] of Object.entries(loadUsers())) {
    if (String(record["id"] ?? "") === userId) return [username, record];
  }
  return null;
}

export function getLearnerProfile(username: string): Record<string, unknown> | null {
  const record = getUser(username);
  if (record === null || String(record["preset"] ?? "standard") !== "learner") {
    return null;
  }
  return normalizeProfile(record["learner_profile"]);
}

export function setLearnerProfile(
  username: string,
  profile: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const users = loadUsers();
  const record = users[username];
  if (
    record === undefined ||
    String(record["role"] ?? "user") === "admin" ||
    String(record["preset"] ?? "standard") !== "learner"
  ) {
    return null;
  }
  record["learner_profile"] = normalizeProfile(profile);
  writeUsers(users);
  return record["learner_profile"] as Record<string, unknown> | null;
}

export function setBookPermission(username: string, permission: unknown): boolean {
  if (!existsSync(usersFile())) return false;
  const users = loadUsers();
  const record = users[username];
  if (record === undefined) return false;
  record["book_permission"] = publicPermissionDict(
    normalizeBookPermission(permission),
  );
  writeUsers(users);
  return true;
}

export function deleteUser(username: string): boolean {
  if (!existsSync(usersFile())) return false;
  const users = loadUsers();
  const record = users[username];
  if (record === undefined) return false;
  const userId = String(record["id"] ?? "");
  delete users[username];
  writeUsers(users);
  try {
    // Guardian-relationship cleanup lives in a subsystem not ported here;
    // upstream also treats failures as non-fatal.
    void userId;
  } catch {
    // ignore
  }
  return true;
}

export function setPassword(
  username: string,
  hashedPassword: string,
): UserRecord | null {
  if (!existsSync(usersFile())) return null;
  const users = loadUsers();
  const record = users[username];
  if (record === undefined) return null;
  record["hash"] = hashedPassword;
  writeUsers(users);
  return { ...record };
}

export function setMustChangePassword(username: string, required: boolean): boolean {
  if (!existsSync(usersFile())) return false;
  const users = loadUsers();
  const record = users[username];
  if (record === undefined) return false;
  record["must_change_password"] = Boolean(required);
  writeUsers(users);
  return true;
}

export function setAvatar(username: string, avatar: string): boolean {
  if (!existsSync(usersFile())) return false;
  const users = loadUsers();
  const record = users[username];
  if (record === undefined) return false;
  record["avatar"] = avatar;
  writeUsers(users);
  return true;
}

// ---------------------------------------------------------------------------
// Avatar image files
// ---------------------------------------------------------------------------

export const AVATAR_EXTENSIONS = ["png", "jpg", "webp"] as const;

function avatarDir(): string {
  return join(authDir(), "avatars");
}

export function getAvatarFile(userId: string): string | null {
  for (const ext of AVATAR_EXTENSIONS) {
    const candidate = join(avatarDir(), `${userId}.${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function saveAvatarFile(userId: string, data: Buffer, ext: string): string {
  if (!(AVATAR_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(`Unsupported avatar extension: ${ext}`);
  }
  const directory = avatarDir();
  mkdirSync(directory, { recursive: true });
  const target = join(directory, `${userId}.${ext}`);
  const tmp = join(directory, `${userId}.${ext}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, target);
  for (const other of AVATAR_EXTENSIONS) {
    if (other !== ext) {
      try {
        unlinkSync(join(directory, `${userId}.${other}`));
      } catch {
        // missing_ok
      }
    }
  }
  return target;
}

export function deleteAvatarFile(userId: string): void {
  for (const ext of AVATAR_EXTENSIONS) {
    try {
      unlinkSync(join(avatarDir(), `${userId}.${ext}`));
    } catch {
      // missing_ok
    }
  }
}

export function setRole(username: string, role: Role): boolean {
  if (!VALID_ROLE_SET.has(role)) {
    throw new Error(`role must be one of ${[...VALID_ROLE_SET].sort().join(", ")}`);
  }
  if (!existsSync(usersFile())) return false;
  const users = loadUsers();
  const record = users[username];
  if (record === undefined) return false;
  record["role"] = role;
  writeUsers(users);
  return true;
}

const VALID_ROLE_SET = new Set(["admin", "teacher", "student", "user"]);

export function setPreset(
  username: string,
  preset: AccountPreset,
  expectedUserId: string | null = null,
): boolean {
  if (!ACCOUNT_PRESETS.has(preset)) {
    throw new Error("preset must be 'standard', 'learner', or 'custom'");
  }
  if (!existsSync(usersFile())) return false;
  const users = loadUsers();
  const record = users[username];
  if (record === undefined) return false;
  if (expectedUserId !== null && String(record["id"] ?? "") !== expectedUserId) {
    return false;
  }
  record["preset"] = preset;
  writeUsers(users);
  return true;
}

export function loadOrCreateAuthSecret(): string {
  migrateLegacyMultiUserTree();
  migrateSecret();
  try {
    if (existsSync(secretFile())) {
      const existing = readFileSync(secretFile(), "utf-8").trim();
      if (existing) return existing;
    }
    // secrets.token_hex(32) → 64 hex chars
    const secret = randomBytesHex(32);
    writeSecretText(secretFile(), secret);
    return secret;
  } catch {
    return randomBytesHex(32);
  }
}

function randomBytesHex(n: number): string {
  return randomBytes(n).toString("hex");
}

function writeSecretText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    chmodSync(dirname(path), 0o700);
  } catch {
    // best-effort
  }
  try {
    unlinkSync(path);
  } catch {
    // FileNotFoundError equivalent
  }
  writeFileSync(path, text, { encoding: "utf-8", mode: 0o600, flag: "wx" });
}
