import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Circle, Pause, PanelLeftClose, ChevronRight, ChevronDown, Folder, Settings, Pencil, Plus, MessagesSquare, Sun, Moon, Pin, PinOff, Archive, ArchiveRestore } from "lucide-react";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { NotificationSettings } from "@/components/NotificationSettings";
import { cn } from "@/lib/utils";
import type { SessionInfo, NotificationPreferences } from "@/types";
import { sessionActivityDisplay } from "@/lib/activity-display";
import { isPeerBusy } from "../../../../coms/coms-registry-core.ts";
import { loadTheme, setTheme, type Theme } from "@/lib/theme";
import { createLogger } from "@/lib/create-logger";
import { isSessionWaitingForInput, partitionSidebarSessions, sessionRowDisplayLabel } from "@/lib/pidash-ux-helpers";

const log = createLogger("SessionSidebar");
const EMPTY_SESSION_IDS: ReadonlySet<string> = new Set();

function ago(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

interface Props {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  connected: boolean;
  onSelect: (s: SessionInfo) => void;
  collapsed: boolean;
  onToggle: () => void;
  onSettings?: () => void;
  onNewSession?: () => void;
  onRename?: (sessionId: string, name: string) => void;
  pinnedSessionIds?: ReadonlySet<string>;
  archivedSessionIds?: ReadonlySet<string>;
  extraAttentionIds?: ReadonlySet<string>;
  onTogglePin?: (sessionId: string) => void;
  onToggleArchive?: (sessionId: string) => void;
  notifications?: {
    permission: NotificationPermission;
    supported: boolean;
    preferences: NotificationPreferences;
    setPreference: <K extends keyof NotificationPreferences>(key: K, value: boolean) => void;
    requestPermission: () => void;
  };
}

// Track which groups the user explicitly collapsed.
// Everything NOT in this set is expanded by default.
//
// Keys are NAMESPACED: a coms project and a directory can share a name ("tmp"),
// and collapsing one must never collapse the other. Stored keys from before the
// namespace existed have no prefix and are read as directory keys.
const COLLAPSED_STORAGE_KEY = "pidash-collapsed-projects-v2";
// v1 stored bare directory names. A legacy name may itself contain a colon
// ("tmp:old"), so sniffing for ":" cannot tell legacy from namespaced — the
// versioned key makes the migration unambiguous instead.
const LEGACY_COLLAPSED_STORAGE_KEY = "pidash-collapsed-projects";

const dirKey = (name: string) => `dir:${name}`;
const comsKey = (project: string) => `coms:${project}`;

function loadCollapsedProjects(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
    const legacy = localStorage.getItem(LEGACY_COLLAPSED_STORAGE_KEY);
    if (legacy) {
      // Every v1 entry was a directory name, colons and all.
      const migrated = new Set((JSON.parse(legacy) as string[]).map(dirKey));
      saveCollapsedProjects(migrated);
      log.debug("migrated collapsed groups to namespaced keys", { count: migrated.size });
      return migrated;
    }
  } catch {}
  return new Set();
}

