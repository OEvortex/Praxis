// markdown documents with
// footnote-style citations. Pure parse/serialize; no I/O.
//
// New format:  "- text [^1], [^3] <!--m_xxx-->"  + "[^1]: notebook:abc"
// Legacy:      "- text[^m_xxx]"                  + "[^m_xxx]: ref1, ref2"
import { is_entry_id } from "./ids.js";

const ENTRY_ID_RE_SRC = "m_[0-9A-HJKMNP-TV-Z]{26}";

const TITLE_RE = /^#\s+(.+?)\s*$/;
const SECTION_RE = /^##\s+(.+?)\s*$/;

// "- text [^1], [^3] <!--m_xxx-->" — markers optional, commas tolerated.
const NEW_BULLET_RE = new RegExp(
  String.raw`^\s*-\s+(?<text>.*?)(?<markers>(?:\s*,?\s*\[\^\d+\])*)\s*<!--\s*(?<id>${ENTRY_ID_RE_SRC})\s*-->\s*$`,
);
const OLD_BULLET_RE = new RegExp(
  String.raw`^\s*-\s+(?<text>.*?)\[\^(?<id>${ENTRY_ID_RE_SRC})\]\s*$`,
);
const OLD_FOOTNOTE_RE = new RegExp(
  String.raw`^\[\^(?<id>${ENTRY_ID_RE_SRC})\]:\s*(?<refs>.*?)\s*$`,
);
const NEW_FOOTNOTE_RE = /^\[\^(?<label>[^\]]+)\]:\s*(?<ref>.*?)\s*$/;
const MARKER_RE = /\[\^([^\]]+)\]/g;

export interface Entry {
  id: string;
  section: string;
  text: string;
  refs: string[];
}

export interface Document {
  title: string;
  // [sectionName, entries] pairs, insertion-ordered.
  sections: Array<[string, Entry[]]>;
}

export function newDocument(title = ""): Document {
  return { title, sections: [] };
}

export function all_entries(doc: Document): Entry[] {
  return doc.sections.flatMap(([, entries]) => entries);
}

export function find_entry(doc: Document, entryId: string): Entry | null {
  for (const [, entries] of doc.sections) {
    for (const entry of entries) {
      if (entry.id === entryId) return entry;
    }
  }
  return null;
}

export function section_entries(doc: Document, name: string): Entry[] {
  for (const [section, entries] of doc.sections) {
    if (section === name) return entries;
  }
  const entries: Entry[] = [];
  doc.sections.push([name, entries]);
  return entries;
}

export function remove_entry(doc: Document, entryId: string): boolean {
  for (const [, entries] of doc.sections) {
    const i = entries.findIndex((e) => e.id === entryId);
    if (i >= 0) {
      entries.splice(i, 1);
      return true;
    }
  }
  return false;
}

export function parse(md: string): Document {
  const rawLines = md.split("\n");

  // Pass 1 — collect footnote definitions (both layouts).
  const refsByEntry = new Map<string, string[]>();
  const refByLabel = new Map<string, string>();
  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/, "");
    const mOldFn = OLD_FOOTNOTE_RE.exec(line);
    if (mOldFn?.groups) {
      const refsRaw = mOldFn.groups["refs"] ?? "";
      refsByEntry.set(
        mOldFn.groups["id"] ?? "",
        refsRaw
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
      );
      continue;
    }
    const mNewFn = NEW_FOOTNOTE_RE.exec(line);
    if (mNewFn?.groups) {
      const label = mNewFn.groups["label"] ?? "";
      if (label.startsWith("m_")) continue; // entry-keyed row, handled above
      refByLabel.set(label, (mNewFn.groups["ref"] ?? "").trim());
    }
  }

  // Pass 2 — title, sections, bullets.
  const doc = newDocument();
  let currentEntries: Entry[] | null = null;
  let currentSection: string | null = null;
  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/, "");

    if (!doc.title) {
      const mTitle = TITLE_RE.exec(line);
      if (mTitle) {
        doc.title = (mTitle[1] ?? "").trim();
        continue;
      }
    }

    const mSection = SECTION_RE.exec(line);
    if (mSection) {
      currentSection = (mSection[1] ?? "").trim();
      currentEntries = [];
      doc.sections.push([currentSection, currentEntries]);
      continue;
    }

    const mNewB = NEW_BULLET_RE.exec(line);
    if (mNewB?.groups && currentEntries !== null && currentSection !== null) {
      const entryId = mNewB.groups["id"] ?? "";
      const text = (mNewB.groups["text"] ?? "").replace(/\s+$/, "");
      const markers = (mNewB.groups["markers"] ?? "").match(MARKER_RE) ?? [];
      const entryRefs: string[] = [];
      for (const marker of markers) {
        const label = marker.replace(/^\[\^/, "").replace(/\]$/, "");
        const ref = refByLabel.get(label);
        if (ref !== undefined && !entryRefs.includes(ref)) entryRefs.push(ref);
      }
      currentEntries.push({
        id: entryId,
        section: currentSection,
        text,
        refs: entryRefs,
      });
      continue;
    }

    const mOldB = OLD_BULLET_RE.exec(line);
    if (mOldB?.groups && currentEntries !== null && currentSection !== null) {
      const entryId = mOldB.groups["id"] ?? "";
      const text = (mOldB.groups["text"] ?? "").trim();
      currentEntries.push({
        id: entryId,
        section: currentSection,
        text,
        refs: [...(refsByEntry.get(entryId) ?? [])],
      });
    }
  }
  return doc;
}

export function serialize(doc: Document): string {
  // 1. Consolidated ref → label map in first-appearance order.
  const refOrder: string[] = [];
  const refToLabel = new Map<string, number>();
  for (const entry of all_entries(doc)) {
    for (const ref of entry.refs) {
      if (refToLabel.has(ref)) continue;
      refToLabel.set(ref, refOrder.length + 1);
      refOrder.push(ref);
    }
  }

  const lines: string[] = [];
  if (doc.title) {
    lines.push(`# ${doc.title}`, "");
  }

  for (const [section, entries] of doc.sections) {
    if (!entries.length) continue;
    lines.push(`## ${section}`, "");
    for (const entry of entries) {
      const markers = entry.refs
        .filter((r) => refToLabel.has(r))
        .map((r) => `[^${refToLabel.get(r)}]`)
        .join(", ");
      const text = entry.text.replace(/\s+$/, "");
      lines.push(
        markers ? `- ${text} ${markers} <!--${entry.id}-->` : `- ${text} <!--${entry.id}-->`,
      );
    }
    lines.push("");
  }

  if (refOrder.length) {
    lines.push("---", "");
    refOrder.forEach((ref, i) => lines.push(`[^${i + 1}]: ${ref}`));
    lines.push("");
  }

  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

export { is_entry_id };
