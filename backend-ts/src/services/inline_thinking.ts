// split inline reasoning out
// of provider text streams. vtx understands the ` thinking … </think>` form;
// this is the provider-agnostic safety net for other tag spellings
// (`<thought>`, `<reasoning>`, `<|begin_of_thought|>`, …), including tags split
// across chunks.

export type SegmentKind = "think" | "text";
export type Segment = [SegmentKind, string];

// Tags whose contents are model scratchpad rather than a user-facing answer.
const REASONING_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "thoughts",
  "reasoning",
  "analysis",
  "reflection",
] as const;

// OpenAI-style special-token form, e.g. `<|begin_of_thought|>…<|end_of_thought|>`.
const SPECIAL_TAGS: string[] = [
  ...REASONING_TAG_NAMES.map((name) => `begin_of_${name}`),
  ...REASONING_TAG_NAMES.map((name) => `begin_${name}`),
];

const OPEN_TAGS: string[] = [
  ...REASONING_TAG_NAMES.map((name) => `<${name}>`),
  ...REASONING_TAG_NAMES.map((name) => `<${name} `), // <thinking duration="3s">
  ...SPECIAL_TAGS.map((name) => `<|${name}|>`),
];

// close tag for each opening tag prefix, plus the general `</name>` form.
const CLOSE_TAGS = new Map<string, string[]>();
for (const name of REASONING_TAG_NAMES) {
  CLOSE_TAGS.set(`<${name}>`, [`</${name}>`]);
  CLOSE_TAGS.set(`<${name} `, [`</${name}>`]);
}
for (const special of SPECIAL_TAGS) {
  const base = special.replace(/^begin_of_/, "").replace(/^begin_/, "");
  CLOSE_TAGS.set(`<|${special}|>`, [`<|end_of_${base}|>`, `<|end_${base}|>`]);
}

function longestPartialTagSuffix(buffer: string, tags: readonly string[]): number {
  /** Length of the longest suffix that could begin one of `tags`. */
  const limit = Math.min(Math.max(...tags.map((t) => t.length), 0) - 1, buffer.length);
  for (let size = limit; size > 0; size--) {
    const tail = buffer.slice(-size);
    if (tags.some((tag) => tag.startsWith(tail))) return size;
  }
  return 0;
}

function findOpenTag(buffer: string): [number, string] | null {
  const lowered = buffer.toLowerCase();
  let best: [number, string] | null = null;
  for (const tag of OPEN_TAGS) {
    const index = lowered.indexOf(tag);
    if (index === -1) continue;
    if (best === null || index < best[0] || (index === best[0] && tag.length > best[1].length)) {
      best = [index, tag];
    }
  }
  return best;
}

function findCloseTag(buffer: string, openTag: string): [number, string] | null {
  const lowered = buffer.toLowerCase();
  let best: [number, string] | null = null;
  for (const tag of CLOSE_TAGS.get(openTag.toLowerCase()) ?? []) {
    const index = lowered.indexOf(tag);
    if (index === -1) continue;
    if (best === null || index < best[0]) best = [index, tag];
  }
  return best;
}

/** Incremental splitter for inline reasoning blocks in a text stream. */
export class InlineThinkingSplitter {
  private buffer = "";
  private thinking = false;
  private openTag = "";

  feed(text: string): Segment[] {
    if (!text) return [];
    this.buffer += text;
    return [...this.drain(false)];
  }

  flush(): Segment[] {
    return [...this.drain(true)];
  }

  private *drain(final: boolean): Generator<Segment> {
    while (this.buffer) {
      if (this.thinking) {
        const found = findCloseTag(this.buffer, this.openTag);
        if (found === null) {
          if (final) {
            yield ["think", this.buffer];
            this.buffer = "";
            break;
          }
          const hold = longestPartialTagSuffix(
            this.buffer,
            CLOSE_TAGS.get(this.openTag.toLowerCase()) ?? [],
          );
          let head: string;
          if (hold) {
            head = this.buffer.slice(0, -hold);
            this.buffer = this.buffer.slice(-hold);
          } else {
            head = this.buffer;
            this.buffer = "";
          }
          if (head) yield ["think", head];
          break;
        }
        const [index, closeTag] = found;
        const head = this.buffer.slice(0, index);
        if (head) yield ["think", head];
        this.buffer = this.buffer.slice(index + closeTag.length);
        this.thinking = false;
        this.openTag = "";
        continue;
      }

      const found = findOpenTag(this.buffer);
      if (found === null) {
        if (final) {
          if (this.buffer) {
            yield ["text", this.buffer];
            this.buffer = "";
          }
          break;
        }
        const hold = longestPartialTagSuffix(this.buffer, OPEN_TAGS);
        let head: string;
        if (hold) {
          head = this.buffer.slice(0, -hold);
          this.buffer = this.buffer.slice(-hold);
        } else {
          head = this.buffer;
          this.buffer = "";
        }
        if (head) yield ["text", head];
        break;
      }

      const [index, openTag] = found;
      const head = this.buffer.slice(0, index);
      if (head) yield ["text", head];
      this.buffer = this.buffer.slice(index + openTag.length);
      this.thinking = true;
      this.openTag = openTag;
    }
  }
}

/** Split a complete string into text / reasoning segments. */
export function splitInlineReasoning(text: string): Segment[] {
  if (!text) return [];
  const splitter = new InlineThinkingSplitter();
  return [...splitter.feed(text), ...splitter.flush()];
}

/** Return only the user-facing text of `text` with reasoning removed. */
export function stripInlineReasoning(text: string): string {
  return splitInlineReasoning(text)
    .filter(([kind]) => kind === "text")
    .map(([, piece]) => piece)
    .join("")
    .trim();
}
