// web_continuity,runtime_status,interaction,commands,shell} consolidated.
//
// Persistence: SQLite ext_items (see store.ts). The upstream JSONL session
// files become one ext_items row per session stem holding the message list;
// web continuity / channel links / runtime status / drafts / soul library
// follow the same shapes as upstream so the API payloads match.
//
// Runtime: there is no channel bus in this backend. "Running" a partner is a
// process-local flag plus a published runtime-status row; each web turn runs
// a real LLM call (services/llm_text) with the partner's SOUL.md as system
// prompt and its own actor-scoped session history.
import { createHash } from "node:crypto";
import { getSettings } from "../../config.js";
import { completeText, streamText } from "../llm_text.js";
import {
  COL,
  deleteItem,
  getItem,
  isoNow,
  listItems,
  now,
  putItem,
  uuid12,
  uuid32,
  type AnyRecord,
} from "./store.js";
import {
  ADMIN_USER,
  assignedPartnerIds,
  canManagePartner,
  canUsePartner,
  currentUser,
  identityCard,
  type CurrentUser,
} from "./multiuser.js";
import { dispatchPartnerCommand, looksLikePartnerCommand, type CommandCtx } from "./commands.js";

// ── errors ─────────────────────────────────────────────────────
export class PartnerTurnBusyError extends Error {}
export class PartnerStaleSessionError extends Error {
  activeSessionKey: string;
  constructor(activeSessionKey: string) {
    super("The active conversation changed in another browser.");
    this.activeSessionKey = activeSessionKey;
  }
}
export class PartnerNotFoundError extends Error {}

// ── ids / secrets ──────────────────────────────────────────────
const RESERVED_NAMES = new Set(["workspace", "media", "sessions", "_souls"]);
const HYPHEN_RUN = /-+/g;
const LEGACY_GLOBAL_DELIVERY_KEYS = new Set([
  "send_progress",
  "send_tool_hints",
  "sendProgress",
  "sendToolHints",
]);
const SECRET_FIELD_HINTS = ["token", "secret", "password", "api_key", "apikey", "encrypt_key"];
const SECRET_MASK = "***";

function isSecretField(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_FIELD_HINTS.some((h) => n.includes(h));
}

export function maskChannelSecrets(channels: AnyRecord): AnyRecord {
  const walk = (value: unknown, keyHint?: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, keyHint));
    if (value && typeof value === "object") {
      const out: AnyRecord = {};
      for (const [k, v] of Object.entries(value as AnyRecord)) out[k] = walk(v, k);
      return out;
    }
    if (
      keyHint !== undefined &&
      isSecretField(keyHint) &&
      typeof value === "string" &&
      value
    ) {
      return SECRET_MASK;
    }
    return value;
  };
  const walked = walk(channels);
  return walked && typeof walked === "object" && !Array.isArray(walked) ? (walked as AnyRecord) : {};
}

export function stripLegacyGlobalDelivery(channels: AnyRecord): AnyRecord {
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) return {};
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(channels)) {
    if (!LEGACY_GLOBAL_DELIVERY_KEYS.has(k)) out[k] = v;
  }
  return out;
}

function slugifyId(name: string, fallback: string): string {
  const stripped = String(name || "").trim();
  const cleaned = [...stripped.toLowerCase()]
    .map((c) => (c.length === 1 && /[a-z0-9]/.test(c) ? c : "-"))
    .join("");
  const slug = cleaned.replace(HYPHEN_RUN, "-").replace(/^-+|-+$/g, "");
  if (slug) return slug;
  if (!stripped) return fallback;
  // Stable per-name fallback for non-ASCII names (sha1 -> hex prefix).
  const digest = createHash("sha1").update(stripped, "utf8").digest("hex").slice(0, 8);
  return `${fallback}-${digest}`;
}

export const slugifyPartnerId = (name: string) => slugifyId(name, "partner");
export const slugifySoulId = (name: string) => slugifyId(name, "soul");

function optionalStrList(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return null;
}

const MCP_TOOLS_UNRESTRICTED = "*";

function mcpToolsSetting(data: AnyRecord): string[] | null {
  if (!("mcp_tools" in data)) return [];
  const value = data["mcp_tools"];
  if (value === null || value === undefined) return [];
  const names = optionalStrList(value);
  if (names === null) return [];
  return names.includes(MCP_TOOLS_UNRESTRICTED) ? null : names;
}

// ── PartnerConfig ──────────────────────────────────────────────
export interface PartnerConfig {
  name: string;
  description: string;
  owner_id: string;
  workspace_id: string;
  channels: AnyRecord;
  llm_selection: AnyRecord | null;
  backup_llm_selection: AnyRecord | null;
  model: string | null;
  language: string;
  emoji: string;
  color: string;
  avatar: string;
  soul_origin: AnyRecord;
  enabled_tools: string[] | null;
  builtin_tools: string[] | null;
  mcp_tools: string[] | null;
}

export function defaultConfig(name: string): PartnerConfig {
  return {
    name,
    description: "",
    owner_id: "",
    workspace_id: "",
    channels: {},
    llm_selection: null,
    backup_llm_selection: null,
    model: null,
    language: "",
    emoji: "",
    color: "",
    avatar: "",
    soul_origin: {},
    enabled_tools: null,
    builtin_tools: null,
    mcp_tools: [],
  };
}

// ── soul defaults ──────────────────────────────────────────────
export const DEFAULT_SOUL = `# Soul

You are a warm, curious learning companion. Help the person actually understand
things — start from what they know, build one step up, prefer a worked example,
and check understanding with one small question. When you don't know, say so.
`;

