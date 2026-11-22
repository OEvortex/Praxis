// Port of deeptutor/services/skill/service.py — SKILL.md package CRUD over a
// filesystem root (user layer) with an optional read-only builtin layer.
// Frontmatter parsing is a minimal YAML-subset reader (flat keys, [lists],
// nested one-level maps) — enough for the schema SKILL.md files use.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { get_settings, type Settings } from "../../config.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG_RE = /^[a-z0-9][a-z0-9\- _]{0,31}$/;
const DEFAULT_TAGS = ["style", "tool"];
const TAGS_FILE = ".tags.json";
const MAX_READ_CHARS = 100_000;

export class SkillError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export const SkillNotFoundError = (n: string) => new SkillError("not_found", `Skill not found: ${n}`);
export const SkillExistsError = (n: string) => new SkillError("exists", `Skill already exists: ${n}`);
export const SkillReadOnlyError = (n: string) => new SkillError("read_only", `Skill is read-only: ${n}`);
export const InvalidSkillNameError = (m: string) => new SkillError("invalid_name", m);
export const InvalidTagError = (m: string) => new SkillError("invalid_tag", m);
export const TagNotFoundError = (t: string) => new SkillError("tag_not_found", `Tag not found: ${t}`);
export const TagExistsError = (t: string) => new SkillError("tag_exists", `Tag already exists: ${t}`);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// -- minimal frontmatter ---------------------------------------------------------

function parse_scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "" ) return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((p) => parse_scalar(p));
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Parse `---\n<yaml>\n---` frontmatter into a flat-ish object. */
export function parse_frontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, unknown> = {};
  let currentKey = "";
  let currentMap: Record<string, unknown> | null = null;
  for (const line of m[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      const rest = kv[2].trim();
      if (rest === "") {
        // Could be a nested map or a following list; default to map, fix on use.
        currentMap = {};
        meta[currentKey] = currentMap;
      } else {
        meta[currentKey] = parse_scalar(rest);
        currentMap = null;
      }
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && currentKey) {
      const existing = meta[currentKey];
      if (Array.isArray(existing)) existing.push(parse_scalar(item[1]));
      else meta[currentKey] = [parse_scalar(item[1])];
      continue;
    }
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested && currentMap) {
      currentMap[nested[1]] = parse_scalar(nested[2]);
    }
  }
  // Fix keys that got a map but were actually lists of scalars handled above.
  return { meta, body: content.slice(m[0].length) };
}

// -- service ------------------------------------------------------------------------

export class SkillService {
  readonly root: string;
  private readonly builtinRoot: string | null;

  constructor(settings?: Settings, root?: string, builtinRoot?: string | null) {
    const s = settings ?? get_settings();
    this.root = root ?? join(s.workspace_dir, "skills");
    this.builtinRoot = builtinRoot === undefined ? join(s.data_dir, "skills", "builtin") : builtinRoot;
  }

  private validateName(name: string): string {
    const candidate = (name ?? "").trim().toLowerCase();
    if (!NAME_RE.test(candidate)) {
      throw InvalidSkillNameError("Skill name must match ^[a-z0-9][a-z0-9-]{0,63}$");
    }
    return candidate;
  }

  private normalizeTag(raw: unknown): string {
    const candidate = String(raw ?? "").trim().toLowerCase();
    if (!candidate) throw InvalidTagError("Tag name must not be empty.");
    if (!TAG_RE.test(candidate)) {
      throw InvalidTagError("Tag must match ^[a-z0-9][a-z0-9- _]{0,31}$ (letters/digits/dash/space/underscore).");
    }
    return candidate;
  }

  private dedupeTags(values: string[]): string[] {
    return [...new Set(values)];
  }

