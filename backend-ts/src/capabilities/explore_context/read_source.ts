// Port of deeptutor/tools/builtin ReadSourceTool — loads the full text of an
// attached turn source by its manifest id. The per-turn ``{source_id: text}``
// map is injected by the caller (upstream ``source_index`` kwarg; here the
// ``source_index`` param or ``current_source_index`` context var).
//
// ``read_source`` lives only inside the explore-context pre-pass's own tool
// loop — it is never mounted on the answer loop's surface.

import { BaseTool, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import { ContextVar } from "../../agent/turn_context.js";

export const HISTORY_PAGE_CHARS = 16000;

/** Per-turn ``{source_id: full_text}`` map, published by the explorer. */
export const current_source_index = new ContextVar<Record<string, string>>({});

export interface ReadSourceParams {
  source_id?: string;
  offset?: number;
  source_index?: Record<string, string>;
}

export const readSourceParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["source_id"],
  properties: {
    source_id: {
      type: "string",
      description:
        "The source identifier from the Attached Sources manifest. Begins " +
        "with one of: nb- (notebook record), bk- (book reference), rd- " +
        "(reading unit), hs- (history session), qb- (question-bank entry), " +
        "at- (document attachment).",
    },
    offset: {
      type: "integer",
      default: 0,
      description:
        "Character offset for an hs-tutor-* history page; starts at 0.",
    },
  },
};

export class ReadSourceTool extends BaseTool<ReadSourceParams> {
  name = "read_source";
  toolIcon = "📄";
  params = readSourceParamsSchema;
  mutating = false;
  description =
    "Load the full text of one attached source by id. Use ONLY when the " +
    "preview shown in the Attached Sources manifest is insufficient to " +
    "answer the user's question. The id must be copied verbatim from the " +
    "manifest — do not invent ids. Do not call this on every source 'just " +
    "in case'. Tutoring history (hs-tutor-*) is paginated; use next_offset " +
    "to read the next page.";

  async execute(p: ReadSourceParams): Promise<ToolResult> {
    const sourceIndex =
      p.source_index && typeof p.source_index === "object"
        ? p.source_index
        : current_source_index.get();
    if (!sourceIndex || !Object.keys(sourceIndex).length) {
      return fail("Error: no attached sources are available for this turn.");
    }
    let sourceId = String(p.source_id ?? "").trim();
    if (!sourceId) {
      const ids = Object.keys(sourceIndex);
      if (ids.length === 1) sourceId = ids[0];
      else {
        return fail(
          "Error: source_id is required when multiple sources are available.",
        );
      }
    }
    const fullText = sourceIndex[sourceId];
    if (!fullText) {
      const available = Object.keys(sourceIndex).sort().join(", ");
      return fail(
        `Error: unknown source_id ${JSON.stringify(sourceId)}. ` +
          `Valid ids for this turn: ${available || "(none)"}.`,
      );
    }
    let content = String(fullText);
    const metadata: Record<string, unknown> = {
      source_id: sourceId,
      char_count: [...content].length,
    };
    if (sourceId.startsWith("hs-tutor-")) {
      const offsetRaw = p.offset ?? 0;
      const offset = Math.trunc(Number(offsetRaw));
      const total = [...content].length;
      if (!Number.isFinite(offset) || offset < 0 || offset >= total) {
        return fail(
          "Error: offset must be a non-negative integer within the archive.",
        );
      }
      if (offset || total > HISTORY_PAGE_CHARS) {
        const chars = [...content];
        const end = Math.min(offset + HISTORY_PAGE_CHARS, total);
        const nextOffset = end < total ? end : null;
        metadata["offset"] = offset;
        metadata["next_offset"] = nextOffset;
        content = JSON.stringify({
          archive_id: sourceId,
          offset,
          next_offset: nextOffset,
          total_chars: total,
          content: chars.slice(offset, end).join(""),
        });
      }
    }
    const out: ToolResult = {
      success: true,
      result: content,
      metadata,
    };
    if ((p as Record<string, unknown>)["_mastery_source_context"]) {
      out["public_result"] = { content: "Attached source inspected privately." };
    }
    return out;
  }
}
export const read_source = new ReadSourceTool();
