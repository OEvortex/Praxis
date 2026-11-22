'use client'

import { usePathname } from '@/shared/router/navigation'

import { useActiveWorkspaceId } from '@/hooks/useActiveWorkspaceId'
import { useChatWorkspaces } from '@/hooks/useChatWorkspaces'
import { selectWorkspace } from '@/lib/workspace-scope'
import { switchDestination } from '@/components/sidebar/page-sections'

/** The workspace this URL is scoped to, the ones it can switch to, and the switch. */
export function useWorkspaceChoices() {
  
  const pathname = usePathname() ?? '/'
  const active = useActiveWorkspaceId()
  const { workspaces } = useChatWorkspaces()
  const current = workspaces.find(row => row.workspace_id === active)
  const currentName = active ? (current?.display_name ?? "Workspace unavailable") : "General workspace"
  const choices = [
    { workspace_id: '', display_name: "General workspace" },
    ...workspaces.filter(row => row.workspace_id === active || (!row.archived && row.status === 'ready')),
  ]
  const choose = (workspaceId: string) => {
    if (workspaceId !== active) void selectWorkspace(workspaceId, switchDestination(pathname))
  }
  return { active, currentName, choices, choose }
}
