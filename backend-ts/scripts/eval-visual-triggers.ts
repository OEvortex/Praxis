#!/usr/bin/env -S npx tsx
/**
 * Evaluate whether the model reaches for Intelligent UI only when it should.
 *
 * Offline (default): verifies the fixture set and the prompt policy, no API
 * calls. `--live`: sends each fixture prompt through the app's real system
 * prompt and model, classifies the reply the same way the web app renders it,
 * and reports false-trigger / missed-trigger rates.
 *
 *   npx tsx scripts/eval-visual-triggers.ts
 *   npx tsx scripts/eval-visual-triggers.ts --live
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyRenderer } from "../src/agent/renderer.js";
import { build_praxis_prompt } from "../src/agent/prompt.js";
import { get_settings } from "../src/config.js";
import { load_catalog, resolve_runtime_model } from "../src/provider-config.js";


type Fixture = {
  id: string;
  category: string;
  prompt: string;
  expected: "markdown" | "ui";
  sample_output: string;
};

const here = dirname(fileURLToPath(import.meta.url));
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(here, "../tests/fixtures/visual-triggers.json"), "utf8"),
);
const live = process.argv.includes("--live");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 1) : 0;
const cases = limit ? fixtures.slice(0, limit) : fixtures;

let failures = 0;
for (const fixture of cases) {
  if (classifyRenderer(fixture.sample_output) !== fixture.expected) {
    console.error(`fixture ${fixture.id}: sample output classifies wrongly`);
    failures += 1;
  }
}
if (failures) process.exit(1);

if (!live) {
  console.log(`${cases.length} fixtures verified. Add --live to run them against the configured model.`);
  for (const f of cases) {
    console.log(`  ${f.expected.padEnd(8)} ${f.id.padEnd(24)} ${f.prompt}`);
  }
  process.exit(0);
}

const settings = get_settings();
// The saved catalog has no active selection in many setups — the chat sends
// one per turn. Use its first model for the eval when none is saved.
const selectionOverride = (() => {
  try {
    const cfg = load_catalog(settings) as {
      services?: { llm?: { profiles?: Array<{ id?: string; models?: Array<{ id?: string }> }> } };
    };
    const profile = cfg.services?.llm?.profiles?.[0];
    const model = profile?.models?.[0];
    if (profile?.id && model?.id) return { profile_id: profile.id, model_id: model.id };
  } catch {
    /* fall through */
  }
  return null;
})();
const resolved = resolve_runtime_model(
  settings,
  selectionOverride ? { llm_selection: selectionOverride } : null,
);
if (!resolved.base_url || !resolved.api_key) {
  console.error("No model/base URL configured — cannot run --live.");
  process.exit(1);
}
const system = build_praxis_prompt(
  { cwd: process.cwd(), declared_tools: () => [] },
  null,
  null,
);

// This model spends its whole completion budget on reasoning at temperature
// 0.1 with no effort cap, returning an empty message. Give the eval a sane
// budget and a low effort so a missed trigger is the model's choice, not an
// exhausted token counter.
async function ask(prompt: string): Promise<string> {
  const base = String(resolved.base_url).replace(/\/+$/, "");
  const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${resolved.api_key}`,
    },
    body: JSON.stringify({
      model: resolved.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 2500,
      temperature: 0.4,
      reasoning_effort: "low",
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: { text?: unknown }) => String(part.text ?? "")).join("");
  }
  return "";
}

let correct = 0;
let falseUi = 0;
let missedUi = 0;
for (const fixture of cases) {
  try {
    const reply = await ask(fixture.prompt);
    const actual = classifyRenderer(reply);
    const ok = actual === fixture.expected;
    if (ok) correct += 1;
    else if (actual === "ui") falseUi += 1;
    else missedUi += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"} ${fixture.id.padEnd(24)} expected=${fixture.expected.padEnd(8)} actual=${actual.padEnd(8)} ${reply.slice(0, 90).replace(/\s+/g, " ")}`,
    );
  } catch (error) {
    console.error(`ERROR ${fixture.id}: ${error instanceof Error ? error.message : String(error)}`);
    missedUi += 1;
  }
}
console.log(
  `\n${correct}/${cases.length} correct · false UI: ${falseUi} · missed UI: ${missedUi}`,
);
process.exit(correct === cases.length ? 0 : 1);
