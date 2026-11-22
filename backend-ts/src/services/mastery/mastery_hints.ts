// Port of deeptutor/services/mastery_hints.py — the line the study composer
// shows before the learner types. Never blocks; "" means "keep placeholder".
import { isChinese } from "./prompts.js";
import { completeText } from "../llm_text.js";
import type { Settings } from "../../config.js";
import type { SessionStore } from "../../store/session_store.js";
import { LearningStore } from "./store.js";
import { findKnowledgePoint, nextObjective, pathDisplayName } from "./policy.js";

const MAX_HINT_CHARS: Record<string, number> = { zh: 44, en: 110 };
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

const SYSTEM_ZH = `你要写出学习者此刻**可以问导师的一个问题**。

给你的是他在精通路径上的位置，以及这段对话的结尾。写出他如果知道该问什么、接下来会问的那个问题。

硬规则：你写的是**问题**，绝不是答案。不要解释、不要暗示答案、不要出现"因为"。如果你这行字把知识点讲出来了，那就是错的——那部分应该由学习者和导师一起做出来。

规则：
- 只回复那个问题本身。不要引号、不要前缀、不要 markdown、不要任何补充说明。
- 第一人称，像学习者自己打出来的。不超过 25 个字。
- 以问号结尾。
- 必须是关于当前这个知识点的，且不能问导师上一条消息已经回答过的东西。
- 优先选那种能把问题打开的：一个区别、一个为什么、一个边界情况、一个"如果……会怎样"。避免是非题，也避免去问对话里已经给过的定义。

好："路由为什么需要意图，而不是只看查询本身？"
好："如果跳过反思那一步，会在哪里出问题？"
差："能讲讲路由吗？"              <- 要的是一段讲解，没点到任何边界
差："路由是按意图选工具，对吧？"  <- 把答案说出来了`;

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

function render(material: Material, zh: boolean): string {
  const lines: string[] = [];
  if (zh) {
    lines.push(`# 学习主题\n${material.path_name}`);
    if (material.goal) lines.push(`# 学习目标\n${material.goal}`);
    let where = `# 当前知识点\n${material.waypoint}`;
    if (material.module_name) where += `（所属模块：${material.module_name}）`;
    if (material.waypoint_type) where += `\n类型：${material.waypoint_type}`;
    if (material.status) where += `\n掌握状态：${material.status}`;
    lines.push(where);
  } else {
    lines.push(`# Topic\n${material.path_name}`);
    if (material.goal) lines.push(`# Goal\n${material.goal}`);
    let where = `# Current waypoint\n${material.waypoint}`;
    if (material.module_name) where += ` (module: ${material.module_name})`;
    if (material.waypoint_type) where += `\nType: ${material.waypoint_type}`;
    if (material.status) where += `\nStatus: ${material.status}`;
    lines.push(where);
  }
  if (material.transcript.length) {
    const speaker: Record<string, string> = zh
      ? { user: "学习者", assistant: "导师" }
      : { user: "Learner", assistant: "Tutor" };
    const body = material.transcript
      .map(([role, text]) => `[${speaker[role] ?? role}] ${text}`)
      .join("\n");
    lines.push((zh ? "# 对话结尾\n" : "# End of the conversation\n") + body);
  } else {
    lines.push(
      zh
        ? "# 对话结尾\n（还没开始，这是他要问的第一个问题。）"
        : "# End of the conversation\n(Nothing yet — this is their opening question.)",
    );
  }
  lines.push(zh ? "\n请写出那一个问题。" : "\nWrite that one question.");
  return lines.join("\n\n");
}

function sanitize(raw: string, language: string): string {
  let text = String(raw ?? "").replace(/\s+/g, " ");
  for (const fence of ["```", "「", "」", '"', "'", "“", "”", "‘", "’"]) {
    text = text.split(fence).join("");
  }
  text = text.replace(/^[-•*#\s]+/, "").trim();
  if (!text) return "";
  if (text.includes("\n")) text = text.split("\n").pop()!.trim();
  if (!text.endsWith("?") && !text.endsWith("？")) return "";
  const limit = isChinese(language) ? MAX_HINT_CHARS.zh : MAX_HINT_CHARS.en;
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
  if (!material.waypoint) return empty;
  material.transcript = transcript;
  material.anchor = `${material.anchor}:${anchor}`;

  const language = "en";
  const key = cacheKey(pathId, material.anchor, sessionId);
  const cached = cacheGet(key);
  if (cached) return cached;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<HintCacheEntry> => {
    try {
      const raw = await Promise.race([
        completeText(settings, {
          system: isChinese(language) ? SYSTEM_ZH : SYSTEM_EN,
          prompt: render(material, isChinese(language)),
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("ask-hint timeout")), LLM_TIMEOUT),
        ),
      ]);
      const hint = sanitize(raw, language);
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
