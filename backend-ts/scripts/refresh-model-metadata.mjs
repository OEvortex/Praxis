#!/usr/bin/env node
/**
 * Refresh src/model-metadata.json from the models.dev catalog.
 *
 * Fetches https://models.dev/api.json and applies the same extraction logic
 * vtx's ``ContextLengthManager._parse_limits``
 * (vtx/ai/context_length.py) + ``parse_models_dev_reasoning_options``
 * (vtx/ai/thinking.py) use, then serialises the compact row format consumed
 * by src/model-metadata.ts:
 *
 *   { "<model_id>": [context, max_output_tokens, reasoning, vision, tools,
 *                    audio, effortsCsv] }
 *
 * Usage:
 *   node scripts/refresh-model-metadata.mjs            # fetch models.dev
 *   node scripts/refresh-model-metadata.mjs --from api.json   # offline input
 *   node scripts/refresh-model-metadata.mjs --out path.json   # custom output
 *
 * ``--from`` accepts a saved copy of the raw api.json payload (the same shape
 * ``~/.vtx/models_dev_limits.json`` caches), which is handy for testing or
 * when the network is unavailable.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const OUT_DEFAULT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "model-metadata.json",
);

// Mirrors vtx.ai.thinking: canonical level vocabulary, low-to-high.
const EXTENDED = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_LEVELS = EXTENDED.slice(1); // minimal..max
const ANTHROPIC_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};
const ANTHROPIC_MIN_BUDGET = 1024;
const BUDGET_PREFIX = "budget:";
const MISSING = Symbol("missing"); // vtx's _MISSING sentinel

function safeMaxOutputTokens(context) {
  // vtx.ai.context_length.safe_max_output_tokens
  if (context <= 128 * 1024) return 8192;
  if (context <= 256 * 1024) return 16384;
  return 32768;
}

function parseReasoningOptions(options, maxTokens = null) {
  // vtx.ai.thinking.parse_models_dev_reasoning_options +
  // _budget_level_map. Returns {level: effort|"budget:N"|null} or null.
  if (!options) return null;
  options = Array.isArray(options) ? [...options] : [];

  const supported = new Set();
  for (const option of options) {
    if (option && typeof option === "object" && option.type === "effort") {
      for (const value of option.values ?? []) {
        if (value !== null && value !== undefined) supported.add(String(value));
      }
    }
  }

  if (EFFORT_LEVELS.some((l) => supported.has(l)) || supported.has("none")) {
    const mapping = { off: supported.has("none") ? "none" : null };
    for (const level of EFFORT_LEVELS) {
      mapping[level] = supported.has(level) ? level : null;
    }
    return mapping;
  }

  const budget = options.find(
    (o) => o && typeof o === "object" && o.type === "budget_tokens",
  );
  if (!budget) return null;

  const minimum = Number(budget.min ?? ANTHROPIC_MIN_BUDGET) || ANTHROPIC_MIN_BUDGET;
  let ceiling = Number(budget.max ?? 0) || 0;
  if (maxTokens) {
    // budget_tokens must stay strictly below max_tokens.
    ceiling = Math.min(ceiling || maxTokens, maxTokens - ANTHROPIC_MIN_BUDGET);
  }
  const mapping = { off: "none" };
  for (const level of EFFORT_LEVELS) {
    const budgetTokens = ANTHROPIC_BUDGETS[level];
    const usable =
      budgetTokens >= Math.max(minimum, ANTHROPIC_MIN_BUDGET) &&
      (!ceiling || budgetTokens < ceiling);
    mapping[level] = usable ? `${BUDGET_PREFIX}${budgetTokens}` : null;
  }
  return mapping;
}

function supportedLevels(reasoning, levelMap) {
  // vtx.ai.thinking.get_supported_thinking_levels (catalog "off" spelling).
  if (!reasoning) return ["off"];
  const m = levelMap ?? {};
  const out = [];
  for (const level of EXTENDED) {
    const mapped = level in m ? m[level] : MISSING;
    if (mapped === null) continue; // explicitly unsupported
    if (level === "xhigh" || level === "max") {
      if (mapped !== MISSING) out.push(level);
      continue;
    }
    out.push(level);
  }
  return out;
}

function extractLimits(data) {
  // vtx ContextLengthManager._parse_limits flattened to the snapshot's
  // compact rows. Insertion-ordered; last write wins on duplicate ids.
  const limits = {};
  let skipped = 0;
  for (const providerData of Object.values(data ?? {})) {
    if (!providerData || typeof providerData !== "object") continue;
    const models = providerData.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, modelInfo] of Object.entries(models)) {
      if (!modelInfo || typeof modelInfo !== "object") continue;
      const limit = modelInfo.limit;
      if (
        !limit ||
        typeof limit !== "object" ||
        Object.keys(limit).length === 0
      ) {
        continue;
      }
      let context = Number(limit.context ?? 0) || 0;
      let output = Number(limit.output ?? 0) || 0;
      if (!(context > 0)) {
        skipped += 1;
        continue;
      }
      if (context - output <= 8192) {
        output = safeMaxOutputTokens(context);
      }
      const modalities = modelInfo.modalities ?? {};
      const inputMods = modalities.input ?? [];
      const outputMods = modalities.output ?? [];
      const levelMap = parseReasoningOptions(
        modelInfo.reasoning_options,
        output,
      );
      const reasoning = Boolean(modelInfo.reasoning ?? false);
      const vision = inputMods.includes("image");
      const tools = Boolean(modelInfo.tool_call ?? false);
      const audio = inputMods.includes("audio") || outputMods.includes("audio");
      const efforts = supportedLevels(reasoning, levelMap).map((l) =>
        l === "off" ? "none" : l,
      );
      limits[modelId] = [
        context,
        output,
        reasoning ? 1 : 0,
        vision ? 1 : 0,
        tools ? 1 : 0,
        audio ? 1 : 0,
        efforts.join(","),
      ];
    }
  }
  return { limits, skipped };
}

function parseArgs(argv) {
  const opts = { from: null, out: OUT_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") opts.from = argv[++i];
    else if (argv[i] === "--out") opts.out = argv[++i];
    else if (argv[i] === "-h" || argv[i] === "--help") opts.help = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "usage: node scripts/refresh-model-metadata.mjs [--from api.json] [--out path]",
    );
    return;
  }

  let data;
  if (opts.from) {
    data = JSON.parse(readFileSync(opts.from, "utf-8"));
    console.log(`loaded ${opts.from}`);
  } else {
    const resp = await fetch(MODELS_DEV_API_URL, {
      headers: { "user-agent": "praxis-backend/1.0" },
    });
    if (!resp.ok) {
      throw new Error(`models.dev fetch failed: HTTP ${resp.status}`);
    }
    data = await resp.json();
    console.log(`fetched ${MODELS_DEV_API_URL}`);
  }

  const { limits, skipped } = extractLimits(data);
  writeFileSync(opts.out, JSON.stringify(limits), "utf-8");
  console.log(
    `wrote ${opts.out}: ${Object.keys(limits).length} models ` +
      `(${skipped} skipped: no verified context window)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
