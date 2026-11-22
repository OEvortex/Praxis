import { apiFetch } from "@/shared/api/client";
import { withClientCache } from "@/lib/client-cache";
import {
  apiUrl,
  appendFilesWithPaths,
  inKnowledgeLibrary,
  invalidateKnowledgeCaches,
  KNOWLEDGE_CACHE_PREFIX,
  readErrorDetail,
  withDockerUpgradeHint,
} from "./http";
import type {
  EmbeddingModelSelection,
  KnowledgeBaseFile,
  KnowledgeBaseSummary,
  KnowledgeTaskResponse,
  KnowledgeUploadPolicy,
} from "./types";

const IMAGE_UPLOAD_EXTENSIONS = [
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
];

const IMAGE_UPLOAD_MIME_TYPES = [
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
];

function normalizeUploadPolicy(data: unknown): KnowledgeUploadPolicy {
  const payload = data as Partial<KnowledgeUploadPolicy> | null | undefined;
  const allowAnyExtension = payload?.allow_any_extension === true;
  const extensions = Array.from(
    new Set([
      ...(allowAnyExtension
        ? []
        : Array.isArray(payload?.extensions)
          ? payload.extensions
          : []),
      ...(allowAnyExtension ? [] : IMAGE_UPLOAD_EXTENSIONS),
    ]),
  ).sort();
  const serverAccept =
    typeof payload?.accept === "string"
      ? payload.accept
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  const accept = allowAnyExtension
    ? ""
    : Array.from(
        new Set([...serverAccept, ...extensions, ...IMAGE_UPLOAD_MIME_TYPES]),
      ).join(",");

  return {
    extensions,
    accept,
    allow_any_extension: allowAnyExtension,
    max_file_size_bytes:
      typeof payload?.max_file_size_bytes === "number"
        ? payload.max_file_size_bytes
        : 200 * 1024 * 1024,
  };
}

export async function listKnowledgeBases(options?: {
  force?: boolean;
  library?: boolean;
}) {
  return withClientCache<KnowledgeBaseSummary[]>(
    `${KNOWLEDGE_CACHE_PREFIX}list:${options?.library || inKnowledgeLibrary() ? "library" : "workspace"}`,
    async () => {
      const response = await apiFetch(
        apiUrl(
          options?.library
            ? "/api/knowledge-bases/list?resource_library=true"
            : "/api/knowledge-bases/list",
        ),
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to list knowledge bases"),
        );
      }
      const data = await response.json();
      return Array.isArray(data)
        ? data
        : Array.isArray(data?.knowledge_bases)
          ? data.knowledge_bases
          : [];
    },
    {
      force: options?.force,
    },
  );
}

export async function getKnowledgeUploadPolicy(options?: { force?: boolean }) {
  return withClientCache<KnowledgeUploadPolicy>(
    `${KNOWLEDGE_CACHE_PREFIX}upload-policy`,
    async () => {
      const response = await apiFetch(
        apiUrl("/api/knowledge-bases/supported-file-types"),
        {
          cache: "no-store",
        },
      );
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, "Failed to load upload policy"),
        );
      }
      const data = await response.json();
      return normalizeUploadPolicy(data);
    },
    {
      force: options?.force,
    },
  );
}

