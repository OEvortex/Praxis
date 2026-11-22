// rasterize one
// PDF page (optionally a normalized region) for the knowledge-base
// source-page endpoint. Upstream uses PyMuPDF; this backend shells out to
// poppler's pdftoppm (region crops supported) with a MuPDF mutool fallback
// for full pages. Every failure raises Error with a user-facing message; the
// router maps it to 422, matching upstream.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// visual_assets.MAX_IMAGE_BYTES upstream.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 512 * 1024 * 1024;
// Upstream pixel budget: scale = min(cap, sqrt(8MP / clip area in points)).
const PIXEL_BUDGET = 8_000_000;
const FULL_PAGE_SCALE_CAP = 2;
const REGION_SCALE_CAP = 4;

export interface PdfPageImage {
  data: Buffer;
  mime: string;
  scale: number;
}

interface PageBox {
  width: number; // points
  height: number; // points
}

interface CmdResult {
  ok: boolean;
  spawnError: boolean;
  stdout: Buffer;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { input?: Buffer } = {}): CmdResult {
  try {
    const res = spawnSync(cmd, args, {
      input: opts.input,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      encoding: "buffer",
    });
    return {
      ok: !res.error && res.status === 0,
      spawnError: Boolean(res.error),
      stdout: res.stdout ?? Buffer.alloc(0),
      stderr: res.stderr ? res.stderr.toString("utf8") : String(res.error?.message ?? ""),
    };
  } catch (exc) {
    return {
      ok: false,
      spawnError: true,
      stdout: Buffer.alloc(0),
      stderr: String((exc as Error).message ?? exc),
    };
  }
}

function binaryAvailable(cmd: string): boolean {
  // Any executed process counts — ENOENT surfaces as spawnError.
  return !run(cmd, ["-v"]).spawnError;
}

/** "Pages: N" and per-page "Page    N size:  W x H pts" from pdfinfo. */
function pdfInfo(fsPath: string, page: number): { pages: number; size: PageBox | null } {
  const all = run("pdfinfo", [fsPath]);
  const pagesMatch = /Pages:\s+(\d+)/.exec(all.stdout.toString("utf8"));
  const pages = pagesMatch ? parseInt(pagesMatch[1]!, 10) : 0;
  const one = run("pdfinfo", ["-f", String(page), "-l", String(page), fsPath]);
  const text = one.stdout.toString("utf8");
  const sizeMatch = /Page\s+\d+\s+size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/.exec(text);
  const size = sizeMatch
    ? { width: parseFloat(sizeMatch[1]!), height: parseFloat(sizeMatch[2]!) }
    : null;
  return { pages, size };
}

function parseRegion(region: string): [number, number, number, number] {
  const parts = region.split(",").map((v) => Number(v.trim()));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error("region must contain four finite normalized coordinates.");
  }
  const [x0, y0, x1, y1] = parts as [number, number, number, number];
  if (!(0 <= x0 && x0 < x1 && x1 <= 1 && 0 <= y0 && y0 < y1 && y1 <= 1)) {
    throw new Error("region must satisfy 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1.");
  }
  return [x0, y0, x1, y1];
}

function renderWithPdftoppm(
  fsPath: string,
  page: number,
  dpi: number,
  regionPx: { x: number; y: number; w: number; h: number } | null,
  dir: string,
  tag: string,
): { data: Buffer; mime: string } | null {
  const args = [
    "-f", String(page), "-l", String(page),
    "-r", String(dpi),
    "-singlefile",
  ];
  if (regionPx) {
    args.push("-x", String(regionPx.x), "-y", String(regionPx.y),
      "-W", String(regionPx.w), "-H", String(regionPx.h));
  }
  // PNG first; JPEG fallback when the PNG exceeds the model byte budget.
  for (const [ext, extra] of [["png", ["-png"]], ["jpeg", ["-jpeg", "-jpegopt", "quality=90"]]] as const) {
    const prefix = join(dir, `${tag}-${ext}`);
    const res = run("pdftoppm", [...args, ...extra, fsPath, prefix]);
    if (!res.ok) return null;
    const outPath = `${prefix}.${ext === "jpeg" ? "jpg" : "png"}`;
    if (!existsSync(outPath)) return null;
    const data = readFileSync(outPath);
    if (data.length <= MAX_IMAGE_BYTES) {
      return { data, mime: ext === "jpeg" ? "image/jpeg" : "image/png" };
    }
    if (ext === "jpeg") {
      throw new Error("Page image exceeds the model byte budget. Select a smaller region.");
    }
  }
  return null;
}

