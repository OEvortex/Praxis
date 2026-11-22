// Route-table diff vs the UPSTREAM DeepTutor reference backend
// (/home/vortex/DeepTutor/reff/deeptutor), unlike route-table.ts which diffs
// against our older Python backend.
//
// Upstream routes come from two generated/declared sources:
//   * api/router_index.json  — per-router route patterns (path, methods, kind)
//     produced from the APIRouter decorators in api/routers/*.py
//   * modules/manifests/*.json — `routes[].reference` + `options.prefix`, i.e.
//     the include_router() prefixes applied by api/module_routes.py
//   * api/main.py            — app-level @app.get decorators ("", "/health", ...)
//   * api/module_routes.py   — mounts modules:router at /api/modules
//
// TS routes are regex-extracted from src/api/*.ts (`xxxRouter.METHOD("/path"`)
// and src/main.ts (`app.route("prefix", xRouter)` supplies the mount prefix,
// `app.METHOD("/path")` is app-level). Routes registered inside loops over
// method/path arrays are approximated — each literal `.METHOD(` call site is
// counted once.
//
// Run:  node scripts/route-table-upstream.mjs
// Writes /tmp/route-diff-upstream.txt and prints a summary.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_SRC = join(HERE, "..", "src");
const UP = "/home/vortex/DeepTutor/reff/deeptutor";
const OUT = "/tmp/route-diff-upstream.txt";

// -- canonicalisation ---------------------------------------------------------

function canon(path) {
  return path
    .split("/")
    .map((seg) => {
      if (seg === "*" || seg.startsWith(":") || /^\{[^}]*\}$/.test(seg)) return "{}";
      return seg;
    })
    .join("/");
}

const key = (r) => `${r.method} ${canon(r.path)}`;

// -- upstream routes ----------------------------------------------------------

function upstreamRoutes() {
  const index = JSON.parse(readFileSync(join(UP, "api/router_index.json"), "utf8"));
  const prefixes = new Map(); // "module:attr" -> prefix
  for (const file of readdirSync(join(UP, "modules/manifests"))) {
    if (!file.endsWith(".json")) continue;
    const manifest = JSON.parse(readFileSync(join(UP, "modules/manifests", file), "utf8"));
    for (const r of manifest.routes ?? []) {
      prefixes.set(r.reference, r.options?.prefix ?? "");
    }
  }
  // module_routes.py mounts the modules router directly (not via manifests).
  prefixes.set("deeptutor.api.routers.modules:router", "/api/modules");
  // unified_ws is mounted with prefix "" in its manifest already.

  const routes = [];
  const perRouter = {};
  for (const [ref, patterns] of Object.entries(index.routers)) {
    const prefix = prefixes.get(ref);
    if (prefix === undefined) {
      perRouter[ref] = { prefix: null, count: patterns.length, note: "NO PREFIX FOUND" };
      continue;
    }
    perRouter[ref] = { prefix, count: patterns.length };
    for (const p of patterns) {
      if (typeof p.path !== "string") continue;
      const path = prefix + p.path;
      if (p.kind === "websocket") {
        routes.push({ method: "WS", path, ref });
      } else {
        for (const m of p.methods ?? ["GET"]) {
          routes.push({ method: m.toUpperCase(), path, ref });
        }
      }
    }
  }

  // api/main.py app-level routes.
  const mainSrc = readFileSync(join(UP, "api/main.py"), "utf8");
  const appRe = /@app\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = appRe.exec(mainSrc))) {
    routes.push({ method: m[1].toUpperCase(), path: m[2], ref: "api/main.py" });
  }
  return { routes, perRouter };
}

// -- TS routes ---------------------------------------------------------------

