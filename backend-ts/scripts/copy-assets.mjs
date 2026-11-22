// Copy runtime assets that tsc does not emit into dist/.
//
// These files are read at runtime via paths relative to the compiled module
// (import.meta.url), so `node dist/main.js` needs them next to the JS:
//   * src/provider-catalog.json            -> dist/provider-catalog.json
//   * src/model-metadata.json              -> dist/model-metadata.json
//   * src/agent/openui_prompt.txt          -> dist/agent/openui_prompt.txt
//   * src/agent/notebook_agent/prompts/    -> dist/agent/notebook_agent/prompts/
//   * src/agent/video_lesson/prompts/      -> dist/agent/video_lesson/prompts/
//   * src/agent/video_lesson/remotion/     -> dist/agent/video_lesson/remotion/
//     (package.json/package-lock.json for `npm ci`, kit.tsx/voice.ts/build.mjs/
//      render-platform.ts read by the video-lesson runtime)
//   * src/capabilities/*/prompts/          -> dist/capabilities/*/prompts/
//     (ask_questions/creator/explore_context/mastery/reading/solve resolve
//      prompts/<lang>/... via `new URL(..., import.meta.url)` + readFileSync;
//      handoff/notes prompts dirs are empty placeholders, no files to copy)
//   * src/services/platform/data/          -> dist/services/platform/data/
//     (cli-apps.json / mcp-curated.json read via __dirname in
//      services/platform/{misc,mcp}.ts)
//   * src/services/persona/presets/        -> dist/services/persona/presets/
//     (PERSONA.md files read via PRESETS_DIR in services/persona.ts)
//
// Not needed: src/services/memory/consolidator/prompts.ts embeds the upstream
// YAML prompt text as string literals (no fs reads at runtime).
//
// Dev mode (`tsx src/main.ts`) reads the sources directly and is unaffected.

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");

const FILES = [
  ["provider-catalog.json", "provider-catalog.json"],
  ["model-metadata.json", "model-metadata.json"],
  ["agent/openui_prompt.txt", "agent/openui_prompt.txt"],
];

const DIRS = [
  ["agent/notebook_agent/prompts", "agent/notebook_agent/prompts"],
  ["agent/video_lesson/prompts", "agent/video_lesson/prompts"],
  ["agent/video_lesson/remotion", "agent/video_lesson/remotion"],
  ["capabilities/ask_questions/prompts", "capabilities/ask_questions/prompts"],
  ["capabilities/creator/prompts", "capabilities/creator/prompts"],
  ["capabilities/explore_context/prompts", "capabilities/explore_context/prompts"],
  ["capabilities/mastery/prompts", "capabilities/mastery/prompts"],
  ["capabilities/reading/prompts", "capabilities/reading/prompts"],
  ["capabilities/solve/prompts", "capabilities/solve/prompts"],
  ["services/persona/presets", "services/persona/presets"],
  ["services/platform/data", "services/platform/data"],
];

if (!existsSync(DIST)) {
  console.error("copy-assets: dist/ not found — run `tsc` first.");
  process.exit(1);
}

for (const [from, to] of FILES) {
  const src = join(SRC, from);
  const dst = join(DIST, to);
  if (!existsSync(src)) {
    console.error(`copy-assets: missing source asset ${src}`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
}

for (const [from, to] of DIRS) {
  const src = join(SRC, from);
  const dst = join(DIST, to);
  if (!existsSync(src)) {
    console.error(`copy-assets: missing source asset dir ${src}`);
    process.exit(1);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
}

console.log("copy-assets: runtime assets copied to dist/");
