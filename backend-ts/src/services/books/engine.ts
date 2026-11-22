// BookEngine orchestrator.
//
// Faithful port of the observable contract: same storage layout, same status
// machine, same revision/breaker semantics, same event kinds. The upstream
// multi-agent pipeline (IdeationAgent, SourceExplorer, SpineSynthesizer,
// SectionArchitect LLM layer, per-type block generators, RAG grounding) is
// implemented here as a single-pass LLM pipeline over llm_text:
//   ideation  → one JSON completion → BookProposal
//   spine     → one JSON completion → Spine (+ concept graph)
//   compile   → static template plan (page_planner) + one JSON completion
//               per block → payload
// Everything deterministic (overview page, progress, edits, drift, export)
// matches upstream exactly.

import { createHash } from "node:crypto";
import { complete_text } from "../llm_text.js";
import { get_settings, type Settings } from "../../config.js";
import {
  get_book_storage,
  safe_book_id,
  ValueError,
  type BookStorage,
} from "./storage.js";
import {
  book_allowed_block_types,
  chapter_basis,
  overview_copy,
  render_mermaid,
  static_plan,
} from "./planner.js";
import {
  ensure_can_refresh_fingerprints,
  fingerprint_kbs,
  mark_drift_on_book,
  refresh_book_fingerprints,
  scan_log_health,
  ValueError as KbValueError,
} from "./kb_health.js";
import * as progress_ops from "./progress.js";
import {
  close_book_bus,
  get_book_bus,
  get_book_stream,
  SOURCE,
  STAGE_COMPILATION,
  STAGE_IDEATION,
  STAGE_OVERVIEW,
  STAGE_SPINE,
  BookStream,
  type StreamBus,
} from "./streaming.js";
import {
  coerceDepth,
  make_block,
  make_chapter,
  make_page,
  make_progress,
  now,
  type Block,
  type BlockType,
  type Book,
  type BookDepth,
  type BookInputs,
  type BookProposal,
  type Chapter,
  type ContentType,
  type Page,
  type PageStatus,
  type Progress,
  type Spine,
} from "./models.js";

export class BookPausedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookPausedError";
  }
}

const CONSECUTIVE_PAGE_FAILURE_LIMIT = 2;

const UNFINISHED_PAGE_STATUSES = new Set<PageStatus>([
  "pending",
  "planning",
  "generating",
  "error",
]);

const EDITABLE_BLOCK_TYPES = new Set<BlockType>(["text", "user_note", "callout"]);

function body_key(block: Block): string {
  if (block.type === "text" && "content" in (block.payload ?? {})) return "content";
  return "body";
}

function prune_concept_graph(spine: Spine): number {
  const graph = spine.concept_graph;
  if (!graph?.nodes?.length) return 0;
  const live = new Set(spine.chapters.map((c) => c.id));
  const kept = graph.nodes.filter((n) => !n.chapter_id || live.has(n.chapter_id));
  const dropped = graph.nodes.length - kept.length;
  if (!dropped) return 0;
  graph.nodes = kept;
  const ids = new Set(kept.map((n) => n.id));
  graph.edges = (graph.edges ?? []).filter((e) => ids.has(e.src) && ids.has(e.dst));
  return dropped;
}

function generation_error_category(message: string): string {
  const text = (message || "").toLowerCase();
  if (["quota", "insufficient", "credit", "billing"].some((t) => text.includes(t))) return "quota";
  if (["unauthorized", "forbidden", "api key", "credential"].some((t) => text.includes(t)))
    return "authentication";
  if (["rate limit", "too many requests", "429"].some((t) => text.includes(t))) return "rate_limit";
  if (
    ["requires the optional", "pip install", "modulenotfounderror", "no module named", "not installed"].some(
      (t) => text.includes(t),
    )
  )
    return "missing_dependency";
  if (["timeout", "timed out", "connection", "provider"].some((t) => text.includes(t)))
    return "provider";
  if (["parse", "invalid json", "validation"].some((t) => text.includes(t))) return "content";
  return "unknown";
}

function is_auto_overview(chapter: Chapter): boolean {
  return (
    chapter.content_type === "overview" ||
    (chapter as Record<string, unknown>)["auto_overview"] === true
  );
}

function coerce_depth(value?: string | BookDepth | null): BookDepth {
  return coerceDepth(typeof value === "string" ? value : (value ?? undefined));
}

function is_systemic_failure(page: Page): string {
  if (page.status !== "error") return "";
  const text = (page.error || "").toLowerCase();
  if (
    ["quota", "insufficient", "credit", "billing", "unauthorized", "forbidden", "api key", "credential", "rate limit", "429", "timeout", "connection", "provider"].some(
      (t) => text.includes(t),
    )
  )
    return page.error;
  return "";
}

// ── LLM helpers ────────────────────────────────────────────────────────────

