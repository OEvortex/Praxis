"use client";

import { memo, useEffect, useState } from "react";
import dynamic from "@/shared/router/dynamic";
import {
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  Pencil,
} from "lucide-react";
import Link from "@/shared/router/link";


import Tooltip from "@/shared/ui/Tooltip";
import { formatBytes } from "@/shared/lib/format";
import type { CreationDraftData } from "@/lib/creation-draft";
import {
  approveCreationDraft,
  CreationApiError,
  getCreationDraft,
  type CreationApproval,
} from "@/lib/creations-api";
import { CREATE_KINDS, notifyCreationSaved } from "@/lib/creations";
import { invalidateSkillsCache } from "@/lib/skills-api";
import { invalidatePersonasCache } from "@/lib/personas-api";

// Lazy-loaded like the Skills page's own viewer: the markdown deps only ship
// once a draft card actually renders a body.
const DraftMarkdown = dynamic(
  () => import("@/components/common/SimpleMarkdownRenderer"),
  { ssr: false },
);

const CLAMP_CLASS = "max-h-40 overflow-hidden";

export const CreationDraftCard = memo(function CreationDraftCard({
  data,
}: {
  data: CreationDraftData;
}) {
  
  const def = CREATE_KINDS[data.kind];
  const Icon = def.icon;

  const [name, setName] = useState(data.name);
  const [description, setDescription] = useState(data.description);
  const [content, setContent] = useState(data.content);
  const [tagsText, setTagsText] = useState(data.tags.join(", "));
  const [editingFields, setEditingFields] = useState(false);
  const [bodyExpanded, setBodyExpanded] = useState(false);
  const [openReference, setOpenReference] = useState<string | null>(null);

  const [approval, setApproval] = useState<CreationApproval>(
    data.status === "created" ? "done" : "create",
  );
  const [saved, setSaved] = useState<{ name: string; replaced: boolean } | null>(
    data.status === "created" ? { name: data.created_name || data.name, replaced: data.replaced } : null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // A reload replays this message's events, which carry the metadata as it
  // was the moment `propose_creation` ran — stale once the user has since
  // approved (or someone else took the name). One GET on mount catches up.
  useEffect(() => {
    let alive = true;
    void getCreationDraft(data.draft_id)
      .then((response) => {
        if (!alive) return;
        setApproval(response.approval);
        if (response.approval === "done") {
          setSaved({
            name: response.draft.created_name || response.draft.name,
            replaced: response.draft.replaced,
          });
        }
      })
      .catch(() => {
        // No network, or the draft vanished — the card simply keeps
        // whatever the transcript already said.
      });
    return () => {
      alive = false;
    };
  }, [data.draft_id]);

  const approve = async () => {
    setSaving(true);
    setError("");
    const submittedName = name;
    try {
      const tags = tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      const result = await approveCreationDraft(data.draft_id, {
        name,
        description,
        content,
        ...(data.kind === "skill" ? { tags } : {}),
      });
      setSaved({ name: result.saved_name, replaced: result.replaced });
      setEditingFields(false);
      if (data.kind === "skill") invalidateSkillsCache();
      else invalidatePersonasCache();
      notifyCreationSaved(data.kind);
    } catch (err) {
      if (err instanceof CreationApiError && err.status === 409) {
        setError(
          `A ${(def.labelKey).toLowerCase()} named “${submittedName}” already exists. Rename it, then approve again.`,
        );
      } else {
        setError(
          err instanceof CreationApiError
            ? err.message
            : "Couldn't save the draft.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    "w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12px] text-[var(--foreground)] outline-none transition focus:border-[var(--ring)]";

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.05)]">
      <div className="flex items-start gap-3 p-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--primary)_10%,transparent)] text-[var(--primary)]">
          <Icon size={16} strokeWidth={1.7} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">
                {(def.draftHeaderKey)}
              </div>
              {!editingFields ? (
                <div className="mt-0.5 truncate text-[15px] font-semibold text-[var(--foreground)]">
                  {name}
                </div>
              ) : null}
            </div>
            {!saved ? (
              <Tooltip label={editingFields ? "Done" : "Edit"}>
                <button
                  type="button"
                  onClick={() => setEditingFields((value) => !value)}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] text-[var(--muted-foreground)] transition hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]"
                >
                  <Pencil size={12} /> {editingFields ? "Done" : "Edit"}
                </button>
              </Tooltip>
            ) : null}
          </div>

          {editingFields ? (
            <div className="mt-3 space-y-2.5">
              <input
                aria-label={"Name"}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={fieldClass}
                placeholder={"Name"}
              />
              <textarea
                aria-label={"Description"}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                className={`${fieldClass} min-h-16 resize-y`}
                placeholder={"Description"}
              />
              {data.kind === "skill" ? (
                <input
                  aria-label={"Tags"}
                  value={tagsText}
                  onChange={(event) => setTagsText(event.target.value)}
                  className={fieldClass}
                  placeholder={"tag-one, tag-two"}
                />
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
              {description}
            </p>
          )}

          <div className="mt-3">
            {!editingFields ? (
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setBodyExpanded((value) => !value)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  {bodyExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {bodyExpanded ? "Collapse" : "Expand"}
                </button>
              </div>
            ) : null}
            {editingFields ? (
              <textarea
                aria-label={"Draft content"}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                className={`${fieldClass} min-h-48 resize-y font-mono leading-relaxed`}
              />
            ) : (
              <div
                className={`prose-skill rounded-xl bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] px-3 py-2 text-[12.5px] leading-relaxed text-[var(--foreground)] ${
                  bodyExpanded ? "" : CLAMP_CLASS
                }`}
              >
                <DraftMarkdown content={content} variant="compact" />
              </div>
            )}
          </div>

          {data.references.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-medium text-[var(--muted-foreground)]">
                {"References"}
              </div>
              <ul className="space-y-1">
                {data.references.map((reference) => (
                  <li key={reference.path}>
                    <button
                      type="button"
                      onClick={() =>
                        setOpenReference((current) =>
                          current === reference.path ? null : reference.path,
                        )
                      }
                      className="inline-flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[11.5px] text-[var(--muted-foreground)] transition hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]"
                    >
                      <FileText size={12} className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate font-mono">{reference.path}</span>
                      <span className="shrink-0 tabular-nums">{formatBytes(reference.size)}</span>
                    </button>
                    {openReference === reference.path && reference.content ? (
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-2.5 text-[10.5px] leading-relaxed text-[var(--muted-foreground)]">
                        {reference.content}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {error ? (
            <p className="mt-3 text-[11px] text-red-500">{error}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {saved ? (
              <Link
                href={def.href}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--foreground)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--background)]"
              >
                {(def.manageLabelKey)}
              </Link>
            ) : (
              <button
                type="button"
                disabled={saving || !name.trim() || !description.trim() || !content.trim()}
                onClick={approve}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--foreground)] px-3.5 py-2 text-[11.5px] font-medium text-[var(--background)] transition disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : null}
                {approval === "update"
                  ? "Approve and update"
                  : "Approve and save"}
              </button>
            )}
            <span className="text-[10.5px] text-[var(--muted-foreground)]">
              {saved
                ? saved.replaced
                  ? `Updated “${saved.name}”`
                  : `Saved as “${saved.name}”`
                : "Nothing is saved until you approve it"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

CreationDraftCard.displayName = "CreationDraftCard";
