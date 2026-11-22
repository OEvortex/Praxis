// Port of the LearningService subset the mastery REST surface needs:
// get_or_create, create_topic, replace_modules_for_path, rename_path,
// reset_path, abandon_active_question, set_learner_mastery_override,
// list_progress — plus the identity/relation plumbing they share.
import { randomBytes } from "node:crypto";

import {
  KnowledgePoint,
  KnowledgeType,
  LearningModule,
  LearningProgress,
  QuizAttempt,
  TopicMetadata,
  TopicSource,
  compute_mastery,
  learnerProfileIsEmpty,
  normalizeModule,
  normalizeProgress,
} from "./models.js";
import {
  ObjectiveRelationError,
  RelationRefs,
  resolveRelationRefs,
  validateObjectiveRelations,
} from "./objective_relations.js";
import { findKnowledgePoint, pathDisplayName } from "./policy.js";
import { schedulerForProgress } from "./review_strategy.js";
import { LearningStore, LearningTransaction } from "./store.js";

export const MAX_PATH_NAME_LEN = 200;
export const MAX_PROFILE_FIELD_LEN = 600;
export const LEARNER_PROFILE_FIELDS = [
  "prior_knowledge",
  "target_level",
  "time_budget",
  "preferences",
  "teaching_strategy",
  "notes",
] as const;

export class MasteryInteractionError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ---- objective identity -----------------------------------------------------

function objectiveFingerprint(kp: KnowledgePoint): [string, string] {
  return [String(kp.name ?? "").trim().toLowerCase(), kp.type];
}

