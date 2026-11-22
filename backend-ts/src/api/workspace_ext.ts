// Port of the deeptutor/api/routers/workspace.py settings_router endpoints that
// backend-ts/src/api/handlers.ts does not already cover:
//   GET  /api/settings/workspace
//   POST /api/settings/workspace/validate
//   PUT  /api/settings/workspace
//   POST /api/settings/workspace/knowledge-bases/preview-move
//   POST /api/settings/workspace/knowledge-bases/move
//   GET  /api/settings/workspace/data/discover|operations|exports/{id}
//   POST /api/settings/workspace/data/preview|migrate|export|operations/{id}/recover
// Registrations CRUD, folders, resources and resource-usage already exist in
// handlers.ts; files_router (published-item delivery) is TODO — see notes.
import { Hono } from "hono";
import type { Context } from "hono";
import { existsSync, statSync } from "node:fs";
import { get_settings } from "../config.js";
import { get_state, put_state } from "../store/database.js";
import { KnowledgeBaseStore } from "../store/kb_store.js";
import {
  WorkspaceError,
  WorkspaceRegistry,
} from "../services/workspace_registry.js";

export const workspaceExtRouter = new Hono();

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

async function jsonBody(c: Context): Promise<Record<string, any>> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function registry(): WorkspaceRegistry {
  return new WorkspaceRegistry(get_settings());
}

function currentWorkspace(): Record<string, unknown> {
  const saved = get_state<Record<string, unknown>>(get_settings(), "workspace/current", null);
  return saved ?? {};
}

// GET /api/settings/workspace — current workspace descriptor.
workspaceExtRouter.get("/api/settings/workspace", (c) => {
  const described = registry().describe() as Record<string, unknown>;
  const current = currentWorkspace();
  return c.json({
    ...described,
    workspace_id: current["workspace_id"] ?? "",
    path: current["path"] ?? "",
    display_name: current["display_name"] ?? "",
    is_default: !current["workspace_id"],
  });
});

// POST /api/settings/workspace/validate — folder picker validation.
workspaceExtRouter.post("/api/settings/workspace/validate", async (c) => {
  const body = await jsonBody(c);
  const raw = String(body.path ?? "").trim();
  if (!raw) {
    return c.json({ path: "", status: "invalid", error: "The workspace folder path cannot be empty." });
  }
  const path = raw.startsWith("~/") ? `${process.env.HOME ?? ""}${raw.slice(1)}` : raw;
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return c.json({ path, status: "invalid", error: "The workspace folder does not exist." });
    }
  } catch (e) {
    return c.json({ path, status: "invalid", error: String(e) });
  }
  return c.json({
    path,
    status: "ready",
    workspace_id: `ws_${Buffer.from(path).toString("hex").slice(0, 16)}`,
    display_name: path.split("/").filter(Boolean).pop() ?? path,
    is_default: false,
    locked: false,
  });
});

// PUT /api/settings/workspace — select the active workspace folder.
workspaceExtRouter.put("/api/settings/workspace", async (c) => {
  const body = await jsonBody(c);
  const raw = body.path === null || body.path === undefined ? "" : String(body.path).trim();
  if (!raw) return httpError(c, 400, "The workspace folder path cannot be empty.");
  const path = raw.startsWith("~/") ? `${process.env.HOME ?? ""}${raw.slice(1)}` : raw;
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new WorkspaceError("The workspace folder does not exist.");
    }
  } catch (e) {
    return httpError(c, 400, e instanceof Error ? e.message : String(e));
  }
  const selection = {
    workspace_id: `ws_${Buffer.from(path).toString("hex").slice(0, 16)}`,
    path,
    display_name: path.split("/").filter(Boolean).pop() ?? path,
  };
  put_state(get_settings(), "workspace/current", selection);
  const described = registry().describe() as Record<string, unknown>;
  return c.json({ ...described, ...selection, is_default: false });
});

// -- knowledge-base move ---------------------------------------------------------
// Upstream kb_move copies a KB directory between workspace roots and rewrites
// assignments. The TS backend stores KBs in SQLite (not per-workspace folders),
// so the preview reports real blockers where detectable and `move` records a
// kv alias; physical relocation is a TODO until KB storage is workspace-scoped.

function kbNames(): string[] {
  try {
    const kb = new KnowledgeBaseStore(get_settings());
    return (kb.list() as Array<Record<string, unknown>>).map(
      (r) => String(r["id"] ?? r["name"] ?? ""),
    ).filter(Boolean);
  } catch {
    return [];
  }
}

function workspaceRows(): Array<Record<string, unknown>> {
  const described = registry().describe() as Record<string, unknown>;
  return Array.isArray(described["workspaces"]) ? (described["workspaces"] as Array<Record<string, unknown>>) : [];
}

function moveAliases(): Record<string, string> {
  return get_state<Record<string, string>>(get_settings(), "workspace/kb_move_aliases", {}) ?? {};
}

