// pure filesystem
// operations over a connected Obsidian vault.
//
// This module is the *only* place that knows Obsidian's on-disk conventions:
// notes are `.md` files under the vault root, metadata is YAML frontmatter
// fenced by `---`, links are `[[wikilinks]]`, and `.obsidian` / `.trash` /
// `.git` are vault internals to ignore.
//
// Every function takes the vault root explicitly and returns plain data.
// Writes are additive only (create / append / set a property); nothing here
// edits prose in place or deletes.
//
// Frontmatter YAML goes through ./yaml.js — a documented subset parser
// (no anchors, no `|`/`>` block scalars). TODO(yaml): full YAML if needed.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseYamlSubset, dumpYamlSubset } from "./yaml.js";

// Vault-internal folders that hold app state, not user notes.
export const IGNORED_DIRS = new Set([".obsidian", ".trash", ".git"]);

const WIKILINK_RE = /!?\[\[([^\]\n|#^]+)/g;
// Inline #tag (allowing nested #a/b), not a Markdown heading (# h): requires
// a non-space immediately after # and not at line start after space.
const INLINE_TAG_RE = /(?:^|(?<=\s))#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export class VaultError extends Error {}

// --- internals --------------------------------------------------------------

function isIgnored(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part));
}

async function* iterMarkdown(root: string): AsyncGenerator<string> {
  // Yield every user-facing .md file under root (ignored dirs skipped),
  // sorted for deterministic output like Python's sorted(root.rglob).
  const stack: string[] = [root];
  const files: string[] = [];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(full);
      }
    }
  }
  files.sort();
  for (const f of files) {
    const rel = relative(root, f);
    if (!isIgnored(rel)) yield f;
  }
}

async function readText(path: string): Promise<string> {
  // Decode tolerating bad bytes — TextDecoder's default replaces them,
  // matching Python's errors="replace".
  const buf = await readFile(path);
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

async function readTextExact(path: string): Promise<string> {
  // Reads that will be written back stay strict: rewriting a note we could
  // only partially decode would replace the user's bytes with U+FFFD.
  const buf = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch (exc) {
    throw new VaultError(
      `Note ${basename(path)} is not valid UTF-8; editing it would corrupt ` +
        `the undecodable bytes. Fix its encoding first. (${String(exc)})`,
    );
  }
}

export function safeJoin(root: string, rel: string): string {
  /** Resolve rel under root, refusing anything that escapes the vault. */
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, rel.replace(/^\/+/, ""));
  const relOut = relative(rootResolved, candidate);
  if (relOut === "") return candidate;
  if (relOut === ".." || relOut.startsWith(`..${sep}`) || isAbsolute(relOut)) {
    throw new VaultError(`Path ${JSON.stringify(rel)} escapes the vault.`);
  }
  return candidate;
}

function withMdSuffix(rel: string): string {
  return rel.toLowerCase().endsWith(".md") ? rel : `${rel}.md`;
}

export async function resolveNote(root: string, ref: string): Promise<string | null> {
  /** Resolve a note reference the way Obsidian links do: vault-relative path
   * or bare note name matched by basename anywhere in the vault. */
  let cleaned = (ref || "").trim();
  const hash = cleaned.indexOf("#");
  if (hash >= 0) cleaned = cleaned.slice(0, hash);
  const pipe = cleaned.indexOf("|");
  if (pipe >= 0) cleaned = cleaned.slice(0, pipe);
  cleaned = cleaned.trim();
  if (!cleaned) return null;

  // Explicit path (has a separator or .md suffix) → resolve directly.
  if (cleaned.includes("/") || cleaned.includes("\\") || cleaned.toLowerCase().endsWith(".md")) {
    const candidate = safeJoin(root, withMdSuffix(cleaned));
    try {
      const st = await stat(candidate);
      return st.isFile() ? candidate : null;
    } catch {
      return null;
    }
  }
  // Bare name → first .md whose stem matches (case-insensitive fallback).
  const wanted = cleaned.toLowerCase();
  let fallback: string | null = null;
  for await (const path of iterMarkdown(root)) {
    const stem = basename(path, ".md");
    if (stem === cleaned) return path;
    if (fallback === null && stem.toLowerCase() === wanted) fallback = path;
  }
  return fallback;
}

