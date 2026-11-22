// read-only "is there a ready index in this folder" probing for linked KBs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AnyRecord } from "./types.js";
import {
  DEFAULT_PROVIDER,
  GRAPHRAG_PROVIDER,
  LIGHTRAG_PROVIDER,
  PAGEINDEX_OSS_PROVIDER,
  PAGEINDEX_PROVIDER,
  normalizeProviderName,
} from "./types.js";

const VERSION_RE = /^version-(\d+)$/;
const META_FILENAME = "meta.json";
const LEGACY_VERSION_DIRNAME = "versions";
const LEGACY_STORAGE_DIRNAME = "llamaindex_storage";

function readJson(path: string): AnyRecord | null {
  try {
    const payload: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as AnyRecord)
      : null;
  } catch {
    return null;
  }
}

function isStorageReady(storageDir: string): boolean {
  try {
    if (!statSync(storageDir).isDirectory()) return false;
    return readdirSync(storageDir).some((n) => n !== META_FILENAME);
  } catch {
    return false;
  }
}

function flatVersionDirs(kbDir: string): string[] {
  let children: string[];
  try {
    if (!statSync(kbDir).isDirectory()) return [];
    children = readdirSync(kbDir);
  } catch {
    return [];
  }
  return children
    .filter((n) => VERSION_RE.test(n))
    .map((n) => join(kbDir, n))
    .sort(
      (a, b) =>
        Number(VERSION_RE.exec(a.split("/").pop()!)![1]) -
        Number(VERSION_RE.exec(b.split("/").pop()!)![1]),
    );
}

function entryFromFlatVersion(versionDir: string): AnyRecord {
  const storedMeta = readJson(join(versionDir, META_FILENAME));
  const meta: AnyRecord = { ...(storedMeta ?? {}) };
  meta["version"] = meta["version"] ?? versionDir.split("/").pop();
  meta["signature"] = meta["signature"] ?? meta["version"];
  const hasProviderOutput = isStorageReady(versionDir);
  const isUnpublishedLightragCandidate =
    storedMeta === null &&
    (existsSync(join(versionDir, "kv_store_doc_status.json")) ||
      existsSync(join(versionDir, "deeptutor_ingress")));
  let ready = hasProviderOutput && !isUnpublishedLightragCandidate;
  if (existsSync(join(versionDir, ".building.json"))) {
    ready = ready && storedMeta?.["state"] === "published";
  }
  if (storedMeta?.["provider"] === "lightrag") {
    const adapterSchema = storedMeta["lightrag_adapter_schema"];
    if (adapterSchema !== undefined && adapterSchema !== null) {
      ready = Boolean(
        adapterSchema === 2 &&
          storedMeta["state"] === "published" &&
          nativeLightragOutputReady(versionDir, storedMeta),
      );
    }
  }
  meta["ready"] = ready;
  meta["storage_path"] = versionDir;
  meta["version_path"] = versionDir;
  meta["layout"] = "flat";
  return meta;
}

function nativeLightragOutputReady(versionDir: string, meta: AnyRecord): boolean {
  const workspace = String(meta["workspace"] ?? "").trim();
  let statusPath: string;
  if (workspace) {
    const wsName = workspace.split("/").pop() ?? "";
    if (workspace.includes("/") || workspace.includes("..") || wsName !== workspace) {
      return false;
    }
    statusPath = join(versionDir, workspace, "kv_store_doc_status.json");
  } else {
    statusPath = join(versionDir, "kv_store_doc_status.json");
  }
  const payload = readJson(statusPath);
  if (!payload) return false;
  return Object.values(payload).some((row) => {
    if (row === null || typeof row !== "object") return false;
    const r = row as AnyRecord;
    const status = String(r["status"] ?? "").toLowerCase();
    return (
      ["processed", "completed", "done", "success", "indexed"].includes(status) ||
      (Array.isArray(r["chunks_list"]) && r["chunks_list"].length > 0)
    );
  });
}

