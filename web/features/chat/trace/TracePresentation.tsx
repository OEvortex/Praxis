"use client";

import { useMemo, useState, type ReactNode } from "react";

import type { StreamEvent } from "@/features/chat/model/protocol";
import { ActivityFold, ActivityRow, ActivityStack } from "@/components/activity";
import type { Answerer } from "./answerer";
import type { ResearchStageCard } from "./model";
import {
  getTraceMeta,
  hasRenderableCallTrace as selectHasRenderableCallTrace,
  hasSettledFinalRound,
  isTracePending,
} from "./selectors";
import { CallTracePanel } from "./CallTracePanel";
import { StreamingStatus, detectStreamingMode } from "./StreamingStatus";
import {
  RESEARCH_STAGE_SPECS,
  getTraceText,
  humanizeQuestionId,
  titleCase,
} from "./trace-format";

export { getLatestToolProgress, getToolProvider } from "./selectors";
export { CallTracePanel } from "./CallTracePanel";
export { StreamingStatus } from "./StreamingStatus";

function hasRenderableCallTrace(events: StreamEvent[]): boolean {
  return selectHasRenderableCallTrace(events);
}

/**
 * Inline trace rows for the assistant message flow: each trace renders as
 * its own one-line, expandable, live-streaming row — there is no outer
 * trace card. Group-level fold (open while working, collapsed once the
 * final answer lands) is handled by ``AssistantActivity``, which nests this
 * directly under the status header.
 */
export function TraceFlow({
  events,
  isStreaming,
}: {
  events: StreamEvent[];
  isStreaming?: boolean;
}) {
  // Mount only when at least one renderable trace group exists — groups
  // that CallTracePanel would discard (final-response only, or reasoning
  // sub-traces absorbed into the final answer) must not leave a stray
  // margin behind.
  const hasCallTrace = useMemo(() => hasRenderableCallTrace(events), [events]);

  if (!hasCallTrace) return null;
  return <CallTracePanel events={events} isStreaming={isStreaming} />;
}

/**
 * Trace rows hanging from the guide line that aligns them under the activity
 * mark, so they read as "nested below" whatever they belong to. Shared by the
 * status header's own trace and by the resumed-round trace the chat surface
 * renders under an ``ask_user`` card.
 */
export function NestedTraceFlow({
  events,
  isStreaming,
}: {
  events: StreamEvent[];
  isStreaming?: boolean;
}) {
  return (
    <div className="pt-2 [&>div]:mb-0">
      <TraceFlow events={events} isStreaming={isStreaming} />
    </div>
  );
}

/**
 * Has the turn entered its final-answer phase? Used to auto-collapse the
 * reasoning trace once Praxis stops working and starts (or has finished)
 * its answer.
 *
 *  - turn complete (``!isStreaming``)                    → final
 *  - a pipeline streaming its final write (solve/research) → final
 *    (``detectStreamingMode`` → responding / responded)
 *  - chat single loop: the latest completed round settled as terminal
 *
 * The chat loop streams its final answer as ``agent_loop_round`` content
 * (which ``detectStreamingMode`` reads as "exploring"), so a round's own
 * completion marker — emitted when it lands — is the chat-path signal.
 */
function isChatLoopTurn(events: StreamEvent[]): boolean {
  for (const event of events) {
    if (String(getTraceMeta(event).call_kind || "") === "agent_loop_round") {
      return true;
    }
  }
  return false;
}

function isFinalAnswerPhase(
  events: StreamEvent[],
  isStreaming: boolean,
  hasFinalContent: boolean,
): boolean {
  if (!isStreaming) return true;
  if (hasSettledFinalRound(events)) return true;
  const mode = detectStreamingMode(events, hasFinalContent, true);
  if (mode === "responding" || mode === "responded") {
    // Chat's single loop streams commentary mid-loop, which also reads as
    // "responding" — there only a settled round marker (above) settles the
    // phase; trusting the mode would flap the trace shut on every line of
    // commentary and open again on the next tool call.
    return !isChatLoopTurn(events);
  }
  return false;
}

/**
 * The assistant activity block: the status header
 * ("Praxis Exploring… · 8s", settling to "Praxis responded. · 10s")
 * with the exploring trace nested directly beneath it.
 *
 * The trace is expanded by default while Praxis is still reasoning /
 * exploring, and collapses once the turn resolves into its final answer.
 * The header doubles as a disclosure toggle, so the user can re-open a
 * collapsed trace (or fold an expanded one) at any time.
 */
