// stable embedding identity used by probe-folder compatibility checks.
import { createHash } from "node:crypto";
import type { Settings } from "../../config.js";
import * as providerConfig from "../../provider-config.js";
import type { AnyRecord } from "./types.js";

export interface EmbeddingSignature {
  binding: string;
  model: string;
  dimension: number;
  base_url: string;
  api_version: string;
  role_semantics?: string;
}

export function signatureHash(sig: EmbeddingSignature): string {
  const fields: Record<string, unknown> = {
    binding: sig.binding,
    model: sig.model,
    dimension: sig.dimension,
    base_url: sig.base_url,
    api_version: sig.api_version,
  };
  if (sig.role_semantics) fields["role_semantics"] = sig.role_semantics;
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

interface EmbeddingConfigLike {
  binding?: string;
  model?: string;
  dim?: number;
  base_url?: string;
  effective_url?: string;
  api_version?: string;
}

/** Resolve the active embedding config from our provider catalog. */
export async function embeddingConfigFromCatalog(
  settings: Settings,
): Promise<EmbeddingConfigLike | null> {
  try {
    const catalog = (await providerConfig.load_catalog(settings)) as AnyRecord;
    const services = (catalog["services"] ?? {}) as AnyRecord;
    const emb = services["embedding"] as AnyRecord | undefined;
    if (!emb) return null;
    const activeProfileId = emb["active_profile_id"] ?? emb["activeProfileId"];
    const activeModelId = emb["active_model_id"] ?? emb["activeModelId"];
    const profiles = (emb["profiles"] ?? []) as AnyRecord[];
    const profile =
      profiles.find((p) => p["id"] === activeProfileId) ?? profiles[0] ?? null;
    if (!profile) return null;
    const models = (profile["models"] ?? []) as AnyRecord[];
    const model =
      models.find((m) => m["id"] === activeModelId) ?? models[0] ?? null;
    return {
      binding: String(profile["provider"] ?? profile["binding"] ?? "").trim().toLowerCase(),
      model: String(model?.["id"] ?? activeModelId ?? "").trim(),
      dim: Number(model?.["dimension"] ?? model?.["dim"] ?? 0) || 0,
      base_url: String(
        profile["base_url"] ?? profile["baseUrl"] ?? model?.["base_url"] ?? "",
      ).trim(),
      api_version: String(profile["api_version"] ?? profile["apiVersion"] ?? "").trim(),
    };
  } catch {
    return null;
  }
}

export function signatureFromConfig(config: EmbeddingConfigLike): EmbeddingSignature {
  const binding = (config.binding ?? "").trim().toLowerCase();
  const roleSemantics = binding === "jina" ? "jina-task" : "";
  return {
    binding,
    model: (config.model ?? "").trim(),
    dimension: Math.trunc(Number(config.dim ?? 0) || 0),
    base_url: (config.effective_url ?? config.base_url ?? "").trim(),
    api_version: (config.api_version ?? "").trim(),
    role_semantics: roleSemantics,
  };
}

/** signature_from_embedding_config — null when no embedding is configured. */
export async function signatureFromEmbeddingConfig(
  settings: Settings,
): Promise<EmbeddingSignature | null> {
  const config = await embeddingConfigFromCatalog(settings);
  if (config === null) return null;
  return signatureFromConfig(config);
}
