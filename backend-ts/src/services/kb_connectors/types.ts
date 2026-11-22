// Shared types/helpers for the knowledge-base connector surface.
// Mirrors the knowledge-base and RAG provider names.

export type AnyRecord = Record<string, any>;

// Provider ids (services/rag/factory.py)
export const DEFAULT_PROVIDER = "llamaindex";
export const IMA_PROVIDER = "ima";

// Retired provider ids. Kept as exported constants so stored kb_meta rows and
// the connector/probe code still parse; they are absent from KNOWN_PROVIDERS,
// so normalizeProviderName folds them back to the default.
export const GRAPHRAG_PROVIDER = "graphrag";
export const LIGHTRAG_PROVIDER = "lightrag";
export const PAGEINDEX_PROVIDER = "pageindex";
export const PAGEINDEX_OSS_PROVIDER = "pageindex_oss";
export const LIGHTRAG_SERVER_PROVIDER = "lightrag_server";
export const WEKNORA_PROVIDER = "weknora";
export const KIWIX_PROVIDER = "kiwix";

// Provider ids that still exist as stored data but have no engine behind
// them normalize to the default — see normalizeProviderName.
export const KNOWN_PROVIDERS = new Set([
  DEFAULT_PROVIDER,
  IMA_PROVIDER,
]);

// KB type discriminators (knowledge/kb_types.py)
export const OBSIDIAN_KB_TYPE = "obsidian";
export const LINKED_KB_TYPE = "linked";
export const IMA_KB_TYPE = "ima";
export const MARGINNOTE4_KB_TYPE = "marginnote4";
// Retired connector types kept only so existing kb_meta rows still parse as
// connected/read-only; nothing can create new ones.
export const LIGHTRAG_SERVER_KB_TYPE = "lightrag_server";
export const WEKNORA_KB_TYPE = "weknora";
export const KIWIX_KB_TYPE = "kiwix";

export const CONNECTED_KB_TYPES = new Set([
  OBSIDIAN_KB_TYPE,
  LINKED_KB_TYPE,
  LIGHTRAG_SERVER_KB_TYPE,
  IMA_KB_TYPE,
  WEKNORA_KB_TYPE,
  MARGINNOTE4_KB_TYPE,
  KIWIX_KB_TYPE,
]);

export function normalizeProviderName(name: unknown): string {
  const candidate = String(name ?? "").trim().toLowerCase();
  return KNOWN_PROVIDERS.has(candidate) ? candidate : DEFAULT_PROVIDER;
}

export function isConnectedKb(entry: unknown): boolean {
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    CONNECTED_KB_TYPES.has(String((entry as AnyRecord)["type"] ?? ""))
  );
}

export function supportsLocalRawFiles(entry: unknown): boolean {
  return (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    !isConnectedKb(entry)
  );
}

export function externalRootOf(entry: unknown): string | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  const rec = entry as AnyRecord;
  const v = rec["external_path"] ?? rec["vault_path"];
  return typeof v === "string" && v ? v : null;
}
