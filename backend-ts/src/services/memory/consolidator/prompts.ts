// The upstream files are YAML with `system: |` / `user: |` literal blocks;
// they are embedded verbatim here and parsed with a tiny literal-block reader
// (no yaml dependency in this package).

interface PromptFile {
  system: string;
  user: string;
}

const RAW: Record<string, Record<string, string>> = {
  en: {
    update_l2: `system: |
  You are the memory curator for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of the user's recent {surface} activity
  (raw, untruncated). Extract durable facts about the user.

  OUTPUT: A single JSON object — nothing else, no prose, no fences.

      {{"facts": [
        {{"text":   "<≤240 chars; one fact per item>",
          "section": "<one of: {sections}>",
          "refs":   ["<surface>:<entity_id>", ...]}}
      ]}}

  HARD RULES
  - Every fact must have ≥1 ref. Each ref must come from the
    "Chunk-local citeable refs" list or the "@entity <surface>:<id>"
    markers you see in the chunk below — do NOT invent ids, do NOT cite
    entities outside this chunk.
  - text ≤ 240 chars. Be terse, verb-led ("uses X", "stuck on Y").
  - Banned absolutist phrasing (unless wrapping in quotes):
    deeply, truly, mastered, expert, passionate, loves, hates, always,
    never, fully understands.
  - Surface focus: {focus}.
  - If nothing material is in this chunk, emit \`{{"facts": []}}\` —
    that is a correct, expected answer.

  Today is {today}.

user: |
  # Existing {surface} memory (do not duplicate items already captured here):
  {existing}

  # Source chunk {chunk_index}/{chunk_total} (chars {chunk_start}..{chunk_end}):
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON. Cite only refs listed or visible in the chunk above.
`,
    update_l3: `system: |
  You are the cross-surface memory curator for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of L2 summaries from one or more
  surfaces (chat / notebook / quiz / kb / book / partner / cowriter).
  Synthesize durable, hedged claims about the user.

  OUTPUT: A single JSON object — nothing else.

      {{"facts": [
        {{"text":   "<≤240 chars, hedged with surface/count>",
          "section": "<one of: {sections}>",
          "refs":   ["<surface>", ...]}}
      ]}}

  HARD RULES
  - \`refs\` are **bare surface names** taken from the chunk's
    "Chunk-local citeable refs" list (e.g. \`chat\`, \`notebook\`).
    Never emit \`m_xxx\`, \`surface:id\`, or any entry id. One fact
    may cite multiple surfaces if it genuinely synthesizes across them.
  - text ≤ 240 chars. Forced hedge template: claims must be of the
    form "Across N <surface> interactions, the user X" or
    "<surface> entries show the user X" — bind to a surface or count.
  - Banned absolutist phrasing (unless quoting):
    deeply, truly, mastered, expert, passionate, loves, hates, always,
    never, fully understands.
  - Slot focus: {focus}.
  - Empty \`{{"facts": []}}\` is a correct answer if nothing in this
    chunk warrants a new L3 claim.

  Today is {today}.

user: |
  # Existing {slot} memory (do not duplicate):
  {existing}

  # L2 chunk {chunk_index}/{chunk_total}:
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON. Cite only surface names from the "Chunk-local citeable
  refs" list at the top of the chunk.
`,
    audit_l2: `system: |
  You are the memory auditor for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of {surface} L2 memory with each
  entry annotated by its **full original source** (no truncation).
  Your job is to find factual errors and edit the memory so it
  matches the evidence.

  OUTPUT: A single JSON object — nothing else.

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240>",
          "refs": ["<surface>:<id>", ...], "reason": "<short>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<short>"}},
        {{"op": "insert",  "after_line": <int>, "text": "<≤240>",
          "refs": ["<surface>:<id>", ...], "section": "<optional>",
          "reason": "<short>"}}
      ]}}

  HARD RULES
  - Line numbers refer to the numbered view of the chunk below.
  - Every replace/insert MUST cite refs from the sources shown for
    that line (or for nearby lines in the same chunk).
  - text/new_text ≤ 240 chars.
  - Don't edit lines that are not bullet entries (titles, blanks,
    section headers). Section creation happens implicitly via insert.
  - Banned absolutist phrasing same as update mode.
  - When nothing needs fixing, emit \`{{"edits": []}}\`. Don't churn.
  - \`reason\` is short prose describing what evidence drives the edit.

  Today is {today}.

user: |
  # Annotated chunk of {surface} memory (each bullet shows its sources):
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON. Edit only lines visible above.
`,
    audit_l3: `system: |
  You are the cross-surface memory auditor for DeepTutor user {user_label}.

  ROLE: You are reading a chunk of {slot} L3 memory annotated with
  the **full L2 entries** it cites. Find claims that are
  overgeneralized, contradicted by L2, or no longer supported.

  OUTPUT: A single JSON object — nothing else.

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240, hedged>",
          "refs": ["m_xxx", ...], "reason": "<short>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<short>"}},
        {{"op": "insert",  "after_line": <int>, "text": "<≤240, hedged>",
          "refs": ["m_xxx", ...], "section": "<optional>",
          "reason": "<short>"}}
      ]}}

  HARD RULES (same as update_l3 plus audit-specific):
  - replace/insert must cite L2 m_xxx ids visible in the annotated
    sources of this chunk.
  - Hedge: claims of the form "Across N <surface> interactions" or
    "<surface> entries show…".
  - Banned absolutist phrasing.
  - Empty edits is correct when the chunk holds up.

  Today is {today}.

user: |
  # Annotated chunk of {slot} memory (each L3 bullet shows its L2 sources):
  ----------------------------------------------------------------
  {chunk}
  ----------------------------------------------------------------

  Return JSON.
`,
    dedup: `system: |
  You are the memory dedup pass for DeepTutor user {user_label}.

  ROLE: Read the entire memory document below as a line-numbered view.
  Merge duplicates, collapse near-duplicates by replacing one and
  deleting the others, and rewrite muddled entries.

  OUTPUT: A single JSON object — nothing else.

      {{"edits": [
        {{"op": "replace", "line": <int>, "new_text": "<≤240>",
          "refs": ["<source ref from refs=[...]>", ...], "reason": "<short>"}},
        {{"op": "delete",  "line_start": <int>, "line_end": <int>,
          "reason": "<merged into Lx | duplicate of Ly | low signal>"}}
      ]}}

  HARD RULES
  - You may use ONLY replace and delete — no insert. Dedup never adds.
  - When merging A and B: keep the higher-quality one (replace its
    line with the merged text, union of refs) and delete the other.
  - When two entries restate the same fact verbatim, delete the later
    duplicate (lower-line wins).
  - text ≤ 240. Preserve refs (union when merging).
  - Each entry's refs=[...] suffix contains its source references. Copy
    those values exactly; [^m_...] is an entry anchor, not a source ref.
    Do not include the refs metadata suffix in new_text.
  - Banned absolutist phrasing (same list as update mode).
  - If nothing needs deduping, emit \`{{"edits": []}}\`. Don't churn.

  Today is {today}.

user: |
  # Memory document (line-numbered):
  ----------------------------------------------------------------
  {doc}
  ----------------------------------------------------------------

  Iteration {iteration}/{iterations_total}. Return JSON.
`,
  },
};

