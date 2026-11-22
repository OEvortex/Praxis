// data models for the Book Engine.
//
// Pydantic ``model_dump(mode="json")`` maps to plain JSON objects here; the
// models are interfaces plus small helpers. Enum values are kept as string
// unions / const objects so serialized payloads match upstream exactly.

export type BookStatus =
  | "draft"
  | "spine_ready"
  | "compiling"
  | "paused"
  | "ready"
  | "error"
  | "archived";

export type PageStatus = "pending" | "planning" | "generating" | "ready" | "partial" | "error";

export type BlockStatus = "pending" | "generating" | "ready" | "error" | "hidden";

export type BlockType =
  | "text"
  | "callout"
  | "quiz"
  | "user_note"
  | "figure"
  | "interactive"
  | "animation"
  | "code"
  | "timeline"
  | "flash_cards"
  | "deep_dive"
  | "section"
  | "concept_graph"
  | "diagnostic"
  | "pretest"
  | "retrieval_practice"
  | "error_diagnosis"
  | "module_test"
  | "progress_dashboard";

export const BLOCK_TYPES: readonly BlockType[] = [
  "text",
  "callout",
  "quiz",
  "user_note",
  "figure",
  "interactive",
  "animation",
  "code",
  "timeline",
  "flash_cards",
  "deep_dive",
  "section",
  "concept_graph",
  "diagnostic",
  "pretest",
  "retrieval_practice",
  "error_diagnosis",
  "module_test",
  "progress_dashboard",
];

export type BookDepth = "brief" | "standard" | "deep";

/** Multiplier applied to every template's ``target_words``. */
export const DEPTH_WORD_SCALE: Record<BookDepth, number> = {
  brief: 0.5,
  standard: 1.0,
  deep: 1.6,
};

export function depth_scale(depth?: string | null): number {
  const d = (depth ?? "standard").trim().toLowerCase() as BookDepth;
  return DEPTH_WORD_SCALE[d] ?? 1.0;
}

export function coerceDepth(value?: string | BookDepth | null): BookDepth {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "brief" || v === "deep" || v === "standard" ? v : "standard";
}

export type ContentType =
  | "theory"
  | "derivation"
  | "history"
  | "practice"
  | "concept"
  | "overview";

export const CONTENT_TYPES: readonly ContentType[] = [
  "theory",
  "derivation",
  "history",
  "practice",
  "concept",
  "overview",
];

export type LearningCaptureStatus =
  | "captured"
  | "drafted"
  | "pending_confirmation"
  | "approved"
  | "delivered"
  | "imported"
  | "rejected";

export const LEARNING_CAPTURE_STATUSES: readonly LearningCaptureStatus[] = [
  "captured",
  "drafted",
  "pending_confirmation",
  "approved",
  "delivered",
  "imported",
  "rejected",
];

export interface NotebookRef {
  notebook_id: string;
  record_ids?: string[];
  [k: string]: unknown;
}

export interface ChatSelection {
  session_id: string;
  message_ids?: number[];
  [k: string]: unknown;
}

export interface ChatMessageSnapshot {
  role?: string;
  content?: string;
  capability?: string;
  created_at?: number;
  [k: string]: unknown;
}

export interface BookInputs {
  source_refs?: Record<string, unknown>[];
  source_context?: string;
  user_intent?: string;
  chat_session_id?: string;
  chat_selections?: ChatSelection[];
  chat_history?: ChatMessageSnapshot[];
  notebook_refs?: NotebookRef[];
  knowledge_bases?: string[];
  question_categories?: number[];
  question_entries?: number[];
  language?: string;
  captured_at?: number;
  [k: string]: unknown;
}

export interface BookProposal {
  title?: string;
  description?: string;
  scope?: string;
  target_level?: string;
  estimated_chapters?: number;
  rationale?: string;
  [k: string]: unknown;
}

export interface SourceAnchor {
  kind?: string; // 'kb' | 'notebook' | 'chat' | 'web' | 'manual'
  kb_name?: string;
  ref?: string;
  snippet?: string;
  [k: string]: unknown;
}

export interface Chapter {
  id: string;
  title: string;
  learning_objectives: string[];
  content_type: ContentType;
  source_anchors: SourceAnchor[];
  prerequisites: string[];
  page_ids: string[];
  summary: string;
  order: number;
  // Extra keys the upstream pydantic model allows (extra="allow") — e.g.
  // ``auto_overview`` / ``deep_dive`` markers — ride along here.
  [k: string]: unknown;
}

export interface ConceptNode {
  id: string;
  label: string;
  chapter_id?: string;
  description?: string;
  weight?: number;
  [k: string]: unknown;
}

export interface ConceptEdge {
  src: string;
  dst: string;
  relation?: string; // 'depends_on' | 'extends' | 'related'
  rationale?: string;
  [k: string]: unknown;
}

export interface ConceptGraph {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
  [k: string]: unknown;
}

export interface Spine {
  book_id: string;
  chapters: Chapter[];
  version?: number;
  updated_at?: number;
  concept_graph?: ConceptGraph;
  exploration_summary?: string;
  [k: string]: unknown;
}

