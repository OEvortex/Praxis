// _partners_channel_schema to a Hono router. Mount as `app.route("/api", partnersFullRouter)`
// or merge into handlers; paths mirror upstream exactly.
//
// Already covered by api/handlers.ts (do NOT duplicate there):
//   GET/POST /api/partners, GET/DELETE /api/partners/{pid},
//   POST /api/partners/consultation-session (stub — upstream is GET with
//   ?chat_session_id&partner_name; this router implements the real GET),
//   POST/GET /api/partners/drafts/{id} (stub — upstream is GET draft +
//   POST /drafts/{id}/confirm; implemented here),
//   GET /api/partner-groups[/discussion-modes] stubs.
//
// WebSocket endpoints (partner chat ws, group ws) are TODO — they need the
// node `ws` upgrade path wired in main.ts (see notes at bottom).
import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  getPartnerManager,
  slugifyPartnerId,
  slugifySoulId,
  maskChannelSecrets,
  stripLegacyGlobalDelivery,
  validateSessionKey,
  freshWebSessionKey,
  webSessionKey,
  getWebContinuity,
  setWebContinuity,
  moveActiveWebSession,
  PartnerDraftStore,
  PartnerTurnBusyError,
  PartnerStaleSessionError,
  PartnerNotFoundError,
  issueLinkCode,
  redeemLinkCode,
  listLinks,
  removeLink,
  DEFAULT_SOUL,
  type PartnerConfig,
} from "../services/partners_ext/manager.js";
import { getPartnerGroupManager } from "../services/partners_ext/groups.js";
import {
  currentUser,
  canManagePartner,
  canUsePartner,
  identityCard,
  listUserInfo,
  getUserById,
  createUser,
  setPassword,
  setPreset,
  setBookPermission,
  revokeDeviceCredentialsForUser,
  loadGrant,
  saveGrant,
  saveGrantWithReceipt,
  restoreGrantIfUnchanged,
  normalizeGrant,
  validateGrant,
  learnerGrant,
  listRelationships,
  relationshipById,
  authorizeGuardian,
  revokeGuardian,
  guardianCanAccess,
  normalizeBookPermission,
  publicPermissionDict,
  logAdminAction,
  logGuardianAction,
  GUARDIAN_PERMISSIONS,
  LEARNING_AGE_BANDS,
  LEARNING_SURFACES,
  assignedPartnerIds,
  ADMIN_USER,
  type CurrentUser,
} from "../services/partners_ext/multiuser.js";
import { COL, getItem, listItems, putItem } from "../services/partners_ext/store.js";
import { completeText } from "../services/llm_text.js";
import { getSettings } from "../config.js";
import type { AnyRecord } from "../services/partners_ext/store.js";

export const partnersFullRouter = new Hono();

// ── helpers ────────────────────────────────────────────────────
function user(c: Context): CurrentUser {
  return currentUser(c.req.header("x-praxis-user-id"));
}
function jsonError(c: Context, status: number, detail: unknown) {
  return c.json(typeof detail === "string" ? { detail } : { detail }, status as never);
}
function isAdmin(u: CurrentUser) {
  return u.is_admin;
}
function requireAdmin(c: Context): CurrentUser | Response {
  const u = user(c);
  if (!u.is_admin) return jsonError(c, 403, "Admin access required");
  return u;
}
function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function rec(v: unknown): AnyRecord {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as AnyRecord) : {};
}
function arr(v: unknown): AnyRecord[] {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

const AVATAR_MAX_CHARS = 200_000;
function validateAvatar(value: unknown): string {
  const avatar = str(value).trim();
  if (!avatar) return "";
  if (!avatar.startsWith("data:image/")) throw new HttpError(422, "Avatar must be a data:image/* URL");
  if (avatar.length > AVATAR_MAX_CHARS) {
    throw new HttpError(422, "Avatar too large — resize the image before uploading");
  }
  return avatar;
}
class HttpError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}
function validateLlmSelection(value: unknown): AnyRecord | null {
  if (value === null || value === undefined) return null;
  const sel = rec(value);
  const out: AnyRecord = {};
  for (const k of ["profile_id", "model_id", "provider", "model"]) {
    if (sel[k] !== undefined && sel[k] !== null && sel[k] !== "") out[k] = String(sel[k]);
  }
  return Object.keys(out).length ? out : null;
}
const LEGACY_DELIVERY = new Set(["send_progress", "send_tool_hints", "sendProgress", "sendToolHints"]);
function validateChannels(channels: unknown): AnyRecord {
  const ch = rec(channels);
  const legacy = Object.keys(ch).filter((k) => LEGACY_DELIVERY.has(k));
  if (legacy.length) {
    throw new HttpError(422, {
      message: `Delivery flags are configured per channel; remove top-level channel keys: ${legacy.join(", ")}`,
    });
  }
  const emptyAllow = Object.entries(ch)
    .filter(
      ([, v]) =>
        v && typeof v === "object" && !Array.isArray(v) &&
        (v as AnyRecord)["enabled"] === true &&
        ((v as AnyRecord)["allow_from"] ?? (v as AnyRecord)["allowFrom"]) !== undefined &&
        Array.isArray((v as AnyRecord)["allow_from"] ?? (v as AnyRecord)["allowFrom"]) &&
        (((v as AnyRecord)["allow_from"] ?? (v as AnyRecord)["allowFrom"]) as unknown[]).length === 0,
    )
    .map(([k]) => k);
  if (emptyAllow.length) {
    throw new HttpError(422, {
      message: `Enabled channels require at least one allowed sender: ${emptyAllow.join(", ")}`,
      channels: emptyAllow,
    });
  }
  return ch;
}

// Access guards (usable = exists + can_use; manageable = can_manage).
function usablePartner(c: Context, pid: string): { ok: true; user: CurrentUser } | { ok: false; res: Response } {
  const mgr = getPartnerManager();
  const u = user(c);
  if (!mgr.partnerExists(pid) || !canUsePartner(pid, mgr.ownerId(pid), u)) {
    return { ok: false, res: jsonError(c, 404, "Partner not found") };
  }
  return { ok: true, user: u };
}
function manageablePartner(c: Context, pid: string): { ok: true; user: CurrentUser } | { ok: false; res: Response } {
  const g = usablePartner(c, pid);
  if (!g.ok) return g;
  if (!canManagePartner(getPartnerManager().ownerId(pid), g.user)) {
    return { ok: false, res: jsonError(c, 403, "You cannot manage this partner") };
  }
  return g;
}

// Wrap handlers so HttpError maps to its status.
function h(fn: (c: Context) => unknown | Promise<unknown>) {
  return async (c: Context) => {
    try {
      const out = await fn(c);
      return out instanceof Response ? out : c.json(out as never);
    } catch (e) {
      if (e instanceof HttpError) return jsonError(c, e.status, e.detail);
      if (e instanceof PartnerNotFoundError) return jsonError(c, 404, "Partner not found");
      if (e instanceof PartnerStaleSessionError) {
        return c.json({ detail: { message: String(e.message), active_session_key: e.activeSessionKey } }, 409 as never);
      }
      if (e instanceof PartnerTurnBusyError) return jsonError(c, 409, String(e.message));
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "partner_stopped_start_required") return jsonError(c, 409, "Partner is stopped; start it first");
      if (msg.startsWith("Unknown partner")) return jsonError(c, 422, msg);
      if (msg.includes("Partner Group")) return jsonError(c, 404, msg);
      return jsonError(c, 500, msg);
    }
  };
}

// ════════════════════════════════════════════════════════════════
// PARTNERS — soul library & catalog (static routes first)
// ════════════════════════════════════════════════════════════════

partnersFullRouter.get("/partners/souls", h(() => getPartnerManager().listSouls()));

partnersFullRouter.post("/partners/souls", h(async (c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const b = rec(await c.req.json());
  const soulId = slugifySoulId(str(b["id"]) || str(b["name"]));
  const mgr = getPartnerManager();
  if (mgr.getSoul(soulId)) throw new HttpError(409, `Soul already exists: ${soulId}`);
  return mgr.createSoul(soulId, str(b["name"]), str(b["content"]));
}));

partnersFullRouter.get("/partners/souls/:soul_id", h((c) => {
  const soul = getPartnerManager().getSoul(c.req.param("soul_id")!);
  if (!soul) throw new HttpError(404, "Soul not found");
  return soul;
}));

partnersFullRouter.put("/partners/souls/:soul_id", h(async (c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const b = rec(await c.req.json());
  const result = getPartnerManager().updateSoul(
    c.req.param("soul_id")!,
    b["name"] !== undefined ? str(b["name"]) : null,
    b["content"] !== undefined ? str(b["content"]) : null,
  );
  if (!result) throw new HttpError(404, "Soul not found");
  return result;
}));

partnersFullRouter.delete("/partners/souls/:soul_id", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  if (!getPartnerManager().deleteSoul(c.req.param("soul_id")!)) throw new HttpError(404, "Soul not found");
  return { id: c.req.param("soul_id")!, deleted: true };
}));

