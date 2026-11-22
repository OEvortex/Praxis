"use client";

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { ActivityFold, FoldCaret } from "@/components/activity";
import AssistantResponse from "@/components/common/AssistantResponse";
import { LearningText } from "@/components/common/LearningText";
import { NestedTraceFlow, TraceFlow } from "@/features/chat/trace/TracePresentation";
import { hasSettledFinalRound } from "@/features/chat/trace/selectors";
import { AskUserOptions, type MessageSegment } from "@/components/chat/home/AskUserOptions";
import type { StreamEvent } from "@/features/chat/model/protocol";
import { ROW_GUTTER } from "./types";

function processContentKey(
  segments: MessageSegment[],
  settled: boolean,
): string {
  return segments
    .map((seg) =>
      seg.kind === "ask_user"
        ? `q${seg.key}:${JSON.stringify(seg.data)}`
        : settled
          ? seg.key
          : seg.kind === "text"
            ? `t${seg.key}:${seg.text.length}`
            : seg.kind === "trace"
              ? `r${seg.key}:${seg.events.length}`
              : seg.key,
    )
    .join("|");
}

/**
 * Prose and the steps it introduced, in the order they were written.
 *
 * Spacing is owned here rather than left to each piece. Markdown carries a
 * bottom margin and the trace rows carried only a top one, so a row sat 24px
 * below the sentence that introduced it and flush against the one that
 * followed — reading as a heading for the next paragraph instead of as the
 * step between them. Both margins are stripped and one gap governs the whole
 * column, so the rhythm is even whichever way you read it.
 *
 * Alignment is owned here too, for the same reason. A trace row carries its
 * own mark column, so its text started {@link ROW_GUTTER}px right of the
 * prose above it and the column had four left edges inside 42px — the rule,
 * the prose, the dots, the row text. Read down it, every other line stepped
 * sideways. The rows are pulled back by exactly that gutter instead, which
 * leaves two edges: one content edge that prose and steps share, and the
 * dots hanging in the margin beside it, which is what a bullet gutter is.
 *
 * Memoized on what it holds rather than on the props it is handed.
 * ``messageSegments`` is rebuilt from scratch on every streamed delta, so the
 * working-out — which stops changing the moment a turn starts writing its
 * answer — arrived as a brand-new element tree on every frame of that answer.
 * React cannot skip a subtree whose elements it has never seen, so the whole
 * trace re-rendered for the answer's full length: profiled over one 35s turn,
 * 2905 renders costing 10.3s, none of which changed a pixel.
 *
 * ``events`` is deliberately left out of the comparison. It is read only to
 * verify reading-material locators, and anything that could verify one is a
 * tool call — which lands in a run of steps and moves the key on its own.
 */
export const ProcessBody = memo(
  function ProcessBody({
    segments,
    events,
    language,
    isStreaming,
    readingMaterialId,
    readingMaterialRevision,
  }: {
    segments: MessageSegment[];
    events: StreamEvent[];
    /** The turn has moved on to its answer, so this run is finished. */
    settled: boolean;
    language?: string;
    isStreaming?: boolean;
    readingMaterialId?: string;
    readingMaterialRevision?: number;
  }) {
    return (
      <div
        className="flex flex-col gap-3"
        // The padding is the content edge — where prose starts and where a
        // row's text is pulled back to. Wide enough to hold the dots.
        style={{ paddingLeft: ROW_GUTTER }}
      >
        {segments.map((seg) =>
          seg.kind === "text" ? (
            <div key={seg.key} className="[&_.md-renderer>*:last-child]:mb-0">
              <AssistantResponse
                content={seg.text}
                language={language}
                isStreaming={isStreaming}
                readingMaterialId={readingMaterialId}
                readingMaterialRevision={readingMaterialRevision}
                events={events}
              />
            </div>
          ) : seg.kind === "trace" ? (
            <div
              key={seg.key}
              className="[&>div]:mb-0"
              style={{ marginLeft: -ROW_GUTTER }}
            >
              <TraceFlow events={seg.events} isStreaming={isStreaming} />
            </div>
          ) : seg.kind === "ask_user" && seg.data.resolved ? (
            <AskUserOptions
              key={seg.key}
              data={seg.data}
              onSubmit={() => false}
            />
          ) : null,
        )}
      </div>
    );
  },
  (a, b) =>
    a.language === b.language &&
    a.isStreaming === b.isStreaming &&
    a.settled === b.settled &&
    a.readingMaterialId === b.readingMaterialId &&
    a.readingMaterialRevision === b.readingMaterialRevision &&
    processContentKey(a.segments, a.settled) ===
      processContentKey(b.segments, b.settled),
);

/**
 * A run of working-out that folds itself away.
 *
 * Used for the runs that follow a card — the leading run rides in the
 * message's activity header instead, which is already a disclosure and
 * already pinned at the top, so the common turn shows one line of chrome
 * rather than two.
 */
