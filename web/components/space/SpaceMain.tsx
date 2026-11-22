"use client";

import Link from "@/shared/router/link";
import { usePathname } from "@/shared/router/navigation";
import { ArrowLeft } from "lucide-react";

import { FeaturePage } from "@/components/layout/FeaturePage";
import { useUiLayoutLabel } from "@/features/ui-layout/tokens";
import { categoryForPath } from "@/lib/navigation";

// Hub-and-spoke: the dashboard at `/space` is the only navigator. Once inside a
// section we don't re-list every sibling on a rail — a single "back to the hub"
// link keeps the section focused and sends you to the overview to switch.
function BackToHub({ pathname }: { pathname: string }) {
  
  const spaceLabel = useUiLayoutLabel("space");
  // Account-level sections hang off their own hub, not the workspace's.
  const personal = categoryForPath(pathname) === "personalization";
  return (
    <Link
      href={personal ? "/personalization" : "/space"}
      className="dt-section-back group inline-flex items-center gap-1.5 text-[13px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
    >
      <ArrowLeft
        size={15}
        strokeWidth={1.8}
        className="transition-transform group-hover:-translate-x-0.5"
      />
      {personal ? "Personalization" : spaceLabel}
    </Link>
  );
}

export default function SpaceMain({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname() ?? "";
  const isDashboard = pathname === "/space";

  return (
    <FeaturePage>
      {!isDashboard && (
        <div className="mb-5">
          <BackToHub pathname={pathname} />
        </div>
      )}
      {children}
    </FeaturePage>
  );
}

