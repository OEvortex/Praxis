// Port of backend/app/services/usage_stats.py — LLM usage accounting behind
// `GET /api/settings/usage`. vtx records provider-reported token usage on every
// assistant message; we reconstruct one `usage_turns` row per model call.
//
// Differences from Python: zoneinfo is replaced by Intl-based timezone
// helpers; everything else maps onto store/database.connect(settings).
import type { DatabaseSync } from "node:sqlite";
import type { Settings } from "../config.js";
import { connect } from "../store/database.js";

function withConnection<T>(settings: Settings, fn: (conn: DatabaseSync) => T): T {
  const conn = connect(settings);
  try {
    return fn(conn);
  } finally {
    conn.close();
  }
}

const TABLE = `
CREATE TABLE IF NOT EXISTS usage_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    turn_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 1,
    duration_s REAL NOT NULL DEFAULT 0,
    ttft_s REAL NOT NULL DEFAULT 0
)
`;

const INDEX = "CREATE INDEX IF NOT EXISTS idx_usage_turns_ts ON usage_turns(ts)";

const TIMING_TABLE = `
CREATE TABLE IF NOT EXISTS usage_turn_times (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    ttft_s REAL NOT NULL DEFAULT 0,
    gen_s REAL NOT NULL DEFAULT 0,
    ts REAL NOT NULL DEFAULT 0
)
`;

// -- timezone helpers (zoneinfo replacement) ---------------------------------

function isValidTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function zone(name: string): string {
  return name && isValidTimeZone(name) ? name : "UTC";
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(tz: string, utcMs: number): LocalParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Local calendar date (ISO yyyy-mm-dd) and year for an epoch-seconds ts. */
function localDateAndYear(tz: string, ts: number): { dateKey: string; year: number } {
  const p = partsInZone(tz, ts * 1000);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return { dateKey: `${p.year}-${mm}-${dd}`, year: p.year };
}

/** datetime(year,1,1,tzinfo=UTC).timestamp() */
function utcYearStartSeconds(year: number): number {
  return Date.UTC(year, 0, 1) / 1000;
}

// -- recording ----------------------------------------------------------------

/** Add one model call's usage into a turn's running total. */
export function add_usage(
  total: { [k: string]: unknown } | null,
  next: { [k: string]: unknown } | null | undefined,
): { [k: string]: unknown } | null {
  if (!next) return total;
  const out: Record<string, unknown> = { ...(total ?? {}) };
  for (const field of [
    "total_tokens",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
  ] as const) {
    const value = Number((next as Record<string, unknown>)[field] ?? 0) || 0;
    if (value) out[field] = (Number(out[field]) || 0) + value;
  }
  out["calls"] = (Number(out["calls"]) || 0) + 1;
  return out;
}

/** Store honest stream timings for one turn. Never raises. */
export function record_turn_timing(
  settings: Settings,
  args: {
    turn_id: string;
    session_id: string;
    model: string;
    provider: string;
    ttft_s: number;
    gen_s: number;
  },
): void {
  try {
    withConnection(settings, (conn) => {
      conn.exec(TIMING_TABLE);
      conn
        .prepare(
          "INSERT OR REPLACE INTO usage_turn_times" +
            " (turn_id, session_id, model, provider, ttft_s, gen_s, ts)" +
            " VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          args.turn_id,
          args.session_id,
          args.model,
          args.provider,
          Math.max(0, args.ttft_s),
          Math.max(0, args.gen_s),
          Date.now() / 1000,
        );
    });
  } catch {
    // accounting must never break a turn
  }
}

function toInt(value: unknown): number {
  const n = Math.trunc(Number(value ?? 0));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function isoTs(value: unknown): number {
  if (value == null) return 0;
  const s = String(value).replace("Z", "+00:00");
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

type Entry = Record<string, unknown>;

/** `sessions.vtx_entries` is a JSON list of JSON-encoded entry strings. */
function entriesFrom(raw: unknown): Entry[] {
  if (raw instanceof Uint8Array) raw = Buffer.from(raw).toString("utf-8");
  let items: unknown;
  if (typeof raw === "string") {
    try {
      items = JSON.parse(raw);
    } catch {
      return [];
    }
  } else {
    items = raw;
  }
  if (!Array.isArray(items)) return [];
  const out: Entry[] = [];
  for (let item of items) {
    if (typeof item === "string") {
      try {
        item = JSON.parse(item);
      } catch {
        continue;
      }
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      out.push(item as Entry);
    }
  }
  return out;
}

type CallRow = [
  number, // ts
  string, // session_id
  string, // turn_id
  string, // model
  string, // provider
  number, // input_tokens
  number, // output_tokens
  number, // cache_read
  number, // cache_write
  number, // total
  number, // calls
  number, // duration
  number, // ttft
];

/**
 * Extract one usage row per assistant message carrying provider usage.
 * Timestamps on vtx entries are completion times, so per-call latency is
 * approximated by the gap to the previous entry, and TTFT by the gap from the
 * turn's user message to its first model call.
 */
function callRows(
  entries: Entry[],
  args: { session_id: string; turn_id: string; since_ts?: number },
): CallRow[] {
  const { session_id, turn_id } = args;
  const sinceTs = args.since_ts ?? 0;
  const rows: CallRow[] = [];
  let model = "";
  let provider = "";
  let backfillTurn = 0;
  let backfillTurnId = "";
  let prevTs = 0;
  let turnAnchorTs = 0;
  let liveAnchorTs = 0;
  let emitted = false;
  for (const entry of entries) {
    const ts = isoTs(entry.timestamp);
    const etype = entry.type;
    if (etype === "model_change") {
      model = String(entry.model_id ?? "");
      provider = String(entry.provider ?? "");
    } else if (etype === "message") {
      const message = (entry.message ?? {}) as Entry;
      const role = message.role;
      if (role === "user") {
        backfillTurn += 1;
        backfillTurnId = `${session_id}#t${backfillTurn}`;
        if (ts) turnAnchorTs = ts || turnAnchorTs;
        if (ts) liveAnchorTs = ts || liveAnchorTs;
      }
      const usage = message.usage;
      if (usage && typeof usage === "object" && !Array.isArray(usage)) {
        const u = usage as Entry;
        const inputTokens = toInt(u.input_tokens);
        const outputTokens = toInt(u.output_tokens);
        const cacheRead = toInt(u.cache_read_tokens);
        const cacheWrite = toInt(u.cache_write_tokens);
        const total = inputTokens + outputTokens + cacheRead + cacheWrite;
        if (total) {
          if (turn_id) {
            if (!ts || ts < sinceTs) {
              if (ts) prevTs = ts;
              continue;
            }
            const rowTurn = turn_id;
            const anchor = liveAnchorTs;
            const duration = prevTs ? Math.max(0, ts - prevTs) : 0;
            const ttft = anchor && !emitted ? Math.max(0, ts - anchor) : 0;
            emitted = true;
            rows.push([
              ts || Date.now() / 1000,
              session_id,
              rowTurn,
              model,
              provider,
              inputTokens,
              outputTokens,
              cacheRead,
              cacheWrite,
              total,
              1,
              duration,
              ttft,
            ]);
          } else {
            const rowTurn = backfillTurnId;
            const anchor = turnAnchorTs;
            if (!rowTurn) {
              if (ts) prevTs = ts;
              continue;
            }
            const duration = prevTs ? Math.max(0, ts - prevTs) : 0;
            const ttft = anchor && !emitted ? Math.max(0, ts - anchor) : 0;
            emitted = true;
            rows.push([
              ts || Date.now() / 1000,
              session_id,
              rowTurn,
              model,
              provider,
              inputTokens,
              outputTokens,
              cacheRead,
              cacheWrite,
              total,
              1,
              duration,
              ttft,
            ]);
          }
        }
      }
    }
    if (ts) prevTs = ts;
  }
  return rows;
}

function insertRows(settings: Settings, rows: CallRow[]): void {
  if (!rows.length) return;
  withConnection(settings, (conn) => {
    conn.exec(TABLE);
    conn.exec(INDEX);
    const stmt = conn.prepare(
      "INSERT INTO usage_turns (ts, session_id, turn_id, model, provider," +
        " input_tokens, output_tokens, cache_read_tokens," +
        " cache_write_tokens, total_tokens, calls, duration_s, ttft_s)" +
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const row of rows) stmt.run(...(row as unknown as never[]));
  });
}

/** Record the model calls a just-finished turn made, from vtx_entries. */
export function record_live_turn(
  settings: Settings,
  args: { session_id: string; turn_id: string; started_at: number },
): void {
  try {
    withConnection(settings, (conn) => {
      conn.exec(TABLE);
      const row = conn
        .prepare("SELECT vtx_entries FROM sessions WHERE id = ?")
        .get(args.session_id) as { vtx_entries: unknown } | undefined;
      if (!row || !row.vtx_entries) return;
      const entries = entriesFrom(row.vtx_entries);
      // Only entries stamped after the turn started belong to this turn.
      const rows = callRows(entries, {
        session_id: args.session_id,
        turn_id: args.turn_id,
        since_ts: args.started_at,
      });
      // duration is unknown per call; leave 0 so tokens/sec stays null.
      insertRows(settings, rows);
    });
  } catch {
    // accounting must never break a turn
  }
}

/**
 * Record the provider usage reported by a just-finished turn.
 *
 * The local agent loop keeps usage on the `AgentEndEvent`, not on persisted
 * session entries, so `record_live_turn` (which scrapes `vtx_entries`) has
 * nothing to find. This is the authoritative path for live turns.
 */
export function record_call_usage(
  settings: Settings,
  args: {
    session_id: string;
    turn_id: string;
    model: string;
    provider: string;
    usage: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
      total_tokens?: number;
      calls?: number;
    } | null;
    duration_s?: number;
    ttft_s?: number;
  },
): void {
  const u = args.usage;
  if (!u) return;
  const input = toInt(u.input_tokens);
  const output = toInt(u.output_tokens);
  const cacheRead = toInt(u.cache_read_tokens);
  const cacheWrite = toInt(u.cache_write_tokens);
  const total = toInt(u.total_tokens) || input + output + cacheRead + cacheWrite;
  if (!total) return;
  try {
    withConnection(settings, (conn) => {
      conn.exec(TABLE);
      conn.exec(INDEX);
      // One row per turn: a scraped backfill must not double-count this call.
      conn
        .prepare("DELETE FROM usage_turns WHERE session_id = ? AND turn_id = ?")
        .run(args.session_id, args.turn_id);
      const stmt = conn.prepare(
        "INSERT INTO usage_turns (ts, session_id, turn_id, model, provider," +
          " input_tokens, output_tokens, cache_read_tokens," +
          " cache_write_tokens, total_tokens, calls, duration_s, ttft_s)" +
          " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      );
      stmt.run(
        Date.now() / 1000,
        args.session_id,
        args.turn_id,
        args.model,
        args.provider,
        input,
        output,
        cacheRead,
        cacheWrite,
        total,
        Math.max(1, toInt(u.calls) || 1),
        Math.max(0, Number(args.duration_s) || 0),
        Math.max(0, Number(args.ttft_s) || 0),
      );
    });
  } catch {
    // accounting must never break a turn
  }
}

// -- aggregation ---------------------------------------------------------------

interface Totals {
  prompt_tokens: number;
  completion_tokens: number;
  cache_creation_input_tokens: number;
  cache_input_tokens: number;
  cache_read_input_tokens: number;
  cache_reported_calls: number;
  total_calls: number;
  total_tokens: number;
  duration_seconds: number;
  estimated_calls: number;
  cache_hit_rate: number | null;
  tokens_per_second: number | null;
  ttft_seconds: number | null;
}

function emptyTotals(): Totals {
  return {
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_reported_calls: 0,
    total_calls: 0,
    total_tokens: 0,
    duration_seconds: 0,
    estimated_calls: 0,
    cache_hit_rate: null,
    tokens_per_second: null,
    ttft_seconds: null,
  };
}

function finishTotals(t: Totals): void {
  const cacheDenom = t.cache_read_input_tokens + t.cache_input_tokens;
  t.cache_hit_rate = cacheDenom > 0 ? Math.round((t.cache_read_input_tokens / cacheDenom) * 10000) / 10000 : null;
  t.tokens_per_second =
    t.duration_seconds > 0 && t.completion_tokens > 0
      ? Math.round((t.completion_tokens / t.duration_seconds) * 100) / 100
      : null;
}

interface UsageRow {
  id: number;
  ts: number;
  session_id: string;
  turn_id: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  calls: number;
  duration_s: number;
  ttft_s: number;
  [k: string]: unknown;
}

interface ModelRow extends Totals {
  model: string;
  provider: string;
  _ttft?: number[];
}

export interface UsageReport {
  year: number;
  timezone: string;
  totals: Totals;
  days: Array<Record<string, unknown>>;
  models: ModelRow[];
  active_days: number;
  sessions: number;
  turns: number;
  tracked_turns: number;
  updated_at: number;
  [k: string]: unknown;
}

/** Aggregate `usage_turns` into the UsageStatistics contract shape. */
export function usage_for_year(settings: Settings, year: number, timezone: string): UsageReport {
  const tz = zone(timezone || "UTC");
  const startUtc = utcYearStartSeconds(year - 1);
  const endUtc = utcYearStartSeconds(year + 2);

  const totals = emptyTotals();
  const days = new Map<string, Record<string, unknown>>();
  const dayTurns = new Map<string, Set<string>>();
  const dayTracked = new Map<string, Set<string>>();
  const models = new Map<string, ModelRow>();
  const sessions = new Set<string>();
  const turnFirstTs = new Map<string, number>();
  const turnHasTokens = new Map<string, boolean>();
  const turnTtft = new Map<string, number>();
  const modelTtft = new Map<string, number[]>();
  let latest = 0;

  const timings = new Map<string, Record<string, unknown>>();
  const rows = withConnection(settings, (db) => {
    db.exec(TIMING_TABLE);
    const timingRows = db
      .prepare("SELECT turn_id, model, provider, ttft_s, gen_s, ts FROM usage_turn_times")
      .all() as Array<Record<string, unknown>>;
    for (const t of timingRows) {
      timings.set(String(t.turn_id), t);
    }
    db.exec(TABLE);
    return db
      .prepare(
        "SELECT id, ts, session_id, turn_id, model, provider, input_tokens," +
          " output_tokens, cache_read_tokens, cache_write_tokens," +
          " total_tokens, calls, duration_s, ttft_s FROM usage_turns" +
          " WHERE ts >= ? AND ts < ?",
      )
      .all(startUtc, endUtc) as unknown as UsageRow[];
  });

  for (const row of rows) {
    const ts = Number(row.ts ?? 0) || 0;
    const { dateKey, year: localYear } = localDateAndYear(tz, ts);
    if (localYear !== year) continue;
    const modelKey = `${row.model ?? ""}${row.provider ?? ""}`;
    const turnKey = row.turn_id || `row:${row.id}`;
    const rowTokens = Math.trunc(Number(row.total_tokens ?? 0)) || 0;
    const rowCalls = Math.trunc(Number(row.calls ?? 1)) || 1;

    let day = days.get(dateKey);
    if (!day) {
      day = { date: dateKey, total_tokens: 0, total_calls: 0, turns: 0, tracked_turns: 0 };
      days.set(dateKey, day);
    }
    day.total_tokens = (day.total_tokens as number) + rowTokens;
    day.total_calls = (day.total_calls as number) + rowCalls;
    if (!dayTurns.has(dateKey)) dayTurns.set(dateKey, new Set());
    dayTurns.get(dateKey)!.add(turnKey);
    if (rowTokens > 0) {
      if (!dayTracked.has(dateKey)) dayTracked.set(dateKey, new Set());
      dayTracked.get(dateKey)!.add(turnKey);
    }

    let modelRow = models.get(modelKey);
    if (!modelRow) {
      modelRow = {
        model: String(row.model ?? ""),
        provider: String(row.provider ?? ""),
        ...emptyTotals(),
      };
      models.set(modelKey, modelRow);
    }
    modelRow.total_tokens += rowTokens;
    modelRow.prompt_tokens += Math.trunc(Number(row.input_tokens ?? 0)) || 0;
    modelRow.completion_tokens += Math.trunc(Number(row.output_tokens ?? 0)) || 0;
    modelRow.cache_read_input_tokens += Math.trunc(Number(row.cache_read_tokens ?? 0)) || 0;
    modelRow.cache_input_tokens += Math.trunc(Number(row.cache_write_tokens ?? 0)) || 0;
    modelRow.total_calls += rowCalls;
    modelRow.duration_seconds += Number(row.duration_s ?? 0) || 0;
    if (rowTokens === 0) modelRow.estimated_calls += rowCalls;

    totals.total_tokens += rowTokens;
    totals.prompt_tokens += Math.trunc(Number(row.input_tokens ?? 0)) || 0;
    totals.completion_tokens += Math.trunc(Number(row.output_tokens ?? 0)) || 0;
    totals.cache_read_input_tokens += Math.trunc(Number(row.cache_read_tokens ?? 0)) || 0;
    totals.cache_input_tokens += Math.trunc(Number(row.cache_write_tokens ?? 0)) || 0;
    totals.total_calls += rowCalls;
    totals.duration_seconds += Number(row.duration_s ?? 0) || 0;
    if (rowTokens === 0) totals.estimated_calls += rowCalls;

    if (row.session_id) sessions.add(row.session_id);
    const ttft = Number(row.ttft_s ?? 0) || 0;
    if (ttft > 0) {
      if (!turnTtft.has(turnKey)) turnTtft.set(turnKey, ttft);
      const list = modelTtft.get(modelKey) ?? [];
      list.push(ttft);
      modelTtft.set(modelKey, list);
    }
    if (!turnFirstTs.has(turnKey)) turnFirstTs.set(turnKey, ts);
    turnHasTokens.set(turnKey, (turnHasTokens.get(turnKey) ?? false) || rowTokens > 0);
    latest = Math.max(latest, ts);
  }

  for (const [dateKey, turnSet] of dayTurns) {
    const day = days.get(dateKey)!;
    day.turns = turnSet.size;
    day.tracked_turns = dayTracked.get(dateKey)?.size ?? 0;
  }

  finishTotals(totals);
  // Honest timings win; approximations only fill gaps for untimed turns.
  const realTtfts: number[] = [];
  for (const t of timings.values()) {
    const ttft = Number(t.ttft_s ?? 0) || 0;
    const ts = Number(t.ts ?? 0) || 0;
    if (ttft > 0 && ts && localDateAndYear(tz, ts).year === year) {
      realTtfts.push(ttft);
    }
  }
  totals.ttft_seconds = realTtfts.length
    ? Math.round((realTtfts.reduce((a, b) => a + b, 0) / realTtfts.length) * 1000) / 1000
    : null;

  let timedOut = 0;
  let timedGen = 0;
  for (const r of rows) {
    const turnId = r.turn_id ?? "";
    const t = timings.get(turnId);
    if (!t) continue;
    timedOut += Math.trunc(Number(r.output_tokens ?? 0)) || 0;
    timedGen += Number(t.gen_s ?? 0) || 0;
  }
  totals.tokens_per_second =
    timedGen > 0 && timedOut > 0 ? Math.round((timedOut / timedGen) * 100) / 100 : null;

  // Per-model TPS/TTFT only from turns with real stream timings.
  const modelTimed = new Map<string, { out: number; gen: number; ttft: number; n: number }>();
  for (const r of rows) {
    const t = timings.get(r.turn_id ?? "");
    if (!t) continue;
    const key = `${t.model ?? ""}${t.provider ?? ""}`;
    let bucket = modelTimed.get(key);
    if (!bucket) {
      bucket = { out: 0, gen: 0, ttft: 0, n: 0 };
      modelTimed.set(key, bucket);
    }
    bucket.out += Math.trunc(Number(r.output_tokens ?? 0)) || 0;
    bucket.gen += Number(t.gen_s ?? 0) || 0;
    const tTtft = Number(t.ttft_s ?? 0) || 0;
    if (tTtft > 0) {
      bucket.ttft += tTtft;
      bucket.n += 1;
    }
  }
  for (const modelRow of models.values()) {
    finishTotals(modelRow);
    const key = `${modelRow.model}${modelRow.provider}`;
    const timed = modelTimed.get(key);
    modelRow.tokens_per_second =
      timed && timed.gen > 0 && timed.out > 0
        ? Math.round((timed.out / timed.gen) * 100) / 100
        : null;
    modelRow.ttft_seconds = timed && timed.n ? Math.round((timed.ttft / timed.n) * 1000) / 1000 : null;
  }
  for (const t of timings.values()) {
    const ts = Number(t.ts ?? 0) || 0;
    if (!ts || localDateAndYear(tz, ts).year !== year) continue;
    const key = `${t.model ?? ""}${t.provider ?? ""}`;
    const row = models.get(key);
    if (!row) continue;
    const ttft = Number(t.ttft_s ?? 0) || 0;
    if (ttft > 0) {
      if (!row._ttft) row._ttft = [];
      row._ttft.push(ttft);
    }
  }
  for (const modelRow of models.values()) {
    const vals = modelRow._ttft;
    if (vals && vals.length) {
      modelRow.ttft_seconds = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
    }
    delete modelRow._ttft;
  }

  const yearTurns = new Map<string, number>();
  for (const [key, ts] of turnFirstTs) {
    if (localDateAndYear(tz, ts).year === year) yearTurns.set(key, ts);
  }

  const sortedDays = [...days.keys()].sort().map((k) => days.get(k)!);
  const sortedModels = [...models.values()].sort(
    (a, b) => b.total_tokens - a.total_tokens || a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider),
  );

  return {
    year,
    timezone: tz,
    totals,
    days: sortedDays,
    models: sortedModels,
    active_days: dayTurns.size,
    sessions: sessions.size,
    turns: yearTurns.size,
    tracked_turns: [...yearTurns.keys()].filter((k) => turnHasTokens.get(k)).length,
    updated_at: latest,
  };
}

// camelCase aliases for callers that prefer them.
export const recordTurnTiming = record_turn_timing;
export const recordLiveTurn = record_live_turn;
export const recordCallUsage = record_call_usage;
export const addUsage = add_usage;
export const usageForYear = usage_for_year;
