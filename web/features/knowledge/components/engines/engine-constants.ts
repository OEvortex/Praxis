// Model kinds each engine needs for its in-place pickers. Engines absent from
// this map (e.g. Tencent IMA, which keeps its library remotely) show no pickers.
export const ENGINE_MODEL_KINDS: Record<string, ("llm" | "embedding")[]> = {
  llamaindex: ["embedding"],
};

export const MODEL_KIND_LABEL: Record<string, string> = {
  llm: "Chat model",
  embedding: "Embedding model",
};

// Prerequisites prose per engine (English source doubles as i18n key).
export const ENGINE_PREREQUISITES: Record<string, string> = {
  llamaindex:
    "Local vector engine — works out of the box. Each knowledge base uses its selected embedding model; install the optional BM25 package to enable hybrid retrieval.",
  ima: "Hosted engine: the library lives in Tencent IMA and Praxis keeps no copy. Requires an IMA Client ID and API key. Chat searches it, browses its documents, reads full sources, and — only when you ask — collects a web page or saves a note.",
};
