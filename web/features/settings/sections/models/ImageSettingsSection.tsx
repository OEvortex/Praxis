"use client";

import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";
export default function ImageSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Multimodal generation"}
        description={"Manage image and video generation models using saved providers."}
      />
      <ModelsWorkspace page="multimodal" initialService="imagegen" />
    </div>
  );
}
