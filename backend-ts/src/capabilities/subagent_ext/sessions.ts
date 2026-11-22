// Cross-turn session registry for subagent_ext — port of
// deeptutor/services/subagent/sessions.py.
//
// Upstream persists ``session_key → {session_id, kind, cwd}`` so the next
// chat turn resumes the SAME external agent session the earlier consults
// built up. The TS port stores the same shape in the shared sqlite kv table
// under ``subagent_ext:session:<key>``.

import type { Settings } from "../../config.js";
import { get_state, put_state, delete_state } from "../../store/database.js";

export interface SubagentSessionRecord {
  session_id: string;
  kind: string;
  cwd: string;
  updated_at: number;
}

function key(sessionKey: string): string {
  return `subagent_ext:session:${sessionKey}`;
}

/** Derive the registry key — upstream ``session_key(chat_sid, name)``. */
export function sessionKey(chatSessionId: string, name: string): string {
  const chat = chatSessionId.trim();
  const agent = name.trim();
  return chat ? `${chat}:${agent}` : agent || "default";
}

export function getSession(settings: Settings, skey: string): string | null {
  const raw = get_state<unknown>(settings, key(skey));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const sid = (raw as Record<string, unknown>)["session_id"];
  return typeof sid === "string" && sid ? sid : null;
}

export function rememberSession(
  settings: Settings,
  skey: string,
  sessionId: string,
  meta: { kind?: string; cwd?: string } = {},
): void {
  if (!sessionId) return;
  put_state(settings, key(skey), {
    session_id: sessionId,
    kind: meta.kind ?? "",
    cwd: meta.cwd ?? "",
    updated_at: Date.now() / 1000,
  } satisfies SubagentSessionRecord);
}

export function forgetSession(settings: Settings, skey: string): void {
  delete_state(settings, key(skey));
}
