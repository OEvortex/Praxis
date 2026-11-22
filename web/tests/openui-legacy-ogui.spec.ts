import { describe, expect, it } from "vitest";
import {
  buildLegacyOguiDocument,
  hasLegacyOgui,
  legacyOguiInitialHeight,
  parseLegacyOgui,
  stripLegacyOgui,
} from "@/lib/openui/legacy-ogui";
import { previewProse } from "@/lib/openui/preview-text";

const BUNDLE = `Here's the live map.

\`\`\`ogui-meta
{"initialHeight": 1180, "placeholderMessages": ["Loading tiles..."]}
\`\`\`

\`\`\`ogui-css
.tw-map { height: 420px; }
\`\`\`

\`\`\`ogui-html
<div class="tw"><div id="trip-map"></div></div>
\`\`\`

\`\`\`ogui-js
var TRIP = { stops: [] };
function initTrip() { draw(); }
\`\`\`

\`\`\`ogui-expr
initTrip();
\`\`\`

The dashed line is a sketch, not a routing.`;

describe("legacy ogui wire format", () => {
  it("recognises a stored widget bundle", () => {
    expect(hasLegacyOgui(BUNDLE)).toBe(true);
    // A plain markdown answer is not one.
    expect(hasLegacyOgui("Just prose, and a ```js fenced``` sample.")).toBe(false);
    // Fence names alone are not a widget: there is no markup to render.
    expect(hasLegacyOgui("```ogui-css\n.a { color: red }\n```")).toBe(false);
  });

  it("groups the fences into one widget and keeps the prose in order", () => {
    const parts = parseLegacyOgui(BUNDLE);
    expect(parts.map((part) => part.kind)).toEqual(["text", "widget", "text"]);
    const widget = parts[1].kind === "widget" ? parts[1].widget : null;
    expect(widget).not.toBeNull();
    expect(widget!.html).toContain('id="trip-map"');
    expect(widget!.css).toContain(".tw-map");
    expect(widget!.meta.initialHeight).toBe(1180);
    expect(widget!.expr).toContain("initTrip()");
    if (parts[0].kind === "text") expect(parts[0].text).toContain("Here's the live map.");
    if (parts[2].kind === "text") expect(parts[2].text).toContain("not a routing");
  });

  it("splits two widgets separated by prose", () => {
    const two = `${BUNDLE}\n\nAnd a second one.\n\n\`\`\`ogui-html\n<div id="b"></div>\n\`\`\``;
    const parts = parseLegacyOgui(two);
    expect(parts.filter((part) => part.kind === "widget")).toHaveLength(2);
  });

  it("drops the bundle from the prose", () => {
    const prose = stripLegacyOgui(BUNDLE);
    expect(prose).toContain("Here's the live map.");
    expect(prose).toContain("not a routing");
    expect(prose).not.toContain("ogui-");
    expect(prose).not.toContain("trip-map");
  });

  it("builds a document that runs the script, then the startup calls", () => {
    const widget = parseLegacyOgui(BUNDLE).find((part) => part.kind === "widget");
    const doc = buildLegacyOguiDocument(
      widget!.kind === "widget" ? widget!.widget : ({} as never),
      "light",
    );
    expect(doc).toContain('<div class="tw"><div id="trip-map"></div></div>');
    expect(doc).toContain(".tw-map { height: 420px; }");
    // The script and the calls that start it share one script tag, in order.
    const script = doc.slice(doc.lastIndexOf("<script>"));
    expect(script).toContain("function initTrip()");
    expect(script.indexOf("function initTrip()")).toBeLessThan(
      script.indexOf("initTrip();\n}"),
    );
    // Palette the widget was written against.
    expect(doc).toContain("--color-text-primary");
    expect(doc).toContain("--color-background-secondary");
  });

  it("uses the dark palette for a dark chat", () => {
    const widget = parseLegacyOgui(BUNDLE).find((part) => part.kind === "widget");
    const doc = buildLegacyOguiDocument(
      widget!.kind === "widget" ? widget!.widget : ({} as never),
      "dark",
    );
    expect(doc).toContain("--color-background-primary: #1a1a18");
  });

  it("falls back to a sane height and clamps a wild one", () => {
    const base = { meta: {}, css: "", html: "<p/>", js: "", expr: "" };
    expect(legacyOguiInitialHeight(base)).toBe(480);
    expect(legacyOguiInitialHeight({ ...base, meta: { initialHeight: 30 } })).toBe(240);
    expect(legacyOguiInitialHeight({ ...base, meta: { initialHeight: 9000 } })).toBe(2400);
  });
});

describe("previewProse", () => {
  it("shows a legacy reply as its prose", () => {
    const text = previewProse(BUNDLE);
    expect(text).toContain("Here's the live map.");
    expect(text).not.toContain("ogui-");
    expect(text).not.toContain("initialHeight");
  });

  it("shows an OpenUI Lang reply as its introduction", () => {
    const text = previewProse(
      'Here is the dashboard.\n\nroot = Col([head])\nhead = Title("Growth", "xl")',
    );
    expect(text).toBe("Here is the dashboard.");
  });

  it("removes a fenced program", () => {
    const text = previewProse('Let us build it.\n\n```openui-lang\nroot = Text("hi")\n```');
    expect(text).toBe("Let us build it.");
  });

  it("returns nothing for a reply made only of a program", () => {
    expect(previewProse('root = Col([head])\nhead = Title("Growth", "xl")')).toBe("");
  });

  it("leaves ordinary prose alone", () => {
    expect(previewProse("The gradient points uphill.")).toBe(
      "The gradient points uphill.",
    );
  });
});
