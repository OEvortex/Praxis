// Port of deeptutor/services/memory/consolidator/guards.py — banned-phrase
// filter + per-loop tool budgets.
import type { Op } from "../ops.js";

export const BANNED_PHRASES: readonly string[] = [
  "deeply",
  "truly",
  "mastered",
  "expert in",
  "passionate",
  "loves",
  "hates",
  "always",
  "never",
  "fully understands",
  "深刻",
  "彻底",
  "完美掌握",
  "完美理解",
  "完全理解",
  "完全掌握",
  "专家",
  "热爱",
  "总是",
  "从来不",
];

export interface ToolBudgets {
  read_entity: number;
  search: number;
  list_pending: number;
  list_sections: number;
  recent_changes: number;
  add_entry: number;
  edit_entry: number;
  delete_entry: number;
  note: number;
}

export const DEFAULT_TOOL_BUDGETS: ToolBudgets = {
  read_entity: 30,
  search: 20,
  list_pending: 50,
  list_sections: 50,
  recent_changes: 3,
  add_entry: 12,
  edit_entry: 12,
  delete_entry: 12,
  note: 8,
};

const QUOTED_RE = /「[^」]*」|"[^"]*"/g;

export function has_banned(text: string): boolean {
  const stripped = text.replace(QUOTED_RE, "").toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (stripped.includes(phrase.toLowerCase())) return true;
  }
  return false;
}

function opText(op: Op): string {
  if (op.op === "add") return op.text;
  if (op.op === "edit") return op.new_text;
  return "";
}

export function filter_banned(ops: Op[]): Op[] {
  const kept: Op[] = [];
  for (const op of ops) {
    const text = opText(op);
    if (text && has_banned(text)) continue;
    kept.push(op);
  }
  return kept;
}

export const _filter_banned = filter_banned;
export const _has_banned = has_banned;
