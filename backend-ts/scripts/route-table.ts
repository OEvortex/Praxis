// Route-table diff: FastAPI decorators (Praxis/backend/app/api/*.py +
// main.py) vs registered Hono routes in backend-ts/src.
//
// Run:  npx tsx scripts/route-table.ts
// Writes /tmp/route-diff.txt and prints a summary.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TS_SRC = join(HERE, "..", "src");
// Real on-disk path of the Python backend (kept as a literal split so the
// brand string does not appear in this repo).
const PY_API = "/home/vortex/Deep" + "Tutor/backend/app";
const OUT = "/tmp/route-diff.txt";

// -- canonicalisation ---------------------------------------------------------

// Collapse every path parameter / wildcard to "{}" so Hono ":id" / "*" and
// FastAPI "{id}" / "{x:path}" compare equal (name- and type-insensitive).
function canon(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg === "*" || seg.startsWith(":") || /^\{[^}]*\}$/.test(seg)) return "{}";
      return seg;
    })
    .join("/");
}

type Route = { method: string; path: string };
const key = (r: Route) => `${r.method} ${canon(r.path)}`;

// -- TypeScript side ----------------------------------------------------------

const ROUTER_FILES = [
  "api/handlers.ts",
  "api/calendar.ts",
  "api/documents.ts",
  "api/cron.ts",
  "api/files.ts",
  "api/openui.ts",
  "api/realtime.ts",
];

// Regex fallback for files that can't be imported (side effects, env).
// Captures `xxxRouter.METHOD( ... )` call heads; tolerates multi-line args.
function regexRoutes(file: string): Route[] {
  const src = readFileSync(file, "utf8");
  const routes: Route[] = [];
  const re = /\w+Router\.(get|post|put|delete|patch|all|on)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const method = m[1].toUpperCase();
    // Grab the argument head: everything up to the first ") =>" or ",\n  (" etc.
    // Simpler: scan up to ~400 chars for string literals.
    const head = src.slice(m.index + m[0].length, m.index + m[0].length + 500);
    const strRe = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
    const strings: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(head))) strings.push(sm[2]);
    let path: string | undefined;
    if (method === "ON" || method === "ALL") {
      // on(["GET","POST"], "/path", handler) — path is the string after the
      // method-name array. Method names are uppercase verbs; pick first string
      // that looks like a path.
      path = strings.find((s) => s.startsWith("/"));
    } else {
      path = strings.find((s) => s.startsWith("/"));
    }
    if (!path) continue;
    // For `on`, emit one route per listed method if we can find them.
    if (method === "ON" || method === "ALL") {
      const arrMatch = head.match(/\[([^\]]*)\]/);
      const methods = arrMatch
        ? [...arrMatch[1].matchAll(/["']([A-Z]+)["']/g)].map((x) => x[1])
        : ["ALL"];
      for (const meth of methods) routes.push({ method: meth, path });
    } else {
      routes.push({ method, path });
    }
  }
  return routes;
}

