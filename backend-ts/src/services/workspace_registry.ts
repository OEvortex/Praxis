// content workspace
// registry for the settings UI. The frontend treats
// `/api/settings/workspace/registrations` as a catalog `{root, workspaces: []}`.
// This module owns that catalog and the filesystem operations the settings
// page exposes (create, rename, archive, migrate, browse).
import {
  existsSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  accessSync,
  constants as fsConstants,
  statSync,
} from "node:fs";
import {
  resolve as resolvePath,
  join,
  dirname,
  basename,
  relative,
  isAbsolute,
} from "node:path";
import { homedir, platform } from "node:os";
import { randomBytes } from "node:crypto";
import type { Settings } from "../config.js";
import { get_state, put_state } from "../store/database.js";

export const MAX_WORKSPACE_INSTRUCTIONS_CHARS = 10_000;
export const SYSTEM_WORKSPACE_ID = "ws_system";
export const GENERAL_WORKSPACE_ID = "ws_general";
export const RESOURCE_KINDS = ["skills", "mcp", "knowledge_bases"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

function now(): string {
  return new Date().toISOString();
}

type Resources = Record<ResourceKind, string[] | null>;

function emptyResources(): Resources {
  return { skills: null, mcp: null, knowledge_bases: null };
}

function normalizeResources(value: unknown): Resources {
  if (value == null) return emptyResources();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceError("Workspace resources must be an object.");
  }
  const normalized = emptyResources();
  const input = value as Record<string, unknown>;
  for (const kind of RESOURCE_KINDS) {
    const items = input[kind];
    if (items == null) {
      normalized[kind] = null;
      continue;
    }
    if (!Array.isArray(items) || items.length > 1000) {
      throw new WorkspaceError(`Workspace resources for ${kind} must be a list.`);
    }
    const ids: string[] = [];
    for (const item of items) {
      const text = String(item).trim();
      if (text && !ids.includes(text)) ids.push(text);
    }
    normalized[kind] = ids;
  }
  return normalized;
}

function validateInstructions(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_WORKSPACE_INSTRUCTIONS_CHARS) {
    throw new WorkspaceError(
      "Workspace instructions must be text of at most " +
        `${MAX_WORKSPACE_INSTRUCTIONS_CHARS} characters.`,
    );
  }
  return value.trim();
}

function validateName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name || name.length > 100) {
    throw new WorkspaceError("A workspace name must contain 1 to 100 characters.");
  }
  return name;
}

// -- path helpers (pathlib/os replacements) -----------------------------------