partnersFullRouter.get("/partners/soul-sources", h(async (c) => {
  const mgr = getPartnerManager();
  const library = mgr.listSouls();
  // Personas live in the workspace store; expose them if the registry has any.
  const personas: AnyRecord[] = [];
  try {
    const { list_items } = await import("../store/database.js");
    const { getSettings } = await import("../config.js");
    for (const item of list_items(getSettings(), "personas") as AnyRecord[]) {
      personas.push({ name: item["name"], description: item["description"] ?? "", content: stripFrontmatterLocal(str(item["content"])) });
    }
  } catch { /* personas optional */ }
  return { library, personas };
}));

function stripFrontmatterLocal(content: string): string {
  return String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "");
}

partnersFullRouter.get("/partners/navigation", h((c) => {
  const mgr = getPartnerManager();
  const u = user(c);
  const partners = mgr
    .listPartners()
    .filter((p) => canUsePartner(str(p["partner_id"]), str(p["owner_id"]), u))
    .map((p) => {
      const manageable = canManagePartner(str(p["owner_id"]), u);
      const base: AnyRecord = {};
      for (const k of ["partner_id", "name", "description", "emoji", "color", "avatar", "running"]) {
        base[k] = p[k];
      }
      base["can_manage"] = manageable;
      return manageable ? { ...p, can_manage: true } : identityCard({ ...p });
    });
  const groupMgr = getPartnerGroupManager();
  const groups = groupMgr.listGroups(u);
  const sessions: AnyRecord[] = [];
  const unavailable: string[] = [];
  const navTs = (v: unknown): number => {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(String(v));
    return Number.isFinite(t) ? t / 1000 : 0;
  };
  for (const [kind, owners] of [
    ["partner", partners],
    ["group", groups],
  ] as const) {
    for (const owner of owners as AnyRecord[]) {
      const ownerId = str(owner[`${kind}_id`]);
      try {
        const rows =
          kind === "partner"
            ? mgr.sessionStore(ownerId, u).listSessions()
            : groupMgr.listSessions(ownerId);
        for (const row of rows) {
          if (row["archived"]) continue;
          sessions.push({
            kind,
            owner_id: ownerId,
            owner_name: str(owner["name"]),
            session_key: row["session_key"],
            title: str(row["title"] || row["last_message"] || "").slice(0, 160),
            updated_at: navTs(row["updated_at"]),
          });
        }
      } catch {
        unavailable.push(`${kind}:${ownerId}`);
      }
    }
  }
  sessions.sort((a, b) =>
    b["updated_at"] !== a["updated_at"]
      ? b["updated_at"] - a["updated_at"]
      : String(a["kind"]).localeCompare(String(b["kind"])) ||
        String(a["owner_id"]).localeCompare(String(b["owner_id"])) ||
        String(a["session_key"]).localeCompare(String(b["session_key"])),
  );
  return { partners, groups, sessions, unavailable };
}));

partnersFullRouter.get("/partners/consultation-session", h((c) => {
  // GET ?chat_session_id&partner_name — recover native identity for older
  // consultation traces. Subagent sessions aren't ported; match by name.
  const chatSessionId = str(c.req.query("chat_session_id"));
  const partnerName = str(c.req.query("partner_name"));
  const mgr = getPartnerManager();
  const u = user(c);
  const matches: AnyRecord[] = [];
  for (const p of mgr.listPartners()) {
    if (str(p["name"]) !== partnerName) continue;
    const pid = str(p["partner_id"]);
    if (!canUsePartner(pid, str(p["owner_id"]), u)) continue;
    // Native key: web:<chat_session_id> scoped under the partner namespace.
    const nativeKey = `web:${chatSessionId}`;
    const store = mgr.sessionStore(pid, u);
    if (store.messages(nativeKey, { limit: 1 }).length || store.listSessions().some((s) => s["session_key"] === nativeKey)) {
      matches.push({ partner_id: pid, session_key: nativeKey });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}));

partnersFullRouter.get("/partners/recent", h((c) => {
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 3) || 3, 50));
  const mgr = getPartnerManager();
  const u = user(c);
  return mgr
    .getRecentActivePartners(limit)
    .filter((item) => canUsePartner(str(item["partner_id"]), mgr.ownerId(str(item["partner_id"])), u));
}));

// Channel schemas — static metadata describing built-in channels.
partnersFullRouter.get("/partners/channels/schema", h(() => ({ channels: channelSchemas() })));

function channelSchemas(): Record<string, AnyRecord> {
  // JSON-schema payloads for the channels this backend can represent.
  // Secret fields are detected by name hint, same rule as upstream.
  const defs: Record<string, AnyRecord> = {
    telegram: {
      name: "telegram", display_name: "Telegram",
      default_config: { enabled: false, token: "", allow_from: [] },
      json_schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          token: { type: "string", description: "Bot token from @BotFather" },
          allow_from: { type: "array", items: { type: "string" }, description: "Allowed sender ids" },
        },
      },
    },
    discord: {
      name: "discord", display_name: "Discord",
      default_config: { enabled: false, token: "", allow_from: [] },
      json_schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          token: { type: "string" },
          allow_from: { type: "array", items: { type: "string" } },
        },
      },
    },
    slack: {
      name: "slack", display_name: "Slack",
      default_config: { enabled: false, bot_token: "", app_token: "", allow_from: [] },
      json_schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          bot_token: { type: "string" },
          app_token: { type: "string" },
          allow_from: { type: "array", items: { type: "string" } },
        },
      },
    },
    feishu: {
      name: "feishu", display_name: "Feishu / Lark",
      default_config: { enabled: false, app_id: "", app_secret: "", encrypt_key: "", verification_token: "", allow_from: [] },
      json_schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          app_id: { type: "string" },
          app_secret: { type: "string" },
          encrypt_key: { type: "string" },
          verification_token: { type: "string" },
          allow_from: { type: "array", items: { type: "string" } },
        },
      },
    },
    wecom: {
      name: "wecom", display_name: "WeCom",
      default_config: { enabled: false, corp_id: "", secret: "", agent_id: "", allow_from: [] },
      json_schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          corp_id: { type: "string" },
          secret: { type: "string" },
          agent_id: { type: "string" },
          allow_from: { type: "array", items: { type: "string" } },
        },
      },
    },
    weixin: {
      name: "weixin", display_name: "WeChat (personal)",
      default_config: { enabled: false, bot_token: "", allow_from: [] },
      json_schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          bot_token: { type: "string" },
          allow_from: { type: "array", items: { type: "string" } },
        },
      },
    },
    email: {
      name: "email", display_name: "Email",
      default_config: { enabled: false, imap_password: "", smtp_password: "", allow_from: [] },
      json_schema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: false },
          imap_password: { type: "string" },
          smtp_password: { type: "string" },
          allow_from: { type: "array", items: { type: "string" } },
        },
      },
    },
  };
  const out: Record<string, AnyRecord> = {};
  for (const [name, d] of Object.entries(defs)) {
    const schema = d["json_schema"] as AnyRecord;
    const props = rec(schema["properties"]);
    const secretFields: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      const pv = rec(v);
      const t = pv["type"];
      const acceptsString = t === "string" || (Array.isArray(t) && t.includes("string")) ||
        (Array.isArray(pv["anyOf"]) && (pv["anyOf"] as AnyRecord[]).some((x) => rec(x)["type"] === "string"));
      if (/token|secret|password|api_key|apikey|encrypt_key/i.test(k) && acceptsString) {
        secretFields.push(k);
      }
    }
    out[name] = {
      name: d["name"],
      display_name: d["display_name"],
      available: true,
      default_config: d["default_config"],
      secret_fields: secretFields,
      json_schema: schema,
    };
  }
  return out;
}

// ── tool options ──
const TOOL_EXCLUDE_BUILTIN = new Set(["read_memory", "write_memory"]);
const OPTIONAL_POOL = [
  "web", "web_search", "paper_search", "question_bank", "knowledge_base_search",
  "learning", "workspace", "mastery", "video", "notebook", "cron", "review",
  "ask_user",
];
partnersFullRouter.get("/partners/tool-options", h((c) => {
  const u = user(c);
  const optional = u.is_admin ? null : assignedPartnerIds(u.id); // tool reach approx
  void optional;
  const tools = OPTIONAL_POOL.filter((t) => !TOOL_EXCLUDE_BUILTIN.has(t)).map((name) => ({
    name,
    description: name,
    mutating: ["workspace", "notebook", "cron", "review", "learning"].includes(name),
  }));
  return {
    tools,
    builtin_tools: ["web_fetch", "rag", "read_file", "write_file"],
    mcp_tools: [],
  };
}));

