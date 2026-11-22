// agent UI metadata registry.
import { Hono } from "hono";

export const agentConfigRouter = new Hono();

// Agent registry — single source of truth for agent UI metadata (verbatim).
const AGENT_REGISTRY: Record<string, { icon: string; color: string; label_key: string }> = {
  solve: { icon: "HelpCircle", color: "blue", label_key: "Problem Solved" },
  question: { icon: "FileText", color: "purple", label_key: "Question Generated" },
  research: { icon: "Search", color: "emerald", label_key: "Research Report" },
  co_writer: { icon: "PenTool", color: "amber", label_key: "Co-Writer" },
};

// GET /api/agent-config/agents
agentConfigRouter.get("/api/agent-config/agents", (c) => c.json(AGENT_REGISTRY));

// GET /api/agent-config/agents/{agent_type}
agentConfigRouter.get("/api/agent-config/agents/:agent_type", (c) => {
  const agentType = c.req.param("agent_type") ?? "";
  const entry = AGENT_REGISTRY[agentType];
  if (entry) return c.json(entry);
  return c.json({ error: `Agent type '${agentType}' not found` });
});