export const DEFAULT_SOUL_TEMPLATES: AnyRecord[] = [
  {
    id: "companion",
    name: "Learning Companion",
    content: `# Soul

I am a learning companion — a steady, curious presence that helps people
actually understand things, not just collect answers.

## Voice

- Warm, direct, and concrete; no lecture-hall tone
- Chat-sized messages: one idea at a time, short paragraphs
- Plain words first, precise terms second — I define jargon the moment I use it

## How I help

- Start from what you already know, then build exactly one step up
- Prefer a worked example over an abstract explanation
- Check understanding with one small question, never a quiz barrage
- When I don't know, I say so and find out — accuracy beats fluency

## Boundaries

- On homework-style questions I guide before I reveal: hint, stronger hint, then the step
- I keep your pace — encouragement, never condescension
`,
  },
  {
    id: "math-tutor",
    name: "Math Tutor",
    content: `# Soul

I am a math tutor. What I'm after is the moment it clicks — not the answer itself.

## Voice

- Calm and unhurried; math anxiety is real and I never feed it
- Small steps, one per message, written to be read in a chat window
- Notation when it sharpens the idea, words when they're clearer

## Method

- Diagnose first: where exactly does your reasoning break?
- Socratic by default — a nudge, then a stronger hint, then the step itself
- Always ask "why does this rule work", not just "apply this rule"
- After we solve it, one quick variation to confirm it actually clicked

## Habits

- Estimate before computing; sanity-check after
- A wrong answer is information, not failure — we find the good idea inside it
`,
  },
  {
    id: "coding-assistant",
    name: "Coding Assistant",
    content: `# Soul

I am a coding assistant — a pragmatic pair programmer living in your chat.

## Voice

- Precise and to the point: the snippet that matters, not a wall of code
- Code speaks first, prose explains why
- Honest about uncertainty and trade-offs — no hand-waving

## Craft

- Read before writing: respect the existing style and constraints
- Smallest change that solves the problem; name the trade-off when there is one
- Errors and edge cases are part of the answer, not an afterthought
- Every fix ships with a way to verify it — a test, a command, an expected output

## Boundaries

- I don't guess APIs; when unsure I say so and show how to check
`,
  },
  {
    id: "research-helper",
    name: "Research Helper",
    content: `# Soul

I am a research helper. I turn vague questions into answerable ones, and
answers into something you can actually trust.

## Voice

- Neutral and curious; I argue with evidence, not adjectives
- Structured replies sized for chat: the claim, the evidence, what's still open

## Method

- Decompose broad questions into specific sub-questions before searching
- Separate established findings, active debate, and speculation — and label which is which
- Prefer primary sources; cite what I rely on so you can check it
- Steelman the opposing reading before settling a question

## Honesty

- "The evidence is thin here" is a finding, not an apology
- I flag my own uncertainty instead of smoothing it over
`,
  },
  {
    id: "language-tutor",
    name: "Language Tutor",
    content: `# Soul

I am a language tutor. You learn a language by using it — so this chat is
the classroom.

## Voice

- Friendly and a little playful; mistakes are welcome here
- I match your level: simple words for beginners, nuance as you grow

## Method

- Converse first, correct second: I respond to what you said, then gently fix how you said it
- One correction at a time, with a one-line why
- Phrases in context, never isolated word lists
- I recycle yesterday's vocabulary into today's conversation

## Habits

- I celebrate attempts at structures we haven't covered yet
- Ask me "how do I say X" and you get the natural phrasing, not the literal one
`,
  },
];

