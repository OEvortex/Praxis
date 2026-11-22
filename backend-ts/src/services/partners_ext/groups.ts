// first-class Partner Groups:
// store (ext_items), discussion modes, mentions, invocations, whiteboard,
// and the orchestrated turn runner on top of PartnerManager.sendGroupMessage.
import { COL, deleteItem, getItem, listItems, putItem, uuid32, type AnyRecord } from "./store.js";
import { FrameQueue, getPartnerManager, slugifyPartnerId } from "./manager.js";
import { currentUser, canUsePartner, type CurrentUser } from "./multiuser.js";

export function utcNow(): string {
  return new Date().toISOString();
}

function normalizeSessionKey(key: string): string {
  return String(key || "default").slice(0, 120) || "default";
}

// ── models ─────────────────────────────────────────────────────
export interface PartnerGroupConfig {
  group_id: string;
  owner_id: string;
  name: string;
  description: string;
  member_ids: string[];
  discussion_mode: string;
  shared_memory: string;
  emoji: string;
  color: string;
  created_at: string;
  updated_at: string;
  version: number;
  id?: string;
}

export interface GroupMessage {
  event_id: string;
  turn_id: string;
  session_key: string;
  role: string;
  content: string;
  author_id: string;
  author_name: string;
  created_at: string;
  mentions: string[];
  error: boolean;
  kind: string;
  events: AnyRecord[];
  invocation_id: string;
  invocation: AnyRecord | null;
}

export interface PartnerInvocation {
  invocation_id: string;
  group_id: string;
  session_key: string;
  parent_turn_id: string;
  requester_partner_id: string;
  requester_partner_name: string;
  target_partner_id: string;
  target_partner_name: string;
  question: string;
  status: string;
  created_at: string;
  updated_at: string;
  question_event_id: string;
  reply_event_id: string;
  error: string;
  id?: string;
}

// ── discussion modes ───────────────────────────────────────────
export interface DiscussionContext {
  group: PartnerGroupConfig;
  targets: string[];
  respond: (partnerId: string, opts?: { extra_context?: string; instruction?: string; allow_invoke_other?: boolean }) => Promise<GroupMessage>;
  emit: (frame: AnyRecord) => Promise<void>;
}

interface DiscussionMode {
  name: string;
  label: string;
  description: string;
  run(ctx: DiscussionContext): Promise<GroupMessage[]>;
}

const noopEmit = async (_f: AnyRecord) => {};

function renderMessages(messages: GroupMessage[]): string {
  return messages.map((m) => `${m.author_name}: ${m.content}`).join("\n\n");
}

class PanelParallelMode implements DiscussionMode {
  name = "panel_parallel";
  label = "Parallel panel";
  description =
    "Selected Partners answer concurrently from shared public context; their private intermediate work is not shared.";
  async run(ctx: DiscussionContext): Promise<GroupMessage[]> {
    const one = async (pid: string) => {
      await ctx.emit({ type: "partner_started", partner_id: pid });
      const msg = await ctx.respond(pid);
      await ctx.emit({ type: "partner_message", message: msg });
      return msg;
    };
    return Promise.all(ctx.targets.map(one));
  }
}

class SequentialMode implements DiscussionMode {
  name = "sequential";
  label = "Sequential Build";
  description =
    "Selected Partners respond in Group member order, each building on messages already produced this round without repeating them.";
  instruction =
    "Supplement, correct, or advance the prior points, and do not repeat what has already been said. If you genuinely agree with no addition, briefly state which point you agree with and offer one new angle.";
  async run(ctx: DiscussionContext): Promise<GroupMessage[]> {
    const targetIds = new Set(ctx.targets);
    const ordered = ctx.group.member_ids.filter((id) => targetIds.has(id));
    const replies: GroupMessage[] = [];
    for (const pid of ordered) {
      await ctx.emit({ type: "partner_started", partner_id: pid });
      const msg = await ctx.respond(pid, {
        extra_context: renderMessages(replies),
        instruction: this.instruction,
      });
      await ctx.emit({ type: "partner_message", message: msg });
      replies.push(msg);
    }
    return replies;
  }
}

class DebateMode implements DiscussionMode {
  name = "debate";
  label = "Cross Debate";
  description =
    "Selected Partners debate in two parallel rounds: clear opening positions, then substantive clashes informed by every opening statement.";
  opening_instruction =
    "This is the debate's opening statement. State a clear position on the user's question and support it with your strongest reasons.";
  clash_instruction =
    "This is the debate's clash round. Identify substantive disagreements with other opening statements, state clearly what you disagree with and why, and explicitly concede and revise if another opening persuades you. Do not restate your own Round 1 content.";
  async run(ctx: DiscussionContext): Promise<GroupMessage[]> {
    const one = async (pid: string, instruction: string, extra = "", allowInvoke = true) => {
      await ctx.emit({ type: "partner_started", partner_id: pid });
      const msg = await ctx.respond(pid, { extra_context: extra, instruction, allow_invoke_other: allowInvoke });
      await ctx.emit({ type: "partner_message", message: msg });
      return msg;
    };
    const openings = await Promise.all(ctx.targets.map((pid) => one(pid, this.opening_instruction)));
    if (ctx.targets.length < 2) return openings;
    const openingContext = renderMessages(openings);
    const clashes = await Promise.all(
      ctx.targets.map((pid) => one(pid, this.clash_instruction, openingContext, false)),
    );
    for (const c of clashes) c.kind = "debate_rebuttal";
    return [...openings, ...clashes];
  }
}

const MODES = new Map<string, DiscussionMode>([
  ["panel_parallel", new PanelParallelMode()],
  ["sequential", new SequentialMode()],
  ["debate", new DebateMode()],
]);

export const discussionModeRegistry = {
  describe: () =>
    [...MODES.values()].map((m) => ({ name: m.name, label: m.label, description: m.description })),
  get: (name: string) => {
    const m = MODES.get(name);
    if (!m) throw new Error(`Unknown discussion mode: ${name}`);
    return m;
  },
};

export const sharedMemoryRegistry = {
  describe: () => [
    {
      name: "whiteboard",
      label: "Shared whiteboard",
      description: "Shared Group notes stored separately from the public transcript.",
    },
  ],
  validate: (name: string) => {
    if (name !== "whiteboard") throw new Error(`Unknown shared memory type: ${name}`);
  },
};

// ── whiteboard (ext_items) ─────────────────────────────────────
function whiteboardEntries(gid: string): AnyRecord[] {
  const item = getItem(COL.groupWhiteboard(gid), "board");
  const rows = Array.isArray(item?.["entries"]) ? (item["entries"] as AnyRecord[]) : [];
  const active = new Map<string, AnyRecord>();
  const order: string[] = [];
  for (const row of rows) {
    if (row["schema_version"] !== 2) continue;
    const eid = String(row["event_id"] || "");
    if (!eid) continue;
    if (row["kind"] === "unpin") {
      active.delete(eid);
      const i = order.indexOf(eid);
      if (i >= 0) order.splice(i, 1);
    } else if (row["kind"] === "pin" && row["content"]) {
      active.set(eid, row);
      const i = order.indexOf(eid);
      if (i >= 0) order.splice(i, 1);
      order.push(eid);
    }
  }
  return order.filter((k) => active.has(k)).map((k) => active.get(k)!);
}

