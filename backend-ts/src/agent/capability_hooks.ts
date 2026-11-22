/**
 * Per-turn wiring for the chat-loop capabilities.
 *
 * Pipeline-side calls:
 *
 *   * ``_capability_system_blocks``  → ordered prompt blocks appended to the
 *     system prompt (upstream places them after the foundation blocks, before
 *     workspace/persona notes — ``prompt_blocks.py`` ``blocks()``);
 *   * ``_capability_pre_loop_seed``  → ``pre_loop_seed`` texts joined into the
 *     user-message seed;
 *   * ``_capability_pre_loop_briefings`` → async ``pre_loop`` hook results
 *     (explore_context's investigation) appended after the seeds;
 *   * ``cap.augment_kwargs``         → server-owned private kwargs merged into
 *     each dispatched tool call.
 *
 * Every hook is best-effort: a capability that throws is logged and skipped —
 * it must never break a turn. Notebook (Co-Writer) turns keep their existing
 * prompt/tool surface, so prompt blocks and seeds are suppressed there; the
 * kwargs augmentation still runs because it is scoped by tool name.
 */

import { is_co_writer_turn } from "./co_writer.js";
import type { Dict } from "../shared/types.js";
import { masteryPromptBlocks, preLoopStatusSnapshot } from "../capabilities/mastery/pipeline.js";
import {
  activePathId,
  getSessionBinding,
  loadPath,
  MASTERY_TOOL_NAMES,
} from "../capabilities/mastery/index.js";
import {
  bindReadingKwargs,
  isActive as readingIsActive,
  locatePrePass,
  preLoopSeed as readingPreLoopSeed,
  prepareReadingTurn,
  systemBlock as readingSystemBlock,
} from "../capabilities/reading/mode.js";
import { notes_capability } from "../capabilities/notes/capability.js";
import {
  augment_kwargs as solveAugmentKwargs,
  is_active as solveIsActive,
  pre_loop_seed as solvePreLoopSeed,
  prepare_solve_turn,
  system_block as solveSystemBlock,
} from "../capabilities/solve/capability.js";
import {
  activate as askQuestionsActivate,
  augment_kwargs as askQuestionsAugment,
  is_active as askQuestionsIsActive,
  system_block as askQuestionsSystemBlock,
} from "../capabilities/ask_questions/capability.js";
import {
  augment_kwargs as creatorAugmentKwargs,
  is_active as creatorIsActive,
  system_block as creatorSystemBlock,
} from "../capabilities/creator/capability.js";
import {
  is_active as exploreIsActive,
  pre_loop as explorePreLoop,
} from "../capabilities/explore_context/capability.js";
import type { ExploreContext } from "../capabilities/explore_context/explorer.js";

const log = {
  warning: (msg: string, err?: unknown) =>
    console.warn(`[praxis.capabilities] ${msg}`, err ?? ""),
};

/** One named prompt fragment (upstream ``PromptBlock``). */
export interface CapabilityPromptBlock {
  name?: string;
  key?: string;
  content?: string;
  text?: string;
}

/** Everything the local agent loop needs for one turn's capabilities. */
export interface TurnCapabilityHooks {
  /** Turn metadata the capabilities resolved/augmented (upstream context.metadata). */
  metadata: Dict;
  /** Ordered system-prompt fragments, appended after the base prompt. */
  systemBlocks: CapabilityPromptBlock[];
  /** Text appended to the user-message seed (pre_loop_seed + briefings). */
  seedText: string;
  /** Merge capability-owned private kwargs into a tool call. Never throws. */
  augment(toolName: string, kwargs: Dict): Dict;
}

