import { apiFetch } from "@/shared/api/client";
import { withClientCache } from "@/lib/client-cache";
import {
  apiUrl,
  getEngineConfig,
  invalidateKnowledgeCaches,
  KNOWLEDGE_CACHE_PREFIX,
  readErrorDetail,
  updateEngineConfig,
} from "./http";
import type {
  EmbeddingUsage,
  EnginePreflight,
  GraphRagConfig,
  GraphRagModelCompatibility,
  ImaAccountConfig,
  LightRagConfig,
  LightRagServerConfig,
  LlamaIndexConfig,
  ModelKindOptions,
  ModelOptionsByKind,
  PageIndexConfig,
  RagProviderSummary,
} from "./types";
export type {
  EnginePreflight,
  GraphRagConfig,
  GraphRagModelCompatibility,
  ImaAccountConfig,
  LightRagConfig,
  LightRagServerConfig,
  LlamaIndexConfig,
  ModelKindOptions,
  ModelOptionsByKind,
  PageIndexConfig,
  RagProviderSummary,
} from "./types";
export {
  connectLightRagServer,
  probeLightRagServer,
  type LightRagServerProbe,
} from "./connectors";

export async function getEmbeddingUsage(): Promise<EmbeddingUsage[]> {
  const res = await apiFetch(apiUrl("/api/knowledge-bases/embedding-usage"), {
    cache: "no-store",
  });
  if (!res.ok)
    throw new Error(
      await readErrorDetail(res, "Failed to load embedding model usage"),
    );
  return (await res.json()).knowledge_bases;
}

export async function listRagProviders(options?: { force?: boolean }) {
  return withClientCache<RagProviderSummary[]>(
    `${KNOWLEDGE_CACHE_PREFIX}providers`,
    async () => {
      const response = await apiFetch(
        apiUrl("/api/knowledge-bases/rag-providers"),
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to list RAG providers"),
        );
      }
      const data = await response.json();
      return Array.isArray(data?.providers) ? data.providers : [];
    },
    {
      force: options?.force,
    },
  );
}

const PAGEINDEX_CONFIG_PATH =
  "/api/knowledge-bases/rag-pipelines/pageindex/config";

