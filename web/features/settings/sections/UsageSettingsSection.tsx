'use client'

import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useRouter, useSearchParams } from '@/shared/router/navigation'

import { SettingsPageHeader } from '@/components/settings/shared'
import { fetchUsageStatistics, usageYear, type UsageStatistics } from '@/lib/usage-statistics'
import UsageActivity from '../components/UsageActivity'
import { isApiError } from '@/shared/api/errors'

export default function UsageSettingsSection() {
  
  const router = useRouter()
  const search = useSearchParams()
  const currentYear = new Date().getFullYear()
  const year = usageYear(search.get('year'), currentYear)
  const [snapshot, setSnapshot] = useState<{
    key: string
    data: UsageStatistics | null
    error: string | null
  } | null>(null)
  const [revision, setRevision] = useState(0)
  const requestKey = `${year}:${revision}`
  const data = snapshot?.data
  const loading = snapshot?.key !== requestKey
  const error = !loading && Boolean(snapshot?.error)
  useEffect(() => {
    const controller = new AbortController()
    fetchUsageStatistics(year, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setSnapshot({ key: requestKey, data: value, error: null })
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setSnapshot(previous => ({
            key: requestKey,
            data: previous?.data ?? null,
            error: failure instanceof Error
              ? `${failure.message}${isApiError(failure) && failure.status ? ` (HTTP ${failure.status})` : ''}`
              : 'Unable to load usage statistics.',
          }))
      })
    return () => controller.abort()
  }, [year, requestKey])
  const changeYear = (next: number) => {
    const query = new URLSearchParams(search.toString())
    query.set('year', String(next))
    router.push(`/settings/usage?${query}`, { scroll: false })
  }
  const n = (value?: number | null) => (value == null ? '—' : value.toLocaleString("en"))
  const percent = (value?: number | null) => (value == null ? '—' : `${(value * 100).toFixed(1)}%`)
  const visible = data?.year === year ? data : null
  const stats = visible?.totals
  const models = visible?.models.filter(model => model.model) ?? []
  const historical = visible?.models.filter(model => !model.model) ?? []
  return (
    <div>
      <SettingsPageHeader
        title={"Usage statistics"}
        description={"Model usage across conversations, personalized learning, and background tasks."}
      />
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-3 rounded-lg border border-[var(--border)] px-1 py-1">
          <button
            type="button"
            aria-label={"Previous year"}
            disabled={year <= 1970}
            onClick={() => changeYear(year - 1)}
            className="rounded-md p-1.5 hover:bg-[var(--muted)] disabled:opacity-30"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="min-w-12 text-center text-sm font-medium tabular-nums">{year}</span>
          <button
            type="button"
            aria-label={"Next year"}
            disabled={year >= currentYear}
            onClick={() => changeYear(year + 1)}
            className="rounded-md p-1.5 hover:bg-[var(--muted)] disabled:opacity-30"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <button
          type="button"
          aria-label={"Refresh usage"}
          disabled={loading}
          onClick={() => setRevision(value => value + 1)}
          className="rounded-lg p-2 text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-40"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-5 flex items-center justify-between rounded-lg bg-[var(--destructive)]/5 px-3 py-2 text-xs text-[var(--destructive)]"
        >
          <span>
            {"Unable to load usage statistics."}
            {snapshot?.error && <span className="mt-1 block break-words">{(snapshot.error)}</span>}
          </span>
          <button
            type="button"
            onClick={() => setRevision(value => value + 1)}
            className="px-2 py-1 font-medium"
          >
            {"Retry"}
          </button>
        </div>
      )}
      {loading && !visible && (
        <div role="status" className="py-16 text-center text-sm text-[var(--muted-foreground)]">
          {"Loading usage…"}
        </div>
      )}
      {visible && (
        <div className="space-y-6" aria-busy={loading}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {[
              ["Total tokens", visible.tracked_turns ? n(stats?.total_tokens) : '—'],
              ["Input tokens", visible.tracked_turns ? n(stats?.prompt_tokens) : '—'],
              ["Output tokens", visible.tracked_turns ? n(stats?.completion_tokens) : '—'],
              ["Cache hit rate", percent(stats?.cache_hit_rate)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="mb-1.5 text-xs text-[var(--muted-foreground)]">{label}</dt>
                <dd className="text-xl font-semibold tracking-tight tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <UsageActivity
            key={year}
            days={visible.days}
            year={year}
            activeDays={visible.active_days}
            turns={visible.turns}
          />
          <section aria-label={"Usage by model"}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-medium">{"Usage by model"}</h2>
              <span className="text-xs text-[var(--muted-foreground)]">
                {`${n(stats?.total_calls)} LLM calls · ${n(visible.sessions)} sessions`}
              </span>
            </div>
            {models.length ? (
              <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                <table className="w-full min-w-[720px] text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--muted)]/40 text-[11px] text-[var(--muted-foreground)]">
                      {[
                        "Model",
                        "Total tokens",
                        "Input tokens",
                        "Output tokens",
                        "Cache hit rate",
                        "LLM calls",
                        "TTFT",
                        "TPS",
                      ].map((label, index) => (
                        <th
                          key={label}
                          scope="col"
                          className={`px-3 py-3 font-medium ${index ? 'text-right' : 'text-left'}`}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {models.map(model => (
                      <tr
                        key={JSON.stringify([model.provider, model.model])}
                        className="border-b border-[var(--border)]/60 last:border-0 hover:bg-[var(--muted)]/30"
                      >
                        <th
                          scope="row"
                          className="max-w-[220px] break-words px-3 py-3 text-left font-medium"
                        >
                          <span className="block">{model.model}</span>
                          {model.provider && (
                            <span className="mt-1 block text-[10px] font-normal text-[var(--muted-foreground)]">
                              {model.provider}
                            </span>
                          )}
                        </th>
                        <td className="px-3 py-3 text-right font-medium">
                          {n(model.total_tokens)}
                        </td>
                        <td className="px-3 py-3 text-right">{n(model.prompt_tokens)}</td>
                        <td className="px-3 py-3 text-right">{n(model.completion_tokens)}</td>
                        <td className="px-3 py-3 text-right">{percent(model.cache_hit_rate)}</td>
                        <td className="px-3 py-3 text-right">{n(model.total_calls)}</td>
                        <td className="whitespace-nowrap px-3 py-3 text-right">
                          {model.ttft_seconds == null
                            ? '—'
                            : `${model.ttft_seconds.toFixed(2)} s`}
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 text-right">
                          {model.tokens_per_second == null
                            ? '—'
                            : `${model.tokens_per_second.toFixed(1)} tok/s`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-[var(--border)] px-5 py-10 text-center text-sm text-[var(--muted-foreground)]">
                {"No recorded model usage for this year."}
              </div>
            )}
            {historical.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted-foreground)]">
                <span>{"Historical usage without recoverable model details"}</span>
                <span className="tabular-nums">{n(historical.reduce((sum, model) => sum + model.total_tokens, 0))} tokens</span>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
