"use client";

import { useEffect } from "react";

import type { SessionViewerPanelHandle } from "@/components/chat/home/SessionViewerPanel";
import { useGeogebraTabOpener } from "@/context/GeogebraTabContext";
import { useOptionalQuizFollowupController } from "@/context/QuizFollowupContext";

/** Connect in-message Quiz/GeoGebra actions to a surface's shared viewer. */
export function ChatViewerBridges({
  viewerPanelRef,
}: {
  viewerPanelRef: React.MutableRefObject<SessionViewerPanelHandle | null>;
}) {
  const quiz = useOptionalQuizFollowupController();
  const geogebra = useGeogebraTabOpener();

  useEffect(() => {
    if (!quiz) return;
    quiz.setOpenTabHandler((context) => {
      viewerPanelRef.current?.openQuizFollowupTab(context);
    });
    return () => quiz.setOpenTabHandler(null);
  }, [quiz, viewerPanelRef]);

  useEffect(() => {
    if (!geogebra) return;
    geogebra.setOpenHandler((payload) => {
      viewerPanelRef.current?.openGeogebraTab(payload);
    });
    return () => geogebra.setOpenHandler(null);
  }, [geogebra, viewerPanelRef]);

  return null;
}
