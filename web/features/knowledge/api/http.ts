import { apiFetch, apiUrl as baseApiUrl } from "@/shared/api/client";
import { invalidateClientCache, withClientCache } from "@/lib/client-cache";

export function inKnowledgeLibrary(): boolean {
  return (
    typeof window !== "undefined" &&
    /^\/knowledge-bases(?:\/|$)/.test(window.location.pathname)
  );
}

export function apiUrl(path: string): string {
  const url = baseApiUrl(path);
  return inKnowledgeLibrary() &&
    path.startsWith("/api/knowledge-bases") &&
    !path.includes("resource_library=")
    ? `${url}${url.includes("?") ? "&" : "?"}resource_library=true`
    : url;
}

export const KNOWLEDGE_CACHE_PREFIX = "knowledge:";

export function invalidateKnowledgeCaches() {
  invalidateClientCache(KNOWLEDGE_CACHE_PREFIX);
}

export async function readErrorDetail(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = await res.json();
    if (body?.detail) return String(body.detail);
  } catch {
    // body wasn't JSON; fall through
  }
  return fallback;
}

export function withDockerUpgradeHint(
  detail: string,
  status: number,
  action: string,
): string {
  if (status === 404 && detail.trim().toLowerCase() === "not found") {
    return `${action} endpoint not found (404). The web UI may be newer than the backend API. If using Docker, pull and recreate the container, then retry.`;
  }
  return detail;
}

// A folder upload's File objects carry `webkitRelativePath` (e.g.
// "Papers/2024/a.pdf"); single-file picks leave it "". We forward it as
// `rel_paths` so the backend preserves the folder layout under raw/.
export function appendFilesWithPaths(form: FormData, files: File[]): void {
  files.forEach((file) => {
    form.append("files", file);
    form.append("rel_paths", file.webkitRelativePath || "");
  });
}

export async function getEngineConfig<T>(
  provider: string,
  cacheKey: string,
  options?: { force?: boolean },
): Promise<T> {
  return withClientCache<T>(
    `${KNOWLEDGE_CACHE_PREFIX}${cacheKey}`,
    async () => {
      const response = await apiFetch(
        apiUrl(`/api/knowledge-bases/rag-pipelines/${provider}/config`),
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(
          await readErrorDetail(response, `Failed to read ${provider} config`),
        );
      }
      return (await response.json()) as T;
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

export async function updateEngineConfig<T>(
  provider: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/rag-pipelines/${provider}/config`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to update ${provider} config`),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as T;
}
