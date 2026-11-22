// Port of deeptutor/multi_user/session_handoff.py — security state for
// private-to-public session handoff.
//
// Pairing codes and tickets are represented only by SHA-256 fingerprints in
// SQLite. A short-lived JWE carries the credential between the two public
// POST calls, so the database never contains a plaintext bearer token.
//
// TS port notes:
//  - Upstream keeps a dedicated ``session_handoff.sqlite3`` under AUTH_DIR and
//    encrypts tickets with python-jose (JWE dir + A256GCM). Here the records
//    live in the shared Praxis database (own tables, created lazily) and the
//    JWE is implemented directly on node:crypto — same compact serialization:
//    ``b64(header)."".b64(iv).b64(ct).b64(tag)`` with alg=dir, enc=A256GCM and
//    CEK = SHA-256(secret).
//  - The auth secret upstream comes from multi_user.identity; here it is a
//    random 32-byte secret persisted once in the kv store under
//    ``handoff/auth_secret``.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getDb, query, queryOne, run, tx } from "../../shared/db.js";
import { get_settings } from "../../config.js";
import { get_state, put_state } from "../../store/database.js";

export const CODE_LIFETIME_SECONDS = 300;
export const TICKET_LIFETIME_SECONDS = 120;
export const MAX_CODE_ATTEMPTS = 5;
export const CREATE_RATE_LIMIT: [number, number] = [5, 60];
export const STATE_RETENTION_SECONDS = 600;

export class HandoffError extends Error {}
export class HandoffRejected extends HandoffError {}
export class HandoffRateLimited extends HandoffError {}

export interface HandoffRecord {
  code: string;
  ticket: string;
  public_origin: string;
  expires_at: number;
}

// ---------------------------------------------------------------------------
// Host / origin canonicalization
// ---------------------------------------------------------------------------

function _normalized_hostname(hostname: string): string {
  if (!hostname || hostname.length > 253) throw new HandoffError("Invalid host");
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(hostname)) throw new HandoffError("Invalid host");
  return hostname.replace(/\.+$/, "").toLowerCase();
}

function _is_ip_literal(host: string): boolean {
  // IPv4 dotted quad or [v6] already bracketed by URL parsing.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

export function canonical_host(value: string, default_port: number | null = null): string {
  const raw = value.trim();
  if (!raw || raw.includes("/") || raw.includes("?") || raw.includes("#") || raw.includes("@")) {
    throw new HandoffError("Invalid host");
  }
  // urlsplit("//" + raw): strip a leading "//" if the caller included it.
  const stripped = raw.replace(/^\/+/, "");
  let hostname = "";
  let port: number | null = null;
  try {
    // Manual parse: [v6]:port or host:port or host.
    if (stripped.startsWith("[")) {
      const end = stripped.indexOf("]");
      if (end === -1) throw new Error("bad");
      hostname = stripped.slice(1, end);
      const rest = stripped.slice(end + 1);
      if (rest.startsWith(":")) port = Number(rest.slice(1)) || null;
      else if (rest) throw new Error("bad");
    } else {
      const idx = stripped.lastIndexOf(":");
      if (idx !== -1 && /^\d+$/.test(stripped.slice(idx + 1))) {
        hostname = stripped.slice(0, idx);
        port = Number(stripped.slice(idx + 1));
      } else {
        hostname = stripped;
      }
    }
    if (!hostname) throw new Error("bad");
    if (port !== null && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new Error("bad port");
    }
  } catch {
    throw new HandoffError("Invalid host");
  }
  let host = _normalized_hostname(hostname);
  if (_is_ip_literal(host)) {
    // keep as-is (upstream str(ip_address(host)) canonicalizes; close enough —
    // IPv6 canonicalization differences are cosmetic for equality checks
    // because both sides go through this function).
  } else {
    // IDNA encode (punycode) like upstream's host.encode("idna").
    try {
      host = new URL(`http://${host}`).hostname.toLowerCase();
    } catch {
      throw new HandoffError("Invalid host");
    }
  }
  if (port === null) port = default_port;
  if (port !== null && port !== default_port) {
    host = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  }
  return host;
}

export function is_loopback_host(host: string): boolean {
  let h = host;
  if (h.startsWith("[")) h = h.split("]", 1)[0].slice(1);
  else if (h.split(":").length === 2) h = h.split(":", 1)[0];
  if (h === "localhost") return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split(".").map(Number);
    return parts[0] === 127 || parts[0] === 0;
  }
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  return false;
}

