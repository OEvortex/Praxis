// Mastery capability — TypeScript port of
// deeptutor/capabilities/mastery (upstream Python).
//
// Exports the mastery_* BaseTool objects for the orchestrator to register,
// plus the prompt-assembly helpers (pipeline.ts) and the session/path
// binding helpers. Mode enforcement is call-time via mode.ts; all state
// persists in the shared SQLite database via store.ts (ext_items/kv).
//
// Usage (orchestrator side):
//   import { masteryTools } from "./capabilities/mastery/index.js";
//   for (const t of masteryTools()) registry.set(t.name, t);
//
// This module does NOT register itself into src/agent/tools.ts — that file
// is owned by the core runtime.

export * from "./mode.js";
export * from "./store.js";
export {
  masteryTools,
  MASTERY_TOOLS,
  MASTERY_TOOL_NAMES,
  QUESTION_CARD_KEY,
  GRADE_META_KEY,
} from "./tools.js";
export {
  masteryPromptBlocks,
  modeInstructions,
  preLoopStatusSnapshot,
} from "./pipeline.js";
export {
  // engine re-exports the orchestrator/runtime may need
  mapSummary,
  nextObjective,
  listPathOverviews,
  dueReviews,
} from "./engine.js";
export type { LearningProgress, PendingQuestion, MasteryInteraction, SessionBinding } from "./store.js";
