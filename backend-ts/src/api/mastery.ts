// Port of deeptutor/api/routers/mastery_path.py — the Mastery Path REST
// surface. Mount with ``app.route("/api/mastery-paths", masteryRouter)``.
import { Hono } from "hono";
import { randomBytes, randomUUID } from "node:crypto";

import type { Settings } from "../config.js";
import { get_settings } from "../config.js";
import type { SessionStore } from "../store/session_store.js";
import { appState } from "../main.js";
import {
  ACTIVE_INTERACTION_STATES,
  KnowledgePoint,
  LearningModule,
  LearningProgress,
  MasteryTopic,
  normalizeModule,
  normalizeKnowledgePoint,
  normalizeKnowledgeType,
  publicPendingQuestion,
  TopicMetadata,
  TopicSource,
  templateAsBinding,
  learnerProfileIsEmpty,
} from "../services/mastery/models.js";
import {
  ObjectiveRelationError,
  normalizeRefs,
  type RelationRefs,
} from "../services/mastery/objective_relations.js";
import {
  LearningService,
  MAX_PROFILE_FIELD_LEN,
  MAX_PATH_NAME_LEN,
} from "../services/mastery/service.js";
import {
  KeyError,
  LearningStore,
  LearningConflictError,
  PathLeaseConflictError,
  validateId,
} from "../services/mastery/store.js";
import {
  findKnowledgePoint,
  mapSummary,
  nextObjective,
  objectiveReport,
  objectiveStatus,
  pathDisplayName,
  reviewableTasks,
  dueReviews,
  displayMastery,
  isMastered,
} from "../services/mastery/policy.js";
import {
  schedulerForProgress,
  builtinTemplates,
  BUILTIN_TEMPLATE_IDS,
} from "../services/mastery/review_strategy.js";
import { reviewSortKey } from "../services/mastery/scheduler.js";
import { normalizeRepetitionState, buildReviewStrategyTemplate } from "../services/mastery/models.js";
import {
  generateTopicDraft,
  materializeModules,
  moduleLimitFor,
  TopicGenerationError,
  MAX_MODULE_LIMIT,
  DEFAULT_MODULE_LIMIT,
} from "../services/mastery/topic_generation.js";
import { suggestTopicName } from "../services/mastery/topic_naming.js";
import { getAskHint } from "../services/mastery/mastery_hints.js";
import {
  topicSessions,
  topicCards,
  findTopic,
} from "../services/mastery/navigation.js";
import { admissionError, normalizeMode, MODES } from "../services/mastery/mode.js";
import { masteryTopicEventHub, type TopicSubscription } from "../services/mastery/event_hub.js";
import { completeText } from "../services/llm_text.js";
import { loadUi } from "../services/settings_ext/store.js";
import {
  defaultModuleName,
  isChinese,
  notebookGenerationPrompts,
} from "../services/mastery/prompts.js";
import { parseJsonResponse } from "../services/mastery/topic_generation.js";

export const masteryRouter = new Hono();

// ---- error handling ------------------------------------------------------------
// Hono runs sub-app middleware for mounted routes, so a router-level ``use``
// catches every handler error and maps HttpError/KeyError/conflicts to the
// upstream status codes (a sub-app ``onError`` would not fire when mounted).
masteryRouter.use("*", async (c, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof HttpError) {
      return c.json({ detail: err.message }, err.status as 400);
    }
    if (err instanceof LearningConflictError) {
      return c.json({ detail: String(err.message) }, 409);
    }
    if (err instanceof KeyError) {
      return c.json({ detail: "Not found" }, 404);
    }
    console.error("mastery router error:", err);
    return c.json({ detail: "Internal server error" }, 500);
  }
});


function settings(): Settings {
  return appState?.settings ?? get_settings();
}

function sessionStore(): SessionStore | null {
  return (appState?.store as SessionStore) ?? null;
}

function responseLanguage(): string {
  try {
    const ui = loadUi(settings()) as Record<string, unknown>;
    const lang = String(ui["response_language"] ?? ui["language"] ?? "en");
    return lang || "en";
  } catch {
    return "en";
  }
}

function newStore(): LearningStore {
  return new LearningStore(settings());
}

function newService(): LearningService {
  return new LearningService(newStore());
}

// ---- upstream helpers -------------------------------------------------------

function validateBookId(bookId: string): void {
  if (!bookId || bookId.includes("..") || bookId.includes("/") || bookId.includes("\\") || bookId.includes(":")) {
    throw new HttpError(400, "Invalid book_id");
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function param(c: { req: { param: (k: string) => string } }, key: string): string {
  return c.req.param(key) ?? "";
}

async function body<T = Record<string, unknown>>(c: { req: { json: () => Promise<unknown> } }): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

function parseModules(raw: unknown): LearningModule[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  return list.map((m, i) => {
    const kpsData = Array.isArray(m["knowledge_points"]) ? (m["knowledge_points"] as Record<string, unknown>[]) : [];
    const kps = kpsData.map((kp) =>
      normalizeKnowledgePoint(
        {
          ...kp,
          id: kp["id"] === undefined || kp["id"] === null || kp["id"] === "" ? undefined : kp["id"],
          name: String(kp["name"] ?? ""),
          type: normalizeKnowledgeType(kp["type"] ?? "concept"),
          module_id: String(kp["module_id"] ?? ""),
          prerequisite_ids: Array.isArray(kp["prerequisite_ids"]) ? kp["prerequisite_ids"] : [],
          prerequisite_refs: Array.isArray(kp["prerequisite_refs"]) ? kp["prerequisite_refs"] : [],
          topic_source_ids: Array.isArray(kp["topic_source_ids"]) ? kp["topic_source_ids"] : [],
          topic_source_refs: Array.isArray(kp["topic_source_refs"]) ? kp["topic_source_refs"] : [],
          client_ref: String(kp["client_ref"] ?? ""),
        },
        String(m["id"] ?? ""),
      ),
    );
    const mClean = { ...m };
    delete mClean["knowledge_points"];
    return normalizeModule(
      {
        ...mClean,
        id: m["id"] === undefined || m["id"] === null || m["id"] === "" ? `${i}` : m["id"],
        name: String(m["name"] ?? ""),
        order: m["order"] === undefined || m["order"] === null ? i : m["order"],
        objective: String(m["objective"] ?? ""),
        pass_threshold: m["pass_threshold"] === undefined ? 0.7 : Number(m["pass_threshold"]),
        knowledge_points: kps,
      },
      i,
    );
  });
}

function validateRunnableModules(modules: LearningModule[], statusCode = 400): void {
  if (!modules.length) {
    throw new HttpError(statusCode, "At least one learning module is required");
  }
  for (const mod of modules) {
    if (!mod.knowledge_points?.length) {
      throw new HttpError(statusCode, `Module ${mod.id} must contain at least one knowledge point`);
    }
  }
}

// Cancel an in-flight learning turn before an administrative mutation, then
// hold the path lease so no tutor write can interleave (upstream
// ``_exclusive_path_mutation``). The TS runtime has no capability-tagged
// mastery turns yet; lease conflicts still produce the upstream 409.
async function exclusivePathMutation<T>(bookId: string, fn: () => T | Promise<T>): Promise<T> {
  const store = newStore();
  const operationId = `api-${randomUUID().replace(/-/g, "")}`;
  try {
    store.acquirePathLease(bookId, "__path_api__", operationId, { bindSession: false });
  } catch (e) {
    if (e instanceof PathLeaseConflictError) {
      const lease = (e as PathLeaseConflictError).lease;
      throw new HttpError(
        409,
        `Mastery path changed activity while the operation was starting; active session: ${lease.session_id}`,
      );
    }
    throw e;
  }
  try {
    return await fn();
  } finally {
    try {
      store.releasePathLease(bookId, operationId);
    } catch {
      /* best effort */
    }
  }
}

function topicSources(items: Record<string, unknown>[]): TopicSource[] {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    id: String(item["id"] ?? "").trim() || `source_${randomBytes(8).toString("hex")}`,
    kind: String(item["kind"] ?? "goal") as TopicSource["kind"],
    source_id: String(item["source_id"] ?? "").trim().slice(0, 300),
    label: String(item["label"] ?? "").trim(),
    excerpt: String(item["excerpt"] ?? "").trim(),
    position: index,
    available: item["available"] !== false,
    metadata: isRecord(item["metadata"]) ? (item["metadata"] as Record<string, unknown>) : {},
    created_at: Date.now() / 1000,
  }));
}

