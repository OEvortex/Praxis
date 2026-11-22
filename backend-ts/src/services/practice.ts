// and the data access behind api/routers/practice.py.
//
// Upstream stores review state in SQL tables beside `notebook_entries`. This
// backend keeps notebook entries as ext_items JSON, so the practice store is
// implemented over ext_items collections in the shared database:
//   "question-notebook/entries"  — the questions themselves (existing store)
//   "practice/state"             — review state keyed by entry id
//   "practice/events"            — review events keyed by request_id
//   "practice/imports"           — staged imports keyed by token
import { createHash, randomUUID } from "node:crypto";
import type { Settings } from "../config.js";
import * as database from "../store/database.js";
import { readZip } from "../shared/zip.js";

type AnyDict = Record<string, any>;
const DAY = 86400;
export type Rating = "again" | "hard" | "good" | "easy";

export class ReviewConflict extends Error {}

// -- scheduler ----------------------------------------------------------------

export function dayBounds(timezone: string, now: number): [number, number] {
  // Compute local-midnight bounds for `timezone` using Intl offsets.
  const offsetAt = (ts: number): number => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = dtf.formatToParts(new Date(ts * 1000));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
    return (asUTC - ts * 1000) / 1000; // local - utc offset in seconds
  };
  // Find the UTC instant of local midnight today.
  const localNow = now + offsetAt(now);
  const localMidnight = Math.floor(localNow / DAY) * DAY; // local epoch day
  // Convert local-midnight back to UTC: iterate offset (DST-safe enough).
  let start = localMidnight - offsetAt(localMidnight - offsetAt(now));
  start = localMidnight - offsetAt(start);
  const end = start + DAY; // approximate; DST edge acceptable for this port
  return [start, end];
}

export function schedule(state: AnyDict, rating: Rating, now: number): AnyDict {
  let interval = Number(state.interval_days ?? 1);
  let ease = Number(state.ease ?? 2.5);
  let streak = Number(state.streak ?? 0);
  let lapses = Number(state.lapses ?? 0);
  if (rating === "again") {
    interval = 10 / 1440;
    streak = 0;
    lapses += 1;
    ease = Math.max(1.3, ease - 0.2);
  } else if (rating === "hard") {
    interval = Math.max(1.0, interval * 1.2);
    ease = Math.max(1.3, ease - 0.15);
    streak = 0;
  } else if (rating === "good" || rating === "easy") {
    interval = interval <= 1 || !state.review_count ? 3.0 : interval * ease;
    if (rating === "easy") {
      interval *= 1.3;
      ease = Math.min(3.0, ease + 0.15);
    }
    streak += 1;
  } else {
    throw new Error("Unknown review rating");
  }
  interval = Math.min(365.0, Math.round(interval * 1000) / 1000);
  return {
    interval_days: interval,
    ease,
    streak,
    lapses,
    due_at: now + interval * DAY,
    last_review_at: now,
    review_count: Number(state.review_count ?? 0) + 1,
    version: Number(state.version ?? 0) + 1,
  };
}

// -- answers ------------------------------------------------------------------

function trueFalse(value: unknown): boolean | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(text)) return true;
  if (["false", "f", "no", "n", "0"].includes(text)) return false;
  return null;
}