function entryFromLegacyNested(kbDir: string, versionDir: string): AnyRecord {
  const storage = join(versionDir, LEGACY_STORAGE_DIRNAME);
  const meta = readJson(join(versionDir, META_FILENAME)) ?? {
    signature: versionDir.split("/").pop(),
  };
  meta["version"] = meta["version"] ?? versionDir.split("/").pop();
  meta["signature"] = meta["signature"] ?? meta["version"];
  meta["ready"] = isStorageReady(storage);
  meta["storage_path"] = storage;
  meta["version_path"] = versionDir;
  meta["layout"] = "nested_legacy";
  meta["legacy"] = true;
  meta["kb_path"] = kbDir;
  return meta;
}

function entryFromRootLegacy(kbDir: string): AnyRecord {
  const storage = join(kbDir, LEGACY_STORAGE_DIRNAME);
  return {
    signature: "legacy",
    version: "legacy",
    ready: isStorageReady(storage),
    storage_path: storage,
    version_path: storage,
    layout: "root_legacy",
    legacy: true,
  };
}

function sortVersions(versions: AnyRecord[]): AnyRecord[] {
  const key = (e: AnyRecord): [string, number, number] => {
    const layoutPriority = e["layout"] === "flat" ? 2 : 1;
    const m = VERSION_RE.exec(String(e["version"] ?? ""));
    return [String(e["created_at"] ?? ""), layoutPriority, m ? Number(m[1]) : 0];
  };
  return versions.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 3; i++) {
      const av = ka[i];
      const bv = kb[i];
      if (av === bv) continue;
      // newest-first: compare descending
      return av > bv ? -1 : 1;
    }
    return 0;
  });
}

/** list_kb_versions — newest first. */
export function listKbVersions(kbDir: string): AnyRecord[] {
  const versions: AnyRecord[] = [];
  for (const versionDir of flatVersionDirs(kbDir)) {
    try {
      versions.push(entryFromFlatVersion(versionDir));
    } catch {
      /* unreadable version skipped, same as upstream */
    }
  }
  const legacyRoot = join(kbDir, LEGACY_VERSION_DIRNAME);
  let legacyChildren: string[] = [];
  try {
    if (statSync(legacyRoot).isDirectory()) {
      legacyChildren = readdirSync(legacyRoot)
        .sort()
        .map((n) => join(legacyRoot, n));
    }
  } catch {
    legacyChildren = [];
  }
  for (const child of legacyChildren) {
    try {
      if (statSync(child).isDirectory()) {
        versions.push(entryFromLegacyNested(kbDir, child));
      }
    } catch {
      /* skip */
    }
  }
  const rootLegacy = join(kbDir, LEGACY_STORAGE_DIRNAME);
  try {
    if (statSync(rootLegacy).isDirectory() && readdirSync(rootLegacy).length > 0) {
      versions.push(entryFromRootLegacy(kbDir));
    }
  } catch {
    /* skip */
  }
  return sortVersions(versions);
}

// -- provider probes (index_probe.py subset) -------------------------------------

const GRAPHRAG_OUTPUT_TABLES = [
  "entities",
  "communities",
  "community_reports",
  "text_units",
  "relationships",
];
const LIGHTRAG_SUCCESS = new Set(["processed", "completed", "done", "success", "indexed"]);
const LIGHTRAG_FAILED = new Set(["failed", "error"]);

function llamaindexDocCount(docstorePath: string): number | null {
  const payload = readJson(docstorePath);
  if (!payload) return null;
  const data = payload["docstore/data"];
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? Object.keys(data as object).length
    : null;
}

