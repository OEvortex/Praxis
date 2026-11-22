// the
// tools the immersive-reading capability mounts on the chat loop.
//
// Two families, and the split matters:
//
// **Reading** — material_outline / search_material / read_material. These are
// how the model gets grounded. Because the material is stored per unit, every
// one of them returns a *locator*, so a claim is traceable to "page 12" as a
// by-product of how the evidence was fetched.
//
// **Driving the reader** — reader_goto / reader_annotate. These reach out of
// the conversation and act on what the user is looking at. UI side-effects
// travel on the tool result's ``metadata`` under ``reader_action`` (upstream
// ToolResult.metadata → tool_result event; same convention here).
//
// The material id is never a model parameter: ``mode.ts`` resolves it
// server-side from the session's mode record or the orchestrator-injected
// ``_material_id`` / ``_reading_workspace_id`` / ``_reading_binding`` params
// (upstream ``augment_kwargs``). Each call builds/uses the shared
// ``MaterialStore`` — reads are cheap file opens; writes take the store's
// atomic-write path.

import { BaseTool, type ToolParamsSchema } from "../../shared/vtx.js";
import { fail, type Dict, type ToolResult } from "../../shared/types.js";
import {
  MaterialNotFound,
  ReadingError,
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  materialStore,
  renderOutline,
  renderUnits,
  searchMaterial,
  searchHitToPlain,
  unitTimestamps,
  verifyQuote,
  type MaterialStore,
} from "./store.js";
import {
  bindMaterial,
  READING_TOOL_NAMES,
  resolveBinding,
} from "./mode.js";
import { renderMediaNote } from "./media_notes.js";
import { view_figure } from "./figure_view.js";
import type { Annotation } from "../../services/reading/models.js";

export { READING_TOOL_NAMES };
export { view_figure, ViewFigureTool } from "./figure_view.js";

const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 20;

// ---------------------------------------------------------------------------
// Shared plumbing (upstream _tool_base.py)
// ---------------------------------------------------------------------------

interface HiddenBindingParams {
  _material_id?: string;
  _reading_workspace_id?: string;
  _reading_binding?: Dict;
}

abstract class ReadingToolBase<P extends HiddenBindingParams = HiddenBindingParams> extends BaseTool<P> {
  toolIcon = "📖";
  mutating = false;

  /** Resolve the bound material id or fail with the no-material message. */
  protected materialId(p: P): string {
    try {
      return bindMaterial(resolveBinding(p as unknown as Dict));
    } catch (exc) {
      if (exc instanceof ReadingError) throw exc;
      throw exc;
    }
  }

  protected workspaceId(p: P): string {
    return resolveBinding(p as unknown as Dict).workspace_id;
  }

  /** Upstream ``_guard``: engine errors become readable tool failures. */
  protected async guarded(run: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
    try {
      return await run();
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      if (message.startsWith("No reading material is open")) {
        return fail("No reading material is open. Ask the user to open a document in the reader.");
      }
      if (exc instanceof MaterialNotFound || exc instanceof ReadingError) {
        return fail(message);
      }
      // Defensive: never let a store failure kill the turn.
      return fail("The reader could not complete that request.");
    }
  }

  async execute(p: P): Promise<ToolResult> {
    return this.guarded(() => this.run(p));
  }

  protected run(_p: P): Promise<ToolResult> | ToolResult {
    throw new Error("not implemented");
  }
}

function clampInt(value: unknown, fallback: number, low: number, high: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(low, Math.min(high, Math.trunc(n)));
}

function asLocator(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function ellipsis(text: string, limit: number): string {
  const flat = (text ?? "").split(/\s+/).filter(Boolean).join(" ");
  const chars = [...flat];
  return chars.length <= limit ? flat : chars.slice(0, limit - 1).join("") + "…";
}

function failure(message: string): ToolResult {
  return fail(message);
}

function store(): MaterialStore {
  return materialStore;
}

// ---------------------------------------------------------------------------
// reading_list_tabs / reading_switch_tab
// ---------------------------------------------------------------------------

export interface ReadingListTabsParams extends HiddenBindingParams {}
export const readingListTabsParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {},
};

export class ReadingListTabsTool extends ReadingToolBase<ReadingListTabsParams> {
  name = "reading_list_tabs";
  description =
    "List the material tabs on the current reading table. Returns only " +
    "identity, source type and processing status—never document bodies. " +
    "Use this before comparing sources or switching to another material.";
  params = readingListTabsParamsSchema;