function topicSourceAliases(items: Record<string, unknown>[], sources: TopicSource[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  (Array.isArray(items) ? items : []).forEach((item, i) => {
    const alias = String(item["client_ref"] ?? "").trim();
    if (!alias) return;
    const sourceId = sources[i]?.id;
    if (alias in aliases && aliases[alias] !== sourceId) {
      throw new ObjectiveRelationError(`Source reference ${alias} is ambiguous`);
    }
    aliases[alias] = sourceId ?? "";
  });
  return aliases;
}

function relationRefs(
  inputs: Record<string, unknown>[],
  modules: LearningModule[],
): Record<string, RelationRefs> {
  const refs: Record<string, RelationRefs> = {};
  const inputModules = Array.isArray(inputs) ? inputs : [];
  modules.forEach((module, i) => {
    const inputModule = inputModules[i] ?? {};
    const inputPoints = Array.isArray(inputModule["knowledge_points"])
      ? (inputModule["knowledge_points"] as Record<string, unknown>[])
      : [];
    const points = module.knowledge_points ?? [];
    points.forEach((point, j) => {
      const ip = inputPoints[j] ?? {};
      refs[point.id] = {
        client_ref: String(ip["client_ref"] ?? "").trim(),
        prerequisite_refs: normalizeRefs([
          ...(Array.isArray(ip["prerequisite_refs"]) ? (ip["prerequisite_refs"] as unknown[]) : []),
          ...(Array.isArray(ip["prerequisite_ids"]) ? (ip["prerequisite_ids"] as unknown[]) : []),
        ]),
        topic_source_refs: normalizeRefs([
          ...(Array.isArray(ip["topic_source_refs"]) ? (ip["topic_source_refs"] as unknown[]) : []),
          ...(Array.isArray(ip["topic_source_ids"]) ? (ip["topic_source_ids"] as unknown[]) : []),
        ]),
      };
    });
  });
  return refs;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---- read projections --------------------------------------------------------

function readProjection(progress: LearningProgress, now = Date.now() / 1000): LearningProgress {
  const projected = JSON.parse(JSON.stringify(progress)) as LearningProgress;
  projected.review_queue = schedulerForProgress(projected).buildReviewQueue(projected, now);
  return projected;
}

function reviewQueue(progress: LearningProgress, now = Date.now() / 1000): Record<string, unknown>[] {
  const scheduler = schedulerForProgress(progress);
  const moment = now;
  const names = new Map<string, string>();
  for (const m of progress.modules ?? []) {
    for (const kp of m.knowledge_points ?? []) names.set(kp.id, kp.name);
  }
  const tasks = reviewableTasks(progress);
  tasks.sort((a, b) => {
    const ka = reviewSortKey(a, moment);
    const kb = reviewSortKey(b, moment);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
  return tasks.map((task) => ({
    id: task.id,
    knowledge_point_id: task.knowledge_point_id,
    knowledge_point_name: names.get(task.knowledge_point_id) ?? "",
    knowledge_type: task.knowledge_type,
    due_at: task.due_at,
    priority: task.priority,
    due: task.due_at <= moment,
    forgetting_risk: Math.round(task.forgetting_risk * 1000) / 1000,
    reason: task.reason,
    evidence_source: task.evidence_source,
    evidence_id: task.evidence_id,
    stability: Math.round(task.state.stability * 1000) / 1000,
    retrievability:
      Math.round(scheduler.retrievability(task.state, moment) * 1000) / 1000,
    desired_retention: task.state.desired_retention,
    lapse_count: task.state.lapse_count,
    recent_failure: Boolean(
      task.state.consecutive_wrong ||
        (progress.error_records ?? []).some(
          (e) =>
            e.knowledge_point_id === task.knowledge_point_id &&
            (e.status === "active" || e.status === "retrying"),
        ),
    ),
  }));
}

function reviewSettingsPayload(progress: LearningProgress): Record<string, unknown> {
  const binding = progress.review_strategy;
  const strategy = binding
    ? {
        template_id: binding.template_id,
        name: binding.name,
        builtin: binding.builtin,
        desired_retention: binding.desired_retention,
        intervals: binding.intervals,
      }
    : null;
  return {
    desired_retention: progress.desired_retention,
    scope: "path",
    strategy,
  };
}

function nextStepPayload(store: LearningStore, pathId: string, progress: LearningProgress): Record<string, unknown> {
  const interaction =
    progress.pending_question != null ? store.getActiveInteraction(pathId) : null;
  return nextObjective(progress, {
    pending_session_id: interaction?.session_id ?? "",
  }) as unknown as Record<string, unknown>;
}

function topicPayloadFromSnapshot(
  progress: LearningProgress,
  topic: MasteryTopic,
  sessionCount: number,
  activeInteraction: ReturnType<LearningStore["getActiveInteraction"]>,
): Record<string, unknown> {
  const pathId = progress.book_id;
  const moment = Date.now() / 1000;
  const projected = readProjection(progress, moment);
  const profile = projected.learner_profile;
  return {
    path_id: pathId,
    name: pathDisplayName(progress),
    metadata: topic.metadata,
    sources: topic.sources,
    path_revision: progress.version,
    next: nextObjective(projected, {
      now: moment,
      pending_session_id: activeInteraction?.session_id ?? "",
    }),
    map: mapSummary(projected, moment),
    reviews: reviewQueue(projected, moment),
    review_settings: reviewSettingsPayload(progress),
    learner_profile: profile && !learnerProfileIsEmpty(profile) ? profile : null,
    session_count: sessionCount,
    updated_at: progress.updated_at,
  };
}

function topicPayload(store: LearningStore, pathId: string): Record<string, unknown> {
  const progress = store.load(pathId);
  if (progress === null) throw new HttpError(404, "Mastery topic not found");
  const topic = store.getTopic(pathId, progress);
  if (topic === null) throw new HttpError(404, "Mastery topic not found");
  const active = progress.pending_question != null ? store.getActiveInteraction(pathId) : null;
  return topicPayloadFromSnapshot(
    progress,
    topic,
    store.listSessionIds(pathId).length,
    active,
  );
}

function strategyPayload(template: Record<string, unknown>): Record<string, unknown> {
  return template;
}

function resolveReviewStrategy(
  store: LearningStore,
  templateId: string,
): Record<string, unknown> | null {
  const builtin = builtinTemplates()[templateId];
  if (builtin) return builtin as unknown as Record<string, unknown>;
  try {
    const custom = store.getReviewStrategy(templateId);
    return custom ? (custom as unknown as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---- topics -----------------------------------------------------------------

masteryRouter.get("/topics", (c) => {
  const store = newStore();
  const topics = store.listTopicSnapshots("active").map((snap) =>
    topicPayloadFromSnapshot(
      snap.progress,
      snap.topic,
      snap.sessionCount,
      snap.activeInteraction,
    ),
  );
  return c.json({ topics });
});

masteryRouter.get("/topics/index", (c) => {
  const store = newStore();
  const topics = store.listTopicSnapshots("active").map((snap) => ({
    path_id: snap.progress.book_id,
    name: pathDisplayName(snap.progress),
    emoji: snap.topic.metadata.emoji,
  }));
  return c.json({ topics });
});

masteryRouter.get("/reading/records", (c) => {
  const records = newStore().listReadingRecords();
  return c.json(records);
});

masteryRouter.post("/topics/draft", async (c) => {
  const b = await body<Record<string, unknown>>(c);
  const name = String(b["name"] ?? "").trim();
  const goal = String(b["goal"] ?? "").trim();
  if (!name || name.length > 120) throw new HttpError(422, "name is required (max 120 chars)");
  if (!goal || goal.length > 2000) throw new HttpError(422, "goal is required (max 2000 chars)");
  const sourceItems = Array.isArray(b["sources"]) ? (b["sources"] as Record<string, unknown>[]) : [];
  if (sourceItems.length > 16) throw new HttpError(422, "at most 16 sources");
  const mustCover = Array.isArray(b["must_cover"])
    ? (b["must_cover"] as unknown[]).map((s) => String(s)).slice(0, 40)
    : [];
  try {
    const draft = await generateTopicDraft(settings(), {
      name,
      goal,
      sources: topicSources(sourceItems),
      language: responseLanguage(),
      must_cover: mustCover,
    });
    return c.json(draft);
  } catch (e) {
    if (e instanceof TopicGenerationError) throw new HttpError(502, String(e.message));
    throw e;
  }
});

const PROVISIONAL_NAME_CHARS = 32;

function provisionalName(goal: string): string {
  const head = String(goal ?? "").trim().split(/[\n。.!?！？;；]/)[0]?.trim() ?? "";
  if (!head) return "";
  if (head.length <= PROVISIONAL_NAME_CHARS) return head;
  return head.slice(0, PROVISIONAL_NAME_CHARS).trimEnd() + "…";
}

masteryRouter.post("/topics", async (c) => {
  const b = await body<Record<string, unknown>>(c);
  const pathId = `topic_${randomBytes(16).toString("hex")}`;
  const moduleItems = Array.isArray(b["modules"]) ? (b["modules"] as Record<string, unknown>[]) : [];
  let modules: LearningModule[] = [];
  if (moduleItems.length) {
    try {
      modules = materializeModules(
        pathId,
        moduleItems.map((m) => ({ ...m })),
        { strict: true, moduleLimit: MAX_MODULE_LIMIT },
      );
    } catch (e) {
      if (e instanceof TopicGenerationError) throw new HttpError(422, String(e.message));
      throw e;
    }
  }
  const sourceItems = Array.isArray(b["sources"]) ? (b["sources"] as Record<string, unknown>[]) : [];
  const sources = topicSources(sourceItems);
  const sourceAliases = topicSourceAliases(sourceItems, sources);
  const store = newStore();
  const now = Date.now() / 1000;
  const metadata: TopicMetadata = {
    path_id: pathId,
    goal: String(b["goal"] ?? "").trim(),
    description: String(b["description"] ?? "").trim().slice(0, 500),
    emoji: String(b["emoji"] ?? "").trim() || "🧭",
    map_seed: 0,
    status: "active",
    created_at: now,
    updated_at: now,
  };
  let resolvedName = String(b["name"] ?? "").trim();
  if (!resolvedName) {
    resolvedName =
      (await suggestTopicName(settings(), metadata.goal, {
        source_labels: sources.map((s) => s.label),
        language: responseLanguage(),
      })) || provisionalName(metadata.goal);
  }
  try {
    const progress = newService().createTopic(pathId, {
      name: resolvedName,
      modules,
      metadata,
      sources,
      relationRefs: relationRefs(moduleItems, modules),
      sourceAliases,
    });
    const payload = topicPayload(newStore(), pathId);
    payload["path_revision"] = progress.version;
    return c.json(payload);
  } catch (e) {
    if (e instanceof ObjectiveRelationError) throw new HttpError(422, String(e.message));
    throw e;
  }
});

masteryRouter.get("/topics/:path_id", (c) => {
  const pathId = param(c, "path_id");
  validateBookId(pathId);
  return c.json(topicPayload(newStore(), pathId));
});

masteryRouter.get("/topics/:path_id/review-settings", (c) => {
  const pathId = param(c, "path_id");
  validateBookId(pathId);
  const progress = newStore().load(pathId);
  if (progress === null) throw new HttpError(404, "Mastery topic not found");
  return c.json(reviewSettingsPayload(progress));
});

masteryRouter.put("/topics/:path_id/review-settings", async (c) => {
  const pathId = param(c, "path_id");
  validateBookId(pathId);
  const b = await body<Record<string, unknown>>(c);
  const desired = Number(b["desired_retention"]);
  if (!Number.isFinite(desired) || desired < 0.7 || desired > 0.99) {
    throw new HttpError(422, "desired_retention must be between 0.7 and 0.99");
  }
  if (!newStore().exists(pathId)) throw new HttpError(404, "Mastery topic not found");
  await exclusivePathMutation(pathId, () => {
    const store = newStore();
    try {
      store.mutate(pathId, (tx) => {
        const states = Object.values(tx.progress.repetition_states ?? {});
        if (
          tx.progress.desired_retention === desired &&
          states.every((s) => normalizeRepetitionState(s).desired_retention === desired)
        ) {
          return;
        }
        schedulerForProgress(tx.progress).setDesiredRetention(tx.progress, desired);
        tx.touch();
        tx.emit("review.settings_changed", { desired_retention: tx.progress.desired_retention });
      });
    } catch (e) {
      if (e instanceof KeyError) throw new HttpError(404, "Mastery topic not found");
      throw e;
    }
  });
  return c.json(topicPayload(newStore(), pathId));
});

// ---- review strategies -------------------------------------------------------

masteryRouter.get("/review-strategies", (c) => {
  const store = newStore();
  const presets = builtinTemplates();
  const customs = store.listReviewStrategies();
  const strategies = [
    ...BUILTIN_TEMPLATE_IDS.map((id) => presets[id]),
    ...customs,
  ];
  return c.json({ strategies: strategies.map(strategyPayload) });
});

masteryRouter.post("/review-strategies", async (c) => {
  const b = await body<Record<string, unknown>>(c);
  const name = String(b["name"] ?? "").trim();
  if (!name || name.length > 120) throw new HttpError(422, "name must not be blank (max 120 chars)");
  let desiredRetention: number | null = null;
  if (b["desired_retention"] !== null && b["desired_retention"] !== undefined) {
    const v = Number(b["desired_retention"]);
    if (!Number.isFinite(v) || v < 0.7 || v > 0.99) {
      throw new HttpError(422, "desired_retention must be between 0.7 and 0.99");
    }
    desiredRetention = v;
  }
  let saved;
  try {
    saved = newStore().saveReviewStrategy(buildReviewStrategyTemplate({
      template_id: `custom-${randomBytes(6).toString("hex")}`,
      name,
      description: String(b["description"] ?? "").slice(0, 500),
      builtin: false,
      desired_retention: desiredRetention,
      intervals: b["intervals"],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    }));
  } catch (e) {
    if (e instanceof Error && /template_id|intervals|name|desired/.test(e.message)) {
      throw new HttpError(422, e.message);
    }
    throw new HttpError(409, String(e));
  }
  return c.json(strategyPayload(saved as unknown as Record<string, unknown>), 201);
});

masteryRouter.get("/review-strategies/:template_id", (c) => {
  const templateId = param(c, "template_id");
  const template = resolveReviewStrategy(newStore(), templateId);
  if (template === null) throw new HttpError(404, "Review strategy not found");
  return c.json(strategyPayload(template));
});

masteryRouter.put("/review-strategies/:template_id", async (c) => {
  const templateId = param(c, "template_id");
  if (BUILTIN_TEMPLATE_IDS.includes(templateId)) {
    throw new HttpError(403, "Built-in preset strategies cannot be edited");
  }
  const b = await body<Record<string, unknown>>(c);
  const store = newStore();
  let existing;
  try {
    existing = store.getReviewStrategy(templateId);
  } catch {
    existing = null;
  }
  if (!existing) throw new HttpError(404, "Review strategy not found");
  const name = String(b["name"] ?? "").trim();
  if (!name || name.length > 120) throw new HttpError(422, "name must not be blank (max 120 chars)");
  let desiredRetention: number | null = null;
  if (b["desired_retention"] !== null && b["desired_retention"] !== undefined) {
    const v = Number(b["desired_retention"]);
    if (!Number.isFinite(v) || v < 0.7 || v > 0.99) {
      throw new HttpError(422, "desired_retention must be between 0.7 and 0.99");
    }
    desiredRetention = v;
  }
  const replacement = buildReviewStrategyTemplate({
    template_id: templateId,
    name,
    description: String(b["description"] ?? "").slice(0, 500),
    desired_retention: desiredRetention,
    intervals: b["intervals"],
    builtin: false,
    created_at: existing.created_at,
    updated_at: Date.now() / 1000,
  });
  const saved = store.saveReviewStrategy(replacement);
  return c.json(strategyPayload(saved as unknown as Record<string, unknown>));
});

masteryRouter.post("/review-strategies/:template_id/duplicate", async (c) => {
  const templateId = param(c, "template_id");
  const source = resolveReviewStrategy(newStore(), templateId);
  if (source === null) throw new HttpError(404, "Review strategy not found");
  const b = await body<Record<string, unknown>>(c);
  const copy = buildReviewStrategyTemplate({
    template_id: `custom-${randomBytes(6).toString("hex")}`,
    name: String(b["name"] ?? "").trim() || `${String(source["name"])} (copy)`,
    description: source["description"] ?? "",
    desired_retention: source["desired_retention"] ?? null,
    intervals: source["intervals"],
    builtin: false,
  });
  const saved = newStore().saveReviewStrategy(copy);
  return c.json(strategyPayload(saved as unknown as Record<string, unknown>), 201);
});

masteryRouter.delete("/review-strategies/:template_id", async (c) => {
  const templateId = param(c, "template_id");
  if (BUILTIN_TEMPLATE_IDS.includes(templateId)) {
    throw new HttpError(403, "Built-in preset strategies cannot be deleted");
  }
  let deleted = false;
  try {
    deleted = newStore().deleteReviewStrategy(templateId);
  } catch {
    deleted = false;
  }
  if (!deleted) throw new HttpError(404, "Review strategy not found");
  return c.json({ deleted: true });
});

masteryRouter.put("/topics/:path_id/review-strategy", async (c) => {
  const pathId = param(c, "path_id");
  validateBookId(pathId);
  const b = await body<Record<string, unknown>>(c);
  const templateId = String(b["template_id"] ?? "").trim();
  const store = newStore();
  if (!store.exists(pathId)) throw new HttpError(404, "Mastery topic not found");
  let template: Record<string, unknown> | null = null;
  if (templateId) {
    template = resolveReviewStrategy(store, templateId);
    if (template === null) throw new HttpError(404, "Review strategy not found");
  }
  await exclusivePathMutation(pathId, () => {
    const store2 = newStore();
    try {
      store2.mutate(pathId, (tx) => {
        const retention = template ? (template["desired_retention"] as number | null) : null;
        const current = tx.progress.review_strategy;
        const replacement = template
          ? (templateAsBinding(
              template as never,
              current ? current.bound_at : undefined,
            ) as LearningProgress["review_strategy"])
          : null;
        const sameStrategy =
          JSON.stringify(current) === JSON.stringify(replacement);
        if (sameStrategy && (retention === null || retention === tx.progress.desired_retention)) {
          return;
        }
        tx.progress.review_strategy = replacement;
        const effectiveRetention = retention ?? tx.progress.desired_retention;
        if (retention !== null) tx.progress.desired_retention = retention;
        schedulerForProgress(tx.progress).rebuildFromEvidence(tx.progress);
        tx.progress.desired_retention = effectiveRetention;
        tx.touch();
        tx.emit("review.strategy_changed", {
          template_id: template ? String(template["template_id"]) : "",
          name: template ? String(template["name"]) : "",
        });
      });
    } catch (e) {
      if (e instanceof KeyError) throw new HttpError(404, "Mastery topic not found");
      throw e;
    }
  });
  return c.json(topicPayload(newStore(), pathId));
});

masteryRouter.put("/topics/:path_id/map", async (c) => {
  const pathId = param(c, "path_id");
  validateBookId(pathId);
  const b = await body<Record<string, unknown>>(c);
  const moduleItems = Array.isArray(b["modules"]) ? (b["modules"] as Record<string, unknown>[]) : [];
  if (!moduleItems.length) throw new HttpError(422, "modules must contain at least one module");
  await exclusivePathMutation(pathId, () => {
    const store = newStore();
    const progress = store.load(pathId);
    if (progress === null) throw new HttpError(404, "Mastery topic not found");
    const existingModuleIds = new Set((progress.modules ?? []).map((m) => m.id));
    const existingObjectiveIds = new Set(
      (progress.modules ?? []).flatMap((m) => (m.knowledge_points ?? []).map((kp) => kp.id)),
    );
    const existingCounts: Record<string, number> = {};
    for (const m of progress.modules ?? []) {
      existingCounts[m.id] = (m.knowledge_points ?? []).length;
    }
    let modules: LearningModule[];
    try {
      modules = materializeModules(
        pathId,
        moduleItems.map((m) => ({ ...m })),
        {
          strict: true,
          existingModuleIds,
          existingObjectiveIds,
          existingObjectiveCounts: existingCounts,
          moduleLimit: MAX_MODULE_LIMIT,
        },
      );
    } catch (e) {
      if (e instanceof TopicGenerationError) throw new HttpError(422, String(e.message));
      throw e;
    }
    try {
      new LearningService(store).replaceModulesForPath(pathId, modules, {
        eventType: "topic.map_edited",
        relationRefs: relationRefs(moduleItems, modules),
      });
    } catch (e) {
      if (e instanceof ObjectiveRelationError) throw new HttpError(422, String(e.message));
      throw e;
    }
  });
  return c.json(topicPayload(newStore(), pathId));
});

masteryRouter.post("/topics/:path_id/objectives/:kp_id/override", async (c) => {
  const pathId = param(c, "path_id");
  const kpId = param(c, "kp_id");
  validateBookId(pathId);
  const b = await body<Record<string, unknown>>(c);
  const mastered = Boolean(b["mastered"]);
  const note = String(b["note"] ?? "").slice(0, 500);
  let progress: LearningProgress;
  try {
    progress = await exclusivePathMutation(pathId, () =>
      newService().setLearnerMasteryOverride(pathId, kpId, { mastered, note }),
    );
  } catch (e) {
    if (e instanceof Error && e.name === "MasteryInteractionError") {
      throw new HttpError(404, String(e.message));
    }
    throw e;
  }
  return c.json({
    status: "ok",
    path_revision: progress.version,
    map: mapSummary(progress),
  });
});

masteryRouter.get("/topics/:path_id/sessions", async (c) => {
  const pathId = param(c, "path_id");
  validateBookId(pathId);
  if (!newStore().exists(pathId)) throw new HttpError(404, "Mastery topic not found");
  const sessions = await topicSessions(settings(), sessionStore(), pathId);
  return c.json({ path_id: pathId, sessions });
});

masteryRouter.put("/topics/:path_id/sessions/:session_id/mode", async (c) => {
  const pathId = param(c, "path_id");
  const sessionId = param(c, "session_id");
  validateBookId(pathId);
  const b = await body<Record<string, unknown>>(c);
  const requested = String(b["mode"] ?? "").trim().toLowerCase();
  if (!MODES.includes(requested)) {
    throw new HttpError(422, `mode must be one of: ${MODES.join(", ")}`);
  }
  const progress = newStore().load(pathId);
  const hasOutline =
    progress !== null && (progress.modules ?? []).some((m) => (m.knowledge_points ?? []).length > 0);
  const refusal = admissionError(requested, hasOutline);
  if (refusal) throw new HttpError(409, refusal);
  const store = sessionStore();
  if (!store) throw new HttpError(404, "Session not found");
  const session = store.get(sessionId);
  if (!session) throw new HttpError(404, "Session not found");
  const preferences = { ...((session["preferences"] ?? {}) as Record<string, unknown>), mastery_session_mode: requested };
  (session as Record<string, unknown>)["preferences"] = preferences;
  store.save(session as never);
  return c.json({ session_id: sessionId, mode: normalizeMode(requested) });
});

masteryRouter.get("/topics/:path_id/ask-hint", async (c) => {
  const pathId = param(c, "path_id");
  validateBookId(pathId);
  const sessionId = String(c.req.query("session_id") ?? "");
  const hint = await getAskHint(settings(), sessionStore(), pathId, sessionId);
  return c.json(hint);
});

// ---- progress ---------------------------------------------------------------

masteryRouter.get("/progress", (c) => {
  return c.json(newService().listProgress());
});

masteryRouter.get("/progress/:book_id/map", (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const progress = newService().getOrCreate(bookId);
  const moment = Date.now() / 1000;
  const projected = readProjection(progress, moment);
  return c.json({
    book_id: bookId,
    name: pathDisplayName(projected),
    path_revision: projected.version,
    next: nextObjective(projected, { now: moment }),
    map: mapSummary(projected, moment),
  });
});

masteryRouter.get("/progress/:book_id/board", (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const progress = newService().getOrCreate(bookId);
  const moment = Date.now() / 1000;
  const projected = readProjection(progress, moment);
  const summary = mapSummary(projected, moment);
  const dueByKp = new Map<string, number>();
  for (const t of projected.review_queue ?? []) dueByKp.set(t.knowledge_point_id, t.due_at);
  const cards: Record<string, unknown>[] = [];
  const modules: Record<string, unknown>[] = [];
  for (const module of (summary["modules"] as Record<string, unknown>[]) ?? []) {
    const moduleCards: Record<string, unknown>[] = [];
    const kps = (module["knowledge_points"] as Record<string, unknown>[]) ?? [];
    kps.forEach((kp, index) => {
      const card = {
        id: kp["id"],
        name: kp["name"],
        type: kp["type"],
        module_id: module["id"],
        module_name: module["name"],
        status: kp["status"],
        mastery_level: kp["mastery"],
        next_review_at: dueByKp.get(String(kp["id"])) ?? null,
        position: { column: module["order"], row: index },
      };
      cards.push(card);
      moduleCards.push(card);
    });
    modules.push({
      id: module["id"],
      name: module["name"],
      order: module["order"],
      mastered: module["mastered"],
      total: module["total"],
      cards: moduleCards,
    });
  }
  return c.json({
    book_id: bookId,
    name: summary["name"],
    path_revision: projected.version,
    cards,
    modules,
  });
});

masteryRouter.get("/progress/:book_id/objectives/:kp_id", (c) => {
  const bookId = param(c, "book_id");
  const kpId = param(c, "kp_id");
  validateBookId(bookId);
  const store = newStore();
  const { progress, evidence, evidenceCount } = store.loadWithLearningEvidence(bookId, kpId, 20);
  if (progress === null) throw new HttpError(404, "Progress not found");
  const moment = Date.now() / 1000;
  const projected = readProjection(progress, moment);
  const report = objectiveReport(projected, kpId, moment);
  if (report === null) throw new HttpError(404, "Objective not found");
  const interactions = store.listInteractions(bookId);
  const prompts = new Map<string, string>();
  for (const interaction of interactions) {
    prompts.set(interaction.interaction_id, publicPendingQuestion(interaction.question).prompt as string);
  }
  const attempts = (report["attempts"] as Record<string, unknown>[]) ?? [];
  for (const attempt of attempts) {
    attempt["prompt"] = prompts.get(String(attempt["question_id"])) ?? "";
  }
  (report as Record<string, unknown>)["evidence"] = evidence;
  (report as Record<string, unknown>)["evidence_count"] = evidenceCount;
  return c.json({ book_id: bookId, path_revision: projected.version, objective: report });
});

masteryRouter.get("/progress/:book_id/events", (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const after = Math.max(0, Number(c.req.query("after_revision") ?? 0) || 0);
  const store = newStore();
  const progress = store.load(bookId);
  if (progress === null) throw new HttpError(404, "Progress not found");
  const events = store.listEvents(bookId, after);
  return c.json({ book_id: bookId, events });
});

masteryRouter.get("/progress/:book_id/sessions", (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const store = newStore();
  if (!store.exists(bookId)) throw new HttpError(404, "Progress not found");
  return c.json({ book_id: bookId, session_ids: store.listSessionIds(bookId) });
});

masteryRouter.post("/progress/:book_id/init-modules", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const b = await body<Record<string, unknown>>(c);
  const moduleItems = Array.isArray(b["modules"]) ? (b["modules"] as Record<string, unknown>[]) : [];
  const modules = parseModules(moduleItems);
  validateRunnableModules(modules);
  const progress = await exclusivePathMutation(bookId, () =>
    newService().replaceModulesForPath(bookId, modules),
  );
  return c.json({
    status: "ok",
    module_count: modules.length,
    path_revision: progress.version,
  });
});

masteryRouter.post("/progress/:book_id/import-from-book", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const b = await body<Record<string, unknown>>(c);
  const chapters = Array.isArray(b["chapters"]) ? (b["chapters"] as Record<string, unknown>[]) : [];
  const modules: LearningModule[] = chapters.map((ch, i) => {
    const kpsData = Array.isArray(ch["knowledge_points"]) ? (ch["knowledge_points"] as unknown[]) : [];
    const kps = kpsData.map((name, j) =>
      normalizeKnowledgePoint(
        {
          id: `${bookId}_ch${i}_kp${j}`,
          name: String(name),
          type: "concept",
          module_id: `${bookId}_ch${i}`,
        },
        `${bookId}_ch${i}`,
      ),
    );
    return normalizeModule(
      {
        id: `${bookId}_ch${i}`,
        name: String(ch["title"] ?? "") || `Chapter ${i + 1}`,
        order: i,
        pass_threshold: 0.7,
        knowledge_points: kps,
      },
      i,
    );
  });
  validateRunnableModules(modules);
  const progress = await exclusivePathMutation(bookId, () =>
    newService().replaceModulesForPath(bookId, modules),
  );
  return c.json({
    status: "ok",
    module_count: modules.length,
    path_revision: progress.version,
  });
});

masteryRouter.patch("/progress/:book_id", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const b = await body<Record<string, unknown>>(c);
  const name = String(b["name"] ?? "");
  const store = newStore();
  if (!store.exists(bookId)) throw new HttpError(404, "Progress not found");
  const progress = await exclusivePathMutation(bookId, () =>
    new LearningService(store).renamePath(bookId, name),
  );
  return c.json({
    status: "ok",
    name: pathDisplayName(progress),
    path_revision: progress.version,
  });
});

masteryRouter.delete("/progress/:book_id", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const store = newStore();
  if (!store.exists(bookId)) throw new HttpError(404, "Progress not found");
  await exclusivePathMutation(bookId, () => store.delete(bookId));
  return c.json({ status: "ok" });
});

masteryRouter.post("/progress/:book_id/skip-question", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const store = newStore();
  if (!store.exists(bookId)) throw new HttpError(404, "Progress not found");
  const { progress, skipped } = await exclusivePathMutation(bookId, () =>
    new LearningService(store).abandonActiveQuestion(bookId),
  );
  return c.json({ status: "ok", skipped: Boolean(skipped), path_revision: progress.version });
});

masteryRouter.post("/progress/:book_id/redo", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const store = newStore();
  if (!store.exists(bookId)) throw new HttpError(404, "Progress not found");
  const progress = await exclusivePathMutation(bookId, () =>
    new LearningService(store).resetPath(bookId),
  );
  return c.json({ status: "ok", path_revision: progress.version });
});

// ---- generation --------------------------------------------------------------

masteryRouter.post("/progress/:book_id/generate-from-notebook", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const b = await body<Record<string, unknown>>(c);
  const records = Array.isArray(b["records"]) ? (b["records"] as Record<string, unknown>[]) : [];
  if (!records.length) throw new HttpError(400, "No records provided");
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const recordsData = records.slice(0, 20).map((r) => ({
    type: escapeHtml(String(r["type"] ?? "note").slice(0, 50)),
    title: escapeHtml(String(r["title"] ?? "").slice(0, 200)),
    output: escapeHtml(String(r["output"] ?? "").slice(0, 500)),
  }));
  const recordsJson = JSON.stringify(recordsData);
  const language = responseLanguage();
  const [systemPrompt, prompt] = notebookGenerationPrompts(language, recordsJson);
  let response: string;
  try {
    response = await completeText(settings(), { system: systemPrompt, prompt });
  } catch (e) {
    throw new HttpError(502, `LLM call failed: ${String(e)}`);
  }
  const data = parseJsonResponse(response);
  if (!isRecord(data)) throw new HttpError(502, "LLM returned invalid JSON");
  const modulesRaw = data["modules"];
  if (!Array.isArray(modulesRaw)) {
    throw new HttpError(502, "LLM returned invalid structure: modules is not a list");
  }
  const modules: LearningModule[] = [];
  const ALLOWED = new Set(["memory", "concept", "procedure", "design"]);
  modulesRaw.forEach((m, i) => {
    if (!isRecord(m) || !("name" in m)) return;
    const fallbackName = defaultModuleName(language, i + 1);
    const moduleName = String(m["name"] ?? "").trim().slice(0, 200) || fallbackName;
    const kps: KnowledgePoint[] = [];
    const rawKps = Array.isArray(m["knowledge_points"]) ? (m["knowledge_points"] as Record<string, unknown>[]) : [];
    rawKps.forEach((kp, j) => {
      if (!isRecord(kp) || !("name" in kp)) return;
      const kpName = String(kp["name"]).trim().slice(0, 200);
      if (kpName.length < 2) return;
      let kpType = String(kp["type"] ?? "concept").trim();
      if (!ALLOWED.has(kpType)) kpType = "concept";
      kps.push(
        normalizeKnowledgePoint(
          {
            id: `${bookId}_nb${i}_kp${j}`,
            name: kpName,
            type: normalizeKnowledgeType(kpType),
            module_id: `${bookId}_nb${i}`,
          },
          `${bookId}_nb${i}`,
        ),
      );
    });
    modules.push(
      normalizeModule(
        {
          id: `${bookId}_nb${i}`,
          name: moduleName,
          order: i,
          pass_threshold: 0.7,
          knowledge_points: kps,
        },
        i,
      ),
    );
  });
  try {
    validateRunnableModules(modules, 502);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw e;
  }
  const progress = await exclusivePathMutation(bookId, () =>
    newService().replaceModulesForPath(bookId, modules),
  );
  return c.json({
    status: "ok",
    module_count: modules.length,
    modules: modules.map((m) => ({ ...m })),
    path_revision: progress.version,
  });
});