// ── create partner ──
partnersFullRouter.post("/partners", h(async (c) => {
  const u = user(c);
  const b = rec(await c.req.json());
  const mgr = getPartnerManager();
  const pid = slugifyPartnerId(str(b["partner_id"]) || str(b["name"]));
  if (mgr.partnerExists(pid)) throw new HttpError(409, `Partner already exists: ${pid}`);

  if (b["channels"] !== undefined && b["channels"] !== null) validateChannels(b["channels"]);
  const llmSel = validateLlmSelection(b["llm_selection"]);
  const backupSel = validateLlmSelection(b["backup_llm_selection"]);

  // Resolve soul.
  let soulContent = DEFAULT_SOUL;
  let soulOrigin: AnyRecord = { type: "default", id: "" };
  const soul = rec(b["soul"]);
  const source = str(soul["source"]) || "default";
  if (source === "custom") {
    soulContent = str(soul["content"]).trim();
    if (!soulContent) throw new HttpError(422, "Soul content is empty");
    soulOrigin = { type: "custom", id: "" };
  } else if (source === "library") {
    const sid = str(soul["id"]);
    const entry = mgr.getSoul(sid);
    if (!entry) throw new HttpError(404, `Soul library entry not found: ${sid}`);
    soulContent = str(entry["content"]);
    soulOrigin = { type: "library", id: sid };
  } else if (source === "persona") {
    const name = str(soul["id"]).trim();
    if (!name) throw new HttpError(422, "Persona name is required");
    soulContent = await loadPersonaMarkdown(name);
    if (!soulContent) throw new HttpError(404, `Persona not found: ${name}`);
    soulOrigin = { type: "persona", id: name };
  }

  const cfg: PartnerConfig = {
    name: str(b["name"]).trim(),
    description: str(b["description"]).trim(),
    owner_id: u.id,
    workspace_id: str(b["workspace_id"]).trim(),
    channels: b["channels"] ? validateChannels(b["channels"]) : {},
    llm_selection: llmSel,
    backup_llm_selection: backupSel,
    model: null,
    language: str(b["language"]).trim(),
    emoji: str(b["emoji"]).trim(),
    color: str(b["color"]).trim(),
    avatar: validateAvatar(b["avatar"]),
    soul_origin: soulOrigin,
    enabled_tools: Array.isArray(b["enabled_tools"]) ? b["enabled_tools"].map(str) : null,
    builtin_tools: Array.isArray(b["builtin_tools"]) ? b["builtin_tools"].map(str) : null,
    mcp_tools: b["mcp_tools"] === null || b["mcp_tools"] === undefined ? [] : Array.isArray(b["mcp_tools"]) ? b["mcp_tools"].map(str) : [],
  };
  mgr.saveConfig(pid, cfg, { auto_start: Boolean(b["start"] ?? true) });
  mgr.writeSoul(pid, soulContent);

  const provisioning: AnyRecord = { copied: {}, errors: [] };
  const assets = rec(b["assets"]);
  const hasAssets = ["knowledge_bases", "skills", "notebooks"].some(
    (k) => Array.isArray(assets[k]) && (assets[k] as unknown[]).length,
  );
  if (cfg.workspace_id && hasAssets) {
    throw new HttpError(400, "Use the shared workspace resources or copy private assets, not both.");
  }
  if (hasAssets) provisioning["copied"] = provisionAssetsStub(pid, assets);

  const wantStart = b["start"] !== false;
  let result: AnyRecord;
  if (wantStart) {
    try {
      const inst = await mgr.startPartner(pid, cfg);
      result = mgr["instanceToDict"]
        ? (mgr as any).instanceToDict(inst, { mask_secrets: true })
        : mgr.stoppedPartnerDict(pid, cfg);
      result["running"] = true;
    } catch {
      result = mgr.stoppedPartnerDict(pid, cfg);
      result["start_error"] = "Partner created but failed to start";
    }
  } else {
    result = mgr.stoppedPartnerDict(pid, cfg);
  }
  result["provisioning"] = provisioning;
  return result;
}));

async function loadPersonaMarkdown(name: string): Promise<string> {
  try {
    const { list_items } = await import("../store/database.js");
    const { getSettings } = await import("../config.js");
    for (const item of list_items(getSettings(), "personas") as AnyRecord[]) {
      if (str(item["name"]) === name) return stripFrontmatterLocal(str(item["content"]));
    }
  } catch { /* ignore */ }
  return "";
}

// Asset provisioning is workspace-coupled upstream; record what would copy.
function provisionAssetsStub(pid: string, assets: AnyRecord): AnyRecord {
  const copied: AnyRecord = {};
  for (const kind of ["knowledge_bases", "skills", "notebooks"] as const) {
    const list = Array.isArray(assets[kind]) ? (assets[kind] as unknown[]).map(str) : [];
    if (list.length) copied[kind] = list;
  }
  return copied;
}

// ── drafts ──
partnersFullRouter.get("/partners/drafts/:draft_id", h((c) => {
  const mgr = getPartnerManager();
  void mgr;
  const draft = new PartnerDraftStore().get(c.req.param("draft_id")!, user(c).id);
  if (!draft) throw new HttpError(404, "Partner draft not found");
  const { id: _id, ...rest } = draft as AnyRecord;
  return rest;
}));

partnersFullRouter.post("/partners/drafts/:draft_id/confirm", h(async (c) => {
  const u = user(c);
  const draftId = c.req.param("draft_id")!;
  const store = new PartnerDraftStore();
  const draft = store.get(draftId, u.id);
  if (!draft) throw new HttpError(404, "Partner draft not found");
  const mgr = getPartnerManager();

  if (draft.status === "created" && draft.created_partner_id) {
    const cfg = mgr.loadConfig(draft.created_partner_id);
    if (cfg) {
      const inst = mgr.getPartner(draft.created_partner_id);
      const result = inst?.running
        ? (mgr as any).instanceToDict(inst, { mask_secrets: true })
        : mgr.stoppedPartnerDict(draft.created_partner_id, cfg);
      result["draft_id"] = draft.draft_id;
      result["already_created"] = true;
      return result;
    }
  }

  const b = rec(await c.req.json().catch(() => ({})));
  const pick = (key: string, fallback: string) => (b[key] !== undefined ? str(b[key]) : fallback);
  // Reuse the create path by simulating the payload.
  const createPayload = {
    name: pick("name", draft.name),
    description: pick("description", draft.description),
    soul: { source: "custom", content: pick("soul", draft.soul) },
    language: pick("language", draft.language),
    emoji: pick("emoji", draft.emoji),
    color: pick("color", draft.color),
    enabled_tools: draft.enabled_tools,
    builtin_tools: draft.builtin_tools,
    mcp_tools: draft.mcp_tools,
    start: b["start"] !== undefined ? Boolean(b["start"]) : true,
  };
  // Inline the create logic (same as POST /partners).
  const result = await createPartnerInternal(createPayload, u);
  store.markCreated(draft, str(result["partner_id"]));
  result["draft_id"] = draft.draft_id;
  result["already_created"] = false;
  return result;
}));

async function createPartnerInternal(b: AnyRecord, u: CurrentUser): Promise<AnyRecord> {
  const mgr = getPartnerManager();
  const pid = slugifyPartnerId(str(b["partner_id"]) || str(b["name"]));
  if (mgr.partnerExists(pid)) throw new HttpError(409, `Partner already exists: ${pid}`);
  if (b["channels"] !== undefined && b["channels"] !== null) validateChannels(b["channels"]);
  const llmSel = validateLlmSelection(b["llm_selection"]);
  const backupSel = validateLlmSelection(b["backup_llm_selection"]);
  let soulContent = DEFAULT_SOUL;
  let soulOrigin: AnyRecord = { type: "default", id: "" };
  const soul = rec(b["soul"]);
  const source = str(soul["source"]) || "default";
  if (source === "custom") {
    soulContent = str(soul["content"]).trim();
    if (!soulContent) throw new HttpError(422, "Soul content is empty");
    soulOrigin = { type: "custom", id: "" };
  } else if (source === "library") {
    const sid = str(soul["id"]);
    const entry = mgr.getSoul(sid);
    if (!entry) throw new HttpError(404, `Soul library entry not found: ${sid}`);
    soulContent = str(entry["content"]);
    soulOrigin = { type: "library", id: sid };
  } else if (source === "persona") {
    const name = str(soul["id"]).trim();
    soulContent = await loadPersonaMarkdown(name);
    if (!soulContent) throw new HttpError(404, `Persona not found: ${name}`);
    soulOrigin = { type: "persona", id: name };
  }
  const cfg: PartnerConfig = {
    name: str(b["name"]).trim(),
    description: str(b["description"]).trim(),
    owner_id: u.id,
    workspace_id: str(b["workspace_id"]).trim(),
    channels: b["channels"] ? validateChannels(b["channels"]) : {},
    llm_selection: llmSel,
    backup_llm_selection: backupSel,
    model: null,
    language: str(b["language"]).trim(),
    emoji: str(b["emoji"]).trim(),
    color: str(b["color"]).trim(),
    avatar: validateAvatar(b["avatar"]),
    soul_origin: soulOrigin,
    enabled_tools: Array.isArray(b["enabled_tools"]) ? b["enabled_tools"].map(str) : null,
    builtin_tools: Array.isArray(b["builtin_tools"]) ? b["builtin_tools"].map(str) : null,
    mcp_tools: b["mcp_tools"] === null || b["mcp_tools"] === undefined ? [] : Array.isArray(b["mcp_tools"]) ? b["mcp_tools"].map(str) : [],
  };
  mgr.saveConfig(pid, cfg, { auto_start: Boolean(b["start"] ?? true) });
  mgr.writeSoul(pid, soulContent);
  const wantStart = b["start"] !== false;
  let result: AnyRecord;
  if (wantStart) {
    try {
      const inst = await mgr.startPartner(pid, cfg);
      result = (mgr as any).instanceToDict(inst, { mask_secrets: true });
    } catch {
      result = mgr.stoppedPartnerDict(pid, cfg);
      result["start_error"] = "Partner created but failed to start";
    }
  } else {
    result = mgr.stoppedPartnerDict(pid, cfg);
  }
  result["provisioning"] = { copied: {}, errors: [] };
  return result;
}

