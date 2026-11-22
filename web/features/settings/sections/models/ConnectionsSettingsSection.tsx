"use client";



import { ProvidersWorkspace } from "@/components/settings/ProvidersWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";

export default function ConnectionsSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Providers"}
        description={"Manage provider names, URLs, and credentials. Configure models on their own pages."}
      />
      <ProvidersWorkspace />
    </div>
  );
}
