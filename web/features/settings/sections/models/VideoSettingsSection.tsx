"use client";

import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";
export default function VideoSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Multimodal generation"}
        description={"Manage image and video generation models using saved providers."}
      />
      <ModelsWorkspace page="multimodal" initialService="videogen" />
    </div>
  );
}
