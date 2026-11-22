// NoteUI Lang: DSL -> BlockNote blocks,
// fences, and Markdown round-trips.
import { describe, expect, it } from "vitest";
import {
  blocks_to_markdown,
  coarse_markdown_to_blocks,
  safe_link,
  validate_blocks,
} from "../src/services/documents/blocks.js";
import {
  NoteUIError,
  blocks_to_dsl,
  compile_noteui,
} from "../src/services/documents/noteui.js";

function types(blocks: any[]): string[] {
  return blocks.map((b) => b.type);
}

describe("compile_noteui", () => {
  it("compiles a basic program", () => {
    const blocks = compile_noteui(`
        $name = "Ada"
        Page([
          Heading(1, "Notes on " + $name),
          Text("**Bold** and $x^2$ math."),
          Callout("warning", "Careful"),
        ])
        `);
    expect(types(blocks)).toEqual(["heading", "paragraph", "callout"]);
    expect(blocks[0].props.level).toBe(1);
    expect(
      blocks[1].content.some((i: any) => i.styles?.bold),
    ).toBe(true);
    expect(blocks[1].content.some((i: any) => i.type === "math")).toBe(true);
    expect(blocks[2].props.tone).toBe("warning");
  });

  it("compiles nested children and columns", () => {
    const blocks = compile_noteui(
      'Columns([Column([Bullet("a"), Bullet("b", [Bullet("nested")])]), Column([Text("r")])])',
    );
    expect(types(blocks)).toEqual(["noteColumns"]);
    const cols = blocks[0].children;
    expect(cols.map((c: any) => c.type)).toEqual(["noteColumn", "noteColumn"]);
    const nested = cols[0].children[1].children;
    expect(nested[0].type).toBe("bulletListItem");
  });

  it("compiles learning components", () => {
    const blocks = compile_noteui(
      'Quiz({questions: [{question: "2+2?", options: {A: "3", B: "4"}, correct_answer: "B"}]})\n' +
        'Flashcards({cards: [{front: "f", back: "b"}]})\n' +
        "Mermaid(`graph TD; A-->B`)",
    );
    expect(types(blocks)).toEqual(["learning", "learning", "learning"]);
    const quiz = JSON.parse(blocks[0].props.data);
    expect(quiz.questions[0].correct_answer).toBe("B");
    expect(blocks[2].props.kind).toBe("mermaid");
    expect(blocks[2].props.markdown).toContain("graph TD");
  });

  it("evaluates functions and expressions", () => {
    const blocks = compile_noteui(
      'Text(@Plural(3, "guest") + " -> " + @Format(1234.5, "currency") + " " + @Upper("ok"))',
    );
    const text = blocks[0].content.map((i: any) => i.text ?? "").join("");
    expect(text).toContain("3 guests");
    expect(text).toContain("$1,234.50");
    expect(text).toContain("OK");
  });

  it("expands @Each components", () => {
    const blocks = compile_noteui(
      '$items = [{name: "a"}, {name: "b"}]\n' +
        'Page([@Each($items, "i", Bullet(i.name))])',
    );
    expect(types(blocks)).toEqual(["bulletListItem", "bulletListItem"]);
    expect(blocks[0].content[0].text).toBe("a");
  });

  it("raises NoteUIError on bad programs", () => {
    expect(() => compile_noteui("Bogus(1)")).toThrow(NoteUIError);
    expect(() => compile_noteui("Text($missing)")).toThrow(NoteUIError);
    expect(() => compile_noteui("Text(@Nope(1))")).toThrow(NoteUIError);
    // only one column
    expect(() =>
      compile_noteui('Columns([Column([Text("x")])])'),
    ).toThrow(NoteUIError);
  });
});

describe("markdown fences", () => {
  it("compiles a ```noteui fence", () => {
    const blocks = coarse_markdown_to_blocks(
      '# Hi\n\n```noteui\nPage([Callout("tip", "hi"), Text("there")])\n```\n',
    );
    expect(types(blocks)).toEqual(["heading", "callout", "paragraph"]);
    validate_blocks(blocks);
  });

  it("still supports learning fences", () => {
    const blocks = coarse_markdown_to_blocks(
      '```quiz\n{"questions": [{"question": "Q?"}]}\n```\n' +
        "```mermaid\ngraph TD; A-->B\n```",
    );
    expect(types(blocks)).toEqual(["learning", "learning"]);
    expect(blocks[0].props.kind).toBe("quiz");
    expect(blocks[1].props.kind).toBe("mermaid");
    validate_blocks(blocks);
  });
});

