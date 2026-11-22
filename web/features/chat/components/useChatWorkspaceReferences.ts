"use client";

import { useCallback, useMemo, useState } from "react";
import type { SelectedHistorySession } from "@/components/chat/HistorySessionPicker";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import type { SelectedRecord } from "@/lib/notebook-selection-types";
import {
  selectedBooksToPayload,
  type SelectedBookReference,
} from "@/lib/book-references";
import {
  selectedReadingsToPayload,
  type SelectedReadingReference,
} from "@/lib/reading-references";
import type { SpaceMemoryFile } from "@/lib/space-items";

export function useChatWorkspaceReferences(
  setPersonaSelection: (persona: string) => void,
) {
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showNotebookPicker, setShowNotebookPicker] = useState(false);
  const [showBookPicker, setShowBookPicker] = useState(false);
  const [showReadingPicker, setShowReadingPicker] = useState(false);
  const [showHistoryPicker, setShowHistoryPicker] = useState(false);
  const [showAgentsPicker, setShowAgentsPicker] = useState(false);
  const [showQuestionBankPicker, setShowQuestionBankPicker] = useState(false);
  const [personaSelectorOpen, setPersonaSelectorOpen] = useState(false);
  const [showMemoryPicker, setShowMemoryPicker] = useState(false);
  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);

  const [selectedNotebookRecords, setSelectedNotebookRecords] = useState<
    SelectedRecord[]
  >([]);
  const [selectedBookReferences, setSelectedBookReferences] = useState<
    SelectedBookReference[]
  >([]);
  const [selectedReadingReferences, setSelectedReadingReferences] = useState<
    SelectedReadingReference[]
  >([]);
  const [selectedHistorySessions, setSelectedHistorySessions] = useState<
    SelectedHistorySession[]
  >([]);
  const [selectedAgentSessions, setSelectedAgentSessions] = useState<
    SelectedHistorySession[]
  >([]);
  const [selectedQuestionEntries, setSelectedQuestionEntries] = useState<
    SelectedQuestionEntry[]
  >([]);
  const [selectedMemoryFiles, setSelectedMemoryFiles] = useState<
    SpaceMemoryFile[]
  >([]);

  const notebookReferenceGroups = useMemo(() => {
    const groups = new Map<string, { notebookName: string; count: number }>();
    selectedNotebookRecords.forEach((record) => {
      const existing = groups.get(record.notebookId);
      if (existing) {
        existing.count += 1;
      } else {
        groups.set(record.notebookId, {
          notebookName: record.notebookName,
          count: 1,
        });
      }
    });
    return Array.from(groups.entries()).map(([notebookId, value]) => ({
      notebookId,
      ...value,
    }));
  }, [selectedNotebookRecords]);

  const notebookReferencesPayload = useMemo(() => {
    const grouped = new Map<string, string[]>();
    selectedNotebookRecords.forEach((record) => {
      const current = grouped.get(record.notebookId) || [];
      current.push(record.id);
      grouped.set(record.notebookId, current);
    });
    return Array.from(grouped.entries()).map(([notebook_id, record_ids]) => ({
      notebook_id,
      record_ids,
    }));
  }, [selectedNotebookRecords]);

  const bookReferencesPayload = useMemo(
    () => selectedBooksToPayload(selectedBookReferences),
    [selectedBookReferences],
  );
  const readingReferencesPayload = useMemo(
    () => selectedReadingsToPayload(selectedReadingReferences),
    [selectedReadingReferences],
  );
  const historyReferencesPayload = useMemo(
    () =>
      Array.from(
        new Set([
          ...selectedHistorySessions.map((session) => session.sessionId),
          ...selectedAgentSessions.map((session) => session.sessionId),
        ]),
      ),
    [selectedHistorySessions, selectedAgentSessions],
  );
  const questionNotebookReferencesPayload = useMemo(
    () => selectedQuestionEntries.map((entry) => entry.id),
    [selectedQuestionEntries],
  );
  const memoryReferencesPayload = useMemo(
    () => [...selectedMemoryFiles],
    [selectedMemoryFiles],
  );

  const handleSelectNotebookPicker = useCallback(
    () => setShowNotebookPicker(true),
    [],
  );
  const handleSelectBookPicker = useCallback(() => setShowBookPicker(true), []);
  const handleSelectReadingPicker = useCallback(
    () => setShowReadingPicker(true),
    [],
  );
  const handleSelectHistoryPicker = useCallback(
    () => setShowHistoryPicker(true),
    [],
  );
  const handleSelectAgentsPicker = useCallback(
    () => setShowAgentsPicker(true),
    [],
  );
  const handleSelectQuestionBankPicker = useCallback(
    () => setShowQuestionBankPicker(true),
    [],
  );
  const handleSelectPersonaPicker = useCallback(
    () => setPersonaSelectorOpen(true),
    [],
  );
  const handleSelectMemoryPicker = useCallback(
    () => setShowMemoryPicker(true),
    [],
  );

  const handleRemoveHistory = useCallback((sessionId: string) => {
    setSelectedHistorySessions((prev) =>
      prev.filter((item) => item.sessionId !== sessionId),
    );
  }, []);
  const handleRemoveAgent = useCallback((sessionId: string) => {
    setSelectedAgentSessions((prev) =>
      prev.filter((item) => item.sessionId !== sessionId),
    );
  }, []);
  const handleRemoveNotebook = useCallback((notebookId: string) => {
    setSelectedNotebookRecords((prev) =>
      prev.filter((record) => record.notebookId !== notebookId),
    );
  }, []);
  const handleRemoveBookReference = useCallback((bookId: string) => {
    setSelectedBookReferences((prev) =>
      prev.filter((record) => record.bookId !== bookId),
    );
  }, []);
  const handleRemoveReadingReference = useCallback((materialId: string) => {
    setSelectedReadingReferences((previous) =>
      previous.filter((record) => record.materialId !== materialId),
    );
  }, []);
  const handleRemoveQuestion = useCallback((entryId: number) => {
    setSelectedQuestionEntries((prev) =>
      prev.filter((entry) => entry.id !== entryId),
    );
  }, []);
  const handleClearPersona = useCallback(() => {
    setPersonaSelection("");
  }, [setPersonaSelection]);
  const handleToggleMemoryFile = useCallback((file: SpaceMemoryFile) => {
    setSelectedMemoryFiles((prev) =>
      prev.includes(file)
        ? prev.filter((item) => item !== file)
        : [...prev, file],
    );
  }, []);

  const handleCloseNotebookPicker = useCallback(() => {
    setShowNotebookPicker(false);
    setSpaceMenuOpen(true);
  }, []);
  const handleCloseBookPicker = useCallback(() => {
    setShowBookPicker(false);
    setSpaceMenuOpen(true);
  }, []);
  const handleCloseReadingPicker = useCallback(() => {
    setShowReadingPicker(false);
    setSpaceMenuOpen(true);
  }, []);
  const handleApplyBookReferences = useCallback(
    (references: SelectedBookReference[]) => {
      setSelectedBookReferences(references);
    },
    [],
  );
  const handleApplyReadingReferences = useCallback(
    (references: SelectedReadingReference[]) => {
      setSelectedReadingReferences(references);
    },
    [],
  );
  const handleApplyNotebookRecords = useCallback(
    (records: SelectedRecord[]) => {
      setSelectedNotebookRecords(records);
    },
    [],
  );
  const handleCloseHistoryPicker = useCallback(() => {
    setShowHistoryPicker(false);
    setSpaceMenuOpen(true);
  }, []);
  const handleApplyHistorySessions = useCallback(
    (sessions: SelectedHistorySession[]) => {
      setSelectedHistorySessions(sessions);
    },
    [],
  );
  const handleCloseAgentsPicker = useCallback(() => {
    setShowAgentsPicker(false);
    setSpaceMenuOpen(true);
  }, []);
  const handleApplyAgentSessions = useCallback(
    (sessions: SelectedHistorySession[]) => {
      setSelectedAgentSessions(sessions);
    },
    [],
  );
  const handleCloseQuestionBankPicker = useCallback(() => {
    setShowQuestionBankPicker(false);
    setSpaceMenuOpen(true);
  }, []);
  const handleApplyQuestionEntries = useCallback(
    (entries: SelectedQuestionEntry[]) => {
      setSelectedQuestionEntries(entries);
    },
    [],
  );
  const handleCloseMemoryPicker = useCallback(() => {
    setShowMemoryPicker(false);
    setSpaceMenuOpen(true);
  }, []);
  const handleApplyMemoryFiles = useCallback((files: SpaceMemoryFile[]) => {
    setSelectedMemoryFiles(files);
  }, []);
  const handleCloseSaveModal = useCallback(() => {
    setShowSaveModal(false);
  }, []);

  return {
    showSaveModal,
    setShowSaveModal,
    showNotebookPicker,
    showBookPicker,
    showReadingPicker,
    showHistoryPicker,
    showAgentsPicker,
    showQuestionBankPicker,
    personaSelectorOpen,
    setPersonaSelectorOpen,
    showMemoryPicker,
    spaceMenuOpen,
    setSpaceMenuOpen,
    selectedNotebookRecords,
    setSelectedNotebookRecords,
    selectedBookReferences,
    setSelectedBookReferences,
    selectedReadingReferences,
    setSelectedReadingReferences,
    selectedHistorySessions,
    setSelectedHistorySessions,
    selectedAgentSessions,
    setSelectedAgentSessions,
    selectedQuestionEntries,
    setSelectedQuestionEntries,
    selectedMemoryFiles,
    setSelectedMemoryFiles,
    notebookReferenceGroups,
    notebookReferencesPayload,
    bookReferencesPayload,
    readingReferencesPayload,
    historyReferencesPayload,
    questionNotebookReferencesPayload,
    memoryReferencesPayload,
    handleSelectNotebookPicker,
    handleSelectBookPicker,
    handleSelectReadingPicker,
    handleSelectHistoryPicker,
    handleSelectAgentsPicker,
    handleSelectQuestionBankPicker,
    handleSelectPersonaPicker,
    handleSelectMemoryPicker,
    handleRemoveHistory,
    handleRemoveAgent,
    handleRemoveNotebook,
    handleRemoveBookReference,
    handleRemoveReadingReference,
    handleRemoveQuestion,
    handleClearPersona,
    handleToggleMemoryFile,
    handleCloseNotebookPicker,
    handleCloseBookPicker,
    handleCloseReadingPicker,
    handleApplyBookReferences,
    handleApplyReadingReferences,
    handleApplyNotebookRecords,
    handleCloseHistoryPicker,
    handleApplyHistorySessions,
    handleCloseAgentsPicker,
    handleApplyAgentSessions,
    handleCloseQuestionBankPicker,
    handleApplyQuestionEntries,
    handleCloseMemoryPicker,
    handleApplyMemoryFiles,
    handleCloseSaveModal,
  };
}
