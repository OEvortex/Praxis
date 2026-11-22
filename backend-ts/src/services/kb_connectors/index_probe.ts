// read-only "is there a ready index in this folder" probing for linked KBs.
//
// Only LlamaIndex indexes can be linked. Retired engines (GraphRAG, LightRAG,
// PageIndex, WeKnora, Kiwix) have no runtime in this deployment, so their
// on-disk layouts are not recognized as a ready local index.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AnyRecord } from "./types.js";

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
  let ready = isStorageReady(versionDir);
  if (existsSync(join(versionDir, ".building.json"))) {
    ready = ready && storedMeta?.["state"] === "published";
  }
  meta["ready"] = ready;
  meta["storage_path"] = versionDir;
  meta["version_path"] = versionDir;
  meta["layout"] = "flat";
  return meta;
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

// -- LlamaIndex readiness probe --------------------------------------------------

function docCountFromDocstore(docstorePath: string): number | null {
  const payload = readJson(docstorePath);
  if (!payload) return null;
  const data = payload["docstore/data"];
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? Object.keys(data as object).length
    : null;
}

function inspectLlamaIndex(entry: AnyRecord): {
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
  const storageDir = String(entry["storage_path"] ?? "");
  if (!storageDir) return fail("No storage path recorded.");
  let isDir = false;
  try {
    isDir = statSync(storageDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return fail("LlamaIndex storage directory does not exist.");
  const docstore = join(storageDir, "docstore.json");
  const indexStore = join(storageDir, "index_store.json");
  let vectorStores: string[] = [];
  try {
    vectorStores = readdirSync(storageDir).filter((n) => n.endsWith("vector_store.json"));
  } catch {
    /* ignore */
  }
  const diagnostics: AnyRecord = { vector_stores: vectorStores };
  if (!existsSync(docstore)) {
    return { ...fail("Missing LlamaIndex docstore.json."), diagnostics };
  }
  const count = docCountFromDocstore(docstore);
  if (!existsSync(indexStore)) {
    return { ...fail("Missing LlamaIndex index_store.json.", count), diagnostics };
  }
  return { ready: true, failureSummary: "", docCount: count, diagnostics };
}

/** inspect_kb_versions — version entries annotated with probe readiness. */
export function inspectKbVersions(_kbDir: string, _provider: string): AnyRecord[] {
  return listKbVersions(_kbDir).map((entry) => {
    const adjusted = { ...entry };
    // Retired engines left their marker in `provider`/`signature`; their index
    // layouts are not readable here, so treat those versions as not ready.
    const marker = String(entry["provider"] ?? entry["signature"] ?? "").toLowerCase();
    const retired =
      marker !== "" &&
      marker !== "llamaindex" &&
      marker !== "legacy" &&
      !VERSION_RE.test(marker);
    const probe = retired
      ? {
          ready: false,
          failureSummary: "This index was built by an engine that is no longer available.",
          docCount: null,
          diagnostics: {} as AnyRecord,
        }
      : inspectLlamaIndex(entry);
    adjusted["ready"] = probe.ready;
    if (probe.failureSummary) adjusted["failure_summary"] = probe.failureSummary;
    if (probe.docCount !== null) adjusted["doc_count"] = probe.docCount;
    if (Object.keys(probe.diagnostics).length) {
      adjusted["probe_diagnostics"] = probe.diagnostics;
    }
    return adjusted;
  });
}
