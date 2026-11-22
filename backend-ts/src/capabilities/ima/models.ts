// typed views over
// IMA's wire payloads and the parsers that produce them. Wire shapes are
// decoded exactly once, here.

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function entries(data: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function text(raw: Record<string, unknown>, key: string): string {
  const v = raw[key];
  return v === null || v === undefined ? "" : String(v).trim();
}

function intOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ---------------------------------------------------------------------------
// Knowledge base parsing
// ---------------------------------------------------------------------------

const DOCUMENT_KEYS = ["knowledge_list", "info_list"];
const FOLDER_KEYS = ["folder_list", "folders"];
const FOLDER_MEDIA_ID_PREFIX = "folder_";
const FOLDER_MEDIA_TYPE = 99;
const NOTE_MEDIA_TYPE = 11;

export interface ImaDocument {
  media_id: string;
  title: string;
  parent_folder_id: string;
  highlight: string;
}

export interface ImaFolder {
  folder_id: string;
  name: string;
  file_number: number;
  folder_number: number;
  parent_folder_id: string;
}

export interface ImaKnowledgePage {
  documents: ImaDocument[];
  folders: ImaFolder[];
  path: string[];
  next_cursor: string;
  is_end: boolean;
  unverified_documents: number;
}

export interface ImaKnowledgeBase {
  id: string;
  name: string;
  description: string | null;
}

export interface ImaNote {
  note_id: string;
  title: string;
  summary: string;
  folder_name: string;
  created_at: number;
  updated_at: number;
}

export interface ImaNotebook {
  folder_id: string;
  name: string;
  note_number: number;
}

export interface ImaImportedUrl {
  url: string;
  ok: boolean;
  media_id: string;
  code: number;
}

export interface ImaPageCursor {
  next_cursor: string;
  is_end: boolean;
}

function documentFrom(raw: Record<string, unknown>): ImaDocument | null {
  const media_id = text(raw, "media_id");
  const title = text(raw, "title");
  if (!media_id && !title) return null;
  return {
    media_id,
    title: title || media_id,
    parent_folder_id: text(raw, "parent_folder_id"),
    highlight: text(raw, "highlight_content"),
  };
}

function embeddedFolderMediaId(raw: Record<string, unknown>): string {
  const media_id = text(raw, "media_id");
  if (!media_id) return "";
  if (media_id.startsWith(FOLDER_MEDIA_ID_PREFIX)) return media_id;
  if (intOf(raw["media_type"]) === FOLDER_MEDIA_TYPE) return media_id;
  return "";
}

function isDocumentArrayFolder(raw: Record<string, unknown>): boolean {
  if (text(raw, "folder_id") && !text(raw, "media_id")) return true;
  if (embeddedFolderMediaId(raw)) return true;
  const media_type = raw["media_type"];
  return media_type !== null && media_type !== undefined && intOf(media_type) === FOLDER_MEDIA_TYPE;
}

function folderFrom(raw: Record<string, unknown>): ImaFolder | null {
  const folder_id = text(raw, "folder_id") || embeddedFolderMediaId(raw);
  if (!folder_id) return null;
  return {
    folder_id,
    name: text(raw, "name") || text(raw, "title") || folder_id,
    file_number: intOf(raw["file_number"]),
    folder_number: intOf(raw["folder_number"]),
    parent_folder_id: text(raw, "parent_folder_id"),
  };
}

function breadcrumb(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = text(entry, "name");
    if (name) names.push(name);
  }
  return names;
}

