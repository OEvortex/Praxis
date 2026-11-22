"use client";

import dynamic from "@/shared/router/dynamic";
import { useEffect } from "react";
import type React from "react";
import type { SelectedHistorySession } from "@/components/chat/HistorySessionPicker";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import type { SessionViewerPanelHandle } from "@/components/chat/home/SessionViewerPanel";
import type { SelectedRecord } from "@/lib/notebook-selection-types";
const SaveToNotebookModal = dynamic(
  () => import("@/components/notebook/SaveToNotebookModal"),
  { ssr: false },
);

type SaveToNotebookModalProps = React.ComponentProps<typeof SaveToNotebookModal>;
import { useGeogebraTabOpener } from "@/context/GeogebraTabContext";
import { useQuizFollowupController } from "@/context/QuizFollowupContext";
import type { StreamEvent } from "@/features/chat/model/protocol";
import type { SelectedBookReference } from "@/lib/book-references";
import type { SelectedReadingReference } from "@/lib/reading-references";
import type { SpaceMemoryFile } from "@/lib/space-items";

const NotebookRecordPicker = dynamic(
  () => import("@/components/notebook/NotebookRecordPicker"),
  { ssr: false },
);
const HistorySessionPicker = dynamic(
  () => import("@/components/chat/HistorySessionPicker"),
  { ssr: false },
);
const MyAgentsPicker = dynamic(
  () => import("@/components/chat/MyAgentsPicker"),
  { ssr: false },
);
const QuestionBankPicker = dynamic(
  () => import("@/components/chat/QuestionBankPicker"),
  { ssr: false },
);
const MemoryPicker = dynamic(() => import("@/components/chat/MemoryPicker"), {
  ssr: false,
});
const BookReferencePicker = dynamic(
  () => import("@/components/chat/BookReferencePicker"),
  { ssr: false },
);
const ReadingReferencePicker = dynamic(
  () => import("@/components/chat/ReadingReferencePicker"),
  { ssr: false },
);

export interface ChatPickersModalProps {
  showNotebookPicker: boolean;
  onCloseNotebookPicker: () => void;
  onApplyNotebookRecords: (records: SelectedRecord[]) => void;
  showBookPicker: boolean;
  selectedBookReferences: SelectedBookReference[];
  onCloseBookPicker: () => void;
  onApplyBookReferences: (references: SelectedBookReference[]) => void;
  showReadingPicker: boolean;
  selectedReadingReferences: SelectedReadingReference[];
  onCloseReadingPicker: () => void;
  onApplyReadingReferences: (references: SelectedReadingReference[]) => void;
  showHistoryPicker: boolean;
  onCloseHistoryPicker: () => void;
  onApplyHistorySessions: (sessions: SelectedHistorySession[]) => void;
  showAgentsPicker: boolean;
  onCloseAgentsPicker: () => void;
  onApplyAgentSessions: (sessions: SelectedHistorySession[]) => void;
  showQuestionBankPicker: boolean;
  selectedQuestionEntries: SelectedQuestionEntry[];
  onCloseQuestionBankPicker: () => void;
  onApplyQuestionEntries: (entries: SelectedQuestionEntry[]) => void;
  showMemoryPicker: boolean;
  selectedMemoryFiles: SpaceMemoryFile[];
  onCloseMemoryPicker: () => void;
  onApplyMemoryFiles: (files: SpaceMemoryFile[]) => void;
  showSaveModal: boolean;
  chatSavePayload: SaveToNotebookModalProps["payload"];
  chatSaveMessages: SaveToNotebookModalProps["messages"];
  onCloseSaveModal: () => void;
}

