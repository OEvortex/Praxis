#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { copyPdfjsAssets } from "./copy-pdfjs-assets.mjs";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const viteBin = path.join(
  webRoot,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);

const isEntry =
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (isEntry) {
  copyPdfjsAssets();
  const result = spawnSync(
    process.execPath,
    [viteBin, "build", ...process.argv.slice(2)],
    {
      cwd: webRoot,
      stdio: "inherit",
      env: process.env,
    },
  );
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
