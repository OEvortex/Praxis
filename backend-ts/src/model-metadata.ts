// Port of the metadata half of vtx.ai.context_length + vtx.ai.thinking.
//
// vtx resolves model limits/efforts from the models.dev catalog
// (https://models.dev/api.json), cached at ~/.vtx/models_dev_limits.json and
// parsed by `ContextLengthManager._parse_limits`. The TS backend has no vtx
// (generated from the same models.dev payload vtx caches; see the header of
// the generator output for provenance) and looked up here with the same
// semantics:
//
//   * exact match on the raw model id wins;
//   * otherwise a fuzzy fallback scans the table in insertion order and
//     returns the first id whose normalised form (lowercase, hyphens
//     stripped) is a substring of the query's or vice versa;
//   * a model with no verified context window yields "no metadata".
//
// The JSON stores one compact array per model id:
//   [context, max_output_tokens, reasoning, vision, tools, audio, effortsCsv]
// where effortsCsv is the comma-joined list of supported reasoning efforts in
// the "none"-spelled vocabulary (empty string when the model is not a
// reasoning model — see `supported_reasoning_efforts` below).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

type AnyDict = Record<string, any>;

const _METADATA_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "model-metadata.json",
);

type MetadataRow = [
  context: number,
  maxTokens: number,
  reasoning: number,
  vision: number,
  tools: number,
  audio: number,
  effortsCsv: string,
];

interface IndexedRow {
  id: string;
  normalised: string;
  row: MetadataRow;
}

let _rows: IndexedRow[] | null = null;
let _exact: Map<string, MetadataRow> | null = null;
const _memo = new Map<string, AnyDict | null>();

function _load(): void {
  if (_rows !== null) return;
  _rows = [];
  _exact = new Map();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(_METADATA_FILE, "utf-8"));
  } catch {
    raw = {};
  }
  for (const [id, value] of Object.entries(raw)) {
    if (!Array.isArray(value) || value.length < 7) continue;
    const row = value as unknown as MetadataRow;
    const indexed: IndexedRow = {
      id,
      normalised: id.toLowerCase().replace(/-/g, ""),
      row,
    };
    _rows.push(indexed);
    // insertion position (first occurrence) is preserved for fuzzy order.
    _exact.set(id, row);
  }
}

function _normalise(model: string): string {
  return model.toLowerCase().replace(/-/g, "");
}

/** Mirrors vtx ContextLengthManager.get_limits (exact, then fuzzy). */
function _lookup(model_id: string): MetadataRow | null {
  _load();
  const exact = _exact!.get(model_id);
  if (exact) return exact;
  const target = _normalise(model_id);
  if (!target) return null;
  for (const entry of _rows!) {
    const mid = entry.normalised;
    if (target.includes(mid) || mid.includes(target)) {
      return entry.row;
    }
  }
  return null;
}

/**
 * Authoritative model limits/efforts from the vendored models.dev metadata.
 *
 * Returns `null` when there are no verified limits for this id. Local catalog
 * values remain explicit user overrides; everything else comes from models.dev
 * (the same table vtx's `context_length_manager` serves).
 */
export function lookup_model_metadata(model_id: string): AnyDict | null {
  if (!model_id) return null;
  const cached = _memo.get(model_id);
  if (cached !== undefined) return cached;

  const row = _lookup(model_id);
  // vtx only records models with a verified context window; context == 0 is
  // its "unknown" sentinel, so treat it as no metadata.
  if (!row || !row[0]) {
    _memo.set(model_id, null);
    return null;
  }

  const [context, maxTokens, reasoning, vision, tools, audio, effortsCsv] = row;
  const result: AnyDict = {
    context_window: context,
    max_tokens: maxTokens,
    supports_reasoning: Boolean(reasoning),
    supports_vision: Boolean(vision),
    supports_tools: Boolean(tools),
    supports_audio: Boolean(audio),
    supported_reasoning_efforts: effortsCsv ? effortsCsv.split(",") : [],
  };
  _memo.set(model_id, result);
  return result;
}
