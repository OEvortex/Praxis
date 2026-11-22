// probe a local folder for a
// ready engine index before mounting it as a read-only ``linked`` KB.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { inspectKbVersions } from "./index_probe.js";
import {
  DEFAULT_PROVIDER,
  normalizeProviderName,
  type AnyRecord,
} from "./types.js";
import { collectSupportedFiles } from "./file_types.js";
import { createHash } from "node:crypto";

export const LINK_ROOTS_ENV = "DEEPTUTOR_LINKED_FOLDER_ROOTS";
export const LINKABLE_PROVIDERS = new Set([DEFAULT_PROVIDER]);

export class LinkedKbError extends Error {}

export function providerIsLinkable(provider: string): boolean {
  return LINKABLE_PROVIDERS.has(normalizeProviderName(provider));
}

function allowedLinkRoots(): string[] {
  const raw = (process.env[LINK_ROOTS_ENV] ?? "").trim();
  if (!raw) return [];
  return raw
    .split(":")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      try {
        return resolve(c.replace(/^~(?=$|\/)/, homedir()));
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : root + "/");
}

/** assert_path_allowed — resolve folder_path, enforce optional root allowlist. */
export function assertPathAllowed(folderPath: string): string {
  let folder = String(folderPath ?? "").trim();
  if (!folder) throw new LinkedKbError("folder_path is required.");
  if (folder.startsWith("~/")) folder = join(homedir(), folder.slice(2));
  else if (folder === "~") folder = homedir();
  if (!existsSync(folder)) {
    throw new LinkedKbError(`Folder does not exist: ${folder}`);
  }
  let isDir = false;
  try {
    isDir = statSync(folder).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new LinkedKbError(`Not a directory: ${folder}`);
  const resolved = resolve(folder);
  const roots = allowedLinkRoots();
  if (roots.length && !roots.some((root) => isWithin(resolved, root))) {
    throw new LinkedKbError(
      "This folder is outside the locations allowed for linking.",
    );
  }
  return resolved;
}

export interface ProbeResult {
  provider: string;
  external_path: string;
  ok: boolean;
  version: string | null;
  doc_count: number | null;
  embedding: {
    compatible: boolean | null;
    index_model: string | null;
    current_model: string | null;
  };
  warnings: string[];
  error: string | null;
}

function bestEffortDocCount(folder: string): number | null {
  const raw = join(folder, "raw");
  try {
    if (!statSync(raw).isDirectory()) return null;
    return collectSupportedFiles(raw, true).length || countAllFiles(raw);
  } catch {
    return null;
  }
}

function countAllFiles(dir: string): number {
  let count = 0;
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSyncSafe(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) count++;
    }
  };
  walk(dir);
  return count;
}

import { readdirSync as readdirSyncSafe } from "node:fs";

/** probe_linked_folder — never throws; ``error`` set means not linkable. */
export function probeLinkedFolder(
  folderPath: string,
  provider: string,
  embeddingSignature: { model: string | null; hash: string | null },
): ProbeResult {
  const resolved = normalizeProviderName(provider);
  let folder = String(folderPath ?? "");
  if (folder.startsWith("~/")) folder = join(homedir(), folder.slice(2));
  const result: ProbeResult = {
    provider: resolved,
    external_path: folder,
    ok: false,
    version: null,
    doc_count: null,
    embedding: { compatible: null, index_model: null, current_model: null },
    warnings: [],
    error: null,
  };

  if (!LINKABLE_PROVIDERS.has(resolved)) {
    result.error = `Engine '${resolved}' does not support linking an existing folder.`;
    return result;
  }
  if (!existsSync(folder)) {
    result.error = `Folder does not exist: ${folder}`;
    return result;
  }
  let isDir = false;
  try {
    isDir = statSync(folder).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    result.error = `Not a directory: ${folder}`;
    return result;
  }
  result.external_path = resolve(folder);

  const versions = inspectKbVersions(result.external_path, resolved);
  const ready = versions.filter((v) => v["ready"] === true);
  if (!ready.length) {
    const failure = versions
      .map((v) => String(v["failure_summary"] ?? "").trim())
      .find(Boolean);
    result.error =
      failure ||
      "No ready index found in this folder. Point at a knowledge base folder " +
        "that contains a built index (a 'version-N' directory).";
    return result;
  }

  const latest = ready[0];
  result.version = String(latest["version"] ?? "");
  checkEmbedding(resolved, latest, result, embeddingSignature);
  const docCount = latest["doc_count"];
  result.doc_count =
    typeof docCount === "number" && Number.isFinite(docCount)
      ? docCount
      : bestEffortDocCount(result.external_path);
  result.ok = result.error === null;
  return result;
}

function checkEmbedding(
  provider: string,
  version: AnyRecord,
  result: ProbeResult,
  current: { model: string | null; hash: string | null },
): void {
  const compat = result.embedding;
  compat.current_model = current.model;

  const indexHash =
    provider === DEFAULT_PROVIDER
      ? String(version["signature"] ?? "")
      : String(version["embedding_signature"] ?? "");
  const indexModel = version["embedding_model"] ?? version["model"] ?? null;
  compat.index_model = indexModel === null ? null : String(indexModel);

  if (current.hash === null) {
    compat.compatible = null;
    result.warnings.push(
      "No embedding model is configured, so embedding compatibility could not " +
        "be verified. Configure one under Settings before querying.",
    );
    return;
  }
  if (!indexHash) {
    compat.compatible = null;
    result.warnings.push(
      "This index does not record which embedding model built it. Make sure it " +
        "matches your current embedding model, or retrieval may fail.",
    );
    return;
  }
  compat.compatible = indexHash === current.hash;
  if (!compat.compatible) {
    const builtWith = compat.index_model || "a different model";
    result.warnings.push(
      `This index was built with ${builtWith}, which differs from your current ` +
        `embedding model (${compat.current_model}). Retrieval will not work until ` +
        "you switch back to the matching embedding model.",
    );
  }
}

/** md5 helper kept for parity with upstream folder ids. */
export function md5short(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex").slice(0, 8);
}