/**
 * Shown while a persisted trace is being fetched.
 *
 * The header can now open before its rows exist, so without this the panel
 * would expand onto nothing and read as broken rather than as loading.
 */
function TraceLoadingRow() {
  
  return (
    <div className="flex items-center gap-2 py-1 pl-1 text-xs text-[var(--muted-foreground)]">
      <span className="size-1.5 animate-pulse rounded-full bg-[var(--muted-foreground)]" />
      {"Loading the full trace…"}
    </div>
  );
}


export function AssistantActivity({
  events,
  traceEvents,
  isStreaming,
  content,
  className = "",
  agentName,
  answerer,
  showMark = true,
  headerClassName = "",
  onTraceToggle,
  traceBounds,
  hasStoredTrace = false,
  processContent,
  processSummary,
}: {
  events: StreamEvent[];
  /**
   * The subset of ``events`` whose trace rows belong under this header.
   * Defaults to all of them. The chat surface narrows it to the rounds
   * before the first ``ask_user`` card, because the rounds after one render
   * below that card instead — this block is pinned to the top of the
   * message, so anything appended here after the user answers lands above
   * content they have already read.
   */
  traceEvents?: StreamEvent[];
  isStreaming?: boolean;
  content?: string;
  className?: string;
  /** Forwarded to StreamingStatus — names the thinker in the status row. */
  agentName?: string;
  /** Forwarded to StreamingStatus — the partner or agent a turn was handed to. */
  answerer?: Answerer;
  /** Hide the activity mark (partner chat shows its avatar instead). */
  showMark?: boolean;
  /** Extra classes on the status header row (e.g. a min-height so the row
   *  vertically centers against an adjacent avatar). */
  headerClassName?: string;
  /** Notified when a persisted trace is opened or collapsed. */
  onTraceToggle?: (open: boolean) => void;
  /** The turn's real span, when ``events`` is only a preview of it. */
  traceBounds?: { started_at?: number | null; ended_at?: number | null } | null;
  /**
   * Whether the server still holds trace rows this preview dropped.
   *
   * A finished turn keeps only a compact preview in memory, and that preview
   * discards ``thinking`` — which for a round that called no tools is the
   * entire trace. The header then had nothing renderable, so it rendered as
   * *not expandable*, so the click that would have fetched the full trace
   * could never happen: no rows, therefore no way to ever get rows. This flag
   * breaks that circle by letting the header open on the promise of rows.
   */
  hasStoredTrace?: boolean;
  /**
   * The turn's working-out, already laid out by the caller: what it said it
   * was about to do, the steps it took, what each one turned up. Given this,
   * the header folds THAT away rather than a bare stack of trace rows — the
   * whole process becomes one line once the answer lands, and one click
   * brings it back.
   *
   * The chat surface passes it because its process is prose interleaved with
   * rows. Surfaces with nothing but rows pass nothing and keep the old
   * behaviour.
   */
  processContent?: ReactNode;
  /** One line naming what ``processContent`` holds, for the folded header. */
  processSummary?: ReactNode;
}) {
  const shownTraceEvents = traceEvents ?? events;
  const hasTrace = useMemo(
    () => hasRenderableCallTrace(shownTraceEvents),
    [shownTraceEvents],
  );
  const hasFinalContent = Boolean(content && content.trim().length > 0);
  const finalPhase = useMemo(
    () => isFinalAnswerPhase(events, Boolean(isStreaming), hasFinalContent),
    [events, isStreaming, hasFinalContent],
  );
  // null = follow the phase automatically (open while working, collapsed
  // once answered). A click pins the user's choice for this message.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  // Openable either because rows are already here, or because the server has
  // rows to hand over once asked. Auto-open still follows the phase only when
  // there is something to show right now: a settled turn stays collapsed until
  // the reader asks for it.
  const hasProcess = processContent != null;
  const expandable = hasProcess || hasTrace || hasStoredTrace;
  const open =
    expandable && (userOpen ?? ((hasProcess || hasTrace) && !finalPhase));

  // Match StreamingStatus's own null-guard — it takes ``expandable`` into
  // account for exactly this case, so both surfaces appear or neither does.
  if (!isStreaming && !hasFinalContent && !expandable) return null;

  return (
    <div className={className}>
      <StreamingStatus
        events={events}
        isStreaming={isStreaming}
        content={content}
        expandable={expandable}
        expanded={open}
        onToggle={() => {
          const next = !open;
          setUserOpen(next);
          onTraceToggle?.(next);
        }}
        summary={processSummary}
        agentName={agentName}
        answerer={answerer}
        showMark={showMark}
        className={headerClassName}
        traceBounds={traceBounds}
      />
      {expandable ? (
        <ActivityFold open={open}>
          {/* The process hangs from a faint guide line on the header's own
              left edge — where the activity mark sits — with its content
              indented past it, so the working-out reads as nested inside the
              turn while the answer below stays at the top level. pt-2 = gap
              below the header when open; [&>div]:mb-0 strips CallTracePanel's
              own bottom margin so the single gap to the body comes from this
              block's outer ``mb-3`` in both states. */}
          {hasProcess ? (
            <div className="pt-2">{processContent}</div>
          ) : hasTrace ? (
            <NestedTraceFlow
              events={shownTraceEvents}
              isStreaming={isStreaming}
            />
          ) : (
            <TraceLoadingRow />
          )}
        </ActivityFold>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ResearchStagePanel                                                 */
/* ------------------------------------------------------------------ */

function getResearchStageId(event: StreamEvent): ResearchStageCard["id"] {
  const meta = getTraceMeta(event);
  const explicitStage = String(
    (event.metadata as Record<string, unknown> | undefined)
      ?.research_stage_card || "",
  );
  if (
    explicitStage === "understand" ||
    explicitStage === "decompose" ||
    explicitStage === "evidence" ||
    explicitStage === "result"
  ) {
    return explicitStage;
  }
  const stage = String(event.stage || meta.phase || "");
  const text = String(event.content || "").toLowerCase();
  const agent = String(
    (event.metadata as Record<string, unknown> | undefined)?.agent_name || "",
  );

  if (stage === "reporting") return "result";
  if (stage === "decomposing" || agent === "decompose_agent")
    return "decompose";
  if (stage === "rephrasing" || agent === "rephrase_agent") return "understand";
  if (stage === "planning") {
    if (text.includes("decompose") || text.includes("queue"))
      return "decompose";
    return "understand";
  }
  return "evidence";
}

function formatResearchStageSummary(events: StreamEvent[], fallback: string) {
  const progressEvents = events.filter(
    (event) => event.type === "progress" && event.content.trim().length > 0,
  );
  const lastProgress = progressEvents.at(-1)?.content.trim();
  if (lastProgress) {
    return humanizeQuestionId(titleCase(lastProgress.replaceAll("-", "_")));
  }

  const thought = getTraceText(events, ["thinking"]);
  if (thought) return thought.slice(0, 120);

  const content = getTraceText(events, ["content"]);
  if (content) return content.slice(0, 120);

  return fallback;
}

export function ResearchStagePanel({
  events,
  isStreaming,
}: {
  events: StreamEvent[];
  isStreaming?: boolean;
}) {
  
  const cards = useMemo<ResearchStageCard[]>(() => {
    return RESEARCH_STAGE_SPECS.map((spec) => ({
      id: spec.id,
      title: (spec.titleKey),
      hint: (spec.hintKey),
      events: events.filter((event) => getResearchStageId(event) === spec.id),
    })).filter((card) => card.events.length > 0);
  }, [events]);

  if (!cards.length) return null;

  return (
    <ActivityStack className="mb-3">
      {cards.map((card, index) => {
        const hasTrace = card.events.some((event) =>
          Boolean(getTraceMeta(event).call_id),
        );
        const active =
          Boolean(isStreaming) &&
          index === cards.length - 1 &&
          card.events.some(
            (event) => isTracePending([event]) || event.type === "progress",
          );
        const summary = formatResearchStageSummary(card.events, card.hint);

        return (
          // A research stage is one activity row whose second level is the
          // trace of the calls it made. It used to be a bespoke header with
          // its own spinner beside a separately-rendered trace panel; going
          // through `ActivityRow` means a stage folds, aligns and signals
          // exactly like every other line of work in the product.
          <ActivityRow
            key={card.id}
            state={active ? "running" : "done"}
            title={card.title}
            detail={summary}
            breathing={active}
            followOpen={active}
            autoScrollDetail={active}
          >
            {hasTrace ? (
              <CallTracePanel events={card.events} isStreaming={isStreaming} />
            ) : null}
          </ActivityRow>
        );
      })}
    </ActivityStack>
  );
}