export function checkAnswer(entry: AnyDict, answer: string): boolean | null {
  const kind = String(entry.question_type ?? "");
  let options = entry.options;
  if (options == null && entry.options_json) {
    try { options = JSON.parse(String(entry.options_json)); } catch { options = {}; }
  }
  options = options ?? {};
  if ((kind === "concept" || kind === "true_false") && !Object.keys(options).length) {
    const expected = trueFalse(entry.correct_answer);
    if (expected === null) return null;
    return trueFalse(answer) === expected;
  }
  const expected = String(entry.correct_answer ?? "").trim();
  if (!Object.keys(options).length || !expected ||
      ["qualitative", "short_answer", "essay", "free_response"].includes(kind)) {
    return null;
  }
  const folded = (t: string) => t.trim().toUpperCase().split(/\s+/).join(" ");
  const keys = (value: string): Set<string> => {
    const out = new Set<string>();
    for (const [key, text] of Object.entries(options as AnyDict)) {
      const candidates = [folded(key), folded(String(text)), folded(`${key}. ${text}`), folded(`${key}) ${text}`)];
      if (candidates.includes(folded(value))) { out.add(key); return out; }
    }
    let parts = new Set(
      String(value).trim().toUpperCase().split(/[,;\s]+/).filter(Boolean),
    );
    if (["multi_choice", "multiple_select"].includes(kind) && parts.size === 1 && ![...parts].every((p) => p in options)) {
      parts = new Set(String(value).trim().toUpperCase().split(""));
    }
    return parts;
  };
  const expectedKeys = keys(expected);
  const actualKeys = keys(answer);
  if (!expectedKeys.size || ![...expectedKeys].every((k) => k in options)) return null;
  return actualKeys.size > 0 && [...expectedKeys].every((k) => actualKeys.has(k)) &&
    [...actualKeys].every((k) => expectedKeys.has(k));
}

// -- importing ----------------------------------------------------------------

export const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 500;
const MAX_CELL = 20000;
const MAX_COLUMNS = 64;

const ALIASES: Record<string, string[]> = {
  question: ["question"],
  question_type: ["question_type", "type"],
  correct_answer: ["correct_answer", "answer"],
  explanation: ["explanation"],
  difficulty: ["difficulty"],
  tags: ["tags"],
  user_answer: ["user_answer"],
  options: ["options"],
};

const TYPES: Record<string, string> = {
  single_choice: "single_choice", multiple_choice: "single_choice", mcq: "single_choice",
  multi_choice: "multi_choice",
  true_false: "true_false",
  fill_blank: "fill_blank",
  short_answer: "short_answer",
  essay: "short_answer", "free_response": "short_answer",
};

function cell(value: unknown): string {
  const text = value == null ? "" : String(value).trim();
  if (text.length > MAX_CELL) throw new Error("A cell exceeds 20,000 characters");
  return text;
}

/** Minimal RFC-4180 CSV parser (handles quotes, embedded newlines/commas). */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS + 1) throw new Error("Import at most 500 questions at a time");
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sniffDelimiter(content: string): string {
  const first = content.slice(0, 8192).split("\n")[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, first.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

function colIndex(name: string): number {
  // A=0 ... Z=25, AA=26 ...
  let n = 0;
  for (const ch of name.toUpperCase()) {
    if (ch < "A" || ch > "Z") return -1;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function xlsxRows(data: Buffer): unknown[][] {
  const entries = readZip(data, 2000);
  const total = entries.reduce((s, e) => s + e.size, 0);
  if (total > 30 * 1024 * 1024) throw new Error("The expanded workbook exceeds 30 MB");
  const byName = new Map(entries.map((e) => [e.name, e]));
  // shared strings
  const shared: string[] = [];
  const ss = byName.get("xl/sharedStrings.xml");
  if (ss) {
    const xml = ss.data.toString("utf8");
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]));
      shared.push(texts.join(""));
    }
  }
  // first worksheet
  const sheetName = [...byName.keys()].find((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)) ??
    [...byName.keys()].find((n) => n.startsWith("xl/worksheets/"));
  if (!sheetName) throw new Error("The workbook has no worksheet");
  const xml = byName.get(sheetName)!.data.toString("utf8");
  const rows: unknown[][] = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const cells: unknown[] = [];
    const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] ?? cm[3] ?? "";
      const inner = cm[2] ?? "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "";
      const idx = ref ? colIndex(ref) : cells.length;
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let value: unknown = "";
      const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const is = /<is>([\s\S]*?)<\/is>/.exec(inner)?.[1];
      if (is) {
        value = [...is.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join("");
      } else if (v !== undefined) {
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = decodeXml(v);
        else if (type === "b") value = v === "1";
        else value = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : decodeXml(v);
      }
      while (cells.length <= idx) cells.push("");
      cells[idx] = value;
      if (cells.length > MAX_COLUMNS) throw new Error("Import at most 64 columns at a time");
    }
    rows.push(cells);
    if (rows.length > MAX_ROWS + 1) throw new Error("Import at most 500 questions at a time");
  }
  return rows;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

