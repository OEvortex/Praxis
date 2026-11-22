// bounded, cached Office→PDF
// rendering via LibreOffice (soffice). Optional dependency: returns an
// "unavailable" error the route maps to 503.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { get_settings } from "../config.js";

const execFileAsync = promisify(execFile);

export const MAX_OFFICE_BYTES = 25 * 1024 * 1024;
export const MAX_PREVIEW_PDF_BYTES = 60 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_FILES = 200;
const MAX_CACHE_TOTAL_BYTES = 512 * 1024 * 1024;
export const OFFICE_SUFFIXES = new Set([
  ".docx", ".docm", ".doc", ".pptx", ".pptm", ".ppt", ".xlsx", ".xlsm", ".xls",
]);

export class OfficePreviewError extends Error {}
export class OfficePreviewUnavailable extends OfficePreviewError {}
export class OfficePreviewTimeout extends OfficePreviewError {}
export class OfficePreviewInvalid extends OfficePreviewError {}
export class OfficePreviewConversionFailed extends OfficePreviewError {}

let slots = 2;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (slots > 0) { slots--; return; }
  await new Promise<void>((r) => waiters.push(r));
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); else slots++;
}

let sofficePath: Promise<string | null> | null = null;
function findSoffice(): Promise<string | null> {
  sofficePath ??= execFileAsync("which", ["soffice"], { timeout: 5000 })
    .then((r) => r.stdout.trim() || null)
    .catch(() => null);
  return sofficePath;
}

export async function renderOfficePdf(
  data: Buffer,
  filename: string,
  cacheDir: string,
): Promise<Buffer> {
  const suffix = (filename.match(/\.[A-Za-z0-9]+$/) ?? [""])[0].toLowerCase();
  if (!OFFICE_SUFFIXES.has(suffix)) {
    throw new OfficePreviewInvalid("Unsupported Office file type");
  }
  if (!data.length || data.length > MAX_OFFICE_BYTES) {
    throw new OfficePreviewInvalid("Office file is empty or too large to preview");
  }
  const soffice = await findSoffice();
  if (!soffice) {
    throw new OfficePreviewUnavailable("LibreOffice is not installed on the server");
  }
  await acquire();
  try {
    return await renderSync(data, suffix, cacheDir, soffice);
  } finally {
    release();
  }
}

async function renderSync(
  data: Buffer,
  suffix: string,
  cacheDir: string,
  soffice: string,
): Promise<Buffer> {
  const key = createHash("sha256")
    .update("office-preview-v1\0")
    .update(suffix)
    .update("\0")
    .update(data)
    .digest("hex");

  let cacheAvailable = true;
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    cacheAvailable = false;
  }
  if (cacheAvailable) pruneCache(cacheDir);
  const cached = join(cacheDir, `${key}.pdf`);
  if (cacheAvailable && existsSync(cached) && !statSync(cached).isSymbolicLink()) {
    try {
      const st = statSync(cached);
      if (st.size > 0 && st.size <= MAX_PREVIEW_PDF_BYTES) {
        const result = await readFile(cached);
        if (result.subarray(0, 4).toString() === "%PDF") return result;
      }
    } catch { /* fall through */ }
  }

  const work = await mkdtemp(join(tmpdir(), "deeptutor-office-preview-"));
  try {
    const source = join(work, `source${suffix}`);
    await writeFile(source, data);
    const outputDir = join(work, "output");
    mkdirSync(outputDir);
    const profile = join(work, "profile");
    mkdirSync(profile);
    await runSoffice(soffice, profile, outputDir, source, work);
    const rendered = join(outputDir, "source.pdf");
    if (!existsSync(rendered)) {
      throw new OfficePreviewConversionFailed("LibreOffice could not render this file");
    }
    if (statSync(rendered).size > MAX_PREVIEW_PDF_BYTES) {
      throw new OfficePreviewInvalid("Rendered PDF is too large to preview");
    }
    const pdf = await readFile(rendered);
    if (pdf.subarray(0, 4).toString() !== "%PDF") {
      throw new OfficePreviewConversionFailed("LibreOffice produced an invalid PDF");
    }
    if (cacheAvailable) {
      try {
        const tmp = join(cacheDir, `.pending-${key}.pdf`);
        writeFileSync(tmp, pdf);
        renameSync(tmp, cached);
      } catch { /* cache write best-effort */ }
    }
    return pdf;
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

function runSoffice(
  soffice: string,
  profile: string,
  outputDir: string,
  source: string,
  cwd: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      soffice,
      [
        `-env:UserInstallation=file://${profile}`,
        "--headless",
        "--convert-to", "pdf",
        "--outdir", outputDir,
        source,
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch { /* ignore */ }
      reject(new OfficePreviewTimeout("Office preview conversion timed out"));
    }, CONVERSION_TIMEOUT_MS);
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new OfficePreviewConversionFailed(`Could not start LibreOffice: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new OfficePreviewConversionFailed(`LibreOffice exited ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

function pruneCache(cacheDir: string): void {
  try {
    const files = readdirSync(cacheDir)
      .filter((f) => f.endsWith(".pdf"))
      .map((f) => join(cacheDir, f));
    files.sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
    });
    const cutoff = Date.now() - CACHE_TTL_MS;
    let retained = 0;
    for (const [index, file] of files.entries()) {
      try {
        const st = statSync(file);
        if (st.isSymbolicLink()) { rmSync(file, { force: true }); continue; }
        if (index >= MAX_CACHE_FILES || st.mtimeMs < cutoff || retained + st.size > MAX_CACHE_TOTAL_BYTES) {
          rmSync(file, { force: true });
        } else {
          retained += st.size;
        }
      } catch { /* ignore */ }
    }
  } catch { /* best effort */ }
}

/** Default cache dir: <workspace>/cache/office_previews */
export function defaultCacheDir(): string {
  return join(get_settings().workspace_dir, "cache", "office_previews");
}
