// Loader for the explore_context prompt set. Upstream ships one YAML per
// language with dotted keys (``loop.system``, ``status.exploring``, …); here
// each leaf is a ``.txt`` file under ``prompts/<lang>/`` and the dotted key is
// the relative path, so ``loop.system`` → ``loop.system.txt``.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_ROOT = fileURLToPath(new URL("./prompts", import.meta.url));

const _CACHE = new Map<string, Record<string, unknown>>();

function _load_lang(lang: string): Record<string, unknown> {
  const cached = _CACHE.get(lang);
  if (cached !== undefined) return cached;
  const dir = join(PROMPTS_ROOT, lang);
  const root: Record<string, unknown> = {};
  let files: string[] = [];
  try {
    files = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    _CACHE.set(lang, root);
    return root;
  }
  for (const rel of files) {
    if (!rel.endsWith(".txt")) continue;
    const key = rel.slice(0, -".txt".length);
    try {
      const text = readFileSync(join(dir, rel), "utf-8").trim();
      const parts = key.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        const next = node[part];
        node[part] =
          next !== null && typeof next === "object" && !Array.isArray(next)
            ? (next as Record<string, unknown>)
            : {};
        node = node[part] as Record<string, unknown>;
      }
      node[parts[parts.length - 1]] = text;
    } catch {
      // Missing/unreadable prompt leaf — _t() falls back to its default.
    }
  }
  _CACHE.set(lang, root);
  return root;
}

export function load_prompts(language: string): Record<string, unknown> {
  const lang = String(language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  return _load_lang(lang);
}

/** Dotted-key lookup mirroring explorer._t / the YAML ``prompts`` dict. */
export function prompt_text(
  prompts: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  let value: unknown = prompts;
  for (const part of key.split(".")) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return fallback;
    }
    const rec = value as Record<string, unknown>;
    if (!(part in rec)) return fallback;
    value = rec[part];
  }
  return typeof value === "string" ? value.trim() : fallback;
}
