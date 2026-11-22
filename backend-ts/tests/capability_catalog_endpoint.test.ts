import { expect, it } from "vitest";

import { handlersRouter } from "../src/api/handlers.js";

it("registers chat and the five composer tutor modes", async () => {
  const response = await handlersRouter.request("/api/capabilities/registered");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    capabilities: Array<{
      id: string;
      available: boolean;
      manifest: { tools_used?: string[] };
    }>;
  };
  expect(body.capabilities.map((capability) => capability.id)).toEqual([
    "chat",
    "explain",
    "solve",
    "practice",
    "plan",
    "research",
  ]);
  expect(body.capabilities.every((capability) => capability.available)).toBe(true);
  expect(body.capabilities.find((capability) => capability.id === "solve")?.manifest.tools_used)
    .toEqual(["solve_hint", "web"]);
  expect(body.capabilities.find((capability) => capability.id === "research")?.manifest.tools_used)
    .toEqual(["research_source", "web", "paper_search"]);
});
