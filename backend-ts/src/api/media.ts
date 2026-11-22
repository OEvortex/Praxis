// file_preview,file_library,render_storage}.py — media/file surfaces.
import { Hono } from "hono";
import type { Context } from "hono";
import { createReadStream, existsSync, readFileSync, readdirSync as fsReaddirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, resolve, sep, basename } from "node:path";
import { Readable } from "node:stream";
import { get_settings } from "../config.js";
import {
  synthesizeSpeech,
  transcribeAudio,
  VoiceProviderError,
  VoiceProviderTimeout,
  parsePcmContentType,
  pcm16ToWav,
} from "../services/voice/index.js";
import {
  get_visualizer_registry,
  VisualizerStoreError,
} from "../services/visualizers/index.js";
import { get_attachment_store, LocalDiskAttachmentStore } from "../services/storage/attachment_store.js";
import * as fileLibrary from "../services/storage/file_library.js";
import {
  renderOfficePdf,
  defaultCacheDir,
  MAX_OFFICE_BYTES,
  OFFICE_SUFFIXES,
  OfficePreviewInvalid,
  OfficePreviewUnavailable,
  OfficePreviewTimeout,
  OfficePreviewConversionFailed,
} from "../services/office_preview.js";

export const mediaRouter = new Hono();

type AnyDict = Record<string, any>;

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

function vizHttpError(c: Context, exc: VisualizerStoreError) {
  const detail = String(exc.message ?? exc);
  if (detail.includes("not found")) return httpError(c, 404, detail);
  if (detail.includes("already installed") || detail.includes("reserved")) return httpError(c, 409, detail);
  return httpError(c, 400, detail);
}

function mimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
    ".html": "text/html; charset=utf-8", ".json": "application/json",
    ".zip": "application/zip", ".csv": "text/csv", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] ?? "application/octet-stream";
}

function contentDisposition(filename: string): string {
  const safe = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${safe}"`;
}

function fileResponse(c: Context, path: string, opts: { mediaType?: string; headers?: Record<string, string>; filename?: string } = {}) {
  const mediaType = opts.mediaType ?? mimeType(path);
  const headers: Record<string, string> = {
    "Content-Type": mediaType,
    ...(opts.filename ? { "Content-Disposition": `attachment; filename="${opts.filename.replace(/["\\]/g, "_")}"` } : {}),
    ...(opts.headers ?? {}),
  };
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
  return new Response(stream, { headers });
}

// ==========================================================================
// voice.py — /api/voice/{tts,stt}
// ==========================================================================

mediaRouter.post("/api/voice/tts", async (c) => {
  let payload: AnyDict;
  try { payload = await c.req.json(); } catch { return httpError(c, 400, "Invalid JSON body"); }
  const text = String(payload?.text ?? "");
  if (!text.trim()) return httpError(c, 400, "text is required");
  try {
    const { audio, contentType } = await synthesizeSpeech(text, {
      voice: payload.voice ?? null,
      responseFormat: payload.format ?? null,
    });
    let out = audio;
    let ct = contentType;
    const pcm = parsePcmContentType(ct);
    if (pcm) {
      out = pcm16ToWav(audio, pcm.sampleRate, pcm.channels);
      ct = "audio/wav";
    }
    return new Response(new Uint8Array(out), {
      headers: { "Content-Type": ct, "Cache-Control": "no-store" },
    });
  } catch (exc) {
    if (exc instanceof VoiceProviderTimeout) return httpError(c, 504, exc.message);
    if (exc instanceof VoiceProviderError) {
      // ValueError-equivalent config errors → 400; provider errors → 502.
      const msg = exc.message;
      if (/configured|required|exceeds|No active/i.test(msg)) return httpError(c, 400, msg);
      return httpError(c, 502, msg);
    }
    return httpError(c, 502, exc instanceof Error ? exc.message : String(exc));
  }
});

mediaRouter.post("/api/voice/stt", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return httpError(c, 400, "Expected multipart/form-data");
  const file = form["file"];
  if (!file || typeof file === "string") return httpError(c, 400, "file is required");
  const audio = Buffer.from(await file.arrayBuffer());
  if (!audio.length) return httpError(c, 400, "Empty audio upload.");
  if (audio.length > 25 * 1024 * 1024) {
    return httpError(c, 413, "Audio exceeds the 25 MB limit.");
  }
  const language = typeof form["language"] === "string" ? form["language"] : null;
  try {
    const text = await transcribeAudio(audio, {
      filename: file.name || "audio.webm",
      contentType: file.type || "application/octet-stream",
      language,
    });
    return c.json({ text });
  } catch (exc) {
    if (exc instanceof VoiceProviderError) {
      const msg = exc.message;
      if (/configured|required|exceeds|No active/i.test(msg)) return httpError(c, 400, msg);
      return httpError(c, 502, msg);
    }
    return httpError(c, 502, exc instanceof Error ? exc.message : String(exc));
  }
});

