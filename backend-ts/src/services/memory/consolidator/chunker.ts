// char-based
// chunking with boundary expansion. Pure functions.

export type Boundary = "paragraph" | "sentence";

const PARA_BOUNDARY = /\n\s*\n+/g;
const SENT_BOUNDARY = /[.!?][")\]]*(?=\s|$)/g;

export interface ChunkSpan {
  index: number;
  start: number;
  end: number;
  text: string;
}

export function chunk_with_boundary(
  text: string,
  opts: {
    budget: number;
    overlap_ratio: number;
    min_chunk_chars: number;
    max_chunk_chars: number;
    boundary?: Boundary;
  },
): ChunkSpan[] {
  const boundary = opts.boundary ?? "paragraph";
  if (!text.trim()) return [];
  let budget = opts.budget;
  if (budget < 1) budget = 1;

  const n = text.length;
  const span = Math.max(1, budget - (budget - 1) * opts.overlap_ratio);
  let target = Math.ceil(n / span);
  target = Math.max(opts.min_chunk_chars, Math.min(opts.max_chunk_chars, target));
  const overlap = Math.max(0, Math.min(target - 1, Math.round(target * opts.overlap_ratio)));

  if (n <= target) return [{ index: 0, start: 0, end: n, text }];

  const spans: ChunkSpan[] = [];
  let cursor = 0;
  while (cursor < n) {
    const targetEnd = Math.min(n, cursor + target);
    const hardCap = Math.min(n, cursor + opts.max_chunk_chars);
    let end: number;
    if (targetEnd >= n) {
      end = n;
    } else {
      end = expandToBoundary(text, targetEnd, boundary, hardCap);
    }
    if (end <= cursor) end = Math.min(n, cursor + Math.max(1, target));
    spans.push({ index: spans.length, start: cursor, end, text: text.slice(cursor, end) });
    if (end >= n) break;
    let nextCursor = end - overlap;
    if (nextCursor <= cursor) nextCursor = cursor + 1;
    cursor = nextCursor;
  }
  return spans;
}

function expandToBoundary(
  text: string,
  targetEnd: number,
  boundary: Boundary,
  limit: number,
): number {
  const re = boundary === "paragraph" ? PARA_BOUNDARY : SENT_BOUNDARY;
  re.lastIndex = targetEnd;
  const slice = text.slice(targetEnd, limit);
  const m = re.exec(slice);
  if (m === null || m.index === undefined) return limit;
  return targetEnd + m.index + m[0].length;
}