export async function getPageIndexConfig(options?: {
  force?: boolean;
}): Promise<PageIndexConfig> {
  return withClientCache<PageIndexConfig>(
    `${KNOWLEDGE_CACHE_PREFIX}pageindex-config`,
    async () => {
      const response = await apiFetch(apiUrl(PAGEINDEX_CONFIG_PATH), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to read PageIndex config"),
        );
      }
      return (await response.json()) as PageIndexConfig;
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

export async function updatePageIndexConfig(payload: {
  /** Omit to keep the stored key, "" to clear it, any value to replace it. */
  api_key?: string;
}): Promise<PageIndexConfig> {
  const res = await apiFetch(apiUrl(PAGEINDEX_CONFIG_PATH), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to update PageIndex config"),
    );
  }
  // The provider list's `configured` flag depends on this; refresh it.
  invalidateKnowledgeCaches();
  return (await res.json()) as PageIndexConfig;
}

const IMA_CONFIG_PATH = "/api/knowledge-bases/rag-pipelines/ima/config";

export async function getImaConfig(options?: {
  force?: boolean;
}): Promise<ImaAccountConfig> {
  return withClientCache<ImaAccountConfig>(
    `${KNOWLEDGE_CACHE_PREFIX}ima-config`,
    async () => {
      const response = await apiFetch(apiUrl(IMA_CONFIG_PATH), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to read Tencent IMA config"),
        );
      }
      return (await response.json()) as ImaAccountConfig;
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

export async function updateImaConfig(payload: {
  client_id?: string;
  /** Omit to keep the stored key, "" to clear it, any value to replace it. */
  api_key?: string;
}): Promise<ImaAccountConfig> {
  const res = await apiFetch(apiUrl(IMA_CONFIG_PATH), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to update Tencent IMA config"),
    );
  }
  // The provider list's `configured` flag depends on this; refresh it.
  invalidateKnowledgeCaches();
  return (await res.json()) as ImaAccountConfig;
}

const LLAMAINDEX_CONFIG_PATH =
  "/api/knowledge-bases/rag-pipelines/llamaindex/config";

export async function getLlamaIndexConfig(options?: {
  force?: boolean;
}): Promise<LlamaIndexConfig> {
  return withClientCache<LlamaIndexConfig>(
    `${KNOWLEDGE_CACHE_PREFIX}llamaindex-config`,
    async () => {
      const response = await apiFetch(apiUrl(LLAMAINDEX_CONFIG_PATH), {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to read LlamaIndex config"),
        );
      }
      return (await response.json()) as LlamaIndexConfig;
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

export async function updateLlamaIndexConfig(
  payload: Partial<Omit<LlamaIndexConfig, "version">>,
): Promise<LlamaIndexConfig> {
  const res = await apiFetch(apiUrl(LLAMAINDEX_CONFIG_PATH), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to update LlamaIndex config"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as LlamaIndexConfig;
}

export const getGraphRagConfig = (options?: { force?: boolean }) =>
  getEngineConfig<GraphRagConfig>("graphrag", "graphrag-config", options);
export const updateGraphRagConfig = (
  payload: Partial<Omit<GraphRagConfig, "version">>,
) => updateEngineConfig<GraphRagConfig>("graphrag", payload);

export async function getLightRagModelOptions(): Promise<
  import("@/lib/llm-options").LLMOptionsResponse
> {
  const res = await apiFetch(
    apiUrl("/api/knowledge-bases/rag-pipelines/lightrag/model-options"),
    {
      cache: "no-store",
    },
  );
  if (!res.ok)
    throw new Error(
      await readErrorDetail(res, "Failed to load LightRAG models"),
    );
  return res.json();
}

export const getLightRagConfig = (options?: { force?: boolean }) =>
  getEngineConfig<LightRagConfig>("lightrag", "lightrag-config", options);
export const updateLightRagConfig = (
  payload: Partial<Omit<LightRagConfig, "version">>,
) => updateEngineConfig<LightRagConfig>("lightrag", payload);

export const getLightRagServerConfig = (options?: { force?: boolean }) =>
  getEngineConfig<LightRagServerConfig>(
    "lightrag-server",
    "lightrag-server-config",
    options,
  );

export const updateLightRagServerConfig = (payload: {
  server_url?: string;
  /** Omit to keep the stored key; empty clears it. */
  api_key?: string;
}) => updateEngineConfig<LightRagServerConfig>("lightrag-server", payload);

export async function getEnginePreflight(
  provider: string,
): Promise<EnginePreflight> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/rag-pipelines/${provider}/preflight`),
    {
      cache: "no-store",
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to check environment"));
  }
  return (await res.json()) as EnginePreflight;
}

export async function getEngineModelOptions(
  kinds: string[],
): Promise<ModelOptionsByKind> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/rag-pipelines/model-options?kinds=${encodeURIComponent(kinds.join(","))}`,
    ),
    { cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to read model options"));
  }
  return (await res.json()) as ModelOptionsByKind;
}

export async function testGraphRagModelCompatibility(
  profileId: string,
  modelId: string,
): Promise<GraphRagModelCompatibility> {
  const res = await apiFetch(
    apiUrl("/api/knowledge-bases/rag-pipelines/graphrag/model-compatibility"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, model_id: modelId }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to test GraphRAG compatibility"),
    );
  }
  return (await res.json()) as GraphRagModelCompatibility;
}

export async function setEngineActiveModel(
  kind: string,
  profileId: string,
  modelId: string,
): Promise<ModelKindOptions> {
  const res = await apiFetch(
    apiUrl("/api/knowledge-bases/rag-pipelines/active-model"),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, profile_id: profileId, model_id: modelId }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to switch model"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as ModelKindOptions;
}

export async function updateRagProviderMode(
  provider: string,
  mode: string,
): Promise<{ provider: string; mode: string }> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/rag-providers/${encodeURIComponent(provider)}/mode`,
    ),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to update retrieval mode"),
    );
  }
  // The provider list's `default_mode` depends on this; refresh it.
  invalidateKnowledgeCaches();
  return (await res.json()) as { provider: string; mode: string };
}