describe("safe_link", () => {
  it("allows relative notebook links but blocks code", () => {
    // Cross-page references written as `[Lasers](Lasers)` must not break saves.
    for (const value of [
      "Lasers",
      "Optical Fibers",
      "/co-writer/abc",
      "#top",
      "",
      "a/b",
    ]) {
      expect(safe_link(value), value).toBe(true);
    }
    for (const value of ["https://x.test", "http://x.test", "mailto:a@b.c"]) {
      expect(safe_link(value), value).toBe(true);
    }
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "//evil.test/x",
      "java\nscript:alert(1)",
      null,
    ]) {
      expect(safe_link(value), String(value)).toBe(false);
    }
  });

  it("lets a relative-link block survive validation", () => {
    const block = {
      id: "a1",
      type: "paragraph",
      props: {},
      content: [
        {
          type: "link",
          href: "Lasers",
          content: [{ type: "text", text: "Lasers", styles: {} }],
        },
      ],
      children: [],
    };
    validate_blocks([block]);
  });
});

describe("markdown elements", () => {
  it("parses headings, lists, quotes, tables, code", () => {
    const blocks = coarse_markdown_to_blocks(
      "# T\n\npara **bold** $x$\n\n- [x] done\n- item\n\n1. one\n\n> quote\n\n---\n\n" +
        "| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\nprint(1)\n```",
    );
    expect(types(blocks)).toEqual([
      "heading",
      "paragraph",
      "checkListItem",
      "bulletListItem",
      "numberedListItem",
      "quote",
      "divider",
      "table",
      "codeBlock",
    ]);
    validate_blocks(blocks);
  });
});

describe("round-trips", () => {
  it("round-trips rich blocks through markdown", () => {
    const original = compile_noteui(
      "Page([\n" +
        '  Heading(2, "Sec", [Bullet("child item")]),\n' +
        '  Callout("info", "note"),\n' +
        '  Columns([Column([Text("l")]), Column([Text("r")])]),\n' +
        '  Quiz({questions: [{question: "Q?"}]}),\n' +
        "  TableOfContents()\n" +
        "])",
    );
    const md = blocks_to_markdown(original);
    const rebuilt = validate_blocks(coarse_markdown_to_blocks(md));
    expect(types(rebuilt)).toEqual(types(original));
    // Spot-check nested content survived.
    const heading = rebuilt.find((b) => b.type === "heading")!;
    expect(heading.children[0].type).toBe("bulletListItem");
    const quiz = rebuilt.find((b) => b.type === "learning")!;
    expect(JSON.parse(quiz.props.data).questions).toBeTruthy();
  });

  it("serializes all valid DSL types back", () => {
    const blocks = [
      {
        id: "a1",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "hi", styles: {} }],
        children: [],
      },
      {
        id: "a2",
        type: "noteUpload",
        props: { url: "https://x.test/f.pdf", name: "f" },
        children: [],
      },
      {
        id: "a3",
        type: "webCard",
        props: { url: "https://x.test", title: "t" },
        children: [],
      },
      {
        id: "a4",
        type: "taskView",
        props: { view: "table" },
        children: [],
      },
    ];
    const dsl = blocks_to_dsl(blocks);
    const rebuilt = validate_blocks(
      coarse_markdown_to_blocks("````noteui\n" + dsl + "\n````"),
    );
    expect(types(rebuilt)).toEqual([
      "paragraph",
      "noteUpload",
      "webCard",
      "taskView",
    ]);
  });
});

describe("search/wiki images", () => {
  it("compiles SearchImage to a query image block", () => {
    const blocks = compile_noteui(
      'Page([SearchImage("eiffel tower", "The tower")])',
    );
    expect(blocks[0].type).toBe("image");
    const props = blocks[0].props;
    expect(props.query).toBe("eiffel tower");
    expect(props.via).toBe("search");
    expect(props.caption).toBe("The tower");
    expect("url" in props).toBe(false);
  });

  it("compiles WikiImage and serializes it back", () => {
    const blocks = compile_noteui('Page([WikiImage("Eiffel Tower")])');
    expect(blocks[0].props.via).toBe("wiki");
    const dsl = blocks_to_dsl(blocks);
    expect(dsl).toContain("WikiImage(");
  });

  it("rejects an empty SearchImage query", () => {
    expect(() => compile_noteui('Page([SearchImage("")])')).toThrow(NoteUIError);
  });
});
