// Port of deeptutor/services/rag/pipelines/ima/{transport,envelope,models,client,probe,config}.py
// — Tencent IMA OpenAPI client (subset: list/probe used by connector routes).
import type { AnyRecord } from "./types.js";
import type { Settings } from "../../config.js";
import * as database from "../../store/database.js";

export const IMA_API_BASE_URL = "https://ima.qq.com";
export const IMA_WIKI_PREFIX = "/openapi/wiki/v1";
export const IMA_MAX_PAGE_LIMIT = 50;
export const IMA_MAX_DETAIL_IDS = 20;

export class ImaAPIError extends Error {}
export class ImaAuthError extends ImaAPIError {}
export class ImaContentAccessError extends ImaAPIError {}
export class ImaRateLimitError extends ImaAPIError {}

// -- envelope -------------------------------------------------------------------

const CODE_KEYS = ["retcode", "code"];
const MESSAGE_KEYS = ["errmsg", "msg"];
const CREDENTIAL_CODES = new Set([20004, 200002]);
const RATE_LIMIT_CODES = new Set([20002, 110021]);
const RETRYABLE_CODES = new Set([110010, 100003]);

function unwrap(payload: unknown, statusCode: number): AnyRecord {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ImaAPIError(`IMA returned an unexpected payload with status ${statusCode}.`);
  }
  const p = payload as AnyRecord;
  let code: number | null = null;
  for (const key of CODE_KEYS) {
    if (key in p) {
      const n = Number(p[key]);
      if (Number.isFinite(n)) {
        code = n;
        break;
      }
    }
  }
  let message = "";
  for (const key of MESSAGE_KEYS) {
    const v = p[key];
    if (v) {
      message = String(v).trim();
      break;
    }
  }
  if (code === 0) {
    const data = p["data"];
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as AnyRecord)
      : {};
  }
  if (message.includes("订阅知识库") && message.includes("没有权限")) {
    throw new ImaContentAccessError(
      "IMA permits searching this subscribed library, but its files can only be read in the IMA client.",
    );
  }
  if (code !== null && CREDENTIAL_CODES.has(code)) {
    throw new ImaAuthError(message || "IMA rejected the client ID / API key.");
  }
  if (code !== null && RATE_LIMIT_CODES.has(code)) {
    throw new ImaRateLimitError(message || "IMA rate limit reached.");
  }
  if (code !== null && RETRYABLE_CODES.has(code)) {
    throw new ImaAPIError(
      message || `IMA is temporarily unavailable (code ${code}). Try again.`,
    );
  }
  if (code === null) {
    throw new ImaAPIError(`IMA returned an unrecognized response with status ${statusCode}.`);
  }
  throw new ImaAPIError(message || `IMA request failed with code ${code}.`);
}

// -- credentials / config ---------------------------------------------------------

export interface ImaCredentials {
  client_id: string;
  api_key: string;
}

const IMA_SETTINGS_KEY = "runtime_settings/ima";

/** Account-level credential pair from settings (upstream settings/ima.json). */
export function getAccountCredentials(settings: Settings): ImaCredentials {
  const data = database.get_state<AnyRecord>(settings, IMA_SETTINGS_KEY);
  return {
    client_id: String(data?.["client_id"] ?? "").trim(),
    api_key: String(data?.["api_key"] ?? "").trim(),
  };
}

export function saveAccountCredentials(settings: Settings, creds: ImaCredentials): void {
  database.put_state(settings, IMA_SETTINGS_KEY, {
    version: 1,
    client_id: creds.client_id,
    api_key: creds.api_key,
  });
}

// -- transport ---------------------------------------------------------------------