// ── partner detail / update / lifecycle ──
partnersFullRouter.get("/partners/:partner_id", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const u = g.user;
  const mgr = getPartnerManager();
  const manageable = canManagePartner(mgr.ownerId(pid), u);
  const includeSecrets = c.req.query("include_secrets") === "true" && manageable;
  const inst = mgr.getPartner(pid);
  let full: AnyRecord;
  if (inst?.running) {
    full = (mgr as any).instanceToDict(inst, {
      include_secrets: includeSecrets,
      mask_secrets: !includeSecrets,
    });
  } else {
    const cfg = mgr.loadConfig(pid);
    if (!cfg) throw new HttpError(404, "Partner not found");
    full = mgr.stoppedPartnerDict(pid, cfg, { include_secrets: includeSecrets });
  }
  if (!manageable) return { ...identityCard(full), can_manage: false };
  return { ...full, can_manage: true };
}));

function applyUpdate(cfg: PartnerConfig, b: AnyRecord, ownerId: string): void {
  const mgr = getPartnerManager();
  if ("workspace_id" in b) cfg.workspace_id = str(b["workspace_id"]).trim();
  if (b["name"] !== undefined) cfg.name = str(b["name"]);
  if (b["description"] !== undefined) cfg.description = str(b["description"]);
  if (b["channels"] !== undefined) cfg.channels = validateChannels(b["channels"]);
  if (b["language"] !== undefined) cfg.language = str(b["language"]);
  if (b["emoji"] !== undefined) cfg.emoji = str(b["emoji"]);
  if (b["color"] !== undefined) cfg.color = str(b["color"]);
  if (b["avatar"] !== undefined) cfg.avatar = validateAvatar(b["avatar"]);
  if ("llm_selection" in b) {
    cfg.llm_selection = validateLlmSelection(b["llm_selection"]);
    cfg.model = null;
  }
  if ("backup_llm_selection" in b) cfg.backup_llm_selection = validateLlmSelection(b["backup_llm_selection"]);
  if ("enabled_tools" in b) cfg.enabled_tools = Array.isArray(b["enabled_tools"]) ? b["enabled_tools"].map(str) : null;
  if ("builtin_tools" in b) cfg.builtin_tools = Array.isArray(b["builtin_tools"]) ? b["builtin_tools"].map(str) : null;
  if ("mcp_tools" in b) cfg.mcp_tools = Array.isArray(b["mcp_tools"]) ? b["mcp_tools"].map(str) : null;
  void mgr; void ownerId;
}

partnersFullRouter.patch("/partners/:partner_id", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const b = rec(await c.req.json());
  if (b["channels"] !== undefined) validateChannels(b["channels"]);
  const mgr = getPartnerManager();
  const inst = mgr.getPartner(pid);
  if (inst?.running) {
    applyUpdate(inst.config, b, inst.config.owner_id);
    mgr.saveConfig(pid, inst.config);
    if (b["channels"] !== undefined) await mgr.reloadChannels(pid);
    return (mgr as any).instanceToDict(inst, { mask_secrets: true });
  }
  const cfg = mgr.loadConfig(pid);
  if (!cfg) throw new HttpError(404, "Partner not found");
  applyUpdate(cfg, b, cfg.owner_id);
  mgr.saveConfig(pid, cfg);
  return mgr.stoppedPartnerDict(pid, cfg);
}));

partnersFullRouter.post("/partners/:partner_id/start", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  const inst = await mgr.ensureRunning(pid, { allow_stopped: true });
  mgr.saveConfig(pid, inst.config, { auto_start: true });
  return (mgr as any).instanceToDict(inst, { mask_secrets: true });
}));

partnersFullRouter.post("/partners/:partner_id/stop", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const stopped = await getPartnerManager().stopPartner(pid);
  if (!stopped) throw new HttpError(404, "Partner not found or not running");
  return { partner_id: pid, stopped: true };
}));

partnersFullRouter.delete("/partners/:partner_id", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const destroyed = await getPartnerManager().destroyPartner(pid);
  if (!destroyed) throw new HttpError(404, "Partner not found");
  return { partner_id: pid, destroyed: true };
}));

partnersFullRouter.post("/partners/:partner_id/channels/reload", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  const inst = mgr.getPartner(pid);
  if (!inst?.running) throw new HttpError(404, "Partner not running");
  try {
    await mgr.reloadChannels(pid);
  } catch (e) {
    throw new HttpError(500, `Failed to reload channels: ${e instanceof Error ? e.name : "Error"}`);
  }
  return { partner_id: pid, reloaded: true };
}));

partnersFullRouter.get("/partners/:partner_id/channels/status", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  const inst = mgr.getPartner(pid);
  const cfg = inst?.config ?? mgr.loadConfig(pid);
  if (!cfg) throw new HttpError(404, "Partner not found");
  const source = rec(cfg.channels);
  const channels: AnyRecord = {};
  for (const [name, value] of Object.entries(source)) {
    const v = rec(value);
    channels[name] = { enabled: Boolean(v["enabled"]), running: false, setup: {} };
  }
  return {
    partner_id: pid,
    running: Boolean(inst?.running),
    channels,
  };
}));

// Channel onboarding (feishu/wecom app provisioning) — upstream calls
// external provider APIs; keep the state machine, return 501-style errors
// where the provider call would happen.
partnersFullRouter.post("/partners/:partner_id/channel-onboarding/start", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const b = rec(await c.req.json());
  const channel = str(b["channel"]);
  if (!["feishu", "wecom"].includes(channel)) throw new HttpError(422, "channel must be feishu or wecom");
  const sessionId = randomUUID().replace(/-/g, "").slice(0, 16);
  putItem(`partners_ext/onboarding/${pid}`, {
    id: sessionId, partner_id: pid, channel, status: "pending", created_at: Date.now() / 1000,
  });
  return { session_id: sessionId, status: "pending", channel };
}));

partnersFullRouter.get("/partners/:partner_id/channel-onboarding/:session_id", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const item = getItem(`partners_ext/onboarding/${pid}`, c.req.param("session_id")!);
  if (!item) throw new HttpError(404, "Onboarding session not found");
  return { session_id: item["id"], status: item["status"] ?? "pending", channel: item["channel"] };
}));

partnersFullRouter.delete("/partners/:partner_id/channel-onboarding/:session_id", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const item = getItem(`partners_ext/onboarding/${pid}`, c.req.param("session_id")!);
  if (!item) throw new HttpError(404, "Onboarding session not found");
  item["status"] = "cancelled";
  putItem(`partners_ext/onboarding/${pid}`, item);
  return { session_id: item["id"], status: "cancelled" };
}));

partnersFullRouter.post("/partners/:partner_id/channel-onboarding/:session_id/apply", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const item = getItem(`partners_ext/onboarding/${pid}`, c.req.param("session_id")!);
  if (!item || item["status"] === "cancelled") throw new HttpError(404, "Onboarding session not found");
  item["status"] = "applied";
  putItem(`partners_ext/onboarding/${pid}`, item);
  return { session_id: item["id"], status: "applied" };
}));

// ── soul file ──
partnersFullRouter.get("/partners/:partner_id/soul", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  return { partner_id: pid, content: getPartnerManager().readSoul(pid) };
}));

partnersFullRouter.put("/partners/:partner_id/soul", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const b = rec(await c.req.json());
  getPartnerManager().writeSoul(pid, str(b["content"]));
  return { partner_id: pid, saved: true };
}));

// ── assets ──
partnersFullRouter.get("/partners/:partner_id/workspaces", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const cfg = getPartnerManager().loadConfig(pid);
  if (!cfg) throw new HttpError(404, "Partner not found");
  return { workspaces: [{ workspace_id: "", name: "Private partner library" }] };
}));

partnersFullRouter.get("/partners/:partner_id/assets", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  return listAssets(pid);
}));

partnersFullRouter.post("/partners/:partner_id/assets", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const cfg = getPartnerManager().loadConfig(pid);
  if (cfg?.workspace_id) {
    throw new HttpError(400, "This partner uses shared workspace resources. Add resources to that workspace.");
  }
  const b = rec(await c.req.json());
  const report = provisionAssetsStub(pid, b);
  return { partner_id: pid, copied: report, errors: [], assets: listAssets(pid) };
}));

