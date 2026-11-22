"use client";

import { pageGridClass } from '@/components/layout/FeaturePage'
import { navigateTask } from "@/lib/workspace-scope";
import { sessionWorkspaceId } from "@/lib/session-api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@/shared/router/navigation";
import {
  Archive,
  CheckSquare,
  History,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";

import OrganizedSessionList from "@/components/sessions/OrganizedSessionList";
import ArchivedConversations from "@/components/space/ArchivedConversations";
import SpaceSectionHeader from "@/components/space/SpaceSectionHeader";
import { useAppShell } from "@/context/AppShellContext";
import {
  fetchMasteryTopicIndex,
  type MasteryTopicLabel,
} from "@/lib/learning-api";
import { sessionRoute } from "@/lib/mastery-session";
import {
  fetchReadingCollectionIndex,
  type ReadingCollectionLabel,
} from "@/lib/reading-workspace-api";
import { collectArchivedConversations } from "@/lib/session-archive";
import { notifySessionsChanged } from "@/lib/session-events";
import {
  deleteSession,
  listAllSessions,
  searchAllSessions,
  updateSessionTitle,
  updateSessionOrganization,
  type SessionOrganizationPatch,
  type SessionSearchResult,
  type SessionSummary,
} from "@/lib/session-api";

/**
 * The learning space's conversation history: search, filter, and the archive.
 *
 * A conversation reopens on the surface it was held in (see ``sessionRoute``),
 * not always in the main chat. This page used to send everything to `/chat`,
 * which for a reading conversation meant reopening it with its material closed
 * and its citations pointing at a document that is not on screen.
 */
export interface ChatHistorySectionProps {
  icon?: LucideIcon;
  title?: string;
  description?: string;
}

export default function ChatHistorySection({
  icon,
  title,
  description,
}: ChatHistorySectionProps = {}) {
  const basePath = "/chat";
  
  const router = useRouter();
  const { activeSessionId, setActiveSessionId } = useAppShell();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [masteryTopics, setMasteryTopics] = useState<MasteryTopicLabel[]>([]);
  const [readingCollections, setReadingCollections] = useState<
    ReadingCollectionLabel[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchVersion, setSearchVersion] = useState(0);
  const searchGenerationRef = useRef(0);
  const [kindFilter, setKindFilter] = useState("all");
  const [archiveFilter, setArchiveFilter] = useState("active");
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // ``quiet`` refetches without swapping the panel for its skeleton: a restore
  // acts on one row and says so on that row, so blanking the whole archive
  // underneath it would be the only thing the eye followed.
  const load = useCallback(async (force = false, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      // Topic and collection labels only name which surface an archived
      // conversation came from, so losing them costs that line, never the
      // conversation.
      const [nextSessions, nextTopics, nextCollections] = await Promise.all([
        listAllSessions({ force }),
        fetchMasteryTopicIndex().catch(() => [] as MasteryTopicLabel[]),
        fetchReadingCollectionIndex().catch(
          () => [] as ReadingCollectionLabel[],
        ),
      ]);
      setSessions(nextSessions);
      setMasteryTopics(nextTopics);
      setReadingCollections(nextCollections);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const reload = useCallback(
    async (force = false, quiet = false) => {
      await load(force, quiet);
      setSearchVersion((version) => version + 1);
    },
    [load],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    const term = query.trim();
    setSearchError(false);
    if (!term) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchResults([]);
    setSearchLoading(true);
    let controller: AbortController | null = null;
    const timer = window.setTimeout(() => {
      controller = new AbortController();
      searchAllSessions(term, controller.signal)
        .then((results) => {
          if (generation !== searchGenerationRef.current) return;
          setSearchResults(results);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return;
          if (generation !== searchGenerationRef.current) return;
          setSearchResults([]);
          setSearchError(true);
        })
        .finally(() => {
          if (generation === searchGenerationRef.current)
            setSearchLoading(false);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
      controller?.abort();
    };
  }, [query, searchVersion]);

  const filteredSessions = useMemo(() => {
    const source = query.trim() ? searchResults : sessions;
    return source.filter((session) => {
      const prefs = session.preferences ?? {};
      if (archiveFilter === "active" && prefs.archived) return false;
      if (archiveFilter === "archived" && !prefs.archived) return false;
      if (kindFilter === "chat" && prefs.session_kind === "selection_tutor")
        return false;
      if (
        kindFilter === "selection_tutor" &&
        prefs.session_kind !== "selection_tutor"
      )
        return false;
      return true;
    });
  }, [archiveFilter, kindFilter, query, searchResults, sessions]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      const session = filteredSessions.find(
        (item) => item.session_id === sessionId,
      );
      navigateTask(session ? sessionRoute(session) : `${basePath}/${sessionId}`, router.push);
    },
    [basePath, filteredSessions, router, setActiveSessionId],
  );

  const handleRename = useCallback(
    async (sessionId: string, title: string) => {
      await updateSessionTitle(
        sessionId,
        title,
        sessionWorkspaceId(
          filteredSessions.find((item) => item.session_id === sessionId),
        ),
      );
      await reload(true);
    },
    [filteredSessions, reload],
  );

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (!window.confirm("Permanently delete this chat and its tutor threads? This cannot be undone.")) return;
      await deleteSession(
        sessionId,
        sessionWorkspaceId(
          filteredSessions.find((item) => item.session_id === sessionId),
        ),
      );
      if (activeSessionId === sessionId) setActiveSessionId(null);
      setSessions((prev) =>
        prev.filter((session) => session.session_id !== sessionId),
      );
      setSearchResults((prev) =>
        prev.filter((session) => session.session_id !== sessionId),
      );
      setSearchVersion((version) => version + 1);
    },
    [activeSessionId, filteredSessions, setActiveSessionId],
  );

  // The archived view is built from the same filtered set as the list, so the
  // search box and the type filter still narrow it.
  const archiveBuckets = useMemo(
    () =>
      collectArchivedConversations({
        sessions: filteredSessions,
        masteryTopics,
        readingCollections,
      }),
    [filteredSessions, masteryTopics, readingCollections],
  );

  const handleRestore = useCallback(
    async (sessionId: string) => {
      setRestoringId(sessionId);
      try {
        await updateSessionOrganization(
          sessionId,
          { archived: false },
          sessionWorkspaceId(
            filteredSessions.find((item) => item.session_id === sessionId),
          ),
        );
        // Restoring cascades to the tutor threads under the conversation, so
        // the server's own list is what says which rows are left.
        await reload(true, true);
        notifySessionsChanged();
      } finally {
        setRestoringId(null);
      }
    },
    [filteredSessions, reload],
  );

  // Selection only counts rows currently visible under the active filters —
  // a search or archive-filter change must not leave invisible ids armed.
  const visibleIds = useMemo(
    () => new Set(filteredSessions.map((s) => s.session_id)),
    [filteredSessions],
  );
  const effectiveSelected = useMemo(() => {
    const next = new Set<string>();
    for (const id of selectedIds) if (visibleIds.has(id)) next.add(id);
    return next;
  }, [selectedIds, visibleIds]);

  const toggleSelect = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size >= visibleIds.size && visibleIds.size > 0
        ? new Set()
        : new Set(visibleIds),
    );
  }, [visibleIds]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const runBulk = useCallback(
    async (action: "archive" | "unarchive" | "delete") => {
      const ids = [...effectiveSelected];
      if (!ids.length || bulkBusy) return;
      if (
        action === "delete" &&
        !window.confirm(
          `Permanently delete ${ids.length} conversation${ids.length === 1 ? "" : "s"} and their tutor threads? This cannot be undone.`,
        )
      )
        return;
      setBulkBusy(true);
      try {
        await Promise.all(
          ids.map((id) => {
            const ws = sessionWorkspaceId(
              filteredSessions.find((item) => item.session_id === id),
            );
            return action === "delete"
              ? deleteSession(id, ws)
              : updateSessionOrganization(
                  id,
                  { archived: action === "archive" },
                  ws,
                );
          }),
        );
        if (action === "delete") {
          const gone = new Set(ids);
          setSessions((prev) =>
            prev.filter((s) => !gone.has(s.session_id)),
          );
          setSearchResults((prev) =>
            prev.filter((s) => !gone.has(s.session_id)),
          );
          if (activeSessionId && gone.has(activeSessionId))
            setActiveSessionId(null);
        }
        setSelectedIds(new Set());
        await reload(true, true);
        notifySessionsChanged();
      } finally {
        setBulkBusy(false);
      }
    },
    [
      activeSessionId,
      bulkBusy,
      effectiveSelected,
      filteredSessions,
      reload,
      setActiveSessionId,
    ],
  );

  const handleOrganize = useCallback(
    async (sessionId: string, patch: SessionOrganizationPatch) => {
      await updateSessionOrganization(
        sessionId,
        patch,
        sessionWorkspaceId(
          filteredSessions.find((item) => item.session_id === sessionId),
        ),
      );
      await reload(true);
      // Archiving or restoring here changes what the sidebar beside this page
      // is allowed to show, and that list was fetched when the shell mounted.
      notifySessionsChanged();
    },
    [filteredSessions, reload],
  );

  const HeaderIcon = icon ?? History;
  const headerTitle = title ?? "Chat History";
  const headerDescription =
    description ??
    "Browse, rename, delete, and reopen previous conversations from your learning space.";

  return (
    <div className="space-y-6">
      <SpaceSectionHeader
        title={headerTitle}
        description={headerDescription}
        meta={
          <span className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--muted-foreground)]">
            {sessions.length} {"conversations"}
          </span>
        }
        action={
          <div className="flex items-center gap-2">
            {selectMode ? null : (
              <button
                type="button"
                onClick={() => setSelectMode(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)]/50 px-3 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] transition-colors hover:border-[var(--border)] hover:text-[var(--foreground)]"
              >
                <CheckSquare className="h-3 w-3" />
                {"Select"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void reload(true)}
              disabled={loading || searchLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)]/50 px-3 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] transition-colors hover:border-[var(--border)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              {loading || searchLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {"Refresh"}
            </button>
          </div>
        }
      />

      <section className="rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-sm">
        <div className="border-b border-[var(--border)]/60 px-4 py-3">
          <label className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--muted-foreground)] focus-within:border-[var(--ring)]">
            <Search size={14} strokeWidth={1.7} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={200}
              placeholder={"Search chat history..."}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]/55"
            />
          </label>
          <div className={`mt-2 ${pageGridClass(2)}`}>
            <label className="sr-only" htmlFor="history-kind-filter">
              {"Filter by conversation type"}
            </label>
            <select
              id="history-kind-filter"
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
            >
              <option value="all">{"All conversation types"}</option>
              <option value="chat">{"Main conversations"}</option>
              <option value="selection_tutor">{"Tutor threads"}</option>
            </select>
            <label className="sr-only" htmlFor="history-archive-filter">
              {"Filter by archive status"}
            </label>
            <select
              id="history-archive-filter"
              value={archiveFilter}
              onChange={(event) => setArchiveFilter(event.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
            >
              <option value="active">{"Active"}</option>
              <option value="archived">{"Archived"}</option>
              <option value="all">{"Active and archived"}</option>
            </select>
          </div>
        </div>

        {selectMode && archiveFilter !== "archived" ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)]/60 px-4 py-2.5">
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--muted-foreground)]">
              <input
                type="checkbox"
                checked={
                  visibleIds.size > 0 &&
                  effectiveSelected.size >= visibleIds.size
                }
                onChange={toggleSelectAll}
                className="h-3.5 w-3.5 accent-[var(--foreground)]"
              />
              {effectiveSelected.size > 0
                ? `${effectiveSelected.size} selected`
                : "Select all"}
            </label>
            <div className="flex-1" />
            <button
              type="button"
              disabled={!effectiveSelected.size || bulkBusy}
              onClick={() => void runBulk("archive")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Archive size={13} />
              {"Archive"}
            </button>
            <button
              type="button"
              disabled={!effectiveSelected.size || bulkBusy}
              onClick={() => void runBulk("delete")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium text-red-600 transition-colors hover:bg-red-500/10 disabled:opacity-40 dark:text-red-400"
            >
              {bulkBusy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Trash2 size={13} />
              )}
              {"Delete"}
            </button>
            <button
              type="button"
              onClick={exitSelectMode}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              <X size={13} />
              {"Done"}
            </button>
          </div>
        ) : null}

        <div className="px-3 py-3">
          {loading || searchLoading ? (
            <div className="space-y-2 p-2">
              {[0, 1, 2, 3].map((item) => (
                <div
                  key={item}
                  className="h-8 animate-pulse rounded bg-[var(--muted)]/45"
                />
              ))}
            </div>
          ) : searchError ? (
            <div role="alert" className="flex items-center justify-between gap-3 px-2 py-4 text-[12.5px] text-[var(--muted-foreground)]">
              <p>{"Could not search chat history. Try again."}</p>
              <button
                type="button"
                onClick={() => setSearchVersion((version) => version + 1)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]"
              >
                <RefreshCw size={13} strokeWidth={1.8} />
                {"Retry"}
              </button>
            </div>
          ) : archiveFilter === "archived" ? (
            <ArchivedConversations
              buckets={archiveBuckets}
              restoringId={restoringId}
              onOpen={handleSelect}
              onRestore={handleRestore}
            />
          ) : (
            <OrganizedSessionList
              sessions={filteredSessions}
              activeSessionId={activeSessionId}
              onSelect={handleSelect}
              onRename={handleRename}
              onDelete={handleDelete}
              onOrganize={handleOrganize}
              selectionMode={selectMode}
              selectedIds={effectiveSelected}
              onToggleSelect={toggleSelect}
            />
          )}
        </div>
      </section>
    </div>
  );
}
