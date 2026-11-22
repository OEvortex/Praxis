// render a compiled book as one Markdown doc.
import type { Block, Book, Page, Spine } from "./models.js";

const SAFE_FILENAME = /[^\w.-]+/g;

const LABELS = {
  takeaway: "Key takeaway",
  answer: "Answer",
  front: "Front",
  back: "Back",
  sources: "Sources",
  chapters: "Chapters",
  note: "Note",
  untitled_book: "Untitled book",
  untitled_chapter: "Untitled chapter",
  not_generated: "(This chapter has not been generated yet.)",
  omitted: "({kind} omitted — it has no text representation.)",
};

export function export_filename(book: Book): string {
  const stem = (book.title || "book").trim().replace(SAFE_FILENAME, "-").replace(/^-+|-+$/g, "");
  return `${stem || "book"}.md`;
}

function payloadText(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function renderSection(payload: Record<string, unknown>, labels_: Record<string, string>): string {
  const parts: string[] = [];
  const intro = payloadText(payload, "intro");
  if (intro) parts.push(intro);

  const subsections = payload["subsections"];
  if (Array.isArray(subsections) && subsections.length) {
    for (const sub of subsections) {
      if (sub === null || typeof sub !== "object" || Array.isArray(sub)) continue;
      const s = sub as Record<string, unknown>;
      const heading = payloadText(s, "heading");
      const body = payloadText(s, "body");
      if (heading) parts.push(`### ${heading}`);
      if (body) parts.push(body);
    }
  }

  const body = payloadText(payload, "body");
  if (body && !subsections) parts.push(body);

  const takeaway = payloadText(payload, "key_takeaway");
  if (takeaway) parts.push(`> **${labels_["takeaway"]}** — ${takeaway}`);
  return parts.join("\n\n");
}

function renderQuiz(payload: Record<string, unknown>, labels_: Record<string, string>): string {
  const questions = payload["questions"];
  if (!Array.isArray(questions) || !questions.length) return "";
  const parts: string[] = [];
  let index = 0;
  for (const question of questions) {
    if (question === null || typeof question !== "object" || Array.isArray(question)) continue;
    index += 1;
    const q = question as Record<string, unknown>;
    parts.push(`**${index}. ${payloadText(q, "question")}**`);
    const options = q["options"];
    if (options !== null && typeof options === "object" && !Array.isArray(options)) {
      const entries = Object.entries(options as Record<string, unknown>);
      if (entries.length) {
        parts.push(
          entries
            .map(([key, value]) => `- **${key.toUpperCase()}.** ${String(value)}`)
            .join("\n"),
        );
      }
    }
    const answer = payloadText(q, "correct_answer");
    if (answer) {
      parts.push(
        `<details><summary>${labels_["answer"]}</summary>\n\n${answer}\n\n</details>`,
      );
    }
    const explanation = payloadText(q, "explanation");
    if (explanation) parts.push(`_${explanation}_`);
  }
  return parts.join("\n\n");
}

function renderFlashCards(payload: Record<string, unknown>, labels_: Record<string, string>): string {
  const cards = payload["cards"];
  if (!Array.isArray(cards) || !cards.length) return "";
  const rows = [`| ${labels_["front"]} | ${labels_["back"]} |`, "| --- | --- |"];
  for (const card of cards) {
    if (card === null || typeof card !== "object" || Array.isArray(card)) continue;
    const c = card as Record<string, unknown>;
    const front = payloadText(c, "front").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    const back = payloadText(c, "back").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
    rows.push(`| ${front} | ${back} |`);
  }
  return rows.length > 2 ? rows.join("\n") : "";
}

function renderTimeline(payload: Record<string, unknown>): string {
  const events = payload["events"];
  if (!Array.isArray(events) || !events.length) return "";
  const lines: string[] = [];
  for (const event of events) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) continue;
    const e = event as Record<string, unknown>;
    const date = payloadText(e, "date");
    const title = payloadText(e, "title");
    const description = payloadText(e, "description");
    const head = [date, title].filter(Boolean).join(" — ");
    lines.push(`- **${head}**` + (description ? `  \n  ${description}` : ""));
  }
  return lines.join("\n");
}

function renderCode(payload: Record<string, unknown>): string {
  const code = payloadText(payload, "code");
  if (!code) return "";
  const language = payloadText(payload, "language");
  const parts = [`\`\`\`${language}\n${code}\n\`\`\``];
  const explanation = payloadText(payload, "explanation");
  if (explanation) parts.push(explanation);
  return parts.join("\n\n");
}