// ==========================================================================
// visualizers.py — /api/visualizers/*
// ==========================================================================

const IFRAME_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

mediaRouter.get("/api/visualizers/list", (c) => {
  const registry = get_visualizer_registry();
  return c.json({
    schema_version: "deeptutor.visualizer-catalog/v1",
    visualizers: registry.publicCatalog(),
  });
});

mediaRouter.post("/api/visualizers/bundled/:visualizer_id/install", (c) => {
  const id = c.req.param("visualizer_id");
  try {
    get_visualizer_registry().installBundled(id);
    const plugin = get_visualizer_registry().get(id);
    return c.json({ status: "installed", visualizer: plugin?.manifest.id ?? id });
  } catch (exc) {
    if (exc instanceof VisualizerStoreError) return vizHttpError(c, exc);
    throw exc;
  }
});

mediaRouter.post("/api/visualizers/:visualizer_id/enable", (c) => {
  const id = c.req.param("visualizer_id");
  try {
    get_visualizer_registry().setEnabled(id, true);
    return c.json({ status: "enabled", visualizer: id });
  } catch (exc) {
    if (exc instanceof VisualizerStoreError) return vizHttpError(c, exc);
    throw exc;
  }
});

mediaRouter.post("/api/visualizers/:visualizer_id/disable", (c) => {
  const id = c.req.param("visualizer_id");
  try {
    get_visualizer_registry().setEnabled(id, false);
    return c.json({ status: "disabled", visualizer: id });
  } catch (exc) {
    if (exc instanceof VisualizerStoreError) return vizHttpError(c, exc);
    throw exc;
  }
});

mediaRouter.delete("/api/visualizers/:visualizer_id", (c) => {
  const id = c.req.param("visualizer_id");
  // Guard: "/import" and "/list" are literal routes registered above/below;
  // Hono matches in registration order so :visualizer_id only sees real ids.
  try {
    get_visualizer_registry().uninstall(id);
    return c.json({ status: "uninstalled", visualizer: id });
  } catch (exc) {
    if (exc instanceof VisualizerStoreError) return vizHttpError(c, exc);
    throw exc;
  }
});

mediaRouter.post("/api/visualizers/import", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.["file"];
  if (!file || typeof file === "string") return httpError(c, 400, "file is required");
  const filename = String(file.name ?? "");
  if (!filename.toLowerCase().endsWith(".zip")) {
    return httpError(c, 400, "visualizer package must be a zip file");
  }
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > 25 * 1024 * 1024) {
    return httpError(c, 413, "visualizer package exceeds 25 MB");
  }
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: j } = await import("node:path");
  const tmp = mkdtempSync(j(tmpdir(), "deeptutor-visualizer-"));
  const archivePath = j(tmp, "package.zip");
  writeFileSync(archivePath, data);
  try {
    const registry = get_visualizer_registry();
    const plugin = registry.installArchive(archivePath);
    const catalog = registry.publicCatalog();
    const publicManifest = catalog.find((item) => (item as AnyDict).id === plugin.manifest.id);
    return c.json({
      status: "installed",
      visualizer: plugin.manifest.id,
      manifest: publicManifest,
    });
  } catch (exc) {
    if (exc instanceof VisualizerStoreError) return vizHttpError(c, exc);
    return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(tmp, { recursive: true, force: true });
  }
});