function inspectProviderIndex(provider: string, storageDir: string | null): {
  ready: boolean;
  failureSummary: string;
  docCount: number | null;
  diagnostics: AnyRecord;
} {
  const fail = (summary: string, docCount: number | null = null) => ({
    ready: false,
    failureSummary: summary,
    docCount,
    diagnostics: {} as AnyRecord,
  });
  if (storageDir === null) return fail("No storage path recorded.");
  if (provider === PAGEINDEX_PROVIDER || provider === PAGEINDEX_OSS_PROVIDER) {
    // PageIndex manifests are cloud-side; a local folder only holds doc ids.
    const manifest = readJson(join(storageDir, "manifest.json"));
    const ids = manifest?.["doc_ids"] ?? manifest?.["documents"];
    if (!Array.isArray(ids) || !ids.length) {
      return fail("PageIndex manifest has no document ids.", 0);
    }
    return { ready: true, failureSummary: "", docCount: ids.length, diagnostics: {} };
  }
  if (provider === GRAPHRAG_PROVIDER) {
    const out = join(storageDir, "output");
    const tables = GRAPHRAG_OUTPUT_TABLES.filter((n) =>
      existsSync(join(out, `${n}.parquet`)),
    );
    if (!tables.length) {
      return fail("GraphRAG output has no core parquet tables.", null);
    }
    return {
      ready: true,
      failureSummary: "",
      docCount: null,
      diagnostics: { output_tables: tables },
    };
  }
  if (provider === LIGHTRAG_PROVIDER) {
    return inspectLightRag(storageDir);
  }
  return inspectLlamaIndex(storageDir);
}