function stripFrontmatter(content: string): string {
  return String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

// ── session store ──────────────────────────────────────────────
// One ext_items row per session stem under collection
// partners_ext/sessions/<pid>/<actorKey>; payload {id: stem, messages: [...]}.

export function safeFilename(name: string): string {
  return String(name || "")
    .replace(/[\\/:*?"<>|\-\u001f]/g, "_")
    .replace(/\.{2,}/g, ".")
    .slice(0, 200);
}

function sessionStem(sessionKey: string): string {
  return safeFilename(sessionKey).replace(/^\.+|\.+$/g, "") || "default";
}

function isMessageRecord(r: AnyRecord): boolean {
  if (!r || typeof r !== "object" || !r["role"]) return false;
  if (r["content"]) return true;
  const atts = r["attachments"];
  return (
    Array.isArray(atts) &&
    atts.some((a) => a && typeof a === "object" && a["type"] === "image" && a["filename"])
  );
}

export class PartnerSessionStore {
  constructor(
    private partnerId: string,
    private actorKey: string,
  ) {}

  private col(): string {
    return COL.partnerSessions(this.partnerId, this.actorKey);
  }

  private load(stem: string): AnyRecord | null {
    return getItem(this.col(), stem);
  }

  private save(stem: string, item: AnyRecord): void {
    putItem(this.col(), { ...item, id: stem });
  }

  isArchivedKey(sessionKey: string): boolean {
    return safeFilename(sessionKey).startsWith("_archived_");
  }

  isArchived(sessionKey: string): boolean {
    const stem = sessionStem(sessionKey);
    const item = this.load(stem);
    if (item?.["archived"]) return true;
    return this.isArchivedKey(sessionKey);
  }

  setArchived(sessionKey: string, archived: boolean): boolean {
    const stem = sessionStem(sessionKey);
    const item = this.load(stem);
    if (!item) return false;
    if (archived) item["archived"] = true;
    else delete item["archived"];
    this.save(stem, item);
    return true;
  }

  deleteSession(sessionKey: string): boolean {
    const stem = sessionStem(sessionKey);
    return deleteItem(this.col(), stem);
  }

  append(
    sessionKey: string,
    role: string,
    content: string,
    opts: {
      channel?: string;
      sender_id?: string;
      chat_id?: string;
      scope?: string;
      metadata?: AnyRecord;
      attachments?: AnyRecord[];
      events?: AnyRecord[];
    } = {},
  ): void {
    const stem = sessionStem(sessionKey);
    const item = this.load(stem) ?? { id: stem, messages: [] };
    const record: AnyRecord = {
      role,
      content,
      timestamp: new Date().toISOString(),
    };
    if (opts.channel) record["channel"] = opts.channel;
    if (opts.sender_id) record["sender_id"] = opts.sender_id;
    if (opts.chat_id) record["chat_id"] = opts.chat_id;
    if (opts.scope) record["scope"] = opts.scope;
    if (opts.metadata) record["metadata"] = opts.metadata;
    if (opts.attachments?.length) record["attachments"] = opts.attachments;
    if (opts.events?.length) record["events"] = opts.events;
    (item["messages"] as AnyRecord[]).push(record);
    this.save(stem, item);
  }

  private records(sessionKey: string): AnyRecord[] {
    const item = this.load(sessionStem(sessionKey));
    const msgs = Array.isArray(item?.["messages"]) ? (item["messages"] as AnyRecord[]) : [];
    return msgs.filter(isMessageRecord);
  }

  conversationHistory(
    sessionKey: string,
    opts: { maxMessages?: number; maxChars?: number } = {},
  ): Array<{ role: string; content: string }> {
    const maxMessages = opts.maxMessages ?? 40;
    const maxChars = opts.maxChars ?? 24_000;
    const records = this.records(sessionKey).filter((r) => r["content"]);
    const window = records
      .slice(-maxMessages)
      .filter((r) => r["role"] === "user" || r["role"] === "assistant")
      .map((r) => ({ role: String(r["role"]), content: String(r["content"]) }));
    const kept: Array<{ role: string; content: string }> = [];
    let total = 0;
    for (const m of [...window].reverse()) {
      total += m.content.length;
      if (kept.length && total > maxChars) break;
      kept.push(m);
    }
    return kept.reverse();
  }

  messages(sessionKey: string, opts: { limit?: number } = {}): AnyRecord[] {
    const limit = opts.limit ?? 100;
    return this.records(sessionKey).slice(-limit);
  }

  messagesPage(
    sessionKey: string,
    opts: { before?: number | null; limit?: number } = {},
  ): AnyRecord {
    const limit = Math.max(1, Math.min(opts.limit ?? 60, 200));
    const records = this.records(sessionKey);
    const total = records.length;
    const cursor = opts.before === null || opts.before === undefined ? null : Math.max(opts.before, 0);
    const end = cursor === null ? total : Math.min(cursor, total);
    const start = Math.max(0, end - limit);
    return {
      messages: records.slice(start, end),
      next_before: start > 0 ? start : null,
      start,
      total,
    };
  }

  mergedMessages(opts: { limit?: number; includeArchived?: boolean } = {}): AnyRecord[] {
    const limit = opts.limit ?? 100;
    const includeArchived = opts.includeArchived ?? false;
    const items = listItems(this.col());
    const merged: Array<{ ts: string; seq: number; rec: AnyRecord }> = [];
    let seq = 0;
    for (const item of items.sort((a, b) => Number(a["updated_at"] ?? 0) - Number(b["updated_at"] ?? 0))) {
      const stem = String(item["id"] ?? "");
      if (!includeArchived && (item["archived"] || this.isArchivedKey(stem))) continue;
      for (const rec of (item["messages"] as AnyRecord[]) ?? []) {
        if (isMessageRecord(rec)) merged.push({ ts: String(rec["timestamp"] || ""), seq: seq++, rec });
      }
    }
    merged.sort((a, b) => (a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1));
    return merged.slice(-limit).map((m) => m.rec);
  }

  archiveSession(sessionKey: string): AnyRecord | null {
    const records = this.records(sessionKey);
    if (!records.length) return null;
    const stem = sessionStem(sessionKey);
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const archiveKey = `_archived_${stamp}_${stem}`;
    const item = this.load(stem);
    const dest: AnyRecord = { id: archiveKey, messages: item?.["messages"] ?? [] };
    this.save(archiveKey, dest);
    this.deleteSession(sessionKey);
    return this.summary(archiveKey);
  }

  branch(sourceKey: string, newKey: string): AnyRecord | null {
    const src = this.load(sessionStem(sourceKey));
    const records = Array.isArray(src?.["messages"]) ? (src["messages"] as AnyRecord[]) : [];
    if (!records.length) return null;
    const destStem = sessionStem(newKey);
    if (this.load(destStem)) throw new Error("Destination session already exists");
    const dest: AnyRecord = { id: destStem, messages: records.map((r) => ({ ...r })) };
    this.save(destStem, dest);
    this.setArchived(sourceKey, true);
    return this.summary(destStem);
  }

  private summary(stem: string): AnyRecord {
    const item = this.load(stem);
    const records = Array.isArray(item?.["messages"]) ? (item["messages"] as AnyRecord[]) : [];
    const last = records[records.length - 1] ?? {};
    const opener = records.find((r) => r["role"] === "user") ?? records[0];
    let title = "";
    if (opener) {
      title = String(opener["content"] || "").trim().split("\n")[0].slice(0, 60).trim();
    }
    const first = records[0] ?? {};
    return {
      session_key: stem,
      title,
      message_count: records.length,
      updated_at: item?.["updated_at"] ? new Date(Number(item["updated_at"]) * 1000).toISOString() : isoNow(),
      last_message: String(last["content"] || "").slice(0, 200),
      archived: Boolean(item?.["archived"]),
      ...(first["chat_id"] ? { chat_id: String(first["chat_id"]), ...(first["scope"] ? { scope: String(first["scope"]) } : {}) } : {}),
    };
  }

  listSessions(): AnyRecord[] {
    return listItems(this.col())
      .map((item) => this.summary(String(item["id"] ?? "")))
      .sort((a, b) => String(b["updated_at"]).localeCompare(String(a["updated_at"])));
  }
}

// ── web continuity ─────────────────────────────────────────────
const SESSION_KEY_RE = /^[^<>"/\\|?*\-\u001f]+$/;

export function validateSessionKey(sessionKey: string): string {
  const key = String(sessionKey || "").trim();
  if (!SESSION_KEY_RE.test(key) || key.length > 128) throw new Error("Invalid Partner session key");
  const stem = safeFilename(key);
  if (!stem || stem !== key.replace(/:/g, "_")) throw new Error("Invalid Partner session key");
  return stem;
}

export function freshWebSessionKey(): string {
  return `web-${uuid32()}`;
}

export function webSessionKey(partnerId: string, opts: { chat_id?: string; session_id?: string } = {}): string {
  const sid = String(opts.session_id || "").trim();
  if (sid) return `web:${sid}`;
  const chat = String(opts.chat_id || "web").trim() || "web";
  if (chat !== "web") return `web:${chat}`;
  return `partner:${partnerId}`;
}

export function getWebContinuity(partnerId: string, accountId: string): AnyRecord {
  const item = getItem(COL.partnerContinuity(partnerId, accountId), "state");
  if (!item || item["enabled"] !== true) return { enabled: false, session_key: null };
  try {
    return { enabled: true, session_key: validateSessionKey(String(item["session_key"])) };
  } catch {
    return { enabled: false, session_key: null };
  }
}

export function setWebContinuity(
  partnerId: string,
  accountId: string,
  opts: { enabled: boolean; session_key?: string | null },
): AnyRecord {
  const state: AnyRecord = {
    enabled: Boolean(opts.enabled),
    session_key: opts.enabled && opts.session_key ? validateSessionKey(String(opts.session_key)) : null,
  };
  putItem(COL.partnerContinuity(partnerId, accountId), { id: "state", ...state });
  return state;
}

export function moveActiveWebSession(
  partnerId: string,
  accountId: string,
  opts: {
    session_key: string;
    new_session_key: string;
    only_if_current?: boolean;
  },
): string | null {
  const state = getWebContinuity(partnerId, accountId);
  if (!state["enabled"]) return null;
  if (opts.only_if_current !== false) {
    let source: string;
    try {
      source = validateSessionKey(opts.session_key);
    } catch {
      return null;
    }
    if (state["session_key"] !== source) return null;
  }
  const nextKey = validateSessionKey(opts.new_session_key);
  setWebContinuity(partnerId, accountId, { enabled: true, session_key: nextKey });
  return nextKey;
}

// ── drafts ─────────────────────────────────────────────────────
const SAFE_DRAFT_ID = /^[a-f0-9]{32}$/;

export interface PartnerDraft {
  draft_id: string;
  owner_id: string;
  name: string;
  description: string;
  soul: string;
  language: string;
  emoji: string;
  color: string;
  enabled_tools: string[] | null;
  builtin_tools: string[] | null;
  mcp_tools: string[] | null;
  status: string;
  created_at: string;
  created_partner_id: string;
  version: number;
  id?: string;
}

function draftText(value: unknown, limit: number): string {
  return String(value ?? "").trim().slice(0, limit);
}
function draftColor(value: unknown): string {
  const c = draftText(value, 16);
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : "";
}
function draftStringList(value: unknown, dflt: string[] | null = null): string[] | null {
  if (value === null || value === undefined) return dflt;
  if (!Array.isArray(value)) return dflt;
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))].slice(0, 100);
}

export class PartnerDraftStore {
  create(profile: AnyRecord, ownerId: string): PartnerDraft {
    const draft: PartnerDraft = {
      draft_id: uuid32(),
      id: uuid32(),
      owner_id: ownerId,
      name: draftText(profile["name"], 80),
      description: draftText(profile["description"], 500),
      soul: draftText(profile["soul"], 20_000),
      language: draftText(profile["language"], 16),
      emoji: draftText(profile["emoji"], 16),
      color: draftColor(profile["color"]),
      enabled_tools: draftStringList(profile["enabled_tools"]),
      builtin_tools: draftStringList(profile["builtin_tools"]),
      mcp_tools: draftStringList(profile["mcp_tools"], []),
      status: "pending",
      created_at: new Date().toISOString(),
      created_partner_id: "",
      version: 1,
    };
    if (!draft.name) throw new Error("A Partner draft needs a name.");
    if (!draft.soul) throw new Error("A Partner draft needs a non-empty soul profile.");
    putItem(COL.partnerDrafts, { ...draft, id: draft.draft_id });
    const { id: _id, ...rest } = draft;
    return { ...rest, id: draft.draft_id };
  }

  get(draftId: string, ownerId: string): PartnerDraft | null {
    const normalized = String(draftId || "").trim().toLowerCase();
    if (!SAFE_DRAFT_ID.test(normalized)) return null;
    const item = getItem(COL.partnerDrafts, normalized);
    if (!item || item["owner_id"] !== ownerId) return null;
    return { ...(item as PartnerDraft), draft_id: normalized };
  }

  markCreated(draft: PartnerDraft, partnerId: string): void {
    putItem(COL.partnerDrafts, {
      ...draft,
      id: draft.draft_id,
      status: "created",
      created_partner_id: partnerId,
    });
  }
}

// ── links ──────────────────────────────────────────────────────
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_TTL_MS = 15 * 60 * 1000;

function linksPath(pid: string) {
  return COL.partnerLinks(pid);
}
function readLinks(pid: string): AnyRecord {
  const item = getItem(linksPath(pid), "state");
  if (!item) return { links: {}, codes: {} };
  return {
    links: item["links"] && typeof item["links"] === "object" ? item["links"] : {},
    codes: item["codes"] && typeof item["codes"] === "object" ? item["codes"] : {},
  };
}
function writeLinks(pid: string, state: AnyRecord): void {
  putItem(linksPath(pid), { id: "state", ...state });
}
function linkKey(channel: string, senderId: string): string {
  return `${channel}:${senderId}`;
}

export function issueLinkCode(partnerId: string, userId: string): { code: string; expires_at: string } {
  const state = readLinks(partnerId);
  const nowMs = Date.now();
  // drop expired + this user's previous codes
  for (const [code, rec] of Object.entries(state["codes"] as AnyRecord)) {
    const r = rec as AnyRecord;
    if (r["user_id"] === userId || new Date(String(r["expires_at"])).getTime() < nowMs) {
      delete (state["codes"] as AnyRecord)[code];
    }
  }
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  const expiresAt = new Date(nowMs + CODE_TTL_MS).toISOString();
  (state["codes"] as AnyRecord)[code] = { user_id: userId, expires_at: expiresAt };
  writeLinks(partnerId, state);
  return { code, expires_at: expiresAt };
}

export function redeemLinkCode(partnerId: string, code: string, channel: string, senderId: string): string | null {
  const wanted = String(code || "").trim().toUpperCase();
  if (!wanted) return null;
  const state = readLinks(partnerId);
  const codes = state["codes"] as AnyRecord;
  const record = codes[wanted];
  if (!record || typeof record !== "object") return null;
  if (new Date(String(record["expires_at"])).getTime() < Date.now()) {
    delete codes[wanted];
    writeLinks(partnerId, state);
    return null;
  }
  delete codes[wanted];
  const userId = String(record["user_id"] || "");
  if (!userId) {
    writeLinks(partnerId, state);
    return null;
  }
  (state["links"] as AnyRecord)[linkKey(channel, senderId)] = {
    user_id: userId,
    channel,
    sender_id: senderId,
    linked_at: new Date().toISOString(),
  };
  writeLinks(partnerId, state);
  return userId;
}

export function listLinks(partnerId: string, userId: string): AnyRecord[] {
  const links = readLinks(partnerId)["links"] as AnyRecord;
  return Object.entries(links)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, rec]) => rec && typeof rec === "object" && rec["user_id"] === userId)
    .map(([key, rec]) => ({ key, ...(rec as AnyRecord) }));
}

