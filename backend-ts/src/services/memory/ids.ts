// Port of deeptutor/services/memory/ids.py — ULID-style trace/entry ids.
import { randomBytes } from "node:crypto";

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford
const ULID_TS_LEN = 10;
const ULID_RAND_LEN = 16;

const ENTRY_RE = /^m_[0-9A-HJKMNP-TV-Z]{26}$/;
const TRACE_RE = /^[a-z][a-z0-9_-]*:[0-9A-HJKMNP-TV-Z]{26}$/;
const SNAPSHOT_RE = /^[a-z][a-z0-9_-]*:[A-Za-z0-9_.:\-]+$/;
const SHORTNAME_REFS = new Set([
  "chat",
  "notebook",
  "quiz",
  "kb",
  "book",
  "partner",
  "cowriter",
]);

function encode(n: bigint, length: number): string {
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    chars.push(BASE32[Number(n & 0x1fn)]);
    n >>= 5n;
  }
  return chars.reverse().join("");
}

export function new_ulid(): string {
  const ts = BigInt(Date.now()) & ((1n << BigInt(ULID_TS_LEN * 5)) - 1n);
  const rand = BigInt("0x" + randomBytes(10).toString("hex")) &
    ((1n << BigInt(ULID_RAND_LEN * 5)) - 1n);
  return encode(ts, ULID_TS_LEN) + encode(rand, ULID_RAND_LEN);
}

export function new_entry_id(): string {
  return `m_${new_ulid()}`;
}

export function new_trace_id(surface: string): string {
  return `${surface}:${new_ulid()}`;
}

export function is_entry_id(s: string): boolean {
  return ENTRY_RE.test(s);
}

export function is_trace_id(s: string): boolean {
  return TRACE_RE.test(s);
}

export function is_snapshot_ref(s: string): boolean {
  return SNAPSHOT_RE.test(s);
}

export function is_shortname_ref(s: string): boolean {
  return SHORTNAME_REFS.has(s);
}

export function is_valid_ref(s: string): boolean {
  return (
    is_entry_id(s) ||
    is_trace_id(s) ||
    is_snapshot_ref(s) ||
    is_shortname_ref(s)
  );
}