// _meta.yaml content (per-surface / per-slot focus + suggested sections).
interface MetaEntry {
  focus: string;
  sections: string[];
}
interface MetaFile {
  surfaces: Record<string, MetaEntry>;
  slots: Record<string, MetaEntry>;
}

const META: Record<string, MetaFile> = {
  en: {
    surfaces: {
      chat: {
        focus:
          "Stable misconceptions the user has surfaced, concepts they've demonstrated mastery of, and durable topics they keep returning to. Drop per-turn chatter.",
        sections: ["Misconceptions", "Mastery", "Topics"],
      },
      notebook: {
        focus:
          "Recurring note themes, formats the user prefers, and questions they keep coming back to in their notes.",
        sections: ["Themes", "Formats", "Open questions"],
      },
      quiz: {
        focus:
          "Error patterns across quiz attempts, topics with low/high success rate, and item types the user struggles with.",
        sections: ["Error patterns", "Strong topics", "Struggling topics"],
      },
      kb: {
        focus:
          "Document interests, query patterns into the knowledge base, and gaps in user's library.",
        sections: ["Interests", "Frequent queries", "Library gaps"],
      },
      book: {
        focus:
          "Reading pacing, sticking points (pages reopened or paused), and topics the user annotates heavily.",
        sections: ["Pacing", "Sticking points", "Annotation themes"],
      },
      partner: {
        focus:
          "Persistent themes across partner conversations and channel-specific behaviours.",
        sections: ["Themes", "Channels"],
      },
      cowriter: {
        focus:
          "Writing style preferences, recurring revisions, and topics the user drafts about.",
        sections: ["Style", "Recurring revisions", "Topics"],
      },
    },
    slots: {
      recent: {
        focus:
          "A rolling timeline of what the user has been doing across all surfaces over the last 1–4 weeks. Time-anchored, surface-attributed.",
        sections: ["This week", "Earlier"],
      },
      profile: {
        focus:
          "Durable identity, learning style, and knowledge level. ONLY claims supported by multiple L2 entries across surfaces. No speculation about traits not directly evidenced.",
        sections: ["Identity", "Learning style", "Knowledge level"],
      },
      scope: {
        focus:
          "Concepts and topics the user has demonstrably engaged with, with confidence labels (familiar / practicing / unsure) tied to L2 evidence.",
        sections: ["Familiar", "Practicing", "Unsure"],
      },
    },
  },
};

