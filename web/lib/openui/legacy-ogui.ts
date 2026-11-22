/**
 * Reading the retired `ogui-*` generative-UI wire format.
 *
 * Before the tutor prompt asked for OpenUI Lang, a demo reply was a bundle of
 * fenced blocks the chat sandboxed into a widget:
 *
 *     ```ogui-meta   {"initialHeight": 1180, "placeholderMessages": [...]}
 *     ```ogui-css    .tw { display: flex; ... }
 *     ```ogui-html   <div class="tw">...</div>
 *     ```ogui-js     var TRIP = {...}; function initTrip() {...}
 *     ```ogui-expr   initTrip();
 *
 * That renderer was removed with the format, so every stored conversation from
 * that period now draws its JSON, CSS, HTML and JavaScript as fenced code:
 * a wall of source where the reader was promised a map, a quiz or a slider.
 *
 * Nothing here regenerates those turns — it only reassembles what the model
 * already wrote into the document it was describing, so the widget a stored
 * reply carries can be shown again instead of its source. `ogui-expr` blocks
 * are collected too: they are the calls that start the widget up (a listener
 * binding, `initTrip()`), which is why a document without them renders a
 * correct-looking but dead page.
 */

/** A fenced `ogui-<name>` block. Only the known family is recognised so an
 *  ordinary markdown fence in prose is never mistaken for wire format. */
const FENCE =
  /```(ogui-(?:meta|css|html|js|expr))[ \t]*\r?\n([\s\S]*?)```/gi;

/** Cheap test for the dispatch in ChatMessageList — no parsing, no allocation. */
export function hasLegacyOgui(content: string | null | undefined): boolean {
  if (!content) return false;
  const match = /```ogui-(?:meta|css|html|js|expr)\b/i.exec(content);
  if (!match) return false;
  // A widget needs markup; a stray fence mention in prose is not one.
  return /```ogui-html\b/i.test(content);
}

export type LegacyOguiMeta = {
  /** The height the widget asked for before anything is measured. */
  initialHeight?: number;
  placeholderMessages?: string[];
};

export type LegacyOguiWidget = {
  meta: LegacyOguiMeta;
  css: string;
  html: string;
  /** `ogui-js` sources, concatenated in the order the reply wrote them. */
  js: string;
  /** `ogui-expr` statements, run after `js` because they call into it. */
  expr: string;
};

export type LegacyOguiPart =
  | { kind: "text"; text: string }
  | { kind: "widget"; widget: LegacyOguiWidget };

function parseMeta(source: string): LegacyOguiMeta {
  const trimmed = source.trim();
  if (!trimmed) return {};
  try {
    const value: unknown = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const record = value as Record<string, unknown>;
    const height = record.initialHeight;
    const placeholders = record.placeholderMessages;
    return {
      initialHeight:
        typeof height === "number" && Number.isFinite(height) && height > 0
          ? height
          : undefined,
      placeholderMessages: Array.isArray(placeholders)
        ? placeholders.filter((item): item is string => typeof item === "string")
        : undefined,
    };
  } catch {
    return {};
  }
}

function isBlank(source: string): boolean {
  return source.trim().length === 0;
}

function emptyWidget(): LegacyOguiWidget {
  return { meta: {}, css: "", html: "", js: "", expr: "" };
}

/**
 * Split a stored reply into the prose it wrote and the widgets it built.
 *
 * Blocks are grouped: fences that sit next to each other (only whitespace
 * between them) describe one widget, while a paragraph in between belongs to
 * the message and starts a new group. A group with no markup is dropped rather
 * than rendered as an empty frame.
 */
