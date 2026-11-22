// quiz-question notebook entries, bookmarks and categories.
//
// Upstream persists via the SQLite session store (notebook_entries +
// notebook_categories + join table). The TS backend has no session-store
// notebook schema, so entries/categories live in the shared ext_items store
// under collections "question-notebook/entries" and
// "question-notebook/categories" — the same collections the legacy shim in
// handlers.ts writes to, so data is shared.
import { get_settings } from "../config.js";
import type { Settings } from "../config.js";
import * as database from "../store/database.js";

type Rec = Record<string, any>;

const ENTRIES = "question-notebook/entries";
const CATEGORIES = "question-notebook/categories";

function now(): number {
  return Date.now() / 1000;
}

function normStr(v: unknown): string {
  return String(v ?? "").trim();
}

// -- entries -------------------------------------------------------------------

function entryDefaults(item: Rec): Rec {
  const out: Rec = { ...item };
  const defs: Record<string, unknown> = {
    session_id: "",
    origin_type: "conversation",
    origin_ref: "",
    turn_id: "",
    question_id: "",
    question_type: "",
    options: {},
    correct_answer: "",
    explanation: "",
    difficulty: "",
    user_answer: "",
    user_answer_images: [],
    source: "deep_question",
    material_id: "",
    material_title: "",
    section_id: "",
    section_title: "",
    score_trend: "new",
    assessment_type: "",
    result: "",
    mastery_path_id: "",
    knowledge_point_id: "",
    attempt_count: 1,
    hints_used: 0,
    confidence: null,
    response_time: null,
    quality: null,
    is_correct: false,
    resolved: false,
    bookmarked: false,
    followup_session_id: "",
    ai_judgment: "",
    categories: [],
    practice: null,
  };
  for (const [k, v] of Object.entries(defs)) {
    if (out[k] === undefined || out[k] === null) out[k] = v;
  }
  if (typeof out.options !== "object" || out.options === null || Array.isArray(out.options)) {
    out.options = {};
  }
  if (!Array.isArray(out.user_answer_images)) out.user_answer_images = [];
  if (!Array.isArray(out.categories)) out.categories = [];
  return out;
}

