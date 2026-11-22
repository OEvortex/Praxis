"use client";


import { SettingsPageHeader } from "./shared";
import ModulesPanel from "./ModulesPanel";
import SettingsStatusPanel from "./SettingsStatusPanel";
import SettingsReadinessPanel from "./SettingsReadinessPanel";
import { useSettings } from "@/features/settings/store/SettingsStore";

export default function SettingsRuntimePage() {
  
  const { catalogEditable } = useSettings();
  return (
    <div>
      <SettingsPageHeader
        title={"Runtime status"}
        description={"Check configured services and resolve connection problems."}
      />
      <ModulesPanel />
      <SettingsStatusPanel />
      <SettingsReadinessPanel enabled={catalogEditable === true} />
    </div>
  );
}
