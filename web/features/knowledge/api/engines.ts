import { apiFetch } from "@/shared/api/client";
import { withClientCache } from "@/lib/client-cache";
import {
  apiUrl,
  invalidateKnowledgeCaches,
  KNOWLEDGE_CACHE_PREFIX,
  readErrorDetail,
} from "./http";
import type {
  EmbeddingUsage,
  EnginePreflight,
  ImaAccountConfig,
  LlamaIndexConfig,
  ModelKindOptions,
  ModelOptionsByKind,
  RagProviderSummary,
} from "./types";
export type {
  EnginePreflight,
  ImaAccountConfig,
  LlamaIndexConfig,
  ModelKindOptions,
  ModelOptionsByKind,
  RagProviderSummary,
} from "./types";

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