export function public_origin(value: string): string {
  const raw = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HandoffError("Public origin must use HTTPS");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new HandoffError("Public origin must use HTTPS");
  }
  if (
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new HandoffError("Public origin must not contain a path or credentials");
  }
  const port = parsed.port ? Number(parsed.port) : null;
  const host = canonical_host(parsed.host, 443);
  if (is_loopback_host(host)) {
    throw new HandoffError("Public origin cannot be loopback");
  }
  if (!_is_ip_literal(host.split(":")[0].replace(/^\[|\]$/g, ""))) {
    if (!host.includes(".")) throw new HandoffError("Public origin hostname is invalid");
  }
  // upstream returns urlunsplit(("https", host, "", "", "")) — port 443 is
  // implicit and dropped by canonical_host already.
  return `https://${host}`;
}

// ---------------------------------------------------------------------------
// Hashing + JWE (dir / A256GCM)
// ---------------------------------------------------------------------------

export function hash_secret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const _SECRET_KEY = "handoff/auth_secret";

function _auth_secret(): string {
  const existing = get_state<string>(get_settings(), _SECRET_KEY);
  if (typeof existing === "string" && existing) return existing;
  const fresh = randomBytes(32).toString("hex");
  put_state(get_settings(), _SECRET_KEY, fresh);
  return fresh;
}

function _jwe_key(): Buffer {
  return createHash("sha256").update(_auth_secret(), "utf8").digest();
}

const _b64u = (buf: Buffer | string): string =>
  Buffer.from(buf as never).toString("base64url");

/** JWE compact serialization, alg=dir enc=A256GCM (python-jose compatible). */
export function encrypt_ticket_payload(payload: Record<string, unknown>): string {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  try {
    const protectedHeader = _b64u(JSON.stringify({ alg: "dir", enc: "A256GCM" }));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", _jwe_key(), iv);
    cipher.setAAD(Buffer.from(protectedHeader, "ascii"));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [protectedHeader, "", _b64u(iv), _b64u(ciphertext), _b64u(tag)].join(".");
  } catch {
    throw new HandoffError("Could not protect the handoff ticket");
  }
}

