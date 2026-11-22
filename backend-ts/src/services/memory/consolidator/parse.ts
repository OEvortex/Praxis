// tolerant JSON
// parsers shared across the consolidator.
import type { Op } from "../ops.js";
import type { Dict } from "../../../shared/types.js";

export interface ParsedAction {
  name: string;
  args: Dict;
  thought: string;
  arg(key: string, defaultValue?: unknown): unknown;
}

export function parse_action(raw: string): ParsedAction | null {
  const snippet = extractJsonObject(raw);
  if (snippet === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(snippet);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const obj = data as Dict;
  const nameRaw = obj["action"];
  if (typeof nameRaw !== "string" || !nameRaw.trim()) return null;
  const argsRaw = obj["args"];
  const args: Dict =
    argsRaw !== null && typeof argsRaw === "object" && !Array.isArray(argsRaw)
      ? (argsRaw as Dict)
      : {};
  const thoughtRaw = obj["thought"];
  const thought = typeof thoughtRaw === "string" ? thoughtRaw.trim() : "";
  return {
    name: nameRaw.trim(),
    args,
    thought,
    arg(key: string, defaultValue: unknown = null) {
      return args[key] ?? defaultValue;
    },
  };
}

// ── Legacy ops-array shape (kept for apply_ops_payload) ───────────────

export function parse_ops_response(raw: string): Op[] {
  const snippet = extractJsonObject(raw);
  if (snippet === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(snippet);
  } catch {
    return [];
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const opsRaw = (data as Dict)["ops"];
  if (!Array.isArray(opsRaw)) return [];
  const ops: Op[] = [];
  for (const rawOp of opsRaw) ops.push(...parseOneOp(rawOp));
  return ops;
}

function parseOneOp(rawOp: unknown): Op[] {
  if (rawOp === null || typeof rawOp !== "object" || Array.isArray(rawOp)) return [];
  const op = rawOp as Dict;
  const kind = op["op"];
  try {
    if (kind === "add") {
      return [
        {
          op: "add",
          section: String(op["section"] ?? "").trim(),
          text: String(op["text"] ?? "").trim(),
          refs: (Array.isArray(op["refs"]) ? op["refs"] : [])
            .map(String)
            .filter(Boolean),
        },
      ];
    }
    if (kind === "edit") {
      return [
        {
          op: "edit",
          target_id: String(op["target_id"] ?? "").trim(),
          new_text: String(op["new_text"] ?? "").trim(),
          new_refs: (Array.isArray(op["new_refs"]) ? op["new_refs"] : [])
            .map(String)
            .filter(Boolean),
        },
      ];
    }
    if (kind === "delete") {
      return [
        {
          op: "delete",
          target_id: String(op["target_id"] ?? "").trim(),
          reason: String(op["reason"] ?? "stale").trim(),
        },
      ];
    }
  } catch {
    return [];
  }
  return [];
}

// ── Shared text extraction ────────────────────────────────────────────

export function extractJsonObject(raw: string): string | null {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