masteryRouter.post("/progress/:book_id/generate-from-reading", async (c) => {
  const bookId = param(c, "book_id");
  validateBookId(bookId);
  const b = await body<Record<string, unknown>>(c);
  const workspaceId = String(b["workspace_id"] ?? "").trim();
  const materialIds = Array.isArray(b["material_ids"])
    ? (b["material_ids"] as unknown[]).map((s) => String(s)).slice(0, 20)
    : [];
  // TODO(port): upstream mastery_source_records(workspace_id, material_ids)
  // collects reading captures from the private reading workspace. backend-ts
  // has no reading-workspace capture pipeline yet; emit records from the
  // reading-progress store so the same generation path still works.
  const records = readingRecordsAsNotebook(settings(), workspaceId, materialIds);
  const notebookBody = {
    notebook_id: `reading:${workspaceId}`,
    records,
  };
  // Delegate to the notebook handler logic inline (same request shape).
  const bodyForNotebook = notebookBody;
  const recs = bodyForNotebook.records as Record<string, unknown>[];
  if (!recs.length) throw new HttpError(400, "No records provided");
  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const recordsData = recs.slice(0, 20).map((r) => ({
    type: escapeHtml(String(r["type"] ?? "note").slice(0, 50)),
    title: escapeHtml(String(r["title"] ?? "").slice(0, 200)),
    output: escapeHtml(String(r["output"] ?? "").slice(0, 500)),
  }));
  const recordsJson = JSON.stringify(recordsData);
  const language = responseLanguage();
  const [systemPrompt, prompt] = notebookGenerationPrompts(language, recordsJson);
  let response: string;
  try {
    response = await completeText(settings(), { system: systemPrompt, prompt });
  } catch (e) {
    throw new HttpError(502, `LLM call failed: ${String(e)}`);
  }
  const data = parseJsonResponse(response);
  if (!isRecord(data)) throw new HttpError(502, "LLM returned invalid JSON");
  const modulesRaw = data["modules"];
  if (!Array.isArray(modulesRaw)) {
    throw new HttpError(502, "LLM returned invalid structure: modules is not a list");
  }
  const ALLOWED = new Set(["memory", "concept", "procedure", "design"]);
  const modules: LearningModule[] = [];
  modulesRaw.forEach((m, i) => {
    if (!isRecord(m) || !("name" in m)) return;
    const fallbackName = defaultModuleName(language, i + 1);
    const moduleName = String(m["name"] ?? "").trim().slice(0, 200) || fallbackName;
    const kps: KnowledgePoint[] = [];
    const rawKps = Array.isArray(m["knowledge_points"]) ? (m["knowledge_points"] as Record<string, unknown>[]) : [];
    rawKps.forEach((kp, j) => {
      if (!isRecord(kp) || !("name" in kp)) return;
      const kpName = String(kp["name"]).trim().slice(0, 200);
      if (kpName.length < 2) return;
      let kpType = String(kp["type"] ?? "concept").trim();
      if (!ALLOWED.has(kpType)) kpType = "concept";
      kps.push(
        normalizeKnowledgePoint(
          { id: `${bookId}_nb${i}_kp${j}`, name: kpName, type: normalizeKnowledgeType(kpType), module_id: `${bookId}_nb${i}` },
          `${bookId}_nb${i}`,
        ),
      );
    });
    modules.push(
      normalizeModule(
        { id: `${bookId}_nb${i}`, name: moduleName, order: i, pass_threshold: 0.7, knowledge_points: kps },
        i,
      ),
    );
  });
  validateRunnableModules(modules, 502);
  const progress = await exclusivePathMutation(bookId, () =>
    newService().replaceModulesForPath(bookId, modules),
  );
  return c.json({
    status: "ok",
    module_count: modules.length,
    modules: modules.map((m) => ({ ...m })),
    path_revision: progress.version,
  });
});

