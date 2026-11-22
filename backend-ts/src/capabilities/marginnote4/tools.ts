// the agent-facing
// MarginNote 4 tools, plus the device-bridge management tool the TS port adds.
//
// Upstream auto-mounts seven read tools only when a synced MN4 library is the
// selected KB and injects ``_db_path`` server-side. The TS port resolves the
// library from ``marginnote4:config``.kb_name via
// ``services/marginnote4/store.resolveDbPath`` (the same per-KB store the
// device router ``src/api/marginnote.ts`` writes to), so synced objects are
// visible to both.
//
// ``marginnote_bridge`` covers the device-protocol surface upstream kept in
// the API router (pair / devices / revoke / status) against the LOCAL store,
// and — when ``base_url`` is configured — the same operations plus heartbeat
// against a remote upstream-compatible bridge over real HTTP (client.ts).

import { BaseTool, type Ctx, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import { get_settings } from "../../config.js";
import {
  ALL_TYPES,
  MarginNoteStore,
  resolveDbPath,
  type MarginNoteObject,
} from "../../services/marginnote4/store.js";
import {
  isMn4RemoteConfigured,
  isMn4RemotePaired,
  loadMn4Config,
  updateMn4Config,
} from "./settings.js";
import { Mn4BridgeClient, Mn4BridgeError } from "./client.js";

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}
function asInt(v: unknown, dflt: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
function errText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// Cache MarginNoteStore instances per resolved db path (upstream caches per
// _db_path the same way). The service store opens a short-lived connection
// per call, so a cached instance is cheap and stateless.
const _stores = new Map<string, MarginNoteStore>();

function localStore(kbName: string): MarginNoteStore {
  const path = resolveDbPath(kbName || "default");
  let store = _stores.get(path);
  if (store === undefined) {
    store = new MarginNoteStore(path);
    _stores.set(path, store);
  }
  return store;
}

function storeOrFail(): MarginNoteStore | ToolResult {
  const cfg = loadMn4Config(get_settings());
  const store = localStore(cfg.kb_name);
  if (store.count() === 0) {
    return fail(
      "No MarginNote 4 library is connected on this turn; " +
        "MarginNote tools are unavailable.",
    );
  }
  return store;
}

const TYPE_ENUM = [...ALL_TYPES].sort();

// ---------------------------------------------------------------------------
// marginnote_search
// ---------------------------------------------------------------------------

export interface MarginNoteSearchParams {
  query?: string;
  object_type?: string;
  limit?: number;
}
export const marginNoteSearchParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string", description: "Text to search for." },
    object_type: {
      type: "string",
      description:
        "Filter by type: note, excerpt, card, mindmap_node, document, comment.",
      enum: TYPE_ENUM,
    },
    limit: { type: "integer", description: "Max results (default 20)." },
  },
};

export class MarginNoteSearchTool extends BaseTool<MarginNoteSearchParams> {
  name = "marginnote_search";
  toolIcon = "🔍";
  params = marginNoteSearchParamsSchema;
  mutating = false;
  description =
    "Search the user's MarginNote 4 library for notes, excerpts, cards, or " +
    "mindmap nodes whose title or content contains the query " +
    "(case-insensitive). Returns matching objects with a short snippet. " +
    "Use this first to find where something lives.";

  async execute(p: MarginNoteSearchParams): Promise<ToolResult> {
    const store = storeOrFail();
    if (!(store instanceof MarginNoteStore)) return store;
    const query = str(p.query);
    if (!query) return fail("marginnote_search needs a non-empty 'query'.");
    try {
      const hits = store.search(query, {
        object_type: str(p.object_type),
        limit: asInt(p.limit, 20, 1, 100),
      });
      return ok(JSON.stringify({ query, count: hits.length, results: hits }));
    } catch (exc) {
      return fail(errText(exc));
    }
  }
}
export const marginnote_search = new MarginNoteSearchTool();

// ---------------------------------------------------------------------------
// marginnote_read
// ---------------------------------------------------------------------------

export interface MarginNoteReadParams { object_id?: string }
export const marginNoteReadParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["object_id"],
  properties: {
    object_id: {
      type: "string",
      description: "The MN4 object ID from a search or list result.",
    },
  },
};

export class MarginNoteReadTool extends BaseTool<MarginNoteReadParams> {
  name = "marginnote_read";
  toolIcon = "📖";
  params = marginNoteReadParamsSchema;
  mutating = false;
  description =
    "Read a single MarginNote 4 object by its ID. Returns the full object: " +
    "title, content, excerpt, tags, links, source document, and timestamps. " +
    "Use after marginnote_search or marginnote_list to drill into a " +
    "specific item.";

