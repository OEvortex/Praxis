// private-to-public session
// handoff. Pairing codes and tickets are stored only as SHA-256 fingerprints
// in a dedicated SQLite DB; a short-lived JWE (dir + A256GCM) carries the
// credential between the two public POST calls.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authDir, loadOrCreateAuthSecret } from "./identity.js";

export const CODE_LIFETIME_SECONDS = 300;
export const TICKET_LIFETIME_SECONDS = 120;
export const MAX_CODE_ATTEMPTS = 5;
export const CREATE_RATE_LIMIT: [number, number] = [5, 60];
export const STATE_RETENTION_SECONDS = 600;

const DB_FILENAME = "session_handoff.sqlite3";

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

function normalizedHostname(hostname: string): string {
  if (!hostname || hostname.length > 253) throw new HandoffError("Invalid host");
  if ([...hostname].some((ch) => /\s/.test(ch) || ch.charCodeAt(0) < 0x20 || ch === "\x7f")) {
    throw new HandoffError("Invalid host");
  }
  return hostname.replace(/\.+$/, "").toLowerCase();
}

// Expand an IPv6 literal to 8 hextets (handles "::" and embedded IPv4).
function expandIPv6(input: string): number[] | null {
  let addr = input.toLowerCase();
  // strip zone id
  const zi = addr.indexOf("%");
  if (zi >= 0) addr = addr.slice(0, zi);
  // embedded IPv4 tail
  const v4Match = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const parts = v4Match[1].split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    const hi = ((parts[0] << 8) | parts[1]).toString(16);
    const lo = ((parts[2] << 8) | parts[3]).toString(16);
    addr = `${addr.slice(0, addr.length - v4Match[1].length)}${hi}:${lo}`;
  }
  if (!/^[0-9a-f:.]+$/.test(addr)) return null;
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]);
  const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  let groups: number[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  }
  if (groups.length !== 8) return null;
  return groups;
}

function canonicalIPv6(input: string): string | null {
  const groups = expandIPv6(input);
  if (groups === null) return null;
  const hextets = groups.map((g) => g.toString(16));
  // RFC 5952: longest run of zero hextets (len>=2), leftmost wins.
  let bestStart = -1;
  let bestLen = 0;
  let i = 0;
  while (i < 8) {
    if (hextets[i] === "0") {
      let j = i;
      while (j < 8 && hextets[j] === "0") j += 1;
      if (j - i > bestLen) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    } else {
      i += 1;
    }
  }
  if (bestLen < 2) bestStart = -1;
  const left = hextets.slice(0, bestStart === -1 ? 8 : bestStart);
  const right = bestStart === -1 ? [] : hextets.slice(bestStart + bestLen);
  const mid = bestStart === -1 ? [] : ["", ""];
  const out = [...left, ...mid, ...right].join(":");
  // collapse a leading "::" correctly: join already yields e.g. "::1"
  return out === "" ? "::" : out;
}

function canonicalIP(host: string): string | null {
  const kind = isIP(host);
  if (kind === 4) {
    const parts = host.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    return parts.join(".");
  }
  if (kind === 6) return canonicalIPv6(host);
  return null;
}

export function canonicalHost(value: string, defaultPort: number | null = null): string {
  const raw = value.trim();
  if (!raw || raw.includes("/") || raw.includes("?") || raw.includes("#") || raw.includes("@")) {
    throw new HandoffError("Invalid host");
  }
  // Parse "//host[:port]" like urlsplit — extract hostname/port manually to
  // mirror urlsplit's rules (bracketed IPv6, optional port).
  let hostPart = raw;
  let port: number | null = null;
  if (hostPart.startsWith("[")) {
    const end = hostPart.indexOf("]");
    if (end < 0) throw new HandoffError("Invalid host");
    const inner = hostPart.slice(1, end);
    const rest = hostPart.slice(end + 1);
    if (rest !== "" && !rest.startsWith(":")) throw new HandoffError("Invalid host");
    if (rest.startsWith(":")) {
      const p = rest.slice(1);
      if (!/^\d+$/.test(p)) throw new HandoffError("Invalid host");
      port = Number(p);
      if (port > 65535) throw new HandoffError("Invalid host");
    }
    hostPart = `[${inner}]`;
    var hostname = inner;
  } else {
    const idx = hostPart.lastIndexOf(":");
    if (idx >= 0) {
      const maybePort = hostPart.slice(idx + 1);
      if (/^\d+$/.test(maybePort)) {
        port = Number(maybePort);
        if (port > 65535) throw new HandoffError("Invalid host");
        hostPart = hostPart.slice(0, idx);
      }
    }
    var hostname = hostPart;
  }
  if (hostname === undefined || hostname === "") throw new HandoffError("Invalid host");
  let host = normalizedHostname(hostname);
  const ipHost = canonicalIP(host);
  if (ipHost !== null) {
    host = ipHost;
  } else {
    // IDNA — Node's URL does this for us; approximate with punycode via URL.
    try {
      host = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      throw new HandoffError("Invalid host");
    }
  }
  if (port === null) port = defaultPort;
  if (port !== null && port !== defaultPort) {
    host = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  }
  return host;
}

