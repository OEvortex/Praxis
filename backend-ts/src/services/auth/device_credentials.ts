// Port of deeptutor/multi_user/device_credentials.py — revocable device
// credentials for local learner accounts (JSON store, bcrypt PIN hashes).
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashPassword, verifyPassword } from "./bcrypt.js";
import { getUserById } from "./identity.js";
import { authDir } from "./identity.js";
import type { UserRecord } from "./identity.js";

export const HEARTBEAT_TIMEOUT_SECONDS = 5 * 60;
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCKOUT_SECONDS = 15 * 60;
export const MIN_DAILY_LIMIT_MINUTES = 5;
export const MAX_DAILY_LIMIT_MINUTES = 24 * 60;

function deviceCredentialsFile(): string {
  return join(authDir(), "device_credentials.json");
}

function utcNow(): Date {
  return new Date();
}

function iso(value: Date): string {
  return value.toISOString();
}

function parseIso(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function hashPairingCode(code: string): string {
  return createHash("sha256").update(code, "utf-8").digest("hex");
}

function hashSessionNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf-8").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validUsageDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function canonicalRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const credentialId = String(value["id"] ?? `dc_${randomUUID().replace(/-/g, "")}`);
  const userId = String(value["user_id"] ?? "");
  const pairingHash = String(value["pairing_code_hash"] ?? "");
  const pinHash = String(value["pin_hash"] ?? "");
  const expiresAt = parseIso(value["expires_at"]);
  const dailyLimit = value["daily_limit_minutes"];
  if (!userId || !pairingHash || !pinHash || expiresAt === null) return null;
  if (
    typeof dailyLimit !== "number" ||
    !Number.isInteger(dailyLimit) ||
    dailyLimit < MIN_DAILY_LIMIT_MINUTES ||
    dailyLimit > MAX_DAILY_LIMIT_MINUTES
  ) {
    return null;
  }
  const revokedAt = parseIso(value["revoked_at"]);
  const lastHeartbeat = parseIso(value["last_heartbeat_at"]);
  let usedSeconds = (value["used_seconds"] ?? 0) as number;
  if (typeof usedSeconds !== "number" || !Number.isInteger(usedSeconds) || usedSeconds < 0) {
    usedSeconds = 0;
  }
  let usageDay = String(value["usage_day"] ?? "");
  if (usageDay && !validUsageDay(usageDay)) usageDay = "";
  let failedPinAttempts = (value["failed_pin_attempts"] ?? 0) as number;
  if (typeof failedPinAttempts !== "number" || !Number.isInteger(failedPinAttempts) || failedPinAttempts < 0) {
    failedPinAttempts = 0;
  }
  const pinLockedUntil = parseIso(value["pin_locked_until"]);
  return {
    id: credentialId,
    user_id: userId,
    device_name: String(value["device_name"] ?? "Device").slice(0, 80),
    pairing_code_hash: pairingHash,
    pin_hash: pinHash,
    created_at: String(value["created_at"] ?? ""),
    expires_at: iso(expiresAt),
    daily_limit_minutes: dailyLimit,
    last_login_at: String(value["last_login_at"] ?? ""),
    last_heartbeat_at: lastHeartbeat ? iso(lastHeartbeat) : "",
    usage_day: usageDay,
    used_seconds: Math.min(usedSeconds, dailyLimit * 60),
    session_nonce_hash: String(value["session_nonce_hash"] ?? ""),
    failed_pin_attempts: Math.min(failedPinAttempts, MAX_PIN_ATTEMPTS),
    pin_locked_until: pinLockedUntil ? iso(pinLockedUntil) : "",
    revoked_at: revokedAt ? iso(revokedAt) : null,
    revoked_by: revokedAt ? String(value["revoked_by"] ?? "") : "",
  };
}

function loadRecords(): Record<string, unknown>[] {
  const path = deviceCredentialsFile();
  let loaded: unknown;
  try {
    loaded = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
  if (!Array.isArray(loaded)) return [];
  const records: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const value of loaded) {
    const record = canonicalRecord(value);
    if (record === null) continue;
    const id = String(record["id"]);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push(record);
  }
  return records;
}

function writeRecords(records: Record<string, unknown>[]): void {
  const path = deviceCredentialsFile();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(records, null, 2), "utf-8");
  renameSync(tmp, path);
}

function publicRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      key === "pairing_code_hash" ||
      key === "pin_hash" ||
      key === "session_nonce_hash" ||
      key === "failed_pin_attempts" ||
      key === "pin_locked_until"
    ) {
      continue;
    }
    out[key] = value === undefined ? null : JSON.parse(JSON.stringify(value));
  }
  return out;
}

function activeAccount(userId: string): [string, UserRecord] | null {
  const account = getUserById(userId);
  if (account === null) return null;
  const [username, record] = account;
  if (String(record["role"] ?? "user") === "admin" || Boolean(record["disabled"])) {
    return null;
  }
  if (String(record["preset"] ?? "standard") !== "learner") return null;
  return [username, record];
}