  async execute(p: MarginNoteReadParams): Promise<ToolResult> {
    const store = storeOrFail();
    if (!(store instanceof MarginNoteStore)) return store;
    const oid = str(p.object_id);
    if (!oid) return fail("marginnote_read needs an 'object_id'.");
    try {
      const obj = store.get(oid);
      if (obj === null) {
        return fail(`Object ${JSON.stringify(oid)} not found in the MarginNote library.`);
      }
      const full: MarginNoteObject = obj;
      return ok(JSON.stringify(full));
    } catch (exc) {
      return fail(errText(exc));
    }
  }
}
export const marginnote_read = new MarginNoteReadTool();

// ---------------------------------------------------------------------------
// marginnote_list
// ---------------------------------------------------------------------------

export interface MarginNoteListParams {
  object_type?: string;
  document_id?: string;
  limit?: number;
}
export const marginNoteListParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    object_type: {
      type: "string",
      description: "Filter: note, excerpt, card, mindmap_node.",
      enum: TYPE_ENUM,
    },
    document_id: {
      type: "string",
      description: "Restrict to one source document.",
    },
    limit: { type: "integer", description: "Max results (default 200)." },
  },
};

export class MarginNoteListTool extends BaseTool<MarginNoteListParams> {
  name = "marginnote_list";
  toolIcon = "📚";
  params = marginNoteListParamsSchema;
  mutating = false;
  description =
    "List MarginNote 4 objects, optionally filtered by type or source " +
    "document. Use to discover structure when you lack a search term.";

  async execute(p: MarginNoteListParams): Promise<ToolResult> {
    const store = storeOrFail();
    if (!(store instanceof MarginNoteStore)) return store;
    try {
      const items = store.listObjects({
        object_type: str(p.object_type),
        document_id: str(p.document_id),
        limit: asInt(p.limit, 200, 1, 1000),
      });
      return ok(JSON.stringify({ count: items.length, objects: items }));
    } catch (exc) {
      return fail(errText(exc));
    }
  }
}
export const marginnote_list = new MarginNoteListTool();

// ---------------------------------------------------------------------------
// marginnote_documents
// ---------------------------------------------------------------------------

export interface MarginNoteDocumentsParams { _unused?: never }
export const marginNoteDocumentsParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {},
};

export class MarginNoteDocumentsTool extends BaseTool<MarginNoteDocumentsParams> {
  name = "marginnote_documents";
  toolIcon = "🗂️";
  params = marginNoteDocumentsParamsSchema;
  mutating = false;
  description =
    "List all source documents (PDFs, books) in the MarginNote library with " +
    "a count of annotations, cards, and nodes each contains. Use to scope a " +
    "search to one document.";

  async execute(): Promise<ToolResult> {
    const store = storeOrFail();
    if (!(store instanceof MarginNoteStore)) return store;
    try {
      const docs = store.listDocuments();
      return ok(JSON.stringify({ count: docs.length, documents: docs }));
    } catch (exc) {
      return fail(errText(exc));
    }
  }
}
export const marginnote_documents = new MarginNoteDocumentsTool();

// ---------------------------------------------------------------------------
// marginnote_links
// ---------------------------------------------------------------------------

export interface MarginNoteLinksParams { object_id?: string }
export const marginNoteLinksParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["object_id"],
  properties: {
    object_id: {
      type: "string",
      description: "The MN4 object ID to find links for.",
    },
  },
};

export class MarginNoteLinksTool extends BaseTool<MarginNoteLinksParams> {
  name = "marginnote_links";
  toolIcon = "🔗";
  params = marginNoteLinksParamsSchema;
  mutating = false;
  description =
    "Find MarginNote objects linked TO or FROM the given object. Links " +
    "include mindmap parent/child relationships and card links. Pair with " +
    "marginnote_read to traverse the knowledge graph.";

  async execute(p: MarginNoteLinksParams): Promise<ToolResult> {
    const store = storeOrFail();
    if (!(store instanceof MarginNoteStore)) return store;
    const oid = str(p.object_id);
    if (!oid) return fail("marginnote_links needs an 'object_id'.");
    try {
      const links = store.linkedObjects(oid);
      return ok(JSON.stringify({ object_id: oid, count: links.length, links }));
    } catch (exc) {
      return fail(errText(exc));
    }
  }
}
export const marginnote_links = new MarginNoteLinksTool();

// ---------------------------------------------------------------------------
// marginnote_tags
// ---------------------------------------------------------------------------

export interface MarginNoteTagsParams { limit?: number }
export const marginNoteTagsParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", description: "Max tags (default 200)." },
  },
};

export class MarginNoteTagsTool extends BaseTool<MarginNoteTagsParams> {
  name = "marginnote_tags";
  toolIcon = "🏷️";
  params = marginNoteTagsParamsSchema;
  mutating = false;
  description =
    "List all tags used across the MarginNote library, ranked by how many " +
    "objects use each. Use to map topics before drilling in.";

