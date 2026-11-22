"use client";

import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";
export default function LlmSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Language models"}
        description={"Manage language models and their context, capabilities, and connection tests."}
      />
      <ModelsWorkspace page="llm" />
    </div>
  );
}