function renderWithMutool(
  fsPath: string,
  page: number,
  dpi: number,
  dir: string,
): { data: Buffer; mime: string } | null {
  const outPath = join(dir, "mutool.png");
  const res = run("mutool", ["draw", "-F", "png", "-r", String(dpi), "-o", outPath, fsPath, String(page)]);
  if (!res.ok || !existsSync(outPath)) return null;
  const data = readFileSync(outPath);
  if (data.length > MAX_IMAGE_BYTES) {
    throw new Error("Page image exceeds the model byte budget. Select a smaller region.");
  }
  return { data, mime: "image/png" };
}

/**
 * Render `page` (1-indexed) of the PDF at `fsPath` to PNG/JPEG bytes.
 * `region` is "x0,y0,x1,y1" normalized coordinates, or "" for the full page.
 */
export function renderPdfPageImage(
  fsPath: string,
  page: number,
  region: string,
): PdfPageImage {
  if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
    throw new Error("Source is unavailable; select an existing document.");
  }
  if (statSync(fsPath).size > MAX_PDF_BYTES) {
    throw new Error("PDF exceeds the 512 MiB page-inspection limit. Open the original document.");
  }

  const crop = region ? parseRegion(region) : null;

  const hasPdftoppm = binaryAvailable("pdftoppm");
  const hasMutool = !hasPdftoppm && binaryAvailable("mutool");
  const hasPdfinfo = binaryAvailable("pdfinfo");
  if (!hasPdftoppm && !hasMutool) {
    throw new Error(
      "PDF page rendering is not available in this backend; " +
        "install poppler-utils (pdftoppm) or MuPDF (mutool) to enable it.",
    );
  }
  if (crop && !hasPdftoppm) {
    throw new Error("Region crops need poppler-utils (pdftoppm); only full pages can be rendered here.");
  }

  // Page geometry for the upstream-equivalent scale + crop math.
  let pages = 0;
  let pageBox: PageBox | null = null;
  if (hasPdfinfo) {
    const info = pdfInfo(fsPath, page);
    pages = info.pages;
    pageBox = info.size;
  }
  if (pages > 0 && (page < 1 || page > pages)) {
    throw new Error(`Page must be between 1 and ${pages}.`);
  }

  const clipW = crop && pageBox ? (crop[2] - crop[0]) * pageBox.width : pageBox?.width ?? 612;
  const clipH = crop && pageBox ? (crop[3] - crop[1]) * pageBox.height : pageBox?.height ?? 792;
  const cap = crop ? REGION_SCALE_CAP : FULL_PAGE_SCALE_CAP;
  const scale = Math.min(cap, Math.sqrt(PIXEL_BUDGET / Math.max(clipW * clipH, 1)));
  const dpi = Math.max(36, Math.round(scale * 72));

  let regionPx: { x: number; y: number; w: number; h: number } | null = null;
  if (crop && pageBox) {
    regionPx = {
      x: Math.max(0, Math.round(crop[0] * pageBox.width * scale)),
      y: Math.max(0, Math.round(crop[1] * pageBox.height * scale)),
      w: Math.max(1, Math.round((crop[2] - crop[0]) * pageBox.width * scale)),
      h: Math.max(1, Math.round((crop[3] - crop[1]) * pageBox.height * scale)),
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "praxis-source-page-"));
  try {
    let rendered: { data: Buffer; mime: string } | null = null;
    let lastStderr = "";
    if (hasPdftoppm) {
      rendered = renderWithPdftoppm(fsPath, page, dpi, regionPx, dir, "page");
      if (!rendered) {
        // Distinguish "page out of range / encrypted" from a hard failure.
        const probe = run("pdftoppm", ["-f", String(page), "-l", String(page), "-r", "36", "-singlefile", "-png", fsPath, join(dir, "probe")]);
        lastStderr = probe.stderr;
      }
    } else {
      rendered = renderWithMutool(fsPath, page, dpi, dir);
      if (!rendered) lastStderr = "mutool draw failed";
    }
    if (!rendered) {
      if (/password|encrypt/i.test(lastStderr)) {
        throw new Error("PDF is encrypted; provide an unlocked source.");
      }
      throw new Error(
        "PDF page could not be decoded. Open the source or replace the damaged document.",
      );
    }
    return { data: rendered.data, mime: rendered.mime, scale };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
