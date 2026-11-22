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

