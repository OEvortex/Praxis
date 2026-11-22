// bounded mixed-source
// route generation for Mastery Topics.
import { randomBytes } from "node:crypto";

import {
  KnowledgePoint,
  KnowledgeType,
  LearningModule,
  TopicSource,
} from "./models.js";
import { topicGenerationPrompts } from "./prompts.js";
import { completeText } from "../llm_text.js";
import type { Settings } from "../../config.js";

export class TopicGenerationError extends Error {}

const MAX_SOURCES = 16;
const MAX_SOURCE_EXCERPT = 4_000;
const MAX_SOURCE_TOTAL = 24_000;
export const DEFAULT_MODULE_LIMIT = 8;
export const MAX_MODULE_LIMIT = 20;
const MAX_OBJECTIVES_PER_MODULE = 7;
const MAX_KB_DOCUMENTS = 60;

const ALLOWED_TYPES = new Set(["memory", "concept", "procedure", "design"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function sourceDocuments(source: TopicSource): string[] {
  const raw = (source.metadata ?? {})["documents"];
  if (!Array.isArray(raw)) return [];
  return raw.map((n) => String(n ?? "").trim()).filter(Boolean);
}

function sourcePayload(sources: TopicSource[]): Record<string, unknown>[] {
  let remaining = MAX_SOURCE_TOTAL;
  const payload: Record<string, unknown>[] = [];
  const sorted = [...sources].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const source of sorted.slice(0, MAX_SOURCES)) {
    const excerpt = String(source.excerpt ?? "").slice(0, Math.min(MAX_SOURCE_EXCERPT, remaining));
    remaining -= excerpt.length;
    const entry: Record<string, unknown> = {
      kind: source.kind,
      label: String(source.label ?? "").slice(0, 200),
      excerpt,
    };
    const documents = sourceDocuments(source);
    if (documents.length) {
      entry["documents"] = documents;
      const omitted = Number((source.metadata ?? {})["documents_omitted"] ?? 0) || 0;
      if (omitted > 0) entry["documents_omitted"] = omitted;
    }
    payload.push(entry);
    if (remaining <= 0) break;
  }
  return payload;
}

// TODO(port): upstream grounds KNOWLEDGE_BASE sources via rag_search and FILE
// sources via isolated document extraction (multi_user.knowledge_access +
// document_extractor). backend-ts has no equivalent retrieval pipeline yet;
// sources are used as submitted (excerpt/metadata preserved) and KB inventory
// metadata already present on the source is honored by coverage.

function newEntityId(prefix: string, reserved: Set<string>): string {
  for (;;) {
    const candidate = `${prefix}_${randomBytes(6).toString("hex")}`;
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
}

function moduleObjective(rawModule: Record<string, unknown>): string {
  for (const key of ["objective", "goal", "purpose", "summary", "description"]) {
    const value = rawModule[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 300);
    }
  }
  return "";
}

export function materializeModules(
  pathId: string,
  rawModules: unknown[],
  opts: {
    strict?: boolean;
    existingModuleIds?: Set<string> | null;
    existingObjectiveIds?: Set<string> | null;
    existingObjectiveCounts?: Record<string, number> | null;
    discardedModules?: Record<string, unknown>[] | null;
    moduleLimit?: number;
  } = {},
): LearningModule[] {
  const strict = Boolean(opts.strict);
  const cap = Math.max(
    1,
    Math.min(Math.trunc(opts.moduleLimit ?? DEFAULT_MODULE_LIMIT) || DEFAULT_MODULE_LIMIT, MAX_MODULE_LIMIT),
  );
  if (strict && rawModules.length > cap) {
    throw new TopicGenerationError(
      `A route may have at most ${cap} regions; this one has ${rawModules.length}`,
    );
  }
  const allowedModules = opts.existingModuleIds ?? null;
  const allowedObjectives = opts.existingObjectiveIds ?? null;
  const reservedModules = new Set(allowedModules ?? []);
  const reservedObjectives = new Set(allowedObjectives ?? []);
  const usedModules = new Set<string>();
  const usedObjectives = new Set<string>();
  const modules: LearningModule[] = [];
  const discarded = opts.discardedModules ?? null;

  const recordDiscard = (index: number, reason: string) => {
    if (discarded) discarded.push({ index: index + 1, reason });
  };

  const limit = Math.min(rawModules.length, cap);
  for (let moduleIndex = 0; moduleIndex < limit; moduleIndex += 1) {
    const rawModule = rawModules[moduleIndex];
    if (!isRecord(rawModule)) {
      if (strict) throw new TopicGenerationError(`Route region ${moduleIndex + 1} is invalid`);
      recordDiscard(moduleIndex, "module is not an object");
      continue;
    }
    const moduleName = String(rawModule.name ?? "").trim().slice(0, 200);
    if (!moduleName) {
      if (strict) throw new TopicGenerationError(`Route region ${moduleIndex + 1} needs a name`);
      recordDiscard(moduleIndex, "module name is missing");
      continue;
    }
    const objective = moduleObjective(rawModule);
    const requestedModuleId = String(rawModule.id ?? "").trim();
    let moduleId: string;
    if (allowedModules && requestedModuleId && allowedModules.has(requestedModuleId) && !usedModules.has(requestedModuleId)) {
      moduleId = requestedModuleId;
      usedModules.add(moduleId);
    } else if (allowedModules === null) {
      moduleId = `${pathId}_m${moduleIndex}`;
      reservedModules.add(moduleId);
    } else {
      moduleId = newEntityId(`${pathId}_m`, reservedModules);
    }
    const knowledgePoints: KnowledgePoint[] = [];
    const rawKps = rawModule.knowledge_points;
    if (!Array.isArray(rawKps)) {
      if (strict) throw new TopicGenerationError(`Route region ${moduleIndex + 1} needs at least one waypoint`);
      recordDiscard(moduleIndex, "knowledge_points is not a list");
      continue;
    }
    if (strict && !rawKps.length) {
      throw new TopicGenerationError(`Route region ${moduleIndex + 1} needs at least one waypoint`);
    }
    let objectiveLimit = MAX_OBJECTIVES_PER_MODULE;
    if (allowedModules?.has(moduleId) && opts.existingObjectiveCounts) {
      objectiveLimit = Math.max(objectiveLimit, opts.existingObjectiveCounts[moduleId] ?? 0);
    }
    if (strict && rawKps.length > objectiveLimit) {
      throw new TopicGenerationError(
        `Route region ${moduleIndex + 1} may have at most ${objectiveLimit} waypoints; it has ${rawKps.length}`,
      );
    }
    const kpLimit = Math.min(rawKps.length, objectiveLimit);
    for (let kpIndex = 0; kpIndex < kpLimit; kpIndex += 1) {
      const rawKp = rawKps[kpIndex];
      if (!isRecord(rawKp)) {
        if (strict) throw new TopicGenerationError(`Route region ${moduleIndex + 1} waypoint ${kpIndex + 1} is invalid`);
        continue;
      }
      const name = String(rawKp.name ?? "").trim().slice(0, 200);
      if (name.length < 2) {
        if (strict) throw new TopicGenerationError(`Route region ${moduleIndex + 1} waypoint ${kpIndex + 1} needs a name`);
        continue;
      }
      let kpType = String(rawKp.type ?? "concept").trim().toLowerCase();
      if (!ALLOWED_TYPES.has(kpType)) {
        if (strict) throw new TopicGenerationError(`Route region ${moduleIndex + 1} waypoint ${kpIndex + 1} has an invalid type`);
        kpType = "concept";
      }
      const requestedObjectiveId = String(rawKp.id ?? "").trim();
      let objectiveId: string;
      if (allowedObjectives && requestedObjectiveId && allowedObjectives.has(requestedObjectiveId) && !usedObjectives.has(requestedObjectiveId)) {
        objectiveId = requestedObjectiveId;
        usedObjectives.add(objectiveId);
      } else if (allowedObjectives === null) {
        objectiveId = `${moduleId}_kp${kpIndex}`;
        reservedObjectives.add(objectiveId);
      } else {
        objectiveId = newEntityId(`${moduleId}_kp`, reservedObjectives);
      }
      knowledgePoints.push({
        id: objectiveId,
        name,
        type: kpType as KnowledgeType,
        module_id: moduleId,
        prerequisite_ids: [],
        topic_source_ids: [],
        required_visual_tasks: [],
      });
    }
    if (knowledgePoints.length) {
      modules.push({
        id: moduleId,
        name: moduleName,
        order: modules.length,
        pass_threshold: 0.7,
        objective,
        knowledge_points: knowledgePoints,
      });
    } else if (strict) {
      throw new TopicGenerationError(`Route region ${moduleIndex + 1} needs at least one waypoint`);
    } else {
      recordDiscard(moduleIndex, "module has no usable waypoints");
    }
  }
  if (!strict && rawModules.length > cap) {
    for (let i = cap; i < rawModules.length; i += 1) {
      recordDiscard(i, "module limit exceeded");
    }
  }
  if (!modules.length) {
    throw new TopicGenerationError("The generated route contains no usable objectives");
  }
  return modules;
}

export function moduleLimitFor(sources: TopicSource[]): number {
  const documents = new Set<string>();
  for (const source of sources) {
    for (const name of sourceDocuments(source)) documents.add(name);
  }
  return Math.max(DEFAULT_MODULE_LIMIT, Math.min(MAX_MODULE_LIMIT, documents.size));
}

function coveredDocuments(rawModules: unknown[]): Set<string> {
  const covered = new Set<string>();
  for (const rawModule of rawModules) {
    if (!isRecord(rawModule)) continue;
    let materials = rawModule.materials;
    if (typeof materials === "string") materials = [materials];
    if (!Array.isArray(materials)) continue;
    for (const material of materials) {
      const name = String(material ?? "").trim();
      if (name) covered.add(name);
    }
  }
  return covered;
}

export function coverageReport(
  sources: TopicSource[],
  rawModules: unknown[],
): Record<string, unknown> {
  const covered = coveredDocuments(rawModules);
  const folded = [...covered].map((n) => n.toLowerCase());
  const missing: { label: string; document: string }[] = [];
  let total = 0;
  const sorted = [...sources].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  for (const source of sorted) {
    for (const name of sourceDocuments(source)) {
      total += 1;
      const needle = name.toLowerCase();
      if (folded.some((item) => item.includes(needle) || needle.includes(item))) continue;
      missing.push({ label: source.label, document: name });
    }
  }
  return {
    documents: total,
    covered: Math.max(0, total - missing.length),
    missing: covered.size ? missing : [],
    reported: covered.size > 0,
  };
}

// Minimal JSON repair: strip code fences, take the first {...} or [...] span.
export function parseJsonResponse(text: string): unknown {
  const raw = String(text ?? "").trim();
  const unfenced = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.search(/[{[]/);
    if (start < 0) return null;
    const open = unfenced[start];
    const close = open === "{" ? "}" : "]";
    const end = unfenced.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export async function generateTopicDraft(
  settings: Settings,
  args: {
    name: string;
    goal: string;
    sources: TopicSource[];
    language: string;
    must_cover?: string[];
  },
): Promise<Record<string, unknown>> {
  // TODO(port): upstream awaits ground_topic_sources (RAG + document
  // extraction). Until retrieval lands, sources pass through unchanged.
  const groundedSources = [...args.sources].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  const sourcesJson = JSON.stringify(sourcePayload(groundedSources));
  const moduleLimit = moduleLimitFor(groundedSources);
  const [systemPrompt, prompt] = topicGenerationPrompts(args.language, {
    name: String(args.name ?? "").trim().slice(0, 120),
    goal: String(args.goal ?? "").trim().slice(0, 2000),
    sources_json: sourcesJson,
    module_limit: moduleLimit,
    must_cover: (args.must_cover ?? []).map((s) => String(s).trim()).filter(Boolean),
  });
  const response = await completeText(settings, { system: systemPrompt, prompt });
  const data = parseJsonResponse(response);
  if (!isRecord(data)) {
    throw new TopicGenerationError("The model returned invalid route JSON");
  }
  const rawModules = data.modules;
  if (!Array.isArray(rawModules)) {
    throw new TopicGenerationError("The generated route has no module list");
  }
  const discardedModules: Record<string, unknown>[] = [];
  const modules = materializeModules("draft", rawModules, {
    discardedModules,
    moduleLimit,
  });
  return {
    description: String(data.description ?? "").trim().slice(0, 500),
    modules: modules.map((m) => ({ ...m })),
    sources: groundedSources.map((s) => ({ ...s })),
    discarded_module_count: discardedModules.length,
    discarded_modules: discardedModules,
    module_limit: moduleLimit,
    coverage: coverageReport(groundedSources, rawModules),
  };
}