  private tagsFromMeta(meta: Record<string, unknown>): string[] {
    const raw = meta["tags"];
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
      try { out.push(this.normalizeTag(item)); } catch { /* skip */ }
    }
    return this.dedupeTags(out);
  }

  private tagsPath(): string {
    return join(this.root, TAGS_FILE);
  }

  private readTagVocab(): string[] {
    try {
      const data = JSON.parse(readFileSync(this.tagsPath(), "utf8")) as { tags?: unknown };
      if (!Array.isArray(data.tags)) return [];
      const out: string[] = [];
      for (const item of data.tags) {
        try { out.push(this.normalizeTag(item)); } catch { /* skip */ }
      }
      return this.dedupeTags(out);
    } catch {
      return [];
    }
  }

  private writeTagVocab(tags: string[]): void {
    mkdirSync(this.root, { recursive: true });
    writeFileSync(this.tagsPath(), JSON.stringify({ tags: this.dedupeTags(tags) }, null, 2), "utf8");
  }

  private loadInfo(skillDir: string, source: string): Record<string, unknown> | null {
    const file = join(skillDir, "SKILL.md");
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { return null; }
    const { meta } = parse_frontmatter(text);
    return {
      name: skillDir.split(sep).pop(),
      description: String(meta["description"] ?? "").trim(),
      tags: this.tagsFromMeta(meta),
      source,
      read_only: source !== "user",
    };
  }

  private resolveSkillDir(name: string): { dir: string; source: string } | null {
    const slug = this.validateName(name);
    const userDir = join(this.root, slug);
    if (existsSync(join(userDir, "SKILL.md"))) return { dir: userDir, source: "user" };
    if (this.builtinRoot) {
      const builtinDir = join(this.builtinRoot, slug);
      if (existsSync(join(builtinDir, "SKILL.md"))) return { dir: builtinDir, source: "builtin" };
    }
    return null;
  }

  list_skills(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    const scan = (root: string | null, source: string) => {
      if (!root || !existsSync(root)) return;
      for (const entry of readdirSync(root).sort()) {
        const dir = join(root, entry);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch { continue; }
        if (!NAME_RE.test(entry) || seen.has(entry)) continue;
        if (!existsSync(join(dir, "SKILL.md"))) continue;
        const info = this.loadInfo(dir, source);
        if (info) { out.push(info); seen.add(entry); }
      }
    };
    scan(this.root, "user");
    scan(this.builtinRoot, "builtin");
    return out;
  }

  get_detail(name: string): Record<string, unknown> {
    const resolved = this.resolveSkillDir(name);
    if (resolved === null) throw SkillNotFoundError(name);
    const text = readFileSync(join(resolved.dir, "SKILL.md"), "utf8");
    const { meta } = parse_frontmatter(text);
    return {
      name: resolved.dir.split(sep).pop(),
      description: String(meta["description"] ?? "").trim(),
      content: text,
      tags: this.tagsFromMeta(meta),
      source: resolved.source,
      read_only: resolved.source !== "user",
    };
  }

  read_skill_file(name: string, relPath = "SKILL.md"): string {
    const resolved = this.resolveSkillDir(name);
    if (resolved === null) throw SkillNotFoundError(name);
    const candidate = (relPath || "SKILL.md").trim() || "SKILL.md";
    if (candidate.includes("..") || candidate.startsWith("/") || candidate.includes("\\")) {
      throw new SkillError("invalid_path", `Illegal skill file path: ${relPath}`);
    }
    const rootResolved = resolve(resolved.dir);
    const target = resolve(rootResolved, candidate);
    if (!target.startsWith(rootResolved + sep) && target !== rootResolved) {
      throw new SkillError("invalid_path", `Illegal skill file path: ${relPath}`);
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new SkillError("file_not_found", `File not found in skill: ${name}/${candidate}`);
    }
    let text = readFileSync(target, "utf8");
    if (text.length > MAX_READ_CHARS) text = text.slice(0, MAX_READ_CHARS) + "\n\n[... truncated ...]";
    return text;
  }

  list_skill_files(name: string): string[] {
    const resolved = this.resolveSkillDir(name);
    if (resolved === null) throw SkillNotFoundError(name);
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full, rel);
        else if (st.isFile()) out.push(rel);
      }
    };
    walk(resolved.dir, "");
    return out;
  }

  // -- tags ----------------------------------------------------------------------

  private ensureInitializedVocab(): string[] {
    const existed = existsSync(this.tagsPath());
    let vocab = this.readTagVocab();
    if (!existed) vocab = [...DEFAULT_TAGS];
    const found: string[] = [];
    for (const info of this.list_skills()) {
      if (info["source"] !== "user") continue;
      for (const tag of (info["tags"] as string[]) ?? []) {
        if (!found.includes(tag)) found.push(tag);
      }
    }
    const union = this.dedupeTags([...vocab, ...found]);
    if (!existed || union.join("|") !== vocab.join("|")) this.writeTagVocab(union);
    return union;
  }

  list_tags(): string[] {
    return this.ensureInitializedVocab();
  }

  create_tag(name: string): string {
    const tag = this.normalizeTag(name);
    const vocab = this.ensureInitializedVocab();
    if (vocab.includes(tag)) throw TagExistsError(tag);
    this.writeTagVocab([...vocab, tag]);
    return tag;
  }

  rename_tag(oldTag: string, newTag: string): string {
    const oldN = this.normalizeTag(oldTag);
    const newN = this.normalizeTag(newTag);
    const vocab = this.ensureInitializedVocab();
    if (!vocab.includes(oldN)) throw TagNotFoundError(oldTag);
    if (vocab.includes(newN)) throw TagExistsError(newTag);
    this.writeTagVocab(vocab.map((t) => (t === oldN ? newN : t)));
    // Rewrite tags inside user SKILL.md frontmatter.
    for (const entry of readdirSync(this.root)) {
      const file = join(this.root, entry, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const updated = text.replace(
        /(tags:\s*\[)([^\]]*)(\])/,
        (_m, pre: string, inner: string, post: string) => {
          const tags = inner.split(",").map((t) => t.trim()).filter(Boolean)
            .map((t) => (t.replace(/^["']|["']$/g, "") === oldN ? newN : t.replace(/^["']|["']$/g, "")));
          return `${pre}${tags.map((t) => `"${t}"`).join(", ")}${post}`;
        },
      );
      if (updated !== text) writeFileSync(file, updated, "utf8");
    }
    return newN;
  }

  delete_tag(name: string): void {
    const tag = this.normalizeTag(name);
    const vocab = this.ensureInitializedVocab();
    if (!vocab.includes(tag)) throw TagNotFoundError(name);
    this.writeTagVocab(vocab.filter((t) => t !== tag));
    for (const entry of readdirSync(this.root)) {
      const file = join(this.root, entry, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const { meta } = parse_frontmatter(text);
      const tags = this.tagsFromMeta(meta).filter((t) => t !== tag);
      // Rebuild frontmatter tags line conservatively.
      const updated = text.replace(/(tags:\s*)\[[^\]]*\]/, `$1[${tags.map((t) => `"${t}"`).join(", ")}]`);
      if (updated !== text) writeFileSync(file, updated, "utf8");
    }
  }

  // -- writes ---------------------------------------------------------------------

  create(name: string, description: string, content: string, tags: string[]): Record<string, unknown> {
    const slug = this.validateName(name);
    const dir = join(this.root, slug);
    if (existsSync(join(dir, "SKILL.md"))) throw SkillExistsError(slug);
    const normalizedTags = this.dedupeTags(tags.map((t) => this.normalizeTag(t)));
    mkdirSync(dir, { recursive: true });
    const fm = [
      "---",
      `name: ${slug}`,
      `description: ${JSON.stringify(description ?? "")}`,
      normalizedTags.length ? `tags: [${normalizedTags.map((t) => JSON.stringify(t)).join(", ")}]` : "",
      "---",
      "",
    ].filter((l) => l !== "").join("\n");
    const body = content ?? "";
    writeFileSync(join(dir, "SKILL.md"), fm + (body.startsWith("\n") ? body : `\n${body}`), "utf8");
    this.ensureInitializedVocab();
    return this.loadInfo(dir, "user")!;
  }

  update(
    name: string,
    opts: { description?: string | null; content?: string | null; rename_to?: string | null; tags?: string[] | null },
  ): Record<string, unknown> {
    const resolved = this.resolveSkillDir(name);
    if (resolved === null) throw SkillNotFoundError(name);
    if (resolved.source !== "user") throw SkillReadOnlyError(name);
    let dir = resolved.dir;
    if (opts.rename_to) {
      const newSlug = this.validateName(opts.rename_to);
      const newDir = join(this.root, newSlug);
      if (existsSync(join(newDir, "SKILL.md"))) throw SkillExistsError(newSlug);
      rmSync(newDir, { recursive: true, force: true });
      renameSync(dir, newDir);
      dir = newDir;
    }
    const file = join(dir, "SKILL.md");
    let text = readFileSync(file, "utf8");
    const { meta, body } = parse_frontmatter(text);
    if (opts.description !== undefined && opts.description !== null) meta["description"] = opts.description;
    if (opts.tags) meta["tags"] = this.dedupeTags(opts.tags.map((t) => this.normalizeTag(t)));
    const newBody = opts.content !== undefined && opts.content !== null ? opts.content : body;
    // Rebuild frontmatter minimally (flat keys only; nested maps are preserved
    // by re-serialising what we parsed).
    const lines = ["---"];
    for (const [k, v] of Object.entries(meta)) {
      if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
      else if (isRecord(v)) {
        lines.push(`${k}:`);
        for (const [ik, iv] of Object.entries(v)) lines.push(`  ${ik}: ${JSON.stringify(String(iv))}`);
      } else lines.push(`${k}: ${JSON.stringify(String(v ?? ""))}`);
    }
    lines.push("---", "");
    writeFileSync(file, lines.join("\n") + (newBody.startsWith("\n") ? newBody : `\n${newBody}`), "utf8");
    this.ensureInitializedVocab();
    return this.loadInfo(dir, "user")!;
  }

  delete(name: string): void {
    const resolved = this.resolveSkillDir(name);
    if (resolved === null) throw SkillNotFoundError(name);
    if (resolved.source !== "user") throw SkillReadOnlyError(name);
    rmSync(resolved.dir, { recursive: true, force: true });
  }
}

let _service: SkillService | null = null;
export function get_skill_service(settings?: Settings): SkillService {
  if (!_service || settings) {
    _service = new SkillService(settings);
  }
  return _service;
}
