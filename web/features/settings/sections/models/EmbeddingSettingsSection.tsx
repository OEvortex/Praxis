"use client";

import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";
export default function EmbeddingSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Embedding models"}
        description={"Manage embedding models for retrieval and knowledge bases."}
      />
      <ModelsWorkspace page="embedding" />
    </div>
  );
}