async function imaPost(
  clientId: string,
  apiKey: string,
  method: string,
  body: AnyRecord,
  prefix = IMA_WIKI_PREFIX,
): Promise<AnyRecord> {
  const response = await fetch(`${IMA_API_BASE_URL}${prefix}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ima-openapi-clientid": clientId,
      "ima-openapi-apikey": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ImaAuthError("IMA rejected the credentials or knowledge-base permissions.");
  }
  if (response.status === 429) {
    throw new ImaRateLimitError("IMA rate limit reached. Try again shortly.");
  }
  if (!response.ok) {
    throw new ImaAPIError(
      `IMA returned HTTP ${response.status}. Retry or check the connection.`,
    );
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return unwrap(payload, response.status);
}

// -- model parsing (models.py subset) ----------------------------------------------

const FOLDER_MEDIA_ID_PREFIX = "folder_";
const FOLDER_MEDIA_TYPE = 99;
const DOCUMENT_KEYS = ["knowledge_list", "info_list"];
const FOLDER_KEYS = ["folder_list", "folders"];

function entries(data: AnyRecord, keys: string[]): AnyRecord[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value.filter(
        (item): item is AnyRecord => item !== null && typeof item === "object" && !Array.isArray(item),
      );
    }
  }
  return [];
}

function text(raw: AnyRecord, key: string): string {
  const v = raw[key];
  return v === null || v === undefined ? "" : String(v).trim();
}

function intOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export interface ImaDocument {
  media_id: string;
  title: string;
  parent_folder_id: string;
  highlight: string;
}
export interface ImaFolder {
  folder_id: string;
  name: string;
}
export interface ImaKnowledgePage {
  documents: ImaDocument[];
  folders: ImaFolder[];
  next_cursor: string;
  is_end: boolean;
}

function embeddedFolderMediaId(raw: AnyRecord): string {
  const mediaId = text(raw, "media_id");
  if (!mediaId) return "";
  if (mediaId.startsWith(FOLDER_MEDIA_ID_PREFIX)) return mediaId;
  if (intOf(raw["media_type"]) === FOLDER_MEDIA_TYPE) return mediaId;
  return "";
}

function isDocumentArrayFolder(raw: AnyRecord): boolean {
  if (text(raw, "folder_id") && !text(raw, "media_id")) return true;
  if (embeddedFolderMediaId(raw)) return true;
  return raw["media_type"] !== undefined && raw["media_type"] !== null && intOf(raw["media_type"]) === FOLDER_MEDIA_TYPE;
}

function folderFrom(raw: AnyRecord): ImaFolder | null {
  const folderId = text(raw, "folder_id") || embeddedFolderMediaId(raw);
  if (!folderId) return null;
  return {
    folder_id: folderId,
    name: text(raw, "name") || text(raw, "title") || folderId,
  };
}

function documentFrom(raw: AnyRecord): ImaDocument | null {
  const mediaId = text(raw, "media_id");
  const title = text(raw, "title");
  if (!mediaId && !title) return null;
  return {
    media_id: mediaId,
    title: title || mediaId,
    parent_folder_id: text(raw, "parent_folder_id"),
    highlight: text(raw, "highlight_content"),
  };
}

export function parseKnowledgePage(data: AnyRecord): ImaKnowledgePage {
  const documents: ImaDocument[] = [];
  const folders: ImaFolder[] = [];
  const seenDocs = new Set<string>();
  const seenFolders = new Set<string>();
  for (const raw of entries(data, DOCUMENT_KEYS)) {
    if (isDocumentArrayFolder(raw)) {
      const folder = folderFrom(raw);
      if (folder && !seenFolders.has(folder.folder_id)) {
        seenFolders.add(folder.folder_id);
        folders.push(folder);
      }
      continue;
    }
    const doc = documentFrom(raw);
    if (doc && !seenDocs.has(doc.media_id)) {
      seenDocs.add(doc.media_id);
      documents.push(doc);
    }
  }
  for (const raw of entries(data, FOLDER_KEYS)) {
    const folder = folderFrom(raw);
    if (folder && !seenFolders.has(folder.folder_id)) {
      seenFolders.add(folder.folder_id);
      folders.push(folder);
    }
  }
  return {
    documents,
    folders,
    next_cursor: String(data["next_cursor"] ?? ""),
    is_end: Boolean(data["is_end"]),
  };
}

export function parseKnowledgeBases(
  data: AnyRecord,
): { bases: { id: string; name: string }[]; next_cursor: string; is_end: boolean } {
  const bases: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const raw of entries(data, ["info_list"])) {
    const id = text(raw, "id") || text(raw, "kb_id");
    const name = text(raw, "name") || text(raw, "kb_name");
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    bases.push({ id, name });
  }
  return {
    bases,
    next_cursor: String(data["next_cursor"] ?? ""),
    is_end: Boolean(data["is_end"]),
  };
}

export function pageLimit(limit: unknown, maximum = IMA_MAX_PAGE_LIMIT): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return maximum;
  return Math.max(1, Math.min(Math.trunc(n), maximum));
}

// -- client --------------------------------------------------------------------------

export class ImaClient {
  constructor(
    private clientId: string,
    private apiKey: string,
    private knowledgeBaseId = "",
  ) {}

  async searchKnowledgeBases(
    query = "",
    cursor = "",
    limit = IMA_MAX_PAGE_LIMIT,
  ): Promise<{ knowledge_bases: AnyRecord[]; next_cursor: string; is_end: boolean }> {
    const data = await imaPost(this.clientId, this.apiKey, "search_knowledge_base", {
      query: String(query ?? "").trim(),
      cursor: String(cursor ?? "").trim(),
      limit: pageLimit(limit),
    });
    const { bases, next_cursor, is_end } = parseKnowledgeBases(data);

    let details: Record<string, AnyRecord> = {};
    if (bases.length) {
      try {
        details = await this.getKnowledgeBases(bases.slice(0, IMA_MAX_DETAIL_IDS).map((b) => b.id));
      } catch {
        details = {};
      }
    }
    return {
      knowledge_bases: bases.map((base) => {
        const rawDesc = details[base.id]?.["description"];
        const description = rawDesc === null || rawDesc === undefined ? "" : String(rawDesc).trim();
        return { id: base.id, name: base.name, description: description || null };
      }),
      next_cursor,
      is_end,
    };
  }

  async getKnowledgeBases(ids: string[]): Promise<Record<string, AnyRecord>> {
    const normalized: string[] = [];
    for (const item of ids) {
      const kbId = String(item ?? "").trim();
      if (kbId && !normalized.includes(kbId)) normalized.push(kbId);
    }
    if (!normalized.length) return {};
    if (normalized.length > IMA_MAX_DETAIL_IDS) {
      throw new ImaAPIError(
        `IMA accepts at most ${IMA_MAX_DETAIL_IDS} knowledge base IDs per request.`,
      );
    }
    const data = await imaPost(this.clientId, this.apiKey, "get_knowledge_base", {
      ids: normalized,
    });
    const infos = data["infos"];
    if (infos === null || typeof infos !== "object" || Array.isArray(infos)) return {};
    const out: Record<string, AnyRecord> = {};
    for (const [kbId, info] of Object.entries(infos as AnyRecord)) {
      if (info !== null && typeof info === "object" && !Array.isArray(info)) {
        out[kbId] = info as AnyRecord;
      }
    }
    return out;
  }

  async getKnowledgeBase(): Promise<AnyRecord> {
    const kbId = this.knowledgeBaseId;
    const details = await this.getKnowledgeBases([kbId]);
    return details[kbId] ?? {};
  }
}

// -- probe (ima/probe.py) ---------------------------------------------------------------

export interface ImaProbe {
  knowledge_base_id: string;
  ok: boolean;
  credentials_ok: boolean;
  knowledge_base_name: string | null;
  description: string | null;
  error: string | null;
}

function optStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

export async function probeKnowledgeBase(
  clientId: string,
  apiKey: string,
  knowledgeBaseId: string,
): Promise<ImaProbe> {
  clientId = String(clientId ?? "").trim();
  apiKey = String(apiKey ?? "").trim();
  knowledgeBaseId = String(knowledgeBaseId ?? "").trim();
  const probe: ImaProbe = {
    knowledge_base_id: knowledgeBaseId,
    ok: false,
    credentials_ok: false,
    knowledge_base_name: null,
    description: null,
    error: null,
  };
  const missing: string[] = [];
  if (!clientId) missing.push("Client ID");
  if (!apiKey) missing.push("API key");
  if (!knowledgeBaseId) missing.push("knowledge base ID");
  if (missing.length) {
    probe.error = `${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} required.`;
    return probe;
  }
  const client = new ImaClient(clientId, apiKey, knowledgeBaseId);
  let info: AnyRecord;
  try {
    info = await client.getKnowledgeBase();
  } catch (exc) {
    if (exc instanceof ImaAuthError) {
      probe.error = "IMA rejected these credentials. Check them and try again.";
    } else {
      probe.error = "Could not reach Tencent IMA. Try again shortly.";
    }
    return probe;
  }
  probe.credentials_ok = true;
  if (!info || !Object.keys(info).length) {
    probe.error =
      "The credentials work, but no knowledge base matches this ID. " +
      "Check the ID in IMA and try again.";
    return probe;
  }
  probe.knowledge_base_name = optStr(info["name"]);
  probe.description = optStr(info["description"]);
  probe.ok = true;
  return probe;
}
