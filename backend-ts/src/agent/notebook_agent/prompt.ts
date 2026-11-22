// Port of backend/app/agent/notebook_agent/prompt.py
//
// Load the shared Co-writer system prompt.
//
// This prompt is the single source of truth for the Co-writer agent, whether it
// runs as the sub-agent dispatched by the main assistant's ``notebook`` tool or
// as the companion working beside an open page in the notebook chat.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROMPT_PATH = fileURLToPath(
  new URL("./prompts/co_writer.txt", import.meta.url),
);

export function load_co_writer_prompt(): string {
  return readFileSync(PROMPT_PATH, "utf-8").trim();
}

// Backwards-compatible alias for code still using the old name.
export const load_writer_prompt = load_co_writer_prompt;
