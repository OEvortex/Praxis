// evaluation-only raw-
// history dense retrieval + optional cross-encoder reranking. Embedder and
// reranker are injected; importing never loads a model SDK.
import type { CaseInput } from "./evaluation.js";
import type { AdapterResult, Evidence } from "./evaluation.js";
import type { Dict } from "../../shared/types.js";

export type Embedder = (texts: string[]) => number[][];
export type Reranker = (query: string, texts: string[]) => number[];

export interface RetrievalConfig {
  window_chars: number;
  overlap_chars: number;
  candidates: number;
  top_k: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  window_chars: 600,
  overlap_chars: 150,
  candidates: 128,
  top_k: 15,
};

function validateConfig(config: RetrievalConfig): void {
  const values = [config.window_chars, config.overlap_chars, config.candidates, config.top_k];
  if (values.some((v) => !Number.isInteger(v))) {
    throw new Error("retrieval sizes must be integers");
  }
  if (config.window_chars < 1 || config.overlap_chars < 0 || config.overlap_chars >= config.window_chars) {
    throw new Error("require 0 <= overlap_chars < window_chars");
  }
  if (config.top_k < 1 || config.top_k > config.candidates) {
    throw new Error("require 1 <= top_k <= candidates");
  }
}

function vectors(values: number[][], count: number): number[][] {
  const out = values.map((v) => v.map(Number));
  if (out.length !== count || !out.length || !out[0].length) {
    throw new Error("embedding count/dimensions do not match the inputs");
  }
  const width = out[0].length;
  return out.map((vector) => {
    if (vector.length !== width || vector.some((v) => !Number.isFinite(v))) {
      throw new Error("embeddings must have equal dimensions and finite values");
    }
    const norm = Math.hypot(...vector);
    if (norm === 0 || !Number.isFinite(norm)) {
      throw new Error("embeddings must have finite nonzero norms");
    }
    return vector.map((v) => v / norm);
  });
}

export class RawHistoryRAG {
  constructor(
    private embedFn: Embedder,
    private rerankFn: Reranker | null = null,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
    private modelInfo: Dict = {},
  ) {
    validateConfig(config);
  }

  async call(context: CaseInput): Promise<AdapterResult> {
    // Embedding is synchronous CPU work in the injected embedder; keep the
    // async signature for adapter parity.
    return this.retrieve(context);
  }

  private retrieve(context: CaseInput): AdapterResult {
    const config = this.config;
    const windows: Evidence[] = [];
    const sources: Record<string, string> = {};
    context.history.forEach((item, index) => {
      for (let start = 0; start < item.text.length; ) {
        const end = Math.min(start + config.window_chars, item.text.length);
        const identifier = `raw:${index}:${start}:${end}`;
        windows.push({
          identifier,
          text: `${item.timestamp} ${item.text.slice(start, end)}`,
        });
        sources[identifier] = item.identifier;
        if (end === item.text.length) break;
        start = end - config.overlap_chars;
      }
    });

    const metadata: Dict = {
      window_chars: config.window_chars,
      overlap_chars: config.overlap_chars,
      candidate_limit: config.candidates,
      top_k: config.top_k,
      window_count: windows.length,
      reranker_executed: false,
      model_info: { ...this.modelInfo },
      corpus_embedding_seconds: 0,
      query_embedding_seconds: 0,
      rerank_seconds: 0,
      index_scope: "rebuilt from visible history for each case and adapter",
    };
    if (!windows.length) {
      return { evidence: [], original_source_ids: true, source_ids: sources, metadata };
    }

    let t0 = performance.now();
    const corpus = this.embedFn(windows.map((w) => w.text));
    metadata["corpus_embedding_seconds"] = (performance.now() - t0) / 1000;
    t0 = performance.now();
    const query = this.embedFn([context.query]);
    metadata["query_embedding_seconds"] = (performance.now() - t0) / 1000;

    const corpusVectors = vectors(corpus, windows.length);
    const queryVector = vectors(query, 1)[0];
    if (queryVector.length !== corpusVectors[0].length) {
      throw new Error("query and corpus embedding dimensions differ");
    }
    const scores = corpusVectors.map((vector) =>
      vector.reduce((acc, v, i) => acc + v * queryVector[i], 0),
    );
    const indices = scores
      .map((s, i) => ({ s, i }))
      .sort((a, b) => b.s - a.s || b.i - a.i)
      .map(({ i }) => i);
    let candidates = indices.slice(0, config.candidates);
    metadata["dense_candidates"] = candidates.map((i) => ({
      id: windows[i].identifier,
      score: scores[i],
    }));

    if (this.rerankFn) {
      t0 = performance.now();
      const rerankScores = this.rerankFn(
        context.query,
        candidates.map((i) => windows[i].text),
      ).map(Number);
      metadata["rerank_seconds"] = (performance.now() - t0) / 1000;
      if (rerankScores.length !== candidates.length || rerankScores.some((v) => !Number.isFinite(v))) {
        throw new Error("reranker must return one finite score per candidate");
      }
      metadata["reranker_executed"] = true;
      metadata["rerank_scores"] = rerankScores;
      const order = rerankScores
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s - a.s)
        .map(({ i }) => i);
      candidates = order.map((i) => candidates[i]);
    }

    const selected = candidates.slice(0, config.top_k);
    return {
      evidence: selected.map((i) => windows[i]),
      original_source_ids: true,
      source_ids: sources,
      metadata,
    };
  }
}