function readingRecordsAsNotebook(
  _settings: Settings,
  _workspaceId: string,
  materialIds: string[],
): Record<string, unknown>[] {
  // TODO(port): no reading-workspace capture store in backend-ts yet; return
  // empty so the endpoint fails with the upstream "No records provided" 400
  // instead of fabricating content. Wire reading captures here when they land.
  void _workspaceId;
  void materialIds;
  return [];
}

// ---- WebSocket helper ---------------------------------------------------------
// Upstream exposes ``ws://…/api/mastery-paths`` for durable topic_event replay.
// backend-ts's Hono server (@hono/node-server) has no built-in WS upgrade, but
// the ``ws`` package is already a dependency. Call
// ``attachMasteryWebSocket(server, { settings })`` from main.ts (or a small
// bootstrap) with the http.Server to enable it — it cannot be wired from a
// router file alone.

export interface MasteryWsServer {
  on(event: "upgrade", listener: (req: unknown, socket: unknown, head: unknown) => void): unknown;
}

export function attachMasteryWebSocket(server: unknown, opts?: { settings?: Settings }): void {
  // Lazy import keeps ``ws`` optional at module load for tests.
  void import("ws").then(({ WebSocketServer }) => {
    const wss = new WebSocketServer({ noServer: true });
    const s = server as {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    s.on("upgrade", (req: unknown, socket: unknown, head: unknown) => {
      const r = req as { url?: string };
      const url = String(r.url ?? "");
      if (
        !url.startsWith("/api/mastery-paths") &&
        !url.startsWith("/mastery-paths") &&
        !url.startsWith("/ws/mastery-paths")
      ) return;
      wss.handleUpgrade(req as never, socket as never, head as never, (ws) => {
        wss.emit("connection", ws, req);
      });
    });
    wss.on("connection", (ws: import("ws").WebSocket) => {
      handleMasteryWebSocket(ws, opts);
    });
  });
}

/**
 * Handle one upgraded ``/ws/mastery-paths`` (or ``/api/mastery-paths`` /
 * ``/mastery-paths``) WebSocket: subscribe → replay durable topic_events.
 * Exported so the shared upgrade dispatcher (ws_dispatch.ts) can mount it
 * without registering a second 'upgrade' listener.
 */
export function handleMasteryWebSocket(
  ws: import("ws").WebSocket,
  opts?: { settings?: Settings },
): void {
  let subscription: TopicSubscription | null = null;
  let forwardRunning = false;
  let cursor = 0;
  const send = (payload: Record<string, unknown>) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* closed */
    }
  };
  const stopForwarding = () => {
    subscription?.close();
    subscription = null;
  };
  ws.on("message", (raw) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      send({ type: "error", content: "Expected a subscribe message" });
      return;
    }
    if (String(message["type"] ?? "") !== "subscribe") {
      send({ type: "error", content: "Expected a subscribe message" });
      return;
    }
    const pathId = String(message["path_id"] ?? "").trim();
    try {
      validateBookId(pathId);
    } catch {
      send({ type: "error", content: "Invalid path_id" });
      return;
    }
    const store = opts?.settings ? new LearningStore(opts.settings) : newStore();
    if (!store.exists(pathId)) {
      send({ type: "error", content: "Mastery topic not found" });
      return;
    }
    stopForwarding();
    const requested = Math.max(0, Number(message["after_revision"] ?? 0) || 0);
    const progress = store.load(pathId);
    const currentRevision = progress ? progress.version : 0;
    cursor = Math.min(requested, currentRevision);
    subscription = masteryTopicEventHub.subscribe(pathId, store.eventScope);
    const events = store.listEvents(pathId, cursor);
    if (events.length) {
      cursor = Math.max(cursor, ...events.map((e) => e.revision));
    }
    cursor = Math.max(cursor, currentRevision);
    send({
      type: "subscribed",
      path_id: pathId,
      revision: cursor,
      events,
    });
    if (!forwardRunning) {
      forwardRunning = true;
      void (async () => {
        try {
          while (subscription) {
            const signal = await subscription.get();
            const tail = store.listEvents(pathId, cursor);
            if (tail.length) {
              cursor = Math.max(cursor, ...tail.map((e) => e.revision));
            } else if (signal.revision <= cursor && !["session.bound", "session.released", "topic.deleted"].includes(signal.reason)) {
              continue;
            }
            cursor = Math.max(cursor, signal.revision);
            send({
              type: "topic_event",
              path_id: pathId,
              revision: cursor,
              reason: signal.reason,
              sequence: signal.sequence,
              events: tail,
            });
          }
        } catch {
          /* closed */
        } finally {
          forwardRunning = false;
        }
      })();
    }
  });
  ws.on("close", () => stopForwarding());
}

// Silence unused-import lint for helpers kept for parity/future use.
void normalizeModule;
void normalizeKnowledgePoint;
void normalizeKnowledgeType;
void publicPendingQuestion;
void MAX_PATH_NAME_LEN;
void MAX_PROFILE_FIELD_LEN;
void findKnowledgePoint;
void objectiveStatus;
void dueReviews;
void displayMastery;
void isMastered;
void isChinese;
void moduleLimitFor;
void DEFAULT_MODULE_LIMIT;
void topicCards;
void findTopic;
void nextStepPayload;
void ACTIVE_INTERACTION_STATES;
void LearningConflictError;
