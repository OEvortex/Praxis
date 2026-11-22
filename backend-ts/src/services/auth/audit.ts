// Port of deeptutor/multi_user/audit.py — append-only JSONL audit log.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureSystemDirs, getCurrentUser, SYSTEM_ROOT } from "./paths.js";

function auditFile(): string {
  return join(SYSTEM_ROOT(), "audit", "usage.jsonl");
}

function write(payload: Record<string, unknown>): void {
  try {
    ensureSystemDirs();
    const path = auditFile();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(payload) + "\n", "utf-8");
  } catch {
    // Auditing must never break a request.
  }
}

export function logUsage(
  resourceType: string,
  resourceId: string,
  action: string,
  extra: Record<string, unknown> | null = null,
): void {
  const user = getCurrentUser();
  if (user.role === "admin") return;
  const payload: Record<string, unknown> = {
    time: new Date().toISOString(),
    user_id: user.id,
    username: user.username,
    resource_type: resourceType,
    resource_id: resourceId,
    action,
  };
  if (extra) payload["extra"] = extra;
  write(payload);
}

export function logAdminAction(
  action: string,
  targetUserId: string | null = null,
  summary: Record<string, unknown> | null = null,
): void {
  const user = getCurrentUser();
  const payload: Record<string, unknown> = {
    time: new Date().toISOString(),
    actor_id: user.id,
    actor_username: user.username,
    actor_role: user.role,
    action,
  };
  if (targetUserId) payload["target_user_id"] = targetUserId;
  if (summary) payload["summary"] = summary;
  write(payload);
}