async function kbMovePreview(sourceId: string, targetWorkspaceId: string, c: Context) {
  const sourceIdTrim = String(sourceId ?? "").trim();
  const targetId = String(targetWorkspaceId ?? "").trim();
  const rows = workspaceRows();
  const sourceRow = rows.find((r) => String(r["workspace_id"] ?? "") === sourceIdTrim);
  const targetRow = rows.find((r) => String(r["workspace_id"] ?? "") === targetId);
  const name = sourceIdTrim.split(":").pop() ?? sourceIdTrim;
  const blockers: string[] = [];
  if (!sourceIdTrim || !name) blockers.push("Choose a knowledge base from the library.");
  if (!sourceRow) blockers.push("The source workspace was not found.");
  if (!targetRow) blockers.push("The target workspace was not found.");
  if (sourceIdTrim === targetId) blockers.push("Choose a different storage workspace.");
  if (sourceRow?.["archived"] || targetRow?.["archived"]) {
    blockers.push("Restore the workspace before moving its knowledge base.");
  }
  if (name && kbNames().includes(name) === false) {
    blockers.push("The source knowledge base is missing from its configuration.");
  }
  const assignments = rows
    .filter((r) => {
      const resources = (r["resources"] ?? {}) as Record<string, unknown>;
      const kbs = Array.isArray(resources["knowledge_bases"]) ? resources["knowledge_bases"] : [];
      return kbs.map(String).includes(name);
    })
    .map((r) => ({ workspace_id: r["workspace_id"], display_name: r["display_name"] }));
  return c.json({
    source_id: sourceIdTrim,
    target_id: targetId ? `${targetId}:${name}` : "",
    source_workspace_id: sourceIdTrim,
    target_workspace_id: targetId,
    name,
    files: 0,
    bytes: 0,
    assignments,
    blockers,
  });
}

// POST /api/settings/workspace/knowledge-bases/preview-move
workspaceExtRouter.post("/api/settings/workspace/knowledge-bases/preview-move", async (c) => {
  const body = await jsonBody(c);
  return kbMovePreview(String(body.source_id ?? ""), String(body.target_workspace_id ?? ""), c);
});

// POST /api/settings/workspace/knowledge-bases/move
workspaceExtRouter.post("/api/settings/workspace/knowledge-bases/move", async (c) => {
  const body = await jsonBody(c);
  const sourceId = String(body.source_id ?? "").trim();
  const targetWorkspaceId = String(body.target_workspace_id ?? "").trim();
  // Preview first — refuse when blockers exist, mirroring upstream move_kb.
  const preview = await (async () => {
    const rows = workspaceRows();
    const name = sourceId.split(":").pop() ?? sourceId;
    const blockers: string[] = [];
    if (sourceId === targetWorkspaceId) blockers.push("Choose a different storage workspace.");
    if (!kbNames().includes(name)) blockers.push("The source knowledge base is missing from its configuration.");
    return { name, blockers };
  })();
  if (preview.blockers.length) {
    return httpError(c, 409, preview.blockers.join(" "));
  }
  // TODO(port): TS KB storage is not workspace-partitioned; record the move as
  // an alias so resolve paths can redirect, and report the preview shape.
  const aliases = moveAliases();
  aliases[sourceId] = targetWorkspaceId ? `${targetWorkspaceId}:${preview.name}` : preview.name;
  put_state(get_settings(), "workspace/kb_move_aliases", aliases);
  return kbMovePreview(sourceId, targetWorkspaceId, c);
});

// -- data migration endpoints -------------------------------------------------------
// Upstream data_migration.py (~1100 lines) copies sessions/KDs/exports between
// workspace roots with journaling. No TS equivalent exists yet — return the
// contract shapes with empty results and mark TODOs rather than fake success.

const MIGRATION_UNPORTED =
  "Workspace data migration is not yet ported to the TypeScript backend.";

// GET /api/settings/workspace/data/discover
workspaceExtRouter.get("/api/settings/workspace/data/discover", (c) => {
  return c.json({ detail: MIGRATION_UNPORTED }, 501);
});

// POST /api/settings/workspace/data/preview
workspaceExtRouter.post("/api/settings/workspace/data/preview", (c) => {
  return c.json({ detail: MIGRATION_UNPORTED }, 501);
});

// POST /api/settings/workspace/data/migrate
workspaceExtRouter.post("/api/settings/workspace/data/migrate", (c) => {
  return c.json({ detail: MIGRATION_UNPORTED }, 501);
});

// POST /api/settings/workspace/data/export
workspaceExtRouter.post("/api/settings/workspace/data/export", (c) => {
  return c.json({ detail: MIGRATION_UNPORTED }, 501);
});

// GET /api/settings/workspace/data/operations
workspaceExtRouter.get("/api/settings/workspace/data/operations", (c) => {
  return c.json({ operations: [] });
});

// POST /api/settings/workspace/data/operations/{operation_id}/recover
workspaceExtRouter.post("/api/settings/workspace/data/operations/:operation_id/recover", (c) => {
  return httpError(c, 404, "Operation not found");
});

// GET /api/settings/workspace/data/exports/{operation_id}
workspaceExtRouter.get("/api/settings/workspace/data/exports/:operation_id", (c) => {
  return httpError(c, 404, "Export not found");
});
