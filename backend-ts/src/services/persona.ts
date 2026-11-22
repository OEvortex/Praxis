// PERSONA.md CRUD under
// <workspace_dir>/personas/<name>/PERSONA.md with YAML frontmatter, plus the
// read-only admin preset overlay (bundled peer/teacher/research-assistant).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { get_settings } from "../config.js";

export class PersonaNotFoundError extends Error {}
export class PersonaExistsError extends Error {}
export class InvalidPersonaNameError extends Error {}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const PERSONA_FILE = "PERSONA.md";

export interface PersonaInfo { name: string; description: string; source?: string; read_only?: boolean }
export interface PersonaDetail { name: string; description: string; content: string; source?: string; read_only?: boolean }

const PRESETS_DIR = join(dirname(fileURLToPath(import.meta.url)), "presets");

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { meta: {}, body: content };
  const body = content.slice(match[0].length);
  const meta: Record<string, unknown> = {};
  // Minimal YAML subset: top-level `key: value` lines (our frontmatter is flat).
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    meta[key] = value;
  }
  return { meta, body };
}

function yamlScalar(value: string): string {
  const needsQuote = /[:#\n]/.test(value) || value !== value.trim();
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return needsQuote ? `"${escaped}"` : escaped;
}

function renderFrontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${yamlScalar(description.trim())}\n---`;
}

export class PersonaService {
  root: string;
  source: "user" | "admin";

  constructor(root: string, source: "user" | "admin" = "user") {
    this.root = resolve(root);
    this.source = source;
  }

  private validateName(name: string): string {
    const candidate = String(name || "").trim().toLowerCase();
    if (!NAME_RE.test(candidate)) {
      throw new InvalidPersonaNameError("Persona name must match ^[a-z0-9][a-z0-9-]{0,63}$");
    }
    return candidate;
  }

  private personaDir(name: string): string {
    return join(this.root, this.validateName(name));
  }

  private personaFile(name: string): string {
    return join(this.personaDir(name), PERSONA_FILE);
  }

  private normalizeContent(name: string, description: string, content: string): string {
    const { body } = parseFrontmatter(content || "");
    return `${renderFrontmatter(name, description)}\n\n${body.replace(/^\s+/, "")}`.trimEnd() + "\n";
  }

  listPersonas(): PersonaInfo[] {
    if (!existsSync(this.root)) return [];
    const out: PersonaInfo[] = [];
    for (const entry of readdirSync(this.root).sort()) {
      const dir = join(this.root, entry);
      const file = join(dir, PERSONA_FILE);
      try {
        if (!statIsDir(dir) || !existsSync(file)) continue;
        const { meta } = parseFrontmatter(readFileSync(file, "utf8"));
        out.push({ name: entry, description: String(meta.description ?? "").trim(), source: this.source });
      } catch { /* skip unreadable */ }
    }
    return out;
  }

  getDetail(name: string): PersonaDetail {
    const file = this.personaFile(name);
    if (!existsSync(file)) throw new PersonaNotFoundError(name);
    const text = readFileSync(file, "utf8");
    const { meta } = parseFrontmatter(text);
    return {
      name: this.validateName(name),
      description: String(meta.description ?? "").trim(),
      content: text,
      source: this.source,
    };
  }

  create(name: string, description: string, content: string): PersonaInfo {
    const slug = this.validateName(name);
    const dir = this.personaDir(slug);
    if (existsSync(dir)) throw new PersonaExistsError(slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.personaFile(slug), this.normalizeContent(slug, description, content), "utf8");
    return { name: slug, description: description.trim(), source: this.source };
  }

  update(
    name: string,
    opts: { description?: string | null; content?: string | null; rename_to?: string | null } = {},
  ): PersonaInfo {
    const slug = this.validateName(name);
    let dir = this.personaDir(slug);
    if (!existsSync(dir)) throw new PersonaNotFoundError(slug);
    const current = this.getDetail(slug);
    const newDescription = opts.description ?? current.description;
    const newContent = opts.content ?? current.content;
    let finalSlug = slug;
    if (opts.rename_to && opts.rename_to !== slug) {
      finalSlug = this.validateName(opts.rename_to);
      const newDir = this.personaDir(finalSlug);
      if (existsSync(newDir)) throw new PersonaExistsError(finalSlug);
      renameSync(dir, newDir);
      dir = newDir;
    }
    writeFileSync(
      join(dir, PERSONA_FILE),
      this.normalizeContent(finalSlug, String(newDescription), String(newContent)),
      "utf8",
    );
    return { name: finalSlug, description: String(newDescription).trim(), source: this.source };
  }

  delete(name: string): void {
    const slug = this.validateName(name);
    const dir = this.personaDir(slug);
    if (!existsSync(dir)) throw new PersonaNotFoundError(slug);
    rmSync(dir, { recursive: true, force: true });
  }

  /** Copy bundled default personas into this root for missing names. */
  seedPresets(): string[] {
    if (!existsSync(PRESETS_DIR)) return [];
    const seeded: string[] = [];
    for (const entry of readdirSync(PRESETS_DIR).sort()) {
      const sourceFile = join(PRESETS_DIR, entry, PERSONA_FILE);
      try {
        if (!statIsDir(join(PRESETS_DIR, entry)) || !existsSync(sourceFile)) continue;
        const name = this.validateName(entry);
        if (existsSync(this.personaDir(name))) continue;
        const text = readFileSync(sourceFile, "utf8");
        mkdirSync(this.personaDir(name), { recursive: true });
        writeFileSync(this.personaFile(name), text, "utf8");
        seeded.push(name);
      } catch { /* skip */ }
    }
    return seeded;
  }
}

function statIsDir(p: string): boolean {
  try { return statSyncSafe(p).isDirectory(); } catch { return false; }
}
import { statSync as statSyncSafe } from "node:fs";

// -- service singletons -------------------------------------------------------

function userRoot(): string {
  return resolve(get_settings().workspace_dir);
}

function adminPersonasRoot(): string {
  // Deployment-level presets live outside the user workspace, mirroring
  // get_admin_path_service().get_workspace_dir()/"personas".
  return resolve(join(get_settings().data_dir, "admin", "workspace", "personas"));
}

let _admin: PersonaService | null = null;
let _user: PersonaService | null = null;

export function adminPersonaService(): PersonaService {
  if (!_admin) {
    _admin = new PersonaService(adminPersonasRoot(), "admin");
    _admin.seedPresets();
  }
  return _admin;
}

export function getPersonaService(): PersonaService {
  if (!_user) _user = new PersonaService(join(userRoot(), "personas"), "user");
  return _user;
}

/** The read-only deployment presets, unless `service` already holds them. */
export function personaPresets(service: PersonaService): PersonaService | null {
  const presets = adminPersonaService();
  if (presets.root === service.root) return null;
  return presets;
}