mediaRouter.get("/api/visualizers/:visualizer_id/assets/*", (c) => {
  const id = c.req.param("visualizer_id");
  const assetPath = c.req.path.replace(`/api/visualizers/${id}/assets/`, "");
  try {
    const path = get_visualizer_registry().assetPath(id, decodeURIComponent(assetPath));
    return fileResponse(c, path, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Security-Policy": IFRAME_CSP,
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (exc) {
    if (exc instanceof VisualizerStoreError) return vizHttpError(c, exc);
    throw exc;
  }
});

// ==========================================================================
// outputs.py — /files/outputs/{path}
// ==========================================================================

const SANDBOXED_PAGE_CSP = "sandbox allow-scripts allow-popups";

function outputsRoot(): string {
  // Public outputs live under the files dir (filesRouter serves /files/*).
  return resolve(get_settings().files_dir);
}

function resolveOutput(relativePath: string): string | null {
  const root = outputsRoot();
  const candidate = resolve(join(root, relativePath));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  return candidate;
}

function readOutput(c: Context, outputPath: string): Response {
  const path = resolveOutput(outputPath);
  if (!path) return httpError(c, 404, "Output not found");
  const headers: Record<string, string> = {};
  if (path.toLowerCase().endsWith(".html") && path.split(sep).includes("video_lesson")) {
    headers["Content-Security-Policy"] = SANDBOXED_PAGE_CSP;
  }
  return fileResponse(c, path, { headers });
}

mediaRouter.get("/files/outputs/*", (c) => {
  const rel = c.req.path.replace(/^\/files\/outputs\//, "");
  return readOutput(c, decodeURIComponent(rel));
});

mediaRouter.on("HEAD", "/files/outputs/*", (c) => {
  const rel = c.req.path.replace(/^\/files\/outputs\//, "");
  const path = resolveOutput(decodeURIComponent(rel));
  if (!path) return httpError(c, 404, "Output not found");
  return new Response(null, {
    headers: { "Content-Type": mimeType(path), "Content-Length": String(statSync(path).size) },
  });
});

// ==========================================================================
// attachments.py — /files/attachments/{session}/{attachment}/{filename}
// ==========================================================================

function serveAttachment(c: Context, sessionId: string, attachmentId: string, filename: string): Response {
  const store = get_attachment_store();
  if (!(store instanceof LocalDiskAttachmentStore)) {
    return httpError(c, 501, "Attachment backend not servable");
  }
  const target = store.resolvePath({ session_id: sessionId, attachment_id: attachmentId, filename });
  if (!target) return httpError(c, 404, "Attachment not found");
  return fileResponse(c, target, {
    mediaType: mimeType(target),
    headers: {
      "Content-Disposition": contentDisposition(basename(target)),
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// Literal upstream shape first so the route-table diff sees
// GET /files/attachments/{session_id}/{attachment_id}/{filename:path}; the
// wildcard below remains for nested filenames.
mediaRouter.get("/files/attachments/:session_id/:attachment_id/*", (c) => {
  const filename = c.req.path.split(`/files/attachments/${c.req.param("session_id")}/${c.req.param("attachment_id")}/`)[1] ?? "";
  return serveAttachment(c, c.req.param("session_id") ?? "", c.req.param("attachment_id") ?? "", decodeURIComponent(filename));
});

mediaRouter.get("/files/attachments/*", (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^\/files\/attachments\//, ""));
  const parts = rel.split("/");
  if (parts.length < 3) return httpError(c, 404, "Attachment not found");
  const [sessionId, attachmentId, ...rest] = parts;
  return serveAttachment(c, sessionId, attachmentId, rest.join("/"));
});

// ==========================================================================
// file_library.py — /files/library/*
// ==========================================================================

mediaRouter.get("/files/library/search", (c) => {
  const q = c.req.query("q") ?? "";
  if (!q.trim() || q.length > 200) return httpError(c, 422, "q must be 1-200 characters");
  return c.json(fileLibrary.searchFiles(q));
});

mediaRouter.get("/files/library/", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
  return c.json(fileLibrary.listFiles(limit, offset));
});

mediaRouter.post("/files/library/", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return httpError(c, 400, "Expected multipart/form-data");
  const file = form["file"];
  if (!file || typeof file === "string") return httpError(c, 400, "file is required");
  const filenameField = form["filename"];
  const filename = typeof filenameField === "string" && filenameField ? filenameField : file.name || "file";
  const mimeField = form["mime_type"];
  const mime = typeof mimeField === "string" ? mimeField : file.type || "";
  const data = Buffer.from(await file.arrayBuffer());
  try {
    return c.json(fileLibrary.addFile({ data, filename, mime_type: mime }));
  } catch (exc) {
    return httpError(c, 500, exc instanceof Error ? exc.message : String(exc));
  }
});

mediaRouter.get("/files/library/:file_id/download", (c) => {
  const fileId = c.req.param("file_id");
  const entry = fileLibrary.getFile(fileId);
  if (!entry || entry.is_deleted) return httpError(c, 404, "File not found");
  const path = fileLibrary.resolvePath(fileId);
  if (!path) return httpError(c, 404, "File not found on disk");
  return fileResponse(c, path, {
    mediaType: mimeType(entry.filename),
    filename: entry.filename,
    headers: {
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

mediaRouter.on("HEAD", "/files/library/:file_id/download", (c) => {
  const fileId = c.req.param("file_id");
  const entry = fileLibrary.getFile(fileId);
  if (!entry || entry.is_deleted) return httpError(c, 404, "File not found");
  if (!fileLibrary.resolvePath(fileId)) return httpError(c, 404, "File not found on disk");
  return new Response(null, { status: 200 });
});

mediaRouter.get("/files/library/:file_id", (c) => {
  const entry = fileLibrary.getFile(c.req.param("file_id"));
  if (!entry) return httpError(c, 404, "File not found");
  return c.json(entry);
});

mediaRouter.delete("/files/library/:file_id", (c) => {
  if (!fileLibrary.deleteFile(c.req.param("file_id"))) return httpError(c, 404, "File not found");
  return c.json({ id: c.req.param("file_id"), deleted: true });
});

mediaRouter.post("/files/library/:file_id/restore", (c) => {
  try {
    if (!fileLibrary.restoreFile(c.req.param("file_id"))) return httpError(c, 404, "File not found");
    return c.json({ id: c.req.param("file_id"), restored: true });
  } catch (exc) {
    if (exc instanceof fileLibrary.FileLibraryContentConflict) return httpError(c, 409, exc.message);
    throw exc;
  }
});

// ==========================================================================
// file_preview.py — /api/file-preview/pdf (GET ?source= / POST upload)
// ==========================================================================

function previewSourcePath(source: string): { bytes: () => Promise<Buffer>; filename: string } {
  if (source.length > 8192) throw Object.assign(new Error("Invalid preview source"), { status: 400 });
  const fail = (status: number, detail: string): never => {
    throw Object.assign(new Error(detail), { status });
  };
  // Strip query string; only local absolute paths under our roots are served.
  const pathOnly = source.split("?")[0];
  if (!pathOnly.startsWith("/") || pathOnly.includes("..")) {
    fail(400, "Preview source must be a local file URL");
  }
  const allowedRoots = [
    resolve(get_settings().files_dir),
    resolve(get_settings().workspace_dir),
    join(resolve(get_settings().data_dir), "library", "files"),
  ];
  const candidate = resolve(pathOnly);
  if (!allowedRoots.some((r) => candidate === r || candidate.startsWith(r + sep))) {
    fail(400, "Unsupported preview source URL");
  }
  return {
    filename: basename(candidate),
    bytes: async () => readFileSync(candidate),
  };
}

async function pdfResponse(c: Context, data: Buffer, filename: string): Promise<Response> {
  const suffix = extname(filename).toLowerCase();
  if (!OFFICE_SUFFIXES.has(suffix)) return httpError(c, 415, "Unsupported Office file type");
  try {
    const pdf = await renderOfficePdf(data, filename, defaultCacheDir());
    const pdfName = `${filename.replace(/\.[^.]+$/, "").replace(/[^\x20-\x7e]/g, "_")}.pdf`;
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdfName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (exc) {
    if (exc instanceof OfficePreviewInvalid) return httpError(c, 422, exc.message);
    if (exc instanceof OfficePreviewUnavailable) return httpError(c, 503, exc.message);
    if (exc instanceof OfficePreviewTimeout) return httpError(c, 504, exc.message);
    if (exc instanceof OfficePreviewConversionFailed) return httpError(c, 502, exc.message);
    throw exc;
  }
}

mediaRouter.get("/api/file-preview/pdf", async (c) => {
  const source = c.req.query("source") ?? "";
  try {
    const { bytes, filename } = previewSourcePath(source);
    const data = await bytes();
    if (data.length > MAX_OFFICE_BYTES + 1) return httpError(c, 413, "Office file is too large to preview");
    return pdfResponse(c, data, filename);
  } catch (exc) {
    const status = (exc as AnyDict)?.status ?? 500;
    return httpError(c, status, exc instanceof Error ? exc.message : String(exc));
  }
});

mediaRouter.post("/api/file-preview/pdf", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.["file"];
  if (!file || typeof file === "string") return httpError(c, 400, "file is required");
  const filename = String(file.name ?? "");
  const suffix = extname(filename).toLowerCase();
  if (!OFFICE_SUFFIXES.has(suffix)) return httpError(c, 415, "Unsupported Office file type");
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > MAX_OFFICE_BYTES + 1) return httpError(c, 413, "Office file is too large to preview");
  return pdfResponse(c, data, filename);
});

// ==========================================================================
// render_storage.py — /files/workspace-items/{wid}/{item_id}/...
// ==========================================================================

function localBrowser(c: Context, requireOrigin = false): boolean {
  const origin = c.req.header("origin") ?? "";
  const host = c.req.header("x-deeptutor-frontend-host") ?? new URL(c.req.url).hostname;
  const isLoopback = (h: string) => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(h);
  let originHost = "";
  try { originHost = new URL(origin).hostname || ""; } catch { return false; }
  return (
    isLoopback(host) &&
    (!requireOrigin || !!origin) &&
    (!origin || isLoopback(originHost))
  );
}

function workspaceItemPath(workspaceId: string, itemId: string): string | null {
  // Published workspace items live under <workspace>/items/<id>/ — best-effort
  // resolution mirroring get_content_workspace_service().resolve_published_item.
  const wsRoot = resolve(get_settings().workspace_dir);
  const candidates = [
    join(wsRoot, workspaceId, "items", itemId),
    join(wsRoot, "items", workspaceId, itemId),
    join(wsRoot, workspaceId, itemId),
  ];
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return resolve(dir);
  }
  return null;
}

function fingerprint64(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function listFilesDeep(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const e of fsReaddirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) out.push(...listFilesDeep(p));
      else out.push(p);
    }
  } catch { /* ignore */ }
  return out;
}

mediaRouter.get("/files/workspace-items/:workspace_id/:item_id/render-storage", (c) => {
  const dir = workspaceItemPath(c.req.param("workspace_id"), c.req.param("item_id"));
  if (!dir) return httpError(c, 404, "Workspace item not found");
  const renderDir = join(dir, "render");
  const files = existsSync(renderDir) ? listFilesDeep(renderDir) : [];
  return c.json({
    workspace_id: c.req.param("workspace_id"),
    workspace_item_id: c.req.param("item_id"),
    file_path: renderDir,
    files,
    fingerprint: fingerprint64(`${dir}:render`),
    can_reveal: localBrowser(c),
  });
});

mediaRouter.get("/files/workspace-items/:workspace_id/:item_id/file-storage", (c) => {
  const dir = workspaceItemPath(c.req.param("workspace_id"), c.req.param("item_id"));
  if (!dir) return httpError(c, 404, "Workspace item not found");
  return c.json({
    workspace_id: c.req.param("workspace_id"),
    workspace_item_id: c.req.param("item_id"),
    file_path: dir,
    fingerprint: fingerprint64(`${dir}:file`),
    can_reveal: localBrowser(c),
  });
});

mediaRouter.post("/files/workspace-items/:workspace_id/:item_id/clean-render-cache", async (c) => {
  const payload = await c.req.json().catch(() => ({})) as AnyDict;
  if (!/^[0-9a-f]{64}$/.test(String(payload?.fingerprint ?? ""))) {
    return httpError(c, 422, "fingerprint must be 64 lowercase hex chars");
  }
  return httpError(c, 409, "Render cache cleanup is not supported by this backend.");
});

mediaRouter.post("/files/workspace-items/:workspace_id/:item_id/remove-generated-output", async (c) => {
  const payload = await c.req.json().catch(() => ({})) as AnyDict;
  if (!/^[0-9a-f]{64}$/.test(String(payload?.fingerprint ?? ""))) {
    return httpError(c, 422, "fingerprint must be 64 lowercase hex chars");
  }
  return httpError(c, 409, "Generated output cleanup is not supported by this backend.");
});

mediaRouter.post("/files/workspace-items/:workspace_id/:item_id/reveal", (c) => {
  if (!localBrowser(c, true)) {
    return httpError(c, 403, "Reveal is available only from a local browser.");
  }
  return httpError(c, 409, "Unable to reveal this file.");
});

mediaRouter.post("/files/workspace-items/:workspace_id/:item_id/reveal-generated-output", (c) => {
  if (!localBrowser(c, true)) {
    return httpError(c, 403, "Reveal is available only from a local browser.");
  }
  return httpError(c, 409, "Unable to reveal this file.");
});