function uniqueFingerprintMap(points: KnowledgePoint[]): Map<string, KnowledgePoint> {
  const counts = new Map<string, number>();
  for (const kp of points) {
    const key = objectiveFingerprint(kp).join("");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const out = new Map<string, KnowledgePoint>();
  for (const kp of points) {
    const key = objectiveFingerprint(kp).join("");
    if (counts.get(key) === 1) out.set(key, kp);
  }
  return out;
}

function reservedObjectiveIds(progress: LearningProgress): Set<string> {
  const ids = new Set<string>();
  for (const m of progress.modules ?? []) {
    for (const kp of m.knowledge_points ?? []) ids.add(kp.id);
  }
  for (const key of [
    progress.mastery_levels,
    progress.knowledge_types,
    progress.qualitative_mastery,
    progress.repetition_states,
    progress.learner_mastery_overrides,
    progress.feynman_retries,
    progress.feynman_explanations,
    progress.deferred_objectives,
    progress.explained_objectives,
  ]) {
    for (const k of Object.keys(key ?? {})) ids.add(k);
  }
  for (const a of progress.quiz_attempts ?? []) ids.add(a.knowledge_point_id);
  for (const r of progress.error_records ?? []) ids.add(r.knowledge_point_id);
  for (const t of progress.review_queue ?? []) ids.add(t.knowledge_point_id);
  for (const e of progress.learning_evidence ?? []) ids.add(e.knowledge_point_id);
  ids.delete("");
  return ids;
}

function newObjectiveId(moduleId: string, reserved: Set<string>): string {
  const prefix = `${moduleId}_kp`;
  for (;;) {
    const candidate = `${prefix}_${randomBytes(8).toString("hex")}`;
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
}

export interface IdentityMap {
  mode: string;
  preserved: string[];
  minted: string[];
  dropped: string[];
}

export function assignObjectiveIdentities(
  progress: LearningProgress,
  modules: LearningModule[],
  identityMode = "explicit",
): IdentityMap {
  const mode = identityMode === "semantic" ? "semantic" : "explicit";
  const oldPoints = (progress.modules ?? []).flatMap((m) => m.knowledge_points ?? []);
  const oldById = new Map(oldPoints.map((kp) => [kp.id, kp]));
  const oldIds = new Set(oldById.keys());
  const reserved = reservedObjectiveIds(progress);
  const preserved: string[] = [];
  const minted: string[] = [];
  const usedOldIds = new Set<string>();

  const fpKey = (kp: KnowledgePoint) => objectiveFingerprint(kp).join("");

  if (mode === "semantic" && oldPoints.length) {
    const oldUnique = uniqueFingerprintMap(oldPoints);
    const newUnique = uniqueFingerprintMap(
      modules.flatMap((m) => m.knowledge_points ?? []),
    );
    for (const module of modules) {
      for (const kp of module.knowledge_points ?? []) {
        const fingerprint = fpKey(kp);
        let matched: KnowledgePoint | undefined;
        if (newUnique.has(fingerprint) && oldUnique.has(fingerprint)) {
          const candidate = oldUnique.get(fingerprint) as KnowledgePoint;
          if (!usedOldIds.has(candidate.id)) matched = candidate;
        }
        if (matched) {
          kp.id = matched.id;
          usedOldIds.add(matched.id);
          preserved.push(kp.id);
        } else if (!reserved.has(kp.id)) {
          reserved.add(kp.id);
          minted.push(kp.id);
        } else {
          kp.id = newObjectiveId(module.id, reserved);
          minted.push(kp.id);
        }
        kp.module_id = module.id;
      }
    }
  } else {
    for (const module of modules) {
      for (const kp of module.knowledge_points ?? []) {
        const old = oldById.get(kp.id);
        const same =
          old !== undefined &&
          objectiveFingerprint(old).join("") === fpKey(kp);
        if (same) {
          preserved.push(kp.id);
          reserved.add(kp.id);
        } else if (reserved.has(kp.id)) {
          kp.id = newObjectiveId(module.id, reserved);
          minted.push(kp.id);
        } else {
          reserved.add(kp.id);
          minted.push(kp.id);
        }
        kp.module_id = module.id;
      }
    }
  }
  const newIds = new Set(
    modules.flatMap((m) => (m.knowledge_points ?? []).map((kp) => kp.id)),
  );
  return {
    mode,
    preserved,
    minted,
    dropped: [...oldIds].filter((id) => !newIds.has(id)).sort(),
  };
}

// ---- module replacement -----------------------------------------------------

function resolveFinalRelations(
  applied: LearningModule[],
  submitted: LearningModule[],
  relationRefs: Record<string, RelationRefs>,
  sourceAliases: Record<string, string>,
  sources: TopicSource[],
  existingModules?: LearningModule[],
): void {
  const aliases: Record<string, string> = {};
  for (const module of existingModules ?? []) {
    for (const point of module.knowledge_points ?? []) aliases[point.id] = point.id;
  }
  const finalRefs: Record<string, RelationRefs> = {};
  for (let i = 0; i < submitted.length; i += 1) {
    const submittedModule = submitted[i];
    const finalModule = applied[i];
    const submittedKps = submittedModule.knowledge_points ?? [];
    const finalKps = finalModule.knowledge_points ?? [];
    for (let j = 0; j < submittedKps.length; j += 1) {
      const submittedPoint = submittedKps[j];
      const finalPoint = finalKps[j];
      if (!(submittedPoint.id in aliases)) aliases[submittedPoint.id] = finalPoint.id;
      aliases[finalPoint.id] = finalPoint.id;
      const specs = relationRefs[submittedPoint.id];
      if (specs) finalRefs[finalPoint.id] = specs;
    }
  }
  for (const [finalId, specs] of Object.entries(finalRefs)) {
    const alias = String(specs.client_ref ?? "").trim();
    if (!alias) continue;
    if (alias in aliases && aliases[alias] !== finalId) {
      throw new ObjectiveRelationError(`Objective reference ${alias} is ambiguous`);
    }
    aliases[alias] = finalId;
  }
  resolveRelationRefs(applied, finalRefs, {
    prerequisite_aliases: aliases,
    source_aliases: sourceAliases,
    sources,
  });
}

function replaceModules(progress: LearningProgress, modules: LearningModule[]): void {
  const newKpIds = new Set(
    modules.flatMap((m) => (m.knowledge_points ?? []).map((kp) => kp.id)),
  );
  const keep = <T>(rec: Record<string, T> | undefined): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec ?? {})) {
      if (newKpIds.has(k)) out[k] = v;
    }
    return out;
  };
  progress.mastery_levels = keep(progress.mastery_levels);
  progress.knowledge_types = keep(progress.knowledge_types) as Record<string, KnowledgeType>;
  progress.qualitative_mastery = keep(progress.qualitative_mastery);
  progress.repetition_states = keep(progress.repetition_states);
  progress.learner_mastery_overrides = keep(progress.learner_mastery_overrides);
  progress.deferred_objectives = keep(progress.deferred_objectives);
  progress.explained_objectives = keep(progress.explained_objectives);
  progress.error_records = (progress.error_records ?? []).filter((r) =>
    newKpIds.has(r.knowledge_point_id),
  );
  progress.quiz_attempts = (progress.quiz_attempts ?? []).filter((a) =>
    newKpIds.has(a.knowledge_point_id),
  );
  progress.learning_evidence = (progress.learning_evidence ?? []).filter((e) =>
    newKpIds.has(e.knowledge_point_id),
  );
  progress.feynman_retries = keep(progress.feynman_retries);
  progress.feynman_explanations = keep(progress.feynman_explanations) as Record<string, string>;
  progress.review_queue = (progress.review_queue ?? []).filter((t) =>
    newKpIds.has(t.knowledge_point_id),
  );
  progress.stage_failure_counts = {};
  progress.stage_failure_notes = {};
  progress.modules = modules.map((m) => normalizeModule(m, m.order ?? 0));
  for (const mod of progress.modules) {
    for (const kp of mod.knowledge_points ?? []) {
      progress.knowledge_types[kp.id] = kp.type;
    }
  }
}

