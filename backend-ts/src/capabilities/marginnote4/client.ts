// HTTP client for the MarginNote 4 device bridge.
//
// Upstream the MN4 Add-on is the *caller* and DeepTutor the server; this TS
// backend has no MN4 routes yet (src/api is out of scope), so the client lets
// the capability act as a conforming peer: it can pair a device identity,
// heartbeat, list/revoke devices and read bridge status against any endpoint
// that implements the upstream protocol (another DeepTutor instance, or this
// backend once ``server.ts`` is mounted).
//
// Wire details mirrored from upstream:
//   * every request carries ``X-MN4-KB: <kb_name>`` (library selector);
//   * device-authenticated calls send ``Authorization: MarginNote <id>:<token>``;
//   * pairing is ``POST /api/marginnote4/pair`` with
//     ``{device_name, device_kind}`` → ``{device_id, token, ...}`` (token once);
//   * sync is ``POST /api/marginnote4/sync`` with
//     ``{cursor, objects[], deleted_ids[]}`` → ``{stored, updated, deleted, new_cursor}``;
//   * heartbeat is ``POST /api/marginnote4/heartbeat`` →
//     ``{status, device_id, object_count}``;
//   * session-side calls are ``GET /devices``, ``DELETE /devices/{id}``,
//     ``GET /status``.

import type { Mn4Config } from "./settings.js";

const MN4_TIMEOUT_MS = 15_000;
// Upstream MAX_SYNC_BATCH — one batch, not one library.
export const MAX_SYNC_BATCH = 2000;

export interface Mn4DeviceInfo {
  device_id: string;
  device_name: string;
  device_kind: string;
  paired_at: string;
  last_seen: string;
  active: boolean;
}

export interface Mn4PairResponse {
  device_id: string;
  token: string;
  device_name: string;
  device_kind: string;
}

export interface Mn4SyncResponse {
  stored: number;
  updated: number;
  deleted: number;
  new_cursor: string;
}

export interface Mn4HeartbeatResponse {
  status: string;
  device_id: string;
  object_count: number;
}

export interface Mn4StatusResponse {
  status: string;
  devices: number;
  objects: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export class Mn4BridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Mn4BridgeClient {
  private readonly baseUrl: string;
  private readonly kbName: string;
  private readonly deviceId: string;
  private readonly token: string;

  constructor(cfg: Mn4Config) {
    // Normalise: accept "http://host:8000" or "http://host:8000/api/marginnote4".
    let base = cfg.base_url.trim().replace(/\/+$/, "");
    if (base.endsWith("/api/marginnote4")) {
      base = base.slice(0, -"/api/marginnote4".length);
    }
    this.baseUrl = base;
    this.kbName = cfg.kb_name.trim() || "default";
    this.deviceId = cfg.device_id.trim();
    this.token = cfg.token.trim();
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/marginnote4${path}`;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; deviceAuth?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-MN4-KB": this.kbName,
    };
    if (opts.deviceAuth) {
      if (!this.deviceId || !this.token) {
        throw new Mn4BridgeError(0, "No paired device credential — run marginnote_pair first.");
      }
      headers["Authorization"] = `MarginNote ${this.deviceId}:${this.token}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MN4_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (exc) {
      const msg =
        exc instanceof Error && exc.name === "AbortError"
          ? `MN4 bridge timed out after ${MN4_TIMEOUT_MS}ms`
          : `MN4 bridge unreachable: ${exc instanceof Error ? exc.message : String(exc)}`;
      throw new Mn4BridgeError(0, msg);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const detail =
        isRecord(data) && typeof data["detail"] === "string"
          ? (data["detail"] as string)
          : typeof data === "string"
            ? data
            : res.statusText || `HTTP ${res.status}`;
      throw new Mn4BridgeError(res.status, detail);
    }
    return data;
  }

  /** POST /pair — register this backend as an MN4 device; returns the one-time token. */
  async pair(deviceName = "", deviceKind = "macos"): Promise<Mn4PairResponse> {
    const data = await this.request("POST", "/pair", {
      body: { device_name: deviceName, device_kind: deviceKind },
    });
    if (!isRecord(data)) throw new Mn4BridgeError(0, "Malformed /pair response");
    return {
      device_id: String(data["device_id"] ?? ""),
      token: String(data["token"] ?? ""),
      device_name: String(data["device_name"] ?? ""),
      device_kind: String(data["device_kind"] ?? ""),
    };
  }

  /** GET /devices — session-side device list. */
  async listDevices(): Promise<Mn4DeviceInfo[]> {
    const data = await this.request("GET", "/devices");
    if (!Array.isArray(data)) return [];
    return data.filter(isRecord).map((d) => ({
      device_id: String(d["device_id"] ?? ""),
      device_name: String(d["device_name"] ?? ""),
      device_kind: String(d["device_kind"] ?? ""),
      paired_at: String(d["paired_at"] ?? ""),
      last_seen: String(d["last_seen"] ?? ""),
      active: Boolean(d["active"]),
    }));
  }

  /** DELETE /devices/{id} — revoke a paired device. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.request("DELETE", `/devices/${encodeURIComponent(deviceId)}`);
  }

  /** GET /status — bridge health + counts. */
  async status(): Promise<Mn4StatusResponse> {
    const data = await this.request("GET", "/status");
    if (!isRecord(data)) throw new Mn4BridgeError(0, "Malformed /status response");
    return {
      status: String(data["status"] ?? ""),
      devices: Number(data["devices"] ?? 0),
      objects: Number(data["objects"] ?? 0),
    };
  }

  /** POST /sync — push an incremental batch (device-token auth). */
  async sync(batch: {
    cursor?: string;
    objects?: unknown[];
    deleted_ids?: string[];
  }): Promise<Mn4SyncResponse> {
    const data = await this.request("POST", "/sync", {
      deviceAuth: true,
      body: {
        cursor: batch.cursor ?? "",
        objects: (batch.objects ?? []).slice(0, MAX_SYNC_BATCH),
        deleted_ids: (batch.deleted_ids ?? []).slice(0, MAX_SYNC_BATCH),
      },
    });
    if (!isRecord(data)) throw new Mn4BridgeError(0, "Malformed /sync response");
    return {
      stored: Number(data["stored"] ?? 0),
      updated: Number(data["updated"] ?? 0),
      deleted: Number(data["deleted"] ?? 0),
      new_cursor: String(data["new_cursor"] ?? ""),
    };
  }

  /** POST /heartbeat — device-token liveness check. */
  async heartbeat(): Promise<Mn4HeartbeatResponse> {
    const data = await this.request("POST", "/heartbeat", { deviceAuth: true });
    if (!isRecord(data)) throw new Mn4BridgeError(0, "Malformed /heartbeat response");
    return {
      status: String(data["status"] ?? ""),
      device_id: String(data["device_id"] ?? ""),
      object_count: Number(data["object_count"] ?? 0),
    };
  }
}
