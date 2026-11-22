#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(webRoot, "node_modules", "tsrs", "bin", "tsrs");

const result = spawnSync(
  process.execPath,
  [binPath, "--noEmit", "--incremental", "false", ...process.argv.slice(2)],
  { cwd: webRoot, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