export function parseRows(data: Buffer, filename: string): [number, AnyDict][] {
  if (!data.length || data.length > MAX_BYTES) throw new Error("Choose a non-empty file up to 5 MB");
  const suffix = (filename.match(/\.[A-Za-z0-9]+$/) ?? [""])[0].toLowerCase();
  let rows: unknown[][];
  if (suffix === ".json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8").replace(/^﻿/, ""));
    } catch {
      throw new Error("JSON must contain an array of question objects");
    }
    if (!Array.isArray(parsed) || parsed.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
      throw new Error("JSON must contain an array of question objects");
    }
    if (parsed.length > MAX_ROWS) throw new Error("Import at most 500 questions at a time");
    return parsed.map((row, i) => [i + 1, row as AnyDict]);
  }
  if (suffix === ".csv" || suffix === ".tsv") {
    let content = data.toString("utf8").replace(/^﻿/, "");
    const delim = suffix === ".tsv" ? "\t" : sniffDelimiter(content);
    rows = parseCsv(content, delim);
  } else if (suffix === ".xlsx") {
    rows = xlsxRows(data);
  } else {
    throw new Error("Supported formats: .xlsx, .csv, .tsv and .json");
  }
  if (!rows.length) throw new Error("The file is empty");
  const headers = rows[0].map((v) => cell(v).toLowerCase());
  const nonempty = headers.filter(Boolean);
  if (new Set(nonempty).size !== nonempty.length) throw new Error("Column names must be unique");
  if (rows.length > MAX_ROWS + 1) throw new Error("Import at most 500 questions at a time");
  return rows.slice(1)
    .map((row, i) => [i + 2, Object.fromEntries(headers.map((h, j) => [h, row[j]]))] as [number, AnyDict])
    .filter(([, row]) => Object.values(row).some((v) => cell(v) !== ""));
}