function saveCollapsedProjects(projects: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...projects])); } catch {}
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  connected,
  onSelect,
  collapsed,
  onToggle,
  onSettings,
  onNewSession,
  onRename,
  pinnedSessionIds,
  archivedSessionIds,
  extraAttentionIds,
  onTogglePin,
  onToggleArchive,
  notifications,
}: Props) {
  const [collapsedProjects, setCollapsedProjectsRaw] = useState<Set<string>>(() => loadCollapsedProjects());
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [archivedSectionOpen, setArchivedSectionOpen] = useState(false);
  // Coms section: a second, collapsible view at the BOTTOM of the list. Sessions
  // appear both here (under their project) and in the directory tree — a cheap
  // cross-reference, since rows cost nothing and members are few.
  const [comsSectionOpen, setComsSectionOpen] = useState<boolean>(() => {
    try { return localStorage.getItem("pidash-coms-section-open") !== "false"; } catch { return true; }
  });
  const toggleComsSection = () => {
    setComsSectionOpen((prev) => {
      const next = !prev;
      log.debug("coms section toggled", { open: next });
      try { localStorage.setItem("pidash-coms-section-open", String(next)); } catch {}
      return next;
    });
  };
  const [theme, setThemeState] = useState<Theme>(() => loadTheme());
  const { pinned, groups: sortedGroups, archived } = useMemo(
    () => partitionSidebarSessions(sessions, {
      pinnedIds: pinnedSessionIds ?? EMPTY_SESSION_IDS,
      archivedIds: archivedSessionIds ?? EMPTY_SESSION_IDS,
    }),
    [sessions, pinnedSessionIds, archivedSessionIds],
  );

  // Wrap setter to persist to localStorage
  const setCollapsedProjects = useCallback((update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setCollapsedProjectsRaw((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      saveCollapsedProjects(next);
      return next;
    });
  }, []);

  // Reveal a newly selected session (e.g. via Ctrl+1..9 or SessionSwitcher) when its
  // owning directory group or Archived section is collapsed, without fighting manual
  // collapse while the same session stays selected.
  const lastRevealedSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId) {
      lastRevealedSessionIdRef.current = null;
      return;
    }
    if (lastRevealedSessionIdRef.current === activeSessionId) return;

    if (archived.some((s) => s.sessionId === activeSessionId)) {
      lastRevealedSessionIdRef.current = activeSessionId;
      setArchivedSectionOpen((prev) => {
        if (prev) return prev;
        log.debug("auto-expanded archived section for selected session", { sessionId: activeSessionId });
        return true;
      });
      return;
    }

    const owningGroup = sortedGroups.find((g) => g.sessions.some((s) => s.sessionId === activeSessionId));
    if (owningGroup) {
      lastRevealedSessionIdRef.current = activeSessionId;
      const key = dirKey(owningGroup.name);
      setCollapsedProjects((prev) => {
        if (!prev.has(key)) return prev;
        log.debug("auto-expanded directory group for selected session", { sessionId: activeSessionId, group: owningGroup.name });
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      return;
    }

    if (pinned.some((s) => s.sessionId === activeSessionId)) {
      lastRevealedSessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId, archived, pinned, sortedGroups, setCollapsedProjects]);

  if (collapsed) return null;

  const renderAttentionBadge = (waitingCount: number) => {
    if (waitingCount <= 0) return null;
    return (
      <span
        data-attention-badge="true"
        className="inline-flex items-center gap-0.5 px-1 rounded-full bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 font-medium shrink-0"
        title={`${waitingCount} session${waitingCount === 1 ? "" : "s"} waiting for input`}
        aria-label={`${waitingCount} waiting for input`}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" aria-hidden="true" />
        {waitingCount}
      </span>
    );
  };

  /** One session row — shared by Pinned, directory groups, Coms, and Archived. */
  const renderSession = (
    s: SessionInfo,
    opts: { showLocation?: boolean; keyPrefix?: string; compactIndent?: boolean; preferComsName?: boolean } = {},
  ) => {
    const isActive = s.sessionId === activeSessionId;
    const isPinned = Boolean(pinnedSessionIds?.has(s.sessionId));
    const isArchived = Boolean(archivedSessionIds?.has(s.sessionId));
    const isWaiting = isSessionWaitingForInput(s, extraAttentionIds);
    const status = sessionActivityDisplay(s);
    const runningAgents = s.active && typeof s.runningAsyncAgents === "number" && s.runningAsyncAgents > 0 ? s.runningAsyncAgents : 0;
    const isBusy = isPeerBusy({ busy: status.isWorking, workload: { agents: runningAgents } });
    const rowKey = opts.keyPrefix ? `${opts.keyPrefix}:${s.sessionId}` : s.sessionId;
    const displayLabel = sessionRowDisplayLabel(s, { preferComsName: opts.preferComsName });
    return (
      <div
        key={rowKey}
        data-session-id={s.sessionId}
        data-waiting={isWaiting ? "true" : undefined}
        className={cn(
          "group/session py-2 cursor-pointer transition-colors border-b border-border/50 min-w-0",
          opts.compactIndent ? "pl-3 pr-2.5" : "pl-7 pr-2.5",
          isActive
            ? cn("bg-accent border-l-3", isWaiting ? "border-l-cyan-500" : "border-l-primary")
            : isWaiting
              ? "bg-cyan-500/10 border-l-3 border-l-cyan-500 hover:bg-cyan-500/15"
              : "hover:bg-accent/30",
          !s.active && "opacity-65",
        )}
        onClick={() => onSelect(s)}
      >
        <div className={cn("text-xs font-medium flex items-center gap-1.5 min-w-0", s.active ? "text-primary" : "text-muted-foreground")}>
          {opts.showLocation && (
            <span
              className="shrink-0 flex items-center gap-0.5 px-1 rounded border border-border bg-muted text-[9px] font-normal text-muted-foreground"
              title={`Session lives in ${s.cwd}`}
            >
              <Folder className="h-2.5 w-2.5 shrink-0" />
              <span className="max-w-[5.5rem] truncate">{s.cwd.split("/").pop() || s.cwd}</span>
            </span>
          )}
          {!s.active && <Pause className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
          {s.active && isBusy && (
            <span className="relative flex h-2 w-2 flex-shrink-0" aria-label="working">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
            </span>
          )}
          {runningAgents > 0 && (
            <span
              data-running-agents={runningAgents}
              className="text-[10px] text-yellow-600 dark:text-yellow-400 shrink-0"
              title={`${runningAgents} running async subagent${runningAgents === 1 ? "" : "s"}`}
            >
              ⏳{runningAgents}
            </span>
          )}
          {isWaiting && (
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-cyan-400" aria-label="waiting for input" />
          )}
          {editingSessionId === s.sessionId ? (
            <input
              className="bg-transparent border-b border-primary outline-none text-xs w-full min-w-0"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && editName.trim()) {
                  onRename?.(s.sessionId, editName.trim());
                  setEditingSessionId(null);
                }
                if (e.key === "Escape") setEditingSessionId(null);
              }}
              onBlur={() => setEditingSessionId(null)}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="truncate min-w-0 flex-1">{displayLabel}</span>
              {(onRename || onTogglePin || onToggleArchive) && (
                <span className="flex items-center gap-0.5 shrink-0">
                  {onRename && (
                    <button
                      type="button"
                      className="p-0.5 rounded opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-primary hover:bg-accent/50 cursor-pointer transition-opacity"
                      title="Rename session"
                      aria-label="Rename session"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingSessionId(s.sessionId);
                        setEditName(s.name || s.model || "");
                      }}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  {onTogglePin && (
                    <button
                      type="button"
                      className={cn(
                        "p-0.5 rounded hover:bg-accent/50 cursor-pointer transition-opacity",
                        isPinned
                          ? "text-primary opacity-85 group-hover/session:opacity-100"
                          : "opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-primary",
                      )}
                      title={isPinned ? "Unpin session" : "Pin session"}
                      aria-label={isPinned ? "Unpin session" : "Pin session"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin(s.sessionId);
                      }}
                    >
                      {isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                    </button>
                  )}
                  {onToggleArchive && (
                    <button
                      type="button"
                      className="p-0.5 rounded opacity-0 group-hover/session:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-primary hover:bg-accent/50 cursor-pointer transition-opacity"
                      title={isArchived ? "Unarchive session" : "Archive session"}
                      aria-label={isArchived ? "Unarchive session" : "Archive session"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleArchive(s.sessionId);
                      }}
                    >
                      {isArchived ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
                    </button>
                  )}
                </span>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground min-w-0 overflow-hidden">
          {s.branch && (
            <span className="flex items-center gap-0.5 min-w-0">
              <GitBranch className="h-2.5 w-2.5 shrink-0" />
              <span className={cn("shrink-0", s.gitDirty ? "text-red-500" : "text-green-500")}>
                {s.gitDirty ? "●" : "✓"}
              </span>
              <span className="truncate">{s.branch}</span>
            </span>
          )}
          {s.comsProject && (
            <span className="flex items-center gap-0.5 min-w-0 text-cyan-700 dark:text-cyan-400/90" title={`Coms project: ${s.comsProject}${s.comsName ? ` (you are ${s.comsName})` : ""}`}>
              <span aria-hidden="true" className="shrink-0">◆</span>
              <span className="truncate max-w-[5rem]">{s.comsProject}</span>
            </span>
          )}
          <span className="shrink-0">{ago(s.startedAt)}</span>
          {isWaiting && (
            <span className="shrink-0 rounded px-1 bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 font-medium whitespace-nowrap">
              waiting for input
            </span>
          )}
          {(s.container || s.containerName) && (
            <Badge
              variant="outline"
              className="text-[8px] px-1 py-0 h-3 shrink-0"
              title={s.containerName ? `Container: ${s.containerName}` : "Containerized session"}
            >
              {s.containerName ? "🐳" : "📦"}
            </Badge>
          )}
        </div>
      </div>
    );
  };


  // ── Coms projects present among non-archived sessions ──────────────
  const comsProjects = new Map<string, { sessions: SessionInfo[]; busy: number; waiting: number }>();
  for (const s of sessions) {
    if (!s.comsProject || archivedSessionIds?.has(s.sessionId)) continue;
    if (!comsProjects.has(s.comsProject)) comsProjects.set(s.comsProject, { sessions: [], busy: 0, waiting: 0 });
    const entry = comsProjects.get(s.comsProject)!;
    entry.sessions.push(s);
    if (isPeerBusy({ busy: s.activity === "working", workload: { agents: s.active ? (s.runningAsyncAgents ?? 0) : 0 } })) {
      entry.busy += 1;
    }
    if (isSessionWaitingForInput(s, extraAttentionIds)) entry.waiting += 1;
  }
  const sortedComsProjects = [...comsProjects.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const comsMemberCount = sortedComsProjects.reduce((n, [, info]) => n + info.sessions.length, 0);
  const comsBusyCount = sortedComsProjects.reduce((n, [, info]) => n + info.busy, 0);
  const comsWaitingCount = sortedComsProjects.reduce((n, [, info]) => n + info.waiting, 0);
  const archivedWaitingCount = archived.filter((s) => isSessionWaitingForInput(s, extraAttentionIds)).length;
  // Active sessions first inside each project, like the directory groups.
  for (const [, info] of sortedComsProjects) {
    info.sessions.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  }

  const toggleProject = (key: string) => {
    log.debug("group toggled", { key });
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); // was collapsed → expand
      else next.add(key); // was expanded → collapse
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full border-r border-border min-w-0 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0 min-w-0">
        <span className="text-sm font-bold text-primary">pidash</span>
        <span className="flex items-center gap-2">
          <Circle className={cn("h-2 w-2 fill-current", connected ? "text-green-500" : "text-red-500")} />
          {onNewSession && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-primary" onClick={onNewSession} title="New session">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {notifications && <NotificationSettings
            permission={notifications.permission}
            supported={notifications.supported}
            preferences={notifications.preferences}
            setPreference={notifications.setPreference}
            requestPermission={notifications.requestPermission}
          />}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
            onClick={() => {
              const next: Theme = theme === "dark" ? "light" : "dark";
              setThemeState(next);
              setTheme(next);
            }}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>
          {onSettings && (
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground" onClick={onSettings}>
              <Settings className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground" onClick={onToggle}>
            <PanelLeftClose className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>
      <div
        data-testid="sidebar-session-list"
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
      >
        {sessions.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">No sessions</p>
        )}

        {pinned.length > 0 && (
          <div className="border-b border-border" data-section="pinned">
            <div className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-primary border-b border-border/60">
              <Pin className="h-3 w-3 shrink-0" />
              <span className="truncate">Pinned</span>
              <span className="ml-auto text-[10px] font-normal text-muted-foreground">{pinned.length}</span>
            </div>
            {pinned.map((s) => renderSession(s, { showLocation: true, keyPrefix: "pinned", compactIndent: true }))}
          </div>
        )}

        {sortedGroups.map((group) => {
          const name = group.name;
          const groupKey = dirKey(name);
          const isExpanded = !collapsedProjects.has(groupKey);
          const hasActive = group.sessions.some(s => s.active);
          const count = group.sessions.length;
          const waitingCount = group.sessions.filter((s) => isSessionWaitingForInput(s, extraAttentionIds)).length;

          return (
            <div key={name}>
              {/* Project header */}
              <div
                className={cn(
                  "flex items-center gap-1.5 px-3 py-2 cursor-pointer text-sm font-semibold border-b border-border",
                  hasActive ? "text-primary" : "text-muted-foreground",
                  "hover:bg-accent/30",
                )}
                onClick={() => toggleProject(groupKey)}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  toggleProject(groupKey);
                }}
              >
                {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                <Folder className="h-3 w-3 shrink-0" />
                <span className="truncate">{name}</span>
                <span className="ml-auto flex items-center gap-1 text-[10px] font-normal shrink-0">
                  {!isExpanded && renderAttentionBadge(waitingCount)}
                  <span>{count}</span>
                </span>
              </div>

              {/* Sessions in this group */}
              {isExpanded && group.sessions.map((s) => renderSession(s))}
            </div>
          );
        })}
        {/* Coms section — AFTER the sessions, not above them. A session shows up
            both here (under its project) and in its directory group: rows are
            cheap, and the cross-reference is the point. Each project collapses
            independently (namespaced keys), and the whole section can be closed. */}
        {sortedComsProjects.length > 0 && (
          <div className="border-t border-border mt-1">
            <div
              className="flex items-center gap-1.5 px-3 py-2 cursor-pointer text-sm font-semibold text-muted-foreground hover:bg-accent/30 focus:outline-none focus:ring-1 focus:ring-primary focus:ring-inset"
              onClick={toggleComsSection}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggleComsSection();
              }}
              role="button"
              tabIndex={0}
              aria-expanded={comsSectionOpen}
              title={`${comsMemberCount} session${comsMemberCount === 1 ? "" : "s"} in ${sortedComsProjects.length} coms project${sortedComsProjects.length === 1 ? "" : "s"}`}
            >
              {comsSectionOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <MessagesSquare className="h-3 w-3 shrink-0" />
              <span className="truncate">Coms</span>
              <span className="ml-auto flex items-center gap-1 text-[10px] font-normal shrink-0">
                {!comsSectionOpen && renderAttentionBadge(comsWaitingCount)}
                <span>{comsMemberCount}</span>
                {comsBusyCount > 0 && <span className="text-green-600 dark:text-green-400">●{comsBusyCount}</span>}
              </span>
            </div>
            {comsSectionOpen && sortedComsProjects.map(([project, info]) => {
              const projectKey = comsKey(project);
              const isProjectOpen = !collapsedProjects.has(projectKey);
              return (
                <div key={projectKey}>
                  <div
                    className="flex items-center gap-1.5 pl-5 pr-3 py-1.5 cursor-pointer text-xs font-medium text-muted-foreground hover:bg-accent/30 focus:outline-none focus:ring-1 focus:ring-primary focus:ring-inset"
                    onClick={() => toggleProject(projectKey)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      toggleProject(projectKey);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isProjectOpen}
                  >
                    {isProjectOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                    <span aria-hidden="true" className="text-cyan-700 dark:text-cyan-400/90 shrink-0">◆</span>
                    <span className="truncate">{project}</span>
                    <span className="ml-auto flex items-center gap-1 text-[10px] font-normal shrink-0">
                      {!isProjectOpen && renderAttentionBadge(info.waiting)}
                      <span>{info.sessions.length}</span>
                    </span>
                  </div>
                  {isProjectOpen && info.sessions.map((s) => renderSession(s, { showLocation: true, keyPrefix: `coms:${project}`, preferComsName: true }))}
                </div>
              );
            })}
          </div>
        )}

        {archived.length > 0 && (
          <div className="border-t border-border mt-1" data-section="archived">
            <div
              className="flex items-center gap-1.5 px-3 py-2 cursor-pointer text-sm font-semibold text-muted-foreground hover:bg-accent/30 focus:outline-none focus:ring-1 focus:ring-primary focus:ring-inset"
              onClick={() => {
                setArchivedSectionOpen((prev) => {
                  const next = !prev;
                  log.debug("archived section toggled", { open: next, count: archived.length });
                  return next;
                });
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setArchivedSectionOpen((prev) => !prev);
              }}
              role="button"
              tabIndex={0}
              aria-expanded={archivedSectionOpen}
              title={`${archived.length} archived session${archived.length === 1 ? "" : "s"}`}
            >
              {archivedSectionOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
              <Archive className="h-3 w-3 shrink-0" />
              <span className="truncate">Archived</span>
              <span className="ml-auto flex items-center gap-1 text-[10px] font-normal shrink-0">
                {!archivedSectionOpen && renderAttentionBadge(archivedWaitingCount)}
                <span>{archived.length}</span>
              </span>
            </div>
            {archivedSectionOpen && archived.map((s) => renderSession(s, { showLocation: true, keyPrefix: "archived", compactIndent: true }))}
          </div>
        )}
      </div>
    </div>
  );
}
