// Shared storage helpers for the Partners / Partner Groups / multi-user port.
// Everything lives in the canonical SQLite `ext_items` table via
// store/database.ts, keyed by dotted collection names (same convention as
// api/handlers.ts `_collection`).
import { getSettings, type Settings } from "../../config.js";
import * as database from "../../store/database.js";

export type AnyRecord = Record<string, any>;

export function settings(): Settings {
  return getSettings();
}

export function now(): number {
  return Date.now() / 1000;
}

export function uuid32(): string {
  // 32 lowercase hex chars — matches upstream uuid4().hex usage.
  return crypto.randomUUID().replace(/-/g, "");
}

export function uuid12(): string {
  return uuid32().slice(0, 12);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function listItems(collection: string): AnyRecord[] {
  return database.list_items(settings(), collection) as AnyRecord[];
}

export function getItem(collection: string, itemId: string): AnyRecord | null {
  return database.get_item(settings(), collection, String(itemId)) as AnyRecord | null;
}

export function putItem(collection: string, item: AnyRecord): void {
  if (item["id"] === undefined || item["id"] === null || item["id"] === "") {
    item["id"] = uuid12();
  }
  if (item["created_at"] === undefined || item["created_at"] === null) {
    item["created_at"] = now();
  }
  item["updated_at"] = now();
  database.put_item(settings(), collection, item);
}

export function deleteItem(collection: string, itemId: string): boolean {
  return database.delete_item(settings(), collection, String(itemId));
}

// Collections
export const COL = {
  partnerConfigs: "partners_ext/configs",
  partnerSouls: "partners_ext/souls",
  partnerSessions: (pid: string, actorKey: string) =>
    `partners_ext/sessions/${pid}/${actorKey}`,
  partnerDrafts: "partners_ext/drafts",
  partnerLinks: (pid: string) => `partners_ext/links/${pid}`,
  partnerContinuity: (pid: string, accountId: string) =>
    `partners_ext/continuity/${pid}/${accountId}`,
  partnerRuntime: "partners_ext/runtime",
  groupConfigs: "partners_ext/groups",
  groupTranscripts: (gid: string, stem: string) =>
    `partners_ext/group-transcripts/${gid}/${stem}`,
  groupInvocations: (gid: string) => `partners_ext/group-invocations/${gid}`,
  groupWhiteboard: (gid: string) => `partners_ext/group-whiteboard/${gid}`,
  muUsers: "multi-user/users",
  muGrants: (uid: string) => `multi-user/grants/${uid}`,
  muGuardians: "multi-user/guardians",
  muAudit: "multi-user/audit",
  muBookPermission: (uid: string) => `multi-user/book-permission/${uid}`,
} as const;
