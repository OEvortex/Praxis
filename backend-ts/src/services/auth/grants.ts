// Port of deeptutor/multi_user/grants.py — logical resource grants.
// Grants are JSON files under <data>/system/grants/<user_id>.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getUserById } from "./identity.js";
import { ensureSystemDirs, SYSTEM_ROOT } from "./paths.js";

const GRANTS_DIR = () => join(SYSTEM_ROOT(), "grants");

export const LEARNING_CAPABILITIES = new Set(["chat", "immersive_reading", "mastery_path"]);
export const LEARNING_AGE_BANDS = new Set(["6-8", "9-12", "13-15"]);
export const LEARNING_PERSONAS = new Set(["teacher"]);
export const LEARNING_SURFACES = new Set(["books", "chat", "reading", "learning"]);
const EXTENSION_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export class GrantStorageError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function atomicWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

// Cooperative cross-process grant writes upstream serialize with an flock
// sidecar; Node's single process makes the in-process path atomic already.
// TODO(port): re-add an flock-style lock if Praxis ever runs multi-process.

export function emptyGrant(userId: string): Record<string, unknown> {
  return {
    version: 2,
    user_id: userId,
    models: { llm: [] },
    knowledge_bases: [],
    skills: [],
    partners: [],
    enabled_tools: null,
    mcp_tools: null,
    cli_apps: null,
    exec_enabled: null,
    learning_policy: null,
  };
}

function normalizeToolList(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeLearningPolicy(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return {};

  const capabilities = normalizeToolList(value["allowed_capabilities"]) ?? [];
  const hasReading = isRecord(value["reading"]);
  const rawReading = hasReading ? (value["reading"] as Record<string, unknown>) : {};
  const materialIds =
    normalizeToolList(rawReading["material_ids"]) ??
    (hasReading ? [] : ["*"]);
  const extensions =
    normalizeToolList(rawReading["extensions"]) ??
    (hasReading
      ? []
      : ["read_aloud", "guided_learning", "vocabulary", "quiz", "translation"]);
  const surfaces = normalizeToolList(value["allowed_surfaces"]);
  const normalized: Record<string, unknown> = {
    age_band: String(value["age_band"] ?? "").trim(),
    locked_persona: String(value["locked_persona"] ?? "").trim(),
    allowed_capabilities: capabilities,
    default_capability: String(value["default_capability"] ?? "chat").trim(),
  };
  if (surfaces !== null) normalized["allowed_surfaces"] = surfaces;
  normalized["reading"] = {
    allow_upload: Boolean(rawReading["allow_upload"] ?? true),
    material_ids: materialIds,
    extensions,
  };
  return normalized;
}

export function grantPath(userId: string): string {
  ensureSystemDirs();
  return join(GRANTS_DIR(), `${userId}.json`);
}

export function normalizeGrant(userId: string, payload: unknown): Record<string, unknown> {
  const base = emptyGrant(userId);
  if (!isRecord(payload)) return base;
  base["user_id"] = userId;
  const models = isRecord(payload["models"]) ? (payload["models"] as Record<string, unknown>) : {};
  const items = Array.isArray(models["llm"]) ? models["llm"] : [];
  (base["models"] as Record<string, unknown>)["llm"] = items
    .filter(isRecord)
    .map((item) => ({ ...item }));
  for (const key of ["knowledge_bases", "skills", "partners"]) {
    const raw = payload[key];
    const values = Array.isArray(raw) ? raw : [];
    base[key] = values.filter(isRecord).map((item) => ({ ...item }));
  }
  for (const key of ["enabled_tools", "mcp_tools", "cli_apps"]) {
    base[key] = normalizeToolList(payload[key]);
  }
  const execEnabled = payload["exec_enabled"];
  base["exec_enabled"] = typeof execEnabled === "boolean" ? execEnabled : null;
  base["learning_policy"] = normalizeLearningPolicy(payload["learning_policy"]);
  return base;
}

export function learnerGrant(userId: string): Record<string, unknown> {
  return normalizeGrant(userId, {
    enabled_tools: [],
    mcp_tools: [],
    cli_apps: [],
    exec_enabled: false,
    learning_policy: {
      age_band: "9-12",
      locked_persona: "teacher",
      allowed_capabilities: ["chat", "immersive_reading"],
      default_capability: "immersive_reading",
      allowed_surfaces: ["chat", "reading"],
      reading: {
        allow_upload: false,
        material_ids: [],
        extensions: [],
      },
    },
  });
}

export function loadGrant(userId: string): Record<string, unknown> {
  const path = grantPath(userId);
  if (!existsSync(path)) return emptyGrant(userId);
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new GrantStorageError(`Cannot read grant for user ${userId}`);
  }
  if (!isRecord(stored)) {
    throw new GrantStorageError(`Grant for user ${userId} must be a JSON object`);
  }
  for (const key of ["enabled_tools", "mcp_tools", "cli_apps"]) {
    const value = stored[key];
    if (value !== null && value !== undefined && !Array.isArray(value)) {
      throw new GrantStorageError(`Grant for user ${userId} has invalid ${key}`);
    }
  }
  if (stored["exec_enabled"] !== null && stored["exec_enabled"] !== undefined && typeof stored["exec_enabled"] !== "boolean") {
    throw new GrantStorageError(`Grant for user ${userId} has invalid exec_enabled`);
  }
  if (stored["learning_policy"] !== null && stored["learning_policy"] !== undefined && !isRecord(stored["learning_policy"])) {
    throw new GrantStorageError(`Grant for user ${userId} has invalid learning_policy`);
  }
  const policy = stored["learning_policy"];
  if (isRecord(policy)) {
    if ("allowed_surfaces" in policy && !Array.isArray(policy["allowed_surfaces"])) {
      throw new GrantStorageError(`Grant for user ${userId} has invalid allowed_surfaces`);
    }
    const reading = policy["reading"];
    if (reading !== null && reading !== undefined && !isRecord(reading)) {
      throw new GrantStorageError(`Grant for user ${userId} has invalid reading policy`);
    }
    if (isRecord(reading) && "allow_upload" in reading && typeof reading["allow_upload"] !== "boolean") {
      throw new GrantStorageError(`Grant for user ${userId} has invalid allow_upload`);
    }
  }
  const grant = normalizeGrant(userId, stored);
  try {
    validateGrant(grant);
  } catch (exc) {
    throw new GrantStorageError(`Grant for user ${userId} is invalid: ${(exc as Error).message}`);
  }
  return grant;
}

