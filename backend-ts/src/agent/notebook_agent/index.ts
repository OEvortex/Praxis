// Port of backend/app/agent/notebook_agent/__init__.py
//
// Notebook writer sub-agent: builds Co-Writer pages in the background.
//
// The main chat's ``notebook`` tool dispatches a dedicated writer agent through
// vtx's sub-agent machinery (``SubagentSpec`` + ``resolve_subagent_runner`` +
// ``BackgroundTaskManager``), exactly like ``delegate_subagent`` but with a
// Praxis-owned prompt and tool surface. The writer creates real pages —
// including subpages, mermaid diagrams and structured learning blocks — directly
// in the notebook store; there is no learner watching the run, so writes are not
// proposals.
//
// Layout mirrors ``video_lesson``:
//
// - ``prompts/co_writer.txt`` — the writer's system prompt (authoring playbook).
// - ``tools.ts`` — the ``nb_*`` toolset, registered into vtx's global tool
//   registry so ``SubagentSpec.tools_allow`` can select exactly these tools.
// - ``capability.ts`` — dispatch: background (default) or synchronous run.

export { launch_notebook_job } from "./capability.js";
