// Immersive-reading capability — public surface for the orchestrator.
//
// Mirrors deeptutor/capabilities/reading/__init__.py: the turn mode + loop
// helpers (mode.ts), the engine/store (store.ts), the media-note formatter
// (media_notes.ts), the figure tool (figure_view.ts) and the tool set
// (tools.ts). Prompt fragments live in prompts/<lang>/reading.yaml.

export * from "./mode.js";
export * from "./store.js";
export * from "./media_notes.js";
export * from "./figure_view.js";
export * from "./tools.js";
