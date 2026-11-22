// Regression tests for the composer's context bar:
//  * reflection/beam-free has a 1M window in models.dev, but the bar used to
//    show the 200k default because the window was looked up with the catalog
//    UUID instead of the wire model (and with no saved active selection).
//  * the breakdown used to be `length / 4` and `120 * toolCount`, rescaled to
//    the reported total. It must be counted with a real tokenizer instead.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/provider-config.js", () => ({
  load_catalog: vi.fn(() => ({ services: {} })),
  context_window_for: vi.fn(() => 0),
  vtx_model_metadata: vi.fn(() => null),
}));

import * as providerConfig from "../src/provider-config.js";
import {
  build_context_budget,
  count_tokens,
  DEFAULT_CONTEXT_WINDOW,
  reported_tokens,
  resolve_context_window,
  tokenizer_available,
  tool_manifest_text,
} from "../src/agent/context_budget.js";

const settings = {} as Parameters<typeof resolve_context_window>[0]["settings"];
const loadCatalog = vi.mocked(providerConfig.load_catalog);
const catalogWindow = vi.mocked(providerConfig.context_window_for);
const metadata = vi.mocked(providerConfig.vtx_model_metadata);

beforeEach(() => {
  vi.clearAllMocks();
  loadCatalog.mockReturnValue({ services: {} } as never);
  catalogWindow.mockReturnValue(0);
  metadata.mockReturnValue(null);
});

function catalogWithBeam(window = "1048576"): Record<string, unknown> {
  return {
    services: {
      llm: {
        profiles: [
          {
            id: "profile-1",
            models: [
              {
                id: "llm-model-b97c9e27-b9ce-4378-99d6-33ee8386c8fb",
                model: "reflection/beam-free",
                name: "reflection/beam-free",
                context_window: window,
                context_window_source: "metadata",
              },
            ],
          },
        ],
      },
    },
  };
}

describe("resolve_context_window", () => {
  it("finds beam's 1M window from the catalog by wire model with no saved selection", () => {
    // This mirrors the real saved state: llm_selection is null and the model
    // entry's id is a UUID, so context_window_for("", "") returns 0.
    loadCatalog.mockReturnValue(catalogWithBeam() as never);
    const result = resolve_context_window({
      settings,
      wire_model: "reflection/beam-free",
    });
    expect(result).toEqual({ window: 1_048_576, estimated: false, source: "catalog" });
  });

  it("handles a gateway-prefixed wire model", () => {
    loadCatalog.mockReturnValue(catalogWithBeam() as never);
    expect(
      resolve_context_window({ settings, wire_model: "kilo/reflection/beam-free" }).window,
    ).toBe(1_048_576);
  });

  it("falls back to models.dev metadata keyed by the wire model", () => {
    metadata.mockReturnValue({ context_window: 1_048_576 } as never);
    expect(
      resolve_context_window({ settings, wire_model: "reflection/beam-free" }),
    ).toEqual({ window: 1_048_576, estimated: false, source: "metadata" });
  });

  it("uses the saved catalog value when a selection exists", () => {
    catalogWindow.mockReturnValue(1_048_576);
    expect(
      resolve_context_window({
        settings,
        wire_model: "irrelevant-wire-model",
        profile_id: "profile-1",
        model_id: "llm-model-beam",
      }).window,
    ).toBe(1_048_576);
  });

  it("only marks the window as estimated for genuinely unknown models", () => {
    expect(
      resolve_context_window({ settings, wire_model: "some-unlisted-model" }),
    ).toEqual({ window: DEFAULT_CONTEXT_WINDOW, estimated: true, source: "default" });
  });
});

describe("real token counting", () => {
  it("loads a real BPE tokenizer", () => {
    expect(tokenizer_available()).toBe(true);
  });

  it("does not use the old length/4 heuristic", () => {
    const text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 40 identical chars
    const counted = count_tokens(text);
    expect(counted.exact).toBe(true);
    // A char/4 estimate would say 10; o200k_base encodes this differently.
    expect(counted.tokens).not.toBe(Math.floor(text.length / 4));
    expect(counted.tokens).toBeGreaterThan(0);
  });

  it("counts the serialized tool manifest, not 120 tokens per tool", () => {
    const tools = [
      { name: "web", description: "Search the web", params: { type: "object", properties: { q: { type: "string" } } } },
    ];
    const manifest = tool_manifest_text(tools);
    expect(manifest).toContain('"web"');
    expect(count_tokens(manifest).tokens).not.toBe(120);
  });
});

describe("build_context_budget", () => {
  const base = {
    settings,
    wire_model: "reflection/beam-free",
    model_provider: "kilo",
    messages: [{ role: "user", content: "Explain beam search." }],
    system_prompt: "You are a tutor.",
    tool_manifest: tool_manifest_text([
      { name: "web", description: "Search", params: { type: "object", properties: {} } },
    ]),
    usage: null,
  };

  it("reports the 1M window and real, unsescaled segment counts", () => {
    loadCatalog.mockReturnValue(catalogWithBeam() as never);
    const budget = build_context_budget(base);
    expect(budget.window).toBe(1_048_576);
    expect(budget.window_estimated).toBe(false);
    expect(budget.counter).toBe("tokenizer");
    expect(budget.tokenizer).toBe("o200k_base");
    expect(budget.model).toBe("kilo/reflection/beam-free");

    const counted = budget.segments.reduce((sum, s) => sum + s.tokens, 0);
    expect(budget.used_tokens).toBe(counted);
    expect(budget.segments.map((s) => s.key)).toEqual([
      "messages",
      "system_prompt",
      "system_tools",
    ]);
    for (const segment of budget.segments) expect(segment.tokens).toBeGreaterThan(0);
    expect(budget.segments[0].tokens).toBe(count_tokens("Explain beam search.").tokens);
    expect(budget.segments[1].tokens).toBe(count_tokens("You are a tutor.").tokens);
    expect(budget.free_tokens).toBe(1_048_576 - counted);
  });

  it("prefers the provider total and exposes the leftover as 'other', not rescaled rows", () => {
    loadCatalog.mockReturnValue(catalogWithBeam() as never);
    const countedBudget = build_context_budget(base);
    const counted = countedBudget.segments.reduce((sum, s) => sum + s.tokens, 0);
    const providerTotal = counted + 500;

    const budget = build_context_budget({
      ...base,
      usage: { total_tokens: providerTotal, input_tokens: providerTotal - 5 },
    });
    expect(budget.counter).toBe("provider_usage");
    expect(budget.used_tokens).toBe(providerTotal);
    // Local rows keep their real counts; the difference is its own row.
    expect(budget.segments.slice(0, 3)).toEqual(countedBudget.segments);
    expect(budget.segments.at(-1)).toEqual({ key: "other_context", tokens: 500 });
  });

  it("keeps the 200k default honest for unknown models", () => {
    const budget = build_context_budget({ ...base, wire_model: "totally-unknown-model" });
    expect(budget.window).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(budget.window_estimated).toBe(true);
  });
});

describe("reported_tokens", () => {
  it("uses the provider total so cached reads are not double counted", () => {
    expect(
      reported_tokens({
        total_tokens: 100,
        input_tokens: 80,
        output_tokens: 20,
        cache_read_tokens: 60,
      }),
    ).toBe(100);
  });

  it("falls back to summing the parts when no total is reported", () => {
    expect(
      reported_tokens({ input_tokens: 40, output_tokens: 10, cache_write_tokens: 5 }),
    ).toBe(55);
  });
});
