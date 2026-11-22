// Port of deeptutor/capabilities/ima/binding.py +
// services/rag/pipelines/ima/config.py — resolve which connected Tencent IMA
// libraries a turn can reach, and load credentials per call.
//
// Upstream derives bindings from selected knowledge bases via the KB
// registry; Praxis has no typed KB registry for remote providers, so bindings
// live in the SQLite kv store instead:
//
//   "ima_account" → { client_id, api_key }          account-level credentials
//   "ima_kbs"     → [{ ref, name, knowledge_base_id, client_id?, api_key? }]
//
// Credentials are deliberately *not* part of a binding — what a tool call
// carries is the KB reference; the credential pair is loaded at call time by
// resolveConfig, so no secret ever sits in tool kwargs.

import type { Settings } from "../../config.js";
import { get_state } from "../../store/database.js";
import { ImaNotConfiguredError, type ImaCredentials } from "./transport.js";

export const IMA_ACCOUNT_KEY = "ima_account";
export const IMA_KBS_KEY = "ima_kbs";

export interface ImaBinding {
  /** The reference as configured — what tools pass back. */
  kb_ref: string;
  /** Display name, used to match a model-supplied kb_name. */
  name: string;
  /** Which IMA library this KB reads. Not a secret. */
  knowledge_base_id: string;
  /** Optional per-KB credential override (wins over the account pair). */
  client_id?: string;
  api_key?: string;
}

export interface ImaConfig extends ImaCredentials {
  knowledge_base_id: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/** Every configured IMA library binding. */
export function imaBindings(settings: Settings): ImaBinding[] {
  const raw = get_state<unknown>(settings, IMA_KBS_KEY, []);
  if (!Array.isArray(raw)) return [];
  const out: ImaBinding[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const ref = str(item["ref"]) || str(item["name"]);
    const knowledge_base_id = str(item["knowledge_base_id"]);
    if (!ref || !knowledge_base_id || seen.has(ref)) continue;
    seen.add(ref);
    out.push({
      kb_ref: ref,
      name: str(item["name"]) || ref,
      knowledge_base_id,
      client_id: str(item["client_id"]) || undefined,
      api_key: str(item["api_key"]) || undefined,
    });
  }
  return out;
}

/** Account-level credential pair, or an empty one. Never raises. */
export function getAccountCredentials(settings: Settings): ImaCredentials {
  try {
    const data = get_state<unknown>(settings, IMA_ACCOUNT_KEY, {});
    if (!isRecord(data)) return { client_id: "", api_key: "" };
    return { client_id: str(data["client_id"]), api_key: str(data["api_key"]) };
  } catch {
    return { client_id: "", api_key: "" };
  }
}

export function isImaConfigured(settings: Settings): boolean {
  const creds = getAccountCredentials(settings);
  return Boolean(creds.client_id && creds.api_key);
}

/**
 * The binding a tool call targets, chosen from the configured libraries.
 * With one library the argument is optional; with several, an unmatched name
 * resolves to null so the tool can ask for a valid one.
 */
export function selectBinding(
  bindings: ImaBinding[],
  kbName?: unknown,
): ImaBinding | null {
  if (!bindings.length) return null;
  const requested = String(kbName ?? "").trim();
  if (!requested) return bindings.length === 1 ? bindings[0] : null;
  for (const binding of bindings) {
    if ([binding.kb_ref, binding.name, binding.knowledge_base_id].includes(requested)) {
      return binding;
    }
  }
  return bindings.length === 1 ? bindings[0] : null;
}

/**
 * Resolve a binding's connection config. The binding's own credential pair
 * wins; the account-level pair fills in what it omits. Raises
 * ImaNotConfiguredError when any required field is still missing.
 */
export function resolveConfig(
  settings: Settings,
  binding: ImaBinding,
  _forWrite = false,
): ImaConfig {
  const account = getAccountCredentials(settings);
  const client_id = binding.client_id || account.client_id;
  const api_key = binding.api_key || account.api_key;
  const missing = [
    ...(client_id ? [] : ["client ID"]),
    ...(api_key ? [] : ["API key"]),
    ...(binding.knowledge_base_id ? [] : ["knowledge base ID"]),
  ];
  if (missing.length) {
    throw new ImaNotConfiguredError(
      `IMA knowledge base '${binding.name}' is not fully connected ` +
        `(missing ${missing.join(", ")}). Add the IMA credentials under ` +
        `settings (kv keys '${IMA_ACCOUNT_KEY}' / '${IMA_KBS_KEY}').`,
    );
  }
  return {
    client_id,
    api_key,
    knowledge_base_id: binding.knowledge_base_id,
  };
}