export function removeLink(partnerId: string, userId: string, key: string): boolean {
  const state = readLinks(partnerId);
  const links = state["links"] as AnyRecord;
  const rec = links[key];
  if (!rec || typeof rec !== "object" || rec["user_id"] !== userId) return false;
  delete links[key];
  writeLinks(partnerId, state);
  return true;
}

// ── runtime status ─────────────────────────────────────────────
function runtimeGet(pid: string): AnyRecord | null {
  return getItem(COL.partnerRuntime, pid);
}
function runtimeSet(
  pid: string,
  opts: { owner_id: string; running: boolean; state: string; started_at?: string | null; last_reload_error?: string | null; payload?: AnyRecord },
): AnyRecord {
  const updatedAt = now();
  const payload: AnyRecord = { ...(opts.payload || {}) };
  delete payload["channels"];
  payload["partner_id"] = pid;
  payload["runtime_owner_id"] = opts.owner_id;
  payload["running"] = Boolean(opts.running);
  payload["runtime_state"] = opts.state;
  payload["started_at"] = opts.started_at ?? null;
  payload["last_reload_error"] = opts.last_reload_error ?? null;
  payload["runtime_updated_at"] = updatedAt;
  putItem(COL.partnerRuntime, { id: pid, ...payload });
  return payload;
}
function runtimeList(): Record<string, AnyRecord> {
  const out: Record<string, AnyRecord> = {};
  for (const item of listItems(COL.partnerRuntime)) out[String(item["id"])] = item;
  return out;
}
function runtimeDelete(pid: string): void {
  deleteItem(COL.partnerRuntime, pid);
}

// ── PartnerManager ─────────────────────────────────────────────

// ── live web turns / activity feed ─────────────────────────────
// Port of upstream ``LiveTurn`` + ``PartnerActivityFeed``
// (services/partners/manager.py). A web turn runs decoupled from any single
// WebSocket: frames fan out to per-subscriber queues (with the backlog
// buffered) so a refresh can reattach and replay instead of killing the turn.

/** Minimal async FIFO the LiveTurn subscribers drain. */
export class FrameQueue {
  private items: AnyRecord[] = [];
  private waiters: Array<(frame: AnyRecord | null) => void> = [];
  private _closed = false;

  get closed(): boolean {
    return this._closed;
  }

  push(frame: AnyRecord): void {
    if (this._closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.items.push(frame);
  }

  /** Next frame, or null once closed and drained. */
  get(): Promise<AnyRecord | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this._closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w(null);
  }
}

export class LiveTurn {
  /** The user message that opened the turn (re-shown on reattach). */
  userContent = "";
  events: AnyRecord[] = [];
  terminal: AnyRecord[] = [];
  done = false;
  subscribers = new Set<FrameQueue>();
  /** Aborted by stop_web_turn; sendMessage checks it between deltas. */
  readonly abort = new AbortController();

  emit(frame: AnyRecord): void {
    this.events.push(frame);
    for (const queue of this.subscribers) queue.push(frame);
  }

  finish(frames: AnyRecord[]): void {
    this.terminal = frames;
    this.done = true;
    for (const queue of this.subscribers) {
      for (const frame of frames) queue.push(frame);
    }
    this.subscribers.clear();
  }

