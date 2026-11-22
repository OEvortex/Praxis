import { useState, type RefObject } from "react";
import { Check, ChevronDown, ChevronRight, Sparkles } from "lucide-react";

import type { CapabilityDef } from "@/features/capabilities/presentation";
import { useCapabilityLabel } from "@/features/ui-layout/tokens";
import Tooltip from "@/shared/ui/Tooltip";

/** One row in the capability picker — shared by the built-in list and the
 *  "More" flyout so both render identically. */
function CapMenuItem({
  cap,
  selected,
  onSelect,
}: {
  cap: CapabilityDef;
  selected: boolean;
  onSelect: (value: string) => void;
}) {
  
  const capabilityLabel = useCapabilityLabel();

  const Icon = cap.icon;
  return (
    <button
      type="button"
      onClick={() => onSelect(cap.value)}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors active:bg-[var(--muted)]/70 ${
        selected ? "bg-[var(--primary)]/[0.06]" : "hover:bg-[var(--muted)]/45"
      }`}
    >
      <Icon
        size={15}
        strokeWidth={1.7}
        className={`shrink-0 ${selected ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium leading-snug text-[var(--foreground)]">
          {capabilityLabel(cap)}
        </div>
        <div className="truncate text-[11px] leading-snug text-[var(--muted-foreground)]">
          {(cap.description)}
        </div>
      </div>
      {selected && (
        <Check
          size={14}
          strokeWidth={2}
          className="shrink-0 text-[var(--primary)]"
        />
      )}
    </button>
  );
}

interface CapabilityMenuProps {
  activeCap: CapabilityDef;
  capabilities: CapabilityDef[];
  capMenuOpen: boolean;
  capBtnRef: RefObject<HTMLButtonElement | null>;
  capMenuRef: RefObject<HTMLDivElement | null>;
  onSetCapMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  onSelectCapability: (value: string) => void;
}

/**
 * Classic-layout capability selector chip and its primary + "More" flyout menu.
 */
export function CapabilityMenu({
  activeCap,
  capabilities,
  capMenuOpen,
  capBtnRef,
  capMenuRef,
  onSetCapMenuOpen,
  onSelectCapability,
}: CapabilityMenuProps) {
  
  const capabilityLabel = useCapabilityLabel();
  const [moreCapsOpen, setMoreCapsOpen] = useState(false);
  const [lastCapMenuOpen, setLastCapMenuOpen] = useState(capMenuOpen);

  if (lastCapMenuOpen !== capMenuOpen) {
    setLastCapMenuOpen(capMenuOpen);
    if (!capMenuOpen) setMoreCapsOpen(false);
  }

  const CapIcon = activeCap.icon;
  const handleSelect = (value: string) => {
    setMoreCapsOpen(false);
    onSelectCapability(value);
  };

  return (
    <div className="relative min-w-0 max-w-full">
      <Tooltip label={capabilityLabel(activeCap)} suppressed={capMenuOpen} side="top">
        <button
          ref={capBtnRef}
          aria-haspopup="menu"
          aria-expanded={capMenuOpen}
          onClick={() => onSetCapMenuOpen((v) => !v)}
          aria-label={capabilityLabel(activeCap)}
          className={`inline-flex h-8 max-w-full items-center rounded-lg px-2 text-[14px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
            capMenuOpen
              ? "bg-[var(--primary)]/10 text-[var(--primary)]"
              : "text-[var(--foreground)] hover:bg-[var(--muted)]/55"
          }`}
        >
          <CapIcon size={16} strokeWidth={1.7} className="shrink-0" />
          <span className="ml-1.5 inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            <span className="min-w-0 truncate">{capabilityLabel(activeCap)}</span>
            <ChevronDown
              size={13}
              strokeWidth={2}
              className={`shrink-0 transition-transform duration-200 ${capMenuOpen ? "rotate-180" : ""}`}
            />
          </span>
        </button>
      </Tooltip>

      {capMenuOpen && (
        <div
          ref={capMenuRef}
          className="dt-popup-up absolute bottom-full left-0 z-50 mb-1.5 w-[260px] overflow-visible rounded-xl border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg backdrop-blur-md"
        >
          {capabilities
            .filter((cap) => !cap.secondary && !cap.legacy)
            .map((cap) => (
              <CapMenuItem
                key={cap.value}
                cap={cap}
                selected={activeCap.value === cap.value}
                onSelect={handleSelect}
              />
            ))}
          {(() => {
            const loopCaps = capabilities.filter(
              (cap) => cap.secondary && !cap.legacy,
            );
            if (loopCaps.length === 0) return null;
            const loopSelected = loopCaps.some(
              (cap) => cap.value === activeCap.value,
            );
            return (
              <div
                className="group/more relative"
                onMouseEnter={() => setMoreCapsOpen(true)}
                onMouseLeave={() => setMoreCapsOpen(false)}
                onFocus={() => setMoreCapsOpen(true)}
                onBlur={(event) => {
                  const next = event.relatedTarget;
                  if (!next || !event.currentTarget.contains(next as Node)) {
                    setMoreCapsOpen(false);
                  }
                }}
              >
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={moreCapsOpen}
                  onClick={() => setMoreCapsOpen((open) => !open)}
                  className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
                    moreCapsOpen
                      ? "bg-[var(--muted)]/45"
                      : "group-hover/more:bg-[var(--muted)]/45"
                  } ${
                    loopSelected && !moreCapsOpen
                      ? "bg-[var(--primary)]/[0.06]"
                      : ""
                  }`}
                >
                  <Sparkles
                    size={15}
                    strokeWidth={1.7}
                    className={`shrink-0 ${loopSelected ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] font-medium leading-snug text-[var(--foreground)]">
                      {"More Capabilities"}
                    </div>
                    <div className="truncate text-[11px] leading-snug text-[var(--muted-foreground)]">
                      {"Agent-loop driven modes"}
                    </div>
                  </div>
                  <ChevronRight
                    size={14}
                    strokeWidth={2}
                    className="shrink-0 text-[var(--muted-foreground)]"
                  />
                </button>
                {/* Right flyout. ``pl-1.5`` is a pointer bridge so the
                  cursor can cross the gap without dropping hover;
                  click/focus also open it for touch and keyboard. */}
                <div
                  className={`absolute bottom-0 left-full z-50 pl-1.5 transition-opacity duration-150 ${
                    moreCapsOpen
                      ? "visible opacity-100"
                      : "invisible opacity-0"
                  }`}
                >
                  <div className="w-[240px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] py-1 shadow-lg backdrop-blur-md">
                    {loopCaps.map((cap) => (
                      <CapMenuItem
                        key={cap.value}
                        cap={cap}
                        selected={activeCap.value === cap.value}
                        onSelect={handleSelect}
                      />
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
