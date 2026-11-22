"use client";

import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { WebFetchBackendCard } from "@/components/settings/WebFetchBackendCard";
import { SettingsPageHeader } from "@/components/settings/shared";
export default function SearchSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Search"}
        description={"Configure and test search engines using saved providers."}
      />
      <ModelsWorkspace page="search" />
      <WebFetchBackendCard />
    </div>
  );
}