export function normalizeQuestion(raw: AnyDict): AnyDict {
  const row: AnyDict = {};
  for (const [k, v] of Object.entries(raw)) row[String(k).trim().toLowerCase()] = v;
  const fields: AnyDict = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    fields[key] = names.map((a) => row[a]).find((v) => v !== undefined) ?? "";
  }
  const question = cell(fields.question);
  let answer = cell(fields.correct_answer);
  if (!question || !answer) throw new Error("Question and correct answer are required");
  let options = fields.options ?? {};
  if (typeof options === "string") {
    try { options = JSON.parse(options); } catch { throw new Error("Options must be valid JSON or a list"); }
  }
  if (Array.isArray(options)) {
    options = Object.fromEntries(options.map((v, i) => [String.fromCharCode(65 + i), v]));
  }
  if (typeof options !== "object" || options === null || Array.isArray(options) || Object.keys(options).length > 10) {
    throw new Error("Options must contain at most 10 named choices");
  }
  options = Object.fromEntries(
    Object.entries(options as AnyDict)
      .map(([k, v]) => [String(k).trim().toUpperCase(), cell(v)] as const)
      .filter(([, v]) => v !== ""),
  );
  for (let i = 0; i < 10; i++) {
    const letter = String.fromCharCode(65 + i);
    const value = cell(row[letter.toLowerCase()] ?? "");
    if (value) (options as AnyDict)[letter] = value;
  }
  const rawType = cell(fields.question_type).toLowerCase();
  let kind = rawType ? TYPES[rawType] : Object.keys(options).length ? "single_choice" : "short_answer";
  if (kind === undefined) throw new Error("Unknown question type");
  if (kind === "true_false") {
    const truths = new Set(["true", "yes", "y", "t", "1"]);
    const falses = new Set(["false", "no", "n", "f", "0"]);
    const lowered = answer.toLowerCase();
    if (!truths.has(lowered) && !falses.has(lowered)) {
      throw new Error("A true/false answer must be true or false");
    }
    options = { T: "True", F: "False" };
    answer = truths.has(lowered) ? "T" : "F";
  }
  if (kind === "single_choice" || kind === "multi_choice") {
    if (Object.keys(options).length < 2) throw new Error("Choice questions need at least two options");
    const optValues = options as AnyDict;
    if (Object.values(optValues).includes(answer)) {
      answer = Object.keys(optValues).find((k) => optValues[k] === answer) ?? answer;
    }
    let keys = answer.split(/[,;\s]+/).map((k) => k.trim().toUpperCase()).filter(Boolean);
    if (kind === "multi_choice" && keys.length === 1 && !(keys[0] in optValues)) {
      keys = keys[0].split("");
    }
    if (!keys.length || keys.some((k) => !(k in optValues)) || (kind === "single_choice" && keys.length !== 1)) {
      throw new Error("The answer must name existing option keys (multi-choice: A,C)");
    }
    answer = [...new Set(keys)].sort().join(",");
  }
  const tagsValue = fields.tags;
  const tags = Array.isArray(tagsValue)
    ? tagsValue
    : String(tagsValue ?? "").split(/[,;，；]/);
  const cleanTags = [...new Set(tags.map((t: unknown) => cell(t)).filter(Boolean))];
  if (cleanTags.length > 20 || cleanTags.some((t) => t.length > 100)) {
    throw new Error("Use at most 20 tags, each up to 100 characters");
  }
  const result: AnyDict = {
    question, question_type: kind, options, correct_answer: answer,
    explanation: cell(fields.explanation), difficulty: cell(fields.difficulty),
    user_answer: cell(fields.user_answer), tags: cleanTags,
  };
  const identity = {
    question: result.question, question_type: result.question_type,
    options: result.options, correct_answer: result.correct_answer,
  };
  result.question_id = "import:" + createHash("sha256")
    .update(JSON.stringify(identity, Object.keys(identity).sort()))
    .digest("hex");
  return result;
}

export function previewImport(data: Buffer, filename: string): { questions: AnyDict[]; errors: { row: number; message: string }[] } {
  const questions: AnyDict[] = [];
  const errors: { row: number; message: string }[] = [];
  for (const [number, row] of parseRows(data, filename)) {
    try {
      questions.push(normalizeQuestion(row));
    } catch (exc) {
      errors.push({ row: number, message: exc instanceof Error ? exc.message : String(exc) });
    }
  }
  if (!questions.length && !errors.length) throw new Error("The file contains no questions");
  return { questions, errors };
}

// -- store --------------------------------------------------------------------

function stateKey(entryId: number | string): string {
  return `state/${entryId}`;
}

export class PracticeStore {
  constructor(private settings: Settings) {}

  private entries(): AnyDict[] {
    return database.list_items(this.settings, "question-notebook/entries");
  }

  private getEntry(entryId: number): AnyDict | null {
    return database.get_item(this.settings, "question-notebook/entries", String(entryId));
  }

  private putEntry(entry: AnyDict): void {
    database.put_item(this.settings, "question-notebook/entries", entry);
  }

  private getState(entryId: number): AnyDict {
    const stored = database.get_item(this.settings, "practice/state", String(entryId));
    return stored ?? {
      entry_id: entryId, is_mistake: 0, version: 0, review_count: 0,
      interval_days: 1, due_at: null,
    };
  }

  private putState(entryId: number, state: AnyDict): void {
    database.put_item(this.settings, "practice/state", { ...state, entry_id: entryId });
  }

  /** Mirror of upstream is_visible: entry exists (sessions join skipped —
      imported entries have no session). */
  isVisible(entryId: number): boolean {
    return this.getEntry(entryId) !== null;
  }

