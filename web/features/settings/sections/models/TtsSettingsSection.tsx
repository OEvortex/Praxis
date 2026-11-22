"use client";

import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";
import { VoicePlaybackPrefs } from "./VoicePlaybackPrefs";
export default function TtsSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Voice services"}
        description={"Manage speech synthesis and transcription models using saved providers."}
      />
      <VoicePlaybackPrefs />
      <ModelsWorkspace page="voice" initialService="tts" />
    </div>
  );
}
