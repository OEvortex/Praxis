import type { ReactNode } from "react";
import { Activity, Plus, X } from "lucide-react";

import ResponderFace from "@/components/chat/home/ResponderFace";
import Tooltip from "@/shared/ui/Tooltip";
import { tabIcon } from "./helpers";
import type { ViewerTab } from "./types";

const TAB_PILL =
  "inline-flex h-7 shrink-0 items-center rounded-lg text-[12.5px] font-medium transition-colors";
const TAB_ACTIVE =
  "bg-[color-mix(in_srgb,var(--muted)_85%,transparent)] text-[var(--foreground)]";
const TAB_IDLE =
  "text-[var(--muted-foreground)] hover:bg-[color-mix(in_srgb,var(--muted)_55%,transparent)] hover:text-[var(--foreground)]";
const TAB_FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--ring)]";
export const HEADER_ICON = `inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[color-mix(in_srgb,var(--muted)_70%,transparent)] hover:text-[var(--foreground)] disabled:pointer-events-none disabled:opacity-40 ${TAB_FOCUS}`;

export function ViewerTabBar({
  tabs,
  activeTabId,
  homeActive,
  onSelectHome,
  onSelect,
  onCloseTab,
  onNewTab,
  onClosePanel,
  agents,
  actions,
}: {
  tabs: ViewerTab[];
  agents: { name: string; kind?: string }[];
  activeTabId: string | null;
  homeActive: boolean;
  onSelectHome: () => void;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onClosePanel: () => void;
  actions?: ReactNode;
}) {
  
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 pl-2.5 pr-2">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          type="button"
          onClick={onSelectHome}
          aria-pressed={homeActive}
          className={`${TAB_PILL} ${TAB_FOCUS} gap-1.5 px-2.5 ${homeActive ? TAB_ACTIVE : TAB_IDLE}`}
        >
          <Activity size={13} strokeWidth={1.8} className="shrink-0" />
          <span>{"Activity"}</span>
        </button>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const Icon = tabIcon(tab);
          return (
            <div
              key={tab.id}
              className={`group ${TAB_PILL} max-w-[190px] ${active ? TAB_ACTIVE : TAB_IDLE}`}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                aria-pressed={active}
                aria-label={tab.label}
                className={`inline-flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg pl-2.5 pr-1 text-left ${TAB_FOCUS}`}
              >
                {tab.kind === "side-chat" && tab.context.sideChat ? (
                  <ResponderFace
                    responder={tab.context.sideChat.responder}
                    agents={agents}
                    size={13}
                  />
                ) : (
                  <Icon size={13} strokeWidth={1.8} className="shrink-0" />
                )}
                <span className="truncate">{tab.label}</span>
              </button>
              <Tooltip label={"Close tab"} side="bottom">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className={`mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-[opacity,background-color,color] hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] hover:text-[var(--foreground)] focus-visible:opacity-100 ${TAB_FOCUS} ${
                    active ? "opacity-70" : "opacity-0 group-hover:opacity-70"
                  }`}
                  aria-label={"Close tab"}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </Tooltip>
            </div>
          );
        })}
      </div>
      {actions ? (
        <>
          {actions}
          <span
            aria-hidden="true"
            className="mx-1 h-4 w-px shrink-0 bg-[color-mix(in_srgb,var(--border)_85%,transparent)]"
          />
        </>
      ) : null}
      <Tooltip label={"New tab"} side="bottom">
        <button
          type="button"
          onClick={onNewTab}
          className={HEADER_ICON}
          aria-label={"New tab"}
        >
          <Plus size={16} strokeWidth={1.8} />
        </button>
      </Tooltip>
      <Tooltip label={"Close viewer"} side="bottom">
        <button
          type="button"
          onClick={onClosePanel}
          className={HEADER_ICON}
          aria-label={"Close viewer"}
        >
          <X size={15} strokeWidth={1.8} />
        </button>
      </Tooltip>
    </div>
  );
}