export interface SourceChunk {
  chunk_id?: string;
  kb_name?: string;
  source?: string;
  ref?: string;
  text?: string;
  score?: number;
  query?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ExplorationReport {
  book_id?: string;
  queries?: string[];
  chunks?: SourceChunk[];
  summary?: string;
  coverage?: Record<string, number>;
  candidate_concepts?: string[];
  notes?: string[];
  created_at?: number;
  [k: string]: unknown;
}

export interface Block {
  id: string;
  type: BlockType;
  status: BlockStatus;
  title: string;
  params: Record<string, unknown>;
  payload: Record<string, unknown>;
  source_anchors: SourceAnchor[];
  metadata: Record<string, unknown>;
  error: string;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface PageLink {
  target_page_id: string;
  relation?: string; // 'deepens' | 'prereq' | 'references'
  label?: string;
  [k: string]: unknown;
}

export interface Page {
  id: string;
  book_id: string;
  chapter_id: string;
  title: string;
  learning_objectives: string[];
  content_type: ContentType;
  status: PageStatus;
  order: number;
  blocks: Block[];
  links: PageLink[];
  parent_page_id?: string;
  error: string;
  created_at: number;
  updated_at: number;
  // Upstream stores this as a pydantic extra on user-added section pages.
  section?: boolean;
  [k: string]: unknown;
}

export interface QuizAttempt {
  block_id: string;
  page_id: string;
  question_id?: string;
  user_answer?: string;
  is_correct?: boolean | null;
  submission_id?: string;
  timestamp: number;
  [k: string]: unknown;
}

export interface Progress {
  book_id: string;
  current_page_id?: string;
  visited_page_ids: string[];
  bookmarked_page_ids: string[];
  quiz_attempts: QuizAttempt[];
  weak_chapters: string[];
  score: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface LearningCapture {
  id: string;
  book_id: string;
  page_id: string;
  block_id?: string;
  capture_type?: string;
  source_text?: string;
  context_before?: string;
  context_after?: string;
  source_locator?: string;
  book_title?: string;
  chapter_title?: string;
  user_note?: string;
  content_hash?: string;
  status: LearningCaptureStatus;
  version: number;
  rejected_reason?: string;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface Book {
  id: string;
  revision: number;
  title: string;
  description: string;
  status: BookStatus;
  proposal?: BookProposal | null;
  knowledge_bases: string[];
  language: string;
  depth: BookDepth;
  page_count: number;
  chapter_count: number;
  created_at: number;
  updated_at: number;
  metadata: Record<string, unknown>;
  kb_fingerprints: Record<string, string>;
  kb_document_fingerprints: Record<string, Record<string, string>>;
  stale_page_ids: string[];
  stale_detected_at: number;
  [k: string]: unknown;
}

// ── helpers ────────────────────────────────────────────────────────────────

let _counter = 0;

export function new_id(prefix: string): string {
  // uuid4().hex[:10] equivalent — crypto.randomUUID keeps it collision-safe.
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  _counter = (_counter + 1) & 0xffff;
  return `${prefix}_${rand.slice(0, 10)}${_counter.toString(16).padStart(4, "0")}`.slice(0, prefix.length + 11);
}

export function now(): number {
  return Date.now() / 1000;
}

export function make_book(partial: Partial<Book> = {}): Book {
  const t = now();
  return {
    id: new_id("bk"),
    revision: 1,
    title: "",
    description: "",
    status: "draft",
    proposal: null,
    knowledge_bases: [],
    language: "en",
    depth: "standard",
    page_count: 0,
    chapter_count: 0,
    created_at: t,
    updated_at: t,
    metadata: {},
    kb_fingerprints: {},
    kb_document_fingerprints: {},
    stale_page_ids: [],
    stale_detected_at: 0,
    ...partial,
  };
}

export function make_chapter(partial: Partial<Chapter> = {}): Chapter {
  return {
    id: new_id("ch"),
    title: "",
    learning_objectives: [],
    content_type: "theory",
    source_anchors: [],
    prerequisites: [],
    page_ids: [],
    summary: "",
    order: 0,
    ...partial,
  };
}

export function make_block(partial: Partial<Block> = {}): Block {
  const t = now();
  return {
    id: new_id("blk"),
    type: "text",
    status: "pending",
    title: "",
    params: {},
    payload: {},
    source_anchors: [],
    metadata: {},
    error: "",
    created_at: t,
    updated_at: t,
    ...partial,
  };
}

export function make_page(partial: Partial<Page> = {}): Page {
  const t = now();
  return {
    id: new_id("pg"),
    book_id: "",
    chapter_id: "",
    title: "",
    learning_objectives: [],
    content_type: "theory",
    status: "pending",
    order: 0,
    blocks: [],
    links: [],
    parent_page_id: "",
    error: "",
    created_at: t,
    updated_at: t,
    ...partial,
  };
}

export function make_progress(book_id: string): Progress {
  return {
    book_id,
    current_page_id: "",
    visited_page_ids: [],
    bookmarked_page_ids: [],
    quiz_attempts: [],
    weak_chapters: [],
    score: 0,
    updated_at: now(),
  };
}

export function make_learning_capture(partial: Partial<LearningCapture> = {}): LearningCapture {
  const t = now();
  return {
    id: new_id("lc"),
    book_id: "",
    page_id: "",
    block_id: "",
    capture_type: "selection",
    source_text: "",
    context_before: "",
    context_after: "",
    source_locator: "",
    book_title: "",
    chapter_title: "",
    user_note: "",
    content_hash: "",
    status: "captured",
    version: 1,
    rejected_reason: "",
    created_at: t,
    updated_at: t,
    ...partial,
  };
}