  overview(timezone: string, now = Date.now() / 1000): AnyDict {
    let start: number, end: number;
    try {
      [start, end] = dayBounds(timezone, now);
    } catch (exc) {
      throw new Error(exc instanceof Error ? exc.message : String(exc));
    }
    const states = new Map(
      database.list_items(this.settings, "practice/state").map((s) => [Number(s.entry_id), s]),
    );
    const entries = this.entries();
    const events = database.list_items(this.settings, "practice/events");
    let total = 0, mistakes = 0, due = 0, overdue = 0, nextDue: number | null = null;
    for (const entry of entries) {
      const id = Number(entry.id);
      if (!Number.isFinite(id)) continue;
      total++;
      const st = states.get(id);
      const dueAt = Number(st?.due_at ?? entry.created_at ?? entry.updated_at ?? 0);
      if (st?.is_mistake) mistakes++;
      if (dueAt <= now) due++;
      if (dueAt <= start) overdue++;
      if (nextDue === null || dueAt < nextDue) nextDue = dueAt;
    }
    const reviewedToday = events.filter((e) => {
      const t = Number(e.reviewed_at ?? 0);
      return t >= start && t < end;
    }).length;
    return {
      total, mistakes, due, overdue, reviewed_today: reviewedToday,
      next_due_at: nextDue, day_end: end, timezone,
    };
  }

  analytics(timezone: string, days: number, now = Date.now() / 1000): AnyDict {
    let startToday: number;
    try { [startToday] = dayBounds(timezone, now); } catch (exc) {
      throw new Error(exc instanceof Error ? exc.message : String(exc));
    }
    if (![7, 30, 90].includes(days)) throw new Error("Choose 7, 30 or 90 days");
    const DAY_COUNT = days;
    // Build day list ending today (local). Approximate via UTC days.
    const daily: AnyDict[] = [];
    const byDate = new Map<string, AnyDict>();
    const todayStr = new Date(now * 1000).toISOString().slice(0, 10);
    for (let i = DAY_COUNT - 1; i >= 0; i--) {
      const d = new Date(Date.parse(todayStr) - i * DAY * 1000).toISOString().slice(0, 10);
      const row = { date: d, questions: 0, mistakes: 0, reviews: 0 };
      daily.push(row);
      byDate.set(d, row);
    }
    const sources = new Map<string, AnyDict>();
    const bump = (dayTs: number, source: string, metric: string) => {
      const day = new Date(dayTs * 1000).toISOString().slice(0, 10);
      const dRow = byDate.get(day);
      if (!dRow) return;
      dRow[metric]++;
      const sRow = sources.get(source) ?? { source, questions: 0, mistakes: 0, reviews: 0 };
      sRow[metric]++;
      sources.set(source, sRow);
    };
    const states = new Map(
      database.list_items(this.settings, "practice/state").map((s) => [Number(s.entry_id), s]),
    );
    const rangeStart = now - DAY_COUNT * DAY;
    for (const entry of this.entries()) {
      const id = Number(entry.id);
      if (!Number.isFinite(id)) continue;
      const source = String(entry.source || "deep_question") || "deep_question";
      const created = Number(entry.created_at ?? 0);
      if (created >= rangeStart && created <= now) bump(created, source, "questions");
      const st = states.get(id);
      const firstWrong = Number(st?.first_wrong_at ?? 0);
      if (st?.is_mistake && firstWrong >= rangeStart && firstWrong <= now) {
        bump(firstWrong, source, "mistakes");
      }
      const events = database.list_items(this.settings, "practice/events");
      for (const e of events) {
        if (Number(e.entry_id) !== id) continue;
        const t = Number(e.reviewed_at ?? 0);
        if (t >= rangeStart && t <= now) bump(t, source, "reviews");
      }
    }
    const totals = { questions: 0, mistakes: 0, reviews: 0 };
    for (const row of daily) {
      totals.questions += row.questions;
      totals.mistakes += row.mistakes;
      totals.reviews += row.reviews;
    }
    return {
      timezone, days,
      start_date: daily[0]?.date ?? "", end_date: daily[daily.length - 1]?.date ?? "",
      updated_at: now, daily, sources: [...sources.values()].sort((a, b) => String(a.source).localeCompare(String(b.source))), totals,
    };
  }

