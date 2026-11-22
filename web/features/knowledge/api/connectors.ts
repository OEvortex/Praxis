import { apiFetch } from "@/shared/api/client";
import type { ImaKnowledgeBaseOption } from "@/lib/ima-connection";
import { apiUrl, invalidateKnowledgeCaches, readErrorDetail } from "./http";

export async function connectObsidianVault(payload: {
  name: string;
  vaultPath: string;
}): Promise<{ status: string; name: string; vault_path: string }> {
  const res = await apiFetch(apiUrl("/api/knowledge-bases/connect-obsidian"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: payload.name, vault_path: payload.vaultPath }),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to connect Obsidian vault"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    status: string;
    name: string;
    vault_path: string;
  };
}

export async function connectMarginNote4Library(payload: {
  name: string;
  description?: string;
}): Promise<{ status: string; name: string; db_path?: string }> {
  const res = await apiFetch(
    apiUrl("/api/knowledge-bases/connect-marginnote4"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `db_path` is deliberately not sent: leaving it blank keeps one rule for
      // where the store lives (derived from the name), which is what lets the
      // pairing endpoints, the Add-on's syncs and the capability binding agree.
      body: JSON.stringify({
        name: payload.name,
        description: payload.description ?? "",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to connect MarginNote 4 library"),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    status: string;
    name: string;
    db_path?: string;
  };
}

export interface LinkedFolderProbe {
  /** Whether the folder holds a ready index for the chosen engine. */
  ok: boolean;
  provider: string;
  external_path: string;
  version: string | null;
  doc_count: number | null;
  embedding: {
    /** null when compatibility could not be verified. */
    compatible: boolean | null;
    index_model: string | null;
    current_model: string | null;
  };
  warnings: string[];
  /** Set when the folder cannot be linked at all (no index, wrong engine, …). */
  error: string | null;
}

export interface LinkedFolderInfo {
  id: string;
  path: string;
  added_at: string;
  file_count: number;
  last_sync: string | null;
}

export interface SyncFolderResponse {
  message: string;
  folder_path?: string | null;
  files: string[];
  new_files: number;
  modified_files: number;
  file_count: number;
  task_id: string | null;
}

export async function probeLinkedFolder(payload: {
  folderPath: string;
  provider: string;
}): Promise<LinkedFolderProbe> {
  const res = await apiFetch(apiUrl("/api/knowledge-bases/probe-folder"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder_path: payload.folderPath,
      rag_provider: payload.provider,
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to inspect folder"));
  }
  return (await res.json()) as LinkedFolderProbe;
}

export async function connectLinkedFolder(payload: {
  name: string;
  folderPath: string;
  provider: string;
}): Promise<{
  status: string;
  name: string;
  external_path: string;
  rag_provider: string;
  warnings: string[];
}> {
  const res = await apiFetch(apiUrl("/api/knowledge-bases/connect-folder"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: payload.name,
      folder_path: payload.folderPath,
      rag_provider: payload.provider,
    }),
  });
  if (!res.ok) {
    throw new Error(await readErrorDetail(res, "Failed to link folder"));
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    status: string;
    name: string;
    external_path: string;
    rag_provider: string;
    warnings: string[];
  };
}

// ── Linked document folders ──────────────────────────────────────────

export async function listLinkedFolders(
  kbName: string,
  options?: { signal?: AbortSignal },
): Promise<LinkedFolderInfo[]> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/linked-folders`),
    { signal: options?.signal },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(
        res,
        `Failed to list linked folders (${res.status})`,
      ),
    );
  }
  return (await res.json()) as LinkedFolderInfo[];
}

export async function linkFolder(
  kbName: string,
  folderPath: string,
): Promise<LinkedFolderInfo> {
  const res = await apiFetch(
    apiUrl(`/api/knowledge-bases/${encodeURIComponent(kbName)}/link-folder`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_path: folderPath }),
    },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to link folder (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as LinkedFolderInfo;
}

export async function unlinkFolder(
  kbName: string,
  folderId: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/linked-folders/${encodeURIComponent(folderId)}`,
    ),
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to unlink folder (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
}

export async function syncLinkedFolder(
  kbName: string,
  folderId: string,
): Promise<SyncFolderResponse> {
  const res = await apiFetch(
    apiUrl(
      `/api/knowledge-bases/${encodeURIComponent(kbName)}/sync-folder/${encodeURIComponent(folderId)}`,
    ),
    { method: "POST" },
  );
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, `Failed to sync linked folder (${res.status})`),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as SyncFolderResponse;
}

export interface ImaKnowledgeBasePage {
  knowledge_bases: ImaKnowledgeBaseOption[];
  next_cursor: string;
  is_end: boolean;
}

export interface ImaProbe {
  knowledge_base_id: string;
  ok: boolean;
  credentials_ok: boolean;
  knowledge_base_name: string | null;
  description: string | null;
  error: string | null;
}

export async function listImaKnowledgeBases(payload: {
  /** Empty falls back to the account credentials stored on the engine page. */
  clientId?: string;
  apiKey?: string;
  cursor?: string;
  limit?: number;
}): Promise<ImaKnowledgeBasePage> {
  const res = await apiFetch(apiUrl("/api/knowledge-bases/list-ima"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: payload.clientId ?? "",
      api_key: payload.apiKey ?? "",
      cursor: payload.cursor ?? "",
      limit: payload.limit ?? 20,
    }),
    skipAuthRedirect: true,
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to read Tencent IMA knowledge bases"),
    );
  }
  return (await res.json()) as ImaKnowledgeBasePage;
}

export async function probeImaKnowledgeBase(payload: {
  clientId?: string;
  apiKey?: string;
  knowledgeBaseId: string;
}): Promise<ImaProbe> {
  const res = await apiFetch(apiUrl("/api/knowledge-bases/probe-ima"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: payload.clientId ?? "",
      api_key: payload.apiKey ?? "",
      knowledge_base_id: payload.knowledgeBaseId,
    }),
    skipAuthRedirect: true,
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(res, "Failed to verify Tencent IMA knowledge base"),
    );
  }
  return (await res.json()) as ImaProbe;
}

export async function connectImaKnowledgeBase(payload: {
  name: string;
  /** Empty binds the KB to the account credentials instead of pinning a copy. */
  clientId?: string;
  apiKey?: string;
  knowledgeBaseId: string;
}): Promise<{
  status: string;
  name: string;
  knowledge_base_id: string;
  rag_provider: string;
}> {
  const res = await apiFetch(apiUrl("/api/knowledge-bases/connect-ima"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: payload.name,
      client_id: payload.clientId ?? "",
      api_key: payload.apiKey ?? "",
      knowledge_base_id: payload.knowledgeBaseId,
    }),
    skipAuthRedirect: true,
  });
  if (!res.ok) {
    throw new Error(
      await readErrorDetail(
        res,
        "Failed to connect Tencent IMA knowledge base",
      ),
    );
  }
  invalidateKnowledgeCaches();
  return (await res.json()) as {
    status: string;
    name: string;
    knowledge_base_id: string;
    rag_provider: string;
  };
}
