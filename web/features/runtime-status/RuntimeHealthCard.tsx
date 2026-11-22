"use client";

import { RefreshCw, ServerCog } from "lucide-react";

import {
  Button,
  InlineAlert,
  Skeleton,
  StatusChip,
  type StatusTone,
} from "@/shared/ui";
import type { RuntimeHealth, RuntimeStatusSnapshot } from "./model";

export interface RuntimeHealthCardProps {
  snapshot: RuntimeStatusSnapshot;
  onRefresh?: () => void | Promise<void>;
  showDetails?: boolean;
  compact?: boolean;
}

const tone: Record<RuntimeHealth, StatusTone> = {
  healthy: "success",
  degraded: "warning",
  recovering: "warning",
  unavailable: "danger",
};

export function RuntimeHealthCard({
  snapshot,
  onRefresh,
  showDetails = false,
  compact = false,
}: RuntimeHealthCardProps) {
  
  const label = {
    healthy: "Healthy",
    degraded: "Degraded",
    recovering: "Recovering",
    unavailable: "Unavailable",
  }[snapshot.health];

  if (snapshot.loading && !snapshot.data) {
    return compact ? (
      <Skeleton className="h-6 w-28" />
    ) : (
      <Skeleton className="h-36 w-full" />
    );
  }

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-foreground">
          {"Turn runtime"}
        </span>
        <StatusChip tone={tone[snapshot.health]}>{label}</StatusChip>
      </div>
    );
  }

  const status = snapshot.data;
  return (
    <section
      className="rounded-2xl border border-border bg-card p-5 shadow-sm"
      aria-labelledby="runtime-health-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <ServerCog aria-hidden className="h-5 w-5" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2
                id="runtime-health-title"
                className="text-sm font-semibold text-foreground"
              >
                {"Turn runtime"}
              </h2>
              <StatusChip tone={tone[snapshot.health]}>{label}</StatusChip>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {healthDescription(snapshot.health)}
            </p>
          </div>
        </div>
        {onRefresh ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onRefresh()}
            loading={snapshot.loading}
            icon={<RefreshCw aria-hidden className="h-4 w-4" />}
          >
            {"Refresh"}
          </Button>
        ) : null}
      </div>

      {snapshot.error ? (
        <InlineAlert tone={status ? "warning" : "danger"} className="mt-4">
          {status
            ? "The latest refresh failed. Showing the last safe snapshot."
            : "Runtime health could not be loaded."}
        </InlineAlert>
      ) : null}

      {status && showDetails ? (
        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-border pt-4 md:grid-cols-4">
          <Metric label={"Workers"} value={String(status.workerCount)} />
          <Metric
            label={"Coordination"}
            value={
              status.coordinationMode === "redis" ? "Redis" : "In process"
            }
          />
          <Metric
            label={"Active owner turns"}
            value={String(status.ownerTurnCount)}
          />
          <Metric
            label={"Recovery backlog"}
            value={String(status.recoveryBacklog)}
          />
          <Metric
            label={"Redis"}
            value={redisLabel(status.redisStatus)}
          />
          <Metric
            label={"Leader"}
            value={
              status.leaderHealthy === false
                ? "Unhealthy"
                : status.leaderId || "Not applicable"
            }
          />
          <Metric label={"Protocol"} value={status.protocolVersion} />
          <Metric label={"Worker ID"} value={status.workerId} />
        </dl>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd
        className="mt-1 truncate text-sm font-semibold text-foreground"
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function redisLabel(
  status: "ok" | "unavailable" | "not_configured",
) {
  if (status === "ok") return "Connected";
  if (status === "unavailable") return "Unavailable";
  return "Not configured";
}

function healthDescription(health: RuntimeHealth) {
  if (health === "healthy")
    return "Turn ownership and recovery services are operating normally.";
  if (health === "recovering")
    return "The runtime is reconciling interrupted work.";
  if (health === "degraded")
    return "Turn coordination needs operator attention.";
  return "The runtime status endpoint is not available.";
}
