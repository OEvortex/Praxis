// Port of deeptutor/visualizers/{protocol,store,registry,builtin}.py — the
// per-user visualizer catalog, lifecycle and sandbox asset serving used by
// api/routers/visualizers.py.
//
// Storage layout (single-tenant backend):
//   <workspace_dir>/visualizers/<id>/visualizer.json + bundle files
//   <workspace_dir>/visualizers-state.json  {installed, disabled, uninstalled}
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { get_settings } from "../../config.js";
import { extractZip } from "../../shared/zip.js";

export class VisualizerStoreError extends Error {}

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ENTRIES = 200;
const MAX_RATIO = 100;
const ALLOWED_SUFFIXES = new Set([
  ".json", ".html", ".js", ".mjs", ".css", ".svg", ".png", ".jpg", ".jpeg",
  ".webp", ".woff2", ".wasm",
]);
const ID_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

export interface VisualizerManifest {
  id: string;
  version: string;
  display_name: string;
  description: string;
  author: string;
  subjects: string[];
  intents: string[];
  render_target: "native" | "iframe" | "artifact";
  native_renderer: string;
  renderer_entry: string;
  payload_format: string;
  payload_kind: "text" | "json";
  payload_schema: Record<string, unknown>;
  language_tag: string;
  prompt: string;
  agentic: boolean;
  core: boolean;
  default_installed: boolean;
  priority: number;
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter((s) => s.trim()) : [];
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

export function validateManifest(raw: unknown): VisualizerManifest {
  const m = (raw ?? {}) as Record<string, unknown>;
  const id = String(m.id ?? "").trim().toLowerCase();
  if (!ID_RE.test(id)) {
    throw new VisualizerStoreError("visualizer id must match [a-z][a-z0-9_.-]{1,63}");
  }
  const renderTarget = String(m.render_target ?? "native");
  if (!["native", "iframe", "artifact"].includes(renderTarget)) {
    throw new VisualizerStoreError("invalid render_target");
  }
  const nativeRenderer = String(m.native_renderer ?? "");
  const rendererEntry = String(m.renderer_entry ?? "").trim().replace(/\\/g, "/");
  if (renderTarget === "native" && !nativeRenderer) {
    throw new VisualizerStoreError("native visualizers require native_renderer");
  }
  if (renderTarget === "iframe" && !rendererEntry) {
    throw new VisualizerStoreError("iframe visualizers require renderer_entry");
  }
  if (rendererEntry) {
    const parts = rendererEntry.split("/");
    if (rendererEntry.startsWith("/") || parts.includes("..")) {
      throw new VisualizerStoreError("renderer_entry must be a safe relative path");
    }
  }
  const schema = (m.payload_schema ?? {}) as Record<string, unknown>;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new VisualizerStoreError("payload_schema must be an object");
  }
  const manifest: VisualizerManifest = {
    id,
    version: String(m.version ?? "1.0.0"),
    display_name: String(m.display_name ?? id),
    description: String(m.description ?? ""),
    author: String(m.author ?? "DeepTutor"),
    subjects: strList(m.subjects),
    intents: strList(m.intents),
    render_target: renderTarget as VisualizerManifest["render_target"],
    native_renderer: nativeRenderer,
    renderer_entry: rendererEntry,
    payload_format: String(m.payload_format ?? "text/plain"),
    payload_kind: m.payload_kind === "json" ? "json" : "text",
    payload_schema: schema,
    language_tag: String(m.language_tag ?? "text"),
    prompt: String(m.prompt ?? ""),
    agentic: bool(m.agentic, true),
    core: bool(m.core, false),
    default_installed: bool(m.default_installed, true),
    priority: Number.isFinite(Number(m.priority)) ? Number(m.priority) : 100,
  };
  return manifest;
}

// ---------------------------------------------------------------------------
// Built-in + bundled manifests (port of builtin.py public fields)
// ---------------------------------------------------------------------------