function validatedGrant(userId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const userRecord = getUserById(userId);
  if (userRecord === null) {
    throw new Error(`Unknown user id: ${userId}`);
  }
  const [, record] = userRecord;
  if (String(record["role"] ?? "user") === "admin") {
    throw new Error("Admin users use the main workspace and cannot receive assignments.");
  }
  const grant = normalizeGrant(userId, payload);
  validateGrant(grant);
  return grant;
}

export function saveGrant(userId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const grant = validatedGrant(userId, payload);
  const path = grantPath(userId);
  atomicWriteText(path, JSON.stringify(grant, null, 2));
  return grant;
}

export function validateGrant(grant: Record<string, unknown>): void {
  const forbidden = new Set(["api_key", "secret", "password", "token", "path", "base_url"]);

  function walk(value: unknown, trail: string): void {
    if (isRecord(value)) {
      for (const [key, child] of Object.entries(value)) {
        const lowered = key.toLowerCase();
        if (forbidden.has(lowered) || lowered.endsWith("_key")) {
          throw new Error(`Grants must not contain secret/path field: ${trail}.${key}`);
        }
        walk(child, `${trail}.${key}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, `${trail}[${index}]`));
    }
  }
  walk(grant, "grant");

  const policy = grant["learning_policy"];
  if (policy === null || policy === undefined) return;
  if (!isRecord(policy)) throw new Error("learning_policy must be an object or null");
  if (!LEARNING_AGE_BANDS.has(String(policy["age_band"]))) {
    throw new Error(
      `learning_policy.age_band must be one of: ${[...LEARNING_AGE_BANDS].sort().join(", ")}`,
    );
  }
  if (!LEARNING_PERSONAS.has(String(policy["locked_persona"]))) {
    throw new Error(
      `learning_policy.locked_persona must be one of: ${[...LEARNING_PERSONAS].sort().join(", ")}`,
    );
  }
  const capabilities = policy["allowed_capabilities"];
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new Error("learning_policy.allowed_capabilities cannot be empty");
  }
  const capabilitySet = new Set(capabilities.map(String));
  const unknown = [...capabilitySet].filter((c) => !LEARNING_CAPABILITIES.has(c));
  if (unknown.length > 0) {
    throw new Error(
      `learning_policy.allowed_capabilities contains unsupported values: ${unknown.sort().join(", ")}`,
    );
  }
  if (!capabilitySet.has(String(policy["default_capability"]))) {
    throw new Error("learning_policy.default_capability must be allowed");
  }
  const surfaces = policy["allowed_surfaces"] ?? ["chat", "reading"];
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    throw new Error("learning_policy.allowed_surfaces cannot be empty");
  }
  const unknownSurfaces = surfaces.map(String).filter((s) => !LEARNING_SURFACES.has(s));
  if (unknownSurfaces.length > 0) {
    throw new Error(
      `learning_policy.allowed_surfaces contains unsupported values: ${[...new Set(unknownSurfaces)].sort().join(", ")}`,
    );
  }
  const reading = isRecord(policy["reading"]) ? (policy["reading"] as Record<string, unknown>) : {};
  const materialIds = reading["material_ids"] ?? [];
  if (!Array.isArray(materialIds)) {
    throw new Error("learning_policy.reading.material_ids must be an array");
  }
  const invalidExtensions = [...new Set((reading["extensions"] ?? []) as unknown[])]
    .map(String)
    .filter((extension) => !EXTENSION_ID_RE.test(extension))
    .sort();
  if (invalidExtensions.length > 0) {
    throw new Error(
      `learning_policy.reading.extensions contains invalid ids: ${invalidExtensions.join(", ")}`,
    );
  }
}

export function publicGrant(userId: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(loadGrant(userId))) as Record<string, unknown>;
}