  protected run(p: ReadingListTabsParams): ToolResult {
    const workspaceId = this.workspaceId(p);
    if (!workspaceId) return failure("No reading workspace is open.");
    const workspace = store().getWorkspace(workspaceId);
    if (!workspace) return failure("The reading workspace is unavailable.");
    const lines = [
      `Reading table “${workspace.title}” has ${workspace.tabs.length} material(s):`,
    ];
    const tabs: Dict[] = [];
    for (const tab of workspace.tabs) {
      const active = workspace.active_material_id === tab.material_id;
      lines.push(
        `- ${active ? "ACTIVE — " : ""}${tab.title} [${tab.source_kind}; ${tab.status}; id=${tab.material_id}]`,
      );
      tabs.push({
        material_id: tab.material_id,
        title: tab.title,
        source_kind: tab.source_kind,
        status: tab.status,
        active,
      });
    }
    return {
      success: true,
      result: lines.join("\n"),
      metadata: { workspace_id: workspaceId, tabs },
    };
  }
}

export interface ReadingSwitchTabParams extends HiddenBindingParams {
  material_id?: string;
}
export const readingSwitchTabParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["material_id"],
  properties: {
    material_id: {
      type: "string",
      description: "The exact material id returned by reading_list_tabs.",
    },
  },
};

export class ReadingSwitchTabTool extends ReadingToolBase<ReadingSwitchTabParams> {
  name = "reading_switch_tab";
  description =
    "Switch the active reading tab before using outline/search/read tools on " +
    "another workspace material. The material must come from reading_list_tabs.";
  params = readingSwitchTabParamsSchema;

