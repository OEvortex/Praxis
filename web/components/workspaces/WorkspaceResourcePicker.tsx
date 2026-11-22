'use client'

import { useEffect, useState } from 'react'
import Link from '@/shared/router/link'

import {
  getWorkspaceResources,
  type WorkspaceResources,
  type WorkspaceResourceCatalog,
} from '@/lib/workspaces-api'

export function WorkspaceResourcePicker({
  value,
  onChange,
  workspaceId = '',
}: {
  value: WorkspaceResources
  onChange: (value: WorkspaceResources) => void
  workspaceId?: string
}) {
  
  const [catalog, setCatalog] = useState<WorkspaceResourceCatalog | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    getWorkspaceResources(workspaceId)
      .then(result => {
        if (active) {
          setCatalog(result)
          setError('')
        }
      })
      .catch(err => {
        if (active) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      active = false
    }
  }, [workspaceId, attempt])
  const groups = [
    { key: 'knowledge_bases' as const, label: 'Knowledge bases', href: '/knowledge-bases' },
  ]
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium">{"Assigned resources"}</h4>
        <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">
          {"Resources are managed in Learning Space. Assigning them creates references; removing an assignment keeps the original resource."}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-[var(--destructive)]">
          {error}{' '}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setError('')
              setCatalog(null)
              setAttempt(n => n + 1)
            }}
          >
            {"Retry"}
          </button>
        </p>
      )}
      {groups.map(({ key, label, href }) => {
        const selected = value[key]
        const items = catalog?.[key] ?? []
        const missing = (selected ?? []).filter(id => !items.some(item => item.id === id))
        return (
          <fieldset key={key} className="rounded-lg border border-[var(--border)] p-3">
            <legend className="px-1 text-xs font-medium">{(label)}</legend>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <select
                aria-label={`${(label)} assignment mode`}
                value={selected === null ? 'inherit' : 'selected'}
                className="max-w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs"
                onChange={event =>
                  onChange({ ...value, [key]: event.target.value === 'inherit' ? null : [] })
                }
              >
                <option value="inherit">{"Inherit available resources"}</option>
                <option value="selected">{"Only selected resources"}</option>
              </select>
              <Link
                className="text-xs underline underline-offset-2 text-[var(--muted-foreground)]"
                href={href}
              >
                {"Manage library"}
              </Link>
            </div>
            {selected === null ? (
              <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                {"Keeps existing access rules. Newly available resources are included automatically."}
              </p>
            ) : (
              <>
                {!catalog && !error && (
                  <p role="status" className="mt-2 text-xs">
                    {"Loading resources…"}
                  </p>
                )}
                {catalog && !items.length && (
                  <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                    {"No resources available. Add resources in Learning Space first."}
                  </p>
                )}
                <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">
                  {items.map(item => (
                    <label
                      key={item.id}
                      className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-[var(--muted)]"
                    >
                      <input
                        className="mt-0.5"
                        type="checkbox"
                        checked={selected.includes(item.id)}
                        onChange={event =>
                          onChange({
                            ...value,
                            [key]: event.target.checked
                              ? [...selected, item.id]
                              : selected.filter(id => id !== item.id),
                          })
                        }
                      />
                      <span className="min-w-0 text-xs">
                        <span className="break-words font-medium">{item.name}</span>
                        <span className="ml-2 text-[var(--muted-foreground)]">
                          {item.provenance_label || (item.source || 'account')}
                        </span>
                        {item.description && (
                          <span className="mt-0.5 block text-[var(--muted-foreground)]">
                            {item.description}
                          </span>
                        )}
                        {item.available === false && (
                          <span className="ml-2 text-[var(--muted-foreground)]">
                            {"Currently unavailable"}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                  {catalog &&
                    missing.map(id => (
                      <label
                        key={id}
                        className="flex items-start gap-2 p-2 text-xs text-[var(--muted-foreground)]"
                      >
                        <input
                          type="checkbox"
                          checked
                          onChange={() =>
                            onChange({ ...value, [key]: selected.filter(item => item !== id) })
                          }
                        />
                        <span>
                          {id} — {"Resource missing or access removed"}
                        </span>
                      </label>
                    ))}
                </div>
                <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                  {selected.length
                    ? `${selected.length} resources selected`
                    : "None selected. This resource type is unavailable in this workspace."}
                </p>
              </>
            )}
          </fieldset>
        )
      })}
    </div>
  )
}