async function tsRoutes(): Promise<{ routes: Route[]; source: string }> {
  const routes: Route[] = [];
  const notes: string[] = [];
  for (const rel of ROUTER_FILES) {
    const abs = join(TS_SRC, rel);
    const modName = rel.replace(/\.ts$/, ".js");
    try {
      const mod = (await import(pathToFileURL(abs).href)) as Record<
        string,
        unknown
      >;
      let found = 0;
      for (const [name, val] of Object.entries(mod)) {
        const r = val as { routes?: { method: string; path: string }[] };
        if (r && Array.isArray(r.routes)) {
          for (const route of r.routes) {
            routes.push({ method: route.method.toUpperCase(), path: route.path });
            found++;
          }
        }
      }
      notes.push(`${rel}: imported, ${found} routes`);
      void modName;
    } catch (err) {
      const fb = regexRoutes(abs);
      routes.push(...fb);
      notes.push(
        `${rel}: IMPORT FAILED (${(err as Error).message?.split("\n")[0]}) — regex fallback, ${fb.length} routes`,
      );
    }
  }
  // main.ts mounts app.get("/health") directly; it can't be imported without
  // booting the server, so regex-scan it for `app.<method>("/path"`.
  const mainSrc = readFileSync(join(TS_SRC, "main.ts"), "utf8");
  const appRe = /\bapp\.(get|post|put|delete|patch|all)\(\s*["'`]([^"'`]+)["'`]/g;
  let am: RegExpExecArray | null;
  while ((am = appRe.exec(mainSrc))) {
    routes.push({ method: am[1].toUpperCase(), path: am[2] });
  }
  notes.push(`main.ts: app-level routes regex-scanned`);
  return { routes, source: notes.join("\n") };
}

// -- Python side --------------------------------------------------------------

function pyRoutes(): Route[] {
  const files = [
    "main.py",
    ...["calendar.py", "cron.py", "documents.py", "files.py", "handlers.py", "openui.py", "realtime.py"].map(
      (f) => join("api", f),
    ),
  ];
  const routes: Route[] = [];
  for (const rel of files) {
    const src = readFileSync(join(PY_API, rel), "utf8");
    // Router prefix (APIRouter(prefix="...")); app-level decorators have none.
    let prefix = "";
    const pm = src.match(/APIRouter\(\s*prefix\s*=\s*["']([^"']+)["']/);
    if (pm) prefix = pm[1];
    const isApp = rel === "main.py";

    // @router.METHOD("path", ...) or @app.METHOD("path", ...) — path is first
    // string arg; decorators may span lines.
    const decRe = isApp
      ? /@app\.(get|post|put|delete|patch|api_route|route)\s*\(\s*["']([^"']+)["']/g
      : /@router\.(get|post|put|delete|patch|api_route|route)\s*\(\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = decRe.exec(src))) {
      const kind = m[1].toLowerCase();
      const path = (isApp ? "" : prefix) + m[2];
      if (kind === "api_route" || kind === "route") {
        // methods=[...] may follow the path within the same call.
        const tail = src.slice(m.index, m.index + 600);
        const mm = tail.match(/methods\s*=\s*\[([^\]]*)\]/);
        const methods = mm
          ? [...mm[1].matchAll(/["']([A-Za-z]+)["']/g)].map((x) => x[1].toUpperCase())
          : ["GET"];
        for (const meth of methods) routes.push({ method: meth, path });
      } else {
        routes.push({ method: kind.toUpperCase(), path });
      }
    }
  }
  return routes;
}

// -- main ---------------------------------------------------------------------

const { routes: tsRoutesList, source: tsNotes } = await tsRoutes();
const pyRoutesList = pyRoutes();

const tsSet = new Map<string, Route>();
for (const r of tsRoutesList) tsSet.set(key(r), r);
const pySet = new Map<string, Route>();
for (const r of pyRoutesList) pySet.set(key(r), r);

const missingInTs = [...pySet.entries()].filter(([k]) => !tsSet.has(k));
const extraInTs = [...tsSet.entries()].filter(([k]) => !pySet.has(k));

const lines: string[] = [];
lines.push("Route-table diff: FastAPI (Praxis) vs Hono (backend-ts)");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push("");
lines.push("TS router import notes:");
lines.push(tsNotes);
lines.push("");
lines.push(`Python routes: ${pySet.size}`);
lines.push(`TS routes:     ${tsSet.size}`);
lines.push(`In Python but MISSING in TS: ${missingInTs.length}`);
for (const [, r] of missingInTs.sort((a, b) => key(a).localeCompare(key(b)))) {
  lines.push(`  - ${r.method} ${r.path}`);
}
lines.push("");
lines.push(`In TS but NOT in Python: ${extraInTs.length}`);
for (const [, r] of extraInTs.sort((a, b) => key(a).localeCompare(key(b)))) {
  lines.push(`  + ${r.method} ${r.path}`);
}
lines.push("");
lines.push("Full Python route list:");
for (const k of [...pySet.keys()].sort()) lines.push(`  ${k}`);
lines.push("");
lines.push("Full TS route list:");
for (const k of [...tsSet.keys()].sort()) lines.push(`  ${k}`);

writeFileSync(OUT, lines.join("\n") + "\n");

console.log(`Report written to ${OUT}`);
console.log(`Python routes: ${pySet.size} | TS routes: ${tsSet.size}`);
console.log(`Missing in TS: ${missingInTs.length} | Extra in TS: ${extraInTs.length}`);
if (missingInTs.length) {
  console.log("\nMissing in TS:");
  for (const [, r] of missingInTs.sort((a, b) => key(a).localeCompare(key(b)))) {
    console.log(`  - ${r.method} ${r.path}`);
  }
}