function _str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function _isRecord(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _blockText(block: CapabilityPromptBlock | null | undefined): string {
  if (!block) return "";
  return String(block.content ?? block.text ?? "").trim();
}

function _pushBlock(
  blocks: CapabilityPromptBlock[],
  name: string,
  block: CapabilityPromptBlock | null | undefined,
): void {
  const content = _blockText(block);
  if (content) blocks.push({ name, content });
}

export interface PrepareTurnCapabilitiesOptions {
  command: Dict;
  session: Dict;
  turn_id: string;
  /** The user prompt text (with attachment notes), for pre-pass context. */
  prompt: string;
  /** Optional progress sink for async pre-loop briefings. */
  progress?: (text: string) => Promise<void> | void;
}

/**
 * Resolve turn metadata and run each capability's per-turn hooks.
 *
 * Mirrors upstream ``request_preparer`` metadata writes (workspace_mode /
 * mastery_path_id / mastery_session_mode / reading ids / create_target /
 * solve_mode / ask_questions_mode) followed by the loop pipeline's
 * system-block / seed / augment collection.
 */
export async function prepare_turn_capabilities(
  opts: PrepareTurnCapabilitiesOptions,
): Promise<TurnCapabilityHooks> {
  const { command, session, turn_id } = opts;
  const sessionId = _str(session["id"]);
  const prefs = _isRecord(session["preferences"]) ? session["preferences"] : {};
  const capability = _str(command["capability"]) || _str(prefs["capability"]) || "chat";
  const language = _str(command["language"]) || _str(prefs["language"]) || "en";

  // Turn metadata: session preferences are the durable base, the turn
  // command's explicit keys win (upstream payload-over-preferences).
  const metadata: Dict = { ...prefs };
  for (const [key, value] of Object.entries(command)) {
    if (value !== undefined) metadata[key] = value;
  }
  metadata["session_id"] = sessionId;
  metadata["turn_id"] = turn_id;
  metadata["capability"] = capability;
  metadata["language"] = language;

  const workspaceMode = _str(metadata["workspace_mode"]).toLowerCase();
  const sessionKind = _str(metadata["session_kind"]).toLowerCase();

  // -- mastery -------------------------------------------------------------
  // Upstream: mastery_mode = (workspace_mode == "mastery_path"); the path id
  // resolves payload → preferences → session binding.
  if (
    metadata["mastery_mode"] !== true &&
    (workspaceMode === "mastery_path" || capability === "mastery_path")
  ) {
    metadata["mastery_mode"] = true;
  }
  const masteryBinding = getSessionBinding(sessionId);
  metadata["mastery_path_id"] =
    _str(metadata["mastery_path_id"]) || _str(masteryBinding?.path_id);
  if (!metadata["mastery_session_mode"]) {
    metadata["mastery_session_mode"] = masteryBinding?.mode ?? "";
  }

  // -- reading ---------------------------------------------------------------
  // A reading session persists its workspace/material on preferences; an
  // immersive_reading turn may also carry them on the command. Sync them into
  // the per-session mode store so isActive/systemBlock/seed see this turn.
  const readingSession =
    capability === "immersive_reading" ||
    workspaceMode === "immersive_reading" ||
    sessionKind === "immersive_reading" ||
    Boolean(_str(metadata["reading_material_id"]) || _str(metadata["reading_workspace_id"]));
  if (readingSession) {
    try {
      const materialId = _str(metadata["reading_material_id"]);
      const workspaceId = _str(metadata["reading_workspace_id"]);
      prepareReadingTurn({
        ...(materialId ? { material_id: materialId } : {}),
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...( _isRecord(metadata["reading_viewport"])
          ? { viewport: metadata["reading_viewport"] as never }
          : {}),
        mode: metadata["immersive_reading_mode"] !== false,
      });
    } catch (exc) {
      log.warning("reading prepareReadingTurn failed", exc);
    }
  }

  // -- solve -------------------------------------------------------------------
  if (
    capability === "deep_solve" ||
    capability === "solve" ||
    metadata["solve_mode"] === true
  ) {
    try {
      prepare_solve_turn(
        { session_id: sessionId, metadata },
        {
          max_replans: Number(metadata["solve_max_replans"]) || undefined,
        },
      );
    } catch (exc) {
      log.warning("solve prepare_solve_turn failed", exc);
    }
  }

  // -- ask_questions -------------------------------------------------------------
  if (capability === "ask_questions" || metadata["ask_questions_mode"] === true) {
    try {
      askQuestionsActivate(metadata);
    } catch (exc) {
      log.warning("ask_questions activate failed", exc);
    }
  }

  // Notebook (Co-Writer) turns keep their own prompt and tool surface; the
  // capability playbooks would only conflict with it.
  const coWriter = is_co_writer_turn();

  const systemBlocks: CapabilityPromptBlock[] = [];
  const seedParts: string[] = [];

  // -- mastery -------------------------------------------------------------------
  const masteryActive = Boolean(metadata["mastery_mode"]);
  if (!coWriter && masteryActive) {
    try {
      for (const block of masteryPromptBlocks(
        language,
        metadata["mastery_session_mode"] ?? undefined,
      )) {
        _pushBlock(systemBlocks, block.key ?? "mastery", block);
      }
    } catch (exc) {
      log.warning("mastery system blocks failed", exc);
    }
    // Upstream pre_loop runs mastery_status once and seeds the snapshot; the
    // TS port exposes the same read as a pure function over the path store.
    try {
      const pathId = activePathId(sessionId, _str(metadata["mastery_path_id"]));
      const progress = pathId ? loadPath(pathId) : null;
      if (progress) {
        const snapshot = preLoopStatusSnapshot(progress, sessionId);
        const text =
          "[Current-turn mastery status snapshot]\n" +
          "The runtime already read the mastery state for this turn. Use it " +
          "directly; refresh with mastery_status after changing the path, " +
          "mode, outline, or progress when updated state is needed.\n" +
          JSON.stringify(snapshot);
        if (text.trim()) seedParts.push(text);
      }
    } catch (exc) {
      log.warning("mastery status snapshot failed", exc);
    }
  }

  // -- reading ---------------------------------------------------------------------
  const readingActive = readingIsActive();
  if (!coWriter && readingActive) {
    try {
      _pushBlock(systemBlocks, "immersive_reading", readingSystemBlock({ language }));
    } catch (exc) {
      log.warning("reading systemBlock failed", exc);
    }
    try {
      const seed = readingPreLoopSeed();
      if (seed.trim()) seedParts.push(seed.trim());
      // Deterministic locate pre-pass (upstream async pre_loop; sync here).
      const locate = locatePrePass(opts.prompt, { language });
      const locateText = _blockText(locate);
      if (locateText) seedParts.push(locateText);
    } catch (exc) {
      log.warning("reading pre-loop seed failed", exc);
    }
  }

  // -- notes -------------------------------------------------------------------------
  // NotesCapability reads note_document_id off the metadata; on Co-Writer
  // turns the dedicated notebook prompt already covers the page.
  if (!coWriter) {
    try {
      const ctx = { metadata, session_id: sessionId };
      if (notes_capability.is_active(ctx)) {
        _pushBlock(systemBlocks, "notes", notes_capability.system_block(ctx, { language }));
        const seed = notes_capability.pre_loop_seed(ctx);
        if (seed && seed.trim()) seedParts.push(seed.trim());
      }
    } catch (exc) {
      log.warning("notes system block failed", exc);
    }
  }

  // -- solve ----------------------------------------------------------------------------
  if (!coWriter && solveIsActive(metadata)) {
    try {
      _pushBlock(systemBlocks, "deep_solve", solveSystemBlock(metadata, { language }));
    } catch (exc) {
      log.warning("solve system_block failed", exc);
    }
    try {
      const seed = solvePreLoopSeed(metadata);
      if (seed.trim()) seedParts.push(seed.trim());
    } catch {
      /* pre_loop_seed is a stub today */
    }
  }

  // -- ask_questions --------------------------------------------------------------------
  if (!coWriter && askQuestionsIsActive(metadata)) {
    try {
      _pushBlock(systemBlocks, "ask_questions", askQuestionsSystemBlock(metadata, { language }));
    } catch (exc) {
      log.warning("ask_questions system_block failed", exc);
    }
  }

  // -- creator ------------------------------------------------------------------------------
  if (!coWriter && creatorIsActive(metadata)) {
    try {
      _pushBlock(
        systemBlocks,
        "creator",
        creatorSystemBlock(metadata, { language, session_id: sessionId }),
      );
    } catch (exc) {
      log.warning("creator system_block failed", exc);
    }
  }

  // -- explore_context async pre_loop briefing -------------------------------------------------
  // Runs once before the first model call; folds the investigation into the
  // user-message seed (upstream _capability_pre_loop_briefings).
  if (!coWriter && exploreIsActive(metadata)) {
    try {
      const context: ExploreContext = {
        session_id: sessionId,
        user_message: opts.prompt,
        active_capability: capability,
        language,
        metadata,
      };
      const block = await explorePreLoop(context, null, null);
      const text = _blockText(block);
      if (text) {
        seedParts.push(text);
        try {
          await opts.progress?.("Exploring attached context…");
        } catch {
          /* progress is cosmetic */
        }
      }
    } catch (exc) {
      log.warning("explore_context pre_loop failed", exc);
    }
  }

  const seedText = seedParts.filter((s) => s.trim()).join("\n\n");

  // -- augment_kwargs -------------------------------------------------------------------------
  // Same capability order as upstream's LOOP_CAPABILITIES iteration; each hook
  // is wrapped so a failure degrades to the un-augmented kwargs.
  const augment = (toolName: string, kwargs: Dict): Dict => {
    let out = kwargs;
    const tryAugment = (fn: () => Dict) => {
      try {
        out = fn();
      } catch (exc) {
        log.warning(`augment_kwargs failed for ${toolName}`, exc);
      }
    };
    // mastery: tools resolve path/mode from the session ContextVars; inject the
    // private turn handles upstream passed explicitly.
    if ((MASTERY_TOOL_NAMES as readonly string[]).includes(toolName)) {
      tryAugment(() => ({
        ...out,
        __session_id: out["__session_id"] ?? sessionId,
        __turn_id: out["__turn_id"] ?? turn_id,
        __mastery_path_id:
          out["__mastery_path_id"] ?? _str(metadata["mastery_path_id"]),
      }));
    }
    tryAugment(() => bindReadingKwargs(toolName, out, metadata));
    tryAugment(() =>
      notes_capability.augment_kwargs(toolName, out, { metadata }),
    );
    tryAugment(() => solveAugmentKwargs(toolName, out, metadata));
    tryAugment(() => askQuestionsAugment(toolName, out, metadata));
    tryAugment(() =>
      creatorAugmentKwargs(toolName, out, metadata, sessionId),
    );
    return out;
  };

  return { metadata, systemBlocks, seedText, augment };
}