  protected run(p: ReadingSwitchTabParams): ToolResult {
    const binding = resolveBinding(p as unknown as Dict);
    const workspaceId = binding.workspace_id;
    const materialId = String(p.material_id ?? "").trim();
    if (!workspaceId) return failure("No reading workspace is open.");
    if (!materialId) return failure("reading_switch_tab needs a material id.");
    // Upstream assert_learning_material: the id must be a real catalog row.
    // MaterialStore.manifest throws MaterialNotFound for unknown ids.
    const s = store();
    try {
      s.manifest(materialId);
    } catch {
      return failure(`Unknown material id: ${materialId}`);
    }
    const workspace = s.setActiveMaterial(workspaceId, materialId);
    if (!workspace) {
      // Workspace row missing or material not a member — still rebind the turn.
      const fallback = s.getWorkspace(workspaceId);
      if (!fallback) return failure("The reading workspace is unavailable.");
      const member = fallback.tabs.some((t) => t.material_id === materialId);
      if (!member) return failure(`${materialId} is not a tab of this workspace.`);
    }
    // Rebind this turn + persist for later turns (upstream mutated the
    // server-side binding dict).
    binding.binding["material_id"] = materialId;
    bindMaterial(binding);
    const title =
      (workspace ?? s.getWorkspace(workspaceId))?.tabs.find(
        (t) => t.material_id === materialId,
      )?.title ?? materialId;
    return {
      success: true,
      result: `Switched the reading tools to “${title}”.`,
      metadata: {
        workspace_id: workspaceId,
        material_id: materialId,
        reader_action: "switch_tab",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// material_outline
// ---------------------------------------------------------------------------

export interface MaterialOutlineParams extends HiddenBindingParams {}
export const materialOutlineParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {},
};

export class MaterialOutlineTool extends ReadingToolBase<MaterialOutlineParams> {
  name = "material_outline";
  description =
    "Show the structure of the document the user is reading: its size and an " +
    "outline with the locator (page / chapter / slide / section number) of " +
    "each heading. Call this FIRST when you need to find where something is " +
    "discussed — it is far cheaper than reading units one by one to look for it.";
  params = materialOutlineParamsSchema;

  protected run(p: MaterialOutlineParams): ToolResult {
    const materialId = this.materialId(p);
    const s = store();
    const text = renderOutline(s, materialId);
    return {
      success: true,
      result: text,
      metadata: { material_id: materialId },
    };
  }
}

// ---------------------------------------------------------------------------
// search_material
// ---------------------------------------------------------------------------

export interface SearchMaterialParams extends HiddenBindingParams {
  query?: string;
  limit?: number;
}
export const searchMaterialParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["query"],
  properties: {
    query: {
      type: "string",
      description:
        "Words or a phrase to look for. A verbatim phrase from the document " +
        "matches most precisely.",
    },
    limit: {
      type: "integer",
      description: `Maximum matches to return (default ${SEARCH_DEFAULT_LIMIT}).`,
    },
  },
};

export class SearchMaterialTool extends ReadingToolBase<SearchMaterialParams> {
  name = "search_material";
  description =
    "Search the full text of the document the user is reading. Returns " +
    "matching locators (page / chapter / slide / section numbers) with a " +
    "snippet from each. Use this to find where a term, name, formula or " +
    "phrase appears, then read those locators with read_material.";
  params = searchMaterialParamsSchema;

  protected run(p: SearchMaterialParams): ToolResult {
    const materialId = this.materialId(p);
    const query = String(p.query ?? "").trim();
    if (!query) return failure("search_material needs a non-empty query.");
    const limit = clampInt(p.limit, SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
    const s = store();
    const manifest = s.manifest(materialId);
    const result = searchMaterial(s, materialId, query, limit);

    if (!result.hits.length) {
      return {
        success: true,
        result:
          `No match for "${query}". Try fewer or different words, or call ` +
          "material_outline to see what the document covers.",
        metadata: {
          material_id: materialId,
          material_revision: manifest.revision,
          hits: [],
        },
      };
    }

    const lines = [
      `${result.hits.length} match(es) for "${query}"` +
        (result.mode === "terms" ? " (loose term match — verify before citing)" : "") +
        ":",
    ];
    const refs = new Map(
      (manifest.render_mode === "video" || manifest.render_mode === "audio"
        ? s.unitReferences(materialId)
        : []
      ).map((ref) => [ref.locator, ref]),
    );
    for (const hit of result.hits) {
      const timestamp = refs.get(hit.locator);
      const timedLabel = timestamp?.title ? ` [${timestamp.title}]` : "";
      lines.push(`- ${manifest.unit} ${hit.locator}${timedLabel}: ${hit.snippet}`);
    }
    if (result.truncated) {
      lines.push("… more matches exist; narrow the query or raise the limit.");
    }
    // Next-step guidance sits in the tool output, not only in the system
    // prompt: snippets are windowed and may cut mid-sentence, so quoting one
    // verbatim produces a citation that does not match the document.
    lines.push(
      `→ These are windowed snippets, not the source. Read the ${manifest.unit}(s) ` +
        "with read_material before quoting, then call reader_goto to show " +
        "the user the passage.",
    );

    return {
      success: true,
      result: lines.join("\n"),
      sources: result.hits.map((hit) => ({
        type: "reading",
        material_id: materialId,
        material_revision: manifest.revision,
        title: manifest.filename,
        page: hit.locator,
        content: hit.snippet,
      })),
      metadata: {
        material_id: materialId,
        material_revision: manifest.revision,
        mode: result.mode,
        hits: result.hits.map(searchHitToPlain),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// read_material
// ---------------------------------------------------------------------------

export interface ReadMaterialParams extends HiddenBindingParams {
  locators?: string;
}
export const readMaterialParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["locators"],
  properties: {
    locators: {
      type: "string",
      description:
        "Which parts to read: '12', '12-14', or '3,12,17'. Locators are " +
        "1-indexed and match what the reader shows.",
    },
  },
};

export class ReadMaterialTool extends ReadingToolBase<ReadMaterialParams> {
  name = "read_material";
  description =
    "Read the exact text of specific parts of the document the user is " +
    "reading, addressed by locator (page / chapter / slide / section " +
    "number). Accepts a single number ('12'), a range ('12-14') or a list " +
    "('3,12,17'). Every claim you make about the document should come from " +
    "text you read here, and should cite the locator it came from.";
  params = readMaterialParamsSchema;

  protected run(p: ReadMaterialParams): ToolResult {
    const materialId = this.materialId(p);
    const spec = p.locators;
    if (spec === undefined || spec === null || String(spec).trim() === "") {
      return failure("read_material needs a locator, e.g. '12' or '12-14'.");
    }
    const s = store();
    const manifest = s.manifest(materialId);
    const rendered = renderUnits(s, materialId, spec);

    if (!rendered.text.trim()) {
      return {
        success: true,
        result:
          `Those ${manifest.unit}s contain no extractable text ` +
          "(they may be images or scans).",
        metadata: {
          material_id: materialId,
          material_revision: manifest.revision,
          locators: rendered.locators,
        },
      };
    }
    const stamps = unitTimestamps(s, manifest);
    let timing = "";
    if (stamps.size) {
      timing =
        "\n\nTimestamp map:\n" +
        rendered.locators
          .filter((locator) => stamps.has(locator))
          .map((locator) => `- ${manifest.unit} ${locator}: [${stamps.get(locator)}]`)
          .join("\n");
    }
    const mediaNote = renderMediaNote(s, materialId, manifest.unit, rendered.locators);
    const followup =
      "\n\n→ Now call reader_goto with the verbatim sentence you are " +
      "about to cite, so the user sees it highlighted, and cite it in " +
      (stamps.size ? "prose with the exact [MM:SS] or [H:MM:SS] timestamp above." : "prose as [p.N].");
    return {
      success: true,
      result: rendered.text + timing + mediaNote + followup,
      sources: rendered.locators.map((locator) => ({
        type: "reading",
        material_id: materialId,
        material_revision: manifest.revision,
        title: manifest.filename,
        page: locator,
      })),
      metadata: {
        material_id: materialId,
        material_revision: manifest.revision,
        locators: rendered.locators,
        truncated: rendered.truncated,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// reader_goto
// ---------------------------------------------------------------------------

export interface ReaderGotoParams extends HiddenBindingParams {
  locator?: number;
  quote?: string;
}
export const readerGotoParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["locator"],
  properties: {
    locator: {
      type: "integer",
      description: "The page / chapter / slide / section number to show.",
    },
    quote: {
      type: "string",
      description:
        "Verbatim text from that locator to highlight. Keep it short (one " +
        "sentence or phrase) and copy it exactly.",
    },
  },
};

function gotoResult(
  materialId: string,
  locator: number,
  opts: {
    quote?: string;
    manifest: ReturnType<MaterialStore["manifest"]>;
    stamps?: Map<number, string>;
    corrected_from?: number | null;
    unverified_quote?: string;
  },
): ToolResult {
  const stamp = opts.stamps?.get(locator) ?? "";
  const where = `${opts.manifest.unit} ${locator}` + (stamp ? ` [${stamp}]` : "");
  let note = "";
  if (opts.corrected_from != null) {
    note =
      ` (that passage is on ${opts.manifest.unit} ${locator}, ` +
      `not ${opts.manifest.unit} ${opts.corrected_from} — cite ${locator})`;
  } else if (opts.unverified_quote) {
    note =
      " — but nothing was highlighted: that wording does not appear " +
      "verbatim in the document. To highlight a passage, pass the text " +
      "exactly as the document writes it, in its own language";
  }
  return {
    success: true,
    result: `Reader moved to ${where}${note}.`,
    metadata: {
      material_id: materialId,
      material_revision: opts.manifest.revision,
      reader_action: "goto",
      locator,
      quote: opts.quote ?? "",
      corrected_from: opts.corrected_from ?? null,
    },
  };
}

export class ReaderGotoTool extends ReadingToolBase<ReaderGotoParams> {
  name = "reader_goto";
  mutating = true;
  description =
    "Scroll the user's reader to a specific locator and highlight the " +
    "passage you are talking about. Use it whenever you reference a " +
    "specific part of the document, so the user sees what you are reading. " +
    "Pass the exact quote you are referring to — if it does not appear in " +
    "the document the jump is refused, so quote verbatim rather than " +
    "paraphrasing.";
  params = readerGotoParamsSchema;

  protected run(p: ReaderGotoParams): ToolResult {
    const materialId = this.materialId(p);
    const s = store();
    const manifest = s.manifest(materialId);
    const stamps = unitTimestamps(s, manifest);

    const locator = asLocator(p.locator);
    if (locator < 1 || locator > manifest.unit_count) {
      return failure(
        `reader_goto needs a locator between 1 and ${manifest.unit_count}.`,
      );
    }
    const quote = String(p.quote ?? "").trim();

    if (!quote) {
      // No claim to verify: a bare navigation request is honoured.
      return gotoResult(materialId, locator, { quote: "", manifest, stamps });
    }

    const check = verifyQuote(s, materialId, locator, quote);
    if (!check.verified) {
      // Move anyway, without a highlight — refusing the whole jump made the
      // reader sit still for translated/paraphrased "quotes".
      return gotoResult(materialId, locator, {
        quote: "",
        manifest,
        stamps,
        unverified_quote: quote,
      });
    }
    const target = check.found_locator ?? locator;
    return gotoResult(materialId, target, {
      quote,
      manifest,
      stamps,
      corrected_from: target !== locator ? locator : null,
    });
  }
}

// ---------------------------------------------------------------------------
// reader_annotate
// ---------------------------------------------------------------------------

export interface ReaderAnnotateParams extends HiddenBindingParams {
  locator?: number;
  quote?: string;
  note?: string;
  color?: string;
}
export const readerAnnotateParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["locator", "quote"],
  properties: {
    locator: {
      type: "integer",
      description: "The page / chapter / slide / section number to mark.",
    },
    quote: {
      type: "string",
      description: "Verbatim text from that locator to mark. Must appear there.",
    },
    note: {
      type: "string",
      description: "Optional note to attach to the mark.",
    },
    color: {
      type: "string",
      description: "Highlight colour.",
      enum: ["yellow", "green", "blue", "pink", "purple"],
    },
  },
};

export class ReaderAnnotateTool extends ReadingToolBase<ReaderAnnotateParams> {
  name = "reader_annotate";
  mutating = true;
  description =
    "Mark a passage in the user's document with an optional note. The mark " +
    "persists, appears in the reader's annotation list, and is included when " +
    "the user exports their annotated file. Use it when the user asks you to " +
    "highlight, mark up or annotate something — not for ordinary explanation.";
  params = readerAnnotateParamsSchema;

  protected run(p: ReaderAnnotateParams): ToolResult {
    const materialId = this.materialId(p);
    const s = store();
    const manifest = s.manifest(materialId);

    const locator = asLocator(p.locator);
    if (locator < 1 || locator > manifest.unit_count) {
      return failure(
        `reader_annotate needs a locator between 1 and ${manifest.unit_count}.`,
      );
    }
    const quote = String(p.quote ?? "").trim();
    if (!quote) {
      return failure("reader_annotate needs the verbatim quote to mark.");
    }

    const check = verifyQuote(s, materialId, locator, quote);
    if (!check.verified) {
      return failure(
        "That quote does not appear in this document, so nothing was marked. " +
          "Read the passage first and copy it exactly.",
      );
    }
    const target = check.found_locator ?? locator;

    const colour = String(p.color ?? "").trim().toLowerCase();
    const annotation: Annotation = {
      annotation_id: "",
      locator: target,
      material_revision: manifest.revision,
      kind: "highlight",
      color: colour in ANNOTATION_COLORS ? colour : DEFAULT_ANNOTATION_COLOR,
      quote,
      note: String(p.note ?? "").trim(),
      rects: [],
      source_anchor: "",
      selectors: [],
      resolution: "resolved",
      author: "assistant",
      created_at: 0,
      updated_at: 0,
    };
    const saved = s.saveAnnotation(materialId, annotation);

    return {
      success: true,
      result:
        `Marked ${manifest.unit} ${target}: “${ellipsis(quote, 80)}”` +
        (saved.note ? ` — ${saved.note}` : ""),
      metadata: {
        material_id: materialId,
        reader_action: "annotate",
        annotation: {
          annotation_id: saved.annotation_id,
          locator: saved.locator,
          kind: saved.kind,
          color: saved.color,
          quote: saved.quote,
          note: saved.note,
          author: saved.author,
          created_at: saved.created_at,
        },
        // Marking is also a reason to look: carry the jump so the client can
        // reveal the mark it just made without a second tool call.
        locator: target,
        quote,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const reading_list_tabs = new ReadingListTabsTool();
export const reading_switch_tab = new ReadingSwitchTabTool();
export const material_outline = new MaterialOutlineTool();
export const search_material = new SearchMaterialTool();
export const read_material = new ReadMaterialTool();
export const reader_goto = new ReaderGotoTool();
export const reader_annotate = new ReaderAnnotateTool();

/** All reading tools, ready for orchestrator registration. */
export const READING_TOOLS = [
  reading_list_tabs,
  reading_switch_tab,
  material_outline,
  search_material,
  read_material,
  view_figure,
  reader_goto,
  reader_annotate,
] as const;

export const READING_TOOL_TYPES = [
  ReadingListTabsTool,
  ReadingSwitchTabTool,
  MaterialOutlineTool,
  SearchMaterialTool,
  ReadMaterialTool,
  ReaderGotoTool,
  ReaderAnnotateTool,
];
