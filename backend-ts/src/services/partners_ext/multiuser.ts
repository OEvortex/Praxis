// Port of the deeptutor.multi_user persistence surface the Partners /
// multi-user routers need: local user records, per-user grants, guardian
// relationships, book permissions and the audit log. Stored in ext_items.
//
// The Python backend delegates identity to PocketBase or its local user
// store; this backend is auth-free, so the "current user" is a seeded local
// admin unless the caller supplies ``x-praxis-user-id`` (used by tests and
// the guardian flows). Grants/guardians follow the upstream JSON shapes.
import { COL, getItem, isoNow, listItems, putItem, deleteItem, uuid32, type AnyRecord } from "./store.js";

export interface CurrentUser {
  id: string;
  username: string;
  role: "admin" | "user";
  is_admin: boolean;
}

export const ADMIN_USER: CurrentUser = {
  id: "admin",
  username: "admin",
  role: "admin",
  is_admin: true,
};

// Resolve the caller. Single-user deployments have no auth layer; an
// ``x-praxis-user-id`` header selects a stored non-admin user when present.
export function currentUser(headerUserId?: string | null): CurrentUser {
  const uid = String(headerUserId || "").trim();
  if (uid && uid !== ADMIN_USER.id) {
    const rec = getUserById(uid);
    if (rec) {
      const [, record] = rec;
      const role = String(record["role"] || "user") === "admin" ? "admin" : "user";
      return { id: uid, username: rec[0], role, is_admin: role === "admin" };
    }
  }
  return ADMIN_USER;
}

// ── users ──────────────────────────────────────────────────────

export function listUserInfo(): AnyRecord[] {
  const users = listItems(COL.muUsers);
  if (!users.length) {
    // Seed the built-in admin so single-user installs have an owner.
    putItem(COL.muUsers, {
      id: ADMIN_USER.id,
      username: ADMIN_USER.username,
      role: "admin",
      preset: "standard",
      disabled: false,
      created_at: isoNow(),
    });
    return listItems(COL.muUsers);
  }
  return users;
}

export function getUserById(userId: string): [string, AnyRecord] | null {
  for (const u of listItems(COL.muUsers)) {
    if (String(u["id"] || "") === userId) {
      return [String(u["username"] || userId), u];
    }
  }
  return null;
}

export function createUser(username: string, opts: { role?: string; preset?: string } = {}): AnyRecord | null {
  const name = String(username || "").trim();
  if (!name) return null;
  if (listItems(COL.muUsers).some((u) => String(u["username"]) === name)) return null;
  const user: AnyRecord = {
    id: `u-${uuid32().slice(0, 12)}`,
    username: name,
    role: opts.role === "admin" ? "admin" : "user",
    preset: opts.preset || "standard",
    disabled: false,
    created_at: isoNow(),
  };
  putItem(COL.muUsers, user);
  return user;
}

export function setPassword(_username: string, _hash: string): boolean {
  // Local auth is not implemented in this backend; passwords are a no-op.
  return true;
}

export function setPreset(username: string, preset: string, expectedUserId?: string): boolean {
  for (const u of listItems(COL.muUsers)) {
    if (String(u["username"]) !== username) continue;
    if (expectedUserId && String(u["id"]) !== expectedUserId) return false;
    u["preset"] = preset;
    putItem(COL.muUsers, u);
    return true;
  }
  return false;
}

export function setBookPermission(username: string, permission: AnyRecord): boolean {
  for (const u of listItems(COL.muUsers)) {
    if (String(u["username"]) !== username) continue;
    u["book_permission"] = permission;
    putItem(COL.muUsers, u);
    return true;
  }
  return false;
}

export function revokeDeviceCredentialsForUser(_userId: string, _revokedBy?: string): number {
  return 0;
}

// ── grants ─────────────────────────────────────────────────────

export const LEARNING_AGE_BANDS = ["child", "teen", "adult"] as const;
export const LEARNING_SURFACES = ["chat", "reading", "practice", "games"] as const;

export function loadGrant(userId: string): AnyRecord {
  return getItem(COL.muGrants(userId), userId) ?? { user_id: userId };
}

export function saveGrant(userId: string, grant: AnyRecord): AnyRecord {
  const normalized = normalizeGrant(userId, grant);
  putItem(COL.muGrants(userId), { ...normalized, id: userId });
  return normalized;
}

