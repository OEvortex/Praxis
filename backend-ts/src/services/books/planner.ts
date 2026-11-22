// deterministic concept-graph mermaid renderer.
//
// The upstream LLM planning layer (SectionArchitect.plan_blocks_async) is
// replaced by the static template plan always — same fallback the Python
// engine uses when the LLM call fails — so behaviour stays deterministic.

import {
  coerceDepth,
  depth_scale,
  make_block,
  now,
  type Block,
  type BlockType,
  type Chapter,
  type ConceptGraph,
  type ContentType,
} from "./models.js";

// ── templates (v2) ─────────────────────────────────────────────────────────

type TemplateEntry = [BlockType, Record<string, unknown>];

const TEMPLATES_V2: Record<ContentType, TemplateEntry[]> = {
  theory: [
    ["section", { role: "introduction", target_words: 1200 }],
    ["figure", { variant: "diagram", transition_in: "Visualising the core structure" }],
    ["section", { role: "deep_dive", target_words: 1600 }],
    ["callout", { variant: "key_idea", transition_in: "A key idea to remember" }],
    ["code", { language: "python", intent: "example", transition_in: "A concrete example in code" }],
    ["section", { role: "synthesis", target_words: 800 }],
    ["quiz", { num_questions: 3, transition_in: "Check your understanding" }],
    ["flash_cards", { count: 5, transition_in: "Quick mental hooks" }],
  ],
  derivation: [
    ["section", { role: "setup", target_words: 1400 }],
    ["animation", { focus: "core derivation", transition_in: "Step through the derivation visually" }],
    ["section", { role: "formal_proof", target_words: 1200 }],
    ["code", { language: "python", intent: "verify", transition_in: "Verify the result numerically" }],
    ["callout", { variant: "insight", transition_in: "What this result really means" }],
    ["section", { role: "interpretation", target_words: 1000 }],
    ["quiz", { num_questions: 2, transition_in: "Test your derivation skills" }],
  ],
  history: [
    ["section", { role: "context", target_words: 1200 }],
    ["timeline", { transition_in: "The key milestones" }],
    ["section", { role: "narrative", target_words: 1500 }],
    ["figure", { variant: "illustration", transition_in: "A period illustration" }],
    ["callout", { variant: "connection", transition_in: "Why this matters today" }],
    ["section", { role: "analysis", target_words: 1000 }],
    ["quiz", { num_questions: 2, transition_in: "Quick recap quiz" }],
  ],
  practice: [
    ["section", { role: "brief", target_words: 1000 }],
    ["quiz", { num_questions: 3, difficulty: "easy", transition_in: "Warm up" }],
    ["code", { language: "python", intent: "scaffold", transition_in: "Try it yourself" }],
    ["section", { role: "walkthrough", target_words: 1200 }],
    ["interactive", { interaction: "guided exercise", transition_in: "Practise interactively" }],
    ["quiz", { num_questions: 3, difficulty: "hard", transition_in: "Now push further" }],
    ["callout", { variant: "common_pitfall", transition_in: "Watch out for these traps" }],
  ],
  concept: [
    ["section", { role: "definition", target_words: 1400 }],
    ["figure", { variant: "mindmap", transition_in: "Map the related concepts" }],
    ["section", { role: "examples", target_words: 1200 }],
    ["flash_cards", { count: 5, transition_in: "Hooks for recall" }],
    ["callout", { variant: "common_pitfall", transition_in: "Watch out for these" }],
    ["figure", { variant: "comparison", transition_in: "Side-by-side comparison" }],
    ["quiz", { num_questions: 3, transition_in: "Self-check" }],
  ],
  overview: [],
};

export const PLANNABLE_BLOCK_TYPES = new Set<BlockType>([
  "section",
  "text",
  "callout",
  "quiz",
  "flash_cards",
  "figure",
  "interactive",
  "animation",
  "code",
  "timeline",
]);

export const PLANNER_DEFAULT_BLOCK_TYPES = new Set<BlockType>(
  (Object.values(TEMPLATES_V2) as TemplateEntry[][])
    .flat()
    .map(([t]) => t),
);

function build_block(
  block_type: BlockType,
  params: Record<string, unknown>,
  chapter: Chapter,
  depth?: string | null,
): Block {
  const transition_in = params["transition_in"];
  delete params["transition_in"];
  const target = params["target_words"];
  if (typeof target === "number") {
    params["target_words"] = Math.max(120, Math.round(target * depth_scale(depth)));
  }
  const full_params: Record<string, unknown> = {
    chapter_title: chapter.title,
    chapter_summary: chapter.summary,
    objectives: chapter.learning_objectives,
    anchors: (chapter.source_anchors ?? []).map((a) => ({ ...a })),
    ...params,
  };
  const metadata: Record<string, unknown> = {};
  if (typeof transition_in === "string" && transition_in) {
    metadata["transition_in"] = transition_in;
  }
  return make_block({ type: block_type, params: full_params, metadata });
}

