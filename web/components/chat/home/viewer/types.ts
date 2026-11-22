import type { ReactNode } from "react";
import { Bot, MessagesSquare, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import type { FilePreviewSource } from "@/components/chat/preview/previewerFor";
import type { SessionActivity } from "@/components/chat/home/SessionActivityPanel";
import type { ComposerResourceCatalog } from "@/hooks/useComposerResources";
import type { QuizFollowupTabContext } from "@/context/QuizFollowupContext";
import type { GeogebraTabPayload } from "@/context/GeogebraTabContext";
import type { MessageAttachment } from "@/features/chat/ChatStateAdapter";
import type { StreamEvent } from "@/features/chat/model/protocol";
import type { SideChatResponder } from "@/lib/side-chat";
import type { SessionSummary } from "@/lib/session-api";

export const VIEWER_WIDTH_VAR = "--viewer-width";
export const VIEWER_WIDTH_KEY = "dt:viewer-width";
export const VIEWER_WIDTH_DEFAULT = 520;
export const VIEWER_WIDTH_MIN = 400;
export const VIEWER_WIDTH_MAX = 960;

export const VIEWER_TABS_STORAGE_PREFIX = "dt:chat:viewer-tabs:";
export const STASHED_CONVERSATIONS = 12;
export const RECENTLY_CLOSED_LIMIT = 4;

export const NO_AGENTS: { name: string; kind?: string }[] = [];

export const RESPONDER_ICONS: Record<SideChatResponder["kind"], LucideIcon> = {
  dito: MessagesSquare,
  partner: UserRound,
  subagent: Bot,
  partner_group: UsersRound,
};

export type ViewerTab =
  | { kind: "file"; id: string; label: string; source: FilePreviewSource }
  | { kind: "web"; id: string; label: string; url: string }
  | { kind: "markdown-note"; id: string; label: string }
  | {
      kind: "quiz-followup";
      id: string;
      label: string;
      context: QuizFollowupTabContext;
    }
  | {
      kind: "side-chat";
      id: string;
      label: string;
      context: QuizFollowupTabContext;
    }
  | {
      kind: "geogebra";
      id: string;
      label: string;
      script: string;
      editable?: boolean;
    }
  | { kind: "new"; id: string; label: string }
  | {
      kind: "subagent";
      id: string;
      label: string;
      callId: string;
      events: StreamEvent[];
    };

export interface SessionViewerPanelHandle {
  openFileTab(a: MessageAttachment): void;
  openWebTab(url: string): void;
  openMarkdownNoteTab(): void;
  openQuizFollowupTab(context: QuizFollowupTabContext): void;
  openSideChatTab(options?: SideChatOpenOptions): void;
  openSideChatThread(thread: SessionSummary): void;
  closeSideChatThread(sessionId: string): void;
  clearSideChatSource(
    sessionId: string,
    sourceMessageId: number | string | null,
  ): void;
  openGeogebraTab(payload: GeogebraTabPayload): void;
  openSubagentTab(
    callId: string,
    label: string,
    events: StreamEvent[],
    focus?: boolean,
  ): void;
  focusActivityHome(): void;
}

export interface SideChatOpenOptions {
  responder?: SideChatResponder;
  quote?: string;
  sourceMessageId?: number | string | null;
}

export interface ViewerConversation {
  title: string;
  leafMessageId: number | null;
  language: string;
}

export interface SessionViewerPanelProps {
  open: boolean;
  sessionId: string | null;
  sessionKey?: string;
  reboundFromKey?: string | null;
  conversation?: ViewerConversation | null;
  workspaceId?: string | null;
  threads?: SessionSummary[];
  onClose: () => void;
  onAutoOpen: () => void;
  activity: SessionActivity;
  configSection?: ReactNode;
  taskDraftIds?: string[];
  onTaskDraftChange?: (ids: string[]) => void;
  resourceCatalog?: ComposerResourceCatalog;
  agents?: { name: string; kind?: string }[];
}

export interface PersistedSideChatTab {
  id: string;
  label: string;
  questionKey: string;
  followupSessionId: string;
  language: string;
  sideChat: {
    parentSessionId: string | null;
    leafMessageId: number | null;
    sourceMessageId: number | string | null;
    parentTitle?: string;
    responder: SideChatResponder;
  };
}

export interface PersistedViewerTabs {
  version: 1;
  tabs: PersistedSideChatTab[];
  activeTabId: string | null;
}

export interface StashedTabs {
  tabs: ViewerTab[];
  activeTabId: string | null;
  closedTabs: ViewerTab[];
}
