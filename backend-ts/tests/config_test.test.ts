// Port of backend/tests/test_config_test.py — draft catalog resolution and
// provider request shaping for the Settings "Test this model" probe.
//
// Differences from the Python version:
// * ``_request_parts`` is private in the TS module, so the request-shape
//   assertions go through ``completeWithConfig`` with a stubbed ``fetch``.
// * ``context_window_for`` cannot be monkey-patched (module-local call), so the
//   runner test asserts the real models.dev window for reflection/beam-free
//   (1048576) instead of a mocked 128000.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeWithConfig,
  ConfigTestRunner,
  resolveDraftConfig,
} from "../src/services/config_test.js";

function draftCatalog(): Record<string, unknown> {
  return {
    connections: [
      {
        id: "conn-1",
        provider: "kilo",
        base_url: "https://api.kilo.ai/api/gateway",
        api_key: "secret-key",
      },
    ],
    services: {
      llm: {
        active_profile_id: "profile-1",
        active_model_id: "model-1",
        profiles: [
          {
            id: "profile-1",
            name: "Kilo Gateway",
            binding: "kilo",
            api_key: "",
            base_url: "",
            models: [
              {
                id: "model-1",
                model: "reflection/beam-free",
                provider_ref: {
                  connection_id: "conn-1",
                  binding: "kilo",
                  default_base_url: "https://api.kilo.ai/api/gateway",
                },
              },
            ],
          },
        ],
      },
    },
  };
}

function openAiResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveDraftConfig", () => {
  it("resolves a provider_ref connection", () => {
    const resolved = resolveDraftConfig(draftCatalog(), "llm");
    expect(resolved.provider).toBe("kilo");
    expect(resolved.wire_model).toBe("reflection/beam-free");
    expect(resolved.base_url).toBe("https://api.kilo.ai/api/gateway");
    expect(resolved.api_key).toBe("secret-key");
    expect(resolved.extra_headers["X-KILOCODE-EDITORNAME"]).toBe("Praxis");
  });

  it("uses the unsaved active selection", () => {
    const catalog = draftCatalog();
    catalog.llm_selection = {
      profile_id: "profile-1",
      model_id: "model-1",
    };
    (catalog.services as any).llm.active_profile_id = null;
    (catalog.services as any).llm.active_model_id = null;
    const resolved = resolveDraftConfig(catalog, "llm");
    expect(resolved.wire_model).toBe("reflection/beam-free");
  });
});

describe("request shape (via completeWithConfig)", () => {
  it("builds an OpenAI chat body", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        seenUrl = String(url);
        seenHeaders = init.headers;
        seenBody = JSON.parse(init.body);
        return openAiResponse("OK");
      }),
    );

    const config = {
      provider: "kilo",
      wire_model: "reflection/beam-free",
      base_url: "https://api.kilo.ai/api/gateway/",
      api_key: "secret-key",
      extra_headers: { "X-KILOCODE-EDITORNAME": "Praxis" },
      reasoning_effort: null,
    };
    const reply = await completeWithConfig(config, {
      system: "sys",
      prompt: "Reply with OK.",
      max_tokens: 32,
    });
    expect(reply).toBe("OK");
    expect(seenUrl).toBe(
      "https://api.kilo.ai/api/gateway/chat/completions",
    );
    expect(seenHeaders["Authorization"]).toBe("Bearer secret-key");
    expect(seenHeaders["X-KILOCODE-EDITORNAME"]).toBe("Praxis");
    expect(seenBody.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(seenBody.max_tokens).toBe(32);
  });

  it("builds an Anthropic body", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody: any = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        seenUrl = String(url);
        seenHeaders = init.headers;
        seenBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: "text", text: "OK" }],
          }),
          text: async () => "{}",
        } as unknown as Response;
      }),
    );

    const config = {
      provider: "anthropic",
      wire_model: "claude-test",
      base_url: "https://api.anthropic.com/v1",
      api_key: "key",
      extra_headers: {},
    };
    await completeWithConfig(config, {
      system: "sys",
      prompt: "hi",
      max_tokens: 16,
    });
    expect(seenUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(seenHeaders["x-api-key"]).toBe("key");
    expect(seenBody.system).toBe("sys");
  });
});

describe("ConfigTestRunner", () => {
  it("emits completed with a context_window event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => openAiResponse("OK")),
    );

    const runner = new ConfigTestRunner();
    const testRun = runner.start("llm", draftCatalog());
    for (let i = 0; i < 200 && !testRun.isTerminal(); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const events = testRun.snapshot(0);

    expect(testRun.status).toBe("completed");
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("response");
    expect(kinds).toContain("context_window");
    expect(kinds).toContain("completed");
    const response = events.find((e) => e.type === "response")!;
    expect(response.snippet).toBe("OK");
    const context = events.find((e) => e.type === "context_window")!;
    // The vendored models.dev table has reflection/beam-free at 1M; detection
    // resolves the wire model, so it must not fall back to the 200k default.
    expect(context.context_window).toBe(1_048_576);
    expect(context.source).toBe("metadata");
  });

  it("reports a probe failure as a failed event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 401,
            json: async () => ({}),
            text: async () => "unauthorized",
          }) as unknown as Response,
      ),
    );

    const runner = new ConfigTestRunner();
    const testRun = runner.start("llm", draftCatalog());
    for (let i = 0; i < 200 && !testRun.isTerminal(); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const events = testRun.snapshot(0);

    expect(testRun.status).toBe("failed");
    const failed = events.find((e) => e.type === "failed")!;
    expect(String(failed.message)).toContain("HTTP 401");
  });
});
