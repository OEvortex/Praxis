// Port of backend/app/api/files.py — static file serving for agent outputs
// and attachments (``GET /files/<path>``).
import { Hono } from "hono";
import { existsSync, statSync, createReadStream } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { get_settings } from "../config.js";
import { mediaRouter } from "./media.js";
import { miscRouter } from "./misc.js";
import { systemExtRouter } from "./system_ext.js";

export const filesRouter = new Hono();

// Routers ported in this batch are composed here because main.ts owns the
// top-level mount list. Register them BEFORE the /files/* wildcard below so
// the specific /files/outputs|attachments|library|workspace-items handlers win
// over the generic static catch-all. (handlersRouter is mounted earlier in
// main.ts, so its overlapping stub routes still take precedence for the small
// set of paths it already defines — see the port report.)
filesRouter.route("/", mediaRouter);
filesRouter.route("/", miscRouter);
filesRouter.route("/", systemExtRouter);

// Generated video lessons are pages of model-written script. Serve them in an
// opaque origin (even when opened directly) with no access to the API's cookies
// or same-origin data. The in-chat player applies the same sandbox to its iframe.
const SANDBOXED_PAGE_CSP = "sandbox allow-scripts allow-popups";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".zip": "application/zip",
};

function filesRoot(): string {
  const override = (process.env.PRAXIS_FILES_DIR ?? "").trim();
  if (override) return resolve(override);
  const settings = get_settings();
  return resolve(settings.files_dir);
}

// GET /files/{file_path:path}
filesRouter.get("/files/*", async (c) => {
  const filePath = c.req.path.replace(/^\/files\/?/, "");
  const root = filesRoot();
  const resolved = resolve(join(root, normalize(filePath)));
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return c.json({ detail: "Forbidden" }, 403);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return c.json({ detail: "Not Found" }, 404);
  }
  const mediaType = MIME[extname(resolved).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Cache-Control": "private, max-age=60" };
  if (mediaType.startsWith("text/html") && resolved.split(sep).includes("videos")) {
    headers["Content-Security-Policy"] = SANDBOXED_PAGE_CSP;
  }
  const stream = Readable.toWeb(createReadStream(resolved)) as ReadableStream;
  return new Response(stream, {
    headers: { ...headers, "Content-Type": mediaType },
  });
});