function extract_json(text: string): unknown {
  const trimmed = (text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.search(/[{[]/);
  if (start < 0) throw new Error("LLM returned no JSON");
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  // Fallback: parse the whole candidate.
  return JSON.parse(candidate);
}

async function llm_json(
  settings: Settings,
  system: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const text = await complete_text(settings, { system, prompt });
  const parsed = extract_json(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LLM returned a non-object JSON payload");
  }
  return parsed as Record<string, unknown>;
}

// ── runtime (per-book scheduling state) ────────────────────────────────────

interface BookRuntime {
  queue: string[];
  queued: Set<string>;
  in_flight: Map<string, Promise<Page> & { done?: () => boolean }>;
  worker: Promise<void> | null;
  consecutive_page_failures: number;
}

// ── engine ─────────────────────────────────────────────────────────────────

export class BookEngine {
  readonly storage: BookStorage;
  private settings: Settings;
  private runtimes = new Map<string, BookRuntime>();

  constructor(opts: { storage?: BookStorage; settings?: Settings } = {}) {
    this.settings = opts.settings ?? get_settings();
    this.storage = opts.storage ?? get_book_storage(this.settings);
  }

  private runtime(book_id: string): BookRuntime {
    let rt = this.runtimes.get(book_id);
    if (!rt) {
      rt = {
        queue: [],
        queued: new Set(),
        in_flight: new Map(),
        worker: null,
        consecutive_page_failures: 0,
      };
      this.runtimes.set(book_id, rt);
    }
    return rt;
  }

  // ── discovery / lifecycle ──

  list_books(): Book[] {
    const books: Book[] = [];
    for (const book_id of this.storage.list_book_ids()) {
      const book = this.storage.load_book(book_id);
      if (book) books.push(book);
    }
    books.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    return books;
  }

  load_book(book_id: string): Book | null {
    return this.storage.load_book(book_id);
  }

  private require_generation_allowed(book_id: string, book?: Book | null): Book {
    const current = book ?? this.storage.load_book(book_id);
    if (!current) throw new ValueError(`Book ${book_id} not found`);
    if (current.status === "paused") {
      throw new BookPausedError(
        "Book generation is paused. Resume it explicitly before generating content.",
      );
    }
    return current;
  }

  reading_summary(book: Book): Record<string, unknown> {
    const progress = this.storage.load_progress(book.id);
    const total = Math.max(0, book.page_count ?? 0);
    if (!progress) {
      return { current_page_id: "", visited_pages: 0, total_pages: total, percent: 0 };
    }
    return {
      current_page_id: progress.current_page_id ?? "",
      visited_pages: new Set(progress.visited_page_ids ?? []).size,
      total_pages: total,
      percent: Math.round(progress_ops.completion_ratio(progress, total) * 100),
    };
  }

  load_spine(book_id: string): Spine | null {
    return this.storage.load_spine(book_id);
  }

  list_pages(book_id: string): Page[] {
    return this.storage.list_pages(book_id);
  }

  load_page(book_id: string, page_id: string): Page | null {
    return this.storage.load_page(book_id, page_id);
  }

  load_progress(book_id: string): Progress {
    let progress = this.storage.load_progress(book_id);
    if (!progress) {
      progress = make_progress(book_id);
      this.storage.save_progress(progress);
    }
    return progress;
  }

  delete_book(book_id: string): boolean {
    const rt = this.runtimes.get(book_id);
    if (rt) {
      rt.queue = [];
      rt.queued.clear();
      this.runtimes.delete(book_id);
    }
    close_book_bus(book_id);
    return this.storage.delete_book(book_id);
  }

  set_page_chat_session(book_id: string, page_id: string, session_id: string): Book | null {
    const book = this.storage.load_book(book_id);
    const page = this.storage.load_page(book_id, page_id);
    const clean = (session_id ?? "").trim();
    if (!book || !page || !clean) return null;
    const metadata = { ...(book.metadata ?? {}) };
    const mapping = { ...((metadata["page_chat_sessions"] as Record<string, string>) ?? {}) };
    mapping[page_id] = clean;
    metadata["page_chat_sessions"] = mapping;
    book.metadata = metadata;
    book.updated_at = now();
    this.storage.save_book(book);
    this.storage.append_log(book_id, `page chat session mapped (${page_id} → ${clean})`, "page_chat");
    return book;
  }

  private static reset_page_for_force_compile(page: Page): void {
    for (const block of page.blocks ?? []) {
      if (block.type === "user_note") continue;
      if (block.metadata?.["edited_by_user"]) continue;
      const preserved: Record<string, unknown> = {};
      for (const key of ["transition_in", "deep_dive_page_id"]) {
        if (key in (block.metadata ?? {})) preserved[key] = block.metadata[key];
      }
      block.status = "pending";
      block.payload = {};
      block.error = "";
      block.source_anchors = [];
      block.metadata = preserved;
      block.updated_at = now();
    }
    page.status = "pending";
    page.error = "";
    page.updated_at = now();
  }

  // ── Stage 1: Ideation ──

  async create_book(args: {
    user_intent: string;
    source_refs?: Record<string, unknown>[];
    chat_session_id?: string;
    chat_selections?: Record<string, unknown>[];
    notebook_refs?: Record<string, unknown>[];
    knowledge_bases?: string[];
    question_categories?: number[];
    question_entries?: number[];
    language?: string;
    fallback_language?: string;
    depth?: string;
    stream?: StreamBus;
  }): Promise<{ book: Book; proposal: BookProposal }> {
    const bus = args.stream ?? get_book_bus("");
    const bstream = new BookStream(bus);
    const language = args.language || "en";

    await bstream.bus.emit({ type: "stage_start", stage: STAGE_IDEATION });
    await bstream.progress("Capturing inputs…", { stage: STAGE_IDEATION });

    const book_inputs: BookInputs = {
      source_refs: args.source_refs ?? [],
      source_context: "",
      user_intent: args.user_intent,
      chat_session_id: args.chat_session_id ?? "",
      chat_selections: (args.chat_selections ?? []) as BookInputs["chat_selections"],
      chat_history: [],
      notebook_refs: (args.notebook_refs ?? []) as BookInputs["notebook_refs"],
      knowledge_bases: args.knowledge_bases ?? [],
      question_categories: args.question_categories ?? [],
      question_entries: args.question_entries ?? [],
      language,
      captured_at: now(),
    };

    await bstream.progress("Generating book proposal…", { stage: STAGE_IDEATION });
    const proposal = await this.run_ideation(book_inputs, language);

    const t = now();
    const book: Book = {
      id: `bk_${createHash("sha1").update(`${t}:${Math.random()}`).digest("hex").slice(0, 10)}`,
      revision: 1,
      title: String(proposal.title ?? ""),
      description: String(proposal.description ?? ""),
      status: "draft",
      proposal,
      knowledge_bases: book_inputs.knowledge_bases ?? [],
      language,
      depth: coerce_depth(args.depth),
      page_count: 0,
      chapter_count: Math.trunc(Number(proposal.estimated_chapters ?? 0)),
      created_at: t,
      updated_at: t,
      metadata: {},
      kb_fingerprints: {},
      kb_document_fingerprints: {},
      stale_page_ids: [],
      stale_detected_at: 0,
    };
    try {
      if (book.knowledge_bases.length) {
        book.kb_fingerprints = fingerprint_kbs(book.knowledge_bases);
      }
    } catch { /* baseline capture is best-effort, same as upstream */ }

    this.storage.save_book(book);
    this.storage.save_inputs(book.id, book_inputs);
    this.storage.save_progress(make_progress(book.id));
    this.storage.append_log(book.id, `created (status=draft, title='${book.title}')`, "create");

    await bstream.book_event(
      "proposal_ready",
      { book_id: book.id, title: book.title, proposal },
      STAGE_IDEATION,
    );
    await bstream.bus.emit({ type: "stage_end", stage: STAGE_IDEATION });
    return { book, proposal };
  }

  private async run_ideation(inputs: BookInputs, language: string): Promise<BookProposal> {
    const intent = inputs.user_intent ?? "";
    const kbs = (inputs.knowledge_bases ?? []).join(", ") || "(none)";
    const refs = JSON.stringify(inputs.source_refs ?? []).slice(0, 4000);
    const system =
      "You are the ideation agent of a book-generation engine. Respond with a single JSON object only.";
    const prompt = [
      `Book language: ${language}`,
      `User intent:\n${intent}`,
      `Knowledge bases attached: ${kbs}`,
      refs ? `Selected source references:\n${refs}` : "",
      "",
      "Produce a book proposal as JSON with keys: title (string), description (string), scope (string), target_level (string), estimated_chapters (integer), rationale (string). Keep it concise.",
    ]
      .filter(Boolean)
      .join("\n");
    const parsed = await llm_json(this.settings, system, prompt);
    return {
      title: String(parsed["title"] ?? ""),
      description: String(parsed["description"] ?? ""),
      scope: String(parsed["scope"] ?? ""),
      target_level: String(parsed["target_level"] ?? ""),
      estimated_chapters: Math.trunc(Number(parsed["estimated_chapters"] ?? 0)),
      rationale: String(parsed["rationale"] ?? ""),
    };
  }

  // ── Stage 2: Spine ──

  async confirm_proposal(args: {
    book_id: string;
    edited_proposal?: BookProposal | null;
    stream?: StreamBus;
  }): Promise<{ book: Book; spine: Spine }> {
    let book = this.storage.load_book(args.book_id);
    if (!book) throw new ValueError(`Book ${args.book_id} not found`);

    if (args.edited_proposal != null) {
      book.proposal = args.edited_proposal;
      book.title = args.edited_proposal.title || book.title;
      book.description = args.edited_proposal.description || book.description;
    }

    const bus = args.stream ?? get_book_bus(book.id);
    const bstream = new BookStream(bus);
    const proposal = book.proposal ?? { title: book.title };
    const inputs =
      this.storage.load_inputs(book.id) ??
      ({
        user_intent: book.title || "",
        knowledge_bases: [...book.knowledge_bases],
        language: book.language,
      } as BookInputs);

    await bstream.bus.emit({ type: "stage_start", stage: STAGE_SPINE });
    try {
      await bstream.progress("Synthesising spine + concept graph…", { stage: STAGE_SPINE });
      const spine = await this.run_spine_synthesis(book, proposal, inputs);

      book.chapter_count = spine.chapters.length;
      book.status = "spine_ready";
      book.updated_at = now();
      this.storage.save_book(book);
      this.storage.save_spine(spine);
      this.storage.append_log(
        book.id,
        `spine generated (${spine.chapters.length} chapters, ${spine.concept_graph?.nodes?.length ?? 0} concepts)`,
        "spine",
      );

      await bstream.book_event(
        "spine_ready",
        {
          book_id: book.id,
          chapter_count: spine.chapters.length,
          concept_node_count: spine.concept_graph?.nodes?.length ?? 0,
          concept_edge_count: spine.concept_graph?.edges?.length ?? 0,
          spine,
        },
        STAGE_SPINE,
      );
      await bstream.bus.emit({ type: "stage_end", stage: STAGE_SPINE });
      return { book, spine };
    } catch (exc) {
      book.metadata = {
        ...(book.metadata ?? {}),
        exploration_failed: true,
        exploration_error: String(exc).slice(0, 400),
      };
      this.storage.save_book(book);
      throw exc;
    }
  }

  private async run_spine_synthesis(
    book: Book,
    proposal: BookProposal,
    inputs: BookInputs,
  ): Promise<Spine> {
    const kbs = (inputs.knowledge_bases ?? book.knowledge_bases ?? []).join(", ") || "(none)";
    const system =
      "You are the spine architect of a book-generation engine. Respond with a single JSON object only.";
    const prompt = [
      `Book language: ${book.language}`,
      `Proposal title: ${proposal.title ?? book.title}`,
      `Proposal description: ${proposal.description ?? ""}`,
      `Scope: ${proposal.scope ?? ""}`,
      `Target level: ${proposal.target_level ?? ""}`,
      `Estimated chapters: ${proposal.estimated_chapters ?? ""}`,
      `Rationale: ${proposal.rationale ?? ""}`,
      `User intent:\n${inputs.user_intent ?? ""}`,
      `Knowledge bases: ${kbs}`,
      "",
      'Produce the book spine as JSON: {"chapters": [{"title": string, "learning_objectives": [string], "content_type": one of "theory"|"derivation"|"history"|"practice"|"concept", "summary": string, "prerequisites": [chapter title or ""], "source_anchors": [{"kind":"kb","kb_name":string,"ref":string,"snippet":string}]}], "concept_graph": {"nodes": [{"id": slug, "label": string, "description": string}], "edges": [{"src": id, "dst": id, "relation": "depends_on"|"extends"|"related"}]}, "exploration_summary": string}. Chapter ids are assigned by the server; prerequisites may reference chapter titles.',
    ].join("\n");

    const parsed = await llm_json(this.settings, system, prompt);
    const chapters: Chapter[] = [];
    const rawChapters = Array.isArray(parsed["chapters"]) ? parsed["chapters"] : [];
    for (const raw of rawChapters) {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const c = raw as Record<string, unknown>;
      const ct = String(c["content_type"] ?? "theory");
      chapters.push(
        make_chapter({
          title: String(c["title"] ?? ""),
          learning_objectives: Array.isArray(c["learning_objectives"])
            ? c["learning_objectives"].map(String)
            : [],
          content_type: (["theory", "derivation", "history", "practice", "concept", "overview"].includes(ct)
            ? ct
            : "theory") as ContentType,
          summary: String(c["summary"] ?? ""),
          prerequisites: Array.isArray(c["prerequisites"]) ? c["prerequisites"].map(String) : [],
          source_anchors: Array.isArray(c["source_anchors"])
            ? (c["source_anchors"] as Array<Record<string, unknown>>).map((a) => ({ ...a }))
            : [],
          order: chapters.length,
        }),
      );
    }

    // Resolve title-based prerequisites to chapter ids.
    const byTitle = new Map(chapters.map((c) => [c.title.trim().toLowerCase(), c.id]));
    for (const chapter of chapters) {
      chapter.prerequisites = (chapter.prerequisites ?? [])
        .map((p) => byTitle.get(String(p).trim().toLowerCase()) ?? "")
        .filter(Boolean);
    }

    // concept_graph: coerce nodes/edges, attach chapter_id by matching labels.
    const cg = (parsed["concept_graph"] ?? {}) as Record<string, unknown>;
    const nodes = (Array.isArray(cg["nodes"]) ? cg["nodes"] : []).map((n) => {
      const r = (n ?? {}) as Record<string, unknown>;
      return {
        id: String(r["id"] ?? ""),
        label: String(r["label"] ?? ""),
        chapter_id: "",
        description: String(r["description"] ?? ""),
        weight: 1,
      };
    });
    const labelToChapter = new Map(chapters.map((c) => [c.title.trim().toLowerCase(), c.id]));
    for (const node of nodes) {
      const hit = labelToChapter.get(node.label.trim().toLowerCase());
      if (hit) node.chapter_id = hit;
    }
    const edges = (Array.isArray(cg["edges"]) ? cg["edges"] : []).map((e) => {
      const r = (e ?? {}) as Record<string, unknown>;
      return {
        src: String(r["src"] ?? ""),
        dst: String(r["dst"] ?? ""),
        relation: String(r["relation"] ?? "depends_on") || "depends_on",
        rationale: String(r["rationale"] ?? ""),
      };
    }).filter((e) => nodes.some((n) => n.id === e.src) && nodes.some((n) => n.id === e.dst));

    return {
      book_id: book.id,
      chapters,
      version: 1,
      updated_at: now(),
      concept_graph: { nodes, edges },
      exploration_summary: String(parsed["exploration_summary"] ?? ""),
    };
  }

  // ── Stage 2.5: Overview chapter injection ──

  private ensure_overview_chapter(spine: Spine, book: Book): Spine {
    const existing = spine.chapters.filter(is_auto_overview);
    if (existing.length) {
      const [keep, ...duplicates] = existing;
      if (duplicates.length) {
        spine.chapters = spine.chapters.filter((c) => c === keep || !is_auto_overview(c) || existing.indexOf(c) === 0);
        spine.chapters = spine.chapters.filter((c, i) => i === spine.chapters.indexOf(keep) || c !== keep || i === spine.chapters.indexOf(keep));
        // simpler: rebuild keeping only first overview
        const seen = new Set<string>();
        spine.chapters = spine.chapters.filter((c) => {
          if (!is_auto_overview(c)) return true;
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
      }
      spine.chapters = [keep, ...spine.chapters.filter((c) => c !== keep)];
      spine.chapters.forEach((c, i) => (c.order = i));
      return spine;
    }
    const copy = overview_copy();
    const overview = make_chapter({
      title: String(copy["chapter_title"]),
      learning_objectives: [...(copy["objectives"] as string[])],
      content_type: "overview",
      summary: String(copy["chapter_summary"]),
      order: 0,
    });
    (overview as Record<string, unknown>)["auto_overview"] = true;
    spine.chapters = [overview, ...spine.chapters];
    spine.chapters.forEach((c, i) => (c.order = i));
    return spine;
  }

  private async materialize_overview_page(
    spine: Spine,
    pages: Page[],
    book: Book,
    stream?: StreamBus,
  ): Promise<void> {
    if (!spine.chapters.length) return;
    const overview_chapter = spine.chapters[0];
    if (overview_chapter.content_type !== "overview") return;
    const overview_page = pages.find((p) => p.chapter_id === overview_chapter.id);
    if (!overview_page || overview_page.status === "ready") return;

    const copy = overview_copy();
    const chapter_index = spine.chapters
      .filter((ch) => ch.content_type !== "overview")
      .map((ch) => ({
        id: ch.id,
        title: ch.title,
        summary: ch.summary,
        objectives: [...(ch.learning_objectives ?? [])],
        order: ch.order,
        content_type: ch.content_type,
        page_id: ch.page_ids?.[0] ?? "",
      }));

    const description = book.proposal?.description ?? "";
    const intro_md = `# ${book.title || copy["untitled_book"]}\n\n${description}\n\n` +
      String(copy["intro_body"]).replace("{concepts}", String(spine.concept_graph?.nodes?.length ?? 0))
        .replace("{chapters}", String(chapter_index.length));
    const intro_block = make_block({
      type: "text",
      status: "ready",
      title: String(copy["intro_title"]),
      params: { role: "overview_intro" },
      payload: { content: intro_md, format: "markdown" },
    });

    const graph = spine.concept_graph ?? { nodes: [], edges: [] };
    const graph_block = make_block({
      type: "concept_graph",
      status: "ready",
      title: String(copy["concept_map_title"]),
      params: {
        concept_graph: graph,
        chapter_index,
      },
      payload: {
        render_type: "concept_graph",
        code: { language: "mermaid", content: render_mermaid(graph) },
        graph,
        index: {
          chapters: chapter_index,
          node_to_chapter: Object.fromEntries(
            (graph.nodes ?? []).filter((n) => n.chapter_id).map((n) => [n.id, n.chapter_id]),
          ),
        },
      },
      metadata: {
        node_count: graph.nodes?.length ?? 0,
        edge_count: graph.edges?.length ?? 0,
      },
    });

    const index_lines = chapter_index.map((entry: any) => {
      let line = `- **${entry.title}**`;
      if (entry.summary) line += ` — ${entry.summary}`;
      return line;
    });
    const index_md = `${copy["chapter_index_heading"]}\n\n${index_lines.join("\n")}`;
    const index_block = make_block({
      type: "text",
      status: "ready",
      title: String(copy["chapter_index_title"]),
      params: { role: "chapter_index" },
      payload: { content: index_md, format: "markdown" },
    });

    const edited_by_role = new Map<string, Block>();
    const notes: Block[] = [];
    for (const existing of overview_page.blocks ?? []) {
      if (existing.type === "user_note") notes.push(existing);
      else if (existing.metadata?.["edited_by_user"]) {
        const role = String(existing.params?.["role"] ?? existing.type);
        edited_by_role.set(role, existing);
      }
    }
    const keep = (block: Block, role: string) => edited_by_role.get(role) ?? block;
    overview_page.blocks = [
      keep(intro_block, "overview_intro"),
      keep(graph_block, "concept_graph"),
      keep(index_block, "chapter_index"),
      ...notes,
    ];
    overview_page.status = "ready";
    overview_page.content_type = "overview";
    overview_page.updated_at = now();
    this.storage.save_page(overview_page);

    await new BookStream(stream ?? get_book_bus(book.id)).book_event(
      "overview_ready",
      {
        book_id: book.id,
        page_id: overview_page.id,
        node_count: graph.nodes?.length ?? 0,
        chapter_count: chapter_index.length,
      },
      STAGE_OVERVIEW,
    );
  }

  // ── Stage 3: confirm spine + page shells ──

  async confirm_spine(args: {
    book_id: string;
    edited_spine?: Spine | null;
    stream?: StreamBus;
    auto_compile?: boolean;
  }): Promise<Page[]> {
    const book = this.storage.load_book(args.book_id);
    if (!book) throw new ValueError(`Book ${args.book_id} not found`);

    let spine = args.edited_spine ?? this.storage.load_spine(args.book_id);
    if (!spine) throw new ValueError(`No spine for book ${args.book_id}`);
    if (args.edited_spine != null) spine.book_id = args.book_id;

    const dropped = prune_concept_graph(spine);
    if (dropped) {
      this.storage.append_log(
        args.book_id,
        `pruned ${dropped} concept-graph node(s) for deleted chapters`,
        "confirm_spine",
      );
    }

    spine = this.ensure_overview_chapter(spine, book);

    const existing = new Map<string, Page[]>();
    for (const saved of this.storage.list_pages(args.book_id)) {
      const list = existing.get(saved.chapter_id) ?? [];
      list.push(saved);
      existing.set(saved.chapter_id, list);
    }

    const pages: Page[] = [];
    for (const chapter of spine.chapters) {
      let chapter_pages = existing.get(chapter.id) ?? [];
      if (!chapter_pages.length) {
        const page = make_page({
          book_id: args.book_id,
          chapter_id: chapter.id,
          title: chapter.title,
          learning_objectives: [...(chapter.learning_objectives ?? [])],
          content_type: chapter.content_type,
          order: chapter.order,
          status: "pending",
        });
        this.storage.save_page(page);
        chapter_pages = [page];
      }
      for (const page of chapter_pages) {
        const independent = page.section === true;
        let changed = page.order !== chapter.order;
        page.order = chapter.order;
        if (!independent && (page.title !== chapter.title || page.content_type !== chapter.content_type)) {
          page.title = chapter.title;
          page.content_type = chapter.content_type;
          page.learning_objectives = [...(chapter.learning_objectives ?? [])];
          changed = true;
        }
        if (changed) {
          page.updated_at = now();
          this.storage.save_page(page);
        }
      }
      chapter.page_ids = chapter_pages.map((p) => p.id);
      pages.push(...chapter_pages);
    }
    this.storage.save_spine(spine);

    await this.materialize_overview_page(spine, pages, book, args.stream);

    book.page_count = pages.length;
    book.status = "compiling";
    const metadata = { ...(book.metadata ?? {}) };
    delete metadata["pause_reason"];
    delete metadata["pause_kind"];
    metadata["lazy_compile"] = !(args.auto_compile ?? true);
    metadata["compile_started_at"] = now();
    book.metadata = metadata;
    book.updated_at = now();
    this.storage.save_book(book);
    this.storage.append_log(
      args.book_id,
      `spine confirmed (${pages.length} page shells, auto_compile=${args.auto_compile ?? true})`,
      "confirm_spine",
    );

    if (args.auto_compile ?? true) {
      await this.enqueue_pending_pages(args.book_id, pages);
    }
    return pages;
  }

  // ── pause / resume / rebuild ──

  private halt_compilation(book_id: string): void {
    const rt = this.runtimes.get(book_id);
    if (!rt) return;
    rt.queue = [];
    rt.queued.clear();
    rt.in_flight.clear();
    rt.consecutive_page_failures = 0;
    this.runtimes.delete(book_id);
  }

  async pause_book(book_id: string, reason = "Paused by user."): Promise<Page[]> {
    const book = this.storage.load_book(book_id);
    if (!book) throw new ValueError(`Book ${book_id} not found`);
    if (!this.storage.load_spine(book_id)) throw new ValueError(`No spine for book ${book_id}`);

    book.status = "paused";
    book.metadata = { ...(book.metadata ?? {}), pause_reason: reason, pause_kind: "user" };
    book.updated_at = now();
    this.storage.save_book(book);

    this.halt_compilation(book_id);

    const pages = this.storage.list_pages(book_id);
    for (const page of pages) {
      if (page.status === "planning" || page.status === "generating") {
        page.status = "pending";
        page.error = "";
        page.updated_at = now();
        this.storage.save_page(page);
      }
    }
    this.storage.append_log(book_id, "compilation paused by user", "paused");
    await get_book_stream(book_id).book_event(
      "compilation_paused",
      { book_id, reason, manual: true },
      STAGE_COMPILATION,
    );
    return this.storage.list_pages(book_id);
  }

  async resume_book(book_id: string, stream?: StreamBus): Promise<Page[]> {
    const book = this.storage.load_book(book_id);
    if (!book) throw new ValueError(`Book ${book_id} not found`);
    if (!this.storage.load_spine(book_id)) throw new ValueError(`No spine for book ${book_id}`);

    const pages = this.storage.list_pages(book_id);
    for (const page of pages) {
      if (page.status === "planning" || page.status === "generating") {
        page.status = "pending";
        page.updated_at = now();
        this.storage.save_page(page);
      }
    }

    const pending = pages.filter((p) => UNFINISHED_PAGE_STATUSES.has(p.status));
    if (!pending.length) {
      await this.maybe_finalize_book(book_id);
      return pages;
    }

    book.status = "compiling";
    const metadata = { ...(book.metadata ?? {}) };
    delete metadata["pause_reason"];
    delete metadata["pause_kind"];
    metadata["compile_started_at"] = now();
    book.metadata = metadata;
    book.updated_at = now();
    this.storage.save_book(book);
    this.storage.append_log(book_id, `resume requested (${pending.length} unfinished pages)`, "resume");

    await this.enqueue_pending_pages(book_id, pending);
    return this.storage.list_pages(book_id);
  }

  async maybe_resume_on_open(book_id: string): Promise<boolean> {
    const book = this.storage.load_book(book_id);
    if (!book || book.status !== "compiling") return false;
    if (book.metadata?.["lazy_compile"]) return false;
    const rt = this.runtimes.get(book_id);
    if (rt) {
      if (rt.in_flight.size) return false;
      if (rt.worker) return false;
    }
    try {
      await this.resume_book(book_id);
      return true;
    } catch {
      return false;
    }
  }

  async rebuild_book(book_id: string, auto_compile = true, stream?: StreamBus): Promise<Page[]> {
    const book = this.storage.load_book(book_id);
    const spine = this.storage.load_spine(book_id);
    if (!book || !spine) {
      throw new ValueError(`Cannot rebuild book – missing book/spine (${book_id})`);
    }

    this.halt_compilation(book_id);

    for (const page of this.storage.list_pages(book_id)) {
      this.storage.delete_page(book_id, page.id);
    }
    for (const chapter of spine.chapters) chapter.page_ids = [];
    this.storage.save_spine(spine);
    this.storage.save_progress(make_progress(book_id));

    book.status = "spine_ready";
    book.page_count = 0;
    book.updated_at = now();
    this.storage.save_book(book);
    this.storage.append_log(
      book_id,
      `rebuild requested (preserve_spine=true, auto_compile=${auto_compile})`,
      "rebuild",
    );

    return this.confirm_spine({ book_id, edited_spine: spine, stream, auto_compile });
  }

  // ── compile one page ──

  async compile_page(args: {
    book_id: string;
    page_id: string;
    stream?: StreamBus;
    force?: boolean;
  }): Promise<Page> {
    this.require_generation_allowed(args.book_id);
    const rt = this.runtime(args.book_id);

    const running = rt.in_flight.get(args.page_id);
    if (running && !running.done?.()) {
      if (!args.force) return running;
      await running.catch(() => undefined);
    }

    const task = this.compile_page_now(args).finally(() => {
      if (rt.in_flight.get(args.page_id) === task) rt.in_flight.delete(args.page_id);
    });
    rt.in_flight.set(args.page_id, task as Promise<Page> & { done?: () => boolean });
    (task as unknown as { done: () => boolean }).done = () => false;
    return task;
  }

  private async compile_page_now(args: {
    book_id: string;
    page_id: string;
    stream?: StreamBus;
    force?: boolean;
  }): Promise<Page> {
    const book = this.storage.load_book(args.book_id);
    const spine = this.storage.load_spine(args.book_id);
    let page = this.storage.load_page(args.book_id, args.page_id);
    if (!book || !spine || !page) {
      throw new ValueError(`Cannot compile page – missing book/spine/page (${args.book_id}/${args.page_id})`);
    }
    this.require_generation_allowed(args.book_id, book);
    if (page.status === "ready" && !args.force) return page;

    if (page.content_type === "overview") {
      page.status = "pending";
      this.storage.save_page(page);
      await this.materialize_overview_page(spine, [page], book, args.stream);
      page = this.storage.load_page(args.book_id, args.page_id) ?? page;
      await this.maybe_finalize_book(args.book_id);
      return page;
    }

    if (args.force) {
      BookEngine.reset_page_for_force_compile(page);
      this.storage.save_page(page);
    }

    let chapter = spine.chapters.find((c) => c.id === page!.chapter_id);
    if (!chapter) {
      throw new ValueError(`Page ${args.page_id} references unknown chapter ${page.chapter_id}`);
    }

    if (page.section === true || (chapter.page_ids ?? []).length > 1) {
      chapter = {
        ...chapter,
        title: page.title,
        learning_objectives: [...(page.learning_objectives ?? [])],
        summary: `Section of ${chapter.title}. ${chapter.summary}`,
      };
    }

    const bstream = new BookStream(args.stream ?? get_book_bus(args.book_id));
    try {
      page = await this.compile_page_blocks({
        book,
        spine,
        chapter,
        page,
        bstream,
      });
    } catch (exc) {
      this.mark_page_error(page, exc, "Compilation failed");
      throw exc;
    }

    if (page.status === "ready") {
      try {
        const refreshed = this.storage.load_book(args.book_id);
        if (refreshed && !Object.keys(refreshed.kb_fingerprints ?? {}).length) {
          refresh_book_fingerprints(args.book_id, this.storage);
        }
      } catch { /* fingerprint refresh is best-effort */ }
    }

    await this.maybe_finalize_book(args.book_id);
    return page;
  }

  /** Generate every pending block on a page via the static plan + LLM. */
  private async compile_page_blocks(args: {
    book: Book;
    spine: Spine;
    chapter: Chapter;
    page: Page;
    bstream: BookStream;
  }): Promise<Page> {
    const { book, chapter, page, bstream } = args;
    page.status = "planning";
    page.updated_at = now();
    this.storage.save_page(page);

    const allowed = book_allowed_block_types(book.metadata);
    const planned = static_plan(chapter, { depth: book.depth, allowed });

    // Keep blocks the reader authored; replace generated ones.
    const user_notes = (page.blocks ?? []).filter(
      (b) => b.type === "user_note" || b.metadata?.["edited_by_user"],
    );
    page.blocks = [...user_notes];
    this.storage.save_page(page);

    page.status = "generating";
    page.updated_at = now();
    this.storage.save_page(page);

    for (const shell of planned) {
      const block = make_block({
        ...shell,
        book_id: undefined,
      } as Partial<Block>);
      block.params = { ...shell.params };
      block.metadata = { ...shell.metadata };
      page.blocks.push(block);
      this.storage.save_page(page);

      try {
        await this.generate_block_payload({ book, chapter, page, block, bstream });
      } catch (exc) {
        block.status = "error";
        block.error = String(exc instanceof Error ? exc.message : exc);
        block.updated_at = now();
        this.storage.save_page(page);
        await bstream.book_event(
          "block_error",
          { book_id: book.id, page_id: page.id, block_id: block.id, error: block.error },
          STAGE_COMPILATION,
        );
      }
    }

    this.finalize_page_status(page);
    page.updated_at = now();
    this.storage.save_page(page);

    await bstream.book_event(
      "page_ready",
      { book_id: book.id, page_id: page.id, status: page.status },
      STAGE_COMPILATION,
    );
    return page;
  }

  /** One LLM call → JSON payload for a single block. */
  private async generate_block_payload(args: {
    book: Book;
    chapter: Chapter;
    page: Page;
    block: Block;
    bstream: BookStream;
  }): Promise<void> {
    const { book, chapter, page, block, bstream } = args;
    block.status = "generating";
    block.updated_at = now();
    this.storage.save_page(page);
    await bstream.book_event(
      "block_generating",
      { book_id: book.id, page_id: page.id, block_id: block.id, block_type: block.type },
      STAGE_COMPILATION,
    );

    const schema = payload_schema_hint(block.type);
    const system =
      "You are a block generator inside a book engine. Respond with a single JSON object only — the block payload.";
    const prompt = [
      `Book title: ${book.title}`,
      `Book language: ${book.language}`,
      `Chapter: ${chapter.title}`,
      `Chapter summary: ${chapter.summary ?? ""}`,
      `Learning objectives: ${(chapter.learning_objectives ?? []).join("; ")}`,
      `Page title: ${page.title}`,
      `Block type: ${block.type}`,
      `Block params: ${JSON.stringify(block.params ?? {})}`,
      `Required payload shape: ${schema}`,
      "",
      "Write the content now. Return ONLY the JSON payload object.",
    ].join("\n");

    const parsed = await llm_json(this.settings, system, prompt);
    block.payload = normalize_payload(block.type, parsed);
    block.status = "ready";
    block.error = "";
    block.updated_at = now();
    this.storage.save_page(page);
    await bstream.book_event(
      "block_ready",
      { book_id: book.id, page_id: page.id, block_id: block.id, block_type: block.type },
      STAGE_COMPILATION,
    );
  }

  private finalize_page_status(page: Page): void {
    const blocks = page.blocks ?? [];
    if (!blocks.length) {
      page.status = "pending";
      return;
    }
    const ready = blocks.filter((b) => b.status === "ready").length;
    const failed = blocks.filter((b) => b.status === "error").length;
    const pending = blocks.filter((b) => b.status === "pending" || b.status === "generating").length;
    if (pending) page.status = "generating";
    else if (failed && ready) page.status = "partial";
    else if (failed && !ready) page.status = "error";
    else page.status = "ready";
  }

  private mark_page_error(page: Page | null, exc: unknown, prefix: string): void {
    if (!page || (page.status !== "generating" && page.status !== "planning")) return;
    page.status = "error";
    page.error = `${prefix}: ${exc instanceof Error ? exc.message : String(exc)}`;
    page.updated_at = now();
    try {
      this.storage.save_page(page);
    } catch { /* best-effort */ }
  }

  // ── background queue ──

  private async enqueue_pending_pages(book_id: string, pages: Page[]): Promise<void> {
    const rt = this.runtime(book_id);
    rt.consecutive_page_failures = 0;
    for (const page of pages) {
      if (page.status === "ready") continue;
      if (rt.queued.has(page.id)) continue;
      rt.queued.add(page.id);
      rt.queue.push(page.id);
    }
    this.ensure_worker(book_id);
  }

  private ensure_worker(book_id: string): void {
    const rt = this.runtime(book_id);
    if (rt.worker) return;
    rt.worker = this.worker_loop(book_id).finally(() => {
      rt.worker = null;
      // Retire empty runtimes.
      if (!rt.queue.length && !rt.in_flight.size && this.runtimes.get(book_id) === rt) {
        this.runtimes.delete(book_id);
      }
    });
  }

  private async worker_loop(book_id: string): Promise<void> {
    const rt = this.runtime(book_id);
    while (rt.queue.length || rt.in_flight.size) {
      const page_id = rt.queue.shift();
      if (page_id === undefined) {
        if (!rt.in_flight.size) break;
        await Promise.race([...rt.in_flight.values()].map((p) => p.catch(() => undefined)));
        continue;
      }
      rt.queued.delete(page_id);
      let page: Page | null = null;
      let tripped = false;
      try {
        page = this.storage.load_page(book_id, page_id);
        if (!page || page.status === "ready") continue;
        const compiled = await this.compile_page({ book_id, page_id });
        const reason = is_systemic_failure(compiled);
        if (reason) {
          rt.consecutive_page_failures += 1;
        } else {
          rt.consecutive_page_failures = 0;
        }
        if (rt.consecutive_page_failures >= CONSECUTIVE_PAGE_FAILURE_LIMIT) {
          await this.pause_compilation(rt, book_id, reason || compiled.error || "provider failure");
          tripped = true;
        }
      } catch (exc) {
        if (exc instanceof BookPausedError) {
          if (page && (page.status === "planning" || page.status === "generating")) {
            page.status = "pending";
            page.error = "";
            page.updated_at = now();
            this.storage.save_page(page);
          }
          return;
        }
        this.mark_page_error(page, exc, "Background compile failed");
        try {
          this.storage.append_log(book_id, `background compile failed for page ${page_id}: ${exc}`, "compile_error");
        } catch { /* ignore */ }
        rt.consecutive_page_failures += 1;
        if (rt.consecutive_page_failures >= CONSECUTIVE_PAGE_FAILURE_LIMIT) {
          await this.pause_compilation(rt, book_id, String(exc));
          tripped = true;
        }
      }
      if (tripped) return;
    }
  }

  private async pause_compilation(rt: BookRuntime, book_id: string, reason: string): Promise<void> {
    const book = this.storage.load_book(book_id);
    if (book) {
      book.status = "paused";
      book.metadata = { ...(book.metadata ?? {}), pause_reason: reason, pause_kind: "provider" };
      book.updated_at = now();
      this.storage.save_book(book);
    }
    this.halt_compilation(book_id);
    this.storage.append_log(
      book_id,
      `compilation paused after ${rt.consecutive_page_failures} consecutive provider failures: ${reason}`,
      "paused",
    );
    await get_book_stream(book_id).book_event(
      "compilation_paused",
      { book_id, reason },
      STAGE_COMPILATION,
    );
  }

  private async maybe_finalize_book(book_id: string): Promise<void> {
    const book = this.storage.load_book(book_id);
    if (!book) return;
    const pages = this.storage.list_pages(book_id);
    if (!pages.length) return;
    if (!pages.some((p) => UNFINISHED_PAGE_STATUSES.has(p.status))) {
      if (book.status !== "ready") {
        book.status = "ready";
        const metadata = { ...(book.metadata ?? {}) };
        delete metadata["pause_reason"];
        delete metadata["pause_kind"];
        book.metadata = metadata;
        this.storage.save_book(book);
        this.storage.append_log(book_id, "all pages ready → status=READY", "finalize");
        await get_book_stream(book_id).book_event(
          "book_ready",
          { book_id, page_count: pages.length },
          STAGE_COMPILATION,
        );
      }
    }
  }

  // ── block-level controls ──

  async regenerate_block(args: {
    book_id: string;
    page_id: string;
    block_id: string;
    params_override?: Record<string, unknown> | null;
    stream?: StreamBus;
  }): Promise<Block | null> {
    const book = this.storage.load_book(args.book_id);
    const spine = this.storage.load_spine(args.book_id);
    const page = this.storage.load_page(args.book_id, args.page_id);
    if (!book || !spine || !page) return null;
    this.require_generation_allowed(args.book_id, book);
    const chapter = spine.chapters.find((c) => c.id === page.chapter_id);
    if (!chapter) return null;
    const block = (page.blocks ?? []).find((b) => b.id === args.block_id);
    if (!block) return null;
    if (args.params_override) block.params = { ...block.params, ...args.params_override };

    const bstream = new BookStream(args.stream ?? get_book_bus(args.book_id));
    try {
      await this.generate_block_payload({ book, chapter, page, block, bstream });
      delete block.metadata["edited_by_user"];
      this.finalize_page_status(page);
      page.updated_at = now();
      this.storage.save_page(page);
      await this.maybe_finalize_book(args.book_id);
    } catch (exc) {
      block.status = "error";
      block.error = String(exc instanceof Error ? exc.message : exc);
      this.storage.save_page(page);
    }
    return block;
  }

  // ── health ──

  kb_drift_report(book_id: string): Record<string, unknown> {
    const report = mark_drift_on_book(book_id, this.storage);
    if (!report) return { book_id, has_drift: false, missing: true };
    return report as unknown as Record<string, unknown>;
  }

  check_refresh_kb_fingerprints(book_id: string, force = false): boolean {
    try {
      const book = ensure_can_refresh_fingerprints(book_id, this.storage, force);
      return book !== null;
    } catch (e) {
      if (e instanceof KbValueError || (e instanceof Error && e.name === "ValueError")) throw e;
      throw e;
    }
  }

  refresh_kb_fingerprints(book_id: string, force = false): Record<string, unknown> | null {
    const book = refresh_book_fingerprints(book_id, this.storage, force);
    if (!book) return null;
    return {
      book_id: book.id,
      kb_fingerprints: book.kb_fingerprints,
      stale_page_ids: book.stale_page_ids,
    };
  }

  log_health(book_id: string): Record<string, unknown> {
    return scan_log_health(book_id, this.storage) as unknown as Record<string, unknown>;
  }

  is_worker_live(book_id: string): boolean {
    const rt = this.runtimes.get(book_id);
    if (!rt) return false;
    if (rt.in_flight.size) return true;
    return rt.worker !== null;
  }

  generation_overview(book: Book): Record<string, unknown> {
    const source_quality = book.metadata?.["source_quality"];
    const compiling = book.status === "compiling";
    const working = compiling && this.is_worker_live(book.id);
    return {
      status: book.status,
      can_resume: ["compiling", "paused", "error"].includes(book.status),
      pause_reason: String(book.metadata?.["pause_reason"] ?? ""),
      source_quality: source_quality && typeof source_quality === "object" ? source_quality : null,
      working,
      interrupted: compiling && !working,
      started_at: Number(book.metadata?.["compile_started_at"] ?? 0),
    };
  }

  generation_summary(book_id: string, opts: { book?: Book | null; pages?: Page[] } = {}): Record<string, unknown> {
    const book = opts.book ?? this.storage.load_book(book_id);
    if (!book) return { book_id, status: "missing" };
    const pages = opts.pages ?? this.storage.list_pages(book_id);
    const page_counts: Record<string, number> = {};
    for (const s of ["pending", "planning", "generating", "ready", "partial", "error"]) page_counts[s] = 0;
    let failed_blocks = 0;
    const categories: Record<string, number> = {};
    for (const page of pages) {
      page_counts[page.status] = (page_counts[page.status] ?? 0) + 1;
      const errors: string[] = [];
      if (page.error) errors.push(page.error);
      for (const block of page.blocks ?? []) {
        if (block.status === "error") {
          failed_blocks += 1;
          if (block.error) errors.push(block.error);
        }
      }
      for (const error of errors) {
        const cat = generation_error_category(error);
        categories[cat] = (categories[cat] ?? 0) + 1;
      }
    }
    const overview = this.generation_overview(book);
    const queued =
      (page_counts["pending"] ?? 0) + (page_counts["planning"] ?? 0) + (page_counts["generating"] ?? 0);
    const failed = page_counts["error"] ?? 0;
    const stalled = overview["working"] ? 0 : queued;
    const retryable = failed + stalled;
    return {
      book_id: book.id,
      ...overview,
      pages: { total: pages.length, ...page_counts },
      failed_blocks,
      retryable_pages: retryable,
      queued_pages: queued,
      failed_pages: failed,
      can_resume: Boolean(retryable) && Boolean(overview["can_resume"]),
      failure_categories: categories,
    };
  }

  // ── block CRUD ──

  async insert_block(args: {
    book_id: string;
    page_id: string;
    block_type: BlockType;
    params?: Record<string, unknown> | null;
    position?: number | null;
    stream?: StreamBus;
    compile_now?: boolean;
  }): Promise<Block | null> {
    const spine = this.storage.load_spine(args.book_id);
    const page = this.storage.load_page(args.book_id, args.page_id);
    const book = this.storage.load_book(args.book_id);
    if (!spine || !page || !book) return null;
    const compile_now = args.compile_now ?? true;
    if (compile_now && args.block_type !== "user_note") {
      this.require_generation_allowed(args.book_id, book);
    }
    const chapter = spine.chapters.find((c) => c.id === page.chapter_id);
    if (!chapter) return null;

    const merged_params: Record<string, unknown> = {
      chapter_title: chapter.title,
      chapter_summary: chapter.summary,
      objectives: chapter.learning_objectives,
      ...(args.params ?? {}),
    };
    const block = make_block({ type: args.block_type, params: merged_params });
    const pos = args.position;
    if (pos == null || pos >= page.blocks.length || pos < 0) page.blocks.push(block);
    else page.blocks.splice(pos, 0, block);
    this.storage.save_page(page);

    if (compile_now && args.block_type !== "user_note") {
      const bstream = new BookStream(args.stream ?? get_book_bus(args.book_id));
      try {
        await this.generate_block_payload({ book, chapter, page, block, bstream });
      } catch (exc) {
        block.status = "error";
        block.error = String(exc instanceof Error ? exc.message : exc);
      }
      this.finalize_page_status(page);
      page.updated_at = now();
      this.storage.save_page(page);
    } else if (args.block_type === "user_note") {
      block.status = "ready";
      block.payload = {
        format: "markdown",
        body: String(merged_params["body"] ?? ""),
        author: "user",
      };
      this.storage.save_page(page);
    }
    this.storage.append_log(
      args.book_id,
      `inserted ${args.block_type} block on page ${args.page_id} (pos=${pos ?? "end"})`,
      "insert_block",
    );
    return block;
  }

  async update_block(args: {
    book_id: string;
    page_id: string;
    block_id: string;
    title?: string | null;
    body?: string | null;
  }): Promise<Block | null> {
    const page = this.storage.load_page(args.book_id, args.page_id);
    if (!page) return null;
    const block = (page.blocks ?? []).find((b) => b.id === args.block_id);
    if (!block || !EDITABLE_BLOCK_TYPES.has(block.type)) return null;

    if (args.title != null) block.title = args.title;
    if (args.body != null) {
      block.payload = { ...block.payload, [body_key(block)]: args.body, format: "markdown" };
    }
    block.status = "ready";
    block.error = "";
    block.metadata = { ...(block.metadata ?? {}), edited_by_user: true };
    block.updated_at = now();

    this.finalize_page_status(page);
    page.updated_at = now();
    this.storage.save_page(page);
    this.storage.append_log(args.book_id, `edited ${block.type} block ${args.block_id}`, "edit_block");
    return block;
  }

  async delete_block(book_id: string, page_id: string, block_id: string): Promise<boolean> {
    const page = this.storage.load_page(book_id, page_id);
    if (!page) return false;
    const before = (page.blocks ?? []).length;
    page.blocks = (page.blocks ?? []).filter((b) => b.id !== block_id);
    if (page.blocks.length === before) return false;
    this.finalize_page_status(page);
    page.updated_at = now();
    this.storage.save_page(page);
    this.storage.append_log(book_id, `deleted block ${block_id} from page ${page_id}`, "delete_block");
    return true;
  }

  async move_block(book_id: string, page_id: string, block_id: string, new_position: number): Promise<boolean> {
    const page = this.storage.load_page(book_id, page_id);
    if (!page) return false;
    const idx = (page.blocks ?? []).findIndex((b) => b.id === block_id);
    if (idx < 0) return false;
    const clamped = Math.max(0, Math.min(page.blocks.length - 1, Math.trunc(new_position)));
    const [block] = page.blocks.splice(idx, 1);
    page.blocks.splice(clamped, 0, block);
    page.updated_at = now();
    this.storage.save_page(page);
    this.storage.append_log(book_id, `moved block ${block_id} on page ${page_id} → pos ${clamped}`, "move_block");
    return true;
  }

  async change_block_type(args: {
    book_id: string;
    page_id: string;
    block_id: string;
    new_type: BlockType;
    params_override?: Record<string, unknown> | null;
    stream?: StreamBus;
  }): Promise<Block | null> {
    this.require_generation_allowed(args.book_id);
    const spine = this.storage.load_spine(args.book_id);
    const page = this.storage.load_page(args.book_id, args.page_id);
    if (!spine || !page) return null;
    const block = (page.blocks ?? []).find((b) => b.id === args.block_id);
    if (!block) return null;
    block.type = args.new_type;
    block.status = "pending";
    block.payload = {};
    block.error = "";
    if (args.params_override) block.params = { ...block.params, ...args.params_override };
    block.updated_at = now();
    this.storage.save_page(page);
    return this.regenerate_block({
      book_id: args.book_id,
      page_id: args.page_id,
      block_id: args.block_id,
      stream: args.stream,
    });
  }

  // ── chapter CRUD ──

  check_chapter_mutation(book_id: string, chapter_id?: string | null, deleting = false): boolean {
    const spine = this.storage.load_spine(book_id);
    if (!spine || !this.storage.load_book(book_id)) return false;
    if (chapter_id == null) return true;
    const chapter = spine.chapters.find((c) => c.id === chapter_id);
    if (!chapter) return false;
    if (deleting && is_auto_overview(chapter)) {
      throw new KbValueError("The generated overview chapter cannot be deleted");
    }
    return true;
  }

  private renumber_chapters(book_id: string, spine: Spine): void {
    spine.chapters.forEach((chapter, index) => {
      chapter.order = index;
      for (const page_id of chapter.page_ids ?? []) {
        const page = this.storage.load_page(book_id, page_id);
        if (page && page.order !== index) {
          page.order = index;
          page.updated_at = now();
          this.storage.save_page(page);
        }
      }
    });
  }

  async add_chapter(args: {
    book_id: string;
    title: string;
    position?: number | null;
    content_type?: ContentType;
    learning_objectives?: string[];
    summary?: string;
  }): Promise<Chapter | null> {
    const spine = this.storage.load_spine(args.book_id);
    const book = this.storage.load_book(args.book_id);
    if (!spine || !book) return null;

    const chapter = make_chapter({
      title: args.title,
      content_type: args.content_type ?? "theory",
      learning_objectives: [...(args.learning_objectives ?? [])],
      summary: args.summary ?? "",
      order: spine.chapters.length,
    });
    const count = spine.chapters.length;
    const index = args.position == null ? count : Math.max(0, Math.min(args.position, count));
    spine.chapters.splice(index, 0, chapter);
    this.renumber_chapters(args.book_id, spine);

    const page = make_page({
      book_id: args.book_id,
      chapter_id: chapter.id,
      title: chapter.title,
      learning_objectives: [...(chapter.learning_objectives ?? [])],
      content_type: chapter.content_type,
      order: chapter.order,
      status: "pending",
    });
    this.storage.save_page(page);
    chapter.page_ids = [page.id];

    book.chapter_count = spine.chapters.length;
    book.page_count = this.storage.list_pages(args.book_id).length;
    book.updated_at = now();
    this.storage.save_book(book);
    this.storage.save_spine(spine);
    this.storage.append_log(args.book_id, `added chapter ${chapter.id} at position ${index}: ${args.title}`, "add_chapter");
    return chapter;
  }

  async rename_chapter(args: {
    book_id: string;
    chapter_id: string;
    title?: string | null;
    summary?: string | null;
    learning_objectives?: string[] | null;
  }): Promise<Chapter | null> {
    const spine = this.storage.load_spine(args.book_id);
    if (!spine) return null;
    const chapter = spine.chapters.find((c) => c.id === args.chapter_id);
    if (!chapter) return null;

    if (args.title != null) chapter.title = args.title;
    if (args.summary != null) chapter.summary = args.summary;
    if (args.learning_objectives != null) chapter.learning_objectives = [...args.learning_objectives];

    for (const page_id of chapter.page_ids ?? []) {
      const page = this.storage.load_page(args.book_id, page_id);
      if (!page) continue;
      let changed = false;
      if (args.title != null && page.section !== true) {
        page.title = chapter.title;
        changed = true;
      }
      if (args.learning_objectives != null && page.section !== true) {
        page.learning_objectives = [...chapter.learning_objectives];
        changed = true;
      }
      if (changed) {
        page.updated_at = now();
        this.storage.save_page(page);
      }
    }
    this.storage.save_spine(spine);
    this.storage.append_log(args.book_id, `renamed chapter ${args.chapter_id}`, "rename_chapter");
    return chapter;
  }

  async move_chapter(book_id: string, chapter_id: string, new_position: number): Promise<boolean> {
    const spine = this.storage.load_spine(book_id);
    if (!spine) return false;
    const index = spine.chapters.findIndex((c) => c.id === chapter_id);
    if (index < 0) return false;
    const clamped = Math.max(0, Math.min(spine.chapters.length - 1, Math.trunc(new_position)));
    const [chapter] = spine.chapters.splice(index, 1);
    spine.chapters.splice(clamped, 0, chapter);
    this.renumber_chapters(book_id, spine);
    this.storage.save_spine(spine);
    this.storage.append_log(book_id, `moved chapter ${chapter_id} → position ${clamped}`, "move_chapter");
    return true;
  }

  async delete_chapter(book_id: string, chapter_id: string): Promise<boolean> {
    const spine = this.storage.load_spine(book_id);
    const book = this.storage.load_book(book_id);
    if (!spine || !book) return false;
    const chapter = spine.chapters.find((c) => c.id === chapter_id);
    if (!chapter) return false;
    if (is_auto_overview(chapter)) {
      this.storage.append_log(book_id, `refused to delete overview chapter ${chapter_id}`, "delete_chapter");
      return false;
    }

    const removed = new Set<string>();
    for (const p of this.storage.list_pages(book_id)) {
      if (p.chapter_id === chapter_id) removed.add(p.id);
    }
    for (const pid of chapter.page_ids ?? []) removed.add(pid);
    for (const pid of removed) this.storage.delete_page(book_id, pid);

    spine.chapters = spine.chapters.filter((c) => c.id !== chapter_id);
    for (const other of spine.chapters) {
      other.prerequisites = (other.prerequisites ?? []).filter((p) => p !== chapter_id);
    }
    const dropped = prune_concept_graph(spine);
    this.renumber_chapters(book_id, spine);

    const progress = this.storage.load_progress(book_id);
    if (progress) {
      if (removed.has(progress.current_page_id ?? "")) progress.current_page_id = "";
      progress.visited_page_ids = (progress.visited_page_ids ?? []).filter((p) => !removed.has(p));
      progress.bookmarked_page_ids = (progress.bookmarked_page_ids ?? []).filter((p) => !removed.has(p));
      progress.weak_chapters = (progress.weak_chapters ?? []).filter((c) => c !== chapter_id);
      this.storage.save_progress(progress);
    }

    book.chapter_count = spine.chapters.length;
    book.page_count = this.storage.list_pages(book_id).length;
    book.updated_at = now();
    this.storage.save_book(book);
    this.storage.save_spine(spine);
    this.storage.append_log(
      book_id,
      `deleted chapter ${chapter_id} (${removed.size} page(s), ${dropped} concept node(s))`,
      "delete_chapter",
    );
    return true;
  }

  // ── deep dive ──

  async create_deep_dive_subpage(args: {
    book_id: string;
    parent_page_id: string;
    topic: string;
    block_id?: string | null;
    content_type?: ContentType;
    stream?: StreamBus;
  }): Promise<Page | null> {
    const book = this.storage.load_book(args.book_id);
    const spine = this.storage.load_spine(args.book_id);
    const parent = this.storage.load_page(args.book_id, args.parent_page_id);
    if (!book || !spine || !parent) return null;
    this.require_generation_allowed(args.book_id, book);

    const chapter = make_chapter({
      title: `${args.topic} (deep dive)`,
      learning_objectives: [`Go deeper into ${args.topic}`],
      content_type: args.content_type ?? "concept",
      summary: `Sub-chapter spawned from ${parent.title}.`,
      order: spine.chapters.length,
    });
    (chapter as Record<string, unknown>)["deep_dive"] = true;
    spine.chapters.push(chapter);
    this.storage.save_spine(spine);

    const sub = make_page({
      book_id: args.book_id,
      chapter_id: chapter.id,
      title: args.topic,
      learning_objectives: [...(chapter.learning_objectives ?? [])],
      content_type: chapter.content_type,
      status: "pending",
      order: this.storage.list_pages(args.book_id).length,
      parent_page_id: parent.id,
    });
    this.storage.save_page(sub);
    chapter.page_ids = [sub.id];
    this.storage.save_spine(spine);

    book.page_count = this.storage.list_pages(args.book_id).length;
    book.updated_at = now();
    this.storage.save_book(book);

    parent.links = parent.links ?? [];
    parent.links.push({ target_page_id: sub.id, relation: "deepens", label: args.topic });
    if (args.block_id) {
      const block = (parent.blocks ?? []).find((b) => b.id === args.block_id);
      if (block) {
        const pages_by_topic = { ...((block.metadata["deep_dive_pages"] as Record<string, string>) ?? {}) };
        pages_by_topic[args.topic] = sub.id;
        block.metadata = {
          ...block.metadata,
          deep_dive_pages: pages_by_topic,
          deep_dive_page_id: block.metadata["deep_dive_page_id"] ?? sub.id,
        };
      }
    }
    parent.updated_at = now();
    this.storage.save_page(parent);

    await this.compile_page({ book_id: args.book_id, page_id: sub.id, stream: args.stream });
    this.storage.append_log(
      args.book_id,
      `deep-dive page ${sub.id} spawned from ${args.parent_page_id}: ${args.topic}`,
      "deep_dive",
    );
    return this.storage.load_page(args.book_id, sub.id);
  }

  // ── supplement ──

  async supplement_for_weakness(args: {
    book_id: string;
    page_id: string;
    topic: string;
    stream?: StreamBus;
  }): Promise<Block | null> {
    this.require_generation_allowed(args.book_id);
    const page = this.storage.load_page(args.book_id, args.page_id);
    if (!page) return null;

    const clean_topic = (args.topic ?? "").trim();
    const existing = (page.blocks ?? []).find(
      (b) =>
        b.params?.["role"] === "remediation" &&
        String(b.params?.["topic"] ?? "").trim() === clean_topic,
    );
    if (existing) return existing;

    await this.insert_block({
      book_id: args.book_id,
      page_id: args.page_id,
      block_type: "callout",
      params: { variant: "common_pitfall", topic: clean_topic },
      stream: args.stream,
    });
    await this.insert_block({
      book_id: args.book_id,
      page_id: args.page_id,
      block_type: "text",
      params: { role: "remediation", topic: clean_topic },
      stream: args.stream,
    });
    return this.insert_block({
      book_id: args.book_id,
      page_id: args.page_id,
      block_type: "quiz",
      params: { num_questions: 2, difficulty: "easy", topic: clean_topic },
      stream: args.stream,
    });
  }
}

// ── block payload schemas + normalization ──────────────────────────────────

function payload_schema_hint(type: BlockType): string {
  switch (type) {
    case "section":
      return '{"intro": string, "subsections": [{"heading": string, "body": string}], "key_takeaway": string}';
    case "text":
      return '{"body": string}';
    case "callout":
      return '{"label": string, "body": string}';
    case "quiz":
      return '{"questions": [{"question": string, "question_type": "choice"|"short_answer", "options": {"a": string, "b": string, "c": string, "d": string}, "correct_answer": string, "explanation": string, "difficulty": string}]}';
    case "flash_cards":
      return '{"cards": [{"front": string, "back": string}]}';
    case "timeline":
      return '{"events": [{"date": string, "title": string, "description": string}]}';
    case "code":
      return '{"language": string, "code": string, "explanation": string}';
    case "figure":
      return '{"description": string, "code": {"language": "mermaid"|"svg"|"chartjs", "content": string}}';
    case "concept_graph":
      return '{"description": string, "code": {"language": "mermaid", "content": string}}';
    case "interactive":
      return '{"description": string, "code": {"language": "html", "content": string}}';
    case "animation":
      return '{"description": string, "video_url": string, "code": {"language": string, "content": string}}';
    case "deep_dive":
      return '{"suggestions": [{"topic": string, "rationale": string}]}';
    default:
      return '{"body": string}';
  }
}

function normalize_payload(type: BlockType, parsed: Record<string, unknown>): Record<string, unknown> {
  // Keep whatever the model returned, but guarantee the keys the frontend
  // and markdown export read.
  const out: Record<string, unknown> = { ...parsed };
  if (type === "text" && typeof out["body"] !== "string" && typeof out["content"] === "string") {
    out["body"] = out["content"];
  }
  if (type === "section") {
    if (typeof out["intro"] !== "string") out["intro"] = String(out["body"] ?? "");
    if (!Array.isArray(out["subsections"])) out["subsections"] = [];
  }
  if (type === "quiz" && !Array.isArray(out["questions"])) out["questions"] = [];
  if (type === "flash_cards" && !Array.isArray(out["cards"])) out["cards"] = [];
  if (type === "timeline" && !Array.isArray(out["events"])) out["events"] = [];
  if (type === "deep_dive" && !Array.isArray(out["suggestions"])) out["suggestions"] = [];
  return out;
}

// ── singleton ──────────────────────────────────────────────────────────────

const _engines = new Map<string, BookEngine>();

export function get_book_engine(settings?: Settings): BookEngine {
  const key = (settings ?? get_settings()).data_dir;
  let engine = _engines.get(key);
  if (!engine) {
    engine = new BookEngine({ settings });
    _engines.set(key, engine);
  }
  return engine;
}

export { chapter_basis, SOURCE as BOOK_SOURCE };
