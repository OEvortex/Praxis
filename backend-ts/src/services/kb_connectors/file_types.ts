// Port of deeptutor/utils/file_types.py — extension classification used by
// upload policy, linked-folder scanning and supported-file-types endpoint.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { isFile } from "./store.js";

export const PDF_EXTENSIONS = new Set([".pdf"]);
export const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
export const EPUB_EXTENSIONS = new Set([".epub"]);
export const PARSER_EXTENSIONS = new Set([
  ...PDF_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
  ...EPUB_EXTENSIONS,
]);

export const TEXT_EXTENSIONS = new Set([
  ".txt", ".text", ".log", ".md", ".markdown", ".mdx", ".rst", ".asciidoc",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".csv", ".tsv",
  ".ini", ".cfg", ".conf", ".env", ".properties",
  ".tex", ".latex", ".bib",
  ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx",
  ".vue", ".svelte", ".py",
  ".java", ".kt", ".kts", ".scala", ".groovy", ".gradle",
  ".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx",
  ".cs", ".go", ".rs", ".zig", ".nim",
  ".swift", ".m", ".mm",
  ".rb", ".php", ".pl", ".pm", ".lua", ".r", ".jl", ".dart",
  ".hs", ".clj", ".cljs", ".cljc", ".ex", ".exs", ".erl", ".ml", ".mli",
  ".fs", ".fsx", ".lisp", ".lsp", ".scm", ".rkt",
  ".html", ".htm", ".xml", ".svg", ".css", ".scss", ".sass", ".less",
  ".sol",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".vim",
  ".sql", ".graphql", ".gql", ".proto",
  ".cmake", ".mk", ".tf", ".hcl", ".nginxconf", ".dockerfile",
]);

export const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
]);

export function getSupportedExtensions(): Set<string> {
  return new Set([...PARSER_EXTENSIONS, ...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS]);
}

/** Upstream ``accepted_upload_extensions`` — parse-service backed upstream;
 *  here the full supported set (no optional rich-parser engines ported). */
export function acceptedUploadExtensions(): Set<string> {
  return getSupportedExtensions();
}

export function isTextFile(path: string, sampleSize = 8192): boolean {
  try {
    const fd = readFileSync(path);
    const chunk = fd.subarray(0, sampleSize);
    if (chunk.includes(0)) return false;
    // Reject obvious binary: try strict UTF-8 decode of the sample.
    new TextDecoder("utf-8", { fatal: true }).decode(chunk.subarray(0, chunk.length - (chunk.length % 1)));
    return true;
  } catch {
    return false;
  }
}

/** Longest-suffix extension match, mirroring FileTypeRouter.get_extension. */
export function getExtension(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop()!.toLowerCase();
  const supported = getSupportedExtensions();
  let best = "";
  for (const ext of supported) {
    const e = ext.toLowerCase();
    if (name.endsWith(e) && e.length > best.length) best = e;
  }
  return best || extname(filePath).toLowerCase();
}

export function hasSupportedExtension(filePath: string): boolean {
  const ext = getExtension(filePath);
  if (getSupportedExtensions().has(ext)) return true;
  return isTextFile(filePath);
}

/** FileTypeRouter.collect_supported_files(directory, recursive). */
export function collectSupportedFiles(
  directory: string,
  recursive = false,
): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(p);
      } else if (entry.isFile() && hasSupportedExtension(p)) {
        out.push(p);
      }
    }
  };
  walk(directory);
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// decode_bytes fallback chain (utf-8 strict, then locale-ish fallbacks)
const TEXT_DECODING_CANDIDATES = [
  "utf-8",
  "utf-8-sig",
  "gbk",
  "gb2312",
  "gb18030",
  "cp1252",
  "latin-1",
];

export function decodeBytes(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // Node's TextDecoder supports what ICU provides; try the common ones.
    for (const enc of ["utf-8-sig", "latin1"]) {
      try {
        return new TextDecoder(enc).decode(data);
      } catch {
        /* continue */
      }
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(data);
  }
}

export { isFile };
import { readdirSync } from "node:fs";
import { join } from "node:path";