function usageFor(record: Record<string, unknown>, now: Date): [string, number] {
  const currentDay = now.toISOString().slice(0, 10);
  if (record["usage_day"] !== currentDay) return [currentDay, 0];
  return [currentDay, Number(record["used_seconds"] ?? 0)];
}

function isUsable(record: Record<string, unknown>, now: Date): boolean {
  if (record["revoked_at"] !== null) return false;
  const expiresAt = parseIso(record["expires_at"]);
  if (expiresAt === null || expiresAt <= now) return false;
  if (activeAccount(String(record["user_id"])) === null) return false;
  const [, usedSeconds] = usageFor(record, now);
  if (usedSeconds >= Number(record["daily_limit_minutes"]) * 60) return false;
  const lastHeartbeat = parseIso(record["last_heartbeat_at"]);
  if (lastHeartbeat === null) return false;
  const elapsed = (now.getTime() - lastHeartbeat.getTime()) / 1000;
  return elapsed >= 0 && elapsed <= HEARTBEAT_TIMEOUT_SECONDS;
}

function chargePreviousLease(record: Record<string, unknown>, now: Date): void {
  const [usageDay, usedSeconds] = usageFor(record, now);
  const lastHeartbeat = parseIso(record["last_heartbeat_at"]);
  let elapsed = 0;
  if (lastHeartbeat !== null && lastHeartbeat.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
    elapsed = Math.min(
      Math.max(Math.floor((now.getTime() - lastHeartbeat.getTime()) / 1000), 0),
      HEARTBEAT_TIMEOUT_SECONDS,
    );
  }
  record["usage_day"] = usageDay;
  record["used_seconds"] = Math.min(
    usedSeconds + elapsed,
    Number(record["daily_limit_minutes"]) * 60,
  );
}

function secureRandomInt(maxExclusive: number): number {
  // secrets.randbelow equivalent
  return randomInt(0, maxExclusive);
}

export function issueDeviceCredential(opts: {
  user_id: string;
  device_name: string;
  expires_at: Date;
  daily_limit_minutes: number;
  now?: Date;
}): [Record<string, unknown>, string, string] {
  const current = opts.now ?? utcNow();
  if (activeAccount(opts.user_id) === null) {
    throw new Error("Device credentials require an active learner account.");
  }
  if (opts.expires_at <= current) {
    throw new Error("Device credential expiry must be in the future.");
  }
  if (opts.expires_at.getTime() - current.getTime() > 365 * 24 * 3600 * 1000) {
    throw new Error("Device credential expiry cannot exceed 365 days.");
  }
  if (
    opts.daily_limit_minutes < MIN_DAILY_LIMIT_MINUTES ||
    opts.daily_limit_minutes > MAX_DAILY_LIMIT_MINUTES
  ) {
    throw new Error("Daily limit must be between 5 and 1440 minutes.");
  }
  const device = opts.device_name.trim() || "Device";
  if (device.length > 80) {
    throw new Error("Device name cannot exceed 80 characters.");
  }

  const pairingCode = `dc_${randomBytesUrl(24)}`;
  const pin = String(secureRandomInt(1_000_000)).padStart(6, "0");
  const record: Record<string, unknown> = {
    id: `dc_${randomUUID().replace(/-/g, "")}`,
    user_id: opts.user_id,
    device_name: device,
    pairing_code_hash: hashPairingCode(pairingCode),
    pin_hash: hashPassword(pin),
    created_at: iso(current),
    expires_at: iso(opts.expires_at),
    daily_limit_minutes: opts.daily_limit_minutes,
    last_login_at: "",
    last_heartbeat_at: "",
    usage_day: "",
    used_seconds: 0,
    session_nonce_hash: "",
    failed_pin_attempts: 0,
    pin_locked_until: "",
    revoked_at: null,
    revoked_by: "",
  };
  const records = loadRecords();
  records.push(record);
  writeRecords(records);
  return [publicRecord(record), pairingCode, pin];
}

export function listDeviceCredentials(opts?: {
  user_id?: string | null;
  include_revoked?: boolean;
}): Record<string, unknown>[] {
  const userId = opts?.user_id ?? null;
  const includeRevoked = opts?.include_revoked ?? false;
  return loadRecords()
    .filter(
      (record) =>
        (includeRevoked || record["revoked_at"] === null) &&
        (userId === null || record["user_id"] === userId),
    )
    .map(publicRecord);
}

