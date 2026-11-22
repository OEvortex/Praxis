// evaluation-only
// history/L3 snapshot comparison harness. Never opens active user memory;
// snapshots are supplied artifacts. Readers/token counters are injected.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Dict } from "../../shared/types.js";

export interface HistoryItem {
  identifier: string;
  timestamp: string;
  text: string;
}
export interface CaseInput {
  query: string;
  history: HistoryItem[];
  l3_snapshot: Array<[string, string]>;
  question_time?: string;
  memory_as_of?: string;
}
export interface EvalCase {
  case_id: string;
  category: string;
  input: CaseInput;
  answers: string[];
  evidence_ids: Set<string>;
}
export interface Evidence {
  identifier: string;
  text: string;
}
export interface AdapterResult {
  evidence: Evidence[];
  original_source_ids?: boolean;
  source_ids?: Record<string, string> | null;
  metadata?: Dict | null;
}
export interface ReaderResult {
  answer: string;
  usage?: Dict | null;
}
export type Adapter = (context: CaseInput) => Promise<AdapterResult>;
export type Reader = (context: string, query: string) => Promise<ReaderResult>;
export type TokenCounter = (text: string) => number;

function parseTs(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("invalid timestamp");
  return d;
}

// load_cases(path): upstream reads JSONL from disk; here callers pass parsed
// rows. Validation mirrors upstream (chronology, gold visibility, answerable).
export function validate_cases(rows: unknown[]): EvalCase[] {
  const cases: EvalCase[] = [];
  const seen = new Set<string>();
  rows.forEach((dataRaw, idx) => {
    const data = dataRaw as Dict;
    const caseId = String(data["case_id"] ?? "");
    const query = String(data["query"] ?? "");
    const category = String(data["category"] ?? "");
    if (!caseId.trim() || !query.trim() || !category.trim()) {
      throw new Error(`case ${idx + 1}: case_id/query/category must be nonempty`);
    }
    if (seen.has(caseId)) throw new Error(`case ${idx + 1}: duplicate case ID`);
    if (!Array.isArray(data["history"])) throw new Error(`case ${idx + 1}: history must be a list`);
    const history: HistoryItem[] = (data["history"] as Dict[]).map((item) => ({
      identifier: String(item["id"]),
      timestamp: String(item["timestamp"]),
      text: String(item["text"]),
    }));
    const dates = history.map((h) => parseTs(h.timestamp).getTime());
    for (let i = 1; i < dates.length; i++) {
      if (dates[i] < dates[i - 1]) throw new Error(`case ${idx + 1}: history must be chronological`);
    }
    if (new Set(history.map((h) => h.identifier)).size !== history.length) {
      throw new Error(`case ${idx + 1}: duplicate history ID`);
    }
    const cutoff = parseTs(String(data["question_time"])).getTime();
    const snapshotTime = parseTs(String(data["memory_as_of"])).getTime();
    if (snapshotTime > cutoff) throw new Error(`case ${idx + 1}: memory snapshot is newer than the question`);
    const visible = history.filter((_, i) => dates[i] <= cutoff);
    const gold = Array.isArray(data["evidence_ids"]) ? (data["evidence_ids"] as string[]) : null;
    if (!gold || !gold.every((x) => typeof x === "string")) {
      throw new Error(`case ${idx + 1}: evidence_ids must be a string list`);
    }
    const visibleIds = new Set(visible.map((h) => h.identifier));
    if (!gold.every((g) => visibleIds.has(g))) {
      throw new Error(`case ${idx + 1}: gold evidence must exist before question_time`);
    }
    const answerable = data["answerable"];
    const expected = String(data["expected_answer"] ?? "");
    const aliases = Array.isArray(data["answer_aliases"]) ? (data["answer_aliases"] as string[]) : [];
    if (typeof answerable !== "boolean") throw new Error(`case ${idx + 1}: invalid answerability`);
    if (answerable && (!expected.trim() || !gold.length)) {
      throw new Error(`case ${idx + 1}: answerable cases need an answer and evidence`);
    }
    if (!answerable && (expected || gold.length || aliases.length)) {
      throw new Error(`case ${idx + 1}: unanswerable cases must not supply answers/evidence/aliases`);
    }
    const snapshot = data["l3_snapshot"];
    const L3 = new Set(["recent", "profile", "scope", "preferences"]);
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        !Object.entries(snapshot as Dict).every(([k, v]) => L3.has(k) && typeof v === "string")) {
      throw new Error(`case ${idx + 1}: l3_snapshot must map known L3 slots to strings`);
    }
    cases.push({
      case_id: caseId,
      category,
      input: {
        query,
        history: visible,
        l3_snapshot: Object.entries(snapshot as Dict) as Array<[string, string]>,
        question_time: String(data["question_time"] ?? ""),
        memory_as_of: String(data["memory_as_of"] ?? ""),
      },
      answers: answerable ? [expected, ...aliases] : ["UNKNOWN"],
      evidence_ids: new Set(gold),
    });
    seen.add(caseId);
  });
  if (!cases.length) throw new Error("dataset must contain at least one case");
  return cases;
}

