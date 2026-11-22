export type KnowledgeEngineGroup = "local" | "cloud";

/** The only retrieval engines still shipped with Praxis. */
export const SUPPORTED_KNOWLEDGE_ENGINE_IDS = new Set(["llamaindex", "ima"]);

export const isSupportedKnowledgeEngine = (id: string): boolean =>
  SUPPORTED_KNOWLEDGE_ENGINE_IDS.has(id);

const CLOUD_ENGINE_IDS = new Set(["ima"]);
const LOCAL_ENGINE_IDS = new Set(["llamaindex"]);

/**
 * Keep the Knowledge Center grouping stable for the built-in engines while
 * still giving future providers a sensible home.
 */
export function knowledgeEngineGroup(provider: {
  id: string;
  requires_api_key?: boolean;
}): KnowledgeEngineGroup {
  if (CLOUD_ENGINE_IDS.has(provider.id)) return "cloud";
  if (LOCAL_ENGINE_IDS.has(provider.id)) return "local";
  return provider.requires_api_key ? "cloud" : "local";
}