export function ChatPickersModal({
  showNotebookPicker,
  onCloseNotebookPicker,
  onApplyNotebookRecords,
  showBookPicker,
  selectedBookReferences,
  onCloseBookPicker,
  onApplyBookReferences,
  showReadingPicker,
  selectedReadingReferences,
  onCloseReadingPicker,
  onApplyReadingReferences,
  showHistoryPicker,
  onCloseHistoryPicker,
  onApplyHistorySessions,
  showAgentsPicker,
  onCloseAgentsPicker,
  onApplyAgentSessions,
  showQuestionBankPicker,
  selectedQuestionEntries,
  onCloseQuestionBankPicker,
  onApplyQuestionEntries,
  showMemoryPicker,
  selectedMemoryFiles,
  onCloseMemoryPicker,
  onApplyMemoryFiles,
  showSaveModal,
  chatSavePayload,
  chatSaveMessages,
  onCloseSaveModal,
}: ChatPickersModalProps) {
  return (
    <>
      <NotebookRecordPicker
        open={showNotebookPicker}
        onClose={onCloseNotebookPicker}
        onApply={onApplyNotebookRecords}
      />
      <BookReferencePicker
        open={showBookPicker}
        initialReferences={selectedBookReferences}
        onClose={onCloseBookPicker}
        onApply={onApplyBookReferences}
      />
      <ReadingReferencePicker
        open={showReadingPicker}
        initialReferences={selectedReadingReferences}
        onClose={onCloseReadingPicker}
        onApply={onApplyReadingReferences}
      />
      <HistorySessionPicker
        open={showHistoryPicker}
        onClose={onCloseHistoryPicker}
        onApply={onApplyHistorySessions}
      />
      <MyAgentsPicker
        open={showAgentsPicker}
        onClose={onCloseAgentsPicker}
        onApply={onApplyAgentSessions}
      />
      <QuestionBankPicker
        open={showQuestionBankPicker}
        initialSelected={selectedQuestionEntries}
        onClose={onCloseQuestionBankPicker}
        onApply={onApplyQuestionEntries}
      />
      <MemoryPicker
        open={showMemoryPicker}
        initialFiles={selectedMemoryFiles}
        onClose={onCloseMemoryPicker}
        onApply={onApplyMemoryFiles}
      />
      <SaveToNotebookModal
        open={showSaveModal}
        payload={chatSavePayload}
        messages={chatSaveMessages}
        onClose={onCloseSaveModal}
      />
    </>
  );
}

export function QuizFollowupBridge({
  viewerPanelRef,
}: {
  viewerPanelRef: React.MutableRefObject<SessionViewerPanelHandle | null>;
}) {
  const controller = useQuizFollowupController();
  useEffect(() => {
    controller.setOpenTabHandler((ctx) => {
      viewerPanelRef.current?.openQuizFollowupTab(ctx);
    });
    return () => controller.setOpenTabHandler(null);
  }, [controller, viewerPanelRef]);
  return null;
}

export function GeogebraTabBridge({
  viewerPanelRef,
}: {
  viewerPanelRef: React.MutableRefObject<SessionViewerPanelHandle | null>;
}) {
  const controller = useGeogebraTabOpener();
  useEffect(() => {
    if (!controller) return;
    controller.setOpenHandler((payload) => {
      viewerPanelRef.current?.openGeogebraTab(payload);
    });
    return () => controller.setOpenHandler(null);
  }, [controller, viewerPanelRef]);
  return null;
}

export function SubagentTabWatcher({
  messages,
  viewerPanelRef,
}: {
  messages: { events?: StreamEvent[] }[];
  viewerPanelRef: React.MutableRefObject<SessionViewerPanelHandle | null>;
}) {
  useEffect(() => {
    const groups = new Map<string, { label: string; events: StreamEvent[] }>();
    for (const msg of messages) {
      for (const ev of msg.events ?? []) {
        const meta = (ev.metadata ?? {}) as Record<string, unknown>;
        if (meta.trace_kind !== "subagent_event") continue;
        const key = String(meta.turn_id || meta.call_id || meta.trace_id || "");
        if (!key) continue;
        const existing = groups.get(key);
        const label = String(
          meta.subagent_name || existing?.label || "Subagent",
        );
        if (existing) {
          existing.label = label;
          existing.events.push(ev);
        } else {
          groups.set(key, { label, events: [ev] });
        }
      }
    }
    for (const [key, group] of groups) {
      viewerPanelRef.current?.openSubagentTab(key, group.label, group.events);
    }
  }, [messages, viewerPanelRef]);
  return null;
}
