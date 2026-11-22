'use client'

import { useId } from 'react'

import { inputClass } from '@/components/settings/shared'

export function WorkspaceInstructionsField({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  
  const id = useId()
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        {"Workspace instructions"}
      </label>
      <p
        id={`${id}-description`}
        className="text-xs leading-relaxed text-[var(--muted-foreground)]"
      >
        {"Set learning goals, teaching style and response preferences for this workspace. Leave blank to use the default behavior."}
      </p>
      <textarea
        id={id}
        aria-describedby={`${id}-description ${id}-scope`}
        className={`${inputClass} min-h-36 resize-y leading-relaxed`}
        value={value}
        onChange={event => onChange(event.target.value)}
        maxLength={10000}
        rows={6}
        placeholder={"For example: I am learning linear algebra. Explain the geometric intuition before introducing formulas, and give hints before complete solutions."}
      />
      <p id={`${id}-scope`} className="text-xs leading-relaxed text-[var(--muted-foreground)]">
        {"Applies to Chat, Solve, Ask Questions, Guided Learning, Reading and standard visualizations. Changes take effect on the next turn."}
      </p>
      <div className="flex items-center justify-between gap-3 text-xs text-[var(--muted-foreground)]">
        <button
          type="button"
          onClick={() => onChange('')}
          disabled={!value}
          className="underline underline-offset-2 disabled:opacity-50"
        >
          {"Clear instructions"}
        </button>
        <span>{`${value.length} / ${10000} characters`}</span>
      </div>
    </div>
  )
}
