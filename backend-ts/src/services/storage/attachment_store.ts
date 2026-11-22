// Port of deeptutor/services/storage/attachment_store.py — local-disk chat
// attachment storage used by api/routers/attachments.py and file-preview.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { get_settings } from "../../config.js";

const PUBLIC_URL_PREFIX = "/files/attachments";
const VISIBLE_SUBPATH = ["chat", "attachments"];
const LEGACY_SUBPATH = ["workspace", "chat", "attachments"];

// Mirrors utils/filenames.safe_filename: strip control chars, replace unsafe
// path chars with '_', trim dots/whitespace.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const UNSAFE_CHARS = /[\\/:*?"<>|]/g;

export function safeFilename(name: string): string {
  const cleaned = String(name || "")
    .replace(CONTROL_CHARS, "")
    .replace(UNSAFE_CHARS, "_")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();
  return cleaned;
}

export function coerceFilename(filename: string): string {
  const base = basename(String(filename || ""));
  return safeFilename(base) || "file";
}

function attachmentRoot(): string {
  const ws = resolve(get_settings().workspace_dir);
  let dir = ws;
  for (const component of VISIBLE_SUBPATH) {
    dir = join(dir, component);
    if (existsSync(dir) && statSync(dir).isSymbolicLink()) {
      throw new Error("Chat attachment directories cannot be symbolic links.");
    }
  }
  return resolve(dir);
}

function legacyAttachmentRoot(): string {
  return resolve(get_settings().data_dir, ...LEGACY_SUBPATH);
}

export class LocalDiskAttachmentStore {
  root: string;
  legacyRoot: string | null;

  constructor(root?: string, legacyRoot?: string | null) {
    this.root = root ?? attachmentRoot();
    const legacy = legacyRoot === undefined ? legacyAttachmentRoot() : legacyRoot;
    this.legacyRoot = legacy && legacy !== this.root ? legacy : null;
  }

  private storedFilename(attachmentId: string, filename: string): string {
    return `${attachmentId}_${coerceFilename(filename)}`;
  }

  private sessionDir(root: string, sessionId: string): string {
    return join(root, coerceFilename(sessionId));
  }

  private safeJoin(root: string, sessionId: string, name: string): string | null {
    const sessionDir = this.sessionDir(root, sessionId);
    const raw = join(sessionDir, name);
    if (
      (existsSync(sessionDir) && statSync(sessionDir).isSymbolicLink()) ||
      (existsSync(raw) && statSync(raw).isSymbolicLink())
    ) {
      return null;
    }
    const candidate = resolve(raw);
    const rootResolved = resolve(root);
    if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
      return null;
    }
    return candidate;
  }

  async put(opts: {
    session_id: string;
    attachment_id: string;
    filename: string;
    data: Buffer;
    mime_type?: string;
  }): Promise<string> {
    const stored = this.storedFilename(opts.attachment_id, opts.filename);
    const target = this.safeJoin(this.root, opts.session_id, stored);
    if (!target) {
      throw new Error(`refusing to write attachment outside storage root: ${stored}`);
    }
    mkdirSync(join(target, ".."), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, opts.data);
    renameSync(tmp, target);
    const sid = encodeURIComponent(coerceFilename(opts.session_id));
    const aid = encodeURIComponent(opts.attachment_id);
    const name = encodeURIComponent(coerceFilename(opts.filename));
    return `${PUBLIC_URL_PREFIX}/${sid}/${aid}/${name}`;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const roots = this.legacyRoot ? [this.root, this.legacyRoot] : [this.root];
    for (const root of roots) {
      const dir = this.sessionDir(root, sessionId);
      try {
        if (existsSync(dir) && !statSync(dir).isSymbolicLink()) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch { /* best effort */ }
    }
  }

  async deleteAttachment(sessionId: string, attachmentId: string): Promise<void> {
    const roots = this.legacyRoot ? [this.root, this.legacyRoot] : [this.root];
    const prefix = `${attachmentId}_`;
    for (const root of roots) {
      const dir = this.sessionDir(root, sessionId);
      try {
        if (!existsSync(dir) || statSync(dir).isSymbolicLink()) continue;
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(prefix)) {
            try { rmSync(join(dir, entry), { force: true }); } catch { /* ignore */ }
          }
        }
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
      } catch { /* best effort */ }
    }
  }

  resolvePath(opts: { session_id: string; attachment_id: string; filename: string }): string | null {
    const stored = this.storedFilename(opts.attachment_id, opts.filename);
    const target = this.safeJoin(this.root, opts.session_id, stored);
    if (target && existsSync(target) && statSync(target).isFile()) return target;
    if (this.legacyRoot) {
      const legacy = new LocalDiskAttachmentStore(this.legacyRoot, null);
      const legacyTarget = legacy.safeJoin(this.legacyRoot, opts.session_id, stored);
      if (legacyTarget && existsSync(legacyTarget) && statSync(legacyTarget).isFile()) {
        return legacyTarget;
      }
    }
    return null;
  }
}

let _store: LocalDiskAttachmentStore | null = null;
export function get_attachment_store(): LocalDiskAttachmentStore {
  _store ??= new LocalDiskAttachmentStore();
  return _store;
}
