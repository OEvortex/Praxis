"use client";

import { TaskModelsWorkspace } from "@/components/settings/TaskModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";
export default function TaskModelsSettingsPage() {
  
  return (
    <div>
      <SettingsPageHeader
        title={"Task models"}
        description={"The model behind the calls Praxis makes on its own — titles, suggestions, lookups. Set one for all of them, or give a task its own."}
      />
      <TaskModelsWorkspace />
    </div>
  );
}