function nextEntryId(settings: Settings): number {
  let max = 0;
  for (const e of database.list_items(settings, ENTRIES) as Rec[]) {
    const id = Number(e.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  // ext_items may also hold legacy string ids; skip them.
  return max + 1;
}

function findByOrigin(
  settings: Settings, originType: string, originRef: string, questionId: string, turnId?: string | null,
): Rec | null {
  for (const e of database.list_items(settings, ENTRIES) as Rec[]) {
    if (String(e.origin_type ?? "") !== originType) continue;
    if (String(e.origin_ref ?? "") !== originRef) continue;
    if (String(e.question_id ?? "") !== questionId) continue;
    if (turnId !== undefined && turnId !== null && String(e.turn_id ?? "") !== String(turnId)) continue;
    return e;
  }
  return null;
}

export interface UpsertPayload {
  session_id?: string;
  origin_type?: string;
  origin_ref?: string;
  turn_id?: string;
  question_id?: string;
  question?: string;
  question_type?: string;
  options?: Record<string, string> | null;
  correct_answer?: string;
  explanation?: string;
  difficulty?: string;
  user_answer?: string;
  user_answer_images?: Array<Record<string, unknown>> | null;
  source?: string;
  material_id?: string;
  material_title?: string;
  section_id?: string;
  section_title?: string;
  is_correct?: boolean;
  assessment_type?: string;
  result?: string;
  mastery_path_id?: string;
  knowledge_point_id?: string;
  attempt_count?: number;
  hints_used?: number;
  confidence?: number | null;
  response_time?: number | null;
  quality?: number | null;
}

export function upsertEntry(payload: UpsertPayload, settings?: Settings): Rec {
  const s = settings ?? get_settings();
  const originType = normStr(payload.origin_type) || "conversation";
  let sessionId = normStr(payload.session_id);
  let originRef = normStr(payload.origin_ref);
  if (originType === "conversation") {
    if (!sessionId) throw new Error("conversation entries require session_id");
    if (originRef && originRef !== sessionId) {
      throw new Error("conversation origin_ref must match session_id");
    }
    originRef = sessionId;
  } else if (!originRef) {
    throw new Error(`${originType} entries require origin_ref`);
  }
  const questionId = normStr(payload.question_id);
  const existing = findByOrigin(s, originType, originRef, questionId, payload.turn_id);

  // Persist answer images: base64 becomes a data: URL (no AttachmentStore port).
  let images: Array<Record<string, string>> | undefined;
  if (payload.user_answer_images !== undefined && payload.user_answer_images !== null) {
    images = [];
    for (const image of payload.user_answer_images) {
      const recordId = normStr(image.id) || Math.random().toString(36).slice(2, 14);
      const filename = normStr(image.filename) || "answer.png";
      const mimeType = normStr(image.mime_type) || "image/png";
      let url = normStr(image.url);
      const b64 = normStr(image.base64);
      if (!url && b64) {
        const clean = b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
        url = `data:${mimeType};base64,${clean}`;
      }
      if (!url) continue;
      images.push({ id: recordId, url, filename, mime_type: mimeType });
    }
  }

  const ts = now();
  const item: Rec = entryDefaults({
    ...(existing ?? {}),
    ...payload,
    session_id: sessionId,
    origin_type: originType,
    origin_ref: originRef,
    question_id: questionId,
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  });
  if (images !== undefined) item.user_answer_images = images;
  if (!existing) {
    item.id = nextEntryId(s);
    item.created_at = ts;
  }
  database.put_item(s, ENTRIES, item);
  const saved = findByOrigin(s, originType, originRef, questionId, payload.turn_id);
  if (!saved) throw new Error("Upsert failed");
  return saved;
}

export interface ListFilter {
  category_id?: number | null;
  mistakes_only?: boolean;
  uncategorized?: boolean;
  bookmarked?: boolean | null;
  is_correct?: boolean | null;
  source?: string;
  material_id?: string;
  section_id?: string;
  assessment_type?: string;
  result?: string;
  mastery_path_id?: string;
  knowledge_point_id?: string;
  resolved?: boolean | null;
  score_trend?: string;
  search?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

function entryCategories(entry: Rec): number[] {
  return (Array.isArray(entry.categories) ? entry.categories : [])
    .map((c) => Number(c))
    .filter((n) => Number.isFinite(n));
}

export function listEntries(filter: ListFilter, settings?: Settings): { items: Rec[]; total: number } {
  const s = settings ?? get_settings();
  let items = (database.list_items(s, ENTRIES) as Rec[]).map(entryDefaults);
  const f = filter;
  if (f.category_id !== undefined && f.category_id !== null) {
    items = items.filter((e) => entryCategories(e).includes(Number(f.category_id)));
  } else if (f.uncategorized) {
    items = items.filter((e) => entryCategories(e).length === 0);
  }
  if (f.mistakes_only) items = items.filter((e) => e.is_correct === false);
  if (f.bookmarked !== undefined && f.bookmarked !== null) {
    items = items.filter((e) => Boolean(e.bookmarked) === Boolean(f.bookmarked));
  }
  if (f.is_correct !== undefined && f.is_correct !== null) {
    items = items.filter((e) => Boolean(e.is_correct) === Boolean(f.is_correct));
  }
  if (f.source) items = items.filter((e) => String(e.source ?? "") === f.source);
  if (f.material_id) items = items.filter((e) => String(e.material_id ?? "") === f.material_id);
  if (f.section_id) items = items.filter((e) => String(e.section_id ?? "") === f.section_id);
  if (f.assessment_type) items = items.filter((e) => String(e.assessment_type ?? "") === f.assessment_type);
  if (f.result) items = items.filter((e) => String(e.result ?? "") === f.result);
  if (f.mastery_path_id) items = items.filter((e) => String(e.mastery_path_id ?? "") === f.mastery_path_id);
  if (f.knowledge_point_id) items = items.filter((e) => String(e.knowledge_point_id ?? "") === f.knowledge_point_id);
  if (f.resolved !== undefined && f.resolved !== null) {
    items = items.filter((e) => Boolean(e.resolved) === Boolean(f.resolved));
  }
  if (f.score_trend) items = items.filter((e) => String(e.score_trend ?? "") === f.score_trend);
  if (f.search) {
    const q = String(f.search).toLowerCase();
    items = items.filter(
      (e) =>
        String(e.question ?? "").toLowerCase().includes(q) ||
        String(e.correct_answer ?? "").toLowerCase().includes(q) ||
        String(e.explanation ?? "").toLowerCase().includes(q),
    );
  }
  items.sort((a, b) => {
    const ka = Number(a.updated_at ?? a.created_at ?? 0);
    const kb = Number(b.updated_at ?? b.created_at ?? 0);
    return f.sort === "oldest" ? ka - kb : kb - ka;
  });
  const total = items.length;
  const limit = Math.min(Math.max(Number(f.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(f.offset ?? 0) || 0, 0);
  return { items: items.slice(offset, offset + limit), total };
}

export function getEntry(entryId: number, settings?: Settings): Rec | null {
  const s = settings ?? get_settings();
  const item = database.get_item(s, ENTRIES, String(entryId));
  return item ? entryDefaults(item) : null;
}

export function lookupEntry(
  args: {
    session_id?: string;
    origin_type?: string;
    origin_ref?: string;
    question_id?: string;
    turn_id?: string | null;
  },
  settings?: Settings,
): Rec | null {
  const s = settings ?? get_settings();
  const originType = args.origin_type || "conversation";
  const sessionId = normStr(args.session_id);
  let resolvedRef = normStr(args.origin_ref) || sessionId;
  if (originType === "conversation" && sessionId && resolvedRef !== sessionId) return null;
  if (!resolvedRef) return null;
  const questionId = normStr(args.question_id);
  if (!questionId) return null;
  return findByOrigin(s, originType, resolvedRef, questionId, args.turn_id);
}

export function updateEntry(
  entryId: number,
  updates: Rec,
  settings?: Settings,
): Rec | null {
  const s = settings ?? get_settings();
  const item = database.get_item(s, ENTRIES, String(entryId));
  if (!item) return null;
  const allowed = ["bookmarked", "followup_session_id", "ai_judgment", "resolved"];
  const patch: Rec = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) patch[key] = updates[key];
  }
  if (!Object.keys(patch).length) return item;
  const merged = entryDefaults({ ...item, ...patch, updated_at: now() });
  database.put_item(s, ENTRIES, merged);
  return merged;
}

export function deleteEntry(entryId: number, settings?: Settings): Rec | null {
  const s = settings ?? get_settings();
  const item = database.get_item(s, ENTRIES, String(entryId));
  if (!item) return null;
  database.delete_item(s, ENTRIES, String(entryId));
  return item;
}

export function linkEntriesToCategory(
  entryIds: number[], categoryId: number, link: boolean, settings?: Settings,
): number {
  const s = settings ?? get_settings();
  let changed = 0;
  for (const rawId of entryIds) {
    const id = Number(rawId);
    const item = database.get_item(s, ENTRIES, String(id));
    if (!item) continue;
    const cats = entryCategories(item);
    const has = cats.includes(Number(categoryId));
    if (link && !has) {
      cats.push(Number(categoryId));
      database.put_item(s, ENTRIES, entryDefaults({ ...item, categories: cats, updated_at: now() }));
      changed += 1;
    } else if (!link && has) {
      database.put_item(
        s, ENTRIES,
        entryDefaults({ ...item, categories: cats.filter((c) => c !== Number(categoryId)), updated_at: now() }),
      );
      changed += 1;
    }
  }
  return changed;
}

export function addEntryToCategory(entryId: number, categoryId: number, settings?: Settings): boolean {
  const s = settings ?? get_settings();
  const item = database.get_item(s, ENTRIES, String(entryId));
  if (!item) return false;
  const cats = entryCategories(item);
  if (cats.includes(Number(categoryId))) return true;
  cats.push(Number(categoryId));
  database.put_item(s, ENTRIES, entryDefaults({ ...item, categories: cats, updated_at: now() }));
  return true;
}

export function removeEntryFromCategory(entryId: number, categoryId: number, settings?: Settings): boolean {
  const s = settings ?? get_settings();
  const item = database.get_item(s, ENTRIES, String(entryId));
  if (!item) return false;
  const cats = entryCategories(item);
  if (!cats.includes(Number(categoryId))) return false;
  database.put_item(
    s, ENTRIES,
    entryDefaults({ ...item, categories: cats.filter((c) => c !== Number(categoryId)), updated_at: now() }),
  );
  return true;
}

// -- overview ---------------------------------------------------------------------

export function questionBankStats(settings?: Settings): Rec {
  const s = settings ?? get_settings();
  const entries = (database.list_items(s, ENTRIES) as Rec[]).map(entryDefaults);
  let uncategorized = 0;
  for (const e of entries) {
    if (entryCategories(e).length === 0) uncategorized += 1;
  }
  return {
    total: entries.length,
    wrong: entries.filter((e) => e.is_correct === false).length,
    unresolved: entries.filter((e) => !e.resolved).length,
    bookmarked: entries.filter((e) => e.bookmarked).length,
    uncategorized,
  };
}

export function listQuestionBankMaterials(settings?: Settings): Rec[] {
  const s = settings ?? get_settings();
  const groups = new Map<string, Rec>();
  for (const e of (database.list_items(s, ENTRIES) as Rec[]).map(entryDefaults)) {
    const source = String(e.source ?? "");
    const materialId = String(e.material_id ?? "");
    if (!materialId) continue;
    const key = `${source}${materialId}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        source,
        material_id: materialId,
        material_title: String(e.material_title ?? ""),
        entry_count: 0,
        unresolved_count: 0,
      };
      groups.set(key, row);
    }
    row.entry_count += 1;
    if (!e.resolved) row.unresolved_count += 1;
  }
  return [...groups.values()];
}

// -- categories ---------------------------------------------------------------------

function categoryEntryCounts(settings: Settings): Map<number, number> {
  const counts = new Map<number, number>();
  for (const e of database.list_items(settings, ENTRIES) as Rec[]) {
    for (const c of entryCategories(e)) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  return counts;
}

function decorateCategory(settings: Settings, item: Rec): Rec {
  const counts = categoryEntryCounts(settings);
  return {
    id: Number(item.id),
    name: String(item.name ?? ""),
    created_at: Number(item.created_at ?? 0),
    entry_count: counts.get(Number(item.id)) ?? 0,
  };
}

function nextCategoryId(settings: Settings): number {
  let max = 0;
  for (const c of database.list_items(settings, CATEGORIES) as Rec[]) {
    const id = Number(c.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}

export function listCategories(settings?: Settings): Rec[] {
  const s = settings ?? get_settings();
  return (database.list_items(s, CATEGORIES) as Rec[])
    .map((c) => decorateCategory(s, c))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

export function createCategory(name: string, settings?: Settings): Rec {
  const s = settings ?? get_settings();
  const trimmed = normStr(name).slice(0, 100);
  if (!trimmed) throw new Error("Category name is required");
  for (const c of database.list_items(s, CATEGORIES) as Rec[]) {
    if (String(c.name ?? "").trim().toLowerCase() === trimmed.toLowerCase()) {
      throw new Error("Category name already exists");
    }
  }
  const item: Rec = { id: nextCategoryId(s), name: trimmed, created_at: now() };
  database.put_item(s, CATEGORIES, item);
  return decorateCategory(s, item);
}

export function renameCategory(categoryId: number, name: string, settings?: Settings): Rec | null {
  const s = settings ?? get_settings();
  const item = database.get_item(s, CATEGORIES, String(categoryId));
  if (!item) return null;
  const trimmed = normStr(name).slice(0, 100);
  if (!trimmed) throw new Error("Category name is required");
  for (const c of database.list_items(s, CATEGORIES) as Rec[]) {
    if (Number(c.id) !== categoryId && String(c.name ?? "").trim().toLowerCase() === trimmed.toLowerCase()) {
      throw new Error("Category name already exists");
    }
  }
  const merged = { ...item, name: trimmed, updated_at: now() };
  database.put_item(s, CATEGORIES, merged);
  return decorateCategory(s, merged);
}

export function deleteCategory(categoryId: number, settings?: Settings): boolean {
  const s = settings ?? get_settings();
  if (!database.get_item(s, CATEGORIES, String(categoryId))) return false;
  // Unlink the category from every entry, mirroring the upstream join-table delete.
  for (const e of database.list_items(s, ENTRIES) as Rec[]) {
    const cats = entryCategories(e);
    if (cats.includes(Number(categoryId))) {
      database.put_item(
        s, ENTRIES,
        entryDefaults({ ...e, categories: cats.filter((c) => c !== Number(categoryId)), updated_at: now() }),
      );
    }
  }
  return database.delete_item(s, CATEGORIES, String(categoryId));
}