  async execute(p: MarginNoteTagsParams): Promise<ToolResult> {
    const store = storeOrFail();
    if (!(store instanceof MarginNoteStore)) return store;
    try {
      const tags = store.collectTags({ limit: asInt(p.limit, 200, 1, 1000) });
      return ok(JSON.stringify({ count: tags.length, tags }));
    } catch (exc) {
      return fail(errText(exc));
    }
  }
}
export const marginnote_tags = new MarginNoteTagsTool();

// ---------------------------------------------------------------------------
// marginnote_cards
// ---------------------------------------------------------------------------

export interface MarginNoteCardsParams { limit?: number }
export const marginNoteCardsParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    limit: { type: "integer", description: "Max cards (default 100)." },
  },
};

export class MarginNoteCardsTool extends BaseTool<MarginNoteCardsParams> {
  name = "marginnote_cards";
  toolIcon = "🃏";
  params = marginNoteCardsParamsSchema;
  mutating = false;
  description =
    "List flashcards in the MarginNote library. Returns card front/back " +
    "content, tags, and source document. Use when the user asks about their " +
    "review material or wants to study.";

  async execute(p: MarginNoteCardsParams): Promise<ToolResult> {
    const store = storeOrFail();
    if (!(store instanceof MarginNoteStore)) return store;
    try {
      const cards = store.listObjects({
        object_type: "card",
        limit: asInt(p.limit, 100, 1, 500),
      });
      return ok(JSON.stringify({ count: cards.length, cards }));
    } catch (exc) {
      return fail(errText(exc));
    }
  }
}
export const marginnote_cards = new MarginNoteCardsTool();

// ---------------------------------------------------------------------------
// marginnote_bridge — device management + optional remote bridge calls.
// ---------------------------------------------------------------------------

export interface MarginNoteBridgeParams {
  action?: string;
  scope?: string;
  kb_name?: string;
  base_url?: string;
  device_name?: string;
  device_kind?: string;
  device_id?: string;
}
export const marginNoteBridgeParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["configure", "status", "pair", "devices", "revoke", "heartbeat"],
      description:
        "configure = set library selector / remote bridge address; status = " +
        "local store + remote config summary; pair = register an MN4 device " +
        "(returns its one-time token); devices = list paired devices; " +
        "revoke = deactivate a device_id; heartbeat = remote device liveness " +
        "check (requires remote pairing).",
    },
    scope: {
      type: "string",
      enum: ["local", "remote"],
      description:
        "Target for pair/devices/revoke: 'local' (default) manages devices on " +
        "this backend's synced store — what the MN4 Add-on pairs against; " +
        "'remote' calls a configured upstream-compatible bridge over HTTP.",
    },
    kb_name: {
      type: "string",
      description: "MN4 library selector for the local store (configure).",
    },
    base_url: {
      type: "string",
      description: "Remote bridge base URL, e.g. http://localhost:8000 (configure).",
    },
    device_name: {
      type: "string",
      description: "Label for the device at pairing time (pair).",
    },
    device_kind: {
      type: "string",
      description: "macos | ipados (pair).",
    },
    device_id: {
      type: "string",
      description: "Device to revoke (revoke).",
    },
  },
};

export class MarginNoteBridgeTool extends BaseTool<MarginNoteBridgeParams> {
  name = "marginnote_bridge";
  toolIcon = "🔌";
  params = marginNoteBridgeParamsSchema;
  mutating = true;
  description =
    "Manage the MarginNote 4 device bridge. scope=local (default) pairs, " +
    "lists and revokes MN4 devices on this backend's synced store — pair " +
    "returns the one-time token the MN4 Add-on needs. scope=remote performs " +
    "the same operations plus heartbeat against a configured upstream-" +
    "compatible bridge over HTTP. The seven marginnote_* read tools query " +
    "the locally synced store and need no bridge.";

