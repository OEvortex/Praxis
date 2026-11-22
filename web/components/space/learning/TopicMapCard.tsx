'use client'

import { masteryTopicRoute } from '@/lib/learning-routes'

import Link from '@/shared/router/link'

import { CircleCheck, Route } from 'lucide-react'

import type { MasteryTopic } from '@/lib/learning-api'

import { topicDisplayName } from './format'
import { LearningCardContent } from '@/components/learning/LearningCard'

export function TopicMapCard({ topic }: { topic: MasteryTopic }) {
  
  const { map, metadata } = topic
  const total = map.counts.total
  const mastered = map.counts.mastered
  const progress = total ? mastered / total : 0
  const displayName = topicDisplayName(topic)

  return (
    <Link
      href={masteryTopicRoute(topic.path_id, topic.content_workspace_id)}
      aria-label={`Open ${displayName}, ${mastered} of ${total} knowledge points complete`}
      className="mastery-map-card group block overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
    >
      <div className="flex items-center gap-3 p-4">
        <LearningCardContent
          title={displayName}
          subtitle={metadata.description || metadata.goal}
          icon={map.complete ? <CircleCheck size={19} /> : <Route size={19} />}
          updatedAt={topic.updated_at}
          progress={progress}
        />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--border)] px-4 py-3 text-[11px] text-[var(--muted-foreground)]">
        <span>{(map.modules.length === 1 ? `${map.modules.length} module` : `${map.modules.length} modules`)}</span>
        <span>
          {mastered}/{total} {"knowledge points"}
        </span>
        <span>{(topic.session_count === 1 ? `${topic.session_count} session` : `${topic.session_count} sessions`)}</span>
      </div>
    </Link>
  )
}
