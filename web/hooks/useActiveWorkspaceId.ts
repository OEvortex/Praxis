'use client'

import { useSearchParams } from '@/shared/router/navigation'
import { activeWorkspaceId, workspaceIdOf } from '@/lib/workspace-scope'

/** The workspace this tab is in, for render: the URL's, else the one it stayed in. */
export function useActiveWorkspaceId(): string {
  return workspaceIdOf(useSearchParams()) ?? activeWorkspaceId()
}