interface ReplaceOpts {
  append?: boolean;
  name?: string;
  eventType?: string;
  sessionId?: string;
  turnId?: string;
  identityMode?: string;
  relationRefs?: Record<string, RelationRefs>;
  sourceAliases?: Record<string, string>;
  topicSources?: TopicSource[] | null;
  freshIdentity?: boolean;
}

interface ReplaceEffects {
  identityMap: IdentityMap;
  activeInteractionRemoved: boolean;
}

export class LearningService {
  constructor(public store: LearningStore) {}

  getOrCreate(bookId: string): LearningProgress {
    const { progress } = this.store.mutate(bookId, () => undefined, { create: true });
    return progress;
  }

  private _replaceModuleSet(tx: LearningTransaction, modules: LearningModule[], opts: ReplaceOpts = {}): ReplaceEffects {
    const append = Boolean(opts.append);
    const identityMode = opts.identityMode ?? "explicit";
    const relationRefs = opts.relationRefs ?? {};
    const sourceAliases = opts.sourceAliases ?? {};
    const bookId = tx.progress.book_id;
    const name = String(opts.name ?? "");
    if (name.trim() && !String(tx.progress.name ?? "").trim()) {
      tx.progress.name = name.trim().slice(0, MAX_PATH_NAME_LEN);
    }
    const appliedModules = modules.map((m) =>
      normalizeModule(JSON.parse(JSON.stringify(m)), m.order ?? 0),
    );
    let identityMap: IdentityMap = { mode: "explicit", preserved: [], minted: [], dropped: [] };
    let activeInteractionRemoved = false;

    if (append) {
      const reserved = reservedObjectiveIds(tx.progress);
      const offset = (tx.progress.modules ?? []).length;
      const minted: string[] = [];
      appliedModules.forEach((module, idx) => {
        module.id = `${bookId}_m${offset + idx}`;
        module.order = offset + idx;
        (module.knowledge_points ?? []).forEach((kp, kpIndex) => {
          kp.module_id = module.id;
          const candidate = `${module.id}_kp${kpIndex}`;
          if (reserved.has(candidate)) {
            kp.id = newObjectiveId(module.id, reserved);
          } else {
            kp.id = candidate;
            reserved.add(candidate);
          }
          tx.progress.knowledge_types[kp.id] = kp.type;
          minted.push(kp.id);
        });
      });
      identityMap = { mode: "append", preserved: [], minted, dropped: [] };
      const existingModules = tx.progress.modules ?? [];
      const sources = opts.topicSources ?? tx.topicSources();
      resolveFinalRelations(
        appliedModules,
        modules,
        relationRefs,
        sourceAliases,
        sources,
        existingModules,
      );
      validateObjectiveRelations([...existingModules, ...appliedModules], sources);
      tx.progress.modules = [...existingModules, ...appliedModules];
      if (!tx.progress.current_module_id && appliedModules.length) {
        tx.progress.current_module_id = appliedModules[0].id;
        tx.progress.current_kp_index = 0;
      }
    } else {
      let currentKpId = "";
      for (const currentModule of tx.progress.modules ?? []) {
        if (currentModule.id !== tx.progress.current_module_id) continue;
        const idx = tx.progress.current_kp_index ?? 0;
        if (idx >= 0 && idx < (currentModule.knowledge_points ?? []).length) {
          currentKpId = currentModule.knowledge_points[idx].id;
        }
        break;
      }
      const pending = tx.progress.pending_question;
      const pendingKpId = pending?.knowledge_point_id ?? "";
      const pendingLeaves = pending?.questions?.length ? pending.questions : pending ? [pending] : [];
      const activeInteraction = tx.activeInteraction();
      const activeLeaves = activeInteraction
        ? activeInteraction.question.questions?.length
          ? activeInteraction.question.questions
          : [activeInteraction.question]
        : [];
      const activeKpId = activeInteraction?.question.knowledge_point_id ?? "";

      if (opts.freshIdentity) {
        const reserved = reservedObjectiveIds(tx.progress);
        for (const module of appliedModules) {
          for (const kp of module.knowledge_points ?? []) {
            kp.id = newObjectiveId(module.id, reserved);
            kp.module_id = module.id;
          }
        }
        identityMap = {
          mode: "fresh",
          preserved: [],
          minted: appliedModules.flatMap((m) => (m.knowledge_points ?? []).map((kp) => kp.id)),
          dropped: [
            ...new Set(
              (tx.progress.modules ?? []).flatMap((m) =>
                (m.knowledge_points ?? []).map((kp) => kp.id),
              ),
            ),
          ].sort(),
        };
      } else {
        identityMap = assignObjectiveIdentities(tx.progress, appliedModules, identityMode);
      }
      const sources = opts.topicSources ?? tx.topicSources();
      resolveFinalRelations(appliedModules, modules, relationRefs, sourceAliases, sources);
      validateObjectiveRelations(appliedModules, sources);
      replaceModules(tx.progress, appliedModules);
      const objectiveLocations = new Map<string, [string, number]>();
      for (const module of appliedModules) {
        (module.knowledge_points ?? []).forEach((kp, i) => {
          objectiveLocations.set(kp.id, [module.id, i]);
        });
      }
      if (currentKpId && objectiveLocations.has(currentKpId)) {
        const [mid, idx] = objectiveLocations.get(currentKpId) as [string, number];
        tx.progress.current_module_id = mid;
        tx.progress.current_kp_index = idx;
      } else if (appliedModules.length) {
        tx.progress.current_module_id = appliedModules[0].id;
        tx.progress.current_kp_index = 0;
      } else {
        tx.progress.current_module_id = "";
        tx.progress.current_kp_index = 0;
      }
      if (pending) {
        const leavesMissing =
          !objectiveLocations.has(pendingKpId) ||
          pendingLeaves.some((q) => !objectiveLocations.has(q.knowledge_point_id));
        if (leavesMissing) {
          tx.progress.pending_question = null;
        } else {
          const [mid] = objectiveLocations.get(pendingKpId) as [string, number];
          pending.module_id = mid;
          for (const q of pendingLeaves) {
            const [qid] = objectiveLocations.get(q.knowledge_point_id) as [string, number];
            q.module_id = qid;
          }
        }
      }
      if (activeInteraction) {
        const leavesMissing =
          !objectiveLocations.has(activeKpId) ||
          activeLeaves.some((q) => !objectiveLocations.has(q.knowledge_point_id));
        if (leavesMissing) {
          activeInteractionRemoved = true;
          tx.abandonActiveInteractions();
        } else {
          const [mid] = objectiveLocations.get(activeKpId) as [string, number];
          const changed =
            activeInteraction.question.module_id !== mid ||
            activeLeaves.some(
              (q) =>
                q.module_id !==
                (objectiveLocations.get(q.knowledge_point_id) as [string, number])[0],
            );
          activeInteraction.question.module_id = mid;
          for (const q of activeLeaves) {
            q.module_id = (objectiveLocations.get(q.knowledge_point_id) as [string, number])[0];
          }
          if (changed) tx.putInteraction(activeInteraction);
        }
      }
    }
    tx.touch();
    tx.emit(
      opts.eventType ?? "path.modules_replaced",
      {
        mode: append ? "append" : "replace",
        identity_map: identityMap,
        module_count: appliedModules.length,
        knowledge_point_count: appliedModules.reduce(
          (n, m) => n + (m.knowledge_points ?? []).length,
          0,
        ),
      },
      opts.sessionId ?? "",
      opts.turnId ?? "",
    );
    return { identityMap, activeInteractionRemoved };
  }

