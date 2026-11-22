import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  currentWorkspaceDraftLocation,
  saveWorkspaceDraft,
  readWorkspaceDraft,
  type WorkspaceDraft,
  type WorkspaceDraftLocation,
} from "@/lib/workspace-drafts";
import type { ComposerInputHandle } from "../ComposerInput";
import type { PendingAttachment } from "./types";

interface UseWorkspaceDraftSyncParams {
  attachments: PendingAttachment[];
  onAddFiles: (files: File[]) => void;
  inputHandleRef: RefObject<ComposerInputHandle | null>;
}

/**
 * Restores, autosaves, and flushes workspace-scoped composer drafts across
 * workspace switches and unmounts.
 */
export function useWorkspaceDraftSync({
  attachments,
  onAddFiles,
  inputHandleRef,
}: UseWorkspaceDraftSyncParams) {
  const draftAttachmentsRef = useRef(attachments);
  const addDraftFilesRef = useRef(onAddFiles);
  useEffect(() => {
    draftAttachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(() => {
    addDraftFilesRef.current = onAddFiles;
  }, [onAddFiles]);

  const restoredDraftRef = useRef(false);
  const restoreFailedRef = useRef(false);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftDirtyRef = useRef(false);
  const draftRevisionRef = useRef(0);
  const draftLocationRef = useRef<WorkspaceDraftLocation | null>(null);
  const draftTextRef = useRef("");
  const interactedBeforeRestoreRef = useRef(false);
  const restoreBaseRef = useRef<WorkspaceDraft | undefined | null>(null);
  const suppressDraftSaveRef = useRef(false);
  const draftWritesRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueDraftWrite = useCallback((write: () => Promise<void>) => {
    const pending = draftWritesRef.current.catch(() => {}).then(write);
    draftWritesRef.current = pending;
    return pending;
  }, []);

  const collectDraft = useCallback(
    (): WorkspaceDraft => ({
      // Keep the last value in a ref: the imperative handle may already be
      // detached when the unmount cleanup runs.
      text: draftTextRef.current,
      attachments: draftAttachmentsRef.current.map(
        ({ filename, base64, mimeType }) => ({ filename, base64, mimeType }),
      ),
    }),
    [],
  );

  const cancelDraftSave = useCallback(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
    }
    draftDirtyRef.current = false;
  }, []);

  const saveDraftInBackground = useCallback(async () => {
    if (!draftDirtyRef.current) return;
    const location = draftLocationRef.current;
    if (!location) return;
    const draft = collectDraft();
    draftDirtyRef.current = false;
    try {
      await enqueueDraftWrite(async () => {
        if (restoreFailedRef.current) {
          // The stored draft never reached the composer; merge instead of
          // overwriting it with only what was typed after the failure.
          if (restoreBaseRef.current === null) {
            restoreBaseRef.current = await readWorkspaceDraft(
              location.workspaceId,
              location.pathname,
            );
          }
          const base = restoreBaseRef.current;
          await saveWorkspaceDraft(
            {
              text: [base?.text, draft.text].filter(Boolean).join("\n"),
              attachments: [...(base?.attachments ?? []), ...draft.attachments],
            },
            location.workspaceId,
            location.pathname,
          );
        } else {
          await saveWorkspaceDraft(draft, location.workspaceId, location.pathname);
        }
      });
    } catch (error) {
      draftDirtyRef.current = true;
      console.warn("[ChatComposer] workspace draft autosave failed", error);
    }
  }, [collectDraft, enqueueDraftWrite]);

  const scheduleDraftSave = useCallback(() => {
    if (!restoredDraftRef.current && !restoreFailedRef.current) return;
    draftDirtyRef.current = true;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      void saveDraftInBackground();
    }, 500);
  }, [saveDraftInBackground]);

  useEffect(() => {
    let alive = true;
    const location = currentWorkspaceDraftLocation();
    draftLocationRef.current = location;
    const restore = readWorkspaceDraft(location.workspaceId, location.pathname);
    if (!restoredDraftRef.current) {
      void restore
        .then((draft) => {
          if (!alive || restoredDraftRef.current) return;
          restoredDraftRef.current = true;
          if (!draft) {
            if (interactedBeforeRestoreRef.current) scheduleDraftSave();
            return;
          }
          const current = inputHandleRef.current?.getValue() || "";
          const restoredText = current ? `${draft.text}\n${current}` : draft.text;
          draftTextRef.current = restoredText;
          // Restoring is not user input; don't queue a save that would write
          // the draft straight back to storage.
          suppressDraftSaveRef.current = true;
          inputHandleRef.current?.setValue(restoredText);
          queueMicrotask(() => {
            suppressDraftSaveRef.current = false;
          });
          if (interactedBeforeRestoreRef.current) scheduleDraftSave();
          const files = draft.attachments
            .filter((item) => item.base64)
            .map((item) => {
              const bytes = Uint8Array.from(atob(item.base64!), (char) =>
                char.charCodeAt(0),
              );
              return new File([bytes], item.filename, {
                type: item.mimeType || "application/octet-stream",
              });
            });
          if (files.length) addDraftFilesRef.current(files);
        })
        .catch((error) => {
          if (!alive) return;
          restoreFailedRef.current = true;
          console.warn(
            "[ChatComposer] workspace draft restore failed; keeping the stored draft untouched",
            error,
          );
        });
    }
    // The stored draft never made it into the composer, so saving the composer
    // as-is could clobber it. Skip when nothing new was typed; otherwise merge
    // the new input on top of the stored draft. If even the re-read fails,
    // reject the switch (as on main) instead of losing the new input.
    const saveAfterFailedRestore = () => {
      restoreFailedRef.current = true;
      const draft = collectDraft();
      if (!draft.text && !draft.attachments.length) return Promise.resolve();
      const merge = (stored?: WorkspaceDraft) =>
        saveWorkspaceDraft(
          {
            text: [stored?.text, draft.text].filter(Boolean).join("\n"),
            attachments: [...(stored?.attachments ?? []), ...draft.attachments],
          },
          location.workspaceId,
          location.pathname,
        );
      // Re-read only once per mount so a retried switch merges the original
      // stored draft instead of re-appending the composer to itself. Autosave
      // shares the same cache: it may already have written base + typed text.
      if (restoreBaseRef.current !== null) return merge(restoreBaseRef.current);
      return readWorkspaceDraft(location.workspaceId, location.pathname).then((stored) => {
        restoreBaseRef.current = stored ?? { text: "", attachments: [] };
        return merge(restoreBaseRef.current);
      });
    };
    const save = (event: Event) => {
      (event as CustomEvent<Promise<void>[]>).detail.push(
        enqueueDraftWrite(async () => {
          // The switch (and any draft transfer before navigation) must wait
          // for older autosaves, including their asynchronous identity reads.
          await restore.catch(() => {
            restoreFailedRef.current = true;
          });
          const revision = draftRevisionRef.current;
          if (restoreFailedRef.current) {
            await saveAfterFailedRestore();
          } else {
            await saveWorkspaceDraft(collectDraft(), location.workspaceId, location.pathname);
          }
          // A successful switch already persisted this revision. Do not let
          // unmount restore a source draft that beforeNavigate just moved.
          // If the user typed while the save ran, keep that newer input dirty.
          if (draftRevisionRef.current === revision) cancelDraftSave();
        }),
      );
    };
    window.addEventListener("praxis:before-workspace-switch", save);
    return () => {
      alive = false;
      window.removeEventListener("praxis:before-workspace-switch", save);
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
      if (!draftDirtyRef.current) return;
      if (restoredDraftRef.current || restoreFailedRef.current) {
        void saveDraftInBackground();
        return;
      }
      // The composer unmounted before the stored draft arrived. Merge it with
      // whatever was typed so neither side is lost.
      void enqueueDraftWrite(async () => {
        let draft: WorkspaceDraft | undefined;
        try {
          draft = await restore;
        } catch {
          if (draftDirtyRef.current) await saveAfterFailedRestore();
          return;
        }
        if (!draftDirtyRef.current) return;
        const current = collectDraft();
        await saveWorkspaceDraft(
          {
            text: [draft?.text, current.text].filter(Boolean).join("\n"),
            attachments: [...(draft?.attachments ?? []), ...current.attachments],
          },
          location.workspaceId,
          location.pathname,
        );
      }).catch((error) => {
        console.warn("[ChatComposer] could not preserve draft after unmount", error);
      });
    };
  }, [cancelDraftSave, collectDraft, enqueueDraftWrite, inputHandleRef, saveDraftInBackground, scheduleDraftSave]);

  // Attachments are part of the same draft. Their signature is a cheap way to
  // react to add/remove without re-saving on every parent render.
  const attachmentSignature = attachments
    .map((item) => `${item.filename}:${item.base64?.length ?? 0}:${item.mimeType ?? ""}`)
    .join("|");
  const attachmentsInitializedRef = useRef(false);
  useEffect(() => {
    if (!attachmentsInitializedRef.current) {
      attachmentsInitializedRef.current = true;
      return;
    }
    if (suppressDraftSaveRef.current) return;
    draftRevisionRef.current += 1;
    if (!restoredDraftRef.current && !restoreFailedRef.current) {
      interactedBeforeRestoreRef.current = true;
      draftDirtyRef.current = true;
      return;
    }
    draftLocationRef.current = currentWorkspaceDraftLocation();
    scheduleDraftSave();
  }, [attachmentSignature, scheduleDraftSave]);

  const notifyDraftTextChange = useCallback(
    (val: string) => {
      draftTextRef.current = val;
      if (suppressDraftSaveRef.current) return;
      draftRevisionRef.current += 1;
      if (!restoredDraftRef.current && !restoreFailedRef.current) {
        interactedBeforeRestoreRef.current = true;
        draftDirtyRef.current = true;
        return;
      }
      draftLocationRef.current = currentWorkspaceDraftLocation();
      scheduleDraftSave();
    },
    [scheduleDraftSave],
  );

  const clearDraftOnSend = useCallback(() => {
    if (restoredDraftRef.current && !restoreFailedRef.current) {
      const location = draftLocationRef.current ?? currentWorkspaceDraftLocation();
      void enqueueDraftWrite(() =>
        saveWorkspaceDraft(
          { text: "", attachments: [] },
          location.workspaceId,
          location.pathname,
        ),
      ).catch(() => {});
    }
    // Suppress the draft save that the clear below would otherwise queue:
    // the message is sent, so there is nothing left to restore.
    suppressDraftSaveRef.current = true;
    inputHandleRef.current?.clear();
    draftTextRef.current = "";
    queueMicrotask(() => {
      suppressDraftSaveRef.current = false;
    });
    cancelDraftSave();
  }, [cancelDraftSave, enqueueDraftWrite, inputHandleRef]);

  return { notifyDraftTextChange, clearDraftOnSend };
}