export function splitFrontmatter(text: string): [Record<string, unknown>, string] {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return [{}, text];
  let data: unknown;
  try {
    data = parseYamlSubset(match[1]);
  } catch {
    return [{}, text];
  }
  if (!isRecord(data)) return [{}, text];
  return [data, text.slice(match[0].length)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function composeNote(frontmatter: Record<string, unknown>, body: string): string {
  const keys = Object.keys(frontmatter);
  if (!keys.length) return body;
  const fm = dumpYamlSubset(frontmatter).trim();
  return `---\n${fm}\n---\n${body}`;
}

function rel(root: string, path: string): string {
  return relative(resolve(root), resolve(path)).split(sep).join("/");
}

function snippet(body: string, query: string, width = 160): string {
  const lowered = body.toLowerCase();
  const idx = lowered.indexOf(query.toLowerCase());
  if (idx < 0) return body.slice(0, width).trim().replace(/\n/g, " ");
  const start = Math.max(0, idx - Math.floor(width / 3));
  const piece = body.slice(start, start + width).trim().replace(/\n/g, " ");
  return `${start > 0 ? "…" : ""}${piece}${start + width < body.length ? "…" : ""}`;
}

// --- read operations --------------------------------------------------------

export interface NoteRead {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export async function readNote(root: string, ref: string): Promise<NoteRead> {
  const path = await resolveNote(root, ref);
  if (path === null) {
    throw new VaultError(`Note ${JSON.stringify(ref)} not found in the vault.`);
  }
  const text = await readText(path);
  const [frontmatter, body] = splitFrontmatter(text);
  return { path: rel(root, path), frontmatter, body };
}

export interface SearchHit {
  path: string;
  snippet: string;
}

export async function searchNotes(
  root: string,
  query: string,
  limit = 20,
): Promise<SearchHit[]> {
  const q = (query || "").trim();
  if (!q) return [];
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  for await (const path of iterMarkdown(root)) {
    let text: string;
    try {
      text = await readText(path);
    } catch {
      continue;
    }
    const stem = basename(path, ".md");
    if (stem.toLowerCase().includes(needle) || text.toLowerCase().includes(needle)) {
      hits.push({ path: rel(root, path), snippet: snippet(text, q) });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

export async function listNotes(
  root: string,
  folder = "",
  limit = 200,
): Promise<string[]> {
  let base = root;
  if (folder.trim()) {
    try {
      base = safeJoin(root, folder);
    } catch {
      return [];
    }
    if (!existsSync(base)) return [];
  }
  const out: string[] = [];
  const scanRoot = base;
  for await (const path of iterMarkdown(scanRoot)) {
    // iterMarkdown yields under scanRoot; re-relativize against vault root.
    out.push(rel(root, path));
    if (out.length >= limit) break;
  }
  return out;
}

const LINK_TARGET_RE = /!?\[\[([^\]\n|#^]+)/g;

export async function outgoingLinks(root: string, ref: string): Promise<string[]> {
  const note = await readNote(root, ref);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of note.body.matchAll(LINK_TARGET_RE)) {
    const name = (m[1] ?? "").trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export interface BacklinkHit {
  path: string;
  snippet: string;
}

export async function backlinks(root: string, ref: string, limit = 50): Promise<BacklinkHit[]> {
  const target = await resolveNote(root, ref);
  if (target === null) {
    throw new VaultError(`Note ${JSON.stringify(ref)} not found in the vault.`);
  }
  const notes: string[] = [];
  for await (const p of iterMarkdown(root)) notes.push(p);

  const exactNames = new Map<string, string>();
  const foldedNames = new Map<string, string>();
  for (const note of notes) {
    const stem = basename(note, ".md");
    if (!exactNames.has(stem)) exactNames.set(stem, note);
    const folded = stem.toLowerCase();
    if (!foldedNames.has(folded)) foldedNames.set(folded, note);
  }

  const pointsToTarget = async (link: string): Promise<boolean> => {
    const l = link.trim();
    if (!l) return false;
    let destination: string | null;
    if (l.includes("/") || l.includes("\\") || l.toLowerCase().endsWith(".md")) {
      try {
        destination = await resolveNote(root, l);
      } catch {
        return false;
      }
    } else {
      destination = exactNames.get(l) ?? foldedNames.get(l.toLowerCase()) ?? null;
    }
    return destination !== null && resolve(destination) === resolve(target);
  };

  const out: BacklinkHit[] = [];
  for (const path of notes) {
    if (resolve(path) === resolve(target)) continue;
    let text: string;
    try {
      text = await readText(path);
    } catch {
      continue;
    }
    const links = [...text.matchAll(LINK_TARGET_RE)].map((m) => m[1] ?? "");
    for (const link of links) {
      if (await pointsToTarget(link)) {
        out.push({ path: rel(root, path), snippet: snippet(text, basename(target, ".md")) });
        break;
      }
    }
    if (out.length >= limit) break;
  }
  return out;
}

export interface TagCount {
  tag: string;
  count: number;
}

export async function collectTags(root: string, limit = 200): Promise<TagCount[]> {
  const counts = new Map<string, number>();
  const bump = (tag: string) => {
    const t = tag.trim().replace(/^#/, "");
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  };
  for await (const path of iterMarkdown(root)) {
    let text: string;
    try {
      text = await readText(path);
    } catch {
      continue;
    }
    const [frontmatter, body] = splitFrontmatter(text);
    let fmTags = frontmatter["tags"];
    if (typeof fmTags === "string") fmTags = [fmTags];
    if (Array.isArray(fmTags)) {
      for (const tag of fmTags) bump(String(tag));
    }
    for (const m of body.matchAll(INLINE_TAG_RE)) {
      if (m[1]) bump(m[1]);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return ranked.slice(0, limit).map(([tag, count]) => ({ tag, count }));
}

// --- write operations (additive only) ---------------------------------------

export async function createNote(
  root: string,
  relPath: string,
  content: string,
  frontmatter: Record<string, unknown> | null = null,
): Promise<string> {
  const cleaned = (relPath || "").trim();
  if (!cleaned) throw new VaultError("create_note needs a non-empty path.");
  const withExt = withMdSuffix(cleaned);
  const path = safeJoin(root, withExt);
  if (existsSync(path)) {
    throw new VaultError(
      `Note ${JSON.stringify(withExt)} already exists; use append instead.`,
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, composeNote(frontmatter ?? {}, content ?? ""), "utf-8");
  return rel(root, path);
}

export async function appendNote(root: string, ref: string, content: string): Promise<string> {
  const path = await resolveNote(root, ref);
  if (path === null) {
    throw new VaultError(`Note ${JSON.stringify(ref)} not found; create it first.`);
  }
  const existing = await readTextExact(path);
  const separator = existing.endsWith("\n") || !existing ? "" : "\n";
  await writeFile(path, existing + separator + (content ?? ""), "utf-8");
  return rel(root, path);
}

export async function setProperty(
  root: string,
  ref: string,
  key: string,
  value: unknown,
): Promise<string> {
  const k = (key || "").trim();
  if (!k) throw new VaultError("set_property needs a non-empty key.");
  const path = await resolveNote(root, ref);
  if (path === null) {
    throw new VaultError(`Note ${JSON.stringify(ref)} not found; create it first.`);
  }
  const [frontmatter, body] = splitFrontmatter(await readTextExact(path));
  frontmatter[k] = value;
  await writeFile(path, composeNote(frontmatter, body), "utf-8");
  return rel(root, path);
}

export const vaultOps = {
  VaultError,
  resolveNote,
  readNote,
  searchNotes,
  listNotes,
  outgoingLinks,
  backlinks,
  collectTags,
  createNote,
  appendNote,
  setProperty,
  splitFrontmatter,
};
