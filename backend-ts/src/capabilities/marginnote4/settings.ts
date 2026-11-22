// MarginNote 4 capability settings — persisted in the shared sqlite kv table
// (store/database.ts get_state/put_state), key "marginnote4:config".
//
// Two config groups:
//   * ``kb_name`` — which connected MN4 library (``type: marginnote4`` KB /
//     X-MN4-KB selector upstream) the read tools query. The store itself is
//     resolved per-library by ``services/marginnote4/store.resolveDbPath``.
//   * ``base_url`` (+ optional remote ``device_id``/``token``) — an optional
//     remote upstream-compatible MN4 bridge the ``marginnote_bridge`` tool can
//     call over real HTTP (client.ts). Empty = local-only mode.
//
// The remote plaintext token is stored here because this backend acts as the
// MN4 client; upstream keeps only a hash server-side — a documented
// deviation (no session-auth pairing UI exists in the TS port yet).

import type { Settings } from "../../config.js";
import { get_state, put_state } from "../../store/database.js";

export interface Mn4Config {
  /** KB/library selector for the local synced store (upstream X-MN4-KB / kb name). */
  kb_name: string;
  /** Base URL of a remote MN4 bridge, e.g. "http://localhost:8000". Empty = unconfigured. */
  base_url: string;
  /** Remote device credential (filled by remote_pair). */
  device_id: string;
  token: string;
}

const CONFIG_KEY = "marginnote4:config";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function emptyMn4Config(): Mn4Config {
  return { kb_name: "default", base_url: "", device_id: "", token: "" };
}

export function loadMn4Config(settings: Settings): Mn4Config {
  const cfg = emptyMn4Config();
  const raw = get_state<unknown>(settings, CONFIG_KEY);
  if (!isRecord(raw)) return cfg;
  for (const key of Object.keys(cfg) as (keyof Mn4Config)[]) {
    const v = raw[key];
    if (typeof v === "string") cfg[key] = v;
  }
  return cfg;
}

export function saveMn4Config(settings: Settings, cfg: Mn4Config): void {
  put_state(settings, CONFIG_KEY, { ...cfg });
}

export function updateMn4Config(
  settings: Settings,
  patch: Partial<Mn4Config>,
): Mn4Config {
  const cfg = { ...loadMn4Config(settings), ...patch };
  saveMn4Config(settings, cfg);
  return cfg;
}

/** True when a remote bridge address is set. */
export function isMn4RemoteConfigured(cfg: Mn4Config): boolean {
  return cfg.base_url.trim().length > 0;
}

/** True when a remote device credential exists. */
export function isMn4RemotePaired(cfg: Mn4Config): boolean {
  return cfg.device_id.trim().length > 0 && cfg.token.trim().length > 0;
}