  replaceModulesForPath(
    bookId: string,
    modules: LearningModule[],
    opts: ReplaceOpts = {},
  ): LearningProgress {
    const { progress } = this.store.mutate(
      bookId,
      (tx) => this._replaceModuleSet(tx, modules, opts),
      { create: true },
    );
    return progress;
  }

  createTopic(
    bookId: string,
    args: {
      name: string;
      modules: LearningModule[];
      metadata: TopicMetadata;
      sources: TopicSource[];
      relationRefs?: Record<string, RelationRefs>;
      sourceAliases?: Record<string, string>;
    },
  ): LearningProgress {
    if (this.store.exists(bookId)) {
      throw new Error(`Mastery topic ${bookId} already exists`);
    }
    const { progress } = this.store.mutate(
      bookId,
      (tx) => {
        tx.progress.name = String(args.name ?? "").trim().slice(0, MAX_PATH_NAME_LEN);
        tx.putTopic(args.metadata, args.sources);
        const appliedModules = args.modules.map((m) =>
          normalizeModule(JSON.parse(JSON.stringify(m)), m.order ?? 0),
        );
        resolveFinalRelations(
          appliedModules,
          args.modules,
          args.relationRefs ?? {},
          args.sourceAliases ?? {},
          args.sources,
        );
        validateObjectiveRelations(appliedModules, args.sources);
        replaceModules(tx.progress, appliedModules);
        tx.progress.current_module_id = appliedModules.length ? appliedModules[0].id : "";
        tx.progress.current_kp_index = 0;
        tx.touch();
        tx.emit("topic.created", {
          module_count: args.modules.length,
          knowledge_point_count: args.modules.reduce(
            (n, m) => n + (m.knowledge_points ?? []).length,
            0,
          ),
          source_count: args.sources.length,
        });
      },
      { create: true },
    );
    return progress;
  }

