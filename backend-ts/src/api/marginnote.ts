// HTTP bridge for MarginNote 4
// Add-on devices (pairing, incremental sync, heartbeat).
//
// Auth note: upstream mounts session auth on /pair, /devices, /status and
// device-token auth (`Authorization: MarginNote <id>:<token>`) on /sync and
// /heartbeat. The TS backend is auth-free, so session endpoints are open;
// device-token auth is enforced exactly as upstream.
import { Hono } from "hono";
import type { Context } from "hono";
import {
  MarginNoteStore,
  resolveDbPath,
} from "../services/marginnote4/store.js";
import { get_settings } from "../config.js";
import type { MarginNoteObject } from "../services/marginnote4/store.js";

export const marginnoteRouter = new Hono();

const MAX_SYNC_BATCH = 2000;

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

function requestedKb(c: Context): string {
  return c.req.header("x-mn4-kb") ?? "default";
}

function deviceDbPath(kbName: string): string {
  return resolveDbPath(kbName, get_settings());
}

function storeFor(c: Context): MarginNoteStore {
  return new MarginNoteStore(resolveDbPath(requestedKb(c), get_settings()));
}

function authDevice(
  c: Context,
): { device_id: string; store: MarginNoteStore } | { error: Response } {
  const authorization = c.req.header("authorization") ?? "";
  if (!authorization.startsWith("MarginNote ")) {
    return { error: httpError(c, 401, "Missing or malformed Authorization header.") };
  }
  const raw = authorization.slice("MarginNote ".length);
  const idx = raw.indexOf(":");
  if (idx < 0) {
    return { error: httpError(c, 401, "Invalid Authorization format.") };
  }
  const deviceId = raw.slice(0, idx);
  const token = raw.slice(idx + 1);
  const store = MarginNoteStore.openExisting(deviceDbPath(requestedKb(c)), get_settings());
  if (store === null || !store.verifyToken(deviceId, token)) {
    return { error: httpError(c, 403, "Invalid device credentials.") };
  }
  store.touchDevice(deviceId);
  return { device_id: deviceId, store };
}

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(v: unknown, fallback = ""): string {
  return v === undefined || v === null ? fallback : String(v);
}

// -- session-authenticated endpoints ----------------------------------------

// POST /api/marginnote4/pair
marginnoteRouter.post("/api/marginnote4/pair", async (c) => {
  const kbName = requestedKb(c);
  // Upstream refuses when pairing and sync would resolve different workspaces;
  // the TS backend has a single workspace, so the paths always agree.
  if (resolveDbPath(kbName, get_settings()) !== deviceDbPath(kbName)) {
    return httpError(
      c,
      501,
      "MN4 device sync is not available for this account yet: pairing and " +
        "sync would resolve different workspaces.",
    );
  }
  const body = await jsonBody(c);
  const store = storeFor(c);
  const [device, token] = store.pairDevice({
    device_name: str(body.device_name).slice(0, 128),
    device_kind: str(body.device_kind, "macos").slice(0, 32),
  });
  return c.json({
    device_id: device.device_id,
    token,
    device_name: device.device_name,
    device_kind: device.device_kind,
  });
});

// GET /api/marginnote4/devices
marginnoteRouter.get("/api/marginnote4/devices", (c) => {
  const store = storeFor(c);
  return c.json(
    store.listDevices().map((d) => ({
      device_id: d.device_id,
      device_name: d.device_name,
      device_kind: d.device_kind,
      paired_at: d.paired_at,
      last_seen: d.last_seen,
      active: d.active,
    })),
  );
});

// DELETE /api/marginnote4/devices/{device_id}
marginnoteRouter.delete("/api/marginnote4/devices/:device_id", (c) => {
  const store = storeFor(c);
  const deviceId = c.req.param("device_id");
  if (!store.revokeDevice(deviceId)) {
    return httpError(c, 404, `Device ${deviceId} not found.`);
  }
  return c.json({ status: "revoked", device_id: deviceId });
});

// GET /api/marginnote4/status
marginnoteRouter.get("/api/marginnote4/status", (c) => {
  const store = storeFor(c);
  return c.json({
    status: "ok",
    devices: store.listDevices().length,
    objects: store.count(),
  });
});

// -- device-token-authenticated endpoints -----------------------------------

// POST /api/marginnote4/sync
marginnoteRouter.post("/api/marginnote4/sync", async (c) => {
  const auth = authDevice(c);
  if ("error" in auth) return auth.error;
  const body = await jsonBody(c);
  const rawObjects = Array.isArray(body.objects) ? body.objects : [];
  const rawDeleted = Array.isArray(body.deleted_ids) ? body.deleted_ids : [];
  const objects: MarginNoteObject[] = rawObjects.slice(0, MAX_SYNC_BATCH).map((o) => {
    const row = (o ?? {}) as Record<string, unknown>;
    return {
      object_id: str(row.object_id),
      object_type: str(row.object_type),
      title: str(row.title),
      content: str(row.content),
      excerpt: row.excerpt === undefined || row.excerpt === null ? null : str(row.excerpt),
      document_id: row.document_id === undefined || row.document_id === null ? null : str(row.document_id),
      document_title:
        row.document_title === undefined || row.document_title === null
          ? null
          : str(row.document_title),
      page: typeof row.page === "number" ? row.page : row.page == null ? null : Number(row.page),
      tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : [],
      links: Array.isArray(row.links) ? row.links.map((t) => String(t)) : [],
      color: row.color === undefined || row.color === null ? null : str(row.color),
      created_at: str(row.created_at),
      updated_at: str(row.updated_at),
      device_id: auth.device_id,
      raw: row.raw !== null && typeof row.raw === "object" && !Array.isArray(row.raw)
        ? (row.raw as Record<string, unknown>)
        : {},
    };
  });
  const deletedIds = rawDeleted.slice(0, MAX_SYNC_BATCH).map((d) => String(d));
  const result = auth.store.ingest({
    device_id: auth.device_id,
    cursor: str(body.cursor).slice(0, 256),
    objects,
    deleted_ids: deletedIds,
  });
  return c.json({
    stored: result.stored,
    updated: result.updated,
    deleted: result.deleted,
    new_cursor: result.new_cursor,
  });
});

// POST /api/marginnote4/heartbeat
marginnoteRouter.post("/api/marginnote4/heartbeat", (c) => {
  const auth = authDevice(c);
  if ("error" in auth) return auth.error;
  return c.json({
    status: "ok",
    device_id: auth.device_id,
    object_count: auth.store.count({ device_id: auth.device_id }),
  });
});
