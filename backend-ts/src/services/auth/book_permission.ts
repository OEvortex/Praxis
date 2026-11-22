import { getUser } from "./identity.js";
import type { CurrentUser } from "./paths.js";

export type BookPermissionLevel = "none" | "read" | "edit";
export type BookDefaultLevel = "none" | "read";

export const BOOK_PERMISSION_LEVELS: ReadonlySet<string> = new Set(["none", "read", "edit"]);
export const BOOK_DEFAULT_LEVELS: ReadonlySet<string> = new Set(["none", "read"]);

export interface BookPermission {
  create: boolean;
  default: BookDefaultLevel;
  books: [string, BookPermissionLevel][];
}

export const DEFAULT_BOOK_PERMISSION: BookPermission = {
  create: true,
  default: "none",
  books: [],
};

export const ADMIN_BOOK_PERMISSION: BookPermission = {
  create: true,
  default: "read",
  books: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeBookPermission(raw: unknown): BookPermission {
  if (!isRecord(raw)) return { ...DEFAULT_BOOK_PERMISSION, books: [] };

  if ("create" in raw || "default" in raw || "books" in raw) {
    const create = raw["create"] === undefined ? true : raw["create"] === true;
    const defaultRaw = raw["default"];
    const def: BookDefaultLevel = BOOK_DEFAULT_LEVELS.has(String(defaultRaw))
      ? (defaultRaw as BookDefaultLevel)
      : "none";
    const books: [string, BookPermissionLevel][] = [];
    const rawBooks = raw["books"];
    if (isRecord(rawBooks)) {
      for (const [rawId, rawLevel] of Object.entries(rawBooks)) {
        const bookId = String(rawId ?? "").trim();
        if (!bookId) continue;
        let level = rawLevel === "delete" ? "edit" : rawLevel;
        if (BOOK_PERMISSION_LEVELS.has(String(level))) {
          books.push([bookId, level as BookPermissionLevel]);
        }
      }
    }
    return { create, default: def, books };
  }

  const mode = String(raw["mode"] ?? "none");
  const actions = isRecord(raw["actions"]) ? raw["actions"] : {};
  const create = actions["create"] === undefined ? true : actions["create"] === true;
  const writable = actions["edit"] === true || actions["delete"] === true;
  const level: BookPermissionLevel = writable ? "edit" : "read";
  if (mode === "all") {
    return { create, default: "read", books: [] };
  }
  if (mode === "list" && Array.isArray(raw["book_ids"])) {
    const seen = new Set<string>();
    const books: [string, BookPermissionLevel][] = [];
    for (const item of raw["book_ids"]) {
      const bookId = String(item ?? "").trim();
      if (bookId && !seen.has(bookId)) {
        seen.add(bookId);
        books.push([bookId, level]);
      }
    }
    return { create, default: "none", books };
  }
  return { create, default: "none", books: [] };
}

export function publicPermissionDict(permission: BookPermission): Record<string, unknown> {
  return {
    create: permission.create,
    default: permission.default,
    books: Object.fromEntries(permission.books),
  };
}

export function canonicalBookPermission(raw: unknown): Record<string, unknown> {
  return publicPermissionDict(normalizeBookPermission(raw));
}

export function permissionForUser(user: CurrentUser): BookPermission {
  if (user.role === "admin") return { ...ADMIN_BOOK_PERMISSION, books: [] };
  const record = getUser(user.username) ?? {};
  return normalizeBookPermission(record["book_permission"]);
}
