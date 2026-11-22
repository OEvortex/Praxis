// Minimal read-only ZIP reader (central-directory based) used by the
// visualizer importer and the practice XLSX parser. Supports stored (0) and
// deflate (8) entries — everything a browser/Excel produces for these flows.
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  isDirectory: boolean;
  size: number; // uncompressed bytes
  compressedSize: number;
  compressionMethod: number;
  data: Buffer; // lazily not stored; filled by readZip
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Find the End Of Central Directory record by scanning backwards. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error("not a zip archive (no end-of-central-directory)");
}

export function readZip(buf: Buffer, maxEntries = 5000): ZipEntry[] {
  if (buf.length < 22) throw new Error("not a zip archive");
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) {
    throw new Error(`zip archive has too many entries (${count})`);
  }
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error("corrupt zip central directory");
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);

    // Local header: signature(4) version(2) flags(2) method(2) time(2)
    // date(2) crc(4) csize(4) usize(4) namelen(2) extralen(2)
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`corrupt zip local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buf.length) throw new Error(`zip entry out of bounds: ${name}`);
    const raw = buf.subarray(dataStart, dataEnd);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw);
      } catch {
        throw new Error(`unsupported zip compression for ${name}`);
      }
    } else {
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    if (data.length !== size) {
      // Some writers misreport sizes; accept the inflated bytes anyway.
    }
    entries.push({
      name: name.replace(/\\/g, "/"),
      isDirectory: name.endsWith("/"),
      size,
      compressedSize,
      compressionMethod: method,
      data,
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract a zip into `destDir` with traversal + size guards. Returns count. */
export async function extractZip(
  buf: Buffer,
  destDir: string,
  opts: {
    maxBytes?: number;
    maxEntries?: number;
    maxEntryBytes?: number;
    maxRatio?: number;
    allowedSuffixes?: Set<string>;
  } = {},
): Promise<number> {
  const {
    maxBytes = 25 * 1024 * 1024,
    maxEntries = 200,
    maxEntryBytes = 10 * 1024 * 1024,
    maxRatio = 100,
    allowedSuffixes,
  } = opts;
  const entries = readZip(buf, 10000);
  const files = entries.filter((e) => !e.isDirectory);
  if (files.length > maxEntries) {
    throw new Error(`package contains too many files (${files.length})`);
  }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { resolve, sep } = await import("node:path");
  const root = resolve(destDir);
  let total = 0;
  let written = 0;
  for (const entry of files) {
    const rel = entry.name;
    if (rel.startsWith("/") || rel.split("/").includes("..")) {
      throw new Error(`illegal package path: ${rel}`);
    }
    const base = rel.split("/").pop() ?? "";
    if (base.startsWith(".")) continue; // hidden / __MACOSX junk
    if (rel.startsWith("__MACOSX/")) continue;
    const dot = rel.lastIndexOf(".");
    const suffix = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
    if (allowedSuffixes && !allowedSuffixes.has(suffix)) {
      throw new Error(`unsupported package file type: ${rel}`);
    }
    if (entry.size > maxEntryBytes) {
      throw new Error(`package entry is too large: ${rel}`);
    }
    if (entry.compressedSize > 0 && entry.size / entry.compressedSize > maxRatio) {
      throw new Error(`suspicious compression ratio: ${rel}`);
    }
    total += entry.size;
    if (total > maxBytes) throw new Error("expanded package exceeds size limit");
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`illegal package path: ${rel}`);
    }
    mkdirSync(target.slice(0, target.length - base.length), { recursive: true });
    writeFileSync(target, entry.data);
    written++;
  }
  return written;
}
