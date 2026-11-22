// Port of deeptutor/learning/navigation.py (the parts the REST surface needs).
import { LearningStore } from "./store.js";
import { findKnowledgePoint, mapSummary, nextObjective, pathDisplayName } from "./policy.js";
import type { SessionStore } from "../../store/session_store.js";
import type { Settings } from "../../config.js";

const TOPIC_LIMIT = 20;
const MODULE_LIMIT = 14;
const SESSION_LIMIT = 20;
const LAST_MESSAGE_CHARS = 160;

function clip<T>(rows: T[], limit: number): [T[], number] {
  if (rows.length <= limit) return [rows, 0];
  return [rows.slice(0, limit), rows.length - limit];
}

function moduleOutline(summary: Record<string, unknown>): [Record<string, unknown>[], number] {
  const rows = ((summary["modules"] as Record<string, unknown>[]) ?? []).map((m) => ({
    module_id: m["id"],
    name: m["name"],
    order: m["order"],
    mastered: m["mastered"],
    objectives: m["total"],
  }));
  return clip(rows, MODULE_LIMIT);
}

export function topicCards(
  settings: Settings,
  query = "",
): Record<string, unknown> {
  const store = new LearningStore(settings);
  const snapshots = store.listTopicSnapshots("active");
  const needle = query.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  const cards: Record<string, unknown>[] = [];
  for (const snap of snapshots) {
    const summary = mapSummary(snap.progress);
    const counts = summary["counts"] as Record<string, number>;
    if (counts["total"] <= 0) continue;
    const [modules, modulesClipped] = moduleOutline(summary);
    const haystack = [
      summary["name"],
      snap.topic.metadata.goal,
      ...modules.map((m) => String(m["name"] ?? "")),
    ]
      .join(" ")
      .toLowerCase();
    if (needle && !haystack.includes(needle)) continue;
    cards.push({
      path_id: snap.progress.book_id,
      name: summary["name"],
      emoji: snap.topic.metadata.emoji,
      goal: snap.topic.metadata.goal,
      objectives: counts["total"],
      mastered: counts["mastered"],
      learning: counts["learning"],
      not_started: counts["new"],
      due_reviews: summary["due_reviews"],
      complete: summary["complete"],
      sessions: snap.sessionCount,
      open_question: snap.activeInteraction !== null,
      updated_at: snap.progress.updated_at,
      modules,
      ...(modulesClipped ? { modules_omitted: modulesClipped } : {}),
    });
  }
  const [capped, clipped] = clip(cards, TOPIC_LIMIT);
  return {
    topics: capped,
    total_topics: capped.length + clipped,
    ...(clipped ? { topics_omitted: clipped } : {}),
    ...(query ? { query } : {}),
  };
}

export function findTopic(
  settings: Settings,
  pathId: string,
): Record<string, unknown> | null {
  const store = new LearningStore(settings);
  let progress;
  try {
    progress = store.exists(pathId) ? store.load(pathId) : null;
  } catch {
    return null;
  }
  if (!progress) return null;
  const summary = mapSummary(progress);
  const counts = summary["counts"] as Record<string, number>;
  if (counts["total"] <= 0) return null;
  const topic = store.getTopic(pathId, progress);
  const [modules, modulesClipped] = moduleOutline(summary);
  return {
    path_id: progress.book_id,
    name: summary["name"],
    emoji: topic?.metadata.emoji ?? "",
    goal: topic?.metadata.goal ?? "",
    objectives: counts["total"],
    mastered: counts["mastered"],
    due_reviews: summary["due_reviews"],
    complete: summary["complete"],
    modules,
    ...(modulesClipped ? { modules_omitted: modulesClipped } : {}),
  };
}