// ── Minimal `key: |` literal-block YAML reader ────────────────────────

function parseLiteralBlocks(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = /^([A-Za-z_]+):\s*\|\s*$/.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const body: string[] = [];
    i++;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        body.push("");
        i++;
        continue;
      }
      const indent = line.match(/^ */)![0].length;
      if (indent < 2) break;
      body.push(line.slice(2));
      i++;
    }
    // YAML literal blocks end with a single trailing newline.
    while (body.length && body[body.length - 1] === "") body.pop();
    out[key] = body.join("\n") + "\n";
  }
  return out;
}

const PROMPT_CACHE = new Map<string, PromptFile>();
const META_CACHE = new Map<string, MetaFile>();

export function lang_code(language: string): string {
  return "en";
}

export function load_prompt(name: string, language: string): PromptFile {
  const lang = lang_code(language);
  const key = `${lang}:${name}`;
  const cached = PROMPT_CACHE.get(key);
  if (cached) return cached;
  const raw = RAW[lang]?.[name];
  if (raw === undefined) throw new Error(`unknown memory prompt ${lang}/${name}`);
  const blocks = parseLiteralBlocks(raw);
  if (!blocks["system"] || !blocks["user"]) {
    throw new Error(`prompt ${name} missing 'system'/'user' keys`);
  }
  const file = { system: blocks["system"], user: blocks["user"] };
  PROMPT_CACHE.set(key, file);
  return file;
}

export function load_focus_meta(language: string): MetaFile {
  const lang = lang_code(language);
  const cached = META_CACHE.get(lang);
  if (cached) return cached;
  const meta = META[lang] ?? META["en"];
  META_CACHE.set(lang, meta);
  return meta;
}

export function surface_focus(language: string, surface: string): [string, string[]] {
  const meta = load_focus_meta(language).surfaces[surface] ?? {};
  return [meta.focus ?? "", [...(meta.sections ?? [])]];
}

export function slot_focus(language: string, slot: string): [string, string[]] {
  const meta = load_focus_meta(language).slots[slot] ?? {};
  return [meta.focus ?? "", [...(meta.sections ?? [])]];
}
