import { apiFetch } from "@/shared/api/client";
import { apiUrl, invalidateKnowledgeCaches, readErrorDetail } from "./http";

// ── GitHub sources ───────────────────────────────────────────────────

export interface GitHubSource {
  id: string;
  repo: string;
  branch: string;
  path: string;
  glob: string;
  enabled: boolean;
  last_synced_sha: string;
  last_synced_at: string;
  last_sync_status: string;
  last_sync_error: string | null;
  files_synced: number;
  added_at: string;
}

export interface AddGitHubSourcePayload {
  repo: string;
  branch?: string;
  path?: string;
  glob?: string;
}

export interface GitHubSyncResult {
  source_id: string;
  repo: string;
  ok: boolean;
  skipped: boolean;
  files_added: number;
  files_updated: number;
  files_removed: number;
  error: string | null;
}

export async function listGitHubSources(
  kbName: string,
): Promise<GitHubSource[]> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/github-sources`),
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(
        res,
        `Failed to list GitHub sources (${res.status})`,
      ),
    );
  }
  return (await res.json()) as GitHubSource[];
}

export async function addGitHubSource(
  kbName: string,
  payload: AddGitHubSourcePayload,
): Promise<GitHubSource> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/github-source`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: payload.repo,
        branch: payload.branch ?? "main",
        path: payload.path ?? "",
        glob: payload.glob ?? "*.md",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to add GitHub source (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as GitHubSource;
}

export async function removeGitHubSource(
  kbName: string,
  sourceId: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/github-source/${encodeURIComponent(sourceId)}`,
    ),
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(
        res,
        `Failed to remove GitHub source (${res.status})`,
      ),
    );
  }
  invalidateKnowledgeCaches();
}

export async function syncGitHubSources(
  kbName: string,
): Promise<GitHubSyncResult[]> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/sync-github`),
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `GitHub sync failed (${res.status})`),
    );
  }
  const body = await res.json();
  return (body.results ?? []) as GitHubSyncResult[];
}

// ── Web sources ──────────────────────────────────────────────────────

export interface BilingualPairing {
  pairing_id: string;
  source_url: string;
  target_url: string;
  source_file: string;
  target_file: string;
  source_lang: string;
  target_lang: string;
  pairing_method: string;
  updated_at?: number;
}

export interface WebSource {
  id: string;
  url: string;
  max_depth: number;
  max_pages: number;
  enabled: boolean;
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
  page_count: number;
  last_synced_at: string;
  last_sync_status: string;
  last_sync_error: string | null;
  added_at: string;
  bilingual_pairings?: BilingualPairing[];
}

export interface AddWebSourcePayload {
  url: string;
  max_depth?: number;
  max_pages?: number;
}

export interface WebSyncSourceResult {
  source_id: string;
  url: string;
  ok: boolean;
  page_count: number;
  pages_added: number;
  pages_updated: number;
  pages_removed: number;
  pages_unchanged: number;
  error: string | null;
}

export interface WebSyncResult {
  ok: boolean;
  message: string;
  results: WebSyncSourceResult[];
}

export interface WebSourceSyncJob {
  owner_id: string;
  kb_name: string;
  source_id: string;
  state: string;
  next_run_at: number;
  last_run_at?: number | null;
  attempt: number;
  error?: string | null;
  cancel_requested: boolean;
}

export interface WebSourceSchedulePayload {
  auto_sync_enabled: boolean;
  sync_interval_hours: number;
}

export async function listWebSources(
  kbName: string,
  options?: { signal?: AbortSignal },
): Promise<WebSource[]> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/web-sources`),
    { signal: options?.signal },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to list web sources (${res.status})`),
    );
  }
  return (await res.json()) as WebSource[];
}

export async function listWebSourcePairings(
  kbName: string,
  sourceId: string,
  options?: { signal?: AbortSignal },
): Promise<BilingualPairing[]> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/web-source/${encodeURIComponent(sourceId)}/pairings`,
    ),
    { signal: options?.signal },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(
        res,
        `Failed to list web source pairings (${res.status})`,
      ),
    );
  }
  return (await res.json()) as BilingualPairing[];
}

export async function addWebSource(
  kbName: string,
  payload: AddWebSourcePayload,
): Promise<WebSource> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/web-source`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: payload.url,
        max_depth: payload.max_depth ?? 3,
        max_pages: payload.max_pages ?? 200,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to add web source (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as WebSource;
}

export async function removeWebSource(
  kbName: string,
  sourceId: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/web-source/${encodeURIComponent(sourceId)}`,
    ),
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to remove web source (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
}

export async function listWebSourceSyncJobs(
  kbName: string,
  options?: { signal?: AbortSignal },
): Promise<WebSourceSyncJob[]> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/web-source-sync`,
    ),
    { signal: options?.signal },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to list sync jobs (${res.status})`),
    );
  }
  return (await res.json()) as WebSourceSyncJob[];
}

export async function updateWebSourceSchedule(
  kbName: string,
  sourceId: string,
  payload: WebSourceSchedulePayload,
): Promise<WebSource> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/web-source/${encodeURIComponent(sourceId)}/schedule`,
    ),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to update sync schedule (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as WebSource;
}

export async function cancelWebSourceSync(
  kbName: string,
  sourceId: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/web-source/${encodeURIComponent(sourceId)}/cancel`,
    ),
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to cancel sync (${res.status})`),
    );
  }
}

export async function retryWebSourceSync(
  kbName: string,
  sourceId: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/web-source/${encodeURIComponent(sourceId)}/retry`,
    ),
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to retry sync (${res.status})`),
    );
  }
}

export async function syncWebSources(kbName: string): Promise<WebSyncResult> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/sync-web`),
    {
      method: "POST",
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Web sync failed (${res.status})`),
    );
  }
  return (await res.json()) as WebSyncResult;
}