export function parseLegacyOgui(
  content: string | null | undefined,
): LegacyOguiPart[] {
  const source = String(content ?? "");
  const parts: LegacyOguiPart[] = [];
  if (!hasLegacyOgui(source)) return parts;

  FENCE.lastIndex = 0;
  let cursor = 0;
  let current: LegacyOguiWidget | null = null;
  const pushText = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) parts.push({ kind: "text", text: trimmed });
  };

  const flushWidget = () => {
    if (!current) return;
    if (current.html.trim()) parts.push({ kind: "widget", widget: current });
    else if (current.css.trim() || current.js.trim()) {
      // CSS or script with no markup is a fragment, not a widget: hand it back
      // as source so nothing silently disappears from the transcript.
      const fragments = [
        current.css && `\`\`\`css\n${current.css.trim()}\n\`\`\``,
        current.js && `\`\`\`javascript\n${current.js.trim()}\n\`\`\``,
      ].filter(Boolean);
      if (fragments.length) {
        parts.push({ kind: "text", text: fragments.join("\n\n") });
      }
    }
    current = null;
  };

  let match: RegExpExecArray | null;
  while ((match = FENCE.exec(source)) !== null) {
    const between = source.slice(cursor, match.index);
    if (!isBlank(between)) {
      // Prose sits between two fences, so the widget the last fence belonged to
      // is complete and this paragraph follows it in the reply.
      flushWidget();
      pushText(between);
    }
    cursor = match.index + match[0].length;

    const name = match[1].slice("ogui-".length).toLowerCase();
    const body = match[2] ?? "";
    if (!current) current = emptyWidget();
    if (name === "meta") current.meta = parseMeta(body);
    else if (name === "css") current.css = current.css ? `${current.css}\n${body}` : body;
    else if (name === "html") current.html = current.html ? `${current.html}\n${body}` : body;
    else if (name === "js") current.js = current.js ? `${current.js}\n${body}` : body;
    else if (name === "expr") current.expr = current.expr ? `${current.expr}\n${body}` : body;
  }

  flushWidget();
  pushText(source.slice(cursor));

  return parts;
}

/** The reply's prose, with every widget bundle removed. */
export function stripLegacyOgui(content: string | null | undefined): string {
  return parseLegacyOgui(content)
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text)
    .join("\n\n");
}

// ─── The document the widget runs in ────────────────────────────────

/**
 * Palette the retired renderer gave generated markup.
 *
 * The replies were written against these token names (`var(--color-text-primary,
 * #1b1b1f)` and friends) and they are not part of the app's own token set, so a
 * document without them falls back to the hard-coded light values inside the
 * widget's CSS and a dark chat shows a glaring white panel.
 */
const LIGHT_TOKENS = `
  --color-background-primary: #ffffff;
  --color-background-secondary: #f7f6f3;
  --color-background-tertiary: #efeee9;
  --color-background-info: #e6f1fb;
  --color-background-danger: #fcebeb;
  --color-background-success: #eaf3de;
  --color-background-warning: #faeeda;
  --color-text-primary: #1a1a1a;
  --color-text-secondary: #73726c;
  --color-text-tertiary: #9c9a92;
  --color-text-info: #185fa5;
  --color-text-danger: #a32d2d;
  --color-text-success: #3b6d11;
  --color-text-warning: #854f0b;
  --color-border-primary: rgba(0, 0, 0, 0.4);
  --color-border-secondary: rgba(0, 0, 0, 0.3);
  --color-border-tertiary: rgba(0, 0, 0, 0.15);
  --color-danger: #a32d2d;
  --color-danger-background: #fcebeb;
  --color-danger-text: #a32d2d;
  --color-success: #3b6d11;
  --color-success-background: #eaf3de;
  --color-success-text: #3b6d11;
  --color-warning-background: #faeeda;
  --color-warning-text: #854f0b;
  --color-info: #185fa5;
`;

const DARK_TOKENS = `
  --color-background-primary: #1a1a18;
  --color-background-secondary: #2c2c2a;
  --color-background-tertiary: #222220;
  --color-background-info: #0c447c;
  --color-background-danger: #501313;
  --color-background-success: #173404;
  --color-background-warning: #412402;
  --color-text-primary: #e8e6de;
  --color-text-secondary: #9c9a92;
  --color-text-tertiary: #73726c;
  --color-text-info: #85b7eb;
  --color-text-danger: #f09595;
  --color-text-success: #97c459;
  --color-text-warning: #ef9f27;
  --color-border-primary: rgba(255, 255, 255, 0.4);
  --color-border-secondary: rgba(255, 255, 255, 0.3);
  --color-border-tertiary: rgba(255, 255, 255, 0.15);
  --color-danger: #f09595;
  --color-danger-background: #501313;
  --color-danger-text: #f09595;
  --color-success: #97c459;
  --color-success-background: #173404;
  --color-success-text: #97c459;
  --color-warning-background: #412402;
  --color-warning-text: #ef9f27;
  --color-info: #85b7eb;
`;

