"use client";

import { PageHeader, pageActionClass, pageGridClass } from '@/components/layout/FeaturePage'
import Link from "@/shared/router/link";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Brain,
  Layers,
  Network,
  RefreshCw,
  Sparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";


import { apiFetch, apiUrl } from "@/shared/api/client";
import MemoryArchivedBanner from "@/components/memory/MemoryArchivedBanner";

interface DocOverview {
  layer: "L2" | "L3";
  key: string;
  exists: boolean;
  updated_at: string | null;
  entry_count: number;
  backlog: number;
}

interface OverviewResponse {
  docs: DocOverview[];
  backups: string[];
}

interface SnapshotResponse {
  surface: string;
  entities: unknown[];
}

const SURFACES = [
  "chat",
  "notebook",
  "quiz",
  "kb",
  "book",
  "partner",
  "cowriter",
] as const;

const L3_VISIBLE = ["recent", "profile", "scope"] as const;

export default function MemoryHub() {
  
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [l1Total, setL1Total] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ovRes, ...l1Counts] = await Promise.all([
        apiFetch(apiUrl("/api/memory/overview")).then((r) => r.json()),
        ...SURFACES.map((s) =>
          apiFetch(apiUrl(`/api/memory/snapshot/${s}`))
            .then((r) => r.json())
            .then((d: SnapshotResponse) => d?.entities?.length ?? 0)
            .catch(() => 0),
        ),
      ]);
      setOverview(ovRes as OverviewResponse);
      setL1Total(l1Counts.reduce<number>((acc, n) => acc + (n as number), 0));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const l2Docs = (overview?.docs || []).filter((d) => d.layer === "L2");
  const l3Docs = (overview?.docs || []).filter(
    (d) => d.layer === "L3" && d.key !== "preferences",
  );
  const l2Total = l2Docs.reduce((acc, d) => acc + d.entry_count, 0);
  const l3Total = l3Docs.reduce((acc, d) => acc + d.entry_count, 0);
  const latestBackup = overview?.backups?.[overview.backups.length - 1] ?? null;

  return (
    <div className="space-y-9">
      <PageHeader
        icon={Brain}
        title={"Memory"}
        description={"Everything Praxis remembers about you, organised across three layers. Click into any layer to inspect or curate it."}
        action={
        <div className="flex items-center gap-3 text-[12px] text-[var(--muted-foreground)]">
          <button
            type="button"
            onClick={() => void load()}
            className={pageActionClass('secondary')}
          >
            <RefreshCw
              className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"}
            />
            {"Refresh"}
          </button>
          <Link
            href="/settings#memory"
            className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-2.5 py-1 transition hover:bg-[var(--muted)]"
          >
            {"Memory settings"}
          </Link>
        </div>
        }
      />

      <div className={pageGridClass(3)}>
        <LayerCard
          href="/memory/l1"
          icon={Layers}
          title={"L1 · Workspace mirror"}
          tag={"Live"}
          stat={l1Total === null ? "…" : l1Total.toLocaleString()}
          statLabel={"entities tracked"}
          detail={`Snapshot of your live workspace across ${SURFACES.length} surfaces. Refresh to record changes.`}
        />
        <LayerCard
          href="/memory/l2"
          icon={Workflow}
          title={"L2 · Per-surface summaries"}
          tag={"Curated"}
          stat={l2Total.toLocaleString()}
          statLabel={`facts across ${l2Docs.length || SURFACES.length} surfaces`}
          detail={"Surface-specific facts extracted by the consolidator. Run Update / Audit / Dedup per doc."}
        />
        <LayerCard
          href="/memory/l3"
          icon={Network}
          title={"L3 · Cross-surface knowledge"}
          tag={"Synthesis"}
          stat={l3Total.toLocaleString()}
          statLabel={`propositions across ${l3Docs.length || L3_VISIBLE.length} slots`}
          detail={"Cross-surface synthesis: profile, recent timeline, knowledge scope. Hedged claims with L2 evidence."}
        />
      </div>

      <GraphCallout />

      <MemoryArchivedBanner latestBackup={latestBackup} variant="compact" />
    </div>
  );
}

function GraphCallout() {
  
  return (
    <Link
      href="/memory/graph"
      className="group relative block overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 transition hover:-translate-y-[1px] hover:border-[var(--primary)]/40 hover:shadow-sm"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(ellipse 60% 80% at 92% 50%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 70%)",
        }}
      />
      <div className="relative flex items-center gap-5">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[var(--primary)]/10 text-[var(--primary)]">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-[var(--foreground)]">
              {"Memory graph"}
            </h3>
            <span className="rounded-full border border-[var(--border)] bg-[var(--background)]/60 px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              {"New"}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--muted-foreground)]">
            {"See all three layers at once — L3 synthesis at the centre, L2 facts in the middle, L1 traces on the outside. Hover any node for a preview."}
          </p>
        </div>
        <ArrowRight className="hidden h-4 w-4 shrink-0 text-[var(--primary)] transition group-hover:translate-x-0.5 md:block" />
      </div>
    </Link>
  );
}

interface LayerCardProps {
  href: string;
  icon: LucideIcon;
  title: string;
  tag: string;
  stat: string;
  statLabel: string;
  detail: string;
}

function LayerCard({
  href,
  icon: Icon,
  title,
  tag,
  stat,
  statLabel,
  detail,
}: LayerCardProps) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 transition hover:-translate-y-[1px] hover:border-[var(--primary)]/40 hover:shadow-sm"
    >
      <div className="flex items-start justify-between">
        <span className="grid h-9 w-9 place-items-center rounded-lg bg-[var(--primary)]/10 text-[var(--primary)]">
          <Icon className="h-4 w-4" />
        </span>
        <span className="rounded-full border border-[var(--border)] bg-[var(--background)] px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {tag}
        </span>
      </div>
      <div className="space-y-1">
        <h2 className="text-[15px] font-semibold text-[var(--foreground)]">
          {title}
        </h2>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-[28px] font-semibold tracking-tight text-[var(--foreground)]">
          {stat}
        </span>
        <span className="text-[12px] text-[var(--muted-foreground)]">
          {statLabel}
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-[var(--muted-foreground)]">
        {detail}
      </p>
      <div className="mt-auto inline-flex items-center gap-1 text-[12px] font-medium text-[var(--primary)] opacity-0 transition group-hover:opacity-100">
        <span>{tag}</span>
        <ArrowRight className="h-3.5 w-3.5" />
      </div>
    </Link>
  );
}