  queue(timezone: string, categoryId: number | null, limit: number, now = Date.now() / 1000): number[] {
    try { dayBounds(timezone, now); } catch (exc) {
      throw new Error(exc instanceof Error ? exc.message : String(exc));
    }
    const states = new Map(
      database.list_items(this.settings, "practice/state").map((s) => [Number(s.entry_id), s]),
    );
    const due: { id: number; dueAt: number }[] = [];
    for (const entry of this.entries()) {
      const id = Number(entry.id);
      if (!Number.isFinite(id)) continue;
      if (categoryId != null) {
        const cats = Array.isArray(entry.category_ids) ? entry.category_ids : Array.isArray(entry.categories) ? entry.categories : [];
        const catIds = cats.map((c: unknown) => Number(typeof c === "object" ? (c as AnyDict).id : c));
        if (!catIds.includes(categoryId)) continue;
      }
      const st = states.get(id);
      const dueAt = Number(st?.due_at ?? entry.created_at ?? entry.updated_at ?? 0);
      if (dueAt <= now) due.push({ id, dueAt });
    }
    due.sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
    return due.slice(0, limit).map((d) => d.id);
  }

  state(entryId: number): AnyDict {
    const st = this.getState(entryId);
    return {
      version: Number(st.version ?? 0),
      review_count: Number(st.review_count ?? 0),
      is_mistake: !!Number(st.is_mistake),
      due_at: st.due_at ?? null,
      interval_days: Number(st.interval_days ?? 1),
      ease: Number(st.ease ?? 2.5),
      streak: Number(st.streak ?? 0),
      lapses: Number(st.lapses ?? 0),
      last_review_at: st.last_review_at ?? null,
    };
  }

  review(
    entryId: number,
    requestId: string,
    version: number,
    rating: Rating,
    answer: string,
    selfReport = false,
    now = Date.now() / 1000,
  ): AnyDict {
    const settings = this.settings;
    // Idempotent replay by request_id.
    const previous = database.get_item(settings, "practice/events", requestId);
    if (previous) {
      if (
        Number(previous.entry_id) !== entryId ||
        previous.rating !== rating ||
        previous.answer !== answer ||
        !!previous.self_report !== selfReport
      ) {
        throw new ReviewConflict("This submission ID was already used for a different answer");
      }
      return (previous.outcome ?? {}) as AnyDict;
    }
    const entry = this.getEntry(entryId);
    if (!entry) throw new Error(`LookupError:${entryId}`);
    const state = this.getState(entryId);
    if (Number(state.version ?? 0) !== version) {
      throw new ReviewConflict("This question changed in another tab. Reload it before reviewing again.");
    }
    const correct = selfReport ? null : checkAnswer(entry, answer);
    if (correct === false && rating !== "again") {
      throw new Error("An incorrect answer must be reviewed again");
    }
    const next = schedule(state, rating, now);
    const mistake = !!Number(state.is_mistake) || rating === "again";
    const merged: AnyDict = {
      ...next,
      is_mistake: mistake ? 1 : 0,
      first_wrong_at: Number(state.is_mistake) || !mistake ? state.first_wrong_at ?? now : now,
    };
    if (rating === "again") {
      entry.resolved = 0;
      this.putEntry(entry);
    }
    this.putState(entryId, merged);
    const outcome: AnyDict = {
      ...next,
      entry_id: entryId,
      is_mistake: mistake,
      correct,
      rating,
      self_report: selfReport,
      mastered: rating === "good" || rating === "easy",
    };
    database.put_item(settings, "practice/events", {
      id: requestId,
      entry_id: entryId,
      rating,
      answer,
      reviewed_at: now,
      self_report: selfReport,
      outcome,
    });
    return outcome;
  }