export function saveGrantWithReceipt(userId: string, grant: AnyRecord): [AnyRecord, string] {
  const normalized = saveGrant(userId, grant);
  return [normalized, uuid32()];
}

export function restoreGrantIfUnchanged(_userId: string, _receipt: string): boolean {
  return true;
}

// Port of multi_user.grants.normalize_grant / validate_grant (best effort):
// keep known sections, coerce lists, drop unknown keys upstream would reject.
export function normalizeGrant(userId: string, grant: AnyRecord): AnyRecord {
  const out: AnyRecord = { user_id: userId };
  const models = grant["models"];
  if (models && typeof models === "object") out["models"] = models;
  for (const key of ["knowledge_bases", "skills", "partners"] as const) {
    const v = grant[key];
    if (Array.isArray(v)) out[key] = v;
  }
  for (const key of ["enabled_tools", "mcp_tools"] as const) {
    const v = grant[key];
    if (v === null || Array.isArray(v)) out[key] = v;
  }
  if (typeof grant["exec_enabled"] === "boolean") out["exec_enabled"] = grant["exec_enabled"];
  if (grant["learning_policy"] && typeof grant["learning_policy"] === "object") {
    out["learning_policy"] = grant["learning_policy"];
  }
  return out;
}

export function validateGrant(grant: AnyRecord): void {
  const policy = grant["learning_policy"];
  if (policy && typeof policy === "object") {
    const age = (policy as AnyRecord)["age_band"];
    if (age !== undefined && !(LEARNING_AGE_BANDS as readonly string[]).includes(String(age))) {
      throw new Error("Unknown learning age band");
    }
    const surfaces = (policy as AnyRecord)["allowed_surfaces"];
    if (Array.isArray(surfaces)) {
      for (const s of surfaces) {
        if (!(LEARNING_SURFACES as readonly string[]).includes(String(s))) {
          throw new Error("Unknown learning surface");
        }
      }
    }
  }
}

export function learnerGrant(userId: string): AnyRecord {
  return {
    user_id: userId,
    models: { llm: [] },
    knowledge_bases: [],
    skills: [],
    partners: [],
    enabled_tools: null,
    mcp_tools: null,
    exec_enabled: false,
    learning_policy: {
      age_band: "child",
      allowed_surfaces: ["chat", "reading"],
      reading: { allow_upload: false, extensions: [], material_ids: [] },
    },
  };
}

// ── guardians ──────────────────────────────────────────────────

export const GUARDIAN_PERMISSIONS = new Set([
  "view_reports",
  "assign_materials",
  "manage_restrictions",
  "reset_credentials",
]);

function guardianItem(): AnyRecord | null {
  return getItem(COL.muGuardians, "guardians");
}

function saveGuardians(item: AnyRecord): void {
  putItem(COL.muGuardians, item);
}

export function listRelationships(opts: { include_revoked?: boolean; guardian_user_id?: string } = {}): AnyRecord[] {
  const store = guardianItem();
  const rows = Array.isArray(store?.["relationships"]) ? store["relationships"] : [];
  return (rows as AnyRecord[]).filter((r) => {
    if (!opts.include_revoked && r["revoked_at"]) return false;
    if (opts.guardian_user_id && r["guardian_user_id"] !== opts.guardian_user_id) return false;
    return true;
  });
}

export function relationshipById(id: string): AnyRecord | null {
  const store = guardianItem();
  const rows = Array.isArray(store?.["relationships"]) ? store["relationships"] : [];
  return (rows as AnyRecord[]).find((r) => r["id"] === id) ?? null;
}

export function authorizeGuardian(guardianId: string, learnerId: string, permissions: string[]): AnyRecord {
  const store = guardianItem() ?? { id: "guardians", relationships: [] };
  const rows = (store["relationships"] ?? []) as AnyRecord[];
  const existing = rows.find(
    (r) => r["guardian_user_id"] === guardianId && r["learner_user_id"] === learnerId && !r["revoked_at"],
  );
  if (existing) throw new Error("Guardian relationship already authorized");
  const rel: AnyRecord = {
    id: uuid32().slice(0, 16),
    guardian_user_id: guardianId,
    learner_user_id: learnerId,
    permissions: [...new Set(permissions)].sort(),
    created_at: isoNow(),
    revoked_at: null,
    revoked_by: "",
    revoke_reason: "",
  };
  rows.push(rel);
  store["relationships"] = rows;
  saveGuardians(store);
  return rel;
}