export function decrypt_ticket_payload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length !== 5) throw new Error("bad jwe");
    const [headerB64, , ivB64, ctB64, tagB64] = parts;
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as Record<string, unknown>;
    if (header["alg"] !== "dir" || header["enc"] !== "A256GCM") throw new Error("bad alg");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      _jwe_key(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAAD(Buffer.from(headerB64, "ascii"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]);
    const payload: unknown = JSON.parse(plaintext.toString("utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("bad payload");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new HandoffRejected("Invalid handoff ticket");
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let _tablesReady = false;
function _ensure_tables(): void {
  if (_tablesReady) return;
  getDb().exec(`
CREATE TABLE IF NOT EXISTS handoff_records (
    code_hash TEXT PRIMARY KEY,
    ticket_hash TEXT NOT NULL UNIQUE,
    encrypted_ticket TEXT NOT NULL,
    public_host TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    code_consumed_at INTEGER,
    ticket_consumed_at INTEGER,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS handoff_expiry_idx ON handoff_records(expires_at);
CREATE TABLE IF NOT EXISTS handoff_rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
);
`);
  _tablesReady = true;
}

function _cleanup(now: number): void {
  run(
    "DELETE FROM handoff_records WHERE expires_at + ? < ?",
    STATE_RETENTION_SECONDS,
    now,
  );
  run("DELETE FROM handoff_rate_limits WHERE window_start + 3600 < ?", now);
}

function _check_rate(bucket: string, limit: [number, number], now: number): void {
  const [count, windowSeconds] = limit;
  const windowStart = now - (now % windowSeconds);
  tx(() => {
    run(
      `INSERT INTO handoff_rate_limits(bucket, window_start, count)
       VALUES (?, ?, 0)
       ON CONFLICT(bucket) DO UPDATE SET
           window_start=excluded.window_start,
           count=CASE
               WHEN handoff_rate_limits.window_start != excluded.window_start
               THEN 0 ELSE handoff_rate_limits.count
           END`,
      bucket,
      windowStart,
    );
    run(
      "UPDATE handoff_rate_limits SET count=count+1 WHERE bucket=?",
      bucket,
    );
  });
  const row = queryOne<{ count: number }>(
    "SELECT count FROM handoff_rate_limits WHERE bucket=?",
    bucket,
  );
  if (row && Number(row.count) > count) {
    throw new HandoffRateLimited("Too many handoff requests");
  }
}

export class SessionHandoffStore {
  create(opts: {
    encrypted_ticket: string;
    ticket_hash: string;
    public_host: string;
    now?: number;
    code_lifetime?: number;
    rate_key?: string;
  }): HandoffRecord {
    const now = Math.trunc(opts.now ?? Date.now() / 1000);
    this._rate_limit(`create:${opts.rate_key ?? "unknown"}`, CREATE_RATE_LIMIT, now);
    const code = randomBytes(32).toString("base64url");
    const expiresAt = now + (opts.code_lifetime ?? CODE_LIFETIME_SECONDS);
    _ensure_tables();
    tx(() => {
      _cleanup(now);
      run(
        `INSERT INTO handoff_records(
            code_hash, ticket_hash, encrypted_ticket, public_host,
            expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        hash_secret(code),
        opts.ticket_hash,
        opts.encrypted_ticket,
        opts.public_host,
        expiresAt,
        now,
      );
    });
    return {
      code,
      ticket: opts.encrypted_ticket,
      public_origin: opts.public_host,
      expires_at: expiresAt,
    };
  }

  exchange(opts: { code: string; public_host: string; now?: number }): string {
    const now = Math.trunc(opts.now ?? Date.now() / 1000);
    const codeHash = hash_secret(opts.code);
    _ensure_tables();
    let freshTicket = "";
    tx(() => {
      _cleanup(now);
      const row = queryOne<Record<string, unknown>>(
        `SELECT encrypted_ticket, public_host, expires_at,
                code_consumed_at, failed_attempts
           FROM handoff_records WHERE code_hash=?`,
        codeHash,
      );
      if (row === undefined) throw new HandoffRejected("Invalid pairing code");
      if (row["code_consumed_at"] !== null && row["code_consumed_at"] !== undefined) {
        throw new HandoffRejected("Invalid pairing code");
      }
      if (Number(row["expires_at"]) <= now) {
        run("DELETE FROM handoff_records WHERE code_hash=?", codeHash);
        throw new HandoffRejected("Invalid pairing code");
      }
      if (row["public_host"] !== opts.public_host) {
        const attempts = Number(row["failed_attempts"] ?? 0) + 1;
        if (attempts >= MAX_CODE_ATTEMPTS) {
          run("DELETE FROM handoff_records WHERE code_hash=?", codeHash);
        } else {
          run(
            "UPDATE handoff_records SET failed_attempts=? WHERE code_hash=?",
            attempts,
            codeHash,
          );
        }
        throw new HandoffRejected("Pairing code is not valid for this site");
      }
      const claims = decrypt_ticket_payload(String(row["encrypted_ticket"]));
      claims["exp"] = now + TICKET_LIFETIME_SECONDS;
      const ticket = encrypt_ticket_payload(claims);
      freshTicket = ticket;
      run(
        `UPDATE handoff_records
            SET code_consumed_at=?, failed_attempts=0,
                encrypted_ticket=?, ticket_hash=?
          WHERE code_hash=? AND code_consumed_at IS NULL`,
        now,
        ticket,
        hash_secret(ticket),
        codeHash,
      );
    });
    return freshTicket;
  }

  consume_ticket(opts: { ticket: string; public_host: string; now?: number }): string {
    const now = Math.trunc(opts.now ?? Date.now() / 1000);
    const ticketHash = hash_secret(opts.ticket);
    _ensure_tables();
    tx(() => {
      _cleanup(now);
      const row = queryOne<Record<string, unknown>>(
        `SELECT encrypted_ticket, public_host, expires_at,
                ticket_consumed_at, code_consumed_at
           FROM handoff_records WHERE ticket_hash=?`,
        ticketHash,
      );
      if (
        row === undefined ||
        row["ticket_consumed_at"] !== null ||
        row["code_consumed_at"] === null ||
        row["code_consumed_at"] === undefined ||
        Number(row["code_consumed_at"]) + TICKET_LIFETIME_SECONDS <= now
      ) {
        if (row !== undefined) {
          run("DELETE FROM handoff_records WHERE ticket_hash=?", ticketHash);
        }
        throw new HandoffRejected("Invalid handoff ticket");
      }
      if (row["public_host"] !== opts.public_host) {
        throw new HandoffRejected("Handoff ticket is not valid for this site");
      }
      if (String(row["encrypted_ticket"]) !== opts.ticket) {
        throw new HandoffRejected("Invalid handoff ticket");
      }
      run(
        `UPDATE handoff_records
            SET ticket_consumed_at=?
          WHERE ticket_hash=? AND ticket_consumed_at IS NULL`,
        now,
        ticketHash,
      );
    });
    return opts.ticket;
  }

  private _rate_limit(bucket: string, limit: [number, number], now: number): void {
    _ensure_tables();
    _check_rate(bucket, limit, now);
  }
}

let _DEFAULT_STORE: SessionHandoffStore | null = null;

export function get_session_handoff_store(): SessionHandoffStore {
  if (_DEFAULT_STORE === null) _DEFAULT_STORE = new SessionHandoffStore();
  return _DEFAULT_STORE;
}

export function reset_session_handoff_store_for_tests(): void {
  _DEFAULT_STORE = null;
}