  subscribe(): FrameQueue {
    // Preload backlog + register atomically (no await between) so no frame is
    // missed or duplicated at the boundary.
    const queue = new FrameQueue();
    for (const frame of [...this.events, ...this.terminal]) queue.push(frame);
    if (!this.done) this.subscribers.add(queue);
    return queue;
  }

  unsubscribe(queue: FrameQueue): void {
    this.subscribers.delete(queue);
    queue.close();
  }
}

/** Per-account broadcast feed for turns arriving from external channels. */
export class PartnerActivityFeed {
  maxRecent = 32;
  private recent = new Map<string, Map<string, AnyRecord[]>>();
  private subscribers = new Map<string, Set<FrameQueue>>();

  private static key(actorId: string | null | undefined): string {
    return actorId || "";
  }

  publish(actorId: string | null | undefined, frame: AnyRecord): void {
    const key = PartnerActivityFeed.key(actorId);
    const activityId = String(frame["activity_id"] || "").trim();
    if (activityId) {
      let recent = this.recent.get(key);
      if (!recent) {
        recent = new Map();
        this.recent.set(key, recent);
      }
      if (!recent.has(activityId)) {
        recent.set(activityId, []);
        while (recent.size > this.maxRecent) {
          const oldest = recent.keys().next().value;
          if (oldest === undefined) break;
          recent.delete(oldest);
        }
      }
      const retained = recent.get(activityId)!;
      retained.push({ ...frame });
      if (frame["type"] === "done") {
        // Late subscribers replay only the gap before history caught up —
        // stream_event deltas are dropped, same as upstream.
        recent.set(
          activityId,
          retained.filter((item) => item["type"] !== "stream_event"),
        );
      }
    }
    for (const queue of [...(this.subscribers.get(key) ?? [])]) queue.push({ ...frame });
  }

  subscribeMany(actorIds: Array<string | null | undefined>): FrameQueue {
    const queue = new FrameQueue();
    const seen = new Set<string>();
    for (const actorId of actorIds) {
      const key = PartnerActivityFeed.key(actorId);
      if (seen.has(key)) continue;
      seen.add(key);
      const recent = this.recent.get(key);
      if (recent) {
        for (const frames of recent.values()) {
          for (const frame of frames) queue.push({ ...frame });
        }
      }
      let subs = this.subscribers.get(key);
      if (!subs) {
        subs = new Set();
        this.subscribers.set(key, subs);
      }
      subs.add(queue);
    }
    return queue;
  }

  unsubscribeMany(actorIds: Array<string | null | undefined>, queue: FrameQueue): void {
    const seen = new Set<string>();
    for (const actorId of actorIds) {
      const key = PartnerActivityFeed.key(actorId);
      if (seen.has(key)) continue;
      seen.add(key);
      const subs = this.subscribers.get(key);
      if (!subs) continue;
      subs.delete(queue);
      if (!subs.size) this.subscribers.delete(key);
    }
    queue.close();
  }
}

/** Account id requiring private Partner state, or null for legacy scope. */
export function personalActorId(actor: CurrentUser | null | undefined): string | null {
  if (!actor || actor.is_admin) return null;
  return actor.id;
}

interface RunningPartner {
  partner_id: string;
  config: PartnerConfig;
  started_at: string;
  last_reload_error: string | null;
  running: boolean;
  /** In-flight web turns by session_key (upstream PartnerInstance.live_turns). */
  live_turns: Map<string, LiveTurn>;
  activityFeed: PartnerActivityFeed;
}

const _partners = new Map<string, RunningPartner>();
const _startLocks = new Map<string, Promise<void>>();

export class PartnerManager {
  readonly runtimeOwnerId = `process:${process.pid}`;

  private partnerExistsOnDisk(pid: string): boolean {
    return getItem(COL.partnerConfigs, pid) !== null;
  }

  partnerExists(pid: string): boolean {
    return this.partnerExistsOnDisk(pid) || _partners.has(pid);
  }

  ownerId(pid: string): string {
    const inst = _partners.get(pid);
    if (inst) return inst.config.owner_id;
    const cfg = this.loadConfig(pid);
    return cfg?.owner_id ?? "";
  }

  loadConfig(pid: string): PartnerConfig | null {
    const item = getItem(COL.partnerConfigs, pid);
    if (!item) return null;
    const cfg = item["config"] as AnyRecord | undefined;
    if (!cfg || typeof cfg !== "object") return null;
    return {
      name: String(cfg["name"] ?? pid),
      description: String(cfg["description"] ?? ""),
      owner_id: String(cfg["owner_id"] ?? ""),
      workspace_id: String(cfg["workspace_id"] ?? ""),
      channels: stripLegacyGlobalDelivery((cfg["channels"] as AnyRecord) ?? {}),
      llm_selection: (cfg["llm_selection"] as AnyRecord) ?? null,
      backup_llm_selection: (cfg["backup_llm_selection"] as AnyRecord) ?? null,
      model: (cfg["model"] as string) ?? null,
      language: String(cfg["language"] ?? ""),
      emoji: String(cfg["emoji"] ?? ""),
      color: String(cfg["color"] ?? ""),
      avatar: String(cfg["avatar"] ?? ""),
      soul_origin: (cfg["soul_origin"] as AnyRecord) ?? {},
      enabled_tools: optionalStrList(cfg["enabled_tools"]),
      builtin_tools: optionalStrList(cfg["builtin_tools"]),
      mcp_tools: mcpToolsSetting(cfg),
    };
  }

  autoStart(pid: string): boolean {
    const item = getItem(COL.partnerConfigs, pid);
    return item?.["auto_start"] !== false;
  }

  saveConfig(pid: string, config: PartnerConfig, opts: { auto_start?: boolean | null } = {}): void {
    const existing = getItem(COL.partnerConfigs, pid);
    const autoStart =
      opts.auto_start !== undefined && opts.auto_start !== null
        ? Boolean(opts.auto_start)
        : existing
          ? existing["auto_start"] !== false
          : true;
    putItem(COL.partnerConfigs, {
      id: pid,
      config: {
        name: config.name,
        description: config.description,
        owner_id: config.owner_id,
        workspace_id: config.workspace_id,
        channels: stripLegacyGlobalDelivery(config.channels),
        language: config.language,
        emoji: config.emoji,
        color: config.color,
        avatar: config.avatar,
        soul_origin: config.soul_origin,
        ...(config.llm_selection ? { llm_selection: config.llm_selection } : {}),
        ...(config.backup_llm_selection ? { backup_llm_selection: config.backup_llm_selection } : {}),
        ...(config.model ? { model: config.model } : {}),
        ...(config.enabled_tools !== null ? { enabled_tools: config.enabled_tools } : {}),
        ...(config.builtin_tools !== null ? { builtin_tools: config.builtin_tools } : {}),
        mcp_tools: config.mcp_tools === null ? [MCP_TOOLS_UNRESTRICTED] : config.mcp_tools,
      },
      auto_start: autoStart,
    });
  }

