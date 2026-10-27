import { useState } from "react";
import { GitBranch, Circle, Pause, PanelLeftClose, ChevronRight, ChevronDown, Folder, Settings, Pencil, Plus, MessagesSquare, Sun, Moon } from "lucide-react";
import { Badge } from "@ui/badge";
import { Button } from "@ui/button";
import { ScrollArea } from "@ui/scroll-area";
import { NotificationSettings } from "@/components/NotificationSettings";
import { cn } from "@/lib/utils";
import type { SessionInfo, NotificationPreferences } from "@/types";
import { sessionActivityDisplay } from "@/lib/activity-display";
import { loadTheme, setTheme, type Theme } from "@/lib/theme";
import { createLogger } from "@/lib/create-logger";

const log = createLogger("SessionSidebar");

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

export function SessionSidebar({ sessions, activeSessionId, connected, onSelect, collapsed, onToggle, onSettings, onNewSession, onRename, notifications }: Props) {
  const [collapsedProjects, setCollapsedProjectsRaw] = useState<Set<string>>(() => loadCollapsedProjects());
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
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

  // Wrap setter to persist to localStorage
  const setCollapsedProjects = (update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    setCollapsedProjectsRaw((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      saveCollapsedProjects(next);
      return next;
    });
  };

  if (collapsed) return null;

  /** One session row — shared by the directory tree and the coms lens. */
  const renderSession = (s: SessionInfo, showLocation = false) => {
    const isActive = s.sessionId === activeSessionId;
    const status = sessionActivityDisplay(s);
    return (
      <div
        key={s.sessionId}
        className={cn(
          "group/session pl-7 pr-3 py-2 cursor-pointer transition-colors border-b border-border/50",
          isActive && "bg-accent border-l-3 border-l-primary",
          !isActive && "hover:bg-accent/30",
          !s.active && "opacity-35",
        )}
        onClick={() => onSelect(s)}
      >
        <div className={cn("text-xs font-medium truncate flex items-center gap-1.5", s.active ? "text-primary" : "text-muted-foreground")}>
          {showLocation && (
            <span
              className="shrink-0 flex items-center gap-0.5 px-1 rounded border border-border bg-muted text-[9px] font-normal text-muted-foreground"
              title={`Session lives in ${s.cwd}`}
            >
              <Folder className="h-2.5 w-2.5" />
              <span className="max-w-[6.5rem] truncate">{s.cwd.split("/").pop() || s.cwd}</span>
            </span>
          )}
          {!s.active && <Pause className="h-3 w-3 flex-shrink-0 text-muted-foreground" />}
          {s.active && status.isWorking && (
            <span className="relative flex h-2 w-2 flex-shrink-0" aria-label="working">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
            </span>
          )}
          {s.active && s.activity === "waiting_for_input" && (
            <span className="h-2 w-2 flex-shrink-0 rounded-full bg-cyan-400" aria-label="waiting for input" />
          )}
          {editingSessionId === s.sessionId ? (
            <input
              className="bg-transparent border-b border-primary outline-none text-xs w-full"
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
              <span className="truncate">{s.name || s.model || "—"}</span>
              {onRename && (
                <Pencil
                  className="h-3 w-3 flex-shrink-0 opacity-0 group-hover/session:opacity-100 text-muted-foreground hover:text-primary cursor-pointer transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingSessionId(s.sessionId);
                    setEditName(s.name || s.model || "");
                  }}
                />
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
          {s.branch && (
            <span className="flex items-center gap-0.5">
              <GitBranch className="h-2.5 w-2.5" />
              <span className={s.gitDirty ? "text-red-500" : "text-green-500"}>
                {s.gitDirty ? "●" : "✓"}
              </span>
              <span className="truncate">{s.branch}</span>
            </span>
          )}
          {s.comsProject && (
            <span className="flex items-center gap-0.5 text-cyan-700 dark:text-cyan-400/90" title={`Coms project: ${s.comsProject}${s.comsName ? ` (you are ${s.comsName})` : ""}`}>
              <span aria-hidden="true">◆</span>
              <span className="truncate max-w-[5rem]">{s.comsProject}</span>
            </span>
          )}
          <span>{ago(s.startedAt)}</span>
          {s.activity === "waiting_for_input" && <span className="text-cyan-400">waiting for input</span>}
          {s.container && <Badge variant="outline" className="text-[8px] px-1 py-0 h-3">📦</Badge>}
        </div>
      </div>
    );
  };


  // ── Coms projects present among the sessions we can see ──────────────
  const comsProjects = new Map<string, { sessions: SessionInfo[]; busy: number }>();
  for (const s of sessions) {
    if (!s.comsProject) continue;
    if (!comsProjects.has(s.comsProject)) comsProjects.set(s.comsProject, { sessions: [], busy: 0 });
    const entry = comsProjects.get(s.comsProject)!;
    entry.sessions.push(s);
    if (s.activity === "working") entry.busy += 1;
  }
  const sortedComsProjects = [...comsProjects.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const comsMemberCount = sortedComsProjects.reduce((n, [, info]) => n + info.sessions.length, 0);
  const comsBusyCount = sortedComsProjects.reduce((n, [, info]) => n + info.busy, 0);
  // Active sessions first inside each project, like the directory groups.
  for (const [, info] of sortedComsProjects) {
    info.sessions.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  }

  // Group sessions by project name (last segment of cwd)
  const groups = new Map<string, { cwd: string; sessions: SessionInfo[] }>();
  for (const s of sessions) {
    const name = s.cwd.split("/").pop() || s.cwd;
    if (!groups.has(name)) groups.set(name, { cwd: s.cwd, sessions: [] });
    groups.get(name)!.sessions.push(s);
  }

  // Sort: active sessions first within each group
  for (const g of groups.values()) {
    g.sessions.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  }

  // Sort groups: groups with active sessions first
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aActive = a[1].sessions.some(s => s.active);
    const bActive = b[1].sessions.some(s => s.active);
    if (aActive !== bActive) return bActive ? 1 : -1;
    return a[0].localeCompare(b[0]);
  });

  const toggleProject = (key: string) => {
    log.debug("group toggled", { key });
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); // was collapsed → expand
      else next.add(key); // was expanded → collapse
      return next;
    });
  };

  // Auto-expand groups that contain the active session
  const activeGroup = sessions.find(s => s.sessionId === activeSessionId);
  const activeGroupName = activeGroup ? (activeGroup.cwd.split("/").pop() || activeGroup.cwd) : null;

  return (
    <div className="flex flex-col h-full border-r border-border">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
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
      <ScrollArea className="flex-1">
        {sessions.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">No sessions</p>
        )}

        {sortedGroups.map(([name, group]) => {
          const groupKey = dirKey(name);
          const isExpanded = !collapsedProjects.has(groupKey);
          const hasActive = group.sessions.some(s => s.active);
          const count = group.sessions.length;

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
                {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <Folder className="h-3 w-3" />
                <span className="truncate">{name}</span>
                <span className="ml-auto text-[10px] font-normal">{count}</span>
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
              {comsSectionOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <MessagesSquare className="h-3 w-3" />
              <span className="truncate">Coms</span>
              <span className="ml-auto flex items-center gap-1 text-[10px] font-normal">
                {comsMemberCount}
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
                    {isProjectOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <span aria-hidden="true" className="text-cyan-700 dark:text-cyan-400/90">◆</span>
                    <span className="truncate">{project}</span>
                    <span className="ml-auto text-[10px] font-normal">{info.sessions.length}</span>
                  </div>
                  {isProjectOpen && info.sessions.map((s) => renderSession(s, true))}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