/** Deterministic template plan (upstream static fallback layer). */
export function static_plan(
  chapter: Chapter,
  opts: { depth?: string | null; allowed?: Set<BlockType> | null } = {},
): Block[] {
  const template = TEMPLATES_V2[chapter.content_type] ?? TEMPLATES_V2["theory"];
  const allowed = opts.allowed ?? null;
  const blocks = template
    .filter(([bt]) => allowed === null || bt === "section" || allowed.has(bt))
    .map(([bt, params]) => build_block(bt, { ...params }, chapter, opts.depth));
  if (blocks.length || allowed === null) return blocks;
  return [build_block("section", { role: "core", target_words: 1700 }, chapter, opts.depth)];
}

/** Allowed block types persisted on the book (metadata.block_types). */
export function book_allowed_block_types(metadata: Record<string, unknown> | undefined | null): Set<BlockType> | null {
  const raw = metadata?.["block_types"];
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = new Set<BlockType>();
  for (const v of raw) {
    if (typeof v === "string" && PLANNABLE_BLOCK_TYPES.has(v as BlockType)) {
      out.add(v as BlockType);
    }
  }
  // SECTION is always implicitly allowed (upstream keeps it regardless).
  out.add("section");
  return out;
}

// ── estimate basis ─────────────────────────────────────────────────────────

const SECONDS_PER_PROSE_BLOCK = 45.0;
const SECONDS_PER_SUPPORT_BLOCK = 15.0;
const PROSE_TYPES = new Set<BlockType>(["section", "text"]);

export function chapter_basis(depth?: string | null): Record<string, { blocks: number; words: number; seconds: number }> {
  const scale = depth_scale(depth);
  const basis: Record<string, { blocks: number; words: number; seconds: number }> = {};
  for (const [content_type, template] of Object.entries(TEMPLATES_V2)) {
    let words = 0;
    let seconds = 0;
    for (const [block_type, params] of template as TemplateEntry[]) {
      const target = params["target_words"];
      if (typeof target === "number") words += target * scale;
      seconds += PROSE_TYPES.has(block_type) ? SECONDS_PER_PROSE_BLOCK : SECONDS_PER_SUPPORT_BLOCK;
    }
    basis[content_type] = {
      blocks: template.length,
      words: Math.round(words),
      seconds: Math.round(seconds),
    };
  }
  basis["overview"] = { blocks: 3, words: 0, seconds: 0 };
  return basis;
}

// ── overview copy (deterministic, no LLM) ──────────────────────────────────

const OVERVIEW_COPY = {
  chapter_title: "How to read this book",
  chapter_summary: "Auto-generated overview of the book's concept graph and chapter index.",
  objectives: [
    "See the full chapter map at a glance",
    "Understand how concepts depend on each other",
    "Pick the reading path that fits your goals",
  ],
  intro_title: "How to read this book",
  intro_body:
    "The diagram below maps the {concepts} core concepts in this book and how they depend on each other. The chapter index that follows lists all {chapters} chapters — read top-to-bottom for the recommended path, or jump straight to whatever you're most curious about.",
  untitled_book: "This book",
  concept_map_title: "Concept map",
  chapter_index_title: "Chapter index",
  chapter_index_heading: "## Chapter index",
};

export function overview_copy(): Record<string, any> {
  return OVERVIEW_COPY;
}

// ── concept graph → mermaid (port of blocks/concept_graph.render_mermaid) ──

function safe_id(raw: string, used: Set<string>): string {
  let base = (raw || "node")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!base) base = "node";
  let id = base;
  let i = 2;
  while (used.has(id)) {
    id = `${base}_${i++}`;
  }
  used.add(id);
  return id;
}

function escape_label(label: string): string {
  return (label || "").replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

export function render_mermaid(graph: ConceptGraph): string {
  const nodes = graph?.nodes ?? [];
  if (!nodes.length) return 'graph TD\n  empty["(no concepts yet)"]';

  const chapter_mode = nodes.some((n) => n.chapter_id);
  const used = new Set<string>();
  const id_map = new Map<string, string>();
  const lines = ["graph TD"];
  let chapter_seq = 0;

  for (const node of nodes) {
    const sid = safe_id(node.id || node.label, used);
    id_map.set(node.id, sid);
    const label = escape_label(node.label);
    if (chapter_mode && node.chapter_id) {
      chapter_seq += 1;
      const num = String(chapter_seq).padStart(2, "0");
      lines.push(`  ${sid}["${num} · ${label}"]`);
    } else if (chapter_mode && !node.chapter_id) {
      lines.push(`  ${sid}(["${label}"])`);
    } else {
      lines.push(`  ${sid}["${label}"]`);
    }
  }

  const arrow_for: Record<string, string> = {
    depends_on: "-->",
    extends: "==>",
    related: "-.->",
  };
  for (const edge of graph?.edges ?? []) {
    const src = id_map.get(edge.src);
    const dst = id_map.get(edge.dst);
    if (!src || !dst) continue;
    lines.push(`  ${src} ${arrow_for[edge.relation ?? ""] ?? "-->"} ${dst}`);
  }
  return lines.join("\n");
}

export { coerceDepth };