  // actor-scoped session store (interaction.session_store_for)
  sessionStore(pid: string, actor: CurrentUser | null = currentUser()): PartnerSessionStore {
    // Admins share the legacy pool; named users get a private directory key.
    const actorKey =
      actor && !actor.is_admin ? `user:${actor.id}` : actor && actor.id !== ADMIN_USER.id ? `user:${actor.id}` : "shared";
    return new PartnerSessionStore(pid, actorKey);
  }

  // ── souls ──
  listSouls(): AnyRecord[] {
    const items = listItems(COL.partnerSouls);
    if (!items.length) {
      for (const s of DEFAULT_SOUL_TEMPLATES) {
        putItem(COL.partnerSouls, { id: String(s["id"]), name: s["name"], content: s["content"] });
      }
      return this.listSouls();
    }
    return items.map((i) => ({ id: i["id"], name: i["name"], content: i["content"] }));
  }
  getSoul(soulId: string): AnyRecord | null {
    const item = getItem(COL.partnerSouls, soulId);
    return item ? { id: item["id"], name: item["name"], content: item["content"] } : null;
  }
  createSoul(soulId: string, name: string, content: string): AnyRecord {
    const entry = { id: soulId, name, content };
    putItem(COL.partnerSouls, entry);
    return entry;
  }
  updateSoul(soulId: string, name: string | null, content: string | null): AnyRecord | null {
    const item = getItem(COL.partnerSouls, soulId);
    if (!item) return null;
    if (name !== null) item["name"] = name;
    if (content !== null) item["content"] = content;
    putItem(COL.partnerSouls, item);
    return { id: item["id"], name: item["name"], content: item["content"] };
  }
  deleteSoul(soulId: string): boolean {
    return deleteItem(COL.partnerSouls, soulId);
  }

  // ── listing ──
  private discoverPartnerIds(): Set<string> {
    return new Set(listItems(COL.partnerConfigs).map((i) => String(i["id"])));
  }

  listPartners(): AnyRecord[] {
    const result = new Map<string, AnyRecord>();
    for (const inst of _partners.values()) {
      result.set(inst.partner_id, this.instanceToDict(inst, { mask_secrets: false }));
    }
    for (const pid of this.discoverPartnerIds()) {
      if (result.has(pid)) continue;
      const cfg = this.loadConfig(pid);
      result.set(pid, {
        partner_id: pid,
        name: cfg?.name ?? pid,
        description: cfg?.description ?? "",
        owner_id: cfg?.owner_id ?? "",
        workspace_id: cfg?.workspace_id ?? "",
        channels: cfg ? Object.keys(cfg.channels) : [],
        llm_selection: cfg?.llm_selection ?? null,
        backup_llm_selection: cfg?.backup_llm_selection ?? null,
        model: cfg?.model ?? null,
        language: cfg?.language ?? "",
        emoji: cfg?.emoji ?? "",
        color: cfg?.color ?? "",
        avatar: cfg?.avatar ?? "",
        soul_origin: cfg?.soul_origin ?? {},
        enabled_tools: cfg?.enabled_tools ?? null,
        builtin_tools: cfg?.builtin_tools ?? null,
        mcp_tools: cfg?.mcp_tools ?? null,
        running: false,
        started_at: null,
        last_reload_error: null,
      });
    }
    for (const [pid, status] of Object.entries(runtimeList())) {
      const row = result.get(pid);
      if (!row) continue;
      for (const key of [
        "running",
        "started_at",
        "last_reload_error",
        "runtime_owner_id",
        "runtime_state",
        "runtime_updated_at",
      ]) {
        if (key in status) row[key] = status[key];
      }
    }
    return [...result.values()];
  }

  getPartner(pid: string): RunningPartner | null {
    return _partners.get(pid) ?? null;
  }

  private instanceToDict(inst: RunningPartner, opts: { mask_secrets?: boolean; include_secrets?: boolean } = {}): AnyRecord {
    const src = stripLegacyGlobalDelivery(inst.config.channels);
    const channels = opts.include_secrets
      ? src
      : opts.mask_secrets
        ? maskChannelSecrets(src)
        : Object.keys(src);
    return {
      partner_id: inst.partner_id,
      name: inst.config.name,
      description: inst.config.description,
      owner_id: inst.config.owner_id,
      workspace_id: inst.config.workspace_id,
      channels,
      llm_selection: inst.config.llm_selection,
      backup_llm_selection: inst.config.backup_llm_selection,
      model: inst.config.model,
      language: inst.config.language,
      emoji: inst.config.emoji,
      color: inst.config.color,
      avatar: inst.config.avatar,
      soul_origin: inst.config.soul_origin,
      enabled_tools: inst.config.enabled_tools,
      builtin_tools: inst.config.builtin_tools,
      mcp_tools: inst.config.mcp_tools,
      running: inst.running,
      started_at: inst.started_at,
      last_reload_error: inst.last_reload_error,
    };
  }

  stoppedPartnerDict(pid: string, cfg: PartnerConfig, opts: { include_secrets?: boolean } = {}): AnyRecord {
    const channels = opts.include_secrets
      ? stripLegacyGlobalDelivery(cfg.channels)
      : maskChannelSecrets(stripLegacyGlobalDelivery(cfg.channels));
    const result: AnyRecord = {
      partner_id: pid,
      workspace_id: cfg.workspace_id,
      name: cfg.name,
      description: cfg.description,
      channels,
      llm_selection: cfg.llm_selection,
      backup_llm_selection: cfg.backup_llm_selection,
      model: cfg.model,
      language: cfg.language,
      emoji: cfg.emoji,
      color: cfg.color,
      avatar: cfg.avatar,
      soul_origin: cfg.soul_origin,
      enabled_tools: cfg.enabled_tools,
      builtin_tools: cfg.builtin_tools,
      mcp_tools: cfg.mcp_tools,
      running: false,
      started_at: null,
      last_reload_error: null,
    };
    const status = runtimeGet(pid);
    if (status) {
      for (const key of [
        "running",
        "started_at",
        "last_reload_error",
        "runtime_owner_id",
        "runtime_state",
        "runtime_updated_at",
      ]) {
        if (key in status) result[key] = status[key];
      }
    }
    return result;
  }

  // ── lifecycle ──
  async startPartner(pid: string, config?: PartnerConfig | null): Promise<RunningPartner> {
    const existing = _partners.get(pid);
    if (existing?.running) return existing;
    const cfg = config ?? this.loadConfig(pid) ?? defaultConfig(pid);
    if (!this.partnerExistsOnDisk(pid)) this.saveConfig(pid, cfg);
    const inst: RunningPartner = {
      partner_id: pid,
      config: cfg,
      started_at: new Date().toISOString(),
      last_reload_error: null,
      running: true,
      live_turns: new Map(),
      activityFeed: new PartnerActivityFeed(),
    };
    _partners.set(pid, inst);
    this.saveConfig(pid, cfg);
    runtimeSet(pid, {
      owner_id: this.runtimeOwnerId,
      running: true,
      state: "running",
      started_at: inst.started_at,
      payload: this.instanceToDict(inst, { mask_secrets: true }),
    });
    return inst;
  }