export function parseKnowledgePage(data: Record<string, unknown>): ImaKnowledgePage {
  const documents: ImaDocument[] = [];
  const folders: ImaFolder[] = [];
  const seenDocuments = new Set<string>();
  const seenFolders = new Set<string>();
  let unverified = 0;

  for (const raw of entries(data, DOCUMENT_KEYS)) {
    if (isDocumentArrayFolder(raw)) {
      const folder = folderFrom(raw);
      if (folder && !seenFolders.has(folder.folder_id)) {
        seenFolders.add(folder.folder_id);
        folders.push(folder);
      }
      continue;
    }
    const document = documentFrom(raw);
    if (document === null) unverified += 1;
    if (document && !seenDocuments.has(document.media_id)) {
      seenDocuments.add(document.media_id);
      documents.push(document);
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
    path: breadcrumb(data["current_path"]),
    next_cursor: String(data["next_cursor"] ?? ""),
    is_end: Boolean(data["is_end"]),
    unverified_documents: unverified,
  };
}

export function parseKnowledgeBases(
  data: Record<string, unknown>,
): { bases: ImaKnowledgeBase[]; cursor: ImaPageCursor } {
  const bases: ImaKnowledgeBase[] = [];
  const seen = new Set<string>();
  for (const raw of entries(data, ["info_list"])) {
    const kb_id = text(raw, "id") || text(raw, "kb_id");
    const name = text(raw, "name") || text(raw, "kb_name");
    if (!kb_id || !name || seen.has(kb_id)) continue;
    seen.add(kb_id);
    bases.push({ id: kb_id, name, description: null });
  }
  return {
    bases,
    cursor: {
      next_cursor: String(data["next_cursor"] ?? ""),
      is_end: Boolean(data["is_end"]),
    },
  };
}

export function parseImportedUrls(data: Record<string, unknown>): ImaImportedUrl[] {
  const results: ImaImportedUrl[] = [];
  for (const raw of entries(data, ["url_data_list", "info_list", "data_list"])) {
    const url = text(raw, "url");
    if (!url) continue;
    const code = intOf(raw["ret_code"]);
    results.push({ url, ok: code === 0, media_id: text(raw, "media_id"), code });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Notes parsing — the notes API nests the same object three ways:
// {"doc": {"basic_info": {...}}}, {"basic_info": {...}}, bare basic-info.
// ---------------------------------------------------------------------------

function basicInfo(raw: unknown, outerKeys: string[]): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  let node: Record<string, unknown> = raw;
  for (const key of outerKeys) {
    const inner = node[key];
    if (isRecord(inner)) node = inner;
  }
  const inner = node["basic_info"];
  if (isRecord(inner)) node = inner;
  return node;
}

export function parseNote(raw: unknown): ImaNote | null {
  const basic = basicInfo(raw, ["doc"]);
  if (basic === null) return null;
  const note_id = text(basic, "docid") || text(basic, "doc_id");
  if (!note_id) return null;
  if (intOf(basic["status"]) === 1) return null; // deleted
  return {
    note_id,
    title: text(basic, "title") || "(untitled)",
    summary: text(basic, "summary"),
    folder_name: text(basic, "folder_name"),
    created_at: intOf(basic["create_time"]),
    updated_at: intOf(basic["modify_time"]),
  };
}

export function parseNotebook(raw: unknown): ImaNotebook | null {
  const basic = basicInfo(raw, ["folder"]);
  if (basic === null) return null;
  const folder_id = text(basic, "folder_id");
  if (!folder_id || intOf(basic["status"]) === 1) return null;
  return {
    folder_id,
    name: text(basic, "name") || "(unnamed)",
    note_number: intOf(basic["note_number"]),
  };
}

export function notesFrom(
  data: Record<string, unknown>,
  keys: string[],
): ImaNote[] {
  for (const key of keys) {
    const rawList = data[key];
    if (!Array.isArray(rawList)) continue;
    const notes = rawList
      .map(parseNote)
      .filter((n): n is ImaNote => n !== null);
    if (notes.length || rawList.length) return notes;
  }
  return [];
}

export function cursorOf(data: Record<string, unknown>): ImaPageCursor {
  return {
    next_cursor: String(data["next_cursor"] ?? ""),
    is_end: Boolean(data["is_end"]),
  };
}

/** The note id behind a note-type knowledge item, if this item is one. */
export function linkedNoteId(info: Record<string, unknown>): string {
  const noteInfo = info["notebook_ext_info"];
  if (intOf(info["media_type"]) !== NOTE_MEDIA_TYPE || !isRecord(noteInfo)) {
    return "";
  }
  return String(noteInfo["notebook_id"] ?? noteInfo["doc_id"] ?? "").trim();
}