const GENERAL_PROMPT = `Generate the visualization itself, not an essay about it. Keep labels concise, use a coherent visual hierarchy, and include only elements that help the stated learning goal. The payload must be complete and directly renderable. Do not put Markdown fences around the payload passed to submit_visualization.`;

function coreManifest(partial: Partial<VisualizerManifest> & { id: string }): VisualizerManifest {
  return validateManifest({
    version: "1.0.0",
    author: "DeepTutor",
    subjects: ["general"],
    intents: [],
    render_target: "native",
    native_renderer: "",
    renderer_entry: "",
    payload_format: "text/plain",
    payload_kind: "text",
    payload_schema: {},
    language_tag: "text",
    prompt: GENERAL_PROMPT,
    agentic: true,
    core: true,
    default_installed: true,
    priority: 100,
    ...partial,
  });
}

export function coreVisualizers(): VisualizerManifest[] {
  return [
    coreManifest({
      id: "svg", display_name: "SVG",
      description: "Precise explanatory illustrations and custom diagrams.",
      subjects: ["general"], intents: ["explain", "illustrate", "compare"],
      native_renderer: "svg", payload_format: "image/svg+xml", language_tag: "svg",
      priority: 10,
      prompt: GENERAL_PROMPT + `\n\nReturn one well-formed raw <svg> element with xmlns and camel-case viewBox. Use a transparent background and the host classes t/th/ts, box, arr, leader, and c-gray/c-blue/c-teal/c-coral/c-purple/c-green/c-amber/c-red. Do not hardcode text colors. Include <title> and <desc>. Calculate positions before drawing; no labels, boxes or arrows may overlap or leave the viewBox.`,
    }),
    coreManifest({
      id: "mermaid", display_name: "Mermaid",
      description: "Structured flows, sequences, states, classes, ERDs and timelines.",
      subjects: ["general", "computer_science"], intents: ["structure", "flow", "sequence"],
      native_renderer: "mermaid", payload_format: "text/vnd.mermaid", language_tag: "mermaid",
      priority: 20,
      prompt: GENERAL_PROMPT + `\n\nReturn valid Mermaid DSL only. Pick the semantically correct diagram keyword. Use stable ASCII node IDs, short labels, and avoid reserved words as IDs. Prefer top-to-bottom layout for explanations and left-to-right for short processes.`,
    }),
    coreManifest({
      id: "mindmap", display_name: "Mind map",
      description: "Hierarchical topics and relationships rendered by Mermaid.",
      subjects: ["general"], intents: ["structure", "outline", "explain"],
      native_renderer: "mermaid", payload_format: "text/vnd.mermaid", language_tag: "mermaid",
      priority: 25,
      prompt: GENERAL_PROMPT + `\n\nReturn valid Mermaid mindmap DSL only. The first non-empty line must be \`mindmap\`, followed by exactly one root node and at least one child branch. Indent each hierarchy level consistently, keep labels short, and do not use Markdown fences, arrows, or flowchart node syntax.`,
    }),
    coreManifest({
      id: "chartjs", display_name: "Chart.js",
      description: "Standard quantitative charts rendered from strict JSON.",
      subjects: ["statistics", "general"], intents: ["compare", "trend", "distribution"],
      native_renderer: "chartjs", payload_format: "application/vnd.chartjs+json",
      payload_kind: "json", language_tag: "json", priority: 30,
      prompt: GENERAL_PROMPT + `\n\nReturn one strict JSON Chart.js configuration with type, data and options. Never include functions, comments, undefined, single-quoted strings or trailing commas. Choose a chart type that matches the comparison and label every series.`,
    }),
    coreManifest({
      id: "html", display_name: "Interactive HTML",
      description: "Self-contained interactive lessons, steppers and simulations.",
      subjects: ["general"], intents: ["interact", "simulate", "practice"],
      native_renderer: "html", payload_format: "text/html", language_tag: "html",
      priority: 40,
      prompt: GENERAL_PROMPT + `\n\nReturn a complete single-file HTML document. Put CSS and JavaScript inline. It runs in a null-origin sandbox. Use responsive sizing and semantic controls; do not navigate the parent. You may call sendPrompt(text) for a meaningful learner follow-up. Include an explanatory state, reset control and accessible labels for interactive elements.`,
    }),
    coreManifest({
      id: "manim_video", display_name: "Manim animation",
      description: "Server-rendered mathematical animation.",
      subjects: ["mathematics"], intents: ["animate", "derive"],
      render_target: "artifact", native_renderer: "math_animator",
      payload_format: "video/mp4", language_tag: "python", agentic: false,
      priority: 200, prompt: "Rendered by the dedicated Manim artifact pipeline.",
    }),
    coreManifest({
      id: "manim_image", display_name: "Manim storyboard",
      description: "Server-rendered mathematical storyboard image.",
      subjects: ["mathematics"], intents: ["storyboard", "derive"],
      render_target: "artifact", native_renderer: "math_animator",
      payload_format: "image/png", language_tag: "python", agentic: false,
      priority: 210, prompt: "Rendered by the dedicated Manim artifact pipeline.",
    }),
  ];
}

