import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(WEB_ROOT, "dist");
const INDEX_HTML_PATH = path.join(DIST_DIR, "index.html");
const ASSETS_DIR = path.join(DIST_DIR, "assets");

const ENTRY_JS_BUDGET_KB = 1_500;
const MAX_CHUNK_BUDGET_KB = 1_500;

function assertBuildPresent() {
  if (!fs.existsSync(INDEX_HTML_PATH) || !fs.existsSync(ASSETS_DIR)) {
    throw new Error("Missing dist build output. Run `bun run build` before `bun run perf:check`.");
  }
}

function extractEntryScripts(html) {
  const scripts = new Set();
  const patterns = [
    /<script[^>]+src="([^"]+\.js(?:\?[^"]*)?)"/g,
    /<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js(?:\?[^"]*)?)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const clean = match[1].split("?")[0].replace(/^\/+/, "");
      if (clean.startsWith("assets/") && clean.endsWith(".js")) {
        scripts.add(clean);
      }
    }
  }
  return scripts;
}

function kb(bytes) {
  return Math.round(bytes / 1024);
}

function printRow(label, sizeKb, budgetKb) {
  const failed = sizeKb > budgetKb;
  console.log(
    `${(failed ? "FAIL" : "OK").padEnd(4)} ${label.padEnd(47)} ${String(sizeKb).padStart(4)}KB / budget ${budgetKb}KB`,
  );
  return failed;
}

function main() {
  assertBuildPresent();
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const entryScripts = extractEntryScripts(html);

  let entryBytes = 0;
  for (const rel of entryScripts) {
    const fullPath = path.join(DIST_DIR, rel);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`dist/index.html references missing asset ${rel}`);
    }
    entryBytes += fs.statSync(fullPath).size;
  }

  const jsFiles = fs
    .readdirSync(ASSETS_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({
      name: `assets/${name}`,
      bytes: fs.statSync(path.join(ASSETS_DIR, name)).size,
    }))
    .sort((a, b) => b.bytes - a.bytes);

  const largest = jsFiles[0] ?? { name: "(none)", bytes: 0 };
  const totalBytes = jsFiles.reduce((sum, f) => sum + f.bytes, 0);

  console.log(`Vite dist budgets (${jsFiles.length} JS chunks, total ${kb(totalBytes)}KB):`);
  let failed = false;
  failed = printRow("entry-scripts (dist/index.html)", kb(entryBytes), ENTRY_JS_BUDGET_KB) || failed;
  failed = printRow(`largest-chunk (${largest.name})`, kb(largest.bytes), MAX_CHUNK_BUDGET_KB) || failed;

  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
