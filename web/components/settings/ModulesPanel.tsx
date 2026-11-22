"use client";


import { useModules } from "@/hooks/useModules";

export default function ModulesPanel() {
  
  const { modules, error, reload } = useModules();
  return (
    <section className="my-6 rounded-xl border p-5">
      <h2 className="text-lg font-semibold">{"Modules"}</h2>
      <p className="my-2 text-sm text-[var(--muted-foreground)]">
        {"Stop Praxis before changing modules. Removing a module keeps your data."}
      </p>
      {error && <button onClick={reload}>{"Retry"}</button>}
      {!modules && !error && <p aria-busy="true">{"Loading..."}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead><tr>
            <th className="py-2">{"Module"}</th><th>{"Installed"}</th>
            <th>{"Enabled"}</th><th>{"Ready"}</th><th>{"Command"}</th>
          </tr></thead>
          <tbody>{modules?.map(module => <tr key={module.id} className="border-t align-top">
            <td className="py-2 pr-3"><code>{module.id}</code>
              {module.issues.map(issue => <p key={issue} className="max-w-md text-xs text-[var(--muted-foreground)]">{issue}</p>)}
            </td>
            {[module.installed, module.enabled, module.ready].map((value, index) =>
              <td className="py-2 pr-3" key={index}>{value ? "Yes" : "No"}</td>)}
            <td className="py-2"><code>{module.id === "core" ? "—" :
              `praxis module ${!module.installed ? "install" : !module.enabled ? "enable" : "disable"} ${module.id}`}</code></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}