export async function listKnowledgeBaseFiles(
  name: string,
  options?: { force?: boolean },
): Promise<KnowledgeBaseFile[]> {
  return withClientCache<KnowledgeBaseFile[]>(
    `${KNOWLEDGE_CACHE_PREFIX}files:${name}`,
    async () => {
      const response = await apiFetch(
        apiUrl(`/api/knowledge-bases/${encodeURIComponent(name)}/files`),
        { cache: "no-store" },
      );
      if (!response.ok) {
        const detail = await readErrorDetail(
          response,
          `Failed to list files (${response.status})`,
        );
        throw new Error(
          withDockerUpgradeHint(
            detail,
            response.status,
            "Knowledge file listing",
          ),
        );
      }
      const data = await response.json();
      return Array.isArray(data?.files) ? data.files : [];
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

/** Build the `/api/...` path for a raw KB file (caller can pass to apiUrl()). */
export function knowledgeBaseFilePath(
  kbName: string,
  filename: string,
): string {
  return `/api/knowledge-bases/${encodeURIComponent(kbName)}/files/${filename
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${inKnowledgeLibrary() ? "?resource_library=true" : ""}`;
}

/** Build the `/api/...` path for extracted plain-text preview of a raw KB file. */
export function knowledgeBaseFilePreviewTextPath(
  kbName: string,
  filename: string,
): string {
  return `/api/knowledge-bases/${encodeURIComponent(kbName)}/file-preview-text/${filename
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${inKnowledgeLibrary() ? "?resource_library=true" : ""}`;
}

export async function createKnowledgeBase(payload: {
  name: string;
  provider: string;
  files: File[];
  storageWorkspaceId?: string;
  pageindexMode?: "flash" | "standard";
  searchMode?: string;
  embeddingModel?: EmbeddingModelSelection;
}): Promise<KnowledgeTaskResponse> {
  const form = new FormData();
  form.append("name", payload.name);
  form.append("rag_provider", payload.provider);
  if (payload.storageWorkspaceId !== undefined)
    form.append("storage_workspace_id", payload.storageWorkspaceId);
  if (payload.pageindexMode) {
    form.append("pageindex_mode", payload.pageindexMode);
  }
  if (payload.searchMode) form.append("search_mode", payload.searchMode);
  if (payload.embeddingModel)
    form.append("embedding_model", JSON.stringify(payload.embeddingModel));
  appendFilesWithPaths(form, payload.files);

  const res = await apiFetch(apiUrl("/api/knowledge-bases"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to create knowledge base"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

export async function uploadKnowledgeBaseFiles(
  name: string,
  files: File[],
  options?: { provider?: string; destSubdir?: string },
): Promise<KnowledgeTaskResponse> {
  const form = new FormData();
  appendFilesWithPaths(form, files);
  if (options?.provider) form.append("rag_provider", options.provider);
  // Places the batch under an existing KB folder. A folder pick reports paths
  // relative to the chosen directory, so its ancestors are not in the payload
  // — this is how the caller says where the subtree belongs (#866).
  if (options?.destSubdir) form.append("dest_subdir", options.destSubdir);

  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(name)}/upload`),
    {
      method: "POST",
      body: form,
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to upload files"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

export async function createKbFolder(
  name: string,
  path: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(name)}/folders`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to create folder"));
  }
  invalidateKnowledgeCaches();
}

export async function moveKbFile(
  name: string,
  source: string,
  destFolder: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(name)}/files/move`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, dest_folder: destFolder }),
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to move file"));
  }
  invalidateKnowledgeCaches();
}

/**
 * Delete a single raw document from a KB. Works even while the KB is in an
 * error state, so an unparseable file can be dropped without rebuilding the
 * whole base. `was_indexed` signals whether a re-index is needed to purge the
 * file's vectors from retrieval.
 */
export async function deleteKbFile(
  name: string,
  filename: string,
): Promise<{ was_indexed: boolean }> {
  const res = await apiFetch(apiUrl(knowledgeBaseFilePath(name, filename)), {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to delete file"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as { was_indexed: boolean };
}

export async function setDefaultKnowledgeBase(name: string): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/default/${encodeURIComponent(name)}`),
    {
      method: "PUT",
    },
  );
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to set default"));
  }
  invalidateKnowledgeCaches();
}

export interface LightRagRebuildConfig {
  fingerprint: string;
  indexing_policy: import("@/lib/knowledge-helpers").LightRagIndexingPolicy;
  embedding: { model: string; dimension: number };
  embedding_selection?: EmbeddingModelSelection | null;
}

export async function getReindexConfig(
  name: string,
  embeddingModel?: EmbeddingModelSelection,
): Promise<LightRagRebuildConfig> {
  const query = embeddingModel
    ? `?${new URLSearchParams({ embedding_model: JSON.stringify(embeddingModel) })}`
    : "";
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(name)}/reindex-config${query}`,
    ),
    { cache: "no-store" },
  );
  if (!res.ok)
    throw new Error(
      await readErrorDetail(res, "Failed to load rebuild configuration"),
    );
  return (await res.json()) as LightRagRebuildConfig;
}

export async function reindexKnowledgeBase(
  name: string,
  configFingerprint?: string,
  embeddingModel?: EmbeddingModelSelection,
): Promise<KnowledgeTaskResponse> {
  const request: RequestInit = { method: "POST" };
  if (configFingerprint || embeddingModel) {
    const form = new FormData();
    if (configFingerprint) form.append("config_fingerprint", configFingerprint);
    if (embeddingModel)
      form.append("embedding_model", JSON.stringify(embeddingModel));
    request.body = form;
  }
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(name)}/reindex`),
    request,
  );
  if (!res.ok) {
    const detail = await readErrorDetail(
      res,
      `Re-index failed (${res.status})`,
    );
    throw new Error(
      withDockerUpgradeHint(detail, res.status, "Knowledge re-index"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

export async function retryKnowledgeBase(
  name: string,
): Promise<KnowledgeTaskResponse> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(name)}/retry`),
    {
      method: "POST",
    },
  );
  if (!res.ok) {
    const detail = await readErrorDetail(res, `Retry failed (${res.status})`);
    throw new Error(
      withDockerUpgradeHint(detail, res.status, "Knowledge retry"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as KnowledgeTaskResponse;
}

/**
 * Deletes by name in the body, not in the path.
 *
 * A name registered before the `register_*` methods validated one can contain
 * a `/`. uvicorn decodes `%2F` back to a separator before routing, so the
 * path route cannot match such a name and answers 404 — leaving a KB that is
 * listed but not removable from the UI. A body has no such limit, so this is
 * the one delete that reaches every registered entry.
 */
export async function deleteKnowledgeBase(name: string): Promise<void> {
  const res = await apiFetch(apiUrl(`/api/knowledge-bases/delete`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Delete failed (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
}