function extractFileRoutes(file) {
  const src = readFileSync(file, "utf8");
  const routes = []; // {routerVar, method, path}
  const routerVars = new Set();
  // Router object names: `export const X = new Hono()` or `const X = new Hono()`
  // plus `export { a as b }` aliases resolved later.
  for (const m of src.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*new Hono/g)) {
    routerVars.add(m[1]);
  }
  const re = /(\w+)\.(get|post|put|delete|patch|all|on)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const [, obj, methodRaw] = m;
    if (!routerVars.has(obj)) continue;
    const method = methodRaw.toUpperCase();
    const head = src.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const strRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    const strings = [];
    let sm;
    while ((sm = strRe.exec(head))) strings.push(sm[2]);
    let path = strings.find((s) => s.startsWith("/"));
    if (!path) continue;
    if (method === "ALL" || method === "ON") {
      // `.on("HEAD", "/path")` — first string is a bare HTTP verb; the method
      // array form always starts the arg list with `[`. A `.on(method, ...)`
      // inside a for-of loop has neither → wildcard ALL.
      const trimmed = head.trimStart();
      const arr = trimmed.startsWith("[") ? trimmed.match(/\[([^\]]*)\]/) : null;
      const firstStr = strings[0];
      const verb =
        firstStr && /^[A-Z]+$/.test(firstStr) && firstStr.length <= 7 && firstStr !== path
          ? firstStr
          : null;
      let methods;
      if (arr) {
        methods = [...arr[1].matchAll(/["']([A-Z]+)["']/g)].map((x) => x[1]);
      } else if (verb) {
        methods = [verb];
      } else {
        methods = ["ALL"];
      }
      for (const meth of methods) routes.push({ routerVar: obj, method: meth, path });
    } else {
      routes.push({ routerVar: obj, method, path });
    }
  }
  return { routes, routerVars, src };
}

