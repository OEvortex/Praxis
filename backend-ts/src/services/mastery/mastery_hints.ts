// the line the study composer
// shows before the learner types. Never blocks; "" means "keep placeholder".
import { chatjimmyComplete, stripStatsTail } from "../chatjimmy.js";
import { askHintsEnabled } from "../settings_ext/store.js";
import type { Settings } from "../../config.js";
import type { SessionStore } from "../../store/session_store.js";
import { LearningStore } from "./store.js";
import { findKnowledgePoint, nextObjective, pathDisplayName } from "./policy.js";

const MAX_HINT_CHARS: Record<string, number> = { en: 110 };
const LLM_TIMEOUT = 12_000;
const HISTORY_TURNS = 4;
const MAX_MESSAGE_CHARS = 700;
const CACHE_LIMIT = 256;
const CACHE_TTL = 30 * 60 * 1000;

const SYSTEM_EN = `You write ONE question a learner could ask their tutor right now.

You are given where they are on a mastery path and the tail of their conversation. Write the question they would ask next if they knew what to ask.

Hard rule: you write the QUESTION, never the answer. No explanation, no hint at the answer, no "because". If your line teaches the point, it is wrong — the learner is supposed to work that out with the tutor.

Rules:
- Reply with the question alone. No quotes, no prefix, no markdown, no trailing commentary.
- First person, as the learner would type it. Under 14 words.
- End with a question mark.
- It must be about the current waypoint, and it must not ask something the tutor's last message already answered.
- Prefer the question that opens the point up: a distinction, a why, a boundary case, a "what happens if". Avoid yes/no questions and avoid asking for a definition the conversation already gave.

Good: "Why does the router need the intent and not just the query?"
Good: "What breaks if I skip the reflection step?"
Bad: "Can you explain routing?"            <- asks for a lecture, names no edge
Bad: "Routing picks the tool by intent — right?"  <- states the answer`;

interface HintCacheEntry {
  hint: string;
  knowledge_point_id: string;
  generated_at: number;
}

const cache = new Map<string, HintCacheEntry>();
const inflight = new Map<string, Promise<HintCacheEntry>>();

function cacheKey(pathId: string, anchor: string, sessionId: string): string {
  return `${pathId}${anchor}${sessionId}`;
}

function cacheGet(key: string): HintCacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.generated_at * 1000 > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function cacheSet(key: string, value: HintCacheEntry): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = [...cache.entries()].sort(
      (a, b) => a[1].generated_at - b[1].generated_at,
    )[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, value);
}

interface Material {
  path_name: string;
  goal: string;
  module_name: string;
  waypoint: string;
  waypoint_type: string;
  status: string;
  transcript: [string, string][];
  anchor: string;
}

function emptyMaterial(): Material {
  return {
    path_name: "",
    goal: "",
    module_name: "",
    waypoint: "",
    waypoint_type: "",
    status: "",
    transcript: [],
    anchor: "",
  };
}

function loadPosition(store: LearningStore, pathId: string): Material {
  const progress = store.load(pathId);
  if (!progress) return emptyMaterial();
  const step = nextObjective(progress);
  const { kp, moduleName } = findKnowledgePoint(progress, step.knowledge_point_id);
  const topic = store.getTopic(pathId, progress);
  const goal = topic ? String(topic.metadata.description || topic.metadata.goal || "") : "";
  return {
    path_name: pathDisplayName(progress),
    goal,
    module_name: moduleName,
    waypoint: step.knowledge_point_name || (kp?.name ?? ""),
    waypoint_type: step.knowledge_point_type,
    status: step.status ?? "",
    transcript: [],
    anchor: step.knowledge_point_id,
  };
}

function loadTranscript(sessionStore: SessionStore | null, sessionId: string): [[string, string][], string] {
  if (!sessionStore || !sessionId) return [[], ""];
  try {
    const session = sessionStore.get(String(sessionId));
    if (!session) return [[], ""];
    const messages = ((session.messages ?? []) as Record<string, unknown>[]).filter(
      (m) => m && (m.role === "user" || m.role === "assistant"),
    );
    const tail: [string, string][] = [];
    for (const m of messages.slice(-HISTORY_TURNS)) {
      const content = String(m.content ?? "").replace(/\s+/g, " ").trim();
      if (content) tail.push([String(m.role), content.slice(0, MAX_MESSAGE_CHARS)]);
    }
    return [tail, String(messages.length)];
  } catch {
    return [[], ""];
  }
}

function render(material: Material): string {
  const lines: string[] = [];
  lines.push(`# Topic\n${material.path_name}`);
  if (material.goal) lines.push(`# Goal\n${material.goal}`);
  let where = `# Current waypoint\n${material.waypoint}`;
  if (material.module_name) where += ` (module: ${material.module_name})`;
  if (material.waypoint_type) where += `\nType: ${material.waypoint_type}`;
  if (material.status) where += `\nStatus: ${material.status}`;
  lines.push(where);
  if (material.transcript.length) {
    const speaker: Record<string, string> = { user: "Learner", assistant: "Tutor" };
    const body = material.transcript
      .map(([role, text]) => `[${speaker[role] ?? role}] ${text}`)
      .join("\n");
    lines.push("# End of the conversation\n" + body);
  } else {
    lines.push(
      "# End of the conversation\n(Nothing yet — this is their opening question.)",
    );
  }
  lines.push("\nWrite that one question.");
  return lines.join("\n\n");
}

function sanitize(raw: string, language: string): string {
  let text = String(raw ?? "").replace(/\s+/g, " ");
  for (const fence of ["```", '"', "'", "“", "”", "‘", "’"]) {
    text = text.split(fence).join("");
  }
  text = text.replace(/^[-•*#\s]+/, "").trim();
  if (!text) return "";
  if (text.includes("\n")) text = text.split("\n").pop()!.trim();
  if (!text.endsWith("?")) return "";
  const limit = MAX_HINT_CHARS.en;
  return text.length > limit ? "" : text;
}

export async function getAskHint(
  settings: Settings,
  sessionStore: SessionStore | null,
  pathId: string,
  sessionId = "",
): Promise<{ hint: string; knowledge_point_id: string; generated_at: number }> {
  const store = new LearningStore(settings);
  const material = loadPosition(store, pathId);
  const [transcript, anchor] = loadTranscript(sessionStore, sessionId);
  const empty = { hint: "", knowledge_point_id: "", generated_at: Date.now() / 1000 };
  if (!askHintsEnabled(settings) || !material.waypoint) return empty;
  material.transcript = transcript;
  material.anchor = `${material.anchor}:${anchor}`;

  const key = cacheKey(pathId, material.anchor, sessionId);
  const cached = cacheGet(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<HintCacheEntry> => {
    try {
      // Composer hints use the hardcoded chatjimmy model, not the chat model.
      const raw = await chatjimmyComplete(settings, {
        system: SYSTEM_EN,
        prompt: render(material),
        timeoutMs: LLM_TIMEOUT,
        defaultWhenOff: true,
      });
      const hint = sanitize(stripStatsTail(raw ?? ""), "en");
      const entry: HintCacheEntry = {
        hint,
        knowledge_point_id: material.anchor.split(":")[0] ?? "",
        generated_at: Date.now() / 1000,
      };
      if (hint) cacheSet(key, entry);
      return entry;
    } catch {
      return { hint: "", knowledge_point_id: material.anchor.split(":")[0] ?? "", generated_at: Date.now() / 1000 };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}
