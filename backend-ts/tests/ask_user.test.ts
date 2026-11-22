// The ask_user tool: schema registration + the argument normalisation port.
import { describe, expect, it } from "vitest";

import { get_settings } from "../src/config.js";
import { builtin_tools } from "../src/agent/tools.js";
import {
  AskUserTool,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  buildAskUserPayload,
} from "../src/agent/ask_user.js";

describe("ask_user registration", () => {
  it("is always mounted in the model-facing tool surface", () => {
    const all = builtin_tools(get_settings()).map((tool) => tool.name);
    expect(all).toContain("ask_user");
  });

  it("advertises the questions array and intro in its schema", () => {
    const tool = builtin_tools(get_settings()).find((t) => t.name === "ask_user")!;
    const schema = tool.params as {
      required?: string[];
      properties: Record<string, { type?: string; items?: unknown }>;
    };
    expect(schema.required).toContain("questions");
    expect(schema.properties.questions.type).toBe("array");
    expect(schema.properties.intro.type).toBe("string");
    expect(schema.properties.questions.items).toBeDefined();
  });
});

describe("buildAskUserPayload", () => {
  it("normalises a v2 payload with options, ids and free-text flags", () => {
    const { payload, error } = buildAskUserPayload({
      intro: "  To tailor this, please clarify:  ",
      questions: [
        {
          id: "audience",
          header: " Audience ",
          prompt: " Who is this for? ",
          multiSelect: true,
          allow_free_text: false,
          placeholder: " e.g. students ",
          options: [
            { label: "Executives (Recommended)", description: "Conclusion-first" },
            "Students",
          ],
        },
      ],
    });
    expect(error).toBeNull();
    expect(payload).toEqual({
      intro: "To tailor this, please clarify:",
      questions: [
        {
          id: "audience",
          prompt: "Who is this for?",
          header: "Audience",
          multi_select: true,
          allow_free_text: false,
          placeholder: "e.g. students",
          options: [
            { label: "Executives (Recommended)", description: "Conclusion-first" },
            { label: "Students", description: null },
          ],
        },
      ],
    });
  });

  it("accepts the legacy {question, options} shape as one question", () => {
    const { payload, error } = buildAskUserPayload({
      question: "Which path?",
      options: ["Theory", "Practice"],
    });
    expect(error).toBeNull();
    expect(payload?.questions).toHaveLength(1);
    expect(payload?.questions[0].prompt).toBe("Which path?");
    expect(payload?.questions[0].id).toBe("q1");
    expect(payload?.questions[0].allow_free_text).toBe(true);
  });

  it("defaults ids and disambiguates duplicates", () => {
    const { payload } = buildAskUserPayload({
      questions: [
        { id: "q1", prompt: "First" },
        { id: "q1", prompt: "Second" },
        { prompt: "Third" },
      ],
    });
    expect(payload?.questions.map((q) => q.id)).toEqual(["q1", "q1_2", "q3"]);
  });

  it("drops duplicate labels, duplicate bodies and a model-supplied Other", () => {
    const { payload } = buildAskUserPayload({
      questions: [
        {
          prompt: "Pick one",
          options: [
            { label: "Alpha", description: "First option" },
            { label: " alpha ", description: "First option" },
            { label: "Other", description: "Let me type" },
            { label: "Beta", description: "Second option" },
          ],
        },
      ],
    });
    expect(payload?.questions[0].options.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
  });

  it("caps questions and options to the reference limits", () => {
    const { payload } = buildAskUserPayload({
      questions: Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({
        prompt: `Q${i}`,
        options: Array.from({ length: MAX_OPTIONS + 2 }, (_, j) => ({ label: `O${j}` })),
      })),
    });
    expect(payload?.questions).toHaveLength(MAX_QUESTIONS);
    expect(payload?.questions[0].options).toHaveLength(MAX_OPTIONS);
  });

  it("rejects empty or malformed arguments with a model-facing error", () => {
    expect(buildAskUserPayload({}).error).toMatch(/at least one question/);
    expect(buildAskUserPayload({ questions: "not an array" }).error).toMatch(/must be an array/);
    expect(buildAskUserPayload({ questions: [{}] }).error).toMatch(/non-empty string/);
  });

  it("decodes dense escaped unicode runs for display", () => {
    const { payload } = buildAskUserPayload({
      questions: [{ prompt: "\\u4f60\\u597d\\u4e16\\u754c" }],
    });
    expect(payload?.questions[0].prompt).toBe("你好世界");
  });
});

describe("AskUserTool.execute", () => {
  it("returns a failure for invalid arguments without pausing", async () => {
    const result = await new AskUserTool().execute({});
    expect(result.success).toBe(false);
    expect(result.result).toMatch(/at least one question/);
    expect(result.pause_for_user).toBeUndefined();
  });

  it("carries the normalised payload metadata for a valid call", async () => {
    const result = await new AskUserTool().execute({
      intro: "Clarify",
      questions: [{ prompt: "Depth?", options: [{ label: "Intro" }] }],
    });
    expect(result.success).toBe(true);
    expect(result.metadata).toEqual({
      ask_user: {
        intro: "Clarify",
        questions: [
          {
            id: "q1",
            prompt: "Depth?",
            header: null,
            multi_select: false,
            allow_free_text: true,
            placeholder: null,
            options: [{ label: "Intro", description: null }],
          },
        ],
      },
    });
  });
});