export function resolveModule(
  topic: Record<string, unknown>,
  moduleRef: string,
): Record<string, unknown> | null {
  const ref = String(moduleRef ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (!ref) return null;
  const modules = (topic["modules"] as Record<string, unknown>[]) ?? [];
  const folded = ref.toLowerCase();
  for (const m of modules) {
    if (String(m["module_id"]).toLowerCase() === folded) return m;
  }
  for (const m of modules) {
    if (String(m["name"]).toLowerCase() === folded) return m;
  }
  const substring = modules.filter((m) => {
    const name = String(m["name"]).toLowerCase();
    return name.includes(folded) || (folded.length > 3 && folded.includes(name));
  });
  if (substring.length) {
    return substring.reduce((best, m) =>
      Math.abs(String(m["name"]).toLowerCase().length - folded.length) <
      Math.abs(String(best["name"]).toLowerCase().length - folded.length)
        ? m
        : best,
    );
  }
  const digits = ref.match(/\d+/);
  let position: number | null = digits ? parseInt(digits[0], 10) : null;
  if (position === null) {
    const CN: Record<string, number> = {
      一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
      六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    };
    const found = [...ref].filter((ch) => ch in CN).map((ch) => CN[ch]);
    position = found.length === 1 ? found[0] : null;
  }
  if (position !== null && position >= 1 && position <= modules.length) {
    const ordered = [...modules].sort(
      (a, b) => Number(a["order"]) - Number(b["order"]),
    );
    return ordered[position - 1];
  }
  return null;
}

export async function topicSessions(
  settings: Settings,
  sessionStore: SessionStore | null,
  pathId: string,
): Promise<Record<string, unknown>[]> {
  const learningStore = new LearningStore(settings);
  const sessionIds = learningStore.listSessionIds(pathId);
  if (!sessionIds.length) return [];
  const activeInteraction = learningStore.getActiveInteraction(pathId);
  const pendingSessionId = activeInteraction?.session_id ?? "";
  const summaries = new Map<string, Record<string, unknown>>();
  if (sessionStore) {
    for (const sid of sessionIds) {
      try {
        const s = sessionStore.get(sid);
        if (s) summaries.set(sid, s as Record<string, unknown>);
      } catch {
        /* skip unreadable session */
      }
    }
  }
  const rows: Record<string, unknown>[] = [];
  for (const sid of sessionIds) {
    const s = summaries.get(sid) ?? {};
    const preferences = (s["preferences"] ?? {}) as Record<string, unknown>;
    const lastMessage = String(s["last_message"] ?? "").trim();
    rows.push({
      session_id: sid,
      title: s["title"] ?? "",
      created_at: s["created_at"] ?? 0,
      updated_at: s["updated_at"] ?? 0,
      status: s["status"] ?? "idle",
      active_turn_id: s["active_turn_id"] ?? "",
      message_count: Number(s["message_count"] ?? 0) || 0,
      last_message: lastMessage.slice(0, 240),
      pinned: Boolean(preferences["pinned"]),
      archived: Boolean(preferences["archived"]),
      has_pending_question: Boolean(pendingSessionId && pendingSessionId === sid),
    });
  }
  rows.sort((a, b) => Number(b["updated_at"]) - Number(a["updated_at"]));
  return rows;
}

export function navigableSessionRows(rows: Record<string, unknown>[]): Record<string, unknown> {
  const live = rows.filter((r) => !r["archived"]);
  const [capped, clipped] = clip(live, SESSION_LIMIT);
  return {
    sessions: capped.map((r) => ({
      session_id: r["session_id"],
      title: r["title"],
      messages: r["message_count"],
      updated_at: r["updated_at"],
      running: Boolean(r["status"] === "running" || r["active_turn_id"]),
      awaiting_answer: r["has_pending_question"],
      last_message: String(r["last_message"] ?? "").slice(0, LAST_MESSAGE_CHARS),
    })),
    total_sessions: live.length,
    ...(clipped ? { sessions_omitted: clipped } : {}),
  };
}

// find_topic / topic_cards module helpers kept for parity with upstream names.
export const NAV_LIMITS = { TOPIC_LIMIT, MODULE_LIMIT, SESSION_LIMIT };