export function ProcessFold({
  segments,
  settled,
  children,
}: {
  segments: MessageSegment[];
  /** The turn has moved on: fold by default, and say what is inside. */
  settled: boolean;
  children: ReactNode;
}) {
  
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? !settled;
  const toolCalls = countProcessToolCalls(segments);

  return (
    <div className="mb-3">
      {/* Same shape as the activity header this fold echoes: the label first,
          the caret after it. The header has an orb holding the left column,
          so a leading caret here would make the two controls read as two
          different kinds of thing. */}
      <button
        type="button"
        onClick={() => setUserOpen(!open)}
        aria-expanded={open}
        className="group/act flex items-center gap-2 text-left text-[12px] font-medium text-[var(--muted-foreground)]/55 transition-colors hover:text-[var(--foreground)]"
      >
        {toolCalls > 0
          ? `${toolCalls} tool calls`
          : "Working notes"}
        <FoldCaret open={open} />
      </button>
      <ActivityFold open={open}>
        <div className="pt-1">{children}</div>
      </ActivityFold>
    </div>
  );
}

/**
 * What the learner sent while this turn was working, where the turn read it.
 *
 * Drawn as the learner's own bubble, only smaller, so the reply reads as one
 * conversation: the work above was done before it arrived, and everything
 * below was written knowing it.
 */
export function SentMidTurn({ messages }: { messages: string[] }) {
  
  return (
    <div data-sent-mid-turn="true" className="my-3 flex flex-col items-end gap-1">
      <span className="pr-1 text-[11px] text-[var(--muted-foreground)]">
        {"You, while it worked"}
      </span>
      {messages.map((text, index) => (
        <div
          key={index}
          dir="auto"
          className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[var(--secondary)] px-3.5 py-2 text-[13.5px] leading-relaxed text-[var(--foreground)]"
        >
          <LearningText size={13.5}>{text}</LearningText>
        </div>
      ))}
    </div>
  );
}

/**
 * One row of the assistant message: a run of working-out, a card, or answer
 * prose. Cards and the answer stand on their own; a process run is what the
 * turn did before either of them and folds away once the turn has settled.
 */
export type MessageBlock =
  | { kind: "process"; key: string; segments: MessageSegment[] }
  | { kind: "card"; key: string; segment: MessageSegment }
  | { kind: "answer"; key: string; segment: MessageSegment };

/**
 * Split a message into its blocks.
 *
 * A mastery question ends its turn, so the prose introducing it is teaching,
 * not commentary awaiting a later answer. Keep learner-facing text since the
 * previous card outside the fold even when tool work separates its parts.
 * Reasoning and tool payloads are trace segments and still fold normally.
 * Answered clarifications belong to the same process as the
 * work before and after them; only pending cards stand outside the fold.
 */
export function buildMessageBlocks(
  segments: MessageSegment[],
  answerStart: number,
  isMastery: boolean,
): MessageBlock[] {
  const teaching = new Set<number>();
  const preserveTeachingBefore = (index: number) => {
    let before = index - 1;
    while (before >= 0 && segments[before].kind === "trace") before -= 1;
    // Later tool work cannot demote an already-written lesson into working
    // notes in a Mastery turn. Ordinary chat preserves only the immediate
    // introduction to its question, keeping earlier exploration folded.
    while (before >= 0) {
      const preceding = segments[before];
      if (preceding.kind === "text") teaching.add(before);
      else if (!isMastery || preceding.kind !== "trace") break;
      before -= 1;
    }
  };
  segments.forEach((segment, index) => {
    if (segment.kind === "mastery_question") preserveTeachingBefore(index);
  });
  // Keep Mastery teaching/feedback visible before an assessment arrives and
  // when a turn ends with bookkeeping without posing an assessment at all.
  if (isMastery) preserveTeachingBefore(segments.length);
  const blocks: MessageBlock[] = [];
  let run: MessageSegment[] = [];
  const flush = () => {
    if (!run.length) return;
    blocks.push({ kind: "process", key: `p-${run[0].key}`, segments: run });
    run = [];
  };
  segments.slice(0, answerStart).forEach((segment, index) => {
    if (
      (segment.kind === "ask_user" && !segment.data.resolved) ||
      segment.kind === "mastery_question" ||
      // A presented lesson page is part of the lesson, not working-out.
      segment.kind === "source_view" ||
      // The learner's own words are conversation, not working-out to fold.
      segment.kind === "user_input"
    ) {
      flush();
      blocks.push({ kind: "card", key: segment.key, segment });
      return;
    }
    if (teaching.has(index)) {
      flush();
      blocks.push({ kind: "answer", key: segment.key, segment });
      return;
    }
    run.push(segment);
  });
  flush();
  segments.slice(answerStart).forEach((segment) => {
    blocks.push({ kind: "answer", key: segment.key, segment });
  });
  return blocks;
}

/**
 * How many steps a run of working-out took, for the line that names it.
 *
 * Steps only. Counting the paragraphs of commentary alongside them read as a
 * measure of how much was said rather than how much was done, which is the
 * thing a reader is deciding whether to open.
 */
export function countProcessToolCalls(segments: MessageSegment[]): number {
  let toolCalls = 0;
  for (const segment of segments) {
    if (segment.kind !== "trace") continue;
    for (const event of segment.events) {
      if (event.type === "tool_call") toolCalls += 1;
    }
  }
  return toolCalls;
}

