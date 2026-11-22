// a standalone action's
// result, turned into the learning block it was run for.
//
// When a learning block's "Generate" runs a pipeline that cannot call
// note_suggest itself (Research, Quiz, Visualize, ...), the turn executor files
// the pipeline result here as a replace suggestion on that block.

import { randomUUID } from "node:crypto";

import { getCoWriterStorage } from "../../services/documents/storage.js";
import type { CoWriterStorage } from "../../services/documents/storage.js";
import { walk_blocks } from "../../services/documents/blocks.js";
import { propose } from "../../services/documents/proposals.js";
import type { Dict } from "../../shared/types.js";

type Block = Dict;

function isRecord(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function _json(value: unknown): Dict {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The learning block a pipeline's result renders as, or null for plain text. */
export function result_learning_block(
  result: Dict,
  response = "",
): Block | null {
  let kind = "";
  let payload: Dict = result;
  const summary = isRecord(result["summary"]) ? (result["summary"] as Dict) : {};
  if (result["outline_preview"] && Array.isArray(result["sub_topics"])) {
    kind = "research";
  } else if (Array.isArray(summary["results"])) {
    kind = "quiz";
    payload = {
      questions: (summary["results"] as unknown[])
        .filter(isRecord)
        .map((row) => row["qa_pair"])
        .filter(isRecord),
    };
  } else if (result["renderer"] && result["payload"]) {
    kind = "visualization";
  } else if (Array.isArray(result["artifacts"]) && result["artifacts"].length) {
    kind = "animation";
  } else if (
    Array.isArray(result["workspace_items"]) &&
    result["workspace_items"].length
  ) {
    kind = "media";
  }
  if (!kind) return null;

  const questions = kind === "quiz" ? payload["questions"] : null;
  let markdown: string;
  if (Array.isArray(questions)) {
    markdown = (questions as Dict[])
      .map(
        (q, i) =>
          `${i + 1}. ${String(q["question"] ?? "")}\n\n${String(q["explanation"] ?? "")}\n`,
      )
      .join("\n");
  } else {
    markdown =
      response || String(result["response"] ?? result["report"] ?? "");
  }
  return {
    id: randomUUID().replace(/-/g, ""),
    type: "learning",
    props: {
      kind,
      prompt: "",
      markdown,
      data: JSON.stringify(payload),
      sourceUrl: "",
    },
    children: [],
  };
}

/** File the turn's result as a replace suggestion on its learning block. */
export function propose_generated_block(opts: {
  note_document_id: string;
  generation: Dict;
  events: Dict[];
  response: string;
  turn_id: string;
  explanation: string;
  storage?: CoWriterStorage;
}): void {
  const storage = opts.storage ?? getCoWriterStorage();
  const { note_document_id, generation, events, turn_id, explanation } = opts;
  let response = opts.response;
  const block_id = String(generation["block_id"] ?? "");
  if (!note_document_id || !block_id) return;

  const result_event = [...events].reverse().find((e) => e["type"] === "result");
  const resultMeta = isRecord(result_event?.["metadata"])
    ? (result_event!["metadata"] as Dict)
    : {};
  response = String(
    resultMeta["response"] ??
      resultMeta["report"] ??
      result_event?.["content"] ??
      response ??
      "",
  );
  const block = result_event
    ? result_learning_block(resultMeta, response)
    : null;
  if (!(block || response.trim())) return;

  const doc = storage.loadDocument(note_document_id);
  const target = doc
    ? [...walk_blocks((doc.blocks ?? []) as Block[])].find(
        (b) => b["id"] === block_id,
      )
    : undefined;
  if (target === undefined) return;

  let blocks: Block[] | null = null;
  if (block) {
    const props = (target["props"] ?? {}) as Dict;
    const data = _json((block["props"] as Dict)["data"]);
    const generationSettings = _json(props["data"])["generation"];
    if (generationSettings !== undefined && generationSettings !== null) {
      data["generation"] = generationSettings;
    }
    blocks = [
      {
        ...block,
        id: block_id,
        props: {
          ...((block["props"] ?? {}) as Dict),
          kind: props["kind"] ?? (block["props"] as Dict)["kind"],
          prompt: props["prompt"] ?? "",
          data: JSON.stringify(data),
          // upstream: ensure_ascii=False — JSON.stringify is UTF-8 already.
        },
      },
    ];
  }
  try {
    propose(storage, note_document_id, {
      operation: "replace",
      block_id,
      source_turn_id: turn_id,
      markdown: response,
      blocks,
      explanation,
    });
  } catch (exc) {
    console.warn(
      `Could not file the generated block for ${block_id}: ${String(exc)}`,
    );
  }
}