function inspectLlamaIndex(storageDir: string): ReturnType<typeof inspectProviderIndex> {
  const fail = (summary: string, docCount: number | null = null) => ({
    ready: false,
    failureSummary: summary,
    docCount,
    diagnostics: {} as AnyRecord,
  });
  let isDir = false;
  try {
    isDir = statSync(storageDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return fail("LlamaIndex storage directory does not exist.");
  const docstore = join(storageDir, "docstore.json");
  const indexStore = join(storageDir, "index_store.json");
  const vectorStores = (() => {
    try {
      return readdirSync(storageDir).filter((n) => n.endsWith("vector_store.json"));
    } catch {
      return [] as string[];
    }
  })();
  const diagnostics: AnyRecord = { vector_stores: vectorStores };
  if (!existsSync(docstore)) {
    return { ...fail("Missing LlamaIndex docstore.json."), diagnostics };
  }
  const count = llamaindexDocCount(docstore);
  if (!existsSync(indexStore)) {
    return { ...fail("Missing LlamaIndex index_store.json.", count), diagnostics };
  }
  return { ready: true, failureSummary: "", docCount: count, diagnostics };
}

function lightragStoreRoot(rootDir: string): string {
  const root = rootDir;
  if (
    existsSync(join(root, "kv_store_doc_status.json")) ||
    (() => {
      try {
        return readdirSync(root).some((n) => /^vdb_.*\.json$/.test(n));
      } catch {
        return false;
      }
    })()
  ) {
    return root;
  }
  const meta = readJson(join(root, META_FILENAME));
  const workspace = String(meta?.["workspace"] ?? "").trim();
  if (workspace) {
    const wsName = workspace.split("/").pop() ?? "";
    if (!workspace.includes("/") && wsName === workspace) {
      const candidate = join(root, workspace);
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        /* fall through */
      }
    }
  }
  return root;
}

function readLightragDocStatus(rootDir: string): AnyRecord | null {
  return readJson(join(lightragStoreRoot(rootDir), "kv_store_doc_status.json"));
}

function lightragHasOutput(rootDir: string): boolean {
  const root = lightragStoreRoot(rootDir);
  try {
    if (!statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  const status = readLightragDocStatus(rootDir);
  if (status) {
    let sawFailure = false;
    for (const item of Object.values(status)) {
      if (item === null || typeof item !== "object") continue;
      const r = item as AnyRecord;
      const chunks = r["chunks_list"];
      if (Array.isArray(chunks) && chunks.length > 0) return true;
      const st = String(r["status"] ?? "").toLowerCase();
      if (LIGHTRAG_SUCCESS.has(st)) return true;
      if (LIGHTRAG_FAILED.has(st)) sawFailure = true;
    }
    if (sawFailure) return false;
  }
  try {
    for (const name of readdirSync(root)) {
      if (
        (/^vdb_.*\.json$/.test(name) || name === "kv_store_text_chunks.json") &&
        statSync(join(root, name)).size > 2
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function lightragDocCount(rootDir: string): number | null {
  const payload = readLightragDocStatus(rootDir);
  if (!payload) return null;
  let count = 0;
  for (const item of Object.values(payload)) {
    if (item === null || typeof item !== "object") continue;
    const r = item as AnyRecord;
    const chunks = r["chunks_list"];
    const st = String(r["status"] ?? "").toLowerCase();
    if ((Array.isArray(chunks) && chunks.length > 0) || LIGHTRAG_SUCCESS.has(st)) {
      count++;
    }
  }
  return count;
}

function lightragFailureSummary(rootDir: string, limit = 3): string {
  const payload = readLightragDocStatus(rootDir);
  if (!payload) return "";
  const failures: string[] = [];
  for (const item of Object.values(payload)) {
    if (item === null || typeof item !== "object") continue;
    const r = item as AnyRecord;
    const status = String(r["status"] ?? "").toLowerCase();
    const error = String(r["error_msg"] ?? "").trim();
    if (!LIGHTRAG_FAILED.has(status) && !error) continue;
    const name = String(r["file_path"] ?? "document").trim();
    failures.push(`${name}: ${error || status}`);
    if (failures.length >= limit) break;
  }
  return failures.join("; ");
}

function inspectLightRag(storageDir: string): ReturnType<typeof inspectProviderIndex> {
  const ready = lightragHasOutput(storageDir);
  return {
    ready,
    failureSummary: ready ? "" : lightragFailureSummary(storageDir),
    docCount: lightragDocCount(storageDir),
    diagnostics: {},
  };
}

function versionMatchesProvider(entry: AnyRecord, provider: string): boolean {
  const resolved = normalizeProviderName(provider);
  const entryProvider = String(entry["provider"] ?? "").trim().toLowerCase();
  const signature = String(entry["signature"] ?? "").trim().toLowerCase();
  if (resolved === DEFAULT_PROVIDER) {
    const synthetic = new Set([
      PAGEINDEX_PROVIDER,
      PAGEINDEX_OSS_PROVIDER,
      GRAPHRAG_PROVIDER,
      LIGHTRAG_PROVIDER,
      "lightrag-server",
      "ima",
      "weknora",
      "kiwix",
    ]);
    return (
      (entryProvider === "" || entryProvider === DEFAULT_PROVIDER) &&
      !synthetic.has(signature)
    );
  }
  return entryProvider === resolved || signature === resolved;
}

function inspectProviderVersion(
  entry: AnyRecord,
  provider: string,
): { ready: boolean; failureSummary: string; docCount: number | null; diagnostics: AnyRecord } {
  const resolved = normalizeProviderName(provider);
  const storagePath = entry["storage_path"];
  if (!storagePath) {
    return { ready: false, failureSummary: "No storage path recorded.", docCount: null, diagnostics: {} };
  }
  if (!versionMatchesProvider(entry, resolved)) {
    return {
      ready: false,
      failureSummary: "",
      docCount: null,
      diagnostics: {
        version_provider: entry["provider"],
        version_signature: entry["signature"],
        provider_mismatch: true,
      },
    };
  }
  return inspectProviderIndex(resolved, String(storagePath));
}

/** inspect_kb_versions — version entries annotated with probe readiness. */
export function inspectKbVersions(kbDir: string, provider: string): AnyRecord[] {
  const resolved = normalizeProviderName(provider);
  return listKbVersions(kbDir).map((entry) => {
    const adjusted = { ...entry };
    const probe = inspectProviderVersion(adjusted, resolved);
    adjusted["ready"] = probe.ready;
    if (probe.failureSummary) adjusted["failure_summary"] = probe.failureSummary;
    if (probe.docCount !== null) adjusted["doc_count"] = probe.docCount;
    if (Object.keys(probe.diagnostics).length) {
      adjusted["probe_diagnostics"] = probe.diagnostics;
    }
    return adjusted;
  });
}