function renderVisual(payload: Record<string, unknown>, kind: string, labels_: Record<string, string>): string {
  const parts: string[] = [];
  const description = payloadText(payload, "description", "summary");
  if (description) parts.push(description);

  const code = payload["code"];
  if (code !== null && typeof code === "object" && !Array.isArray(code)) {
    const content = payloadText(code as Record<string, unknown>, "content");
    const language = payloadText(code as Record<string, unknown>, "language");
    if (content) parts.push(`\`\`\`${language}\n${content}\n\`\`\``);
  } else if (payloadText(payload, "mermaid")) {
    parts.push(`\`\`\`mermaid\n${payloadText(payload, "mermaid")}\n\`\`\``);
  }

  const video = payloadText(payload, "video_url");
  if (video) parts.push(`[▶ ${kind}](${video})`);

  if (!parts.length) parts.push(`_${labels_["omitted"].replace("{kind}", kind)}_`);
  return parts.join("\n\n");
}

function renderDeepDive(payload: Record<string, unknown>): string {
  const suggestions = payload["suggestions"];
  if (!Array.isArray(suggestions)) return "";
  const lines: string[] = [];
  for (const item of suggestions) {
    if (typeof item === "string" && item.trim()) {
      lines.push(`- ${item.trim()}`);
    } else if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const s = item as Record<string, unknown>;
      const topic = payloadText(s, "topic");
      const rationale = payloadText(s, "rationale");
      if (!topic) continue;
      lines.push(`- **${topic}**` + (rationale ? ` — ${rationale}` : ""));
    }
  }
  return lines.join("\n");
}

export function render_block(block: Block): string {
  if (block.status !== "ready") return "";
  const payload = block.payload ?? {};
  const labels_ = LABELS;
  const bridge = payloadText(payload, "bridge_text");

  let body = "";
  if (block.type === "text" || block.type === "user_note") {
    body = payloadText(payload, "body", "content");
  } else if (block.type === "section") {
    body = renderSection(payload, labels_);
  } else if (block.type === "callout") {
    const label = payloadText(payload, "label");
    const text = payloadText(payload, "body");
    body = text ? `> **${label || labels_["note"]}** — ${text}` : "";
  } else if (block.type === "quiz") {
    body = renderQuiz(payload, labels_);
  } else if (block.type === "flash_cards") {
    body = renderFlashCards(payload, labels_);
  } else if (block.type === "timeline") {
    body = renderTimeline(payload);
  } else if (block.type === "code") {
    body = renderCode(payload);
  } else if (block.type === "figure" || block.type === "concept_graph") {
    body = renderVisual(payload, "figure", labels_);
  } else if (block.type === "interactive") {
    body = renderVisual(payload, "interactive widget", labels_);
  } else if (block.type === "animation") {
    body = renderVisual(payload, "animation", labels_);
  } else if (block.type === "deep_dive") {
    body = renderDeepDive(payload);
  } else {
    body = payloadText(payload, "body", "content");
  }

  if (!body) return "";
  const parts: string[] = [];
  if (bridge) parts.push(bridge);
  if (block.title && block.type !== "text" && block.type !== "section") {
    parts.push(`#### ${block.title}`);
  }
  parts.push(body);
  return parts.join("\n\n");
}

export function render_book_markdown(book: Book, spine: Spine | null, pages: Page[]): string {
  const labels_ = LABELS;
  const out: string[] = [`# ${book.title || labels_["untitled_book"]}`];

  if (book.description) out.push(`*${book.description}*`);

  const meta: string[] = [];
  if (book.knowledge_bases?.length) {
    meta.push(`**${labels_["sources"]}:** ${book.knowledge_bases.join(", ")}`);
  }
  if (spine && spine.chapters?.length) {
    meta.push(`**${labels_["chapters"]}:** ${spine.chapters.length}`);
  }
  if (meta.length) out.push(meta.join(" · "));

  out.push("---");

  const sorted = [...pages].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.created_at ?? 0) - (b.created_at ?? 0),
  );
  for (const page of sorted) {
    out.push(`## ${page.title || labels_["untitled_chapter"]}`);
    if (page.learning_objectives?.length) {
      out.push(page.learning_objectives.map((o) => `- ${o}`).join("\n"));
    }
    const rendered = (page.blocks ?? []).map((b) => render_block(b));
    const body = rendered.filter(Boolean);
    if (body.length) out.push(...body);
    else out.push(`_${labels_["not_generated"]}_`);
  }

  return out.join("\n\n").replace(/\s+$/, "") + "\n";
}