  async stopPartner(pid: string, opts: { preserve_auto_start?: boolean } = {}): Promise<boolean> {
    const inst = _partners.get(pid);
    const autoStart = opts.preserve_auto_start ? this.autoStart(pid) : false;
    if (!inst) {
      if (this.partnerExistsOnDisk(pid)) {
        runtimeSet(pid, { owner_id: this.runtimeOwnerId, running: false, state: "stopped" });
      }
      return false;
    }
    inst.running = false;
    this.saveConfig(pid, inst.config, { auto_start: autoStart });
    _partners.delete(pid);
    runtimeSet(pid, { owner_id: this.runtimeOwnerId, running: false, state: "stopped" });
    return true;
  }

  async reloadChannels(pid: string): Promise<void> {
    const inst = _partners.get(pid);
    if (!inst || !inst.running) return;
    inst.last_reload_error = null;
    runtimeSet(pid, {
      owner_id: this.runtimeOwnerId,
      running: true,
      state: "running",
      payload: this.instanceToDict(inst, { mask_secrets: true }),
    });
  }

  async destroyPartner(pid: string): Promise<boolean> {
    await this.stopPartner(pid, { preserve_auto_start: false });
    runtimeDelete(pid);
    const existed = deleteItem(COL.partnerConfigs, pid);
    // Best-effort cleanup of derived collections.
    for (const item of listItems(`partners_ext/sessions/${pid}/shared`)) {
      deleteItem(`partners_ext/sessions/${pid}/shared`, String(item["id"]));
    }
    return existed;
  }

  async ensureRunning(pid: string, opts: { allow_stopped?: boolean } = {}): Promise<RunningPartner> {
    const inst = _partners.get(pid);
    if (inst?.running) return inst;
    const cfg = this.loadConfig(pid);
    if (!cfg) throw new PartnerNotFoundError(`Partner '${pid}' not found`);
    if (!opts.allow_stopped && !this.autoStart(pid)) {
      throw new Error("partner_stopped_start_required");
    }
    let lock = _startLocks.get(pid);
    if (!lock) {
      lock = Promise.resolve();
      _startLocks.set(pid, lock);
    }
    await lock;
    const again = _partners.get(pid);
    if (again?.running) return again;
    try {
      return await this.startPartner(pid, cfg);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      _startLocks.delete(pid);
    }
  }

  // ── history / sessions ──
  getHistory(
    pid: string,
    opts: { session_key?: string | null; session_id?: string | null; limit?: number; include_shared?: boolean; actor?: CurrentUser | null } = {},
  ): AnyRecord[] {
    const actor = opts.actor === undefined ? currentUser() : opts.actor;
    const store = this.sessionStore(pid, actor);
    let key = opts.session_key ?? null;
    if (opts.session_id && !key) key = webSessionKey(pid, { session_id: opts.session_id });
    if (key) return store.messages(key, { limit: opts.limit ?? 100 });
    let messages = store.mergedMessages({ limit: opts.limit ?? 100 });
    if (opts.include_shared) {
      const shared = this.sessionStore(pid, null);
      if (shared !== store) {
        messages = [...messages, ...shared.mergedMessages({ limit: opts.limit ?? 100 })];
        messages.sort((a, b) => String(a["timestamp"] ?? "").localeCompare(String(b["timestamp"] ?? "")));
        messages = messages.slice(-(opts.limit ?? 100));
      }
    }
    return messages;
  }

  getRecentActivePartners(limit = 3): AnyRecord[] {
    const activity: Array<{ ts: string; row: AnyRecord }> = [];
    for (const pid of this.discoverPartnerIds()) {
      const sessions = this.sessionStore(pid, null).listSessions();
      if (!sessions.length) continue;
      const newest = sessions[0];
      const cfg = this.loadConfig(pid);
      const inst = _partners.get(pid);
      activity.push({
        ts: String(newest["updated_at"] ?? ""),
        row: {
          partner_id: pid,
          name: cfg?.name ?? pid,
          running: inst?.running ?? false,
          last_message: newest["last_message"] ?? "",
          updated_at: newest["updated_at"] ?? "",
        },
      });
    }
    activity.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return activity.slice(0, limit).map((a) => a.row);
  }

  // ── souls on disk helpers (read_soul/write_soul equivalents) ──
  readSoul(pid: string): string {
    const item = getItem(`partners_ext/soul-files/${pid}`, "soul");
    const content = String(item?.["content"] ?? "").trim();
    return content || DEFAULT_SOUL;
  }
  writeSoul(pid: string, content: string): void {
    putItem(`partners_ext/soul-files/${pid}`, { id: "soul", content });
  }