function whiteboardAppend(gid: string, rows: AnyRecord[]): void {
  const item = getItem(COL.groupWhiteboard(gid), "board") ?? { id: "board", entries: [] };
  const entries = [...((item["entries"] as AnyRecord[]) ?? []), ...rows];
  putItem(COL.groupWhiteboard(gid), { ...item, entries });
}

function renderRecentLines(lines: string[], maxChars: number, separator: string): string {
  if (maxChars <= 0 || !lines.length) return "";
  const kept: string[] = [];
  let total = 0;
  for (const line of [...lines].reverse()) {
    const joinCost = kept.length ? separator.length : 0;
    const available = maxChars - total - joinCost;
    if (available <= 0) break;
    const fragment = line.slice(0, available);
    kept.push(fragment);
    total += joinCost + fragment.length;
    if (fragment.length < line.length) break;
  }
  return kept.reverse().join(separator);
}

// ── transcript / invocations stores ────────────────────────────
function transcriptCol(gid: string, stem: string): string {
  return COL.groupTranscripts(gid, stem);
}
function transcriptStem(sessionKey: string): string {
  return String(sessionKey || "default").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+|\.+$/g, "").slice(0, 120) || "default";
}

function transcriptAppend(gid: string, msg: GroupMessage): void {
  const stem = transcriptStem(msg.session_key);
  const item = getItem(transcriptCol(gid, stem), stem) ?? { id: stem, messages: [] };
  (item["messages"] as AnyRecord[]).push(msg);
  putItem(transcriptCol(gid, stem), item);
}

function transcriptRead(gid: string, stem: string): GroupMessage[] {
  const item = getItem(transcriptCol(gid, stem), stem);
  const rows = Array.isArray(item?.["messages"]) ? (item["messages"] as AnyRecord[]) : [];
  return rows as unknown as GroupMessage[];
}

function transcriptSessions(gid: string): AnyRecord[] {
  const prefix = `partners_ext/group-transcripts/${gid}/`;
  const out: AnyRecord[] = [];
  for (const item of listItems(prefix)) {
    const msgs = (item["messages"] as AnyRecord[]) ?? [];
    const firstUser = msgs.find((m) => m["role"] === "user");
    const title = firstUser ? String(firstUser["content"] || "").split(/\s+/).join(" ").slice(0, 40).trim() : "";
    const first = msgs[0] ?? {};
    const last = msgs[msgs.length - 1] ?? {};
    out.push({
      session_key: String(first["session_key"] || item["id"]),
      title,
      message_count: msgs.length,
      updated_at: last["created_at"] || item["updated_at"] || "",
      created_at: first["created_at"] || item["created_at"] || "",
    });
  }
  return out.sort((a, b) => String(b["updated_at"]).localeCompare(String(a["updated_at"])));
}