export function beginDeviceSession(
  pairingCode: string,
  pin: string,
  now?: Date,
): [Record<string, unknown>, string, string, string, string] | null {
  const current = now ?? utcNow();
  const pairingHash = hashPairingCode(pairingCode);
  const records = loadRecords();
  const record = records.find((item) => item["pairing_code_hash"] === pairingHash);
  if (record === undefined || !safeEqual(String(record["pairing_code_hash"]), pairingHash)) {
    return null;
  }
  const account = activeAccount(String(record["user_id"]));
  if (account === null) return null;
  if (record["revoked_at"] !== null) return null;
  const expiresAt = parseIso(record["expires_at"]);
  if (expiresAt === null || expiresAt <= current) return null;
  const lockedUntil = parseIso(record["pin_locked_until"]);
  if (lockedUntil !== null && lockedUntil > current) return null;
  if (!verifyPassword(pin, String(record["pin_hash"]))) {
    record["failed_pin_attempts"] = Number(record["failed_pin_attempts"] ?? 0) + 1;
    if (Number(record["failed_pin_attempts"]) >= MAX_PIN_ATTEMPTS) {
      record["pin_locked_until"] = iso(new Date(current.getTime() + PIN_LOCKOUT_SECONDS * 1000));
    }
    writeRecords(records);
    return null;
  }
  record["failed_pin_attempts"] = 0;
  record["pin_locked_until"] = "";
  chargePreviousLease(record, current);
  if (Number(record["used_seconds"]) >= Number(record["daily_limit_minutes"]) * 60) {
    writeRecords(records);
    return null;
  }
  const sessionNonce = randomBytesUrl(32);
  record["session_nonce_hash"] = hashSessionNonce(sessionNonce);
  record["last_login_at"] = iso(current);
  record["last_heartbeat_at"] = iso(current);
  writeRecords(records);
  const [username, userRecord] = account;
  return [
    publicRecord(record),
    username,
    String(userRecord["role"] ?? "user"),
    String(record["user_id"]),
    sessionNonce,
  ];
}

export function validateDeviceToken(userId: string, credentialId: string, sessionNonce: string): boolean {
  const record = loadRecords().find((item) => item["id"] === credentialId);
  return (
    record !== undefined &&
    record["user_id"] === userId &&
    Boolean(sessionNonce) &&
    safeEqual(String(record["session_nonce_hash"] ?? ""), hashSessionNonce(sessionNonce)) &&
    isUsable(record, utcNow())
  );
}

export function heartbeatDeviceCredential(
  credentialId: string,
  opts: { user_id: string; session_nonce: string; now?: Date },
): Record<string, unknown> {
  const current = opts.now ?? utcNow();
  const records = loadRecords();
  const record = records.find((item) => item["id"] === credentialId);
  const nonceMatches =
    record !== undefined &&
    Boolean(opts.session_nonce) &&
    safeEqual(String(record["session_nonce_hash"] ?? ""), hashSessionNonce(opts.session_nonce));
  if (
    record === undefined ||
    record["user_id"] !== opts.user_id ||
    !nonceMatches ||
    !isUsable(record, current)
  ) {
    throw new Error("Device credential is not active.");
  }
  const lastHeartbeat = parseIso(record["last_heartbeat_at"]);
  if (lastHeartbeat === null) {
    throw new Error("Device credential is not active.");
  }
  const elapsed = Math.floor((current.getTime() - lastHeartbeat.getTime()) / 1000);
  const [usageDay, usedSeconds] = usageFor(record, current);
  record["usage_day"] = usageDay;
  record["used_seconds"] = Math.min(
    usedSeconds + Math.max(elapsed, 0),
    Number(record["daily_limit_minutes"]) * 60,
  );
  record["last_heartbeat_at"] = iso(current);
  writeRecords(records);
  const limitSeconds = Number(record["daily_limit_minutes"]) * 60;
  const view = publicRecord(record);
  view["remaining_seconds"] = Math.max(limitSeconds - Number(record["used_seconds"]), 0);
  view["limit_reached"] = Number(record["used_seconds"]) >= limitSeconds;
  return view;
}

export function revokeDeviceCredential(
  credentialId: string,
  opts: { revoked_by: string; now?: Date },
): Record<string, unknown> | null {
  const current = opts.now ?? utcNow();
  const records = loadRecords();
  for (const record of records) {
    if (record["id"] !== credentialId) continue;
    if (record["revoked_at"] === null) {
      record["revoked_at"] = iso(current);
      record["revoked_by"] = opts.revoked_by;
      writeRecords(records);
    }
    return publicRecord(record);
  }
  return null;
}

export function revokeDeviceCredentialsForUser(
  userId: string,
  opts: { revoked_by: string; now?: Date },
): number {
  const current = opts.now ?? utcNow();
  const records = loadRecords();
  let changed = 0;
  for (const record of records) {
    if (record["user_id"] !== userId || record["revoked_at"] !== null) continue;
    record["revoked_at"] = iso(current);
    record["revoked_by"] = opts.revoked_by;
    record["session_nonce_hash"] = "";
    changed += 1;
  }
  if (changed > 0) writeRecords(records);
  return changed;
}

import { randomBytes } from "node:crypto";

function randomBytesUrl(n: number): string {
  // secrets.token_urlsafe(n) — n bytes → base64url without padding
  return randomBytes(n).toString("base64url");
}