function tsRoutes() {
  const mainSrc = readFileSync(join(TS_SRC, "main.ts"), "utf8");

  // import { a, b as c } from "./api/file.js"
  const imports = new Map(); // exportName -> file
  for (const m of mainSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']\.\/api\/([\w]+)\.js["']/g)) {
    for (const part of m[1].split(",")) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      imports.set((as[1] ?? as[0]).trim(), `api/${m[2]}.ts`);
    }
  }
  // app.route("/prefix", exportName)
  const mounts = new Map(); // exportName -> prefix
  for (const m of mainSrc.matchAll(/app\.route\(\s*["']([^"']*)["']\s*,\s*(\w+)\s*\)/g)) {
    mounts.set(m[2], m[1]);
  }

  const routes = [];
  const notes = [];
  for (const file of readdirSync(join(TS_SRC, "api")).filter((f) => f.endsWith(".ts"))) {
    const abs = join(TS_SRC, "api", file);
    const { routes: fileRoutes, routerVars, src } = extractFileRoutes(abs);
    // export aliases: `export { a as b }` or `export const b = a`
    const exportOf = new Map(); // routerVar -> exportName
    for (const v of routerVars) exportOf.set(v, v);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(",")) {
        const p = part.trim();
        if (!p) continue;
        const as = p.split(/\s+as\s+/);
        const local = as[0].trim();
        const exported = (as[1] ?? as[0]).trim();
        if (routerVars.has(local)) exportOf.set(local, exported);
      }
    }
    for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*(\w+)\s*;/g)) {
      if (routerVars.has(m[2])) exportOf.set(m[2], m[1]);
    }
    // default export?
    for (const m of src.matchAll(/export\s+default\s+(\w+)\s*;?/g)) {
      if (routerVars.has(m[1])) exportOf.set(m[1], "default");
    }

    let unmounted = 0;
    for (const r of fileRoutes) {
      const exportName = exportOf.get(r.routerVar);
      const prefix = mounts.get(exportName) ?? mounts.get(r.routerVar) ?? null;
      if (prefix === null) {
        unmounted++;
        // Still count at face value (path may already be absolute).
        routes.push({ method: r.method, path: r.path, note: `unmounted:${r.routerVar}` });
      } else {
        // Many TS routers carry absolute "/api/..." paths and are mounted at
        // "/"; joining naively yields "//api/..." — collapse duplicate slashes.
        routes.push({ method: r.method, path: (prefix + r.path).replace(/\/{2,}/g, "/") });
      }
    }
    notes.push(
      `api/${file}: ${fileRoutes.length} route registrations, ${routerVars.size} routers` +
        (unmounted ? `, ${unmounted} on unmounted router vars` : ""),
    );
  }
  // app-level routes in main.ts
  const appRe = /\bapp\.(get|post|put|delete|patch|all)\(\s*["'`]([^"'`]+)["'`]/g;
  let am;
  while ((am = appRe.exec(mainSrc))) {
    routes.push({ method: am[1].toUpperCase(), path: am[2] });
  }
  // WS endpoints are attached outside Hono: ws_dispatch.ts matches upgrade
  // paths via `path === "/ws/..."` comparisons (attachAllWs in main.ts).
  try {
    const wsSrc = readFileSync(join(TS_SRC, "api/ws_dispatch.ts"), "utf8");
    const wsPaths = new Set();
    for (const m of wsSrc.matchAll(/["'](\/ws[^"']*)["']/g)) wsPaths.add(m[1]);
    for (const p of wsPaths) routes.push({ method: "WS", path: p, note: "ws_dispatch" });
    // legacy fallback: attachUnifiedWs(server, "/ws")
    const legacy = mainSrc.match(/attachUnifiedWs\([^,]+,\s*["']([^"']+)["']/);
    if (legacy) routes.push({ method: "WS", path: legacy[1], note: "attachUnifiedWs" });
  } catch { /* ws_dispatch may not exist yet */ }
  return { routes, notes };
}

// -- diff ---------------------------------------------------------------------

const { routes: upRoutes, perRouter } = upstreamRoutes();
const { routes: tsRoutesList, notes } = tsRoutes();

const upSet = new Map();
for (const r of upRoutes) upSet.set(key(r), r);
const tsSet = new Map();
for (const r of tsRoutesList) tsSet.set(key(r), r);
// WS upstream routes are covered by a same-path GET/WS in TS (Hono upgrades on GET).
const tsGetPaths = new Set(tsRoutesList.filter((r) => r.method === "GET").map((r) => canon(r.path)));
// Hono `.all()` / looped `.on(method, ...)` register a wildcard for every
// method on that path — treat "ALL" as covering any upstream method.
const tsAllPaths = new Set(tsRoutesList.filter((r) => r.method === "ALL").map((r) => canon(r.path)));

const missing = [...upSet.entries()].filter(([k, r]) => {
  if (tsSet.has(k)) return false;
  if (r.method === "WS" && tsGetPaths.has(canon(r.path))) return false;
  if (r.method !== "WS" && tsAllPaths.has(canon(r.path))) return false;
  return true;
});
const extra = [...tsSet.entries()].filter(([k]) => !upSet.has(k));

// Group missing by upstream router file for the gap report.
const byRouter = new Map();
for (const [, r] of missing) {
  const file = (r.ref ?? "?").split(":")[0].replace("deeptutor.api.routers.", "");
  if (!byRouter.has(file)) byRouter.set(file, []);
  byRouter.get(file).push(r);
}

const lines = [];
lines.push("Route-table diff: UPSTREAM DeepTutor (reff/) vs Hono (backend-ts)");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("Upstream router mounts (reference -> prefix):");
for (const [ref, info] of Object.entries(perRouter).sort()) {
  lines.push(`  ${ref}: prefix=${info.prefix ?? "MISSING"} patterns=${info.count}${info.note ? " " + info.note : ""}`);
}
lines.push("");
lines.push("TS extraction notes:");
for (const n of notes) lines.push(`  ${n}`);
lines.push("");
lines.push(`Upstream routes: ${upSet.size}`);
lines.push(`TS routes:       ${tsSet.size}`);
lines.push(`Coverage:        ${((upSet.size - missing.length) / upSet.size * 100).toFixed(1)}% (${upSet.size - missing.length}/${upSet.size})`);
lines.push(`Missing in TS:   ${missing.length}`);
lines.push(`Extra in TS:     ${extra.length}`);
lines.push("");
lines.push("Missing upstream routes, grouped by router file:");
for (const [file, rs] of [...byRouter.entries()].sort()) {
  lines.push(`  ${file} (${rs.length}):`);
  for (const r of rs.sort((a, b) => key(a).localeCompare(key(b)))) {
    lines.push(`    - ${r.method} ${r.path}`);
  }
}
lines.push("");
lines.push("Extra TS routes (first 200):");
for (const [, r] of extra.sort((a, b) => a[0].localeCompare(b[0])).slice(0, 200)) {
  lines.push(`  + ${r.method} ${r.path}${r.note ? "  # " + r.note : ""}`);
}

writeFileSync(OUT, lines.join("\n") + "\n");

console.log(`Report written to ${OUT}`);
console.log(`Upstream: ${upSet.size} | TS: ${tsSet.size} | Missing: ${missing.length} | Extra: ${extra.length}`);
console.log(`Coverage: ${((upSet.size - missing.length) / upSet.size * 100).toFixed(1)}%`);
console.log("\nMissing by router file:");
for (const [file, rs] of [...byRouter.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${file}: ${rs.length}`);
}