partnersFullRouter.delete("/partners/:partner_id/assets/:asset_type/:name", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  const removed = removeAsset(pid, c.req.param("asset_type")!, c.req.param("name")!);
  if (!removed) throw new HttpError(404, "Asset not found");
  return { partner_id: pid, removed: true, assets: listAssets(pid) };
}));

function listAssets(pid: string): AnyRecord {
  const item = getItem(`partners_ext/assets/${pid}`, "assets") ?? { id: "assets", knowledge_bases: [], skills: [], notebooks: [] };
  return {
    knowledge_bases: item["knowledge_bases"] ?? [],
    skills: item["skills"] ?? [],
    notebooks: item["notebooks"] ?? [],
  };
}
function removeAsset(pid: string, type: string, name: string): boolean {
  if (!["knowledge_bases", "skills", "notebooks"].includes(type)) throw new HttpError(422, `Unknown asset type: ${type}`);
  const item = getItem(`partners_ext/assets/${pid}`, "assets");
  if (!item) return false;
  const list = (item[type] as string[]) ?? [];
  const idx = list.indexOf(name);
  if (idx < 0) return false;
  list.splice(idx, 1);
  putItem(`partners_ext/assets/${pid}`, item);
  return true;
}

// ── links ──
partnersFullRouter.post("/partners/:partner_id/links/code", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const issued = issueLinkCode(pid, g.user.id);
  return {
    partner_id: pid,
    code: issued.code,
    expires_at: issued.expires_at,
    command: `/link ${issued.code}`,
  };
}));

partnersFullRouter.get("/partners/:partner_id/links", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  return { partner_id: pid, links: listLinks(pid, g.user.id) };
}));

partnersFullRouter.delete("/partners/:partner_id/links/:key{.+}", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const key = c.req.param("key")!;
  if (!removeLink(pid, g.user.id, key)) throw new HttpError(404, "No such linked account");
  return { partner_id: pid, removed: true, key };
}));

// ── history / sessions / continuity ──
partnersFullRouter.get("/partners/:partner_id/history", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  const sessionKey = c.req.query("session_key") || null;
  const sessionId = c.req.query("session_id") || null;
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 100) || 100, 500));
  return mgr.getHistory(pid, {
    session_key: sessionKey,
    session_id: sessionId,
    limit,
    include_shared: !sessionKey && canManagePartner(mgr.ownerId(pid), g.user),
    actor: g.user,
  });
}));

partnersFullRouter.get("/partners/:partner_id/history/page", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const key = c.req.query("session_key") || "";
  const beforeQ = c.req.query("before");
  const before = beforeQ === undefined || beforeQ === "" ? null : Math.max(0, Number(beforeQ) || 0);
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 60) || 60, 200));
  return getPartnerManager().sessionStore(pid, g.user).messagesPage(key, { before, limit });
}));

partnersFullRouter.get("/partners/:partner_id/web-continuity", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  return getWebContinuity(pid, g.user.id);
}));

partnersFullRouter.put("/partners/:partner_id/web-continuity", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const b = rec(await c.req.json());
  try {
    return setWebContinuity(pid, g.user.id, {
      enabled: Boolean(b["enabled"]),
      session_key: b["session_key"] === undefined ? null : str(b["session_key"]),
    });
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
}));

partnersFullRouter.get("/partners/:partner_id/sessions", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  return getPartnerManager().sessionStore(pid, g.user).listSessions();
}));

async function bodyKey(c: Context): Promise<string> {
  const b = rec(await c.req.json().catch(() => ({})));
  return str(b["session_key"]);
}

partnersFullRouter.post("/partners/:partner_id/sessions/archive", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  const key = await bodyKey(c);
  const store = mgr.sessionStore(pid, g.user);
  if (!store.setArchived(key, true)) throw new HttpError(404, "Session not found");
  const activeKey = moveActiveWebSession(pid, g.user.id, {
    session_key: key,
    new_session_key: freshWebSessionKey(),
  });
  return { partner_id: pid, archived: true, session_key: key, active_session_key: activeKey };
}));

partnersFullRouter.post("/partners/:partner_id/sessions/resume", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  let key: string;
  try {
    key = validateSessionKey(await bodyKey(c));
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
  const store = mgr.sessionStore(pid, g.user);
  store.setArchived(key, false);
  const summary = store.listSessions().find((s) => s["session_key"] === key) ?? null;
  if (!summary) throw new HttpError(404, "Session not found");
  const activeKey = moveActiveWebSession(pid, g.user.id, {
    session_key: key,
    new_session_key: key,
    only_if_current: false,
  });
  return { partner_id: pid, resumed: true, session: summary, active_session_key: activeKey };
}));

partnersFullRouter.post("/partners/:partner_id/sessions/delete", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  const key = await bodyKey(c);
  const store = mgr.sessionStore(pid, g.user);
  if (!store.deleteSession(key)) throw new HttpError(404, "Session not found");
  const activeKey = moveActiveWebSession(pid, g.user.id, {
    session_key: key,
    new_session_key: freshWebSessionKey(),
  });
  return { partner_id: pid, deleted: true, session_key: key, active_session_key: activeKey };
}));

partnersFullRouter.post("/partners/:partner_id/sessions/branch", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const mgr = getPartnerManager();
  const b = rec(await c.req.json());
  const sourceKey = str(b["source_key"]);
  let targetKey: string;
  try {
    targetKey = validateSessionKey(str(b["new_key"]));
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
  const store = mgr.sessionStore(pid, g.user);
  const srcStem = sourceKey.replace(/:/g, "_").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+|\.+$/g, "") || "default";
  if (srcStem === targetKey) throw new HttpError(400, "Branch needs a different session key");
  let summary: AnyRecord | null;
  try {
    summary = store.branch(sourceKey, targetKey);
  } catch (e) {
    if (String(e).includes("already exists")) throw new HttpError(409, "Destination session already exists");
    throw e;
  }
  if (!summary) throw new HttpError(400, "Nothing to branch (source is empty)");
  const activeKey = moveActiveWebSession(pid, g.user.id, {
    session_key: sourceKey,
    new_session_key: targetKey,
  });
  return { partner_id: pid, branched: true, session: summary, active_session_key: activeKey };
}));

// ── chat (HTTP + SSE) ──
function resolveHttpSession(b: AnyRecord): [string, string] {
  const explicitSession = str(b["session_id"]).trim();
  const explicitChat = str(b["chat_id"]).trim();
  if (explicitSession) return [explicitSession, explicitChat || explicitSession];
  if (explicitChat) return [explicitChat, explicitChat];
  const sid = randomUUID().replace(/-/g, "");
  return [sid, sid];
}

partnersFullRouter.post("/partners/:partner_id/chat", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const b = rec(await c.req.json());
  const content = str(b["content"]).trim();
  const attachments = arr(b["attachments"]);
  if (!content && !attachments.length) throw new HttpError(400, "content required");
  const mgr = getPartnerManager();
  await mgr.ensureRunning(pid, { allow_stopped: true });
  const [sessionId, chatId] = resolveHttpSession(b);
  const media = materializeAttachments(pid, attachments);
  const finalContent = content || (media.length ? defaultAttachmentPrompt(attachments) : "");
  try {
    const out = await mgr.sendMessage(pid, finalContent, {
      chat_id: chatId,
      session_id: sessionId,
      session_key: b["session_key"] ? str(b["session_key"]) : null,
      media,
      actor: g.user,
    });
    return { partner_id: pid, session_id: sessionId, content: out.content };
  } catch (e) {
    if (e instanceof PartnerStaleSessionError) throw e;
    if (e instanceof PartnerTurnBusyError) throw e;
    if (e instanceof Error && e.message.includes("not running")) throw new HttpError(400, e.message);
    throw e;
  }
}));