  async execute(p: MarginNoteBridgeParams, _ctx?: Ctx): Promise<ToolResult> {
    const settings = get_settings();
    const action = str(p.action).toLowerCase();
    const scope = str(p.scope).toLowerCase() === "remote" ? "remote" : "local";

    if (action === "configure") {
      const patch: Parameters<typeof updateMn4Config>[1] = {};
      if (p.kb_name !== undefined) patch.kb_name = str(p.kb_name) || "default";
      if (p.base_url !== undefined) patch.base_url = str(p.base_url);
      const cfg = updateMn4Config(settings, patch);
      return ok(
        JSON.stringify({
          kb_name: cfg.kb_name,
          remote_configured: isMn4RemoteConfigured(cfg),
          remote_paired: isMn4RemotePaired(cfg),
        }),
      );
    }

    if (action === "status") {
      const cfg = loadMn4Config(settings);
      const store = localStore(cfg.kb_name);
      return ok(
        JSON.stringify({
          kb_name: cfg.kb_name,
          local: {
            devices: store.listDevices().length,
            objects: store.count(),
          },
          remote: {
            configured: isMn4RemoteConfigured(cfg),
            paired: isMn4RemotePaired(cfg),
            base_url: cfg.base_url,
          },
        }),
      );
    }

    if (scope === "remote") {
      return this._remote(settings, action, p);
    }

    // -- local device management (upstream session-side endpoints) ----------
    const cfg = loadMn4Config(settings);
    const store = localStore(cfg.kb_name);
    try {
      switch (action) {
        case "pair": {
          // services store returns a [device, token] tuple (upstream pair_device).
          const [device, token] = store.pairDevice({
            device_name: str(p.device_name),
            device_kind: str(p.device_kind) || "macos",
          });
          return ok(
            JSON.stringify({
              device_id: device.device_id,
              device_name: device.device_name ?? "",
              device_kind: device.device_kind ?? "macos",
              token,
              note: "Token is shown once — give it to the MN4 Add-on; only its hash is stored.",
            }),
          );
        }
        case "devices": {
          const devices = store.listDevices();
          return ok(JSON.stringify({ count: devices.length, devices }));
        }
        case "revoke": {
          const deviceId = str(p.device_id);
          if (!deviceId) return fail("marginnote_bridge revoke needs 'device_id'.");
          if (!store.revokeDevice(deviceId)) {
            return fail(`Device ${JSON.stringify(deviceId)} not found.`);
          }
          return ok(JSON.stringify({ status: "revoked", device_id: deviceId }));
        }
        case "heartbeat":
          return fail(
            "heartbeat is a device-auth call — use scope=remote against a " +
              "configured bridge, or the MN4 Add-on calls this backend's " +
              "/api/marginnote4/heartbeat directly.",
          );
        default:
          return fail(
            `Unknown marginnote_bridge action ${JSON.stringify(action)} — ` +
              "expected configure|status|pair|devices|revoke|heartbeat.",
          );
      }
    } catch (exc) {
      return fail(errText(exc));
    }
  }

  private async _remote(
    settings: ReturnType<typeof get_settings>,
    action: string,
    p: MarginNoteBridgeParams,
  ): Promise<ToolResult> {
    const cfg = loadMn4Config(settings);
    if (!isMn4RemoteConfigured(cfg)) {
      return fail(
        "No remote MN4 bridge configured — call marginnote_bridge with " +
          "action=configure and a base_url first.",
      );
    }
    const client = new Mn4BridgeClient(cfg);
    try {
      switch (action) {
        case "pair": {
          const paired = await client.pair(
            str(p.device_name) || "DeepTutor-TS",
            str(p.device_kind) || "macos",
          );
          updateMn4Config(settings, {
            device_id: paired.device_id,
            token: paired.token,
          });
          return ok(
            JSON.stringify({
              device_id: paired.device_id,
              device_name: paired.device_name,
              device_kind: paired.device_kind,
              note: "Remote token stored in local settings; shown once by the bridge.",
            }),
          );
        }
        case "devices": {
          const devices = await client.listDevices();
          return ok(JSON.stringify({ count: devices.length, devices }));
        }
        case "revoke": {
          const deviceId = str(p.device_id);
          if (!deviceId) return fail("marginnote_bridge revoke needs 'device_id'.");
          await client.revokeDevice(deviceId);
          if (deviceId === cfg.device_id) {
            updateMn4Config(settings, { device_id: "", token: "" });
          }
          return ok(JSON.stringify({ status: "revoked", device_id: deviceId }));
        }
        case "heartbeat": {
          if (!isMn4RemotePaired(cfg)) {
            return fail("No remote device paired — run marginnote_bridge pair with scope=remote first.");
          }
          const hb = await client.heartbeat();
          return ok(JSON.stringify(hb));
        }
        case "status":
          return ok(JSON.stringify(await client.status()));
        default:
          return fail(
            `Unknown remote marginnote_bridge action ${JSON.stringify(action)}.`,
          );
      }
    } catch (exc) {
      if (exc instanceof Mn4BridgeError) {
        return fail(`MN4 bridge error (${exc.status}): ${exc.message}`);
      }
      return fail(errText(exc));
    }
  }
}
export const marginnote_bridge = new MarginNoteBridgeTool();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MARGINNOTE_TOOL_NAMES = [
  "marginnote_search",
  "marginnote_read",
  "marginnote_list",
  "marginnote_documents",
  "marginnote_links",
  "marginnote_tags",
  "marginnote_cards",
  "marginnote_bridge",
] as const;

export const MARGINNOTE_TOOLS = [
  marginnote_search,
  marginnote_read,
  marginnote_list,
  marginnote_documents,
  marginnote_links,
  marginnote_tags,
  marginnote_cards,
  marginnote_bridge,
];