export const raw_recent: Adapter = async (context) => ({
  evidence: [...context.history].reverse().map((item) => ({
    identifier: item.identifier,
    text: `${item.timestamp} ${item.text}`,
  })),
  original_source_ids: true,
});

function words(text: string): string[] {
  return text.toLowerCase().replace(/−/g, "-").match(/\w+|[-+*/=<>^≤≥]/g) ?? [];
}

export const lexical_top2: Adapter = async (context) => {
  const queryCounts = new Map<string, number>();
  for (const w of words(context.query)) queryCounts.set(w, (queryCounts.get(w) ?? 0) + 1);
  const scored = context.history.map((item, i) => {
    const itemCounts = new Map<string, number>();
    for (const w of words(item.text)) itemCounts.set(w, (itemCounts.get(w) ?? 0) + 1);
    let overlap = 0;
    for (const [w, n] of queryCounts) overlap += Math.min(n, itemCounts.get(w) ?? 0);
    return { i, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap || b.i - a.i);
  return {
    evidence: scored.slice(0, 2).map(({ i }) => ({
      identifier: context.history[i].identifier,
      text: `${context.history[i].timestamp} ${context.history[i].text}`,
    })),
    original_source_ids: true,
  };
};

// memory_snapshot: restore supplied L3 artifacts into a temp memory root and
// read via the native facade. The file-based MemoryStore reads its root from
// settings.workspace_dir, so we point PRAXIS_WORKSPACE_DIR at the temp dir for
// the duration of the read (single-user local deployment).
export const memory_snapshot: Adapter = async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "praxis-memory-eval-"));
  const prev = process.env.PRAXIS_WORKSPACE_DIR;
  process.env.PRAXIS_WORKSPACE_DIR = join(dir, "workspace");
  try {
    const { get_memory_store } = await import("./store.js");
    const store = get_memory_store();
    for (const [slot, text] of context.l3_snapshot) {
      await store.overwrite_doc("L3", slot as never, text);
    }
    if (!context.l3_snapshot.some(([, t]) => t.trim())) return { evidence: [] };
    const text = store.read_l3_concat();
    return { evidence: [{ identifier: "l3", text }] };
  } finally {
    if (prev === undefined) delete process.env.PRAXIS_WORKSPACE_DIR;
    else process.env.PRAXIS_WORKSPACE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

export function pack_evidence(
  items: Evidence[],
  budget: number,
  countTokens: TokenCounter,
): [string, string[]] {
  if (budget < 1) throw new Error("token budget must be positive");
  let text = "";
  const selected: string[] = [];
  for (const item of items) {
    const candidate = `${text}[${item.identifier}] ${item.text}\n`;
    if (countTokens(candidate) <= budget) {
      text = candidate;
      selected.push(item.identifier);
    }
  }
  return [text, selected];
}

export function score_answer(answer: string, expected: string[]): [boolean, number] {
  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("reader returned no answer");
  }
  const answerWords = words(answer);
  let exact = false;
  const scores: number[] = [];
  for (const alias of expected) {
    const gold = words(alias);
    const same = answerWords.length === gold.length && answerWords.every((w, i) => w === gold[i]);
    exact = exact || same;
    const counts = new Map<string, number>();
    for (const w of answerWords) counts.set(w, (counts.get(w) ?? 0) + 1);
    let overlap = 0;
    for (const w of gold) {
      const n = counts.get(w) ?? 0;
      if (n > 0) { overlap++; counts.set(w, n - 1); }
    }
    scores.push(answerWords.length + gold.length ? (2 * overlap) / (answerWords.length + gold.length) : 1);
  }
  return [exact, scores.length ? Math.max(...scores) : 0];
}