partnersFullRouter.post("/partners/:partner_id/chat/execute-stream", h(async (c) => {
  const pid = c.req.param("partner_id")!;
  const g = usablePartner(c, pid);
  if (!g.ok) return g.res;
  const b = rec(await c.req.json());
  const content = str(b["content"]).trim();
  const attachments = arr(b["attachments"]);
  if (!content && !attachments.length) throw new HttpError(400, "content required");
  const mgr = getPartnerManager();
  await mgr.ensureRunning(pid, { allow_stopped: true });
  const [sessionId, chatId] = resolveHttpSession(b);
  const media = materializeAttachments(pid, attachments);
  const finalContent = content || (media.length ? defaultAttachmentPrompt(attachments) : "");

  const sse = (event: string, payload: AnyRecord) =>
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event: string, payload: AnyRecord) =>
        controller.enqueue(enc.encode(sse(event, payload)));
      send("session", { partner_id: pid, session_id: sessionId });
      try {
        const state = getWebContinuity(pid, g.user.id);
        const key = b["session_key"] ? str(b["session_key"]) : null;
        if (key && state["enabled"] && state["session_key"] !== validateSessionKey(key)) {
          throw new PartnerStaleSessionError(str(state["session_key"]));
        }
        const out = await mgr.sendMessage(pid, finalContent, {
          chat_id: chatId,
          session_id: sessionId,
          session_key: key,
          media,
          actor: g.user,
          on_event: (frame) => {
            const ev = rec(frame["event"]);
            if (ev["type"] === "content" || ev["type"] === "thinking") {
              send(String(ev["type"]), { content: str(ev["content"]) });
            }
          },
        });
        send("content", { content: out.content });
        send("done", { partner_id: pid, session_id: sessionId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        send("error", { detail: msg });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}));

export function defaultAttachmentPrompt(attachments: AnyRecord[]): string {
  const allImages = attachments.every((a) => str(a["type"]).toLowerCase() === "image");
  return allImages ? "Please analyze the attached image(s)." : "Please use the attached file(s).";
}
export function materializeAttachments(pid: string, attachments: AnyRecord[]): string[] {
  // Persist base64 payloads under the partner media tree (data/partners/<id>/media/web).
  const out: string[] = [];
  if (!attachments.length) return out;
  const settings = getSettings();
  const dir = `${settings.data_dir}/partners/${pid}/media/web`;
  mkdirSync(dir, { recursive: true });
  for (const item of attachments) {
    let raw = str(item["base64"]).trim();
    if (raw.startsWith("data:") && raw.includes(",")) raw = raw.split(",")[1];
    if (!raw) continue;
    const data = Buffer.from(raw, "base64");
    const filename = (str(item["filename"]) || "attachment").replace(/[^\w.\-]+/g, "_") || "attachment";
    const path = `${dir}/${randomUUID().replace(/-/g, "").slice(0, 12)}_${filename}`;
    writeFileSync(path, data);
    out.push(path);
  }
  return out;
}

partnersFullRouter.get("/partners/commands/palette", h(() => {
  // Port of services.partners.commands.partner_command_palette.
  return {
    commands: [
      { command: "/help", description: "Show available partner commands.", arg_hint: "" },
      { command: "/new", description: "Archive this conversation and start a fresh one.", arg_hint: "" },
      { command: "/branch", description: "Archive this conversation and continue in a copy.", arg_hint: "" },
      { command: "/stop", description: "Stop the reply that's currently being generated.", arg_hint: "" },
      { command: "/sessions", description: "List this partner's conversations and their IDs.", arg_hint: "" },
      { command: "/resume", description: "Reopen an archived conversation.", arg_hint: "<session ID>" },
      { command: "/delete", description: "Delete a conversation permanently.", arg_hint: "<session ID>" },
      { command: "/status", description: "Show partner, session, model, and tool status.", arg_hint: "" },
      { command: "/model", description: "List or switch this partner's model.", arg_hint: "[number|model name]" },
      { command: "/history", description: "Show recent messages in this conversation.", arg_hint: "[n]" },
      { command: "/tool", description: "Show or change enabled tools.", arg_hint: "[on|off <name>|reset]" },
      { command: "/link", description: "Connect this chat account to your DeepTutor account.", arg_hint: "<code from the web app>" },
    ],
  };
}));

// ════════════════════════════════════════════════════════════════
// PARTNER GROUPS
// ════════════════════════════════════════════════════════════════
const groupMgr = () => getPartnerGroupManager();

partnersFullRouter.get("/partner-groups", h((c) => groupMgr().listGroups(user(c))));

partnersFullRouter.get("/partner-groups/discussion-modes", h(() => ({
  modes: [
    { name: "panel_parallel", label: "Parallel panel", description: "Selected Partners answer concurrently from shared public context; their private intermediate work is not shared." },
    { name: "sequential", label: "Sequential Build", description: "Selected Partners respond in Group member order, each building on messages already produced this round without repeating them." },
    { name: "debate", label: "Cross Debate", description: "Selected Partners debate in two parallel rounds: clear opening positions, then substantive clashes informed by every opening statement." },
  ],
})));

partnersFullRouter.get("/partner-groups/shared-memory-types", h(() => ({
  types: [{ name: "whiteboard", label: "Shared whiteboard", description: "Shared Group notes stored separately from the public transcript." }],
})));

partnersFullRouter.post("/partner-groups", h(async (c) => {
  const b = rec(await c.req.json());
  try {
    const group = groupMgr().createGroup({
      name: str(b["name"]),
      description: str(b["description"]),
      member_ids: arr(b["member_ids"]).map((m) => str(m)),
      discussion_mode: str(b["discussion_mode"]) || "panel_parallel",
      shared_memory: str(b["shared_memory"]) || "whiteboard",
      emoji: str(b["emoji"]) || "👥",
      color: str(b["color"]) || "#6366f1",
    }, user(c));
    return groupMgr().describeGroup(group);
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
}));

partnersFullRouter.get("/partner-groups/:group_id", h((c) => {
  const g = groupMgr().getGroup(c.req.param("group_id")!);
  if (!g) throw new HttpError(404, "Partner Group not found");
  return groupMgr().describeGroup(g);
}));

partnersFullRouter.patch("/partner-groups/:group_id", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  const changes: AnyRecord = {};
  for (const k of ["name", "description", "discussion_mode", "shared_memory", "emoji", "color"]) {
    if (b[k] !== undefined) changes[k] = b[k];
  }
  if (b["member_ids"] !== undefined) changes["member_ids"] = arr(b["member_ids"]).map((m) => str(m));
  try {
    const group = groupMgr().updateGroup(gid, changes);
    return groupMgr().describeGroup(group);
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
}));

partnersFullRouter.delete("/partner-groups/:group_id", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  groupMgr().deleteGroup(gid);
  return { deleted: true, group_id: gid };
}));

partnersFullRouter.get("/partner-groups/:group_id/history", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 200) || 200, 500));
  return groupMgr().history(gid, str(c.req.query("session_key") || "default"), limit);
}));

partnersFullRouter.get("/partner-groups/:group_id/sessions", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  return groupMgr().listSessions(gid);
}));

partnersFullRouter.post("/partner-groups/:group_id/sessions", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  return groupMgr().createSession(gid);
}));

partnersFullRouter.delete("/partner-groups/:group_id/sessions/:session_key", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const deleted = groupMgr().deleteSession(gid, c.req.param("session_key")!);
  if (!deleted) throw new HttpError(404, "Partner Group session not found");
  return { deleted: true, session_key: c.req.param("session_key")! };
}));

partnersFullRouter.get("/partner-groups/:group_id/whiteboard", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 200) || 200, 500));
  return groupMgr().whiteboard(gid, limit);
}));

partnersFullRouter.post("/partner-groups/:group_id/whiteboard/pins", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  try {
    return groupMgr().pinWhiteboard(gid, str(b["event_id"]));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) throw new HttpError(404, msg);
    throw new HttpError(409, msg);
  }
}));

partnersFullRouter.delete("/partner-groups/:group_id/whiteboard/pins/:event_id", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  if (!groupMgr().unpinWhiteboard(gid, c.req.param("event_id")!)) {
    throw new HttpError(404, "Whiteboard pin not found");
  }
  return { deleted: true, event_id: c.req.param("event_id")! };
}));

partnersFullRouter.get("/partner-groups/:group_id/invocations", h((c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 200) || 200, 500));
  return groupMgr().invocations(gid, str(c.req.query("session_key") || "default"), limit);
}));

partnersFullRouter.post("/partner-groups/:group_id/invocations", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  try {
    const inv = groupMgr().createInvocation(gid, {
      session_key: str(b["session_key"]),
      requester_partner_id: str(b["requester_partner_id"]),
      target_partner_id: str(b["target_partner_id"]),
      question: str(b["question"]),
    });
    return inv;
  } catch (e) {
    throw new HttpError(422, e instanceof Error ? e.message : String(e));
  }
}));

partnersFullRouter.post("/partner-groups/:group_id/messages", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  const content = str(b["content"]).trim();
  if (!content) throw new HttpError(422, "content is required");
  try {
    const result = await groupMgr().sendMessage(gid, {
      content,
      session_key: str(b["session_key"] || "default"),
      mentions: b["mentions"] === undefined ? null : arr(b["mentions"]).map(str),
      user: user(c),
    });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "Group message cannot be empty.") throw new HttpError(422, msg);
    throw new HttpError(422, msg);
  }
}));

partnersFullRouter.post("/partner-groups/:group_id/turns/:turn_id/partners/:partner_id/retry", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  try {
    return await groupMgr().retryPartner(gid, c.req.param("turn_id")!, c.req.param("partner_id")!, {
      session_key: str(b["session_key"] || "default"),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found") || msg.includes("no longer exists")) throw new HttpError(404, msg);
    throw new HttpError(409, msg);
  }
}));

partnersFullRouter.post("/partner-groups/:group_id/rounds/:turn_id/summary", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  try {
    return await groupMgr().summarizeRound(gid, c.req.param("turn_id")!, {
      session_key: str(b["session_key"] || "default"),
      partner_id: str(b["partner_id"]),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) throw new HttpError(404, msg);
    throw new HttpError(msg.includes("still in progress") ? 409 : 422, msg);
  }
}));

