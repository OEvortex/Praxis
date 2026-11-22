// knowledge-base agent tools backed by
// KnowledgeBaseStore (BM25 retrieval).
//
// Mirrors Praxis's ``rag`` / ``kb_files`` / ``read_source`` tools closely
// enough for the model to cite sources; the ``knowledge_bases`` turn field
// selects which KBs are in scope (empty = all).

import { BaseTool, type ToolParamsSchema } from "../shared/vtx.js";
import { ok, fail, type ToolResult } from "../shared/types.js";
import { get_settings } from "../config.js";
import { KnowledgeBaseStore } from "../store/kb_store.js";

export interface KnowledgeBaseSearchParams {
  action?: "search" | "files" | "read";
  query?: string;
  knowledge_bases?: string;
  top_k?: number;
  kb_name?: string;
  doc?: string;
}

export const knowledgeBaseSearchParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["search", "files", "read"],
      default: "search",
      description:
        "search = retrieve passages for query; files = list documents " +
        "in the knowledge bases; read = full text of one document " +
        "(needs kb_name + doc).",
    },
    query: { type: "string", default: "", description: "Search query — search only." },
    knowledge_bases: {
      type: "string",
      default: "",
      description: "Comma-separated KB names to scope — search/files; empty = all.",
    },
    top_k: { type: "integer", default: 5, description: "Passages per KB — search only." },
    kb_name: { type: "string", default: "", description: "KB name — read only." },
    doc: { type: "string", default: "", description: "Document filename from files — read only." },
  },
};

let _store: KnowledgeBaseStore | null = null;

function _kb(): KnowledgeBaseStore {
  if (_store === null) {
    _store = new KnowledgeBaseStore(get_settings());
  }
  return _store;
}

function _scoped_kbs(commandKbs: string[] | null): string[] {
  const allKbs = _kb()
    .list()
    .map((k) => String(k["name"] ?? ""))
    .filter(Boolean);
  if (!allKbs.length) return [];
  if (commandKbs && commandKbs.length) {
    const allowed = new Set(allKbs);
    return commandKbs.filter((k) => allowed.has(k));
  }
  return allKbs;
}

export class KnowledgeBaseSearchTool extends BaseTool<KnowledgeBaseSearchParams> {
  name = "knowledge_base_search";
  toolIcon = "📚";
  params = knowledgeBaseSearchParamsSchema;
  mutating = false;
  description =
    "Search the user's knowledge bases: retrieve relevant passages, " +
    "list indexed documents, or read one document's full text.";

  async execute(params: KnowledgeBaseSearchParams): Promise<ToolResult> {
    const names = (params.knowledge_bases ?? "")
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    const kbs = _scoped_kbs(names.length ? names : null);
    const action = params.action ?? "search";

    if (action === "files") {
      if (!kbs.length) return ok("No knowledge bases configured.");
      const out: string[] = [];
      for (const name of kbs) {
        const docs = _kb().list_documents(name);
        out.push(
          `KB '${name}': ` +
            (docs.length
              ? docs.map((d) => String(d["name"] ?? "")).join(", ")
              : "(empty)"),
        );
      }
      return ok(out.join("\n"));
    }

    if (action === "read") {
      const text = _kb().read_source(params.kb_name ?? "", params.doc ?? "");
      return ok(
        text ||
          `No indexed content for ${JSON.stringify(params.doc ?? "")} in KB ${JSON.stringify(params.kb_name ?? "")}.`,
      );
    }

    if (!params.query?.trim()) {
      return fail("knowledge_base_search needs a query (action='search').");
    }
    if (!kbs.length) return ok("No knowledge bases configured.");
    const out: string[] = [];
    for (const name of kbs) {
      const hits = _kb().search(name, params.query, params.top_k ?? 5);
      for (const h of hits) {
        out.push(`[KB: ${name} | source: ${String(h["doc"] ?? "")} | chunk: ${String(h["id"] ?? "")}]\n${String(h["text"] ?? "")}`);
      }
    }
    return ok(out.length ? out.join("\n\n---\n\n") : "No relevant passages found.");
  }
}

export const knowledge_base_search = new KnowledgeBaseSearchTool();