export async function evaluate(
  cases: EvalCase[],
  opts: {
    count_tokens: TokenCounter;
    tokenizer: string;
    budget?: number;
    reader?: Reader | null;
    adapters?: Record<string, Adapter> | null;
  },
): Promise<Dict> {
  const budget = opts.budget ?? 512;
  if (!cases.length || budget < 1) {
    throw new Error("a nonempty dataset and positive token budget are required");
  }
  const selectedAdapters = opts.adapters ?? {
    raw_recent,
    lexical_top2,
    native_l3_snapshot: memory_snapshot,
  };
  const rows: Dict[] = [];
  for (const kase of cases) {
    for (const [name, adapter] of Object.entries(selectedAdapters)) {
      const started = performance.now();
      const row: Dict = {
        case_id: kase.case_id,
        category: kase.category,
        question_time: kase.input.question_time ?? "",
        memory_as_of: kase.input.memory_as_of ?? "",
        adapter: name,
        error: null,
        exact_match: null,
        token_f1: null,
        source_id_recall: null,
      };
      try {
        const result = await adapter(kase.input);
        const [context, ids] = pack_evidence(result.evidence, budget, opts.count_tokens);
        row["offered_ids"] = result.evidence.map((e) => e.identifier);
        row["omitted_ids"] = result.evidence.filter((e) => !ids.includes(e.identifier)).map((e) => e.identifier);
        row["evidence_context"] = context;
        row["selected_ids"] = ids;
        row["evidence_tokens"] = opts.count_tokens(context);
        row["preparation_seconds"] = (performance.now() - started) / 1000;
        let sources = ids;
        if (result.source_ids) {
          sources = [...new Set(ids.map((id) => result.source_ids![id]).filter(Boolean))];
          row["selected_source_ids"] = sources;
        }
        if (result.metadata) row["adapter_metadata"] = { ...result.metadata };
        if (result.original_source_ids && kase.evidence_ids.size) {
          row["source_id_recall"] =
            sources.filter((s) => kase.evidence_ids.has(s)).length / kase.evidence_ids.size;
        }
        if (opts.reader) {
          const reading = performance.now();
          const answer = await opts.reader(context, kase.input.query);
          row["answer"] = answer.answer;
          row["usage"] = { ...(answer.usage ?? {}) };
          row["reader_seconds"] = (performance.now() - reading) / 1000;
          const [exact, f1] = score_answer(answer.answer, kase.answers);
          row["exact_match"] = exact;
          row["token_f1"] = f1;
        }
      } catch (exc) {
        row["error"] = `${exc instanceof Error ? exc.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`;
      }
      row["seconds"] = (performance.now() - started) / 1000;
      rows.push(row);
    }
  }
  const summary: Dict = {};
  for (const name of Object.keys(selectedAdapters)) {
    const selected = rows.filter((r) => r["adapter"] === name);
    const scored = selected.filter((r) => r["exact_match"] !== null && !r["error"]);
    const correct = scored.filter((r) => Boolean(r["exact_match"])).length;
    summary[name] = {
      total: selected.length,
      failed: selected.filter((r) => Boolean(r["error"])).length,
      scored: scored.length,
      correct,
      exact_match_scored: scored.length ? correct / scored.length : null,
      exact_match_all_cases: scored.length ? correct / selected.length : null,
    };
  }
  return {
    tokenizer: opts.tokenizer,
    evidence_token_budget: budget,
    budget_excludes: "question, system instructions and output tokens",
    reader_executed: opts.reader != null,
    consolidation_executed: false,
    memory_source: "supplied L3 snapshots; not generated by this evaluator",
    summary,
    rows,
  };
}