partnersFullRouter.post("/partner-groups/:group_id/invocations/:invocation_id/approve", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  try {
    return await groupMgr().approveInvocation(gid, c.req.param("invocation_id")!, {
      session_key: str(b["session_key"] || "default"),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) throw new HttpError(404, msg);
    throw new HttpError(409, msg);
  }
}));

partnersFullRouter.post("/partner-groups/:group_id/invocations/:invocation_id/reject", h(async (c) => {
  const gid = c.req.param("group_id")!;
  if (!groupMgr().getGroup(gid)) throw new HttpError(404, "Partner Group not found");
  const b = rec(await c.req.json());
  try {
    return groupMgr().rejectInvocation(gid, c.req.param("invocation_id")!, {
      session_key: str(b["session_key"] || "default"),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not found")) throw new HttpError(404, msg);
    throw new HttpError(409, msg);
  }
}));

// ════════════════════════════════════════════════════════════════
// MULTI-USER (admin/guardian surface)
// ════════════════════════════════════════════════════════════════

partnersFullRouter.get("/multi-user/admin/resources", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  return {
    models: { llm: [] },
    knowledge_bases: [],
    skills: [],
    partners: adminPartnerSummary(user(c)),
    reading_materials: [],
    reading_extensions: [],
    tools: [],
    mcp_tools: [],
  };
}));

function adminPartnerSummary(u: CurrentUser): AnyRecord[] {
  const mgr = getPartnerManager();
  return mgr
    .listPartners()
    .filter((p) => ["", ADMIN_USER.id, u.id].includes(str(p["owner_id"])))
    .map((p) => ({
      partner_id: str(p["partner_id"]),
      name: str(p["name"]) || str(p["partner_id"]),
      description: str(p["description"]),
      emoji: str(p["emoji"]),
    }));
}

partnersFullRouter.get("/multi-user/admin/books", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  return { books: [] };
}));

partnersFullRouter.get("/multi-user/guardians", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const includeRevoked = c.req.query("include_revoked") === "true";
  const users = Object.fromEntries(listUserInfo().map((x) => [str(x["id"]), x]));
  const relationships = listRelationships({ include_revoked: includeRevoked }).map((r) => ({
    ...r,
    guardian_username: str(users[str(r["guardian_user_id"])]?.["username"]),
    learner_username: str(users[str(r["learner_user_id"])]?.["username"]),
  }));
  return { relationships };
}));

partnersFullRouter.post("/multi-user/guardians", h(async (c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const b = rec(await c.req.json());
  const guardianId = str(b["guardian_user_id"]);
  const learnerId = str(b["learner_user_id"]);
  const perms = arr(b["permissions"]).map(str);
  if (!perms.length || !perms.every((p) => GUARDIAN_PERMISSIONS.has(p))) {
    throw new HttpError(422, "Unknown guardian permission");
  }
  if (!getUserById(guardianId)) throw new HttpError(404, "User not found");
  if (!getUserById(learnerId)) throw new HttpError(404, "User not found");
  try {
    const rel = authorizeGuardian(guardianId, learnerId, perms);
    logAdminAction("guardian_authorize", { target_user_id: learnerId, summary: { relationship_id: rel["id"], guardian_user_id: guardianId, permissions: rel["permissions"] } });
    const users = Object.fromEntries(listUserInfo().map((x) => [str(x["id"]), x]));
    return {
      relationship: { ...rel, guardian_username: str(users[guardianId]?.["username"]), learner_username: str(users[learnerId]?.["username"]) },
      actor_username: u.username,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HttpError(msg.includes("already authorized") ? 409 : 400, msg);
  }
}));

partnersFullRouter.delete("/multi-user/guardians/:relationship_id", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const rel = revokeGuardian(c.req.param("relationship_id")!, { revoked_by: u.id });
  if (!rel) throw new HttpError(404, "Guardian relationship not found");
  logAdminAction("guardian_revoke", { target_user_id: str(rel["learner_user_id"]), summary: { relationship_id: rel["id"], guardian_user_id: rel["guardian_user_id"] } });
  const users = Object.fromEntries(listUserInfo().map((x) => [str(x["id"]), x]));
  return {
    relationship: { ...rel, guardian_username: str(users[str(rel["guardian_user_id"])]?.["username"]), learner_username: str(users[str(rel["learner_user_id"])]?.["username"]) },
    ok: true,
  };
}));

partnersFullRouter.get("/multi-user/me/guardianships", h((c) => {
  const u = user(c);
  if (!getUserById(u.id) && u.id !== ADMIN_USER.id) throw new HttpError(404, "User not found");
  const users = Object.fromEntries(listUserInfo().map((x) => [str(x["id"]), x]));
  const relationships = listRelationships({ guardian_user_id: u.id }).map((r) => ({
    ...r,
    guardian_username: str(users[str(r["guardian_user_id"])]?.["username"]),
    learner_username: str(users[str(r["learner_user_id"])]?.["username"]),
  }));
  return { relationships };
}));

partnersFullRouter.delete("/multi-user/me/guardianships/:relationship_id", h((c) => {
  const u = user(c);
  const rel = relationshipById(c.req.param("relationship_id")!);
  if (!rel || rel["guardian_user_id"] !== u.id || rel["revoked_at"]) {
    throw new HttpError(404, "Active guardian relationship not found");
  }
  const revoked = revokeGuardian(rel["id"], { revoked_by: u.id, reason: "self_revoked" });
  logGuardianAction("guardian_self_revoke", { guardian_user_id: u.id, learner_user_id: str(rel["learner_user_id"]), summary: { relationship_id: rel["id"] } });
  const users = Object.fromEntries(listUserInfo().map((x) => [str(x["id"]), x]));
  return {
    relationship: { ...(revoked as AnyRecord), guardian_username: str(users[u.id]?.["username"]), learner_username: str(users[str(rel["learner_user_id"])]?.["username"]) },
    ok: true,
  };
}));

function requireAssignableUser(userId: string): [string, AnyRecord] {
  const found = getUserById(userId);
  if (!found) throw new HttpError(404, "User not found");
  const [username, record] = found;
  if (str(record["role"] || "user") === "admin") {
    throw new HttpError(403, "Admin users use the main workspace and cannot receive assignments.");
  }
  return [username, record];
}

function requireGuardianAccess(c: Context, learnerUserId: string, permission: string) {
  const actor = user(c);
  const [learnerUsername, learnerRecord] = requireAssignableUser(learnerUserId);
  const isAdmin = actor.is_admin;
  let actorUserId = actor.id;
  if (!isAdmin) {
    requireAssignableUser(actorUserId);
    if (!guardianCanAccess(actorUserId, learnerUserId, permission)) {
      throw new HttpError(403, "Guardian authorization required");
    }
  }
  return { learnerUsername, learnerRecord, actorUserId, isAdmin };
}

function logSupervisor(action: string, a: { learner_user_id: string } & AnyRecord, summary?: AnyRecord) {
  if (a.is_admin) logAdminAction(action, { target_user_id: a.learner_user_id, summary });
  else logGuardianAction(action, { guardian_user_id: a.actor_user_id, learner_user_id: a.learner_user_id, summary });
}

partnersFullRouter.get("/multi-user/learners/:learner_user_id/guardian-report", h((c) => {
  const learnerId = c.req.param("learner_user_id")!;
  const access = requireGuardianAccess(c, learnerId, "view_reports");
  const grant = loadGrant(learnerId);
  const permission = normalizeBookPermission(access.learnerRecord["book_permission"]);
  logSupervisor("guardian_report_view", { ...access, learner_user_id: learnerId }, { assigned_material_count: 0 });
  return {
    learner: {
      id: learnerId,
      username: access.learnerUsername,
      disabled: Boolean(access.learnerRecord["disabled"]),
    },
    book_permission: publicPermissionDict(permission),
    assigned_materials: [],
    reading: null,
    grant_summary: {
      model_count: ((grant["models"] as AnyRecord)?.["llm"] as unknown[])?.length ?? 0,
      knowledge_base_count: (grant["knowledge_bases"] as unknown[])?.length ?? 0,
      skill_count: (grant["skills"] as unknown[])?.length ?? 0,
      enabled_tools: grant["enabled_tools"] ?? null,
    },
  };
}));

partnersFullRouter.get("/multi-user/learners/:learner_user_id/materials", h((c) => {
  const learnerId = c.req.param("learner_user_id")!;
  const access = requireGuardianAccess(c, learnerId, "assign_materials");
  const permission = normalizeBookPermission(access.learnerRecord["book_permission"]);
  logSupervisor("guardian_material_catalog_view", { ...access, learner_user_id: learnerId }, { material_count: 0 });
  return { materials: [] };
}));