  stageImport(filename: string, target: string, questions: AnyDict[]): string {
    const token = randomUUID().replace(/-/g, "");
    const now = Date.now() / 1000;
    // Drop stale unstaged imports older than a day.
    for (const item of database.list_items(this.settings, "practice/imports")) {
      if (!item.result && Number(item.created_at ?? 0) < now - DAY) {
        database.delete_item(this.settings, "practice/imports", String(item.id ?? item.token));
      }
    }
    database.put_item(this.settings, "practice/imports", {
      id: token,
      token,
      filename: String(filename).slice(0, 200),
      target,
      questions,
      created_at: now,
    });
    return token;
  }

  commitImport(token: string, now = Date.now() / 1000): AnyDict {
    const settings = this.settings;
    const staged = database.get_item(settings, "practice/imports", token);
    if (!staged) throw new Error(`LookupError:${token}`);
    if (staged.result) return staged.result as AnyDict;
    if (now - Number(staged.created_at ?? 0) > DAY) {
      throw new Error("Import preview expired. Select the file again.");
    }
    const questions = Array.isArray(staged.questions) ? staged.questions : [];
    const originRef = "practice-import";
    let created = 0;
    let skipped = 0;
    const existing = this.entries();
    const byQid = new Map(existing.map((e) => [String(e.question_id ?? ""), e]));
    let nextId = existing.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) + 1;
    for (const q of questions) {
      const qid = String(q.question_id ?? "");
      let entry = byQid.get(qid);
      if (!entry) {
        entry = {
          id: nextId++,
          session_id: null,
          origin_type: "external_import",
          origin_ref: originRef,
          question_id: qid,
          question: q.question,
          question_type: q.question_type,
          options: q.options ?? {},
          options_json: JSON.stringify(q.options ?? {}),
          correct_answer: q.correct_answer,
          explanation: q.explanation ?? "",
          difficulty: q.difficulty ?? "",
          user_answer: q.user_answer ?? "",
          source: "import",
          result: staged.target === "mistakes" ? "incorrect" : "ungraded",
          assessment_type: "quiz",
          material_title: staged.filename,
          material_id: `import:${token}`,
          tags: q.tags ?? [],
          created_at: now,
          updated_at: now,
        };
        database.put_item(settings, "question-notebook/entries", entry);
        byQid.set(qid, entry);
        created++;
      } else {
        skipped++;
      }
      const entryId = Number(entry.id);
      if (staged.target === "mistakes") {
        const st = this.getState(entryId);
        if (!Number(st.review_count ?? 0) && !st.first_wrong_at) {
          this.putState(entryId, {
            ...st, is_mistake: 1, first_wrong_at: now, due_at: now + DAY,
            interval_days: 1,
          });
        } else if (!Number(st.is_mistake)) {
          this.putState(entryId, { ...st, is_mistake: 1, first_wrong_at: now, due_at: now + DAY, interval_days: 1, version: Number(st.version ?? 0) + 1 });
        }
      }
      // Tags → categories (best effort, matching upstream notebook_categories).
      for (const tag of (q.tags ?? []) as string[]) {
        const catId = `cat-${String(tag).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        if (!database.get_item(settings, "question-notebook/categories", catId)) {
          database.put_item(settings, "question-notebook/categories", { id: catId, name: tag, created_at: now });
        }
        const cats = Array.isArray(entry.category_ids) ? [...entry.category_ids] : [];
        if (!cats.includes(Number.NaN) && !cats.map(String).includes(catId)) {
          cats.push(catId);
          entry.category_ids = cats;
          database.put_item(settings, "question-notebook/entries", entry);
        }
      }
    }
    const result = { created, duplicates: skipped, total: created + skipped };
    database.put_item(settings, "practice/imports", { ...staged, result, questions: [] });
    return result;
  }
}