function invocationGet(gid: string, invId: string): PartnerInvocation | null {
  const normalized = String(invId || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
  const item = getItem(COL.groupInvocations(gid), normalized);
  return item ? ({ ...(item as PartnerInvocation), invocation_id: normalized } as PartnerInvocation) : null;
}
function invocationSave(gid: string, inv: PartnerInvocation): void {
  putItem(COL.groupInvocations(gid), { ...inv, id: inv.invocation_id });
}
function invocationList(gid: string, sessionKey?: string, limit = 200): PartnerInvocation[] {
  const rows = listItems(COL.groupInvocations(gid))
    .map((i) => i as unknown as PartnerInvocation)
    .filter((i) => !sessionKey || i.session_key === sessionKey)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return rows.slice(-Math.max(1, Math.min(limit, 500)));
}
function invocationDeleteSession(gid: string, sessionKey: string): number {
  let n = 0;
  for (const item of listItems(COL.groupInvocations(gid))) {
    if (item["session_key"] === sessionKey) {
      deleteItem(COL.groupInvocations(gid), String(item["id"]));
      n++;
    }
  }
  return n;
}
function invocationTransition(
  gid: string,
  invId: string,
  opts: { allowed: Set<string>; status: string; changes?: AnyRecord },
): PartnerInvocation {
  const inv = invocationGet(gid, invId);
  if (!inv) throw new LookupError("Partner invocation not found");
  if (!opts.allowed.has(inv.status)) {
    throw new Error(
      `Partner invocation is already ${inv.status}; expected ${[...opts.allowed].sort().join(" or ")}`,
    );
  }
  inv.status = opts.status;
  inv.updated_at = utcNow();
  for (const [k, v] of Object.entries(opts.changes ?? {})) {
    if (k in inv) (inv as AnyRecord)[k] = String(v ?? "");
  }
  invocationSave(gid, inv);
  return inv;
}
class LookupError extends Error {}

// ── live group turns ───────────────────────────────────────────
// Port of upstream ``LiveGroupTurn`` + the manager's ``_live_turns`` /
// ``_completed_turns`` maps (services/partner_groups/manager.py). A public
// Group turn survives its initiating WebSocket: frames fan out to
// per-subscriber queues with a bounded replay buffer.

const LIVE_REPLAY_MAX_FRAMES = 512;
const LIVE_REPLAY_MAX_TURNS = 64;

export type GroupEmit = (frame: AnyRecord) => void | Promise<void>;

export class LiveGroupTurn {
  content = "";
  mentions: string[] | null = null;
  operation = "message";
  invocation_id = "";
  turn_id = "";
  partner_id = "";
  frames: AnyRecord[] = [];
  subscribers = new Set<FrameQueue>();
  done = false;
  settled = false;
  task: Promise<void> | null = null;
  startedAt = Date.now();
  readonly abort = new AbortController();

  emit(frame: AnyRecord): void {
    this.record(frame);
  }

  private record(frame: AnyRecord): void {
    this.frames.push(frame);
    if (this.frames.length > LIVE_REPLAY_MAX_FRAMES) {
      this.frames.splice(0, this.frames.length - LIVE_REPLAY_MAX_FRAMES);
    }
    if (["done", "error", "cancelled"].includes(String(frame["type"]))) this.done = true;
    for (const queue of [...this.subscribers]) queue.push(frame);
  }

  subscribe(): FrameQueue {
    const queue = new FrameQueue();
    for (const frame of this.frames) queue.push(frame);
    if (!this.done) this.subscribers.add(queue);
    return queue;
  }

  unsubscribe(queue: FrameQueue): void {
    this.subscribers.delete(queue);
    queue.close();
  }
}

// ── manager ────────────────────────────────────────────────────
const MENTION_PATTERN = /(?<![\w@])@([^\s@,，:：;；!?！？。.]+)/g;
const ROUND_CONTEXT_HEADING = "Messages already produced this round:";
const ROUND_SUMMARY_INSTRUCTION =
  "Summarize only the completed round in the public context. Produce exactly three clearly labeled sections: Consensus, Disagreements, and Recommendation for the user. Use the user's language, distinguish genuine agreement from unresolved differences, and make the recommendation actionable.";

export class PartnerGroupManager {
  // Live turns keyed by `${userId}\u001f${gid}\u001f${sessionKey}\u001f${operationId}`
  // (upstream keys on the same tuple incl. the current user id).
  private readonly _liveTurns = new Map<string, LiveGroupTurn>();
  private readonly _completedTurns = new Map<string, LiveGroupTurn>();

  listGroups(user?: CurrentUser): AnyRecord[] {
    const actor = user ?? currentUser();
    return listItems(COL.groupConfigs)
      .map((i) => i as unknown as PartnerGroupConfig)
      .filter((g) => !actor || g.owner_id === actor.id || actor.is_admin)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((g) => this.describeGroup(g));
  }

  getGroup(gid: string): PartnerGroupConfig | null {
    const item = getItem(COL.groupConfigs, gid);
    return item ? ({ ...(item as PartnerGroupConfig), group_id: String(item["id"]) } as PartnerGroupConfig) : null;
  }

  private requireGroup(gid: string): PartnerGroupConfig {
    const g = this.getGroup(gid);
    if (!g) throw new LookupError("Partner Group not found");
    return g;
  }

  private validateMembers(memberIds: string[]): string[] {
    const mgr = getPartnerManager();
    const out: string[] = [];
    for (const raw of memberIds) {
      const pid = String(raw || "").trim();
      if (!pid) continue;
      if (mgr.loadConfig(pid) === null) throw new Error(`Unknown partner: ${pid}`);
      if (!out.includes(pid)) out.push(pid);
    }
    if (out.length < 2) throw new Error("A Partner Group needs at least two members.");
    return out;
  }

  createGroup(opts: {
    name: string; member_ids: string[]; description?: string; discussion_mode?: string;
    shared_memory?: string; emoji?: string; color?: string;
  }, user?: CurrentUser): PartnerGroupConfig {
    const actor = user ?? currentUser();
    const members = this.validateMembers(opts.member_ids ?? []);
    discussionModeRegistry.get(opts.discussion_mode ?? "panel_parallel");
    sharedMemoryRegistry.validate(opts.shared_memory ?? "whiteboard");
    const base = slugifyPartnerId(opts.name) || "group";
    let gid = base;
    while (this.getGroup(gid)) gid = `${base}-${uuid32().slice(0, 6)}`;
    const now = utcNow();
    const color = /^#[0-9a-fA-F]{6}$/.test(String(opts.color || "")) ? String(opts.color).toLowerCase() : "#6366f1";
    const group: PartnerGroupConfig = {
      group_id: gid,
      id: gid,
      owner_id: actor.id,
      name: String(opts.name || "").trim().slice(0, 80),
      description: String(opts.description || "").trim().slice(0, 500),
      member_ids: members,
      discussion_mode: opts.discussion_mode ?? "panel_parallel",
      shared_memory: opts.shared_memory ?? "whiteboard",
      emoji: String(opts.emoji || "👥").trim().slice(0, 16),
      color,
      created_at: now,
      updated_at: now,
      version: 1,
    };
    if (!group.name) throw new Error("A Partner Group needs a name.");
    putItem(COL.groupConfigs, group as unknown as AnyRecord);
    return group;
  }

  updateGroup(gid: string, changes: AnyRecord): PartnerGroupConfig {
    const group = this.requireGroup(gid);
    if ("name" in changes) {
      const name = String(changes["name"] || "").trim().slice(0, 80);
      if (!name) throw new Error("A Partner Group needs a name.");
      group.name = name;
    }
    if ("description" in changes) group.description = String(changes["description"] || "").trim().slice(0, 500);
    if ("member_ids" in changes) group.member_ids = this.validateMembers([...(changes["member_ids"] as string[] ?? [])]);
    if ("discussion_mode" in changes) {
      discussionModeRegistry.get(String(changes["discussion_mode"]));
      group.discussion_mode = String(changes["discussion_mode"]);
    }
    if ("shared_memory" in changes) {
      sharedMemoryRegistry.validate(String(changes["shared_memory"]));
      group.shared_memory = String(changes["shared_memory"]);
    }
    if ("emoji" in changes) group.emoji = String(changes["emoji"] || "👥").trim().slice(0, 16);
    if ("color" in changes) {
      const c = String(changes["color"] || "");
      group.color = /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : group.color;
    }
    group.updated_at = utcNow();
    putItem(COL.groupConfigs, group as unknown as AnyRecord);
    return group;
  }

  deleteGroup(gid: string): boolean {
    this.requireGroup(gid);
    return deleteItem(COL.groupConfigs, gid);
  }

  describeGroup(group: PartnerGroupConfig): AnyRecord {
    const mgr = getPartnerManager();
    const members: AnyRecord[] = [];
    for (const pid of group.member_ids) {
      const cfg = mgr.loadConfig(pid);
      const owner = mgr.ownerId(pid);
      if (cfg && canUsePartner(pid, owner, currentUser())) {
        members.push({ partner_id: pid, name: cfg.name, description: cfg.description, emoji: cfg.emoji, color: cfg.color, avatar: cfg.avatar });
      }
    }
    return { ...group, members };
  }

  // ── transcripts / sessions / whiteboard / invocations ─────────
  history(gid: string, sessionKey: string, limit = 200): AnyRecord[] {
    this.requireGroup(gid);
    const key = normalizeSessionKey(sessionKey);
    const msgs = transcriptRead(gid, transcriptStem(key)).slice(-Math.max(1, Math.min(limit, 500)));
    for (const m of msgs) {
      if (m.invocation_id) {
        const inv = invocationGet(gid, m.invocation_id);
        if (inv) m.invocation = inv as unknown as AnyRecord;
      }
    }
    return msgs.map((m) => m as unknown as AnyRecord);
  }

  invocations(gid: string, sessionKey: string, limit = 200): AnyRecord[] {
    this.requireGroup(gid);
    return invocationList(gid, normalizeSessionKey(sessionKey), limit).map((i) => i as unknown as AnyRecord);
  }

  createInvocation(
    gid: string,
    opts: { session_key: string; requester_partner_id: string; target_partner_id: string; question: string },
  ): PartnerInvocation {
    const group = this.requireGroup(gid);
    const members = this.memberSnapshot(group);
    const [reqId, reqName, tgtId, tgtName, question] = this.validateInvocationRequest(group, opts, members);
    return this.saveInvocation(group, normalizeSessionKey(opts.session_key), "", reqId, reqName, tgtId, tgtName, question);
  }

  whiteboard(gid: string, limit = 200): AnyRecord[] {
    this.requireGroup(gid);
    return whiteboardEntries(gid).slice(-Math.max(1, Math.min(limit, 500)));
  }

  pinWhiteboard(gid: string, eventId: string): AnyRecord {
    const group = this.requireGroup(gid);
    const stem = transcriptStem(eventId);
    let message: GroupMessage | null = null;
    for (const item of listItems(`partners_ext/group-transcripts/${gid}`)) {
      const msgs = (item["messages"] as AnyRecord[]) ?? [];
      const found = msgs.find((m) => m["event_id"] === eventId);
      if (found) {
        message = found as unknown as GroupMessage;
        break;
      }
    }
    if (!message) throw new LookupError("Partner Group transcript message not found");
    if (message.error || !String(message.content).trim()) {
      throw new Error("Only a completed public transcript message can be pinned.");
    }
    const entries = whiteboardEntries(gid);
    const existing = entries.find((e) => e["event_id"] === eventId);
    if (existing) return { entry: existing, created: false };
    const entry = {
      schema_version: 2,
      kind: "pin",
      event_id: message.event_id,
      turn_id: message.turn_id,
      session_key: message.session_key,
      author_id: message.author_id,
      author_name: message.author_name,
      content: message.content,
      created_at: message.created_at,
      pinned_at: utcNow(),
    };
    whiteboardAppend(gid, [entry]);
    return { entry, created: true };
  }

  unpinWhiteboard(gid: string, eventId: string): boolean {
    this.requireGroup(gid);
    const entries = whiteboardEntries(gid);
    if (!entries.some((e) => e["event_id"] === eventId)) return false;
    whiteboardAppend(gid, [
      { schema_version: 2, kind: "unpin", event_id: eventId, unpinned_at: utcNow() },
    ]);
    return true;
  }

  listSessions(gid: string): AnyRecord[] {
    this.requireGroup(gid);
    return transcriptSessions(gid);
  }

  createSession(gid: string): AnyRecord {
    const group = this.requireGroup(gid);
    const key = `pg-${uuid32()}`;
    const stem = transcriptStem(key);
    const now = utcNow();
    putItem(transcriptCol(group.group_id, stem), { id: stem, messages: [] });
    return { session_key: key, title: "", message_count: 0, updated_at: now, created_at: now };
  }

  deleteSession(gid: string, sessionKey: string, user?: CurrentUser): boolean {
    const group = this.requireGroup(gid);
    const key = normalizeSessionKey(sessionKey);
    const actorId = (user ?? currentUser()).id;
    const prefix = `${actorId}${group.group_id}${key}`;
    for (const liveKey of this._liveTurns.keys()) {
      if (liveKey.startsWith(prefix)) {
        throw new Error("A Partner Group turn is still running in this session.");
      }
    }
    const deleted = deleteItem(transcriptCol(group.group_id, transcriptStem(key)), transcriptStem(key));
    if (!deleted) return false;
    invocationDeleteSession(group.group_id, key);
    whiteboardAppend(group.group_id, [
      { schema_version: 2, kind: "unpin", event_id: "*", session_key: key, unpinned_at: utcNow() },
    ]);
    return true;
  }

  // ── turn execution ──
  resolveMentions(group: PartnerGroupConfig, content: string, mentions: string[] | null | undefined): { targets: string[]; unknown: string[] } {
    const aliases = new Map<string, string>();
    for (const pid of group.member_ids) {
      aliases.set(pid.toLowerCase(), pid);
      const cfg = getPartnerManager().loadConfig(pid);
      if (cfg?.name) aliases.set(String(cfg.name).toLowerCase(), pid);
    }
    let raw: string[];
    if (mentions !== null && mentions !== undefined) {
      raw = mentions.map((m) => String(m).replace(/^@/, "").trim()).filter(Boolean);
    } else {
      raw = [...content.matchAll(MENTION_PATTERN)].map((m) => m[1].trim());
    }
    if (!raw.length) return { targets: [...group.member_ids], unknown: [] };
    const allAliases = new Set(["all"]);
    const unknown = [...new Set(raw.filter((v) => !aliases.has(v.toLowerCase()) && !allAliases.has(v)))].map((v) => `@${v}`);
    let targets: string[];
    if (raw.some((v) => allAliases.has(v))) {
      targets = [...group.member_ids];
    } else {
      targets = [...new Set(raw.filter((v) => aliases.has(v.toLowerCase())).map((v) => aliases.get(v.toLowerCase())!))];
      if (!targets.length) targets = [...group.member_ids];
    }
    return { targets, unknown };
  }

  private memberSnapshot(group: PartnerGroupConfig): { members: AnyRecord[]; configs: Map<string, any>; aliases: Map<string, string> } {
    const mgr = getPartnerManager();
    const members: AnyRecord[] = [];
    const configs = new Map<string, any>();
    const aliases = new Map<string, string>();
    for (const pid of group.member_ids) {
      const cfg = mgr.loadConfig(pid);
      configs.set(pid, cfg);
      const name = cfg?.name ?? pid;
      members.push({ partner_id: pid, name, description: cfg?.description ?? "" });
      aliases.set(pid.toLowerCase(), pid);
      if (name) aliases.set(String(name).toLowerCase(), pid);
    }
    return { members, configs, aliases };
  }

  private validateInvocationRequest(
    group: PartnerGroupConfig,
    opts: { requester_partner_id: string; target_partner_id: string; question: string },
    members: { members: AnyRecord[] },
  ): [string, string, string, string, string] {
    const requester = String(opts.requester_partner_id || "").trim();
    const target = String(opts.target_partner_id || "").trim();
    const question = String(opts.question || "").trim();
    if (!group.member_ids.includes(requester)) throw new Error("Requester Partner is not a current Group member.");
    if (!group.member_ids.includes(target)) throw new Error("Target Partner is not a current Group member.");
    if (requester === target) throw new Error("Requester and target Partners must differ.");
    if (!question) throw new Error("Invocation question is required.");
    if (question.length > 2000) throw new Error("Invocation question must be at most 2000 characters.");
    const names = new Map(members.members.map((m) => [String(m["partner_id"]), String(m["name"])]));
    return [requester, names.get(requester) ?? requester, target, names.get(target) ?? target, question];
  }

  private saveInvocation(
    group: PartnerGroupConfig,
    sessionKey: string,
    parentTurnId: string,
    requesterId: string,
    requesterName: string,
    targetId: string,
    targetName: string,
    question: string,
  ): PartnerInvocation {
    const now = utcNow();
    const inv: PartnerInvocation = {
      invocation_id: uuid32(),
      group_id: group.group_id,
      session_key: sessionKey,
      parent_turn_id: parentTurnId,
      requester_partner_id: requesterId,
      requester_partner_name: requesterName,
      target_partner_id: targetId,
      target_partner_name: targetName,
      question,
      status: "pending",
      created_at: now,
      updated_at: now,
      question_event_id: "",
      reply_event_id: "",
      error: "",
    };
    invocationSave(group.group_id, inv);
    return inv;
  }

  private renderPublicContext(group: PartnerGroupConfig, members: AnyRecord[], previousTranscript: string, sharedMemory: string): string {
    const roster = members.map((m) => {
      let line = `- ${m["name"]} (@${m["partner_id"]})`;
      if (m["description"]) line += `: ${m["description"]}`;
      return line;
    });
    let ctx =
      `Group: ${group.name}\nParallel panel members and positioning:\n` +
      roster.join("\n") +
      "\n\nPublic transcript before the current message:\n" +
      (previousTranscript || "(empty)");
    if (sharedMemory) ctx += "\n\nUser-curated shared whiteboard:\n" + sharedMemory;
    return ctx;
  }

  private renderSharedMemory(group: PartnerGroupConfig): string {
    const entries = whiteboardEntries(group.group_id).slice(-80);
    const lines = entries.map((e) => `${e["author_name"] || "User"}: ${e["content"] || ""}`);
    return renderRecentLines(lines, 16000, "\n");
  }

  private renderTranscript(gid: string, sessionKey: string, opts: { beforeTurnId?: string; maxMessages?: number; maxChars?: number } = {}): string {
    const maxMessages = opts.maxMessages ?? 40;
    const maxChars = opts.maxChars ?? 16000;
    let rows = transcriptRead(gid, transcriptStem(sessionKey));
    if (opts.beforeTurnId) {
      const idx = rows.findIndex((r) => r.turn_id === opts.beforeTurnId);
      if (idx >= 0) rows = rows.slice(0, idx);
    }
    rows = rows.filter((r) => !r.error).slice(-maxMessages);
    const rendered = rows.map((r) => `${r.author_name}: ${r.content}`);
    return renderRecentLines(rendered, maxChars, "\n\n");
  }

  async sendMessage(
    gid: string,
    opts: { content: string; session_key: string; mentions?: string[] | null; turn_id?: string; emit?: GroupEmit; signal?: AbortSignal; user?: CurrentUser },
  ): Promise<AnyRecord> {
    const group = this.requireGroup(gid);
    const content = String(opts.content || "").trim();
    if (!content) throw new Error("Group message cannot be empty.");
    const actor = opts.user ?? currentUser();
    const sessionKey = normalizeSessionKey(opts.session_key);
    const turnId = opts.turn_id || uuid32();
    const emit = opts.emit ?? noopEmit;
    const memberSnapshot = this.memberSnapshot(group);
    const mentionResolution = this.resolveMentions(group, content, opts.mentions);
    const targets = mentionResolution.targets;
    const now = utcNow();
    const userMessage: GroupMessage = {
      event_id: uuid32(), turn_id: turnId, session_key: sessionKey, role: "user",
      content, author_id: actor.id, author_name: actor.username || "User",
      mentions: targets, created_at: now, error: false, kind: "message", events: [],
      invocation_id: "", invocation: null,
    };
    const previousTranscript = this.renderTranscript(group.group_id, sessionKey);
    transcriptAppend(group.group_id, userMessage);
    await emit({ type: "user_message", message: userMessage });

    const publicContext = this.renderPublicContext(
      group, memberSnapshot.members, previousTranscript, this.renderSharedMemory(group),
    );
    const pending = new Map<string, GroupMessage>();
    const mgr = getPartnerManager();

    const respond = async (pid: string, ropts: { extra_context?: string; instruction?: string; allow_invoke_other?: boolean } = {}): Promise<GroupMessage> => {
      const cfg = memberSnapshot.configs.get(pid);
      const name = cfg?.name ?? pid;
      try {
        if (!cfg || !canUsePartner(pid, mgr.ownerId(pid), actor)) throw new Error("Partner is unavailable");
        const inst = mgr.getPartner(pid);
        if (!inst?.running) await mgr.startPartner(pid, cfg);
        const turnPublic = ropts.extra_context
          ? `${publicContext}\n\n${ROUND_CONTEXT_HEADING}\n${ropts.extra_context}`
          : publicContext;
        let turnContent = content;
        if (ropts.instruction) {
          turnContent += `\n\n<upcoming_partner_turn_requirement partner_id="${pid}">\nThis requirement applies only to @${pid}'s upcoming turn:\n${ropts.instruction}\n</upcoming_partner_turn_requirement>`;
        }
        const result = await mgr.sendGroupMessage(pid, turnContent, {
          session_key: `group-${group.group_id}-${sessionKey}`,
          group_id: group.group_id,
          group_name: group.name,
          group_members: memberSnapshot.members,
          public_context: turnPublic,
          actor,
          allow_invoke_other: ropts.allow_invoke_other !== false,
          signal: opts.signal,
          on_event: async (frame) => {
            if (frame["type"] === "stream_event") {
              await emit({
                type: "partner_trace", turn_id: turnId, partner_id: pid,
                partner_name: name, event: frame["event"],
              });
            }
          },
        });
        // Record a pending invocation proposal, if any.
        let invocation: PartnerInvocation | null = null;
        if (result.invocation && ropts.allow_invoke_other !== false) {
          try {
            const [reqId, reqName, tgtId, tgtName, question] = this.validateInvocationRequest(
              group,
              {
                requester_partner_id: pid,
                target_partner_id: String(result.invocation["target_partner_id"]),
                question: String(result.invocation["question"]),
              },
              memberSnapshot,
            );
            invocation = this.saveInvocation(group, sessionKey, turnId, reqId, reqName, tgtId, tgtName, question);
          } catch { /* invalid proposal dropped */ }
        }
        const msg: GroupMessage = {
          event_id: uuid32(), turn_id: turnId, session_key: sessionKey, role: "partner",
          content: result.content, author_id: pid, author_name: name,
          created_at: utcNow(), mentions: [], error: false, kind: "message",
          events: result.events, invocation_id: invocation?.invocation_id ?? "",
          invocation: invocation ? (invocation as unknown as AnyRecord) : null,
        };
        pending.set(msg.event_id, msg);
        return msg;
      } catch (e) {
        // Cancellation propagates so the live-turn driver can emit `cancelled`
        // (upstream re-raises CancelledError instead of folding to an error msg).
        if (opts.signal?.aborted) throw e;
        const msg: GroupMessage = {
          event_id: uuid32(), turn_id: turnId, session_key: sessionKey, role: "partner",
          content: String(e instanceof Error ? e.message : e).slice(0, 500) || "Partner failed to answer.",
          author_id: pid, author_name: name, created_at: utcNow(), mentions: [],
          error: true, kind: "message", events: [], invocation_id: "", invocation: null,
        };
        pending.set(msg.event_id, msg);
        return msg;
      }
    };

    const modeEmit = async (frame: AnyRecord) => {
      if (frame["type"] === "partner_message") {
        const payload = frame["message"] as GroupMessage | undefined;
        const msg = payload ? pending.get(payload.event_id) : undefined;
        if (msg) transcriptAppend(group.group_id, msg);
      }
      await emit(frame);
    };

    const mode = discussionModeRegistry.get(group.discussion_mode);
    const replies = await mode.run({ group, targets, respond, emit: modeEmit });
    for (const r of replies) if (!pending.has(r.event_id)) transcriptAppend(group.group_id, r);
    group.updated_at = utcNow();
    putItem(COL.groupConfigs, group as unknown as AnyRecord);
    const result = { turn_id: turnId, targets, user_message: userMessage, replies, unknown_mentions: mentionResolution.unknown };
    await emit({ type: "done", result });
    return result;
  }

  async summarizeRound(
    gid: string,
    turnId: string,
    opts: { session_key: string; partner_id: string; emit?: GroupEmit; signal?: AbortSignal; user?: CurrentUser },
  ): Promise<GroupMessage> {
    const group = this.requireGroup(gid);
    const sessionKey = normalizeSessionKey(opts.session_key);
    const partnerId = String(opts.partner_id || "").trim();
    const emit = opts.emit ?? noopEmit;
    const roundMessages = transcriptRead(gid, transcriptStem(sessionKey)).filter((m) => m.turn_id === turnId);
    if (!roundMessages.some((m) => m.role === "user")) throw new LookupError("Partner Group round not found");
    if (!group.member_ids.includes(partnerId)) throw new Error("Summary Partner is not a current Group member.");
    const memberSnapshot = this.memberSnapshot(group);
    const publicContext = this.renderPublicContext(
      group, memberSnapshot.members,
      this.renderTranscript(gid, sessionKey, { beforeTurnId: turnId }),
      this.renderSharedMemory(group),
    );
    const extra = roundMessages.map((m) => `${m.author_name}: ${m.content}`).join("\n\n");
    const cfg = memberSnapshot.configs.get(partnerId);
    const name = cfg?.name ?? partnerId;
    const mgr = getPartnerManager();
    if (!cfg || !canUsePartner(partnerId, mgr.ownerId(partnerId), currentUser())) {
      throw new Error("Partner is unavailable");
    }
    const inst = mgr.getPartner(partnerId);
    if (!inst?.running) await mgr.startPartner(partnerId, cfg);
    await emit({ type: "partner_started", turn_id: turnId, partner_id: partnerId });
    const result = await mgr.sendGroupMessage(partnerId, "Summarize this completed Partner Group round.", {
      session_key: `group-${group.group_id}-${sessionKey}`,
      group_id: group.group_id,
      group_name: group.name,
      group_members: memberSnapshot.members,
      public_context: `${publicContext}\n\n${ROUND_CONTEXT_HEADING}\n${extra}`,
      actor: opts.user ?? currentUser(),
      allow_invoke_other: false,
      instruction: ROUND_SUMMARY_INSTRUCTION,
      signal: opts.signal,
      on_event: async (frame) => {
        if (frame["type"] === "stream_event") {
          await emit({
            type: "partner_trace", turn_id: turnId, partner_id: partnerId,
            partner_name: name, event: frame["event"],
          });
        }
      },
    });
    const msg: GroupMessage = {
      event_id: uuid32(), turn_id: turnId, session_key: sessionKey, role: "partner",
      content: result.content, author_id: partnerId, author_name: name,
      created_at: utcNow(), mentions: [], error: false, kind: "round_summary",
      events: result.events, invocation_id: "", invocation: null,
    };
    transcriptAppend(gid, msg);
    await emit({ type: "partner_message", message: msg as unknown as AnyRecord });
    await emit({
      type: "done",
      result: {
        operation: "summarize_round",
        turn_id: turnId,
        partner_id: partnerId,
        message: msg as unknown as AnyRecord,
      },
    });
    return msg;
  }

  async retryPartner(
    gid: string,
    turnId: string,
    partnerId: string,
    opts: { session_key: string; emit?: GroupEmit; signal?: AbortSignal; user?: CurrentUser },
  ): Promise<GroupMessage> {
    const group = this.requireGroup(gid);
    const sessionKey = normalizeSessionKey(opts.session_key);
    const emit = opts.emit ?? noopEmit;
    const msgs = transcriptRead(gid, transcriptStem(sessionKey)).filter((m) => m.turn_id === turnId);
    const userMsg = msgs.find((m) => m.role === "user");
    const failed = [...msgs].reverse().find((m) => m.role === "partner" && m.author_id === partnerId);
    if (!userMsg || !failed) throw new LookupError("Partner Group turn or seat not found");
    if (!failed.error) throw new Error("Only a failed Partner seat can be retried.");
    const memberSnapshot = this.memberSnapshot(group);
    const publicContext = this.renderPublicContext(
      group, memberSnapshot.members,
      this.renderTranscript(gid, sessionKey, { beforeTurnId: turnId }),
      this.renderSharedMemory(group),
    );
    const cfg = memberSnapshot.configs.get(partnerId);
    const name = cfg?.name ?? partnerId;
    const mgr = getPartnerManager();
    if (!cfg || !canUsePartner(partnerId, mgr.ownerId(partnerId), currentUser())) {
      throw new Error("Partner is unavailable");
    }
    const inst = mgr.getPartner(partnerId);
    if (!inst?.running) await mgr.startPartner(partnerId, cfg);
    await emit({ type: "partner_started", turn_id: turnId, partner_id: partnerId, retry: true });
    const result = await mgr.sendGroupMessage(partnerId, userMsg.content, {
      session_key: `group-${group.group_id}-${sessionKey}`,
      group_id: group.group_id,
      group_name: group.name,
      group_members: memberSnapshot.members,
      public_context: publicContext,
      actor: opts.user ?? currentUser(),
      allow_invoke_other: false,
      signal: opts.signal,
      on_event: async (frame) => {
        if (frame["type"] === "stream_event") {
          await emit({
            type: "partner_trace", turn_id: turnId, partner_id: partnerId,
            partner_name: name, retry: true, event: frame["event"],
          });
        }
      },
    });
    const replacement: GroupMessage = {
      ...failed,
      content: result.content,
      error: false,
      kind: failed.kind,
      events: result.events,
    };
    // Replace in place: rewrite the session item.
    const stem = transcriptStem(sessionKey);
    const col = transcriptCol(gid, stem);
    const item = getItem(col, stem);
    if (item) {
      const rows = (item["messages"] as AnyRecord[]) ?? [];
      const idx = rows.findIndex((r) => r["event_id"] === failed.event_id);
      if (idx >= 0) {
        rows[idx] = replacement as unknown as AnyRecord;
        putItem(col, item);
      }
    }
    await emit({ type: "partner_message", message: replacement as unknown as AnyRecord, retry: true });
    await emit({
      type: "done",
      result: {
        operation: "retry_partner",
        turn_id: turnId,
        partner_id: partnerId,
        message: replacement as unknown as AnyRecord,
      },
    });
    return replacement;
  }

  createInvocationForUser(gid: string, opts: { session_key: string; requester_partner_id: string; target_partner_id: string; question: string }): PartnerInvocation {
    return this.createInvocation(gid, opts);
  }

  async approveInvocation(
    gid: string,
    invocationId: string,
    opts: { session_key: string; emit?: GroupEmit; signal?: AbortSignal; user?: CurrentUser },
  ): Promise<GroupMessage> {
    const group = this.requireGroup(gid);
    const sessionKey = normalizeSessionKey(opts.session_key);
    const emit = opts.emit ?? noopEmit;
    const actor = opts.user ?? currentUser();
    const inv = this.requireInvocation(group, invocationId, sessionKey);
    const now = utcNow();
    const approved = invocationTransition(gid, inv.invocation_id, {
      allowed: new Set(["pending", "approved"]), status: "approved", changes: { updated_at: now },
    });
    await emit({ type: "invocation_updated", invocation: approved as unknown as AnyRecord });
    const transcriptMsgs = transcriptRead(gid, transcriptStem(sessionKey));
    let questionMsg = transcriptMsgs.find((m) => m.event_id === approved.question_event_id);
    const followupTurnId = uuid32();
    if (!questionMsg) {
      questionMsg = {
        event_id: uuid32(), turn_id: followupTurnId, session_key: sessionKey, role: "partner",
        content: approved.question, author_id: approved.requester_partner_id,
        author_name: approved.requester_partner_name, created_at: utcNow(),
        mentions: [approved.target_partner_id], kind: "invocation_question",
        error: false,
        events: [], invocation_id: approved.invocation_id,
        invocation: approved as unknown as AnyRecord,
      };
      transcriptAppend(gid, questionMsg);
    }
    await emit({ type: "partner_message", message: questionMsg as unknown as AnyRecord });
    const memberSnapshot = this.memberSnapshot(group);
    const previousTranscript = this.renderTranscript(gid, sessionKey);
    const publicContext = this.renderPublicContext(group, memberSnapshot.members, previousTranscript, this.renderSharedMemory(group));
    const targetId = approved.target_partner_id;
    const cfg = memberSnapshot.configs.get(targetId);
    const targetName = cfg?.name ?? approved.target_partner_name ?? targetId;
    const mgr = getPartnerManager();
    await emit({ type: "partner_started", partner_id: targetId, invocation_id: approved.invocation_id });
    let reply: GroupMessage;
    let status = "completed";
    let error = "";
    try {
      if (!cfg || !canUsePartner(targetId, mgr.ownerId(targetId), actor)) throw new Error("Partner is unavailable");
      const inst = mgr.getPartner(targetId);
      if (!inst?.running) await mgr.startPartner(targetId, cfg);
      const turn = await mgr.sendGroupMessage(targetId,
        `${approved.requester_partner_name} asks you directly in the Group: ${approved.question}`,
        {
          session_key: `group-${group.group_id}-${sessionKey}`,
          group_id: group.group_id,
          group_name: group.name,
          group_members: memberSnapshot.members,
          public_context: publicContext,
          actor,
          allow_invoke_other: true,
          signal: opts.signal,
          on_event: async (frame) => {
            if (frame["type"] === "stream_event") {
              await emit({
                type: "partner_trace", turn_id: followupTurnId, partner_id: targetId,
                partner_name: targetName, invocation_id: approved.invocation_id,
                event: frame["event"],
              });
            }
          },
        });
      let nextInv: PartnerInvocation | null = null;
      if (turn.invocation) {
        try {
          const [rId, rName, tId, tName, q] = this.validateInvocationRequest(group, {
            requester_partner_id: targetId,
            target_partner_id: String(turn.invocation["target_partner_id"]),
            question: String(turn.invocation["question"]),
          }, memberSnapshot);
          nextInv = this.saveInvocation(group, sessionKey, followupTurnId, rId, rName, tId, tName, q);
        } catch { /* drop */ }
      }
      reply = {
        event_id: uuid32(), turn_id: followupTurnId, session_key: sessionKey, role: "partner",
        content: turn.content, author_id: targetId, author_name: targetName,
        created_at: utcNow(), mentions: [], error: false, kind: "invocation_reply",
        events: turn.events, invocation_id: nextInv?.invocation_id ?? approved.invocation_id,
        invocation: nextInv ? (nextInv as unknown as AnyRecord) : null,
      };
    } catch (e) {
      if (opts.signal?.aborted || (e instanceof Error && e.name === "AbortError")) {
        const cancelled = invocationTransition(gid, approved.invocation_id, {
          allowed: new Set(["approved"]), status: "cancelled",
          changes: { updated_at: utcNow(), error: "Cancelled by user." },
        });
        await emit({ type: "invocation_updated", invocation: cancelled as unknown as AnyRecord });
        throw e;
      }
      status = "failed";
      error = String(e instanceof Error ? e.message : e).slice(0, 500) || "Partner failed to answer.";
      reply = {
        event_id: uuid32(), turn_id: followupTurnId, session_key: sessionKey, role: "partner",
        content: error, author_id: targetId, author_name: targetName,
        created_at: utcNow(), mentions: [], error: true, kind: "invocation_reply",
        events: [], invocation_id: approved.invocation_id, invocation: null,
      };
    }
    transcriptAppend(gid, reply);
    await emit({ type: "partner_message", message: reply as unknown as AnyRecord });
    const finalInv = invocationTransition(gid, approved.invocation_id, {
      allowed: new Set(["approved"]), status,
      changes: { updated_at: utcNow(), reply_event_id: reply.event_id, error },
    });
    await emit({ type: "invocation_updated", invocation: finalInv as unknown as AnyRecord });
    await emit({
      type: "done",
      result: {
        operation: "invoke_other",
        invocation: finalInv as unknown as AnyRecord,
        reply: reply as unknown as AnyRecord,
      },
    });
    return reply;
  }

  rejectInvocation(gid: string, invocationId: string, opts: { session_key: string }): PartnerInvocation {
    const group = this.requireGroup(gid);
    this.requireInvocation(group, invocationId, normalizeSessionKey(opts.session_key));
    return invocationTransition(gid, invocationId, {
      allowed: new Set(["pending"]), status: "rejected", changes: { updated_at: utcNow() },
    });
  }

  private requireInvocation(group: PartnerGroupConfig, invocationId: string, sessionKey: string): PartnerInvocation {
    const inv = invocationGet(group.group_id, invocationId);
    if (!inv || inv.group_id !== group.group_id || inv.session_key !== sessionKey) {
      throw new LookupError("Partner invocation not found");
    }
    return inv;
  }

  // ── live turns (WS transport) ─────────────────────────────────
  // Ports of upstream start_live_turn / start_live_invocation /
  // start_live_retry / start_live_summary / subscribe_live_turns /
  // cancel_live_turn plus the consultation activity hooks (no-ops: the
  // ConsultationWindow idle-tracking feature is not ported).

  private liveKey(userId: string, gid: string, sessionKey: string, operationId: string): string {
    return [userId, gid, normalizeSessionKey(sessionKey), operationId].join("");
  }

  private liveKeyPrefix(userId: string, gid: string, sessionKey: string): string {
    return [userId, gid, normalizeSessionKey(sessionKey), ""].join("");
  }

  private trackLiveTurn(key: string, live: LiveGroupTurn): void {
    this._completedTurns.delete(key);
    this._liveTurns.set(key, live);
    const task = live.task;
    if (!task) return;
    const archive = () => {
      live.settled = true;
      if (this._liveTurns.get(key) !== live) return;
      // Cancellation can win before the coroutine emits its terminal frame;
      // record one synchronously so subscribers never hang.
      if (live.abort.signal.aborted && !live.done) {
        live.emit(this.cancelledFrame(live));
      }
      this._liveTurns.delete(key);
      this._completedTurns.delete(key);
      this._completedTurns.set(key, live);
      while (this._completedTurns.size > LIVE_REPLAY_MAX_TURNS) {
        const oldest = this._completedTurns.keys().next().value;
        if (oldest === undefined) break;
        this._completedTurns.delete(oldest);
      }
    };
    void task.then(archive, archive);
  }

  private cancelledFrame(live: LiveGroupTurn): AnyRecord {
    const base: AnyRecord = { type: "cancelled", operation: live.operation };
    if (live.operation === "message") {
      return { ...base, content: "Partner Group turn cancelled." };
    }
    if (live.operation === "invocation") {
      return { ...base, operation: "invoke_other", invocation_id: live.invocation_id, content: "Partner invocation cancelled." };
    }
    if (live.operation === "retry_partner") {
      return { ...base, turn_id: live.turn_id, partner_id: live.partner_id, content: "Partner retry cancelled." };
    }
    return { ...base, turn_id: live.turn_id, partner_id: live.partner_id, content: "Partner Group round summary cancelled." };
  }

  private runLive(key: string, live: LiveGroupTurn, run: () => Promise<unknown>): LiveGroupTurn {
    live.task = (async () => {
      try {
        await run();
      } catch (e) {
        if (live.abort.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
          live.emit(this.cancelledFrame(live));
        } else {
          live.emit({ type: "error", content: String(e instanceof Error ? e.message : e).slice(0, 500) });
        }
      }
    })();
    this.trackLiveTurn(key, live);
    return live;
  }

  consultationActivity(
    _gid: string,
    _sessionKey: string,
    _client: string,
    _opts: { has_draft?: boolean; active?: boolean } = {},
  ): void {
    // Upstream forwards to a ConsultationWindow when one exists; none is
    // ported, so this is intentionally a no-op.
  }

  disconnectConsultation(_gid: string, _sessionKey: string, _client: string): void {
    // See consultationActivity.
  }

  startLiveTurn(
    gid: string,
    opts: { content: string; session_key: string; mentions?: string[] | null; user?: CurrentUser },
  ): LiveGroupTurn {
    const group = this.requireGroup(gid);
    const sessionKey = normalizeSessionKey(opts.session_key);
    const content = String(opts.content || "").trim();
    const mentions = opts.mentions !== null && opts.mentions !== undefined
      ? opts.mentions.map((m) => String(m).trim())
      : null;
    const user = opts.user ?? currentUser();
    const key = this.liveKey(user.id, group.group_id, sessionKey, "message");
    const previous = this._liveTurns.get(key);
    if (previous) {
      const same = previous.content === content &&
        JSON.stringify(previous.mentions ?? null) === JSON.stringify(mentions);
      if (!same) {
        throw new Error("A Partner Group turn is already in progress for this session.");
      }
      return previous;
    }
    const live = new LiveGroupTurn();
    live.content = content;
    live.mentions = mentions;
    live.operation = "message";
    live.turn_id = uuid32();
    return this.runLive(key, live, () =>
      this.sendMessage(group.group_id, {
        content,
        session_key: sessionKey,
        mentions,
        turn_id: live.turn_id,
        emit: (f) => live.emit(f),
        signal: live.abort.signal,
        user,
      }).then(() => undefined),
    );
  }

  startLiveInvocation(
    gid: string,
    opts: { invocation_id: string; session_key: string; user?: CurrentUser },
  ): LiveGroupTurn {
    const group = this.requireGroup(gid);
    const sessionKey = normalizeSessionKey(opts.session_key);
    const user = opts.user ?? currentUser();
    const proposal = this.requireInvocation(group, String(opts.invocation_id || ""), sessionKey);
    const key = this.liveKey(user.id, group.group_id, sessionKey, `invocation:${proposal.invocation_id}`);
    const previous = this._liveTurns.get(key);
    if (previous) return previous;
    if (!["pending", "approved"].includes(proposal.status)) {
      throw new Error(`Partner invocation is already ${proposal.status}.`);
    }
    const live = new LiveGroupTurn();
    live.content = proposal.question;
    live.operation = "invocation";
    live.invocation_id = proposal.invocation_id;
    return this.runLive(key, live, () =>
      this.approveInvocation(group.group_id, proposal.invocation_id, {
        session_key: sessionKey,
        emit: (f) => live.emit(f),
        signal: live.abort.signal,
        user,
      }).then(() => undefined),
    );
  }

  startLiveRetry(
    gid: string,
    opts: { turn_id: string; partner_id: string; session_key: string; user?: CurrentUser },
  ): LiveGroupTurn {
    const group = this.requireGroup(gid);
    const sessionKey = normalizeSessionKey(opts.session_key);
    const turnId = String(opts.turn_id || "").trim();
    const partnerId = String(opts.partner_id || "").trim();
    const user = opts.user ?? currentUser();
    const msgs = transcriptRead(group.group_id, transcriptStem(sessionKey)).filter((m) => m.turn_id === turnId);
    const userMsg = msgs.find((m) => m.role === "user");
    const failed = [...msgs].reverse().find((m) => m.role === "partner" && m.author_id === partnerId);
    if (!userMsg || !failed) throw new LookupError("Partner Group turn or seat not found");
    if (!failed.error) throw new Error("Only a failed Partner seat can be retried.");
    const operationId = `retry:${turnId}:${partnerId}`;
    const key = this.liveKey(user.id, group.group_id, sessionKey, operationId);
    const previous = this._liveTurns.get(key);
    if (previous) return previous;
    const live = new LiveGroupTurn();
    live.operation = "retry_partner";
    live.turn_id = turnId;
    live.partner_id = partnerId;
    return this.runLive(key, live, () =>
      this.retryPartner(group.group_id, turnId, partnerId, {
        session_key: sessionKey,
        emit: (f) => live.emit(f),
        signal: live.abort.signal,
        user,
      }).then(() => undefined),
    );
  }

  startLiveSummary(
    gid: string,
    opts: { turn_id: string; partner_id: string; session_key: string; user?: CurrentUser },
  ): LiveGroupTurn {
    const group = this.requireGroup(gid);
    const sessionKey = normalizeSessionKey(opts.session_key);
    const turnId = String(opts.turn_id || "").trim();
    const partnerId = String(opts.partner_id || "").trim();
    const user = opts.user ?? currentUser();
    const roundMessages = transcriptRead(group.group_id, transcriptStem(sessionKey)).filter((m) => m.turn_id === turnId);
    if (!roundMessages.some((m) => m.role === "user")) throw new LookupError("Partner Group round not found");
    if (!group.member_ids.includes(partnerId)) throw new Error("Summary Partner is not a current Group member.");
    const operationId = `summary:${turnId}:${partnerId}`;
    const key = this.liveKey(user.id, group.group_id, sessionKey, operationId);
    const previous = this._liveTurns.get(key);
    if (previous) return previous;
    const live = new LiveGroupTurn();
    live.operation = "summarize_round";
    live.turn_id = turnId;
    live.partner_id = partnerId;
    return this.runLive(key, live, () =>
      this.summarizeRound(group.group_id, turnId, {
        session_key: sessionKey,
        partner_id: partnerId,
        emit: (f) => live.emit(f),
        signal: live.abort.signal,
        user,
      }).then(() => undefined),
    );
  }

  subscribeLiveTurns(gid: string, sessionKey: string, user?: CurrentUser): LiveGroupTurn[] {
    const group = this.requireGroup(gid);
    const userId = (user ?? currentUser()).id;
    const key = normalizeSessionKey(sessionKey);
    const prefix = this.liveKeyPrefix(userId, group.group_id, key);
    const active = [...this._liveTurns.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, live]) => live)
      .sort((a, b) => a.startedAt - b.startedAt);
    if (active.length) return active;
    const completed = [...this._completedTurns.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, live]) => live);
    return completed.length ? [completed[completed.length - 1]] : [];
  }

  cancelLiveTurn(
    gid: string,
    sessionKey: string,
    opts: { invocation_id?: string; user?: CurrentUser } = {},
  ): LiveGroupTurn {
    const group = this.requireGroup(gid);
    const key = normalizeSessionKey(sessionKey);
    const userId = (opts.user ?? currentUser()).id;
    const invocationId = String(opts.invocation_id || "");
    const prefix = this.liveKeyPrefix(userId, group.group_id, key);
    const candidates = [...this._liveTurns.entries()]
      .filter(([k, live]) =>
        k.startsWith(prefix) &&
        (!invocationId || live.invocation_id === invocationId) &&
        !live.settled &&
        live.task !== null,
      )
      .map(([, live]) => live);
    if (!candidates.length) throw new LookupError("No Partner Group turn is currently running.");
    const live = candidates.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    live.abort.abort();
    if (live.operation === "message") {
      const marker: GroupMessage = {
        event_id: uuid32(),
        turn_id: live.turn_id,
        session_key: key,
        role: "system",
        content: "",
        author_id: "system",
        author_name: "System",
        created_at: utcNow(),
        mentions: [],
        error: false,
        kind: "round_stopped",
        events: [],
        invocation_id: "",
        invocation: null,
      };
      transcriptAppend(group.group_id, marker);
      group.updated_at = marker.created_at;
      putItem(COL.groupConfigs, group as unknown as AnyRecord);
    }
    return live;
  }
}

export const getPartnerGroupManager = (() => {
  let mgr: PartnerGroupManager | null = null;
  return () => (mgr ??= new PartnerGroupManager());
})();