  renamePath(bookId: string, name: string): LearningProgress {
    const cleaned = String(name ?? "").trim().slice(0, MAX_PATH_NAME_LEN);
    const { progress } = this.store.mutate(bookId, (tx) => {
      if (tx.progress.name === cleaned) return;
      tx.progress.name = cleaned;
      tx.touch();
      tx.emit("path.renamed", { name: cleaned });
    });
    return progress;
  }

  abandonActiveQuestion(bookId: string): { progress: LearningProgress; skipped: boolean } {
    const { progress, result } = this.store.mutate(bookId, (tx) => {
      const interaction = tx.activeInteraction();
      let abandoned = tx.abandonActiveInteractions() > 0;
      if (tx.progress.pending_question !== null && tx.progress.pending_question !== undefined) {
        tx.progress.pending_question = null;
        abandoned = true;
      }
      if (!abandoned) return false;
      tx.touch();
      tx.emit("interaction.abandoned", {
        interaction_id: interaction?.interaction_id ?? "",
      });
      return true;
    });
    return { progress, skipped: Boolean(result) };
  }

  resetPath(bookId: string): LearningProgress {
    const { progress } = this.store.mutate(bookId, (tx) => {
      const p = tx.progress;
      p.current_stage = "diagnostic";
      p.mastery_levels = {};
      p.qualitative_mastery = {};
      p.quiz_attempts = [];
      p.error_records = [];
      p.learning_evidence = [];
      p.repetition_states = {};
      p.review_queue = [];
      p.learner_mastery_overrides = {};
      p.deferred_objectives = {};
      p.explained_objectives = {};
      p.pending_question = null;
      p.feynman_retries = {};
      p.feynman_explanations = {};
      p.stage_failure_counts = {};
      p.stage_failure_notes = {};
      p.diagnostic = null;
      p.current_kp_index = 0;
      p.current_module_id = p.modules?.length ? p.modules[0].id : "";
      tx.abandonActiveInteractions();
      tx.touch();
      tx.emit("path.reset", {});
    });
    return progress;
  }

