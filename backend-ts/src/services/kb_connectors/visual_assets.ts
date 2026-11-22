// KB-scoped immutable image files + manifest.json, used by file move/delete.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AnyRecord } from "./types.js";

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export class VisualAssetStore {
  readonly root: string;
  readonly manifestPath: string;

  constructor(private kbDirPath: string) {
    this.root = join(kbDirPath, "visual_assets");
    this.manifestPath = join(this.root, "manifest.json");
  }

  private readManifest(): Record<string, AnyRecord> {
    try {
      if (existsSync(this.manifestPath)) {
        const payload: unknown = JSON.parse(readFileSync(this.manifestPath, "utf-8"));
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const assets = (payload as AnyRecord)["assets"];
          if (assets !== null && typeof assets === "object" && !Array.isArray(assets)) {
            return assets as Record<string, AnyRecord>;
          }
        }
      }
    } catch {
      /* treat as empty */
    }
    return {};
  }

  private atomicWriteManifest(assets: Record<string, AnyRecord>): void {
    mkdirSync(this.root, { recursive: true });
    const tmp = join(this.root, `.manifest-${process.pid}-${Date.now()}.tmp`);
    writeFileSync(tmp, JSON.stringify({ version: 1, assets }, null, 0));
    renameSync(tmp, this.manifestPath);
  }

  private pathFor(assetId: string, mime: string): string {
    const ext = MIME_EXT[mime];
    if (!ID_RE.test(assetId) || !ext) throw new Error("Invalid visual asset record");
    return join(this.root, assetId + ext);
  }

  /** read — verify size+sha256 before returning bytes. */
  read(assetId: string): { record: AnyRecord; data: Buffer } | null {
    if (!ID_RE.test(assetId)) return null;
    const record = this.readManifest()[assetId];
    if (!record || record["asset_id"] !== assetId) return null;
    const mime = String(record["mime_type"] ?? "");
    const ext = MIME_EXT[mime];
    if (!ext) return null;
    const path = join(this.root, assetId + ext);
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      return null;
    }
    if (data.length !== Number(record["size"] ?? -1)) return null;
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== record["image_sha256"]) return null;
    return { record, data };
  }

  /** remove_source — drop manifest entries + files for a raw-relative path. */
  removeSource(sourceRelativePath: string): void {
    const prior = this.readManifest();
    const updated: Record<string, AnyRecord> = {};
    const removedIds: string[] = [];
    for (const [key, value] of Object.entries(prior)) {
      if (value["source_path"] === sourceRelativePath) {
        removedIds.push(key);
      } else {
        updated[key] = value;
      }
    }
    if (!removedIds.length) return;
    this.atomicWriteManifest(updated);
    for (const id of removedIds) {
      const mime = String(prior[id]["mime_type"] ?? "");
      const ext = MIME_EXT[mime];
      if (ext) rmSync(join(this.root, id + ext), { force: true });
    }
  }

  /** move_source — rewrite source_path for moved/renamed raw files. */
  moveSource(oldRelativePath: string, newRelativePath: string): void {
    const prior = this.readManifest();
    let changed = false;
    const updated: Record<string, AnyRecord> = {};
    for (const [key, value] of Object.entries(prior)) {
      const source = value["source_path"];
      if (
        source === oldRelativePath ||
        (typeof source === "string" && source.startsWith(oldRelativePath + "/"))
      ) {
        updated[key] = {
          ...value,
          source_path:
            newRelativePath + String(source).slice(oldRelativePath.length),
        };
        changed = true;
      } else {
        updated[key] = value;
      }
    }
    if (changed) this.atomicWriteManifest(updated);
  }
}

export function listVisualAssetFiles(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}