  // ── chat turn ──
  async sendMessage(
    pid: string,
    content: string,
    opts: {
      chat_id?: string;
      session_id?: string;
      session_key?: string | null;
      media?: string[];
      actor?: CurrentUser | null;
      on_event?: (frame: AnyRecord) => void | Promise<void>;
      signal?: AbortSignal;
      group?: AnyRecord | null;
      extra_context?: string;
      instruction?: string;
      persist?: boolean;
    } = {},
  ): Promise<{ content: string; events: AnyRecord[]; invocation: AnyRecord | null }> {
    const actor = opts.actor === undefined ? currentUser() : opts.actor;
    const inst = _partners.get(pid);
    if (!inst || !inst.running) throw new Error(`Partner '${pid}' is not running`);
    const cfg = inst.config;
    const key =
      opts.session_key?.trim() ||
      webSessionKey(pid, { chat_id: opts.chat_id ?? "web", session_id: opts.session_id });
    const store = this.sessionStore(pid, actor);

    // Slash commands on non-group turns.
    if (!opts.group && looksLikePartnerCommand(content)) {
      const ctx: CommandCtx = {
        partner_id: pid,
        config: cfg,
        store,
        save_config: (c) => this.saveConfig(pid, c as PartnerConfig),
        actor,
        session_key: key,
        channel: opts.group ? "web_group" : "web",
      };
      const result = dispatchPartnerCommand(content, ctx);
      if (result) {
        if (opts.persist !== false) {
          store.append(key, "user", content, { channel: "web", chat_id: opts.chat_id });
          store.append(key, "assistant", result.content, { channel: "web", chat_id: opts.chat_id });
        }
        return { content: result.content, events: [], invocation: null };
      }
    }

    const settings = getSettings();
    const soul = this.readSoul(pid);
    const history = store.conversationHistory(key);
    let system = soul;
    if (opts.group) {
      system +=
        `\n\nYou are speaking inside Partner Group "${opts.group["name"] ?? ""}". ` +
        `Members: ${(opts.group["members"] as AnyRecord[] | undefined ?? [])
          .map((m) => `${m["name"]} (@${m["partner_id"]})`)
          .join(", ")}.\n` +
        `Public context:\n${opts.extra_context ?? ""}\n` +
        (opts.instruction ? `\nInstruction for this turn:\n${opts.instruction}\n` : "") +
        `\nAnswer the user directly and concisely. If another member's input would ` +
        `materially help and this is allowed, end your reply with a single line ` +
        `@@INVOKE_OTHER {"target_partner_id":"<id>","question":"<question>"}. ` +
        `Never claim the peer has answered.`;
    }
    const prompt = history.length
      ? history.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.content}`).join("\n\n") +
        `\n\nUser: ${content}`
      : content;

    const events: AnyRecord[] = [];
    let finalText = "";
    if (opts.signal?.aborted) {
      const err = new Error("Partner turn stopped");
      err.name = "AbortError";
      throw err;
    }
    if (opts.on_event) {
      for await (const delta of streamText(settings, {
        system,
        prompt,
        llm_selection: (cfg.llm_selection as Record<string, unknown>) ?? null,
      })) {
        if (opts.signal?.aborted) {
          const err = new Error("Partner turn stopped");
          err.name = "AbortError";
          throw err;
        }
        finalText += delta;
        const frame = { type: "stream_event", event: { type: "content", content: delta } };
        events.push(frame);
        await opts.on_event(frame);
      }
    } else {
      finalText = await completeText(settings, {
        system,
        prompt,
        llm_selection: (cfg.llm_selection as Record<string, unknown>) ?? null,
      });
    }

    // Parse an invoke_other proposal out of the group reply.
    let invocation: AnyRecord | null = null;
    let visible = finalText;
    const m = /@@INVOKE_OTHER\s*(\{[\s\S]*?\})\s*$/.exec(finalText);
    if (m) {
      visible = finalText.slice(0, m.index).trim();
      try {
        const parsed = JSON.parse(m[1]) as AnyRecord;
        if (parsed["target_partner_id"] && parsed["question"]) invocation = parsed;
      } catch {
        /* malformed proposal — drop it */
      }
    }

    if (opts.persist !== false) {
      store.append(key, "user", content, {
        channel: opts.group ? "web_group" : "web",
        chat_id: opts.chat_id ?? opts.session_id,
        metadata: opts.group ? { partner_group: opts.group["name"] } : undefined,
      });
      store.append(key, "assistant", visible, {
        channel: opts.group ? "web_group" : "web",
        chat_id: opts.chat_id ?? opts.session_id,
        events,
      });
    }
    return { content: visible, events, invocation };
  }

  // Group-facing entry (manager.send_group_message).
  async sendGroupMessage(
    pid: string,
    content: string,
    opts: {
      session_key: string;
      group_id: string;
      group_name: string;
      group_members: AnyRecord[];
      public_context: string;
      actor?: CurrentUser | null;
      allow_invoke_other?: boolean;
      on_event?: (frame: AnyRecord) => void | Promise<void>;
      signal?: AbortSignal;
      extra_context?: string;
      instruction?: string;
    },
  ): Promise<{ content: string; events: AnyRecord[]; invocation: AnyRecord | null }> {
    const group = {
      name: opts.group_name,
      members: opts.group_members,
      allow_invoke_other: opts.allow_invoke_other !== false,
    };
    return this.sendMessage(pid, content, {
      session_key: opts.session_key,
      actor: opts.actor,
      group,
      extra_context: opts.public_context,
      instruction: opts.instruction,
      persist: false,
      signal: opts.signal,
      on_event: opts.on_event,
    });
  }

  // ── live web turns (refresh-survivable streaming) ─────────────
  // Port of upstream start_web_turn / subscribe_web_turn / stop_web_turn /
  // web_session_is_busy / web_session_idle_lock. Upstream guards the session
  // with a non-blocking file lock; this backend is single-process, so the
  // in-memory live_turns map is the equivalent exclusion.

  startWebTurn(
    pid: string,
    sessionKey: string,
    content: string,
    media: string[] = [],
    opts: { account_id?: string | null; actor?: CurrentUser | null } = {},
  ): LiveTurn {
    const inst = _partners.get(pid);
    if (!inst || !inst.running) throw new Error(`Partner '${pid}' is not running`);
    const existing = inst.live_turns.get(sessionKey);
    if (existing && !existing.done) {
      throw new PartnerTurnBusyError("This conversation is already replying. Please wait.");
    }
    const accountId = opts.account_id ?? null;
    if (accountId) {
      const state = getWebContinuity(pid, accountId);
      if (state["enabled"] && state["session_key"] !== validateSessionKey(sessionKey)) {
        throw new PartnerStaleSessionError(String(state["session_key"]));
      }
    }
    const turn = new LiveTurn();
    turn.userContent = content;
    inst.live_turns.set(sessionKey, turn);
    void this.driveWebTurn(pid, sessionKey, content, media, turn, opts.actor ?? null);
    return turn;
  }

  private async driveWebTurn(
    pid: string,
    sessionKey: string,
    content: string,
    media: string[],
    turn: LiveTurn,
    actor: CurrentUser | null,
  ): Promise<void> {
    try {
      const out = await this.sendMessage(pid, content, {
        session_key: sessionKey,
        media,
        actor,
        signal: turn.abort.signal,
        on_event: (frame) => {
          turn.emit(frame);
        },
      });
      turn.finish([{ type: "content", content: out.content }, { type: "done" }]);
    } catch (e) {
      if (turn.abort.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
        turn.finish([{ type: "stopped" }]);
      } else if (e instanceof Error) {
        turn.finish([{ type: "error", content: e.message || "Internal error" }, { type: "done" }]);
      } else {
        turn.finish([{ type: "error", content: `Internal error (${typeof e})` }, { type: "done" }]);
      }
    } finally {
      // A finished turn is read back from history, never re-attached.
      const inst = _partners.get(pid);
      if (inst && inst.live_turns.get(sessionKey) === turn) inst.live_turns.delete(sessionKey);
      turn.events = [];
    }
  }

  subscribeWebTurn(pid: string, sessionKey: string): LiveTurn | null {
    const inst = _partners.get(pid);
    if (!inst) return null;
    const turn = inst.live_turns.get(sessionKey);
    return turn && !turn.done ? turn : null;
  }

  stopWebTurn(pid: string, sessionKey: string): boolean {
    const inst = _partners.get(pid);
    if (!inst) return false;
    const turn = inst.live_turns.get(sessionKey);
    if (!turn || turn.done) return false;
    turn.abort.abort();
    return true;
  }

  webSessionIsBusy(pid: string, sessionKey: string): boolean {
    const inst = _partners.get(pid);
    if (!inst) return false;
    const turn = inst.live_turns.get(sessionKey);
    return Boolean(turn && !turn.done);
  }

  /** Non-blocking exclusion check mirroring upstream's per-session file lock. */
  webSessionIdleLock(pid: string, sessionKey: string): { release(): void } {
    if (this.webSessionIsBusy(pid, sessionKey)) {
      throw new PartnerTurnBusyError("This conversation is already replying. Please wait.");
    }
    return { release() { /* single-process: the live_turns check is the lock */ } };
  }
}

export const getPartnerManager = (() => {
  let mgr: PartnerManager | null = null;
  return () => (mgr ??= new PartnerManager());
})();

// Re-export helpers used by the router.
export { canManagePartner, canUsePartner, currentUser, identityCard, assignedPartnerIds };
export { RESERVED_NAMES };
