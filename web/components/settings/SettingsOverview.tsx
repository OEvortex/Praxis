"use client";

import Link from "@/shared/router/link";
import { useCallback, type SetStateAction } from "react";
import { ArrowRight } from "lucide-react";

import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
  selectClass,
  selectOptionClass,
} from "./shared";
import { useSettings } from "@/features/settings/store/SettingsStore";
import { useStagedSettings } from "@/features/settings/store/useStagedSettings";
import { useUiLayout } from "@/hooks/useUiLayout";
import { UI_LAYOUTS, writeStoredUiLayout, type UiLayout } from "@/lib/ui-layout";

const UI_LAYOUT_LABELS: Record<UiLayout, string> = {
  classic: "Classic",
  modern: "Modern",
};

export default function SettingsOverview() {
  
  const { catalogEditable } = useSettings();
  const uiLayout = useUiLayout();
  const setLiveUiLayout = useCallback(
    (action: SetStateAction<UiLayout>) =>
      writeStoredUiLayout(typeof action === "function" ? action(uiLayout) : action),
    [uiLayout],
  );
  const [stagedUiLayout, stageUiLayout] = useStagedSettings(
    "ui-layout",
    uiLayout,
    setLiveUiLayout,
  );
  return (
    <div>
      <SettingsPageHeader
        title={"General"}
        description={"Make Praxis feel at home. Apply your preferences using the bar below."}
      />
      <SettingSection title={"Layout"}>
        <SettingRow
          title={"Interface layout"}
          description={"Classic keeps the familiar navigation; Modern is the redesigned interface."}
          control={
            <select
              aria-label={"Interface layout"}
              value={stagedUiLayout}
              onChange={(event) => stageUiLayout(event.target.value as UiLayout)}
              className={`${selectClass} min-w-[200px] pr-8`}
            >
              {UI_LAYOUTS.map((layout) => (
                <option key={layout} value={layout} className={selectOptionClass}>
                  {(UI_LAYOUT_LABELS[layout])}
                </option>
              ))}
            </select>
          }
        />
      </SettingSection>
      {catalogEditable && <SettingSection
        title={"Add more when you need it"}
        description={"These services are not required for basic chat."}
      >
        {[
          { href: "/settings/embedding", title: "Knowledge search", description: "Configure an embedding model before indexing a knowledge base." },
          { href: "/settings/task-models", title: "Background task models", description: "Choose models for automatic tasks such as titles and suggestions." },
        ].map(item => (
          <Link key={item.href} href={item.href} className="flex items-center justify-between gap-5 border-b border-[var(--border)]/50 py-4 last:border-0 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ring)]">
            <div>
              <div className="text-[14px] font-medium">{item.title}</div>
              <p className="mt-1 text-[13px] text-[var(--muted-foreground)]">{item.description}</p>
            </div>
            <ArrowRight size={17} className="shrink-0 text-[var(--muted-foreground)]" />
          </Link>
        ))}
      </SettingSection>}
    </div>
  );
}
