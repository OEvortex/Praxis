//
// Upstream layout (runtime-home = parent of `data/`):
//   data/user            admin workspace ("user" subtree of the data root)
//   data/users/<uid>     per-user workspaces
//   data/system          deployment state: accounts, grants, audit, secrets
//
// The TS backend's `data_dir` (PRAXIS_DATA_DIR, default ./data) plays the role
// of upstream `data/`, so SYSTEM_ROOT = <data_dir>/system.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { get_settings } from "../../config.js";
import { ContextVar } from "../../agent/turn_context.js";

export type Role = "admin" | "teacher" | "student" | "user";
export type AccountPreset = "standard" | "learner" | "custom";
export type ScopeKind = "admin" | "user";

export const VALID_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "teacher",
  "student",
  "user",
]);

export const ACCOUNT_PRESETS: ReadonlySet<string> = new Set([
  "standard",
  "learner",
  "custom",
]);

export function normalizeRole(value: string, fallback = "user"): string {
  return VALID_ROLES.has(value) ? value : fallback;
}

export interface UserScope {
  kind: ScopeKind;
  user_id: string;
  root: string;
}

export interface CurrentUser {
  id: string;
  username: string;
  role: Role;
  scope: UserScope;
}

export const LOCAL_ADMIN_ID = "local-admin";
export const LOCAL_ADMIN_USERNAME = "local";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function dataRoot(): string {
  return resolve(get_settings().data_dir);
}

export const ADMIN_WORKSPACE_ROOT = () => dataRoot();
export const USERS_ROOT = () => join(dataRoot(), "users");
export const SYSTEM_ROOT = () => join(dataRoot(), "system");
export const USER_SECRETS_DIRNAME = "user-secrets";

// Legacy sibling tree: upstream keeps it at <runtime-home>/multi-user, i.e.
// next to the data dir's parent. Best-effort — only moved when present.
function legacyMultiUserRoot(): string {
  return join(resolve(dataRoot(), ".."), "multi-user");
}

let _legacyMigrationDone = false;

export function migrateLegacyMultiUserTree(): void {
  if (_legacyMigrationDone) return;
  _legacyMigrationDone = true;
  const legacy = legacyMultiUserRoot();
  if (!existsSync(legacy)) return;
  const leftovers: string[] = [];
  try {
    for (const name of readdirSync(legacy).sort()) {
      const target =
        name === "_system"
          ? join(SYSTEM_ROOT(), "")
          : join(USERS_ROOT(), name);
      const targetPath = name === "_system" ? SYSTEM_ROOT() : target;
      if (existsSync(targetPath)) {
        leftovers.push(name);
        continue;
      }
      mkdirSync(target === SYSTEM_ROOT() ? SYSTEM_ROOT() : USERS_ROOT(), {
        recursive: true,
      });
      renameSync(join(legacy, name), targetPath);
    }
    if (leftovers.length === 0) {
      try {
        rmSync(legacy, { recursive: true });
      } catch {
        // leave the empty dir; operator can remove it
      }
    }
  } catch {
    // Migration is best-effort; a failure must not break auth reads.
  }
}

export function adminScope(): UserScope {
  return {
    kind: "admin",
    user_id: LOCAL_ADMIN_ID,
    root: resolve(ADMIN_WORKSPACE_ROOT()),
  };
}

export function localAdminUser(): CurrentUser {
  return {
    id: LOCAL_ADMIN_ID,
    username: LOCAL_ADMIN_USERNAME,
    role: "admin",
    scope: adminScope(),
  };
}

export function scopeForUser(userId: string, isAdmin: boolean): UserScope {
  if (isAdmin) return adminScope();
  migrateLegacyMultiUserTree();
  return {
    kind: "user",
    user_id: userId,
    root: resolve(join(USERS_ROOT(), userId)),
  };
}

export function ensureUserWorkspace(userId: string): string {
  return ensureScopeWorkspace(scopeForUser(userId, false));
}

export function ensureScopeWorkspace(scope: UserScope): string {
  const root = resolve(scope.root);
  for (const child of ["knowledge_bases", "memory"]) {
    mkdirSync(join(root, child), { recursive: true });
  }
  return root;
}

export function ensureSystemDirs(): void {
  migrateLegacyMultiUserTree();
  for (const child of ["auth", "grants", "audit", "indexes"]) {
    mkdirSync(join(SYSTEM_ROOT(), child), { recursive: true });
  }
  const secretsRoot = join(SYSTEM_ROOT(), USER_SECRETS_DIRNAME);
  mkdirSync(secretsRoot, { recursive: true });
  try {
    // owner-only, matching upstream's 0o700
    chmodSync(secretsRoot, 0o700);
  } catch {
    // chmod is best-effort on exotic filesystems
  }
}

// ---------------------------------------------------------------------------
// Request-local current user (ContextVar port)
// ---------------------------------------------------------------------------

const _currentUser = new ContextVar<CurrentUser | null>(null);

export function setCurrentUser(user: CurrentUser): { prev: CurrentUser | null } {
  return _currentUser.set(user);
}

export function resetCurrentUser(token: { prev: CurrentUser | null }): void {
  _currentUser.reset(token);
}

export function getCurrentUser(): CurrentUser {
  return _currentUser.get() ?? localAdminUser();
}

export function getCurrentUserOrNone(): CurrentUser | null {
  return _currentUser.get();
}

export function userFromTokenPayload(payload: {
  username?: string;
  role?: string;
  user_id?: string;
} | null): CurrentUser {
  if (payload === null) return localAdminUser();
  let userId = String(payload.user_id ?? "");
  const username = String(payload.username ?? "") || "local";
  const role = normalizeRole(String(payload.role ?? "user") || "user") as Role;
  if (!userId) {
    userId = role === "admin" && username === "local" ? LOCAL_ADMIN_ID : username;
  }
  return {
    id: userId,
    username,
    role,
    scope: scopeForUser(userId, role === "admin"),
  };
}