function expandUser(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

function resolveLocal(p: string): string {
  return resolvePath(expandUser(p));
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Path.is_relative_to */
function isRelativeTo(target: string, base: string): boolean {
  const rel = relative(resolveLocal(base), resolveLocal(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function hasAccess(p: string, mode: number): boolean {
  try {
    accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
}

// Settings (src/config.ts) carries workspace_dir/data_dir as resolved paths,
function settingsWorkspaceDir(settings: Settings): string {
  return resolveLocal(settings.workspace_dir ?? join(settings.data_dir, "workspace"));
}

function settingsDataDir(settings: Settings): string {
  return resolveLocal(settings.data_dir ?? "./data");
}

// -- registry -----------------------------------------------------------------

interface WorkspaceRow {
  workspace_id?: string;
  display_name?: string;
  path?: string;
  kind?: string;
  follows_root?: boolean;
  archived?: boolean;
  created_at?: string;
  instructions?: string;
  resources?: unknown;
  error?: string;
  [k: string]: unknown;
}

interface CatalogData {
  version: number;
  root: string;
  workspaces: WorkspaceRow[];
  migration: Record<string, unknown> | null;
}

export interface WorkspaceDescriptor {
  workspace_id: string;
  display_name: string;
  path: string;
  kind: string;
  follows_root: boolean;
  archived: boolean;
  created_at: string;
  status: string;
  error: string;
  instructions: string;
  resources: Resources;
}

export class WorkspaceRegistry {
  private readonly settings: Settings;
  // synchronous fs operations, so no lock is needed.

  constructor(settings: Settings) {
    this.settings = settings;
  }

  // -- persistence -----------------------------------------------------------

  private load(): CatalogData {
    const raw = get_state<unknown>(this.settings, "workspaces", {});
    const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const root = String(obj.root ?? "").trim();
    const data: CatalogData = {
      version: 1,
      root: root || settingsWorkspaceDir(this.settings),
      workspaces: Array.isArray(obj.workspaces) ? (obj.workspaces as WorkspaceRow[]) : [],
      migration:
        obj.migration && typeof obj.migration === "object" && !Array.isArray(obj.migration)
          ? (obj.migration as Record<string, unknown>)
          : null,
    };
    this.ensureBuiltins(data);
    return data;
  }

  private save(data: CatalogData): void {
    put_state(this.settings, "workspaces", data);
  }

  get root(): string {
    return resolveLocal(this.load().root);
  }

  private ensureBuiltins(data: CatalogData): void {
    const root = resolveLocal(data.root);
    const rows = data.workspaces.filter(
      (row): row is WorkspaceRow => typeof row === "object" && row !== null && Boolean(row.workspace_id),
    );
    const known = new Set(rows.map((row) => String(row.workspace_id)));
    let changed = false;
    for (const [kind, workspaceId, name] of [
      ["system", SYSTEM_WORKSPACE_ID, "System workspace"],
      ["general", GENERAL_WORKSPACE_ID, "General workspace"],
    ] as const) {
      if (known.has(workspaceId)) continue;
      const path = join(root, kind);
      try {
        mkdirSync(path, { recursive: true });
      } catch { /* ignore */ }
      rows.push({
        workspace_id: workspaceId,
        display_name: name,
        path,
        kind,
        follows_root: true,
        archived: false,
        created_at: now(),
        instructions: "",
        resources: emptyResources(),
      });
      known.add(workspaceId);
      changed = true;
    }
    data.workspaces = rows;
    if (changed) this.save(data);
  }

  // -- rows -------------------------------------------------------------------

  private static status(path: string): [string, string] {
    try {
      if (!isDir(path)) return ["invalid", "The workspace folder does not exist."];
      if (!hasAccess(path, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)) {
        return ["invalid", "The workspace folder is not accessible."];
      }
    } catch (exc) {
      return ["invalid", String(exc)];
    }
    return ["ready", ""];
  }

  private row(row: WorkspaceRow): WorkspaceDescriptor {
    const rawPath = String(row.path ?? "");
    const path = rawPath ? expandUser(rawPath) : "";
    const [status, error] = WorkspaceRegistry.status(path);
    return {
      workspace_id: String(row.workspace_id ?? ""),
      display_name: String(row.display_name ?? row.workspace_id ?? ""),
      path,
      kind: String(row.kind ?? "workspace"),
      follows_root: Boolean(row.follows_root ?? false),
      archived: Boolean(row.archived),
      created_at: String(row.created_at ?? ""),
      status,
      error: String(row.error ?? error),
      instructions: String(row.instructions ?? ""),
      resources: normalizeResources(row.resources),
    };
  }

  private find(data: CatalogData, workspaceId: string): WorkspaceRow {
    const row = data.workspaces.find((item) => item.workspace_id === workspaceId);
    if (!row) throw new WorkspaceError("Workspace not found.");
    return row;
  }

  describe(): Record<string, unknown> {
    const data = this.load();
    const rows = data.workspaces.map((row) => this.row(row));
    rows.sort((a, b) => {
      const rank = (kind: string) => (kind === "system" ? 0 : kind === "general" ? 1 : 2);
      return rank(a.kind) - rank(b.kind) || a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase());
    });
    return { root: data.root, workspaces: rows, migration: data.migration };
  }

  workspace(workspaceId: string): WorkspaceDescriptor {
    return this.row(this.find(this.load(), workspaceId));
  }

  // -- filesystem helpers -------------------------------------------------------

  private static resolvePathValue(value: unknown, mustExist: boolean): string {
    const text = String(value ?? "").trim();
    if (!text) throw new WorkspaceError("A workspace folder path is required.");
    let path: string;
    try {
      path = resolveLocal(text);
    } catch {
      throw new WorkspaceError("The workspace folder path is invalid.");
    }
    const exists = existsSync(path);
    if (exists && !isDir(path)) {
      throw new WorkspaceError("The workspace path must be a folder.");
    }
    if (mustExist && !isDir(path)) {
      throw new WorkspaceError("The selected workspace folder does not exist.");
    }
    return path;
  }

  private static copyWorkspace(source: string, destination: string): void {
    if (existsSync(destination)) {
      throw new WorkspaceError("The destination folder already exists.");
    }
    mkdirSync(dirname(destination), { recursive: true });
    try {
      if (isDir(source)) {
        // shutil.copytree(source, destination, symlinks=True)
        cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
      } else {
        mkdirSync(destination, { recursive: true });
      }
    } catch (exc) {
      if (existsSync(destination)) {
        try {
          rmSync(destination, { recursive: true, force: true });
        } catch { /* ignore */ }
      }
      throw new WorkspaceError(`Could not copy the workspace folder: ${exc}`);
    }
  }

  // -- mutations -----------------------------------------------------------------

  create(
    name: unknown,
    path?: unknown,
    options?: { resources?: unknown; instructions?: unknown },
  ): WorkspaceDescriptor {
    const displayName = validateName(name);
    const data = this.load();
    const root = resolveLocal(data.root);
    const normalizedResources = normalizeResources(options?.resources);
    const normalizedInstructions =
      options?.instructions == null ? "" : validateInstructions(options.instructions);
    const workspaceId = `ws_${randomBytes(16).toString("hex")}`;
    let target: string;
    if (path) {
      target = WorkspaceRegistry.resolvePathValue(path, true);
    } else {
      target = resolveLocal(join(root, workspaceId));
      try {
        mkdirSync(target);
      } catch (exc) {
        throw new WorkspaceError(`Could not create the workspace folder: ${exc}`);
      }
    }
    for (const row of data.workspaces) {
      const raw = String(row.path ?? "");
      if (!raw) continue;
      let same = false;
      try {
        same = resolveLocal(raw) === target;
      } catch {
        continue;
      }
      if (same) {
        return this.updateLocked(data, String(row.workspace_id), {
          name: displayName,
          archived: false,
          resources: normalizedResources,
          instructions: normalizedInstructions,
        });
      }
    }
    const newRow: WorkspaceRow = {
      workspace_id: workspaceId,
      display_name: displayName,
      path: target,
      kind: "workspace",
      follows_root: !path,
      archived: false,
      created_at: now(),
      instructions: normalizedInstructions,
      resources: normalizedResources,
    };
    data.workspaces.push(newRow);
    this.save(data);
    return this.row(newRow);
  }

  update(workspaceId: string, changes: Record<string, unknown>): WorkspaceDescriptor {
    return this.updateLocked(this.load(), workspaceId, changes);
  }

  private updateLocked(
    data: CatalogData,
    workspaceId: string,
    changes: Record<string, unknown>,
  ): WorkspaceDescriptor {
    const row = this.find(data, workspaceId);
    const kind = String(row.kind ?? "workspace");
    if (kind === "system") {
      throw new WorkspaceError("The system workspace cannot be changed.");
    }
    if ("name" in changes && changes.name != null) {
      if (kind === "general") {
        throw new WorkspaceError("The default workspace cannot be renamed.");
      }
      row.display_name = validateName(changes.name);
    }
    if ("archived" in changes && changes.archived != null) {
      if (kind === "general") {
        throw new WorkspaceError("The default workspace cannot be archived.");
      }
      row.archived = Boolean(changes.archived);
    }
    if ("instructions" in changes && changes.instructions != null) {
      row.instructions = validateInstructions(changes.instructions);
    }
    if ("resources" in changes && changes.resources != null) {
      row.resources = normalizeResources(changes.resources);
    }
    this.save(data);
    return this.row(row);
  }

  migrate(workspaceId: string, destination: unknown): Record<string, unknown> {
    const data = this.load();
    const row = this.find(data, workspaceId);
    const source = resolveLocal(String(row.path ?? ""));
    const target = WorkspaceRegistry.resolvePathValue(destination, false);
    if (target === source) return this.describe();
    WorkspaceRegistry.copyWorkspace(source, target);
    row.path = target;
    row.follows_root = false;
    this.save(data);
    return this.describe();
  }

  migrateRoot(destination: unknown): Record<string, unknown> {
    const data = this.load();
    const currentRoot = resolveLocal(data.root);
    const target = WorkspaceRegistry.resolvePathValue(destination, false);
    if (target === currentRoot) return this.describe();
    if (isRelativeTo(target, currentRoot)) {
      throw new WorkspaceError("The new root cannot be inside the current workspace root.");
    }
    mkdirSync(target, { recursive: true });
    const movable = data.workspaces.filter(
      (row) => row.follows_root && resolveLocal(String(row.path ?? "")) !== target,
    );
    const created: string[] = [];
    try {
      for (const row of movable) {
        const source = resolveLocal(String(row.path ?? ""));
        const destinationPath = resolveLocal(join(target, String(row.workspace_id)));
        if (destinationPath === source) continue;
        WorkspaceRegistry.copyWorkspace(source, destinationPath);
        created.push(destinationPath);
        row.path = destinationPath;
      }
    } catch (exc) {
      for (const path of created) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch { /* ignore */ }
      }
      throw exc;
    }
    data.root = target;
    this.save(data);
    return this.describe();
  }

  // -- folder picker -------------------------------------------------------------

  browse(path = ""): Record<string, unknown> {
    const configured = (process.env.PRAXIS_WORKSPACE_BROWSER_ROOTS ?? "").trim();
    const roots: string[] = [];
    const candidates = configured
      ? configured.split(platform() === "win32" ? ";" : ":").filter((v) => v.trim()).map((v) => expandUser(v.trim()))
      : [settingsWorkspaceDir(this.settings), dirname(settingsDataDir(this.settings))];
    for (const candidate of candidates) {
      let resolved: string;
      try {
        resolved = resolveLocal(candidate);
      } catch {
        continue;
      }
      if (isDir(resolved) && !roots.includes(resolved)) roots.push(resolved);
    }
    if (!roots.length) {
      throw new WorkspaceError("No browsable workspace folders are configured.");
    }
    let current: string;
    try {
      if (path.includes("\0")) throw new Error("Invalid path");
      current = path ? resolveLocal(path) : roots[0];
    } catch {
      throw new WorkspaceError("The server folder path is invalid.");
    }
    const containing = roots.filter((root) => isRelativeTo(current, root));
    if (!containing.length) {
      throw new WorkspaceError("This folder is outside the configured browsing roots.");
    }
    const partsCount = (p: string) => p.split(/[\\/]/).filter(Boolean).length;
    const root = containing.reduce((a, b) => (partsCount(a) >= partsCount(b) ? a : b));
    const folders: Array<{ name: string; path: string }> = [];
    let scanned = 0;
    try {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        scanned += 1;
        if (scanned > 10_000) break;
        if (entry.name.startsWith(".")) continue;
        try {
          const target = resolveLocal(join(current, entry.name));
          const isFolder = entry.isDirectory() || (entry.isSymbolicLink() && isDir(target));
          if (
            isFolder &&
            target !== current &&
            isRelativeTo(target, root) &&
            hasAccess(target, fsConstants.R_OK | fsConstants.X_OK)
          ) {
            folders.push({ name: entry.name, path: target });
          }
        } catch {
          continue;
        }
      }
    } catch {
      throw new WorkspaceError("The selected server folder cannot be opened.");
    }
    folders.sort((a, b) => {
      const al = a.name.toLowerCase();
      const bl = b.name.toLowerCase();
      return al < bl ? -1 : al > bl ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return {
      roots: roots.map((item) => ({ name: basename(item) || item, path: item })),
      path: current,
      name: basename(current) || current,
      parent: current !== root ? dirname(current) : null,
      folders: folders.slice(0, 500),
      truncated: folders.length > 500 || scanned > 10_000,
    };
  }

  // -- resources ------------------------------------------------------------------

  resourceUsage(kind: string, resourceId: string): Array<{ workspace_id: string; display_name: string }> {
    if (!(RESOURCE_KINDS as readonly string[]).includes(kind) || !resourceId) return [];
    const data = this.load();
    return data.workspaces
      .filter((row) => (normalizeResources(row.resources)[kind as ResourceKind] ?? []).includes(resourceId))
      .map((row) => ({
        workspace_id: String(row.workspace_id ?? ""),
        display_name: String(row.display_name ?? row.workspace_id ?? ""),
      }));
  }
}

// -- read-only configuration snapshot ---------------------------------------------

/**
 * Read-only configuration snapshot shown in the built-in system workspace.
 * TODO: depends on src/provider-config.ts (load_catalog / SERVICES).
 */
export async function workspaceSnapshot(settings: Settings): Promise<Record<string, unknown>> {
  const { load_catalog, SERVICES } = await import("../provider-config.js");
  const catalog = load_catalog(settings) as Record<string, unknown>;
  const servicesRaw = catalog.services;
  const services =
    servicesRaw && typeof servicesRaw === "object" && !Array.isArray(servicesRaw)
      ? (servicesRaw as Record<string, unknown>)
      : {};
  const models: Record<string, unknown> = {};
  for (const service of SERVICES as unknown as string[]) {
    const bucketRaw = services[service];
    const bucket =
      bucketRaw && typeof bucketRaw === "object" && !Array.isArray(bucketRaw)
        ? (bucketRaw as Record<string, unknown>)
        : {};
    const profiles: Array<Record<string, unknown>> = [];
    const activeProfileId = bucket.active_profile_id;
    let activeModelId: string | null = null;
    for (const profileRaw of (bucket.profiles as unknown[]) ?? []) {
      if (!profileRaw || typeof profileRaw !== "object" || Array.isArray(profileRaw)) continue;
      const profile = profileRaw as Record<string, unknown>;
      const profileModels: Array<Record<string, string>> = [];
      for (const modelRaw of (profile.models as unknown[]) ?? []) {
        if (!modelRaw || typeof modelRaw !== "object" || Array.isArray(modelRaw)) continue;
        const model = modelRaw as Record<string, unknown>;
        const modelId = String(model.id ?? model.model ?? "");
        if (!modelId) continue;
        profileModels.push({
          id: modelId,
          name: String(model.name ?? ""),
          model: String(model.model ?? ""),
        });
      }
      const profileId = String(profile.id ?? "");
      if (profileId === activeProfileId && profileModels.length) {
        activeModelId = String(profile.active_model_id ?? profileModels[0].id);
      }
      profiles.push({
        id: profileId,
        name: String(profile.name ?? ""),
        binding: String(profile.binding ?? profile.provider ?? ""),
        models: profileModels,
      });
    }
    models[service] = {
      active_profile_id: activeProfileId ?? null,
      active_model_id: activeModelId,
      profiles,
    };
  }
  return { generated_at: now(), models, mcp: [] };
}
