// Port of deeptutor/learning/objective_relations.py.
import {
  KnowledgePoint,
  LearningModule,
  TopicSource,
  TopicSourceKind,
} from "./models.js";

export class ObjectiveRelationError extends Error {}

export interface RelationRefs {
  client_ref: string;
  prerequisite_refs: string[];
  topic_source_refs: string[];
}

export function normalizeRefs(values: unknown, _label = ""): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const value of Array.isArray(values) ? values : []) {
    const ref = String(value ?? "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

export function sourceRefMap(
  sources: TopicSource[],
  aliases?: Record<string, string> | null,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const source of sources) {
    if (source.kind === "goal") continue;
    if (source.id in resolved) {
      throw new ObjectiveRelationError(`Duplicate topic source id ${source.id}`);
    }
    resolved[source.id] = source.id;
  }
  for (const [aliasRaw, sourceId] of Object.entries(aliases ?? {})) {
    const alias = String(aliasRaw ?? "").trim();
    if (!alias) continue;
    if (!(sourceId in resolved)) {
      throw new ObjectiveRelationError(
        `Source alias ${alias} names unknown source ${sourceId}`,
      );
    }
    if (alias in resolved && resolved[alias] !== sourceId) {
      throw new ObjectiveRelationError(`Source reference ${alias} is ambiguous`);
    }
    resolved[alias] = sourceId;
  }
  return resolved;
}

function knowledgePoints(modules: LearningModule[]): KnowledgePoint[] {
  return modules.flatMap((m) => m.knowledge_points ?? []);
}

export function validateObjectiveRelations(
  modules: LearningModule[],
  sources: TopicSource[],
): void {
  const points = knowledgePoints(modules);
  const pointIds = new Set(points.map((p) => p.id));
  if (pointIds.size !== points.length) {
    throw new ObjectiveRelationError(
      "Knowledge point ids must be unique within a mastery path",
    );
  }
  const sourceIds = new Set(
    sources.filter((s) => s.kind !== "goal").map((s) => s.id),
  );
  const names = new Map(points.map((p) => [p.id, p.name]));
  const graph = new Map<string, string[]>();

  for (const point of points) {
    const prerequisites = normalizeRefs(point.prerequisite_ids, "prerequisite");
    point.prerequisite_ids = prerequisites;
    graph.set(point.id, prerequisites);
    const topicSources = normalizeRefs(point.topic_source_ids, "topic source");
    point.topic_source_ids = topicSources;
    const unknownSources = topicSources.filter((ref) => !sourceIds.has(ref));
    if (unknownSources.length) {
      throw new ObjectiveRelationError(
        `Objective ${names.get(point.id)} references unknown or goal topic source ${unknownSources[0]}`,
      );
    }
  }

  for (const [pointId, prerequisites] of graph) {
    for (const prerequisite of prerequisites) {
      if (prerequisite === pointId) {
        throw new ObjectiveRelationError(
          `Objective ${names.get(pointId)} cannot be its own prerequisite`,
        );
      }
      if (!graph.has(prerequisite)) {
        throw new ObjectiveRelationError(
          `Objective ${names.get(pointId)} has unknown prerequisite ${prerequisite}`,
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (pointId: string): void => {
    if (visited.has(pointId)) return;
    if (visiting.has(pointId)) {
      const cycleStart = path.indexOf(pointId);
      const cycle = [...path.slice(cycleStart), pointId];
      throw new ObjectiveRelationError("Prerequisite cycle: " + cycle.join(" -> "));
    }
    visiting.add(pointId);
    path.push(pointId);
    for (const prerequisite of graph.get(pointId) ?? []) visit(prerequisite);
    path.pop();
    visiting.delete(pointId);
    visited.add(pointId);
  };
  for (const pointId of graph.keys()) visit(pointId);
}

export function resolveRelationRefs(
  modules: LearningModule[],
  relationRefs: Record<string, RelationRefs>,
  opts: {
    prerequisite_aliases: Record<string, string>;
    source_aliases?: Record<string, string> | null;
    sources: TopicSource[];
  },
): void {
  const sourceIds = sourceRefMap(opts.sources, opts.source_aliases);
  for (const module of modules) {
    for (const point of module.knowledge_points ?? []) {
      const refs = relationRefs[point.id];
      if (!refs) continue;
      const prerequisites: string[] = [];
      const seenPrerequisites = new Set<string>();
      for (const ref of normalizeRefs(refs.prerequisite_refs, "prerequisite")) {
        if (!(ref in opts.prerequisite_aliases)) {
          throw new ObjectiveRelationError(
            `Objective ${point.name} has unknown prerequisite ref ${ref}`,
          );
        }
        const resolved = opts.prerequisite_aliases[ref];
        if (!seenPrerequisites.has(resolved)) {
          seenPrerequisites.add(resolved);
          prerequisites.push(resolved);
        }
      }
      point.prerequisite_ids = prerequisites;

      const topicSources: string[] = [];
      const seenSources = new Set<string>();
      for (const ref of normalizeRefs(refs.topic_source_refs, "topic source")) {
        if (!(ref in sourceIds)) {
          throw new ObjectiveRelationError(
            `Objective ${point.name} has unknown topic source ref ${ref}`,
          );
        }
        const resolved = sourceIds[ref];
        if (!seenSources.has(resolved)) {
          seenSources.add(resolved);
          topicSources.push(resolved);
        }
      }
      point.topic_source_ids = topicSources;
    }
  }
}

// Re-export for typing parity.
export type { TopicSourceKind };
