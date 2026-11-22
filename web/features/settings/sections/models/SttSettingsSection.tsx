"use client";

import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";
export default function SttSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Voice services"}
        description={"Manage speech synthesis and transcription models using saved providers."}
      />
      <ModelsWorkspace page="voice" initialService="stt" />
    </div>
  );
}
