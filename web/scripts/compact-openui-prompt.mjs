#!/usr/bin/env node
/**
 * Condense the generated OpenUI system prompt.
 *
 * `openui generate` prints the library's `@functions` one per line with a full
 * description. That reference is already in `lib/openui/prompt-options.ts`
 * (`functionReference`), grouped and condensed, so this step removes the
 * generated copy — it is roughly 6k characters sent on every request.
 *
 * Component signatures are left untouched: those are the part that has to
 * follow the library exactly. If the marker check fails, the prompt no longer
 * carries a function reference and this script refuses to strip the only one.
 *
 * Run it after `openui generate`; `npm run openui:prompt` does both and copies
 * the chat prompt to the backend, which reads it as the agent's spec.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = resolve(here, "../lib/openui/generated");
const backendPrompt = resolve(here, "../../backend/app/agent/openui_prompt.txt");

const MARKER = "## Function Reference";
const SECTION = "## Built-in Functions";
const PROMPTS = ["system-prompt.txt", "dashboard-system-prompt.txt"];

/** Remove the one-line-per-function reference, keeping every other section. */
export function compactPrompt(text) {
  if (!text.includes(MARKER)) {
    throw new Error(
      `Refusing to compact: the prompt has no "${MARKER}" section, so the ${SECTION} section is the only function reference.`,
    );
  }
  const start = text.indexOf(SECTION);
  if (start === -1) return text;
  const next = text.indexOf("\n## ", start + SECTION.length);
  const end = next === -1 ? text.length : next + 1;
  return `${text.slice(0, start).trimEnd()}\n\n${text.slice(end).trimStart()}`;
}

async function main() {
  let chat = null;
  for (const file of PROMPTS) {
    const path = resolve(generatedDir, file);
    const compacted = compactPrompt(await readFile(path, "utf8"));
    await writeFile(path, compacted);
    if (file === "system-prompt.txt") chat = compacted;
    console.log(`Compacted ${file} (${compacted.length} chars)`);
  }
  if (process.argv.includes("--sync-backend") && chat) {
    await writeFile(backendPrompt, chat);
    console.log(`Copied system prompt to ${backendPrompt}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