  setLearnerMasteryOverride(
    bookId: string,
    kpId: string,
    args: { mastered: boolean; note?: string },
  ): LearningProgress {
    const { progress } = this.store.mutate(bookId, (tx) => {
      const { kp } = findKnowledgePoint(tx.progress, kpId);
      if (!kp) {
        throw new MasteryInteractionError(`Unknown objective ${kpId}`);
      }
      if (args.mastered) {
        tx.progress.learner_mastery_overrides = {
          ...(tx.progress.learner_mastery_overrides ?? {}),
          [kpId]: {
            knowledge_point_id: kpId,
            note: String(args.note ?? "").trim().slice(0, 500),
            created_at: Date.now() / 1000,
          },
        };
        if (tx.progress.deferred_objectives) delete tx.progress.deferred_objectives[kpId];
        tx.touch();
        tx.emit("mastery.overridden", {
          knowledge_point_id: kpId,
          mastered: true,
        });
      } else {
        const overrides = tx.progress.learner_mastery_overrides ?? {};
        if (!(kpId in overrides)) return;
        delete overrides[kpId];
        tx.progress.learner_mastery_overrides = overrides;
        tx.touch();
        tx.emit("mastery.override_cleared", {
          knowledge_point_id: kpId,
          mastered: false,
        });
      }
    });
    return progress;
  }

  listProgress(): { summaries: Record<string, unknown>[]; errors: Record<string, unknown>[] } {
    const summaries: Record<string, unknown>[] = [];
    const errors: Record<string, unknown>[] = [];
    for (const bid of this.store.listAll()) {
      try {
        const progress = this.store.load(bid);
        if (!progress) continue;
        const currentKpIds = new Set(
          (progress.modules ?? []).flatMap((m) =>
            (m.knowledge_points ?? []).map((kp) => kp.id),
          ),
        );
        const totalKps = currentKpIds.size;
        const totalMastery = [...currentKpIds].reduce(
          (sum, id) => sum + (progress.mastery_levels?.[id] ?? 0),
          0,
        );
        summaries.push({
          book_id: progress.book_id,
          name: pathDisplayName(progress),
          modules_count: (progress.modules ?? []).length,
          kp_count: totalKps,
          current_stage: progress.current_stage ?? "",
          avg_mastery_pct: totalKps ? Math.round((totalMastery / totalKps) * 100) : 0,
          updated_at: progress.updated_at,
        });
      } catch {
        errors.push({ book_id: bid, error: "Failed to load" });
      }
    }
    return { summaries, errors };
  }
}

// Re-exported for the API layer's payload builders.
export { compute_mastery, learnerProfileIsEmpty, schedulerForProgress };
export type { QuizAttempt };
