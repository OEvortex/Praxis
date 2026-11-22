import { getCurrentUser } from "./paths.js";
import { learnerGrant, loadGrant } from "./grants.js";
import { getUserById } from "./identity.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function learningPolicyForUser(
  userId: string,
  isAdmin = false,
): Record<string, unknown> | null {
  if (isAdmin) return null;
  let policy: unknown;
  try {
    policy = loadGrant(userId)["learning_policy"];
  } catch {
    policy = undefined;
  }
  if (policy === null || policy === undefined) {
    const user = getUserById(userId);
    if (user !== null && String(user[1]["preset"] ?? "standard") === "learner") {
      policy = learnerGrant(userId)["learning_policy"];
    }
  }
  return isRecord(policy) ? clone(policy) : null;
}

export function currentLearningPolicy(): Record<string, unknown> | null {
  const user = getCurrentUser();
  return learningPolicyForUser(user.id, user.role === "admin");
}

export function applyLearningPolicy(payload: Record<string, unknown>): Record<string, unknown> {
  const policy = currentLearningPolicy();
  if (policy === null) return payload;

  const capability = String(payload["capability"] ?? "chat");
  const allowed = new Set((policy["allowed_capabilities"] as string[] | undefined) ?? []);
  if (!allowed.has(capability)) {
    throw new Error(
      "This learning account cannot use this mode. Please choose an allowed learning mode.",
    );
  }
  return {
    ...payload,
    persona: String(policy["locked_persona"] ?? ""),
    tools: [],
    enabled_tools: [],
    knowledge_bases: [],
    kb_name: "",
    enable_rag: false,
    enable_web_search: false,
    partner_id: null,
    bot_id: null,
  };
}

export function assertLearningSurface(surface: string): void {
  const policy = currentLearningPolicy();
  if (policy === null) return;
  const allowed = new Set(
    (policy["allowed_surfaces"] as string[] | undefined) ?? ["chat", "reading"],
  );
  if (!allowed.has(surface)) {
    const target = surface ? `${surface} surface` : "requested server surface";
    throw new Error(`This learning account cannot use the ${target}.`);
  }
}

export function learningSurfaceAllowed(surface: string): boolean {
  try {
    assertLearningSurface(surface);
  } catch {
    return false;
  }
  return true;
}

export function assertLearningMaterial(materialId: string, upload = false): void {
  const policy = currentLearningPolicy();
  if (policy === null) return;
  const hasReading = isRecord(policy["reading"]);
  const reading = hasReading ? (policy["reading"] as Record<string, unknown>) : {};
  if (upload) {
    if (hasReading && !Boolean(reading["allow_upload"])) {
      throw new Error("This learning account cannot upload reading materials.");
    }
    return;
  }
  const rawIds = reading["material_ids"];
  const assigned = new Set(
    Array.isArray(rawIds) ? rawIds.map(String) : hasReading ? [] : ["*"],
  );
  if (!assigned.has("*") && !assigned.has(String(materialId ?? ""))) {
    throw new Error("This reading material is not assigned to this learning account.");
  }
}

export function learningMaterialAllowed(materialId: string): boolean {
  try {
    assertLearningMaterial(materialId);
  } catch {
    return false;
  }
  return true;
}

export function assertLearningMaterialMutation(materialId: string): void {
  const policy = currentLearningPolicy();
  if (policy === null) return;
  const reading = isRecord(policy["reading"]) ? (policy["reading"] as Record<string, unknown>) : {};
  if (!Boolean(reading["allow_upload"])) {
    throw new Error("This learning account cannot modify assigned reading materials.");
  }
  assertLearningMaterial(materialId);
}

export function allowedReadingExtensions(): Set<string> | null {
  const policy = currentLearningPolicy();
  if (policy === null) return null;
  if (!isRecord(policy["reading"])) {
    return new Set(["read_aloud", "guided_learning", "vocabulary", "quiz", "translation"]);
  }
  const extensions = (policy["reading"] as Record<string, unknown>)["extensions"];
  return new Set(Array.isArray(extensions) ? extensions.map(String) : []);
}