export function revokeGuardian(id: string, opts: { revoked_by?: string; reason?: string } = {}): AnyRecord | null {
  const store = guardianItem();
  if (!store) return null;
  const rows = (store["relationships"] ?? []) as AnyRecord[];
  const rel = rows.find((r) => r["id"] === id);
  if (!rel || rel["revoked_at"]) return null;
  rel["revoked_at"] = isoNow();
  rel["revoked_by"] = opts.revoked_by || "";
  rel["revoke_reason"] = opts.reason || "";
  saveGuardians(store);
  return rel;
}

export function guardianCanAccess(guardianId: string, learnerId: string, permission: string): boolean {
  return listRelationships({ guardian_user_id: guardianId }).some(
    (r) => r["learner_user_id"] === learnerId && (r["permissions"] || []).includes(permission),
  );
}

// ── book permission ────────────────────────────────────────────

export type BookLevel = "none" | "read" | "edit" | "create";

export function normalizeBookPermission(raw: unknown): AnyRecord {
  const src = raw && typeof raw === "object" ? (raw as AnyRecord) : {};
  const books: Record<string, string> = {};
  if (src["books"] && typeof src["books"] === "object") {
    for (const [k, v] of Object.entries(src["books"] as AnyRecord)) {
      books[k] = String(v);
    }
  }
  return {
    create: src["create"] !== false,
    default: ["none", "read", "edit"].includes(String(src["default"])) ? src["default"] : "none",
    books,
  };
}

export function publicPermissionDict(permission: AnyRecord): AnyRecord {
  const p = normalizeBookPermission(permission);
  return {
    create: p["create"],
    default: p["default"],
    books: p["books"],
    levels: ["none", "read", "edit"],
  };
}

// ── audit ──────────────────────────────────────────────────────

export function logAdminAction(action: string, opts: { target_user_id?: string; summary?: AnyRecord } = {}): void {
  putItem(COL.muAudit, {
    id: uuid32(),
    actor: "admin",
    kind: "admin",
    action,
    target_user_id: opts.target_user_id || "",
    summary: opts.summary || {},
    created_at: isoNow(),
  });
}

export function logGuardianAction(
  action: string,
  opts: { guardian_user_id?: string; learner_user_id?: string; summary?: AnyRecord } = {},
): void {
  putItem(COL.muAudit, {
    id: uuid32(),
    actor: opts.guardian_user_id || "",
    kind: "guardian",
    action,
    learner_user_id: opts.learner_user_id || "",
    summary: opts.summary || {},
    created_at: isoNow(),
  });
}

// Partner access helpers (port of multi_user.partner_access, single-user aware).
export function canManagePartner(partnerOwnerId: string, user: CurrentUser): boolean {
  if (user.is_admin) return true;
  return Boolean(partnerOwnerId) && partnerOwnerId === user.id;
}

export function assignedPartnerIds(userId: string): Set<string> {
  if (userId === ADMIN_USER.id) return new Set();
  const grant = loadGrant(userId);
  const out = new Set<string>();
  for (const item of (grant["partners"] as AnyRecord[]) || []) {
    const pid = String(item?.["partner_id"] || item?.["id"] || "").trim();
    if (pid) out.add(pid);
  }
  return out;
}

export function canUsePartner(partnerId: string, ownerId: string, user: CurrentUser): boolean {
  if (canManagePartner(ownerId, user)) return true;
  return assignedPartnerIds(user.id).has(String(partnerId || "").trim());
}

export const CARD_FIELDS = [
  "partner_id",
  "name",
  "description",
  "emoji",
  "color",
  "avatar",
  "language",
  "running",
] as const;

export function identityCard(partner: AnyRecord): AnyRecord {
  const card: AnyRecord = {};
  for (const f of CARD_FIELDS) card[f] = partner[f];
  card["partner_id"] = String(partner["partner_id"] || "");
  card["can_manage"] = false;
  return card;
}