function ipv4Global(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => p > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 + 192.0.2.0/24 covered by b check below
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51) return false;
  if (a === 203 && b === 0) return false;
  if (a >= 224) return false;
  return true;
}

function ipv6Global(host: string): boolean {
  const groups = expandIPv6(host);
  if (groups === null) return false;
  const isZero = groups.every((g) => g === 0);
  if (isZero) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  // fc00::/7 (ULA) and fe80::/10 (link-local), plus documentation/teredo etc.
  const first = groups[0];
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (first === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  return true;
}

export function isLoopbackHost(host: string): boolean {
  let h = host;
  if (h.startsWith("[")) {
    h = h.slice(1, h.indexOf("]") >= 0 ? h.indexOf("]") : undefined);
  } else if (h.split(":").length === 2 && !h.includes("[")) {
    // host:port with a non-IPv6 host — strip the port for the IP check
    const idx = h.lastIndexOf(":");
    const tail = h.slice(idx + 1);
    if (/^\d+$/.test(tail)) h = h.slice(0, idx);
  }
  const kind = isIP(h);
  if (kind === 4) {
    const parts = h.split(".").map(Number);
    return parts[0] === 127;
  }
  if (kind === 6) {
    const groups = expandIPv6(h);
    if (groups === null) return false;
    return groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
  }
  return h === "localhost";
}

export function publicOrigin(value: string): string {
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
  // Rebuild netloc without userinfo for canonical_host.
  const netloc = parsed.host;
  let port: number | null = null;
  try {
    port = parsed.port === "" ? null : Number(parsed.port);
  } catch {
    port = null;
  }
  if (parsed.port === "" && raw.includes(":443")) {
    // explicit :443 — urlsplit keeps it in netloc; canonical_host strips it
    // because it equals the default port.
  }
  const host = canonicalHost(netloc, 443);
  if (isLoopbackHost(host)) {
    throw new HandoffError("Public origin cannot be loopback");
  }
  const bare = host.replace(/^\[|\].*$/g, (m) => (m.startsWith("[") ? "" : m));
  const ipBare = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  if (isIP(ipBare) !== 0) {
    const global = isIP(ipBare) === 4 ? ipv4Global(ipBare) : ipv6Global(ipBare);
    if (!global) throw new HandoffError("Public origin must use a public address");
  } else {
    if (!host.includes(".")) {
      throw new HandoffError("Public origin hostname is invalid");
    }
  }
  void bare;
  void port;
  return `https://${host}`;
}

export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf-8").digest("hex");
}

// ---------------------------------------------------------------------------
// JWE (dir + A256GCM), compact serialization — jose-compatible enough for our
// own encrypt/decrypt pair.
// ---------------------------------------------------------------------------

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function jweKey(secret?: string): Buffer {
  const material = secret ?? loadOrCreateAuthSecret();
  if (!material) throw new HandoffError("Handoff encryption key is unavailable");
  return createHash("sha256").update(material, "utf-8").digest();
}

