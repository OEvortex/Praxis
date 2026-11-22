'use client'
import Link from '@/shared/router/link'
import { Plus } from 'lucide-react'

import Tooltip from '@/shared/ui/Tooltip'
import { pageActionClass } from '@/components/layout/FeaturePage'
import { useSidebarDrawer } from '@/components/layout/AppShell'
import { scopedUrl, activeWorkspaceId } from '@/lib/workspace-scope'

/** All creation entry points share a bookmarkable page instead of a transient menu. */
export function LearningCreateMenu({ compact = false }: { compact?: boolean }) {
  
  const drawer = useSidebarDrawer()
  return (
    <Tooltip label={"New learning activity"}>
      <Link
        href={scopedUrl('/learning/new', activeWorkspaceId())}
        aria-label={"New learning activity"}
        onClick={() => drawer?.close()}
        className={compact ? 'dt-nav-icon' : pageActionClass()}
      >
        <Plus size={compact ? 17 : 15} />
        {!compact && "New learning activity"}
      </Link>
    </Tooltip>
  )
}
