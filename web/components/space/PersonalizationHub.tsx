"use client";


import { FeaturePage } from "@/components/layout/FeaturePage";
import SpaceDashboard from "@/components/space/SpaceDashboard";
import { PERSONALIZATION_GROUPS } from "@/components/space/dashboard-groups";
import { PersonalizationShelfIcon } from "@/components/sidebar/ShelfIcons";

/** The account's own shelf: the same in every workspace. */
export function PersonalizationHub() {
  
  return (
    <FeaturePage>
      <SpaceDashboard
        icon={PersonalizationShelfIcon}
        title={"Personalization"}
        description={"Your agents, response styles, skills, connectors and memory. They follow your account into every workspace."}
        groups={PERSONALIZATION_GROUPS}
      />
    </FeaturePage>
  );
}