/** Shared tokens: type and radii, identical in both palettes. */
const BASE_TOKENS = `
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-serif: Georgia, "Times New Roman", serif;
  --font-mono: "SF Mono", "Fira Code", "Fira Mono", monospace;
  --border-radius-sm: 6px;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-radius-xl: 16px;
  --p: var(--color-text-primary);
  --s: var(--color-text-secondary);
  --t: var(--color-text-tertiary);
  --bg2: var(--color-background-secondary);
  --b: var(--color-border-tertiary);
  /* Alias the generated CSS also reaches for. */
  --color-border: var(--color-border-tertiary);
`;

/** Bare specifiers the generated scripts import when they need a library. */
const IMPORT_MAP = `<script type="importmap">
{
  "imports": {
    "three": "https://esm.sh/three",
    "three/": "https://esm.sh/three/",
    "gsap": "https://esm.sh/gsap",
    "gsap/": "https://esm.sh/gsap/",
    "d3": "https://esm.sh/d3",
    "d3/": "https://esm.sh/d3/",
    "chart.js": "https://esm.sh/chart.js",
    "chart.js/": "https://esm.sh/chart.js/"
  }
}
</script>`;

/** Body reset: the widget lays out the whole canvas and must not be clipped. */
const RESET_CSS = `
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: var(--font-sans); color: var(--color-text-primary); }
  .ogui-failed { margin: 12px; padding: 10px 12px; border-radius: 8px;
    background: var(--color-background-danger); color: var(--color-text-danger);
    font: 500 12px/1.5 var(--font-sans); }
`;

/**
 * Reports a missing widget instead of leaving an empty frame.
 *
 * Generated scripts fail in ways that leave a half-drawn page (a CDN blocked,
 * a typo on the first line, an element the markup does not have), and a blank
 * canvas reads as "this reply had nothing in it" rather than "this reply broke".
 */
const ERROR_BRIDGE = `
(function () {
  function fail(message) {
    if (document.querySelector(".ogui-failed")) return;
    var note = document.createElement("div");
    note.className = "ogui-failed";
    note.textContent = "This interactive demo could not start: " + message;
    document.body.appendChild(note);
    report();
  }
  window.__oguiFail = fail;
  window.addEventListener("error", function (event) {
    fail((event && event.message) || "script error");
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    fail((reason && (reason.message || String(reason))) || "unhandled rejection");
  });
  // Tell the host how tall the widget actually is, so it never scrolls inside
  // a clipped frame or floats in one three times too tall.
  function report() {
    try {
      parent.postMessage(
        { type: "ogui:height", height: Math.ceil(document.body.scrollHeight) },
        "*",
      );
    } catch (error) {
      /* the host went away */
    }
  }
  window.__oguiReport = report;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(report).observe(document.body);
  }
  window.addEventListener("load", report);
  window.addEventListener("resize", report);
  // Images and tiles arrive after load; keep measuring for the first second.
  [150, 400, 900, 1600, 2600].forEach(function (delay) {
    setTimeout(report, delay);
  });
})();
`;

export type LegacyOguiColorScheme = "light" | "dark";

/**
 * The sandboxed document for one widget: its markup, its styles, its script,
 * the startup calls that script expects, and the palette it was written for.
 */
export function buildLegacyOguiDocument(
  widget: LegacyOguiWidget,
  scheme: LegacyOguiColorScheme = "light",
): string {
  const tokens = scheme === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
  const css = widget.css.trim();
  // `js` defines the widget; `expr` runs it. One script keeps a `const` in the
  // first visible to the second, which separate <script> tags would not for
  // top-level `let`/`const` declared in a module-free document.
  const script = [widget.js.trim(), widget.expr.trim()].filter(Boolean).join("\n;\n");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${IMPORT_MAP}
<style>:root {${tokens}${BASE_TOKENS}}</style>
<style>${RESET_CSS}</style>
${css ? `<style>${css}</style>` : ""}
</head>
<body>
${widget.html.trim()}
${script ? `<script>\n${ERROR_BRIDGE}\ntry {\n${script}\n} catch (error) { window.__oguiFail(error && error.message ? error.message : String(error)); }\n</script>` : `<script>${ERROR_BRIDGE}</script>`}
</body>
</html>`;
}

/** The first height to give a widget before it has measured itself. */
export function legacyOguiInitialHeight(widget: LegacyOguiWidget): number {
  const asked = widget.meta.initialHeight;
  if (asked && Number.isFinite(asked)) return Math.min(2400, Math.max(240, Math.ceil(asked)));
  return 480;
}