partnersFullRouter.put("/multi-user/learners/:learner_user_id/materials", h(async (c) => {
  const learnerId = c.req.param("learner_user_id")!;
  const access = requireGuardianAccess(c, learnerId, "assign_materials");
  const b = rec(await c.req.json());
  const bookIds = arr(b["book_ids"]).map(str).filter(Boolean);
  const [username] = [access.learnerUsername];
  const existing = normalizeBookPermission(access.learnerRecord["book_permission"]);
  const selected = new Set(bookIds);
  const permission = {
    create: existing["create"],
    default: existing["default"],
    books: Object.fromEntries(
      Object.keys((existing["books"] as AnyRecord) ?? {}).map((k) => [
        k,
        selected.has(k) ? "read" : "none",
      ]),
    ),
  };
  if (!setBookPermission(username, permission)) throw new HttpError(404, "User not found");
  const result = publicPermissionDict(permission);
  logSupervisor("guardian_material_assign", { ...access, learner_user_id: learnerId }, { book_ids: bookIds, read_only: true });
  return { book_permission: result };
}));

function guardianRestrictions(grant: AnyRecord): AnyRecord {
  const policy = grant["learning_policy"];
  if (!policy || typeof policy !== "object") {
    throw new HttpError(409, "Learner account has no learning policy");
  }
  const p = policy as AnyRecord;
  const reading = rec(p["reading"]);
  return {
    age_band: p["age_band"] ?? null,
    allow_upload: Boolean(reading["allow_upload"]),
    allowed_surfaces: (p["allowed_surfaces"] as string[]) ?? ["chat", "reading"],
    extensions: (reading["extensions"] as string[]) ?? [],
  };
}

function restrictionGrant(learnerUserId: string, learnerRecord: AnyRecord): AnyRecord {
  const grant = loadGrant(learnerUserId);
  if (grant["learning_policy"] === undefined && learnerRecord["preset"] === "learner") {
    return learnerGrant(learnerUserId);
  }
  return grant;
}

partnersFullRouter.get("/multi-user/learners/:learner_user_id/restrictions", h((c) => {
  const learnerId = c.req.param("learner_user_id")!;
  const access = requireGuardianAccess(c, learnerId, "manage_restrictions");
  const restrictions = guardianRestrictions(restrictionGrant(learnerId, access.learnerRecord));
  logSupervisor("guardian_restrictions_view", { ...access, learner_user_id: learnerId });
  return { restrictions, available_extensions: [] };
}));

partnersFullRouter.put("/multi-user/learners/:learner_user_id/restrictions", h(async (c) => {
  const learnerId = c.req.param("learner_user_id")!;
  const access = requireGuardianAccess(c, learnerId, "manage_restrictions");
  const b = rec(await c.req.json());
  const ageBand = str(b["age_band"]);
  if (!(LEARNING_AGE_BANDS as readonly string[]).includes(ageBand)) {
    throw new HttpError(422, "Unknown learning age band");
  }
  const surfaces = arr(b["allowed_surfaces"]).map(str);
  if (!surfaces.length || !surfaces.every((s) => (LEARNING_SURFACES as readonly string[]).includes(s))) {
    throw new HttpError(422, "Unknown or empty learning surface");
  }
  const extensions = arr(b["extensions"]).map(str);
  let grant = restrictionGrant(learnerId, access.learnerRecord);
  grant = JSON.parse(JSON.stringify(grant));
  let policy = grant["learning_policy"];
  if (!policy || typeof policy !== "object") {
    grant = learnerGrant(learnerId);
    policy = grant["learning_policy"];
  }
  const p = policy as AnyRecord;
  const reading = rec(p["reading"]);
  p["age_band"] = ageBand;
  p["allowed_surfaces"] = surfaces;
  reading["allow_upload"] = Boolean(b["allow_upload"]);
  reading["extensions"] = extensions;
  p["reading"] = reading;
  grant["learning_policy"] = p;
  try {
    grant = normalizeGrant(learnerId, grant);
    validateGrant(grant);
    const needsPreset = access.learnerRecord["preset"] !== "learner";
    if (needsPreset) {
      const [normalized] = saveGrantWithReceipt(learnerId, grant);
      grant = normalized;
      const presetSaved = setPreset(access.learnerUsername, "learner", learnerId);
      if (!presetSaved) {
        restoreGrantIfUnchanged(learnerId, "");
        throw new HttpError(500, "Learner preset update failed; the prior grant was restored");
      }
    } else {
      grant = saveGrant(learnerId, grant);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  const restrictions = guardianRestrictions(grant);
  logSupervisor("guardian_restrictions_set", { ...access, learner_user_id: learnerId }, restrictions);
  return { restrictions };
}));

partnersFullRouter.post("/multi-user/learners/:learner_user_id/credentials/reset", h(async (c) => {
  const learnerId = c.req.param("learner_user_id")!;
  const access = requireGuardianAccess(c, learnerId, "reset_credentials");
  const b = rec(await c.req.json());
  const newPassword = str(b["new_password"]);
  if (newPassword.length < 8 || newPassword.length > 128) {
    throw new HttpError(422, "new_password must be 8-128 characters");
  }
  const revoked = revokeDeviceCredentialsForUser(learnerId, access.actorUserId);
  if (!setPassword(access.learnerUsername, "local")) throw new HttpError(404, "User not found");
  logSupervisor("guardian_credential_reset", { ...access, learner_user_id: learnerId }, { credential_reset: true, device_credentials_revoked: revoked });
  return { ok: true, device_credentials_revoked: revoked };
}));

partnersFullRouter.get("/multi-user/users/:user_id/grants", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  requireAssignableUser(c.req.param("user_id")!);
  return { grant: loadGrant(c.req.param("user_id")!) };
}));

partnersFullRouter.put("/multi-user/users/:user_id/grants", h(async (c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const userId = c.req.param("user_id")!;
  const [, record] = requireAssignableUser(userId);
  const b = rec(await c.req.json());
  try {
    let grant = normalizeGrant(userId, rec(b["grant"]));
    if (str(record["preset"] || "standard") === "learner" && grant["learning_policy"] === undefined) {
      throw new Error("Learner accounts must retain a learning policy.");
    }
    validateGrant(grant);
    grant = saveGrant(userId, grant);
    logAdminAction("grant_set", {
      target_user_id: userId,
      summary: {
        model_count: ((grant["models"] as AnyRecord)?.["llm"] as unknown[])?.length ?? 0,
        kb_count: (grant["knowledge_bases"] as unknown[])?.length ?? 0,
        skill_count: (grant["skills"] as unknown[])?.length ?? 0,
        partner_count: (grant["partners"] as unknown[])?.length ?? 0,
        enabled_tools: grant["enabled_tools"],
        mcp_tool_count: grant["mcp_tools"] === null || grant["mcp_tools"] === undefined ? null : (grant["mcp_tools"] as unknown[])?.length ?? 0,
        exec_enabled: grant["exec_enabled"],
        learning_policy: grant["learning_policy"] ?? null,
      },
    });
    return { grant };
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}));

partnersFullRouter.get("/multi-user/users/:user_id/book-permission", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const [, record] = requireAssignableUser(c.req.param("user_id")!);
  return { permission: publicPermissionDict(normalizeBookPermission(record["book_permission"])) };
}));

partnersFullRouter.put("/multi-user/users/:user_id/book-permission", h(async (c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const userId = c.req.param("user_id")!;
  const [username] = requireAssignableUser(userId);
  const b = rec(await c.req.json());
  const books: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(b["books"]))) books[k] = str(v);
  const permission = {
    create: b["create"] !== false,
    default: ["none", "read", "edit"].includes(str(b["default"])) ? str(b["default"]) : "none",
    books,
  };
  if (!setBookPermission(username, permission)) throw new HttpError(404, "User not found");
  const result = publicPermissionDict(permission);
  logAdminAction("book_permission_set", {
    target_user_id: userId,
    summary: { create: permission.create, default: permission.default, book_count: Object.keys(books).length },
  });
  return { permission: result };
}));

partnersFullRouter.post("/multi-user/admin/skills/install", h(async (c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const b = rec(await c.req.json());
  // Skill hub installs are not ported; record the request shape upstream
  // returns on success is complex — surface a clear unsupported error.
  throw new HttpError(501, "Skill hub install is not available in this backend");
}));

partnersFullRouter.get("/multi-user/users", h((c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  return { users: listUserInfo() };
}));

// Convenience: create a non-admin user (used by guardian flows/tests).
partnersFullRouter.post("/multi-user/users", h(async (c) => {
  const u = requireAdmin(c); if (u instanceof Response) return u;
  const b = rec(await c.req.json());
  const created = createUser(str(b["username"]), { role: str(b["role"]) || "user", preset: str(b["preset"]) || "standard" });
  if (!created) throw new HttpError(409, "Username already exists");
  return { user: created };
}));

// WeChat QR onboarding — upstream runs a QR login exchange against the
// personal-WeChat protocol; kept as an explicit unsupported surface.
partnersFullRouter.post("/partners/:partner_id/channels/weixin/qr", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  throw new HttpError(501, "WeChat QR onboarding is not available in this backend");
}));

partnersFullRouter.get("/partners/:partner_id/channels/weixin/qr/:session_id", h((c) => {
  const pid = c.req.param("partner_id")!;
  const g = manageablePartner(c, pid);
  if (!g.ok) return g.res;
  throw new HttpError(501, "WeChat QR onboarding is not available in this backend");
}));

// Silence unused imports that are part of the ported surface.
void COL; void listItems; void completeText;