export function bundledVisualizers(): VisualizerManifest[] {
  return [
    validateManifest({
      id: "geogebra", version: "1.0.0", author: "DeepTutor",
      display_name: "GeoGebra",
      description: "Interactive geometry, functions, calculus, vectors and coordinate models.",
      subjects: ["mathematics", "physics"],
      intents: ["construct", "explore", "prove", "graph"],
      render_target: "native", native_renderer: "geogebra",
      payload_format: "application/vnd.geogebra.commands+json",
      payload_kind: "json", language_tag: "json",
      prompt: GENERAL_PROMPT + `\n\nReturn strict JSON with this shape:\n{"app_name":"geometry","commands":["A=(0,0)","..."],\n "view":{"x_min":-6,"x_max":6,"y_min":-4,"y_max":4}}\n\nUse app_name geometry for constructions, graphing for functions, and 3d only when three-dimensional manipulation is essential. Each command is one English GeoGebra command with explicit labels. Build dependent objects from independent draggable points so the construction remains mathematically meaningful when manipulated. Include the requested givens, constraints, key derived objects, measurements and concise captions. SetColor uses integer RGB components such as SetColor[A,31,119,180], never CSS or hex colors. Use SetLineThickness, SetPointSize, SetLabelVisible and SetLabelMode sparingly to make the teaching focus obvious. Choose view bounds that contain the whole construction with margin. Never fake a diagram with unrelated fixed coordinates when a dependent construction is possible.\nUse Text only with Text[<object>, <point>], Text[<object>, <point>, <boolean>], or Text[<object>, <point>, <boolean>, <boolean>]. A point must be one argument; for computed coordinates write Text["$x^2$", ((a+b)/2, a+b+0.8)], never Text["$x^2$", (a+b)/2, a+b+0.8]. Keep LaTeX dollar delimiters balanced and set the substitution and LaTeX-formula booleans explicitly when using the four-argument form.`,
      agentic: true, core: false, default_installed: false, priority: 5,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Store + registry
// ---------------------------------------------------------------------------

interface Plugin {
  manifest: VisualizerManifest;
  origin: "core" | "bundled" | "user";
  root: string;
}

interface VizState {
  installed: string[];
  disabled: string[];
  uninstalled: string[];
}

function roots() {
  const ws = resolve(get_settings().workspace_dir);
  return {
    root: join(ws, "visualizers"),
    stateFile: join(ws, "visualizers-state.json"),
  };
}

export class VisualizerStore {
  root: string;
  stateFile: string;

  constructor(root?: string, stateFile?: string) {
    const r = roots();
    this.root = root ?? r.root;
    this.stateFile = stateFile ?? r.stateFile;
  }

  state(): VizState {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8"));
      return {
        installed: strList(raw?.installed),
        disabled: strList(raw?.disabled),
        uninstalled: strList(raw?.uninstalled),
      };
    } catch {
      return { installed: [], disabled: [], uninstalled: [] };
    }
  }

  saveState(state: VizState): void {
    const normalized = {
      installed: [...new Set(state.installed)].sort(),
      disabled: [...new Set(state.disabled)].sort(),
      uninstalled: [...new Set(state.uninstalled)].sort(),
    };
    mkdirSync(join(this.stateFile, ".."), { recursive: true });
    const tmp = this.stateFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(normalized, null, 2) + "\n");
    renameSync(tmp, this.stateFile);
  }

  setEnabled(id: string, enabled: boolean): void {
    const state = this.state();
    const disabled = new Set(state.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    state.disabled = [...disabled];
    this.saveState(state);
  }

  setBundledInstalled(id: string, installed: boolean): void {
    const state = this.state();
    const explicit = new Set(state.installed);
    const uninstalled = new Set(state.uninstalled);
    const disabled = new Set(state.disabled);
    if (installed) {
      explicit.add(id);
      uninstalled.delete(id);
      disabled.delete(id);
    } else {
      explicit.delete(id);
      uninstalled.add(id);
      disabled.delete(id);
    }
    state.installed = [...explicit];
    state.uninstalled = [...uninstalled];
    state.disabled = [...disabled];
    this.saveState(state);
  }

  userPackages(): { manifest: VisualizerManifest; root: string }[] {
    if (!existsSync(this.root)) return [];
    const out: { manifest: VisualizerManifest; root: string }[] = [];
    for (const child of readdirSync(this.root).sort()) {
      const dir = join(this.root, child);
      const manifestFile = join(dir, "visualizer.json");
      try {
        if (!statSync(dir).isDirectory() || !existsSync(manifestFile)) continue;
        if (statSync(manifestFile).size > MAX_MANIFEST_BYTES) continue;
        const manifest = validateManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
        this.validateImportedManifest(manifest, dir);
        out.push({ manifest, root: resolve(dir) });
      } catch {
        continue; // broken package ignored by discovery
      }
    }
    return out;
  }

  installArchive(archivePath: string, reservedIds?: Set<string>): VisualizerManifest {
    mkdirSync(this.root, { recursive: true });
    if (statSync(archivePath).size > MAX_ARCHIVE_BYTES) {
      throw new VisualizerStoreError("visualizer package exceeds 25 MB");
    }
    return installArchiveSync(archivePath, this.root, reservedIds);
  }

  uninstallUser(id: string): void {
    const target = resolve(this.root, id);
    if (!target.startsWith(resolve(this.root) + sep) || target === resolve(this.root)) {
      throw new VisualizerStoreError("invalid visualizer id");
    }
    if (!existsSync(join(target, "visualizer.json"))) {
      throw new VisualizerStoreError(`user visualizer not found: ${id}`);
    }
    rmSync(target, { recursive: true, force: true });
    const state = this.state();
    state.disabled = state.disabled.filter((d) => d !== id);
    state.installed = state.installed.filter((d) => d !== id);
    this.saveState(state);
  }

  assetPath(id: string, relativePath: string): string {
    const pkg = resolve(this.root, id);
    const candidate = resolve(pkg, relativePath);
    if (
      !existsSync(pkg) ||
      !statSync(pkg).isDirectory() ||
      !candidate.startsWith(pkg + sep) ||
      !existsSync(candidate) ||
      !statSync(candidate).isFile()
    ) {
      throw new VisualizerStoreError("visualizer asset not found");
    }
    return candidate;
  }

  private validateImportedManifest(manifest: VisualizerManifest, root: string): void {
    manifest.core = false;
    manifest.default_installed = false;
    if (manifest.render_target !== "iframe") {
      throw new VisualizerStoreError("imported visualizers must use the sandboxed iframe render target");
    }
    const entry = resolve(root, manifest.renderer_entry);
    const rootResolved = resolve(root);
    if (!entry.startsWith(rootResolved + sep) || !existsSync(entry) || !statSync(entry).isFile()) {
      throw new VisualizerStoreError("renderer_entry does not exist in the package");
    }
    if (!entry.toLowerCase().endsWith(".html")) {
      throw new VisualizerStoreError("renderer_entry must be an HTML file");
    }
  }
}

function installArchiveSync(archivePath: string, root: string, reservedIds?: Set<string>): VisualizerManifest {
  const data = readFileSync(archivePath);
  const tmp = mkdtempSync(join(tmpdir(), "dtviz-"));
  try {
    extractZip(data, tmp, {
      maxBytes: MAX_ARCHIVE_BYTES,
      maxEntries: MAX_ENTRIES,
      maxEntryBytes: MAX_ENTRY_BYTES,
      maxRatio: MAX_RATIO,
      allowedSuffixes: ALLOWED_SUFFIXES,
    });
    // Locate package root: visualizer.json at top or single subdir.
    let packageRoot = tmp;
    if (!existsSync(join(tmp, "visualizer.json"))) {
      const dirs = readdirSync(tmp).filter((d) => statSync(join(tmp, d)).isDirectory() && !d.startsWith("."));
      if (dirs.length === 1 && existsSync(join(tmp, dirs[0], "visualizer.json"))) {
        packageRoot = join(tmp, dirs[0]);
      } else {
        throw new VisualizerStoreError("package must contain visualizer.json at its root");
      }
    }
    const manifestPath = join(packageRoot, "visualizer.json");
    if (statSync(manifestPath).size > MAX_MANIFEST_BYTES) {
      throw new VisualizerStoreError("visualizer.json exceeds 128 KB");
    }
    const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    // Host-owned install policy + iframe-only imports.
    manifest.core = false;
    manifest.default_installed = false;
    if (manifest.render_target !== "iframe") {
      throw new VisualizerStoreError("imported visualizers must use the sandboxed iframe render target");
    }
    if (reservedIds?.has(manifest.id)) {
      throw new VisualizerStoreError(`visualizer id is reserved by the host: ${manifest.id}`);
    }
    const rootResolved = resolve(root);
    const destination = resolve(rootResolved, manifest.id);
    if (!destination.startsWith(rootResolved + sep)) {
      throw new VisualizerStoreError("visualizer id escapes the installation root");
    }
    if (existsSync(destination)) {
      throw new VisualizerStoreError(`visualizer already installed: ${manifest.id}`);
    }
    const entry = resolve(packageRoot, manifest.renderer_entry);
    if (!entry.startsWith(resolve(packageRoot) + sep) || !existsSync(entry) || !statSync(entry).isFile()) {
      throw new VisualizerStoreError("renderer_entry does not exist in the package");
    }
    if (!entry.toLowerCase().endsWith(".html")) {
      throw new VisualizerStoreError("renderer_entry must be an HTML file");
    }
    // Copy package into a staging dir then rename into place.
    const staging = join(rootResolved, `.${manifest.id}-${randomBytes(4).toString("hex")}`);
    mkdirSync(staging, { recursive: true });
    try {
      for (const item of readdirSync(packageRoot)) {
        const src = join(packageRoot, item);
        const dst = join(staging, item);
        if (statSync(src).isDirectory()) {
          cpDirSync(src, dst);
        } else {
          writeFileSync(dst, readFileSync(src));
        }
      }
      renameSync(staging, destination);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return manifest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function cpDirSync(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const item of readdirSync(src)) {
    const s = join(src, item);
    const d = join(dst, item);
    if (statSync(s).isDirectory()) cpDirSync(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

import { mkdtempSync } from "node:fs";

export class VisualizerRegistry {
  store: VisualizerStore;
  private catalog = new Map<string, Plugin>();
  private installed = new Set<string>();
  private enabled = new Set<string>();

  constructor(store?: VisualizerStore) {
    this.store = store ?? new VisualizerStore();
    this.reload();
  }

  reload(): void {
    const state = this.store.state();
    const explicit = new Set(state.installed);
    const disabled = new Set(state.disabled);
    const uninstalled = new Set(state.uninstalled);
    const catalog = new Map<string, Plugin>();
    const installed = new Set<string>();

    for (const manifest of coreVisualizers()) {
      catalog.set(manifest.id, { manifest, origin: "core", root: "" });
      installed.add(manifest.id);
    }
    for (const manifest of bundledVisualizers()) {
      if (!catalog.has(manifest.id)) {
        catalog.set(manifest.id, { manifest, origin: "bundled", root: "" });
      }
      if (explicit.has(manifest.id) || (manifest.default_installed && !uninstalled.has(manifest.id))) {
        installed.add(manifest.id);
      }
    }
    for (const { manifest, root } of this.store.userPackages()) {
      if (catalog.has(manifest.id)) continue;
      catalog.set(manifest.id, { manifest, origin: "user", root });
      installed.add(manifest.id);
    }

    this.catalog = catalog;
    this.installed = installed;
    this.enabled = new Set([...installed].filter((id) => !disabled.has(id)));
  }

  catalogList(): Plugin[] {
    return [...this.catalog.values()].sort((a, b) => a.manifest.priority - b.manifest.priority);
  }

  get(id: string, requireEnabled = true): Plugin | null {
    const plugin = this.catalog.get(String(id ?? "").trim().toLowerCase());
    if (!plugin) return null;
    if (!this.installed.has(plugin.manifest.id)) return null;
    if (requireEnabled && !this.enabled.has(plugin.manifest.id)) return null;
    return plugin;
  }

  publicCatalog(): Record<string, unknown>[] {
    return this.catalogList().map((plugin) => {
      const { prompt: _prompt, ...rest } = plugin.manifest;
      return {
        ...rest,
        origin: plugin.origin,
        installed: this.installed.has(plugin.manifest.id),
        enabled: this.enabled.has(plugin.manifest.id),
        uninstallable: !plugin.manifest.core,
      };
    });
  }

  setEnabled(id: string, enabled: boolean): void {
    const vid = String(id ?? "").trim().toLowerCase();
    const plugin = this.catalog.get(vid);
    if (!plugin || !this.installed.has(plugin.manifest.id)) {
      throw new VisualizerStoreError(`visualizer is not installed: ${vid}`);
    }
    this.store.setEnabled(vid, enabled);
    this.reload();
  }

  installBundled(id: string): void {
    const vid = String(id ?? "").trim().toLowerCase();
    const plugin = this.catalog.get(vid);
    if (!plugin || plugin.origin !== "bundled") {
      throw new VisualizerStoreError(`bundled visualizer not found: ${vid}`);
    }
    this.store.setBundledInstalled(vid, true);
    this.reload();
  }

  uninstall(id: string): void {
    const vid = String(id ?? "").trim().toLowerCase();
    const plugin = this.catalog.get(vid);
    if (!plugin) throw new VisualizerStoreError(`visualizer not found: ${vid}`);
    if (plugin.manifest.core) {
      throw new VisualizerStoreError("core visualizers cannot be uninstalled; disable them");
    }
    if (plugin.origin === "bundled") {
      this.store.setBundledInstalled(vid, false);
    } else if (plugin.origin === "user") {
      this.store.uninstallUser(vid);
    }
    this.reload();
  }

  installArchive(archivePath: string): Plugin {
    const manifest = this.store.installArchive(
      archivePath,
      new Set(this.catalog.keys()),
    );
    this.reload();
    const plugin = this.get(manifest.id);
    if (!plugin) throw new VisualizerStoreError("installed visualizer was not discoverable");
    return plugin;
  }

  assetPath(id: string, relativePath: string): string {
    const plugin = this.get(id);
    if (!plugin || plugin.origin !== "user") {
      throw new VisualizerStoreError("visualizer asset not found");
    }
    return this.store.assetPath(plugin.manifest.id, relativePath);
  }
}

let _registry: VisualizerRegistry | null = null;
export function get_visualizer_registry(): VisualizerRegistry {
  // Single-tenant: one registry per process is fine (upstream keys by user).
  _registry ??= new VisualizerRegistry();
  return _registry;
}