export function encryptTicketPayload(payload: Record<string, unknown>, secret?: string): string {
  const plaintext = Buffer.from(JSON.stringify(sortKeys(payload)), "utf-8");
  try {
    const protectedHeader = b64url(JSON.stringify({ alg: "dir", enc: "A256GCM" }));
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", jweKey(secret), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [protectedHeader, "", b64url(iv), b64url(ciphertext), b64url(tag)].join(".");
  } catch {
    throw new HandoffError("Could not protect the handoff ticket");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function decryptTicketPayload(token: string, secret?: string): Record<string, unknown> {
  let payload: unknown;
  try {
    const parts = token.split(".");
    if (parts.length !== 5) throw new Error("bad parts");
    const [protectedB64, , ivB64, ctB64, tagB64] = parts;
    const header = JSON.parse(Buffer.from(protectedB64, "base64url").toString("utf-8"));
    if (header["alg"] !== "dir" || header["enc"] !== "A256GCM") throw new Error("bad header");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      jweKey(secret),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]);
    payload = JSON.parse(plaintext.toString("utf-8"));
  } catch {
    throw new HandoffRejected("Invalid handoff ticket");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HandoffRejected("Invalid handoff ticket");
  }
  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SQLite-backed store
// ---------------------------------------------------------------------------

function dbPath(): string {
  return join(authDir(), DB_FILENAME);
}

export class SessionHandoffStore {
  private db: DatabaseSync | null = null;

  private connect(): DatabaseSync {
    if (this.db) return this.db;
    const path = dbPath();
    const parentExisted = existsSync(dirname(path));
    mkdirSync(dirname(path), { recursive: true });
    if (!parentExisted) {
      try {
        chmodSync(dirname(path), 0o700);
      } catch {
        // best-effort
      }
    }
    const connection = new DatabaseSync(path);
    connection.exec("PRAGMA journal_mode=WAL");
    connection.exec("PRAGMA synchronous=FULL");
    connection.exec("PRAGMA busy_timeout=10000");
    this.initialize(connection);
    return connection;
  }

  private initialize(connection: DatabaseSync): void {
    connection.exec(`
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
      CREATE INDEX IF NOT EXISTS handoff_expiry_idx
        ON handoff_records(expires_at);
      CREATE TABLE IF NOT EXISTS handoff_rate_limits (
        bucket TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
    `);
    try {
      chmodSync(dbPath(), 0o600);
      chmodSync(dirname(dbPath()), 0o700);
    } catch {
      // dropped concurrently
    }
  }

  private cleanup(connection: DatabaseSync, now: number): void {
    connection
      .prepare("DELETE FROM handoff_records WHERE expires_at + ? < ?")
      .run(STATE_RETENTION_SECONDS, now);
    connection
      .prepare("DELETE FROM handoff_rate_limits WHERE window_start + 3600 < ?")
      .run(now);
  }

  private static checkRate(
    connection: DatabaseSync,
    bucket: string,
    limit: [number, number],
    now: number,
  ): void {
    const [count, windowSeconds] = limit;
    const windowStart = now - (now % windowSeconds);
    connection.exec("BEGIN IMMEDIATE");
    try {
      connection
        .prepare(
          `INSERT INTO handoff_rate_limits(bucket, window_start, count)
           VALUES (?, ?, 0)
           ON CONFLICT(bucket) DO UPDATE SET
             window_start=excluded.window_start,
             count=CASE
               WHEN handoff_rate_limits.window_start != excluded.window_start
               THEN 0 ELSE handoff_rate_limits.count
             END`,
        )
        .run(bucket, windowStart);
      connection
        .prepare("UPDATE handoff_rate_limits SET count=count+1 WHERE bucket=?")
        .run(bucket);
      const row = connection
        .prepare("SELECT count FROM handoff_rate_limits WHERE bucket=?")
        .get(bucket) as { count: number } | undefined;
      connection.exec("COMMIT");
      if (row !== undefined && Number(row.count) > count) {
        throw new HandoffRateLimited("Too many handoff requests");
      }
    } catch (e) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw e;
    }
  }

  private rateLimit(bucket: string, limit: [number, number]): void {
    const connection = this.connect();
    SessionHandoffStore.checkRate(connection, bucket, limit, Math.floor(Date.now() / 1000));
  }

  create(opts: {
    encrypted_ticket: string;
    ticket_hash: string;
    public_host: string;
    now?: number;
    code_lifetime?: number;
    rate_key?: string;
  }): HandoffRecord {
    const current = opts.now ?? Math.floor(Date.now() / 1000);
    this.rateLimit(`create:${opts.rate_key ?? "unknown"}`, CREATE_RATE_LIMIT);
    // secrets.token_urlsafe(32) → 32 bytes base64url
    const code = randomBytes(32).toString("base64url");
    const expiresAt = current + (opts.code_lifetime ?? CODE_LIFETIME_SECONDS);
    const connection = this.connect();
    connection.exec("BEGIN IMMEDIATE");
    try {
      this.cleanup(connection, current);
      connection
        .prepare(
          `INSERT INTO handoff_records(
             code_hash, ticket_hash, encrypted_ticket, public_host,
             expires_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(hashSecret(code), opts.ticket_hash, opts.encrypted_ticket, opts.public_host, expiresAt, current);
      connection.exec("COMMIT");
    } catch (e) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw e;
    }
    return {
      code,
      ticket: opts.encrypted_ticket,
      public_origin: opts.public_host,
      expires_at: expiresAt,
    };
  }

  exchange(opts: { code: string; public_host: string; now?: number }): string {
    const current = opts.now ?? Math.floor(Date.now() / 1000);
    const codeHash = hashSecret(opts.code);
    const connection = this.connect();
    connection.exec("BEGIN IMMEDIATE");
    try {
      this.cleanup(connection, current);
      const row = connection
        .prepare(
          `SELECT encrypted_ticket, public_host, expires_at,
                  code_consumed_at, failed_attempts
             FROM handoff_records WHERE code_hash=?`,
        )
        .get(codeHash) as Record<string, unknown> | undefined;
      if (row === undefined) {
        connection.exec("COMMIT");
        throw new HandoffRejected("Invalid pairing code");
      }
      if (row["code_consumed_at"] !== null) {
        connection.exec("COMMIT");
        throw new HandoffRejected("Invalid pairing code");
      }
      if (Number(row["expires_at"]) <= current) {
        connection.prepare("DELETE FROM handoff_records WHERE code_hash=?").run(codeHash);
        connection.exec("COMMIT");
        throw new HandoffRejected("Invalid pairing code");
      }
      if (row["public_host"] !== opts.public_host) {
        const attempts = Number(row["failed_attempts"]) + 1;
        if (attempts >= MAX_CODE_ATTEMPTS) {
          connection.prepare("DELETE FROM handoff_records WHERE code_hash=?").run(codeHash);
        } else {
          connection
            .prepare("UPDATE handoff_records SET failed_attempts=? WHERE code_hash=?")
            .run(attempts, codeHash);
        }
        connection.exec("COMMIT");
        throw new HandoffRejected("Pairing code is not valid for this site");
      }
      const claims = decryptTicketPayload(String(row["encrypted_ticket"]));
      claims["exp"] = current + TICKET_LIFETIME_SECONDS;
      const freshTicket = encryptTicketPayload(claims);
      connection
        .prepare(
          `UPDATE handoff_records
             SET code_consumed_at=?, failed_attempts=0,
                 encrypted_ticket=?, ticket_hash=?
           WHERE code_hash=? AND code_consumed_at IS NULL`,
        )
        .run(current, freshTicket, hashSecret(freshTicket), codeHash);
      connection.exec("COMMIT");
      return freshTicket;
    } catch (e) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw e;
    }
  }

  consumeTicket(opts: { ticket: string; public_host: string; now?: number }): string {
    const current = opts.now ?? Math.floor(Date.now() / 1000);
    const ticketHash = hashSecret(opts.ticket);
    const connection = this.connect();
    connection.exec("BEGIN IMMEDIATE");
    try {
      this.cleanup(connection, current);
      const row = connection
        .prepare(
          `SELECT encrypted_ticket, public_host, expires_at,
                  ticket_consumed_at, code_consumed_at
             FROM handoff_records WHERE ticket_hash=?`,
        )
        .get(ticketHash) as Record<string, unknown> | undefined;
      const codeConsumedAt = row?.["code_consumed_at"];
      if (
        row === undefined ||
        row["ticket_consumed_at"] !== null ||
        codeConsumedAt === null ||
        codeConsumedAt === undefined ||
        Number(codeConsumedAt) + TICKET_LIFETIME_SECONDS <= current
      ) {
        if (row !== undefined) {
          connection.prepare("DELETE FROM handoff_records WHERE ticket_hash=?").run(ticketHash);
        }
        connection.exec("COMMIT");
        throw new HandoffRejected("Invalid handoff ticket");
      }
      if (row["public_host"] !== opts.public_host) {
        connection.exec("COMMIT");
        throw new HandoffRejected("Handoff ticket is not valid for this site");
      }
      if (String(row["encrypted_ticket"]) !== opts.ticket) {
        connection.exec("COMMIT");
        throw new HandoffRejected("Invalid handoff ticket");
      }
      connection
        .prepare(
          `UPDATE handoff_records
             SET ticket_consumed_at=?
           WHERE ticket_hash=? AND ticket_consumed_at IS NULL`,
        )
        .run(current, ticketHash);
      connection.exec("COMMIT");
      return opts.ticket;
    } catch (e) {
      try {
        connection.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw e;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

let _defaultStore: SessionHandoffStore | null = null;

export function getSessionHandoffStore(): SessionHandoffStore {
  if (_defaultStore === null) _defaultStore = new SessionHandoffStore();
  return _defaultStore;
}

export function resetSessionHandoffStoreForTests(): void {
  _defaultStore?.close();
  _defaultStore = null;
}

// randomInt imported for parity with secrets-based generation helpers.
void randomInt;
