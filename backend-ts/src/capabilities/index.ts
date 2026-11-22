// Capabilities exposed as Praxis agent tools. Each subdirectory implements one
// capability; none of these are registered in the tool table yet — wire them in
// src/agent/tools.ts when the runtime is ready to mount them.

export * as obsidian from "./obsidian/index.js";
export * as ima from "./ima/index.js";
export * as audio_overview from "./audio_overview/index.js";
export * as setup from "./setup/index.js";
